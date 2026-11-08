//! 会话事件的输入整理(收尾阶段)。
//!
//! 两家的会话记录形状都按**本机真实文件**确认过(见架构设计说明):
//!
//! - Claude Code:`~/.claude/projects/<cwd 变来的目录>/<id>.jsonl`,每行 `type` 为
//!   `user` / `assistant`(正文在 `message.content`,数组项用 `type: "text"`),
//!   同一份文件里还混着 `api-request-blob` / `attachment` / `cost-state` 等**非对话**记录;
//! - Kiro:`~/.kiro/sessions/cli/<id>.jsonl`,每行 `{version, kind, data}`,`kind` 为
//!   `Prompt` / `AssistantMessage` / `ToolResults` / `Compaction`,正文在
//!   `data.content`(数组项用 `kind: "text"`,文本在 `data`)。
//!
//! 这里把它们抽成“人机对话文本”交给 [`crate::evolution::EvolutionService::process`]。
//! 读文件是**逐行流式**的:真实会话里工具输出占绝大多数字节(实测 260 MB 的文件里
//! 对话只有 42 k 字),按字节截尾部会把最该提炼的长会话压到 2 k 字。
//!
//! 认不出的**对象**行直接跳过(不把 JSON 原文塞进提示词);只有整行不是 JSON、
//! 且不以 `{` 开头时才当纯文本会话保留(有些客户端直接写 `.log` / `.txt`)。

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use kb_core::{KbError, Result};
use serde_json::Value;

/// 交给提炼器的文本上限(字符)。提炼请求自己还会截到 24k 字符,这里只是别把
/// 整个会话塞进内存。
pub const MAX_TEXT_CHARS: usize = 200_000;

/// 单行上限:超过就整行丢掉(真实会话里一条工具输出可以有几 MB,对提炼没有价值)。
pub const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

/// 整份文件最多扫这么多字节(防御性上限:正常会话远小于它)。
pub const MAX_SCAN_BYTES: u64 = 1024 * 1024 * 1024;

/// 找会话时最多看几个候选文件(按修改时间从新到旧)。
const CANDIDATES: usize = 50;

/// 判定“这份会话是不是当前项目的”时读的头部字节数(只给没有 sidecar 的旧文件用)。
const HEAD_BYTES: u64 = 64 * 1024;

/// 读一份会话记录,抽成“用户/助手”对话文本。
///
/// 只接受**普通文件**(FIFO 会在 `open` 前拦住,设备文件与目录直接拒绝),避免
/// `/dev/zero` 读爆内存、FIFO 把线程挂住。文件不是合法 UTF-8 时报 `InvalidInput`;
/// 认不出的行跳过,全部认不出时返回空串。
pub fn read_session_text(path: &Path) -> Result<String> {
    read_session_text_with(path, MAX_SCAN_BYTES, MAX_TEXT_CHARS)
}

/// 同 [`read_session_text`],但扫描上限可注入(测试用)。
pub fn read_session_text_capped(path: &Path, scan_limit: u64) -> Result<String> {
    read_session_text_with(path, scan_limit, MAX_TEXT_CHARS)
}

/// 同 [`read_session_text`],扫描上限与文本窗口都可注入。
pub fn read_session_text_with(path: &Path, scan_limit: u64, max_chars: usize) -> Result<String> {
    let metadata =
        std::fs::metadata(path).map_err(|_| KbError::InvalidInput("打不开会话记录".to_owned()))?;
    if !metadata.is_file() {
        return Err(KbError::InvalidInput(
            "会话记录不是普通文件(目录 / 设备 / FIFO 都不读)".to_owned(),
        ));
    }
    let file = std::fs::File::open(path)
        .map_err(|_| KbError::InvalidInput("打不开会话记录".to_owned()))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    // 只留“最近 `MAX_TEXT_CHARS` 个字符”的滑动窗口:内存与对话量无关,只与上限有关。
    // 上一版把对话行全收进 `Vec` 再截尾,313 MB 全是对话的文件峰值 RSS 538 MB。
    let mut lines: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut kept_chars = 0usize;
    let mut dropped_chars = 0usize;
    let mut line = Vec::new();
    let mut scanned = 0u64;
    let mut scan_truncated = false;
    loop {
        let status = read_line(
            &mut reader,
            &mut line,
            MAX_LINE_BYTES,
            scan_limit.saturating_sub(scanned),
        )
        .map_err(|_| KbError::InvalidInput("读会话记录失败".to_owned()))?;
        match status {
            LineStatus::Eof => break,
            LineStatus::Scanned(bytes) => scanned += bytes,
            LineStatus::Limit => {
                scan_truncated = true;
                break;
            }
        }
        if line.is_empty() {
            continue;
        }
        let text = std::str::from_utf8(&line)
            .map_err(|_| KbError::InvalidInput("会话记录不是 UTF-8".to_owned()))?;
        let Some(entry) = dialogue_line(text) else {
            continue;
        };
        kept_chars += entry.chars().count() + 1;
        lines.push_back(entry);
        // 只剩最新一条时不再弹:它自己超限就交给下面的 `tail` 截它的尾部,
        // 否则窗口会被弹空,结果只剩一行省略提示
        while kept_chars > max_chars
            && lines.len() > 1
            && let Some(dropped) = lines.pop_front()
        {
            let size = dropped.chars().count() + 1;
            kept_chars -= size;
            dropped_chars += size;
        }
    }
    let joined = lines.into_iter().collect::<Vec<_>>().join("\n");
    // 窗口里已经是“最近的”,这里只是把极端情况(单行超过上限)再截一次
    let mut text = tail(&joined, max_chars);
    if dropped_chars > 0 {
        // 窗口弹掉的 + `tail` 截掉的,合成一个总数
        let (already, body) = match text.strip_prefix("…(更早的 ") {
            Some(rest) => match rest.split_once(" 字已省略)\n") {
                Some((count, body)) => {
                    (count.parse::<usize>().unwrap_or_default(), body.to_owned())
                }
                None => (0, text.clone()),
            },
            None => (0, text.clone()),
        };
        text = format!("…(更早的 {} 字已省略)\n{body}", dropped_chars + already);
    }
    if scan_truncated {
        // 扫描到上限就停了:后面的内容没读,如实标出来(而不是静默当成全部)
        text = format!("(扫描到 {scanned} 字节后停止,后面的内容未读)\n{text}");
    }
    // 只剩省略提示 = 没有可提炼的对话
    let body = text
        .lines()
        .filter(|line| !line.starts_with('…') && !line.starts_with("(扫描到"))
        .collect::<String>();
    if body.trim().is_empty() {
        return Ok(String::new());
    }
    Ok(text)
}

/// 读一行的结局。
enum LineStatus {
    /// 读完了(整份文件结束)。
    Eof,
    /// 读到了一行,`line` 里是内容(不含换行);附这一行占的字节数。
    Scanned(u64),
    /// 碰到上限,停止扫描。
    Limit,
}

/// 读一行到 `out`,超过 `max` 字节时整行丢弃(`out` 清空,仍继续读到行尾)。
///
/// 用 `fill_buf` / `consume` 而不是 `read_until`:超长行不会先被整份读进内存。
fn read_line<R: BufRead>(
    reader: &mut R,
    out: &mut Vec<u8>,
    max: usize,
    budget: u64,
) -> std::io::Result<LineStatus> {
    out.clear();
    let mut used = 0u64;
    let mut too_long = false;
    loop {
        // 先探 EOF 再判预算:文件大小恰好等于上限时不该被标成“截断”
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if out.is_empty() && !too_long {
                LineStatus::Eof
            } else {
                LineStatus::Scanned(used)
            });
        }
        if used >= budget {
            return Ok(LineStatus::Limit);
        }
        let (end, found) = match available.iter().position(|byte| *byte == b'\n') {
            Some(index) => (index + 1, true),
            None => (available.len(), false),
        };
        used += end as u64;
        if !too_long {
            if out.len() + end > max {
                too_long = true;
                out.clear();
            } else {
                out.extend_from_slice(&available[..end]);
            }
        }
        reader.consume(end);
        if found {
            // 去掉行尾的 `\n`(与 `\r\n` 的 `\r`)
            if out.last() == Some(&b'\n') {
                out.pop();
                if out.last() == Some(&b'\r') {
                    out.pop();
                }
            }
            return Ok(LineStatus::Scanned(used));
        }
    }
}

/// 从 JSONL 文本里抽对话(纯函数,便于单测)。
pub fn collect_dialogue(raw: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in raw.lines() {
        if let Some(entry) = dialogue_line(line) {
            lines.push(entry);
        }
    }
    tail(&lines.join("\n"), MAX_TEXT_CHARS)
}

/// 一行 → `角色:文本`;不是人机对话就 `None`。
fn dialogue_line(raw: &str) -> Option<String> {
    let line = raw.trim();
    if line.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(line) {
        Ok(value) => dialogue_of(&value).map(|(role, text)| format!("{role}:{text}")),
        // 以 `{` 开头却解析不了:多半是写入中被截断的半条 JSON,丢掉
        Err(_) if line.starts_with('{') => None,
        // 不是 JSON 行:当纯文本会话(有些客户端直接写 .log / .txt)
        Err(_) => Some(line.to_owned()),
    }
}

/// 从一条记录里取 `(角色, 文本)`;不是人机对话就 `None`。
fn dialogue_of(value: &Value) -> Option<(String, String)> {
    // Kiro:`{version, kind, data}`
    if let Some(kind) = value.get("kind").and_then(Value::as_str) {
        return kiro_dialogue(kind, value.get("data")?);
    }
    // Claude Code:`{type: "user" | "assistant", message: {role, content}}`
    claude_dialogue(value)
}

/// Kiro 的一条记录。
fn kiro_dialogue(kind: &str, data: &Value) -> Option<(String, String)> {
    let (label, text) = match kind {
        "Prompt" => ("用户", kiro_text(data.get("content")?)),
        "AssistantMessage" => ("助手", kiro_text(data.get("content")?)),
        // 长会话被压缩过时,更早的内容只剩这一行摘要
        "Compaction" => (
            "摘要",
            data.get("summary")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned(),
        ),
        // ToolResults(工具输出)不进提炼输入
        _ => return None,
    };
    non_empty(text).map(|text| (label.to_owned(), text))
}

/// Kiro 的 `content`:`[{kind: "text", data: "…"}]`,只取 `text` 项(thinking / toolUse 丢掉)。
fn kiro_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.trim().to_owned(),
        Value::Array(items) => items
            .iter()
            .filter(|item| item.get("kind").and_then(Value::as_str) == Some("text"))
            .filter_map(|item| item.get("data").and_then(Value::as_str))
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Claude Code 的一条记录。只认 `user` / `assistant`:同一份文件里的
/// `api-request-blob`(整份请求的副本)、`attachment`、`cost-state` 等都不是新对话。
fn claude_dialogue(value: &Value) -> Option<(String, String)> {
    let label = match value.get("type").and_then(Value::as_str)? {
        "user" => "用户",
        "assistant" => "助手",
        _ => return None,
    };
    let text = claude_text(value.get("message")?);
    non_empty(text).map(|text| (label.to_owned(), text))
}

/// Claude 的 `message.content`:字符串,或 `[{type: "text", text: "…"}]`。
fn claude_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// 空串换成 `None`(链式 `or_else` 用)。
fn non_empty(text: String) -> Option<String> {
    (!text.is_empty()).then_some(text)
}

/// 按字符截断,保留**尾部**(会话刚结束时,越靠后的对话越相关)。
fn tail(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_owned();
    }
    let skipped = count - max_chars;
    let rest: String = text.chars().skip(skipped).collect();
    format!("…(更早的 {skipped} 字已省略)\n{rest}")
}

/// `~/.kiro/sessions/cli/<id>.jsonl`(输入里给了 `session_id` 时的精确命中)。
///
/// `session_id` 只接受字母数字与 `-` / `_`:它是外部输入,不能用来拼路径。
pub fn kiro_session_by_id(home: &Path, session_id: &str) -> Option<PathBuf> {
    let id = session_id.trim();
    if id.is_empty()
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return None;
    }
    let path = home
        .join(".kiro")
        .join("sessions")
        .join("cli")
        .join(format!("{id}.jsonl"));
    path.is_file().then_some(path)
}

/// 在 `<home>/.kiro/sessions/cli` 下找**最近修改且属于 cwd** 的会话文件。
///
/// 归属判定优先读同名的 `<id>.json`(Kiro 自己写的会话元数据,里面有 `cwd`);
/// 没有 sidecar 的旧文件才退回“读头部看有没有提到 cwd”。带 `parent_session_id`
/// 的是子会话,启发式里跳过(它的父会话同样属于这个 cwd)。一个都不匹配时返回
/// `None`(宁可跳过,也不拿别的项目的会话去提炼)。
pub fn find_kiro_session(home: &Path, cwd: &str) -> Option<PathBuf> {
    let dir = home.join(".kiro").join("sessions").join("cli");
    newest_sessions(&dir)?
        .into_iter()
        .find(|path| match kiro_sidecar(path) {
            Some(sidecar) => {
                !sidecar.is_subagent && sidecar.cwd.is_some_and(|it| same_dir(&it, cwd))
            }
            None => session_mentions(path, cwd),
        })
}

/// 在 `<home>/.claude/projects/<slug>` 下找最近修改的会话文件(Claude Code 的
/// hook 输入通常自带 `transcript_path`,这是它没带时的兜底)。
pub fn find_claude_session(home: &Path, cwd: &str) -> Option<PathBuf> {
    let base = home.join(".claude").join("projects");
    claude_project_slug_variants(cwd)
        .into_iter()
        .filter_map(|slug| newest_sessions(&base.join(slug)))
        .flatten()
        .min_by_key(|path| {
            // 取“修改时间最晚”的那份(Reverse 的排序交给下面统一处理)
            std::cmp::Reverse(
                std::fs::metadata(path)
                    .ok()
                    .and_then(|it| it.modified().ok()),
            )
        })
}

/// Claude Code 的会话目录名:`/srv/kb` → `-srv-kb`
/// (字母数字与 `-` / `_` 保留,其余字符一律换成 `-`)。
pub fn claude_project_slug(cwd: &str) -> String {
    slug_with(cwd, true)
}

/// 目录名的两种变体:不同版本的 Claude Code 对下划线处理不一致(见下文),
/// 两种都试一遍。
pub fn claude_project_slug_variants(cwd: &str) -> Vec<String> {
    let keep = slug_with(cwd, true);
    let replace = slug_with(cwd, false);
    if keep == replace {
        vec![keep]
    } else {
        vec![keep, replace]
    }
}

fn slug_with(cwd: &str, keep_underscore: bool) -> String {
    cwd.trim_end_matches('/')
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || (keep_underscore && ch == '_') {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

/// 目录下的 `.jsonl` 按修改时间从新到旧(最多 `CANDIDATES` 个)。
///
/// **空文件不算候选**:刚开的会话(本机实测:sidecar 已经写了 `cwd`,`.jsonl` 还是 0 字节)
/// 修改时间最新,选它只会得到空文本,把真正有内容的上一份挡掉。
fn newest_sessions(dir: &Path) -> Option<Vec<PathBuf>> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
        })
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if metadata.len() == 0 {
                return None;
            }
            let modified = metadata.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect();
    candidates.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    Some(
        candidates
            .into_iter()
            .take(CANDIDATES)
            .map(|(_, path)| path)
            .collect(),
    )
}

/// Kiro 会话 sidecar(`<id>.json`)里用得上的字段。
struct KiroSidecar {
    /// 会话所在目录。
    cwd: Option<String>,
    /// 是不是子会话(有 `parent_session_id`)。
    is_subagent: bool,
}

/// 读 Kiro 会话 sidecar。
fn kiro_sidecar(session: &Path) -> Option<KiroSidecar> {
    let text = std::fs::read_to_string(session.with_extension("json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    Some(KiroSidecar {
        cwd: value.get("cwd").and_then(Value::as_str).map(str::to_owned),
        is_subagent: value
            .get("parent_session_id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty()),
    })
}

/// 两个目录是不是同一个(容忍尾斜杠)。
fn same_dir(left: &str, right: &str) -> bool {
    let left = left.trim_end_matches('/');
    let right = right.trim_end_matches('/');
    !left.is_empty() && left == right
}

/// 会话文件头部有没有提到这个目录(没有 sidecar 的旧文件才走这里)。
fn session_mentions(path: &Path, cwd: &str) -> bool {
    let trimmed = cwd.trim_end_matches('/');
    if trimmed.is_empty() {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = Vec::new();
    if file
        .by_ref()
        .take(HEAD_BYTES)
        .read_to_end(&mut head)
        .is_err()
    {
        return false;
    }
    String::from_utf8_lossy(&head).contains(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Kiro 的真实记录形状(2026-10-23 本机 `~/.kiro/sessions/cli/<id>.jsonl` 实测:
    /// `{version, kind, data}`,`kind` 为 Prompt / AssistantMessage / ToolResults / Compaction)。
    const KIRO: &str = r#"{"version":"v1","kind":"Prompt","data":{"message_id":"m1","content":[{"kind":"text","data":"为什么放弃 tantivy?"}],"meta":{}}}
{"version":"v1","kind":"AssistantMessage","data":{"message_id":"m2","content":[{"kind":"thinking","data":{"text":"想想"}},{"kind":"text","data":"因为要在 LanceDB 里做混合检索。"},{"kind":"toolUse","data":{"name":"Read"}}]}}
{"version":"v1","kind":"ToolResults","data":{"message_id":"m3","content":[{"kind":"toolResult","data":{"toolUseId":"t1"}}],"results":[]}}
{"version":"v1","kind":"Compaction","data":{"summary":"OBJECTIVE\n让预览对齐设计稿","strategy":{},"messages_snapshot":[]}}
not json at all
{"version":"v1","kind":"AssistantMessage","data":{"message_id":"m4","content":[{"kind":"text","data":"结论:BM25 用 LanceDB 内置 FTS。"}]}}
"#;

    /// Claude Code 的真实记录形状(本机 `~/.claude/projects/<slug>/<id>.jsonl` 实测:
    /// 同一份文件里混着 `api-request-blob` / `attachment` / `cost-state` 等非对话记录)。
    const CLAUDE: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"音视频转写要不要走云端?"}]},"cwd":"/srv/workspace/kb"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"想想"},{"type":"text","text":"不要,必须本地跑 whisper.cpp。"},{"type":"tool_use","name":"Read","input":{}}]}}
{"type":"api-request-blob","sessionId":"s1","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>整份请求的副本</system-reminder>"}]}}
{"type":"attachment","attachment":{"type":"file"},"rendered":"附件内容"}
{"type":"cost-state","totalCostUSD":1.2}
{"type":"summary","summary":"讨论转写方案"}
{"type":"assistant","message":{"role":"assistant","content":"结论:转写固定走本地。"}}
"#;

    fn write(path: &Path, body: &str) {
        std::fs::write(path, body).expect("写文件");
    }

    #[test]
    fn kiro_dialogue_keeps_human_and_assistant_text_only() {
        let text = collect_dialogue(KIRO);
        assert!(text.contains("用户:为什么放弃 tantivy?"), "{text}");
        assert!(
            text.contains("助手:因为要在 LanceDB 里做混合检索。"),
            "{text}"
        );
        assert!(
            text.contains("助手:结论:BM25 用 LanceDB 内置 FTS。"),
            "{text}"
        );
        // 压缩摘要留着(长会话只读尾部时它是唯一线索)
        assert!(text.contains("摘要:OBJECTIVE"), "{text}");
        // thinking / 工具输出不进提炼输入
        assert!(!text.contains("想想"), "{text}");
        assert!(!text.contains("toolUseId"), "{text}");
        // 非 JSON 行按纯文本会话保留
        assert!(text.contains("not json at all"), "{text}");
    }

    #[test]
    fn claude_dialogue_drops_non_dialogue_records() {
        let text = collect_dialogue(CLAUDE);
        assert!(text.contains("用户:音视频转写要不要走云端?"), "{text}");
        assert!(
            text.contains("助手:不要,必须本地跑 whisper.cpp。"),
            "{text}"
        );
        assert!(text.contains("助手:结论:转写固定走本地。"), "{text}");
        // 同一份文件里的请求副本 / 附件 / 费用 / 摘要都不是对话
        assert!(!text.contains("整份请求的副本"), "{text}");
        assert!(!text.contains("附件内容"), "{text}");
        assert!(!text.contains("讨论转写方案"), "{text}");
        assert!(!text.contains("totalCostUSD"), "{text}");
        assert!(!text.contains("想想"), "{text}");
    }

    #[test]
    fn a_truncated_json_line_is_not_kept_as_plain_text() {
        // 写入中的半条 JSON:以 `{` 开头却解析不了 → 丢掉,不当纯文本
        let text = collect_dialogue("{\"type\":\"user\",\"message\":{\"content\":\"半条");
        assert!(text.is_empty(), "{text}");
        // 不以 `{` 开头的行仍按纯文本保留
        let text = collect_dialogue("纯文本会话第一行");
        assert_eq!(text, "纯文本会话第一行");
    }

    #[test]
    fn tail_keeps_the_end_of_a_long_session() {
        let long = format!("{}末尾结论", "前".repeat(MAX_TEXT_CHARS + 100));
        let text = tail(&long, MAX_TEXT_CHARS);
        assert!(text.ends_with("末尾结论"), "应保留尾部");
        assert!(text.starts_with("…(更早的 104 字已省略)"), "{text}");
        // 短文本原样返回
        assert_eq!(tail("短", MAX_TEXT_CHARS), "短");
    }

    #[test]
    fn read_session_text_rejects_non_utf8() {
        let dir = tempfile::tempdir().expect("目录");
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, b"{\"type\":\"user\",\"message\":\"a\"}\n\xff\xfe").expect("写文件");
        let err = read_session_text(&path).expect_err("非 UTF-8 应报错");
        assert!(err.to_string().contains("UTF-8"), "{err}");
    }

    #[test]
    fn read_session_text_rejects_non_regular_files() {
        let dir = tempfile::tempdir().expect("目录");
        // 目录
        let err = read_session_text(dir.path()).expect_err("目录应被拒");
        assert!(err.to_string().contains("不是普通文件"), "{err}");
        // 字符设备(有这个文件才测)
        if Path::new("/dev/zero").exists() {
            let err = read_session_text(Path::new("/dev/zero")).expect_err("/dev/zero 应被拒");
            assert!(err.to_string().contains("不是普通文件"), "{err}");
        }
        // FIFO:`open` 之前就该拦住,不能挂住
        let fifo = dir.path().join("pipe.jsonl");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if made {
            let err = read_session_text(&fifo).expect_err("FIFO 应被拒");
            assert!(err.to_string().contains("不是普通文件"), "{err}");
        }
    }

    #[test]
    fn streaming_reads_dialogue_from_the_whole_file_not_just_the_tail() {
        // 12 MB 的工具输出夹在两段对话之间:按字节截尾部会丢掉开头那句
        let dir = tempfile::tempdir().expect("目录");
        let path = dir.path().join("big.jsonl");
        let mut body = String::new();
        body.push_str("{\"version\":\"v1\",\"kind\":\"Prompt\",\"data\":{\"content\":[{\"kind\":\"text\",\"data\":\"开头的提问\"}]}}\n");
        let tool = format!(
            "{{\"version\":\"v1\",\"kind\":\"ToolResults\",\"data\":{{\"content\":[{{\"kind\":\"toolResult\",\"data\":\"{}\"}}]}}}}\n",
            "工".repeat(4 * 1024 * 1024)
        );
        for _ in 0..3 {
            body.push_str(&tool);
        }
        body.push_str("{\"version\":\"v1\",\"kind\":\"AssistantMessage\",\"data\":{\"content\":[{\"kind\":\"text\",\"data\":\"结尾的回答\"}]}}\n");
        write(&path, &body);
        let text = read_session_text(&path).expect("读会话");
        assert!(text.contains("用户:开头的提问"), "{}", text.len());
        assert!(text.contains("助手:结尾的回答"), "{}", text.len());
        // 工具输出不进结果
        assert!(!text.contains("工工工"), "工具输出不该进提示词");
    }

    #[test]
    fn an_over_long_line_is_dropped_whole() {
        let dir = tempfile::tempdir().expect("目录");
        let path = dir.path().join("long.jsonl");
        let huge = format!(
            "{{\"version\":\"v1\",\"kind\":\"AssistantMessage\",\"data\":{{\"content\":[{{\"kind\":\"text\",\"data\":\"{}\"}}]}}}}\n",
            "长".repeat(MAX_LINE_BYTES)
        );
        write(&path, &format!("{huge}{KIRO}"));
        let text = read_session_text(&path).expect("读会话");
        // 超长的那一行整行丢掉,后面的正常行仍然读得到
        assert!(text.contains("用户:为什么放弃 tantivy?"), "{}", text.len());
        assert!(!text.contains("长长长"), "超长行应整行丢弃");
    }

    #[test]
    fn the_scan_limit_stops_reading() {
        let dir = tempfile::tempdir().expect("目录");
        let path = dir.path().join("many.jsonl");
        let line = "{\"version\":\"v1\",\"kind\":\"Prompt\",\"data\":{\"content\":[{\"kind\":\"text\",\"data\":\"一句话\"}]}}\n";
        write(&path, &line.repeat(100));
        // 上限只够读几行:结果里不会有全部 100 句
        let text = read_session_text_capped(&path, 300).expect("读会话");
        assert!(text.lines().count() < 100, "{}", text.lines().count());
        assert!(!text.is_empty(), "至少读到一行");
        // 不设上限时读全
        let full = read_session_text_capped(&path, u64::MAX).expect("读会话");
        assert_eq!(full.lines().count(), 100);
    }

    #[test]
    fn the_window_keeps_only_the_tail_and_bounds_memory() {
        let dir = tempfile::tempdir().expect("目录");
        let path = dir.path().join("chatty.jsonl");
        // 每行 1000 字,共 1000 行 = 100 万字,远超 MAX_TEXT_CHARS(20 万)
        let line = format!(
            "{{\"version\":\"v1\",\"kind\":\"AssistantMessage\",\"data\":{{\"content\":[{{\"kind\":\"text\",\"data\":\"{}\"}}]}}}}\n",
            "话".repeat(1000)
        );
        write(&path, &line.repeat(1000));
        let text = read_session_text(&path).expect("读会话");
        // 结果不超过上限(加一行省略说明)
        assert!(
            text.chars().count() <= MAX_TEXT_CHARS + 64,
            "{}",
            text.chars().count()
        );
        assert!(text.starts_with("…(更早的"), "应是“尾部”而不是“头部”");
        // 读的过程中不会攒下整份对话:窗口上限就是 MAX_TEXT_CHARS
        assert!(text.lines().count() <= MAX_TEXT_CHARS / 1000 + 2);
    }

    #[test]
    fn a_single_over_long_line_keeps_its_tail() {
        // 一条对话就超过窗口上限:留它的尾部,而不是把窗口弹空
        let dir = tempfile::tempdir().expect("目录");
        let path = dir.path().join("one.jsonl");
        let long = "尾".repeat(500);
        write(
            &path,
            &format!(
                "{{\"version\":\"v1\",\"kind\":\"AssistantMessage\",\"data\":{{\"content\":[{{\"kind\":\"text\",\"data\":\"{long}END\"}}]}}}}\n"
            ),
        );
        let text = read_session_text_with(&path, u64::MAX, 100).expect("读会话");
        assert!(text.ends_with("END"), "应保留这一条的尾部:{}", text.len());
        assert!(text.chars().count() <= 100 + 32, "{}", text.chars().count());
    }

    #[test]
    fn dropped_char_count_matches_what_was_dropped() {
        // 上限 40 字、每行 20 字:窗口只留最后两行,丢弃量 = 前面所有行的字符数(+换行)
        let dir = tempfile::tempdir().expect("目录");
        let path = dir.path().join("counted.jsonl");
        let line = "{\"version\":\"v1\",\"kind\":\"Prompt\",\"data\":{\"content\":[{\"kind\":\"text\",\"data\":\"012345678901234567\"}]}}\n";
        write(&path, &line.repeat(5));
        let text = read_session_text_with(&path, u64::MAX, 40).expect("读会话");
        // 每行渲染成 “用户:012345678901234567”(19 字)+ 换行
        let dropped: usize = text
            .lines()
            .next()
            .and_then(|line| line.trim_start_matches("…(更早的 ").split(' ').next())
            .and_then(|value| value.parse().ok())
            .expect("应有省略提示");
        // 每行渲染成 “用户:012345678901234567” = 21 字,加换行 22;窗口只留 1 行
        assert_eq!(dropped, 4 * 22, "丢弃量应等于被弹出的字符数:{text}");
    }

    #[test]
    fn only_a_marker_means_no_dialogue() {
        // 扫描上限在第一条对话行之前就触发 → 空串(而不是把省略提示当对话外发)
        let dir = tempfile::tempdir().expect("目录");
        let path = dir.path().join("tiny.jsonl");
        let line = "{\"version\":\"v1\",\"kind\":\"Prompt\",\"data\":{\"content\":[{\"kind\":\"text\",\"data\":\"一句话\"}]}}\n";
        write(&path, &line.repeat(3));
        // 扫描上限 0:一行都读不到,只剩“已截断”的提示 → 应返回空串
        let text = read_session_text_capped(&path, 0).expect("读会话");
        assert!(text.is_empty(), "应返回空串,实际:{text:?}");
    }

    #[test]
    fn a_file_exactly_at_the_scan_limit_is_not_marked_truncated() {
        let dir = tempfile::tempdir().expect("目录");
        let path = dir.path().join("exact.jsonl");
        let line = "{\"version\":\"v1\",\"kind\":\"Prompt\",\"data\":{\"content\":[{\"kind\":\"text\",\"data\":\"一句话\"}]}}\n";
        write(&path, &line.repeat(3));
        let size = std::fs::metadata(&path).expect("元数据").len();
        let text = read_session_text_capped(&path, size).expect("读会话");
        assert!(!text.contains("扫描到"), "正好读完不该标截断:{text}");
        assert_eq!(text.lines().count(), 3);
    }

    #[test]
    fn window_and_tail_truncation_add_up() {
        // 两条短行被窗口弹出 + 最后一条自己超限被 tail 截:省略量应是两者之和
        let dir = tempfile::tempdir().expect("目录");
        let path = dir.path().join("mixed.jsonl");
        let long = "尾".repeat(500);
        write(
            &path,
            &format!(
                "{{\"version\":\"v1\",\"kind\":\"Prompt\",\"data\":{{\"content\":[{{\"kind\":\"text\",\"data\":\"第一句\"}}]}}}}\n\
                 {{\"version\":\"v1\",\"kind\":\"Prompt\",\"data\":{{\"content\":[{{\"kind\":\"text\",\"data\":\"第二句\"}}]}}}}\n\
                 {{\"version\":\"v1\",\"kind\":\"AssistantMessage\",\"data\":{{\"content\":[{{\"kind\":\"text\",\"data\":\"{long}\"}}]}}}}\n"
            ),
        );
        let text = read_session_text_with(&path, u64::MAX, 100).expect("读会话");
        let dropped: usize = text
            .lines()
            .next()
            .and_then(|line| line.trim_start_matches("…(更早的 ").split(' ').next())
            .and_then(|value| value.parse().ok())
            .expect("应有省略提示");
        // 前两句(“用户:第一句” 6 字 + 换行、“用户:第二句” 6 字 + 换行)= 14,再加尾部截掉的 ~400
        assert!(dropped > 400, "应把两处都算进去:{dropped}");
    }

    #[test]
    fn scan_truncation_is_marked_in_the_text() {
        let dir = tempfile::tempdir().expect("目录");
        let path = dir.path().join("cap.jsonl");
        let line = "{\"version\":\"v1\",\"kind\":\"Prompt\",\"data\":{\"content\":[{\"kind\":\"text\",\"data\":\"一句话\"}]}}\n";
        write(&path, &line.repeat(20));
        let text = read_session_text_capped(&path, 200).expect("读会话");
        assert!(text.starts_with("(扫描到 "), "应标明扫描被截断:{text}");
        assert!(text.contains("后面的内容未读"), "{text}");
    }

    #[test]
    fn claude_slug_matches_the_real_directory_names() {
        // 路径转目录名:`/srv/kb` → `-srv-kb`
        assert_eq!(claude_project_slug("/srv/kb"), "-srv-kb");
        assert_eq!(
            claude_project_slug("/home/user/.codeg/.gemini/antigravity/cli/skills"),
            "-home-user--codeg--gemini-antigravity-cli-skills"
        );
        assert_eq!(
            claude_project_slug("/srv/workspace/kb/"),
            "-srv-workspace-kb"
        );
        // 下划线两种写法都试(不同版本处理不一致)
        assert_eq!(
            claude_project_slug_variants("/srv/workspace/my_proj"),
            vec![
                "-srv-workspace-my_proj".to_owned(),
                "-srv-workspace-my-proj".to_owned()
            ]
        );
        assert_eq!(claude_project_slug_variants("/srv/workspace/kb").len(), 1);
    }

    /// 显式设置修改时间,不靠 `sleep` 拉开。
    fn set_mtime(path: &Path, millis_ago: u64) {
        let when = std::time::SystemTime::now() - std::time::Duration::from_millis(millis_ago);
        std::fs::File::options()
            .write(true)
            .open(path)
            .expect("打开")
            .set_modified(when)
            .expect("设置修改时间");
    }

    #[test]
    fn kiro_session_is_found_by_sidecar_cwd() {
        let home = tempfile::tempdir().expect("目录");
        let dir = home.path().join(".kiro/sessions/cli");
        std::fs::create_dir_all(&dir).expect("建目录");
        let older = dir.join("old.jsonl");
        write(
            &older,
            r#"{"version":"v1","kind":"Prompt","data":{"content":[]}}"#,
        );
        write(
            &dir.join("old.json"),
            r#"{"session_id":"old","cwd":"/srv/workspace/kb"}"#,
        );
        let newer = dir.join("new.jsonl");
        write(
            &newer,
            r#"{"version":"v1","kind":"Prompt","data":{"content":[]}}"#,
        );
        write(
            &dir.join("new.json"),
            r#"{"session_id":"new","cwd":"/srv/workspace/other"}"#,
        );
        set_mtime(&older, 10_000);
        set_mtime(&newer, 1_000);

        assert_eq!(
            find_kiro_session(home.path(), "/srv/workspace/kb"),
            Some(older)
        );
        // 谁都不是这个目录时返回 None(不拿别的项目的会话)
        assert_eq!(find_kiro_session(home.path(), "/srv/workspace/none"), None);
    }

    #[test]
    fn zero_byte_session_never_wins() {
        // 变异守卫:去掉 `newest_sessions` 里的零字节过滤,这条必须变红
        let home = tempfile::tempdir().expect("目录");
        let dir = home.path().join(".kiro/sessions/cli");
        std::fs::create_dir_all(&dir).expect("建目录");
        let old = dir.join("old.jsonl");
        write(
            &old,
            r#"{"version":"v1","kind":"Prompt","data":{"content":[{"kind":"text","data":"有内容"}]}}"#,
        );
        write(
            &dir.join("old.json"),
            r#"{"session_id":"old","cwd":"/srv/workspace/kb"}"#,
        );
        let fresh = dir.join("fresh.jsonl");
        write(&fresh, "");
        write(
            &dir.join("fresh.json"),
            r#"{"session_id":"fresh","cwd":"/srv/workspace/kb"}"#,
        );
        set_mtime(&old, 10_000);
        set_mtime(&fresh, 1_000);
        assert_eq!(
            find_kiro_session(home.path(), "/srv/workspace/kb"),
            Some(old),
            "更新的 0 字节会话不该挡住有内容的上一份"
        );

        // Claude 一侧同样
        let claude_dir = home.path().join(".claude/projects/-srv-workspace-kb");
        std::fs::create_dir_all(&claude_dir).expect("建目录");
        let full = claude_dir.join("full.jsonl");
        write(&full, CLAUDE);
        let empty = claude_dir.join("empty.jsonl");
        write(&empty, "");
        set_mtime(&full, 10_000);
        set_mtime(&empty, 1_000);
        assert_eq!(
            find_claude_session(home.path(), "/srv/workspace/kb"),
            Some(full)
        );
    }

    #[test]
    fn kiro_subagent_sessions_are_skipped() {
        let home = tempfile::tempdir().expect("目录");
        let dir = home.path().join(".kiro/sessions/cli");
        std::fs::create_dir_all(&dir).expect("建目录");
        let parent = dir.join("parent.jsonl");
        write(
            &parent,
            r#"{"version":"v1","kind":"Prompt","data":{"content":[{"kind":"text","data":"主会话"}]}}"#,
        );
        write(
            &dir.join("parent.json"),
            r#"{"session_id":"parent","cwd":"/srv/workspace/kb"}"#,
        );
        let child = dir.join("child.jsonl");
        write(
            &child,
            r#"{"version":"v1","kind":"Prompt","data":{"content":[{"kind":"text","data":"子会话"}]}}"#,
        );
        write(
            &dir.join("child.json"),
            r#"{"session_id":"child","cwd":"/srv/workspace/kb","parent_session_id":"parent"}"#,
        );
        set_mtime(&parent, 10_000);
        set_mtime(&child, 1_000);
        assert_eq!(
            find_kiro_session(home.path(), "/srv/workspace/kb"),
            Some(parent)
        );
    }

    #[test]
    fn kiro_session_by_id_hits_exactly_and_rejects_paths() {
        let home = tempfile::tempdir().expect("目录");
        let dir = home.path().join(".kiro/sessions/cli");
        std::fs::create_dir_all(&dir).expect("建目录");
        let session = dir.join("abc-1.jsonl");
        write(
            &session,
            r#"{"version":"v1","kind":"Prompt","data":{"content":[]}}"#,
        );
        assert_eq!(kiro_session_by_id(home.path(), "abc-1"), Some(session));
        assert_eq!(kiro_session_by_id(home.path(), "nope"), None);
        // 外部输入不能用来拼路径
        assert_eq!(kiro_session_by_id(home.path(), "../../etc/passwd"), None);
        assert_eq!(kiro_session_by_id(home.path(), ""), None);
    }

    #[test]
    fn no_sidecar_falls_back_to_a_head_scan() {
        let home = tempfile::tempdir().expect("目录");
        let dir = home.path().join(".kiro/sessions/cli");
        std::fs::create_dir_all(&dir).expect("建目录");
        let session = dir.join("plain.jsonl");
        write(
            &session,
            r#"{"version":"v1","kind":"Prompt","data":{"content":[{"kind":"text","data":"在 /srv/workspace/kb 干活"}]}}"#,
        );
        assert_eq!(
            find_kiro_session(home.path(), "/srv/workspace/kb"),
            Some(session)
        );
        assert_eq!(find_kiro_session(home.path(), "/srv/workspace/none"), None);
    }

    #[test]
    fn claude_session_is_found_by_project_dir() {
        let home = tempfile::tempdir().expect("目录");
        let dir = home.path().join(".claude/projects/-srv-workspace-kb");
        std::fs::create_dir_all(&dir).expect("建目录");
        let session = dir.join("abc.jsonl");
        write(&session, CLAUDE);
        assert_eq!(
            find_claude_session(home.path(), "/srv/workspace/kb"),
            Some(session)
        );
        assert_eq!(
            find_claude_session(home.path(), "/srv/workspace/other"),
            None
        );
    }

    #[test]
    fn claude_session_is_found_with_underscore_variant() {
        let home = tempfile::tempdir().expect("目录");
        let dir = home.path().join(".claude/projects/-srv-workspace-my-proj");
        std::fs::create_dir_all(&dir).expect("建目录");
        let session = dir.join("abc.jsonl");
        write(&session, CLAUDE);
        assert_eq!(
            find_claude_session(home.path(), "/srv/workspace/my_proj"),
            Some(session)
        );
    }
}
