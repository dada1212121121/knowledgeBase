//! `kb hook claude-stop|kiro-stop`(收尾阶段)。
//!
//! AI 客户端的 Stop hook 会把一份 JSON 从标准输入交过来,这里把它转成一条
//! `session_end` 事件投给守护进程;守护进程读会话记录、提炼经验并写回
//! `events.result`。
//!
//! 这是**挂在别人会话上的钩子**,所以跳过是常态:守护进程没运行、项目没登记、
//! 找不到会话记录、提炼没成功,都只打印一行原因并以退出码 0 结束,绝不让会话本身失败。
//! 只有“钩子自己的活没干成”才是非 0:输入不是 JSON、守护进程返回别的错误。
//!
//! **绑哪个事件**:Claude Code 的 `Stop` 是**每轮**触发,会话结束是 `SessionEnd`
//! (见下文);`kiro-stop` 对应 Kiro 的会话结束。**建议绑 `SessionEnd`**:守护进程
//! 侧的去重只挡住「同一份会话内容没变」的重复触发(Stop 与 SessionEnd 连发、手动重放),
//! 绑在每轮的 `Stop` 上时,会话每轮都在变长,因此**每轮仍会提炼一次** ——
//! 真正兜住成本的是 `[llm] max_calls_per_hour` / `daily_token_budget`。

use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

use kb_core::paths::KbPaths;
use serde_json::{Value, json};

use crate::error::CliError;

/// 支持的会话 hook。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionHook {
    /// Claude Code 的 Stop hook。
    ClaudeStop,
    /// Kiro 的会话结束 hook。
    KiroStop,
}

impl SessionHook {
    /// 从命令行参数解析(参数值已在 clap 里限定)。
    pub fn parse(action: &str) -> Option<Self> {
        match action {
            "claude-stop" => Some(Self::ClaudeStop),
            "kiro-stop" => Some(Self::KiroStop),
            _ => None,
        }
    }

    /// hook 名(进事件的 payload,便于排查)。
    pub fn name(self) -> &'static str {
        match self {
            Self::ClaudeStop => "claude-stop",
            Self::KiroStop => "kiro-stop",
        }
    }

    /// 客户端种类。
    fn source(self) -> &'static str {
        match self {
            Self::ClaudeStop => "claude",
            Self::KiroStop => "kiro",
        }
    }
}

/// 执行。
pub async fn run(paths: &KbPaths, hook: SessionHook) -> Result<ExitCode, CliError> {
    let input = read_stdin()?;
    let cwd = project_root(&input);
    let Some(session) = session_file(hook, &input, &cwd) else {
        println!(
            "kb hook {}:没找到会话记录(会话目录或输入里的路径),已跳过",
            hook.name()
        );
        return Ok(ExitCode::SUCCESS);
    };

    let client = kb_mcp::uds::UdsClient::new(paths.socket());
    if !client.is_running().await {
        println!(
            "kb hook {}:守护进程没有运行,已跳过(不影响本次会话)",
            hook.name()
        );
        return Ok(ExitCode::SUCCESS);
    }

    let body = json!({
        "kind": "session_end",
        "project_root": cwd,
        "payload": {
            "hook": hook.name(),
            "source": hook.source(),
            "session_path": session.to_string_lossy(),
        },
    });
    let response = match client.post_json("/api/v1/events", body).await {
        Ok(response) => response,
        // 目录没登记成项目:这是常态(用户级 hook 会覆盖所有目录),不让会话因此报错
        Err(kb_core::KbError::NotFound(_)) => {
            println!(
                "kb hook {}:这个目录没登记成项目,已跳过(不影响本次会话)",
                hook.name()
            );
            return Ok(ExitCode::SUCCESS);
        }
        Err(err) => return Err(CliError::Kb(err)),
    };
    let data = &response["data"];
    let project = data["project"].as_str().unwrap_or("?");
    let mode = data["mode"].as_str().unwrap_or("?");
    println!(
        "kb hook {}:已投递会话事件 {} · 项目 {project} · {mode} · {} 个文件",
        hook.name(),
        data["event_id"].as_str().unwrap_or("?"),
        data["changed_files"].as_u64().unwrap_or(0),
    );
    print_evolution(&response);
    Ok(ExitCode::SUCCESS)
}

/// 打印提炼结果。
///
/// 提炼失败**不改变退出码**:事件已经投递、索引任务已经入队,失败原因留在
/// `events.result.evolution_error` 里;这是挂在别人会话上的钩子,非 0 会让客户端
/// 把「提炼没成功」显示成会话本身的错误。
fn print_evolution(response: &Value) {
    for line in outcome_lines(response) {
        match line.stderr {
            true => eprintln!("{}", line.text),
            false => println!("{}", line.text),
        }
    }
}

/// 一行要打印的东西。
struct OutputLine {
    /// 走 stderr 还是 stdout。
    stderr: bool,
    /// 文案。
    text: String,
}

/// 提炼结局 → 要打印的行(纯函数,便于单测断言文案与流向)。
fn outcome_lines(response: &Value) -> Vec<OutputLine> {
    let Some(parsed) = response["data"]["result"]
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
    else {
        // 老响应没有 result / 不是 JSON:静默
        return Vec::new();
    };
    let line = |stderr: bool, text: String| OutputLine { stderr, text };
    if let Some(error) = parsed.get("evolution_error").and_then(Value::as_str) {
        return vec![line(
            true,
            format!("kb hook:提炼没成功(索引任务已投递,不影响本次会话):{error}"),
        )];
    }
    let evolution = &parsed["evolution"];
    if evolution
        .get("skipped_unauthorized")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return vec![line(
            false,
            "kb hook:项目没开自动提炼(extract_enabled / allow_cloud_llm),已跳过".to_owned(),
        )];
    }
    if let Some(reason) = evolution.get("skipped").and_then(Value::as_str) {
        return vec![line(false, format!("kb hook:提炼跳过:{reason}"))];
    }
    if evolution.get("pending").and_then(Value::as_bool) == Some(true) {
        return vec![line(
            false,
            "kb hook:提炼已排入后台,结果稍后写进事件记录".to_owned(),
        )];
    }
    if evolution.is_object() {
        return vec![line(
            false,
            format!(
                "kb hook:提炼 {} 条候选,审核调用 {} 次",
                evolution["candidates"].as_u64().unwrap_or(0),
                evolution["review_calls"].as_u64().unwrap_or(0),
            ),
        )];
    }
    Vec::new()
}

/// 读标准输入(没有输入时当空对象)。
fn read_stdin() -> Result<Value, CliError> {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).map_err(|err| {
        CliError::Kb(kb_core::KbError::InvalidInput(format!(
            "读标准输入失败: {err}"
        )))
    })?;
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(raw).map_err(|err| {
        CliError::Kb(kb_core::KbError::InvalidInput(format!(
            "hook 输入不是 JSON: {err}"
        )))
    })
}

/// 项目根目录:hook 输入里的 `cwd` 优先,其次当前目录。
fn project_root(input: &Value) -> String {
    input
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
        })
        .unwrap_or_default()
}

/// 会话记录路径。
///
/// Claude Code 的 hook 输入里有 `transcript_path`,Kiro 的输入里没有。两家都没给路径时
/// 按 `cwd` 找最近修改的那份:`~/.claude/projects/<slug>/*.jsonl`(Claude)、
/// `~/.kiro/sessions/cli/*.jsonl`(Kiro,按 sidecar 的 `cwd` 认)—— 见 。
fn session_file(hook: SessionHook, input: &Value, cwd: &str) -> Option<PathBuf> {
    for key in ["transcript_path", "session_path"] {
        if let Some(path) = input.get(key).and_then(Value::as_str)
            && !path.trim().is_empty()
        {
            return Some(PathBuf::from(path));
        }
    }
    let home = std::env::var_os("HOME")?;
    let home = std::path::Path::new(&home);
    // Kiro 的 hook 输入可能带 `session_id`:能精确命中就不用猜最近修改的那份
    if hook == SessionHook::KiroStop
        && let Some(id) = input.get("session_id").and_then(Value::as_str)
        && let Some(path) = kb_service::evolution::kiro_session_by_id(home, id)
    {
        return Some(path);
    }
    match hook {
        SessionHook::ClaudeStop => kb_service::evolution::find_claude_session(home, cwd),
        SessionHook::KiroStop => kb_service::evolution::find_kiro_session(home, cwd),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 事件响应:`data.result` 是 `EventService` 写回的那段 JSON 文本。
    fn response(result: &str) -> Value {
        json!({ "data": { "result": result } })
    }

    #[test]
    fn each_outcome_prints_one_line_on_the_expected_stream() {
        // 提炼失败:stderr 提示,但调用方仍返回成功(见 run)
        let lines = outcome_lines(&response(
            r#"{"index":"noop","changed_files":0,"evolution_error":"读不到会话记录"}"#,
        ));
        assert_eq!(lines.len(), 1, "只该打一行");
        assert!(lines[0].stderr, "失败走 stderr");
        assert!(lines[0].text.contains("提炼没成功"), "{}", lines[0].text);
        assert!(
            lines[0].text.contains("不影响本次会话"),
            "{}",
            lines[0].text
        );

        // 项目没开提炼
        let lines = outcome_lines(&response(
            r#"{"index":"noop","changed_files":0,"evolution":{"skipped_unauthorized":true}}"#,
        ));
        assert_eq!(lines.len(), 1);
        assert!(!lines[0].stderr);
        assert!(lines[0].text.contains("没开自动提炼"), "{}", lines[0].text);

        // 跳过(空会话 / 没路径 / 没有新内容)
        let lines = outcome_lines(&response(
            r#"{"index":"noop","changed_files":0,"evolution":{"skipped":"会话记录里没有可提炼的对话"}}"#,
        ));
        assert_eq!(lines.len(), 1);
        assert!(!lines[0].stderr);
        assert!(
            lines[0].text.contains("会话记录里没有可提炼的对话"),
            "{}",
            lines[0].text
        );

        // 后台提炼已排入
        let lines = outcome_lines(&response(
            r#"{"index":"noop","changed_files":0,"evolution":{"pending":true}}"#,
        ));
        assert_eq!(lines.len(), 1);
        assert!(lines[0].text.contains("后台"), "{}", lines[0].text);

        // 提炼跑完
        let lines = outcome_lines(&response(
            r#"{"index":"noop","changed_files":0,"evolution":{"candidates":2,"review_calls":2}}"#,
        ));
        assert_eq!(lines.len(), 1);
        assert!(lines[0].text.contains("2 条候选"), "{}", lines[0].text);
        assert!(lines[0].text.contains("审核调用 2 次"), "{}", lines[0].text);

        // 老响应没有 result / 不是 JSON:什么都不打
        assert!(outcome_lines(&json!({ "data": {} })).is_empty());
        assert!(outcome_lines(&response("not json")).is_empty());
    }
}
