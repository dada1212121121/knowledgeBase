//! HTTP 重排器:调 llama.cpp `llama-server --reranking` 的 `/v1/rerank`。

use async_trait::async_trait;
use kb_core::ports::Reranker;
use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};

/// HTTP 重排器。
#[derive(Clone, Debug)]
pub struct HttpReranker {
    client: reqwest::Client,
    base_url: String,
    model: String,
    /// 最近一次健康检查的结果(由 `refresh_health` 更新)。
    available: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Serialize)]
struct RerankRequest<'a> {
    query: &'a str,
    documents: &'a [String],
    model: &'a str,
}

#[derive(Deserialize)]
struct RerankResponse {
    results: Vec<RerankItem>,
}

#[derive(Deserialize)]
struct RerankItem {
    index: usize,
    relevance_score: f32,
}

impl HttpReranker {
    /// 构造(`mode = on`):初始视为可用,失败时降级。
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> Self {
        Self::with_available(base_url, model, true)
    }

    /// 构造(`mode = auto`):初始**不可用**,由探活任务把状态翻成可用。
    pub fn new_auto(base_url: impl Into<String>, model: impl Into<String>) -> Self {
        Self::with_available(base_url, model, false)
    }

    fn with_available(
        base_url: impl Into<String>,
        model: impl Into<String>,
        available: bool,
    ) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .unwrap_or_default(),
            base_url: base_url
                .into()
                .trim_end_matches('/')
                .trim_end_matches("/v1/rerank")
                .to_owned(),
            model: model.into(),
            available: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(available)),
        }
    }

    /// 探测 `/health`,更新可用状态。
    ///
    /// 可用性**变化**时打一条日志:`auto` 模式下不可用属于正常情况(不标记 degraded),
    /// 但前提是没人知道它什么时候掉过 —— 2026-11-07 生产上重排实际上一天都没跑
    /// (`reranked=false`),因为 18082 被别的脚本占着、探活失败完全无声。所以状态一翻转就打日志,
    /// 不管变好还是变坏。
    pub async fn refresh_health(&self) -> bool {
        let ok = self
            .client
            .get(format!("{}/health", self.base_url))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false);
        self.set_available(ok);
        ok
    }

    /// 改可用状态,并只在**翻转**时打日志。
    ///
    /// 探活是 10 秒一次的循环、检索又在每次失败时都会改一次状态,不打日志就没人知道
    /// 它什么时候掉的;而每次都打又会淹掉日志,所以只看翻转。
    fn set_available(&self, ok: bool) -> bool {
        let was = self
            .available
            .swap(ok, std::sync::atomic::Ordering::Relaxed);
        if ok != was {
            if ok {
                tracing::info!(url = %self.base_url, model = %self.model, "重排 sidecar 已可用");
            } else {
                tracing::warn!(
                    url = %self.base_url,
                    model = %self.model,
                    "重排 sidecar 不可用,检索退回融合排序(所有请求 reranked=false)"
                );
            }
        }
        ok
    }
}

#[async_trait]
impl Reranker for HttpReranker {
    async fn rerank(&self, query: &str, docs: &[String]) -> Result<Vec<f32>> {
        if docs.is_empty() {
            return Ok(Vec::new());
        }
        let response = self
            .client
            .post(format!("{}/v1/rerank", self.base_url))
            .json(&RerankRequest {
                query,
                documents: docs,
                model: &self.model,
            })
            .send()
            .await
            .map_err(|err| KbError::Unavailable(format!("sidecar 重排请求失败: {err}")))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            self.set_available(false);
            return Err(KbError::Unavailable(format!(
                "sidecar 重排返回 {status}: {body}"
            )));
        }
        // 注意:`available` 要等响应**解析成功之后**才置真。端口被别的进程占着时它可能照样回
        // 200(`{"ok":true}` 这种),以前这里先标可用、再解析失败,于是每一次检索都白跑一趟重排,
        // 而 `available` 一直说"好的"(2026-11-07 生产上就是这么静默了一整天)。
        let payload: RerankResponse = match response.json().await {
            Ok(payload) => payload,
            Err(err) => {
                self.set_available(false);
                return Err(KbError::Internal(format!("sidecar 重排响应不合法: {err}")));
            }
        };
        if payload.results.is_empty() {
            self.set_available(false);
            return Err(KbError::Internal("sidecar 重排返回空结果".to_owned()));
        }
        self.set_available(true);
        let mut scores = vec![0.0f32; docs.len()];
        for item in payload.results {
            if let Some(slot) = scores.get_mut(item.index) {
                *slot = item.relevance_score;
            }
        }
        Ok(scores)
    }

    fn available(&self) -> bool {
        self.available.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn stub(response_body: &'static str) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定");
        let addr = listener.local_addr().expect("地址");
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer).await;
                let body = response_body;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (format!("http://{addr}"), handle)
    }

    #[tokio::test]
    async fn scores_are_aligned_with_the_documents() {
        let (base, handle) = stub(
            r#"{"results":[{"index":1,"relevance_score":0.9},{"index":0,"relevance_score":0.1}]}"#,
        )
        .await;
        let reranker = HttpReranker::new(base, "m");
        let scores = reranker
            .rerank("q", &["a".to_owned(), "b".to_owned()])
            .await
            .expect("重排");
        assert_eq!(scores, vec![0.1, 0.9]);
        assert!(reranker.available());
        handle.abort();
    }

    #[tokio::test]
    async fn a_200_without_results_is_reported_and_drops_availability() {
        // 端口被别的进程占着时最常见的情形:它照样回 200,但 JSON 里没有 `results`。
        // 以前这种响应会被当成“成功”(甚至把 available 标成真),于是每次检索都白跑一趟重排。
        let (base, handle) = stub(r#"{"ok":true}"#).await;
        let reranker = HttpReranker::new(base, "m");
        assert!(reranker.available(), "mode=on 时初值是可用的");
        let err = reranker
            .rerank("q", &["a".to_owned()])
            .await
            .expect_err("没有 results 必须报错");
        assert!(format!("{err}").contains("不合法"), "{err}");
        assert!(!reranker.available(), "假 sidecar 不能继续被当成可用");
        handle.abort();
    }

    #[tokio::test]
    async fn an_empty_result_list_is_reported_too() {
        let (base, handle) = stub(r#"{"results":[]}"#).await;
        let reranker = HttpReranker::new(base, "m");
        assert!(
            reranker
                .rerank("q", &["a".to_owned()])
                .await
                .expect_err("空结果要报错")
                .to_string()
                .contains("空")
        );
        assert!(!reranker.available());
        handle.abort();
    }

    #[tokio::test]
    async fn unreachable_sidecar_marks_itself_unavailable() {
        let reranker = HttpReranker::new("http://127.0.0.1:1", "m");
        assert!(!reranker.refresh_health().await);
        assert!(!reranker.available(), "健康检查失败后应标记不可用");
        assert!(reranker.rerank("q", &["a".to_owned()]).await.is_err());
    }
}
