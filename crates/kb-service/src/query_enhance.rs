//! 查询增强与深度检索。
//!
//! 两件事:
//! 1. **查询增强**(默认关闭,`search_knowledge` 的 `enhance: true` 打开):
//!    让 LLM 把原问题改写成若干条“更容易命中”的查询(HyDE:先写一段假设答案,再用它检索),
//!    多条查询各检索一次后按 id 合并、按分数取前 k;
//! 2. **深度检索** `deep_search`:LLM 在**最多 4 轮**里自己决定调 `search_knowledge` /
//!    `get_item`,最后给一段**带出处**的总结。
//!
//! 前置条件:作用域内**所有项目**都允许云端 LLM,否则直接拒绝(不调用 LLM)。

use std::sync::Arc;

use kb_core::model::{ChatMessage, ChatRequest, ChatResponse, ToolSpec};
use kb_core::ports::ChatModel;
use kb_core::ports::repo::MetaStore;
use kb_core::{KbError, Result};
use serde::Serialize;
use serde_json::{Value, json};

use crate::llm_gate::{LlmGate, Purpose};
use crate::search::{SearchRequest, SearchResponse, SearchService};

/// 查询增强提示词。
pub const ENHANCE_PROMPT: &str = "你是检索助手。把用户的问题改写成 3 条更容易命中的检索查询:\
其中第 1 条是“假设答案”(先写出可能正确的回答,再用它去检索),另外 2 条是同义改写。\
只输出 JSON:{\"queries\":[\"...\",\"...\",\"...\"]}";

/// 深度检索的系统提示词。
pub const DEEP_SEARCH_PROMPT: &str = "你是知识库检索助手。你可以调用 search_knowledge 与 get_item。\
最多 4 轮:先检索,再按需查看条目详情,最后**基于检索到的内容**给出回答。\
回答里必须用 [id] 标出每一处结论的出处;检索不到就直说没有找到,不要编。";

/// 一轮工具调用。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ToolTrace {
    /// 轮次(1 起)。
    pub round: u32,
    /// 工具名。
    pub tool: String,
    /// 参数摘要。
    pub arguments: String,
    /// 命中数 / 是否取到条目。
    pub hits: usize,
}

/// 深度检索结果。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DeepSearchResult {
    /// 最终回答(带 [id] 出处)。
    pub answer: String,
    /// 用到的条目(去重,按首次出现顺序)。
    pub citations: Vec<Citation>,
    /// 工具调用轨迹。
    pub trace: Vec<ToolTrace>,
    /// 用了几轮。
    pub rounds: u32,
    /// 是否因为轮次用尽而结束。
    pub truncated: bool,
}

/// 一条出处。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Citation {
    /// 条目 id。
    pub id: String,
    /// 出处(相对路径或 `insight:<id>`)。
    pub source: String,
    /// 标题。
    pub title: Option<String>,
}

/// 深度检索里可用的工具。
pub fn deep_search_tools() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "search_knowledge".to_owned(),
            description: "在知识库里检索(返回 id / 出处 / 片段)".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "k": { "type": "integer", "minimum": 1, "maximum": 20 }
                },
                "required": ["query"]
            }),
        },
        ToolSpec {
            name: "get_item".to_owned(),
            description: "按 id 取一个条目的完整内容".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }),
        },
    ]
}

/// 作用域是否全部允许云端 LLM。
pub async fn scope_allows_llm(meta: &dyn MetaStore, collections: &[String]) -> Result<bool> {
    for name in collections {
        let Some(collection) = kb_core::ports::repo::CollectionRepo::get(meta, name).await? else {
            continue;
        };
        if let Some(project_id) = &collection.project_id {
            let Some(project) = kb_core::ports::repo::ProjectRepo::get(meta, project_id).await?
            else {
                continue;
            };
            if !project.allow_cloud_llm {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// 查询增强服务。
pub struct QueryEnhancer {
    gate: LlmGate,
    model: Arc<dyn ChatModel>,
}

impl QueryEnhancer {
    /// 构造。
    pub fn new(gate: LlmGate, model: Arc<dyn ChatModel>) -> Self {
        Self { gate, model }
    }

    /// 生成增强查询(原问题 + LLM 改写;失败时退回原问题)。
    pub async fn enhance(&self, project_id: Option<&str>, query: &str) -> Vec<String> {
        let request = ChatRequest {
            model: self.model.id().to_owned(),
            messages: vec![
                ChatMessage {
                    role: "system".to_owned(),
                    content: Some(ENHANCE_PROMPT.to_owned()),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                },
                ChatMessage {
                    role: "user".to_owned(),
                    content: Some(query.to_owned()),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                },
            ],
            tools: Vec::new(),
            json_output: true,
            thinking: false,
            max_tokens: Some(512),
            temperature: Some(0.3),
        };
        let mut queries = vec![query.to_owned()];
        if let Ok(response) = self
            .gate
            .send(project_id, Purpose::Review, &self.model, request)
            .await
            && let Some(content) = response.message.content
            && let Ok(value) = serde_json::from_str::<Value>(&content)
            && let Some(list) = value.get("queries").and_then(Value::as_array)
        {
            for item in list.iter().filter_map(Value::as_str).take(3) {
                let item = item.trim();
                if !item.is_empty() && !queries.iter().any(|existing| existing == item) {
                    queries.push(item.to_owned());
                }
            }
        }
        queries
    }
}

/// 多查询合并检索:每条查询各检索一次,按 id 合并取最高分。
pub async fn search_many(
    service: &SearchService,
    queries: &[String],
    collections: Vec<String>,
    k: usize,
) -> Result<SearchResponse> {
    let mut merged: Vec<kb_core::model::SearchHit> = Vec::new();
    let mut degraded = None;
    let mut scope = Vec::new();
    for query in queries {
        let response = service
            .search(SearchRequest {
                query: query.clone(),
                collections: collections.clone(),
                k: Some(k),
                explain: false,
                rerank: None,
            })
            .await?;
        if degraded.is_none() {
            degraded = response.degraded.clone();
        }
        if scope.is_empty() {
            scope = response.scope.clone();
        }
        for hit in response.hits {
            match merged.iter_mut().find(|existing| existing.id == hit.id) {
                Some(existing) => {
                    if hit.score > existing.score {
                        existing.score = hit.score;
                        existing.snippet = hit.snippet;
                    }
                }
                None => merged.push(hit),
            }
        }
    }
    merged.sort_by(|left, right| right.score.total_cmp(&left.score));
    merged.truncate(k);
    Ok(SearchResponse {
        timings: None,
        reranked: false,
        hits: merged,
        scope,
        query_parsed: kb_core::query::ParsedQuery::parse(
            queries.first().map(String::as_str).unwrap_or_default(),
        ),
        degraded,
    })
}

/// 深度检索的执行器(工具调用由调用方注入,避免这里依赖具体服务)。
pub struct DeepSearch<'a> {
    gate: &'a LlmGate,
    model: Arc<dyn ChatModel>,
    search: &'a SearchService,
    store: Arc<dyn kb_core::ports::VectorStore>,
    meta: &'a dyn MetaStore,
    collections: Vec<String>,
}

impl<'a> DeepSearch<'a> {
    /// 构造。
    pub fn new(
        gate: &'a LlmGate,
        model: Arc<dyn ChatModel>,
        search: &'a SearchService,
        store: Arc<dyn kb_core::ports::VectorStore>,
        meta: &'a dyn MetaStore,
        collections: Vec<String>,
    ) -> Self {
        Self {
            gate,
            model,
            search,
            store,
            meta,
            collections,
        }
    }

    /// 跑一次深度检索。
    pub async fn run(&self, project_id: Option<&str>, question: &str) -> Result<DeepSearchResult> {
        if !scope_allows_llm(self.meta, &self.collections).await? {
            return Err(KbError::Forbidden(
                "作用域里有项目未开启 allow_cloud_llm,深度检索不可用".to_owned(),
            ));
        }
        let mut messages = vec![
            ChatMessage {
                role: "system".to_owned(),
                content: Some(DEEP_SEARCH_PROMPT.to_owned()),
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
            ChatMessage {
                role: "user".to_owned(),
                content: Some(question.to_owned()),
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
        ];
        let mut trace = Vec::new();
        let mut citations: Vec<Citation> = Vec::new();
        let mut rounds = 0u32;
        let mut truncated = false;

        while rounds < 4 {
            rounds += 1;
            let request = ChatRequest {
                model: self.model.id().to_owned(),
                messages: messages.clone(),
                tools: deep_search_tools(),
                json_output: false,
                thinking: false,
                max_tokens: Some(1024),
                temperature: Some(0.2),
            };
            let response = self
                .gate
                .send(project_id, Purpose::Agent, &self.model, request)
                .await?;
            let tool_calls = response.message.tool_calls.clone();
            if tool_calls.is_empty() {
                return Ok(DeepSearchResult {
                    answer: response.message.content.unwrap_or_default(),
                    citations,
                    trace,
                    rounds,
                    truncated: false,
                });
            }
            messages.push(ChatMessage {
                role: "assistant".to_owned(),
                content: response.message.content.clone(),
                tool_calls: tool_calls.clone(),
                tool_call_id: None,
            });
            for call in tool_calls {
                let (result, hits) = self.execute(&call.name, &call.arguments).await?;
                if let Some(list) = result.get("citations").and_then(Value::as_array) {
                    for item in list {
                        let id = item
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        if id.is_empty() || citations.iter().any(|c| c.id == id) {
                            continue;
                        }
                        citations.push(Citation {
                            id,
                            source: item
                                .get("source")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned(),
                            title: item.get("title").and_then(Value::as_str).map(str::to_owned),
                        });
                    }
                }
                trace.push(ToolTrace {
                    round: rounds,
                    tool: call.name.clone(),
                    arguments: call.arguments.to_string(),
                    hits,
                });
                messages.push(ChatMessage {
                    role: "tool".to_owned(),
                    content: Some(result.to_string()),
                    tool_calls: Vec::new(),
                    tool_call_id: Some(call.id),
                });
            }
            if rounds == 4 {
                truncated = true;
            }
        }
        // 轮次用尽:让模型基于已有结果收尾
        let request = ChatRequest {
            model: self.model.id().to_owned(),
            messages: {
                let mut list = messages.clone();
                list.push(ChatMessage {
                    role: "user".to_owned(),
                    content: Some(
                        "轮次用尽,请直接基于上面的检索结果回答,并标注 [id] 出处。".to_owned(),
                    ),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                });
                list
            },
            tools: Vec::new(),
            json_output: false,
            thinking: false,
            max_tokens: Some(1024),
            temperature: Some(0.2),
        };
        let response = self
            .gate
            .send(project_id, Purpose::Agent, &self.model, request)
            .await?;
        Ok(DeepSearchResult {
            answer: response.message.content.unwrap_or_default(),
            citations,
            trace,
            rounds,
            truncated,
        })
    }

    /// 执行一个工具调用,返回(给模型的 JSON, 命中数)。
    async fn execute(&self, tool: &str, arguments: &Value) -> Result<(Value, usize)> {
        match tool {
            "search_knowledge" => {
                let query = arguments
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let k = arguments
                    .get("k")
                    .and_then(Value::as_u64)
                    .unwrap_or(5)
                    .min(20) as usize;
                let response = self
                    .search
                    .search(SearchRequest {
                        query,
                        collections: self.collections.clone(),
                        k: Some(k),
                        explain: false,
                        rerank: None,
                    })
                    .await?;
                let citations: Vec<Value> = response
                    .hits
                    .iter()
                    .map(|hit| {
                        json!({
                            "id": hit.id,
                            "source": hit.source,
                            "title": hit.title,
                            "snippet": hit.snippet.chars().take(400).collect::<String>(),
                        })
                    })
                    .collect();
                let hits = citations.len();
                Ok((json!({ "hits": citations, "citations": citations }), hits))
            }
            "get_item" => {
                let id = arguments
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let collection = self.collection_of(&id).await?;
                let rows = self
                    .store
                    .get(&collection.active_table, std::slice::from_ref(&id))
                    .await?;
                match rows.into_iter().next() {
                    Some(row) => Ok((
                        json!({
                            "id": row.id,
                            "source": row.source,
                            "title": row.title,
                            "text": row.text.chars().take(4000).collect::<String>(),
                            "citations": [{
                                "id": row.id,
                                "source": row.source,
                                "title": row.title,
                            }],
                        }),
                        1,
                    )),
                    None => Ok((json!({ "error": format!("没有 id 为 {id} 的条目") }), 0)),
                }
            }
            other => Ok((json!({ "error": format!("未知工具 {other}") }), 0)),
        }
    }

    /// 找条目属于哪个 collection。
    async fn collection_of(&self, id: &str) -> Result<kb_core::model::Collection> {
        for name in &self.collections {
            if let Some(collection) =
                kb_core::ports::repo::CollectionRepo::get(self.meta, name).await?
            {
                return Ok(collection);
            }
        }
        Err(KbError::NotFound(format!(
            "找不到条目 {id} 所属的 collection"
        )))
    }
}

/// 响应文本(空内容按空串)。
pub fn response_text(response: &ChatResponse) -> &str {
    response.message.content.as_deref().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_are_documented_for_the_model() {
        let tools = deep_search_tools();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "search_knowledge");
        assert_eq!(tools[1].name, "get_item");
        assert!(tools[0].parameters["properties"]["query"].is_object());
    }

    #[test]
    fn prompts_forbid_making_things_up() {
        assert!(DEEP_SEARCH_PROMPT.contains("不要编"));
        assert!(DEEP_SEARCH_PROMPT.contains("最多 4 轮"));
        assert!(ENHANCE_PROMPT.contains("假设答案"));
    }
}
