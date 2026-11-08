//! LLM 上下文增强(设计规范)。
//!
//! collection 的 `context_mode = llm` 时,对每个块让 LLM 生成 50–100 字的“这块在讲什么”,
//! 用它替换 header 的最后一段;`embed_input_hash` 因此改变,下次索引时会重嵌入。
//!
//! - 结果按 `content_hash` 缓存到 `chunk_context`,同一段内容只问一次;
//! - 开启前先给出**token 估算**(块数 × 每块提示词),由 UI 让用户确认;
//! - 所有调用都过 `LlmGate`(项目未授权时直接拒绝)。

use std::sync::Arc;

use kb_core::model::{ChatMessage, ChatRequest, Millis};
use kb_core::ports::repo::{ChunkRepo, CollectionRepo, ContextRepo, MetaStore};
use kb_core::ports::{ChatModel, VectorStore};
use kb_core::{KbError, Result};
use serde::Serialize;

use crate::llm_gate::{LlmGate, Purpose};

/// 上下文提示词。
pub const CONTEXT_PROMPT: &str = "下面是一个代码 / 文档片段。请用 50-100 字说明它在做什么、\
属于哪个模块、解决了什么问题。只输出这段说明,不要重复原文,不要加引号或前缀。";

/// 每块估算的提示词 token(片段本身 + 指令)。
pub const ESTIMATE_TOKENS_PER_CHUNK: u64 = 220;

/// 估算结果(UI 确认用)。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ContextEstimate {
    /// collection 名。
    pub collection: String,
    /// 需要生成上下文的块数(缓存命中不算)。
    pub chunks: u64,
    /// 需要调用 LLM 的块数。
    pub llm_calls: u64,
    /// 估算 token。
    pub estimated_tokens: u64,
    /// 当前模式。
    pub context_mode: String,
}

/// 应用结果。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ContextApplyResult {
    /// collection 名。
    pub collection: String,
    /// 处理的块数。
    pub chunks: u64,
    /// 命中缓存的块数。
    pub cached: u64,
    /// 调用了多少次 LLM。
    pub llm_calls: u64,
    /// header 被改写的块数。
    pub rewritten: u64,
}

/// 上下文服务。
pub struct ContextService {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    gate: LlmGate,
    model: Arc<dyn ChatModel>,
}

impl ContextService {
    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        gate: LlmGate,
        model: Arc<dyn ChatModel>,
    ) -> Self {
        Self {
            meta,
            store,
            gate,
            model,
        }
    }

    /// 估算开启 LLM 上下文的 token 量。
    pub async fn estimate(&self, collection: &str) -> Result<ContextEstimate> {
        let record = CollectionRepo::get(self.meta.as_ref(), collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {collection}")))?;
        let rows = self.insight_rows(&record.active_table).await?;
        let mut estimate = ContextEstimate {
            collection: collection.to_owned(),
            chunks: rows.len() as u64,
            context_mode: record.context_mode.as_str().to_owned(),
            ..ContextEstimate::default()
        };
        for row in &rows {
            let cached = ContextRepo::get_context(self.meta.as_ref(), &row.content_hash).await?;
            if cached.is_none() {
                estimate.llm_calls += 1;
            }
        }
        estimate.estimated_tokens = estimate.llm_calls * ESTIMATE_TOKENS_PER_CHUNK;
        Ok(estimate)
    }

    /// 生成并写回上下文(只改 header,不在这里重嵌入)。
    pub async fn apply(
        &self,
        collection: &str,
        project_id: Option<&str>,
        limit: usize,
    ) -> Result<ContextApplyResult> {
        let record = CollectionRepo::get(self.meta.as_ref(), collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {collection}")))?;
        let mut result = ContextApplyResult {
            collection: collection.to_owned(),
            ..ContextApplyResult::default()
        };
        let rows = self.insight_rows(&record.active_table).await?;
        // 已缓存的块不占名额,否则每次都卡在同一批前 N 块,后面的永远轮不到。
        let mut llm_budget = limit.max(1);
        for row in &rows {
            let cached = ContextRepo::get_context(self.meta.as_ref(), &row.content_hash).await?;
            if cached.is_none() && llm_budget == 0 {
                continue;
            }
            result.chunks += 1;
            let context = match cached {
                Some(cached) => {
                    result.cached += 1;
                    cached
                }
                None => {
                    llm_budget = llm_budget.saturating_sub(1);
                    let request = ChatRequest {
                        model: self.model.id().to_owned(),
                        messages: vec![
                            ChatMessage {
                                role: "system".to_owned(),
                                content: Some(CONTEXT_PROMPT.to_owned()),
                                tool_calls: Vec::new(),
                                tool_call_id: None,
                            },
                            ChatMessage {
                                role: "user".to_owned(),
                                content: Some(row.text.chars().take(2000).collect()),
                                tool_calls: Vec::new(),
                                tool_call_id: None,
                            },
                        ],
                        tools: Vec::new(),
                        json_output: false,
                        thinking: false,
                        max_tokens: Some(200),
                        temperature: Some(0.2),
                    };
                    let response = self
                        .gate
                        .send(project_id, Purpose::Extract, &self.model, request)
                        .await?;
                    result.llm_calls += 1;
                    let text = response
                        .message
                        .content
                        .unwrap_or_default()
                        .trim()
                        .to_owned();
                    if text.is_empty() {
                        continue;
                    }
                    ContextRepo::put_context(
                        self.meta.as_ref(),
                        &row.content_hash,
                        &text,
                        self.model.id(),
                        now_millis(),
                    )
                    .await?;
                    text
                }
            };
            // 替换 header 的最后一段
            let header = replace_last_segment(&row.header, &context);
            if header != row.header {
                result.rewritten += 1;
                self.rewrite_header(&record.active_table, &row.id, &header)
                    .await?;
            }
        }
        Ok(result)
    }

    /// 取 collection 里的块(不含向量;用于估算与改写)。
    async fn insight_rows(&self, table: &str) -> Result<Vec<kb_core::model::RecordRow>> {
        // 列表查询不需要向量(向量检索要求真实向量,零向量在 LanceDB 里匹配不到行)
        self.store
            .list(table, &kb_core::model::ListQuery::new(5_000, 0))
            .await
    }

    /// 只更新 header 与 lex(正文 / 向量不动;重嵌入由后续索引任务完成)。
    async fn rewrite_header(&self, table: &str, id: &str, header: &str) -> Result<()> {
        let rows = self.store.get(table, &[id.to_owned()]).await?;
        let Some(mut row) = rows.into_iter().next() else {
            return Ok(());
        };
        row.header = header.to_owned();
        row.lex = crate::index::pipeline::lex_of(header, &row.text);
        row.updated_at = now_millis();
        self.store.upsert(table, vec![row]).await
    }
}

/// 把 header 的最后一段换成 `context`。
///
/// header 形如 `proj_demo › src/lib.rs › fn main`;没有分隔符时直接拼在后面。
pub fn replace_last_segment(header: &str, context: &str) -> String {
    match header.rsplit_once(" › ") {
        Some((prefix, _)) => format!("{prefix} › {context}"),
        None => format!("{header} › {context}"),
    }
}

fn now_millis() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 待审草稿数(给 UI 的确认提示用;这里只做占位,避免重复实现)。
pub async fn pending_drafts(meta: &dyn MetaStore) -> Result<u64> {
    kb_core::ports::repo::DraftRepo::count(meta, None).await
}

/// 一个 collection 的块数。
pub async fn chunk_count(meta: &dyn MetaStore, collection: &str) -> Result<u64> {
    ChunkRepo::count(meta, collection).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_last_segment() {
        let header = "proj_demo › src/lib.rs › fn main";
        assert_eq!(
            replace_last_segment(header, "这里实现了主函数"),
            "proj_demo › src/lib.rs › 这里实现了主函数"
        );
    }

    #[test]
    fn appends_when_there_is_no_separator() {
        assert_eq!(
            replace_last_segment("src/lib.rs", "说明"),
            "src/lib.rs › 说明"
        );
    }

    #[test]
    fn prompt_asks_for_fifty_to_hundred_chars() {
        assert!(CONTEXT_PROMPT.contains("50-100 字"), "{CONTEXT_PROMPT}");
    }
}
