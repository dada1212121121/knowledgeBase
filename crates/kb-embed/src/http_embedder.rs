//! OpenAI 兼容的 HTTP 嵌入器:调 llama.cpp `llama-server --embedding` 的 `/v1/embeddings`。

use async_trait::async_trait;
use kb_core::ports::Embedder;
use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};

/// 单次请求最多带多少条文本。
///
/// 调用方一次可能递来很多条:换模型迁移每批 256 条,而 sidecar 的总耗时与条数成正比。
/// 核显(Iris Xe)上实测吞吐从每批 8 条到 64 条几乎不变(约 4.3 块/秒,瓶颈是算力,
/// 并发请求也不会更快),但单个请求的耗时随批大小线性增长:64 条要 15 秒,256 条约 60 秒。
/// 同机的 ffmpeg 转码也用这块核显,稍微一抢就会撞上下面 120 秒的整体超时,整批失败,
/// 迁移任务从头来过。拆成每次最多 16 条串行发,单次请求几秒,总吞吐不变。
const MAX_TEXTS_PER_REQUEST: usize = 16;

/// HTTP 嵌入器。
#[derive(Clone, Debug)]
pub struct HttpEmbedder {
    client: reqwest::Client,
    base_url: String,
    model: String,
    dim: usize,
    id: String,
    compat_group: String,
    available: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// 请求体。
#[derive(Serialize)]
struct EmbedRequest<'a> {
    input: &'a [String],
    model: &'a str,
}

/// 响应体。
#[derive(Deserialize)]
struct EmbedResponse {
    data: Vec<EmbedItem>,
}

#[derive(Deserialize)]
struct EmbedItem {
    index: usize,
    embedding: Vec<f32>,
}

impl HttpEmbedder {
    /// 构造;`base_url` 可以是 `http://127.0.0.1:18081`,也可以是完整端点
    /// `http://127.0.0.1:18081/v1/embeddings`(配置里的默认形态）。
    pub fn new(base_url: impl Into<String>, model: impl Into<String>, dim: usize) -> Self {
        let base_url = base_url.into();
        // 统一成 base:去掉末尾的 `/v1/embeddings`,避免拼成 `/v1/embeddings/v1/embeddings`
        let base_url = base_url
            .trim_end_matches('/')
            .trim_end_matches("/v1/embeddings")
            .to_owned();
        let model = model.into();
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
            base_url,
            id: format!("http:{model}"),
            compat_group: model.clone(),
            model,
            dim,
            available: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
        }
    }

    /// 服务是否健康(同时更新 `state`)。
    pub async fn healthy(&self) -> bool {
        let ok = self
            .client
            .get(format!("{}/health", self.base_url))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false);
        self.available
            .store(ok, std::sync::atomic::Ordering::Relaxed);
        ok
    }
}

#[async_trait]
impl Embedder for HttpEmbedder {
    fn id(&self) -> &str {
        &self.id
    }

    fn dim(&self) -> usize {
        self.dim
    }

    fn compat_group(&self) -> &str {
        &self.compat_group
    }

    fn state(&self) -> kb_core::model::EmbedderState {
        // 由 sidecar 的健康检查维护;进程还活着就当可用
        if self.available.load(std::sync::atomic::Ordering::Relaxed) {
            kb_core::model::EmbedderState::Ready
        } else {
            kb_core::model::EmbedderState::Failed("sidecar 不可用".to_owned())
        }
    }

    async fn embed_documents(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        // 串行发,不并发:算力是瓶颈,并发不会更快,只会让每个请求的耗时叠加
        let mut vectors = Vec::with_capacity(texts.len());
        for part in texts.chunks(MAX_TEXTS_PER_REQUEST) {
            vectors.extend(self.embed_request(part).await?);
        }
        Ok(vectors)
    }

    async fn embed_query(&self, text: String) -> Result<Vec<f32>> {
        let mut vectors = self.embed_documents(vec![text]).await?;
        vectors
            .pop()
            .ok_or_else(|| KbError::Internal("sidecar 没有返回查询向量".to_owned()))
    }
}

impl HttpEmbedder {
    /// 发一次嵌入请求(条数不超过 [`MAX_TEXTS_PER_REQUEST`])。
    async fn embed_request(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let response = self
            .client
            .post(format!("{}/v1/embeddings", self.base_url))
            .json(&EmbedRequest {
                input: texts,
                model: &self.model,
            })
            .send()
            .await
            .map_err(|err| {
                self.available
                    .store(false, std::sync::atomic::Ordering::Relaxed);
                KbError::Unavailable(format!("sidecar 嵌入请求失败: {err}"))
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            self.available
                .store(false, std::sync::atomic::Ordering::Relaxed);
            return Err(KbError::Unavailable(format!(
                "sidecar 嵌入返回 {status}: {body}"
            )));
        }
        self.available
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let mut payload: EmbedResponse = response
            .json()
            .await
            .map_err(|err| KbError::Internal(format!("sidecar 嵌入响应不合法: {err}")))?;
        // 按 index 排序,保证与输入顺序一致
        payload.data.sort_by_key(|item| item.index);
        if payload.data.len() != texts.len() {
            return Err(KbError::Internal(format!(
                "sidecar 返回 {} 条向量,期望 {}",
                payload.data.len(),
                texts.len()
            )));
        }
        Ok(payload
            .data
            .into_iter()
            .map(|item| item.embedding)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 极简 HTTP 桩:收到一个请求就返回固定响应。
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
    async fn embeddings_are_returned_in_input_order() {
        let (base, handle) = stub(
            r#"{"data":[{"index":1,"embedding":[2.0,2.0]},{"index":0,"embedding":[1.0,1.0]}]}"#,
        )
        .await;
        let embedder = HttpEmbedder::new(base, "m", 2);
        let vectors = embedder
            .embed_documents(vec!["a".to_owned(), "b".to_owned()])
            .await
            .expect("嵌入");
        assert_eq!(vectors[0], vec![1.0, 1.0], "应按 index 排序");
        assert_eq!(vectors[1], vec![2.0, 2.0]);
        assert_eq!(embedder.id(), "http:m");
        handle.abort();
    }

    /// 会回显的 HTTP 桩:按请求里的文本 `t<数字>` 返回向量 `[数字]`(并故意倒序返回),
    /// 同时记下每个请求带了几条文本。
    async fn echo_stub() -> (
        String,
        tokio::task::JoinHandle<()>,
        std::sync::Arc<std::sync::Mutex<Vec<usize>>>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定");
        let addr = listener.local_addr().expect("地址");
        let sizes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = sizes.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                // 读到请求头结束,再按 Content-Length 把正文读满
                let mut raw = Vec::new();
                let mut buffer = [0u8; 4096];
                let body = loop {
                    let read = stream.read(&mut buffer).await.unwrap_or(0);
                    if read == 0 {
                        break String::new();
                    }
                    raw.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    if let Some(split) = text.find("\r\n\r\n") {
                        let length = text[..split]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if text.len() - (split + 4) >= length {
                            break text[split + 4..].to_owned();
                        }
                    }
                };
                // `{"input":["t0","t1"],"model":"m"}` → 取方括号里的各项
                let inner = body
                    .split('[')
                    .nth(1)
                    .and_then(|rest| rest.split(']').next())
                    .unwrap_or("");
                let numbers: Vec<f32> = inner
                    .split(',')
                    .filter(|item| !item.trim().is_empty())
                    .map(|item| {
                        item.trim()
                            .trim_matches('"')
                            .trim_start_matches('t')
                            .parse::<f32>()
                            .unwrap_or(-1.0)
                    })
                    .collect();
                seen.lock().expect("锁").push(numbers.len());
                let items: Vec<String> = numbers
                    .iter()
                    .enumerate()
                    .rev()
                    .map(|(index, value)| format!(r#"{{"index":{index},"embedding":[{value}]}}"#))
                    .collect();
                let payload = format!(r#"{{"data":[{}]}}"#, items.join(","));
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (format!("http://{addr}"), handle, sizes)
    }

    #[tokio::test]
    async fn a_large_batch_is_split_into_small_requests_and_keeps_its_order() {
        let (base, handle, sizes) = echo_stub().await;
        let embedder = HttpEmbedder::new(base, "m", 1);
        // 迁移一次递来 256 条:不能一个请求发完(单请求耗时与条数成正比,撞超时整批失败)
        let texts: Vec<String> = (0..256).map(|index| format!("t{index}")).collect();
        let vectors = embedder.embed_documents(texts).await.expect("嵌入");
        assert_eq!(vectors.len(), 256);
        for (index, vector) in vectors.iter().enumerate() {
            assert_eq!(vector, &vec![index as f32], "第 {index} 条的向量对不上");
        }
        let sizes = sizes.lock().expect("锁").clone();
        assert_eq!(sizes.len(), 16, "256 条应拆成 16 个请求:{sizes:?}");
        assert!(
            sizes.iter().all(|size| *size == MAX_TEXTS_PER_REQUEST),
            "每个请求都不该超过上限:{sizes:?}"
        );
        handle.abort();
    }

    #[tokio::test]
    async fn the_last_partial_batch_and_small_batches_are_sent_as_they_are() {
        let (base, handle, sizes) = echo_stub().await;
        let embedder = HttpEmbedder::new(base, "m", 1);
        let texts: Vec<String> = (0..(MAX_TEXTS_PER_REQUEST + 3))
            .map(|index| format!("t{index}"))
            .collect();
        let vectors = embedder.embed_documents(texts).await.expect("嵌入");
        assert_eq!(vectors.len(), MAX_TEXTS_PER_REQUEST + 3);
        assert_eq!(
            sizes.lock().expect("锁").clone(),
            vec![MAX_TEXTS_PER_REQUEST, 3],
            "尾巴单独一个请求"
        );
        // 不超过上限的批次还是一个请求(索引流水线每批 8 条)
        sizes.lock().expect("锁").clear();
        let small: Vec<String> = (0..8).map(|index| format!("t{index}")).collect();
        embedder.embed_documents(small).await.expect("嵌入");
        assert_eq!(sizes.lock().expect("锁").clone(), vec![8]);
        handle.abort();
    }

    #[tokio::test]
    async fn count_mismatch_is_an_error() {
        let (base, handle) = stub(r#"{"data":[{"index":0,"embedding":[1.0]}]}"#).await;
        let embedder = HttpEmbedder::new(base, "m", 1);
        let error = embedder
            .embed_documents(vec!["a".to_owned(), "b".to_owned()])
            .await
            .expect_err("条数不一致应报错");
        assert!(error.to_string().contains("期望 2"), "{error}");
        handle.abort();
    }

    #[tokio::test]
    async fn unreachable_sidecar_reports_unavailable() {
        let embedder = HttpEmbedder::new("http://127.0.0.1:1", "m", 1);
        assert!(!embedder.healthy().await);
        assert!(matches!(
            embedder.state(),
            kb_core::model::EmbedderState::Failed(_)
        ));
        let error = embedder
            .embed_query("x".to_owned())
            .await
            .expect_err("应失败");
        assert!(matches!(error, KbError::Unavailable(_)), "{error:?}");
    }
}

#[cfg(test)]
mod endpoint_tests {
    use super::*;

    #[test]
    fn full_endpoint_is_normalized_to_base() {
        // 配置默认值是完整端点;不能再拼一层
        let embedder = HttpEmbedder::new("http://127.0.0.1:18081/v1/embeddings", "m", 8);
        assert_eq!(embedder.base_url, "http://127.0.0.1:18081");
        let embedder = HttpEmbedder::new("http://127.0.0.1:18081", "m", 8);
        assert_eq!(embedder.base_url, "http://127.0.0.1:18081");
        let embedder = HttpEmbedder::new("http://127.0.0.1:18081/", "m", 8);
        assert_eq!(embedder.base_url, "http://127.0.0.1:18081");
    }
}
