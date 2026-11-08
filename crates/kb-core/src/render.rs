//! 检索结果的文本渲染(设计规范「MCP 输出」)。
//!
//! CLI 的 `kb search` 与 `kb mcp` 共用这一个函数,保证两边输出完全一致:
//!
//! ```text
//! [1] proj_sampleproj · code · src/api/auth.rs:120-168 · impl AuthService › fn login · id=<完整 32 位 id>
//! <片段>
//! ```

use crate::model::SearchHit;

/// 渲染参数。
#[derive(Clone, Copy, Debug)]
pub struct RenderOptions {
    /// 输出总长度上限(字符)。
    pub max_chars: usize,
    /// 每条片段最多保留多少字符。
    pub snippet_chars: usize,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            max_chars: 24_000,
            snippet_chars: 600,
        }
    }
}

/// 把降级代码翻译成中文说明。
pub fn degraded_note(code: &str) -> String {
    let reason = match code {
        "embedder_loading" => "嵌入模型加载中,本次只做了全文检索",
        "rerank_timeout" => "重排超时,已退回融合结果",
        "rerank_unavailable" => "重排器不可用,已退回融合结果",
        "embedder_unavailable" => "嵌入模型不可用,本次只做了全文检索",
        // 文本阶段已写好正文,向量还空着:结果先用全文检索兜底
        "vector_pending" => "部分内容正在补建向量索引,本次按全文相关性排序",
        other => other,
    };
    format!("注意:{reason}")
}

/// 渲染命中列表。
pub fn render_hits(hits: &[SearchHit], degraded: Option<&str>, options: &RenderOptions) -> String {
    let mut out = String::new();
    if let Some(code) = degraded {
        out.push_str(&degraded_note(code));
        out.push('\n');
    }
    if hits.is_empty() {
        out.push_str("没有匹配的结果。\n");
        return out;
    }
    for (index, hit) in hits.iter().enumerate() {
        let header = hit_header(index + 1, hit);
        let snippet = truncate(&hit.snippet, options.snippet_chars);
        let mut block = String::new();
        block.push_str(&header);
        block.push('\n');
        if let Some(explain) = &hit.explain {
            block.push_str(&explain_line(explain));
            block.push('\n');
        }
        block.push_str(&snippet);
        block.push('\n');
        // 长度控制靠减少条数,id 与出处必须完整(按整块计长度,不只算首行)
        if !out.is_empty() && out.chars().count() + block.chars().count() > options.max_chars {
            out.push_str("…(已按输出长度上限截断)\n");
            break;
        }
        out.push_str(&block);
        if index + 1 < hits.len() {
            out.push('\n');
        }
    }
    out
}

/// 单条命中的首行。
pub fn hit_header(index: usize, hit: &SearchHit) -> String {
    let mut parts = vec![hit.collection.clone(), hit.kind.as_str().to_owned()];
    parts.push(location(hit));
    if let Some(label) = hit.symbol.clone().or_else(|| hit.title.clone()) {
        parts.push(label);
    }
    // id 必须完整输出（设计规范）
    parts.push(format!("id={}", hit.id));
    format!("[{index}] {}", parts.join(" · "))
}

fn location(hit: &SearchHit) -> String {
    // 当前阶段:有 anchor 时把位置写进出处(PDF 页码 / 表格单元格 / 幻灯片 / 时间戳)
    let base = match (hit.start_line, hit.end_line) {
        (Some(start), Some(end)) => format!("{}:{start}-{end}", hit.source),
        (Some(start), None) => format!("{}:{start}", hit.source),
        _ => hit.source.clone(),
    };
    match &hit.anchor {
        Some(anchor) => format!("{base} · {}", anchor.label()),
        None => base,
    }
}

fn explain_line(explain: &crate::model::SearchExplain) -> String {
    let mut parts = vec![format!("collection={}", explain.collection)];
    if let Some(rank) = explain.fts_rank {
        parts.push(format!("全文 #{rank}"));
    }
    if let Some(rank) = explain.vector_rank {
        parts.push(format!("向量 #{rank}"));
    }
    if let Some(rank) = explain.fused_rank {
        parts.push(format!("融合 #{rank}"));
    }
    parts.push(format!("score={:.5}", explain.fused_score));
    if let Some(window) = explain.window {
        parts.push(format!(
            "窗口 {}-{}{}",
            window.from,
            window.to,
            if window.fallback { "(回退)" } else { "" }
        ));
    }
    format!("    explain: {}", parts.join(" · "))
}

/// 按字符截断,并加省略号。
pub fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ItemStatus, RecordKind, SearchExplain, SearchHit, WindowExplain};

    fn hit(id: &str, kind: RecordKind, symbol: Option<&str>) -> SearchHit {
        SearchHit {
            id: id.to_owned(),
            collection: "proj_demo".to_owned(),
            kind,
            source: "src/api/auth.rs".to_owned(),
            start_line: Some(120),
            end_line: Some(168),
            symbol: symbol.map(str::to_owned),
            title: None,
            snippet: "fn login() {\n    // 认证\n}".to_owned(),
            score: 0.42,
            related: Vec::new(),
            explain: None,
            anchor: None,
        }
    }

    #[test]
    fn header_matches_the_documented_shape() {
        let hit = hit(
            "3f9c0a1e7b2d4c58a6e1f0b9d2c7a413",
            RecordKind::Code,
            Some("impl AuthService › fn login"),
        );
        let header = hit_header(1, &hit);
        assert_eq!(
            header,
            "[1] proj_demo · code · src/api/auth.rs:120-168 · impl AuthService › fn login · id=3f9c0a1e7b2d4c58a6e1f0b9d2c7a413"
        );
    }

    #[test]
    fn docs_use_the_title_and_omit_lines_when_absent() {
        let mut doc = hit("abc", RecordKind::Doc, None);
        doc.source = "ARCHITECTURE.md".to_owned();
        doc.start_line = None;
        doc.end_line = None;
        doc.title = Some("14. 演进优化 › 14.1 双哈希增量索引".to_owned());
        assert_eq!(
            hit_header(2, &doc),
            "[2] proj_demo · doc · ARCHITECTURE.md · 14. 演进优化 › 14.1 双哈希增量索引 · id=abc"
        );
    }

    #[test]
    fn degraded_note_is_printed_first() {
        let hits = vec![hit("a", RecordKind::Code, None)];
        let text = render_hits(&hits, Some("embedder_loading"), &RenderOptions::default());
        assert!(text.starts_with("注意:嵌入模型加载中"), "{text}");
    }

    #[test]
    fn empty_hits_are_explained() {
        let text = render_hits(&[], None, &RenderOptions::default());
        assert_eq!(text.trim(), "没有匹配的结果。");
    }

    #[test]
    fn explain_adds_a_line() {
        let mut hit = hit("a", RecordKind::Code, None);
        hit.explain = Some(SearchExplain {
            collection: "proj_demo".to_owned(),
            fts_rank: Some(2),
            fts_score: None,
            vector_rank: None,
            vector_score: None,
            store_rank: Some(1),
            fused_rank: Some(1),
            fused_score: 0.016,
            fused_weight: None,
            rerank_rank: None,
            rerank_score: None,
            window: Some(WindowExplain {
                from: 112,
                to: 176,
                fallback: false,
            }),
            pending: false,
        });
        let text = render_hits(&[hit], None, &RenderOptions::default());
        assert!(text.contains("全文 #2"), "{text}");
        assert!(text.contains("窗口 112-176"), "{text}");
    }

    #[test]
    fn long_output_is_truncated_by_dropping_hits_not_ids() {
        let hits: Vec<SearchHit> = (0..5)
            .map(|index| hit(&format!("id-{index}"), RecordKind::Code, None))
            .collect();
        let options = RenderOptions {
            max_chars: 200,
            snippet_chars: 20,
        };
        let text = render_hits(&hits, None, &options);
        assert!(text.contains("已按输出长度上限截断"), "{text}");
        assert!(text.contains("id=id-0"), "第一条必须完整:{text}");
    }

    #[test]
    fn snippet_is_truncated_with_ellipsis() {
        assert_eq!(truncate("abcdef", 3), "abc…");
        assert_eq!(truncate("abc", 3), "abc");
    }

    #[test]
    fn status_and_kind_strings_are_stable() {
        assert_eq!(RecordKind::Insight.as_str(), "insight");
        assert_eq!(ItemStatus::Active.as_str(), "active");
    }
}
