//! `kb integrate`:把 `kb mcp` 接进各 AI 客户端的配置。

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use kb_core::KbError;

use crate::error::CliError;

/// 支持的客户端。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Client {
    /// Kiro CLI(`~/.kiro/settings/mcp.json`)。
    Kiro,
    /// Claude Code(`claude mcp add --scope user`)。
    Claude,
    /// Codex(`~/.codex/config.toml`)。
    Codex,
}

impl Client {
    /// 解析客户端名。
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "kiro" => Some(Self::Kiro),
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    /// 名字。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Kiro => "kiro",
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    /// 配置文件路径(`~` 展开成 `$HOME`)。
    pub fn config_path(self) -> Option<PathBuf> {
        let home = std::env::var_os("HOME")?;
        let home = PathBuf::from(home);
        match self {
            Self::Kiro => Some(home.join(".kiro/settings/mcp.json")),
            Self::Codex => Some(home.join(".codex/config.toml")),
            // Claude Code 用 `claude mcp add` 管理,不直接改文件
            Self::Claude => None,
        }
    }

    /// 要打印的配置片段。
    pub fn snippet(self) -> String {
        match self {
            Self::Kiro => r#"// ~/.kiro/settings/mcp.json
{
  "mcpServers": {
    "kb": { "command": "kb", "args": ["mcp"], "timeout": 120000 }
  }
}"#
            .to_owned(),
            Self::Claude => {
                "# Claude Code(用户级)\nclaude mcp add --scope user kb -- kb mcp".to_owned()
            }
            Self::Codex => r#"# ~/.codex/config.toml
[mcp_servers.kb]
command = "kb"
args = ["mcp"]"#
                .to_owned(),
        }
    }
}

/// `kb integrate` 的参数。
#[derive(Clone, Debug)]
pub struct IntegrateArgs {
    /// 客户端名。
    pub client: String,
    /// 直接写入配置文件(默认只打印)。
    pub apply: bool,
    /// 显式要求只打印(与默认行为一致,便于脚本)。
    pub print: bool,
}

/// 执行。
pub async fn run(args: IntegrateArgs) -> Result<ExitCode, CliError> {
    let client = Client::parse(&args.client).ok_or_else(|| {
        KbError::InvalidInput(format!(
            "未知的客户端 {}:支持 kiro / claude / codex",
            args.client
        ))
    })?;
    println!("== {} ==", client.as_str());
    println!("{}", client.snippet());
    if !args.apply || args.print {
        println!("\n(只打印;加 --apply 写入配置)");
        return Ok(ExitCode::SUCCESS);
    }
    match client.config_path() {
        Some(path) => apply_file(client, &path),
        None => Err(KbError::InvalidInput(
            "Claude Code 请直接执行上面那条 `claude mcp add` 命令(它自己管理配置)".to_owned(),
        )
        .into()),
    }
}

/// 写配置文件(先备份,再整体追加 / 覆盖 kb 段)。
fn apply_file(client: Client, path: &Path) -> Result<ExitCode, CliError> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let backup = backup_path(path);
    let (updated, replaced) = match client {
        Client::Kiro => merge_json(&existing)?,
        Client::Codex => {
            let replaced = toml_has_kb(&existing);
            let same = codex_entry_matches(&existing);
            // 已有条目且内容与推荐值不同:保持原样,但要说清楚
            if replaced && !same {
                println!(
                    "已存在 kb 条目(内容与推荐不同),未修改;如需覆盖请手动编辑 {}",
                    path.display()
                );
                return Ok(ExitCode::SUCCESS);
            }
            (merge_toml(&existing), replaced)
        }
        Client::Claude => unreachable!("Claude 不写文件"),
    };
    if updated == existing {
        println!("kb 条目已存在且内容一致,未修改 {}", path.display());
        return Ok(ExitCode::SUCCESS);
    }
    if path.exists() {
        std::fs::copy(path, &backup)
            .map_err(|err| KbError::Internal(format!("备份 {} 失败: {err}", path.display())))?;
        println!("已备份到 {}", backup.display());
    }
    if replaced {
        println!("注意:已替换现有的 kb 条目(原文件已备份)");
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
        })?;
    }
    // 先写临时文件再 rename,避免写一半把用户配置弄坏
    let temp = path.with_extension("kb-tmp");
    std::fs::write(&temp, &updated)
        .map_err(|err| KbError::Internal(format!("写入 {} 失败: {err}", temp.display())))?;
    std::fs::rename(&temp, path)
        .map_err(|err| KbError::Internal(format!("替换 {} 失败: {err}", path.display())))?;
    println!("已写入 {}", path.display());
    Ok(ExitCode::SUCCESS)
}

fn backup_path(path: &Path) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let mut backup = path.to_path_buf();
    let name = format!(
        "{}.bak-kb-{stamp}",
        path.file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "config".to_owned())
    );
    backup.set_file_name(name);
    backup
}

/// 合并 `mcp.json`(保留其它 server),返回 (新内容, 是否替换了已有 kb 条目)。
fn merge_json(existing: &str) -> Result<(String, bool), CliError> {
    let mut value: serde_json::Value = if existing.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(existing)
            .map_err(|err| KbError::InvalidInput(format!("现有配置不是合法 JSON: {err}")))?
    };
    let object = value
        .as_object_mut()
        .ok_or_else(|| KbError::InvalidInput("现有配置不是 JSON 对象".to_owned()))?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        return Err(KbError::InvalidInput(
            "现有配置里的 mcpServers 不是对象,请手动检查".to_owned(),
        )
        .into());
    }
    let replaced = servers.get("kb").is_some();
    servers["kb"] = serde_json::json!({
        "command": "kb",
        "args": ["mcp"],
        "timeout": 120000,
    });
    Ok((
        format!(
            "{}\n",
            serde_json::to_string_pretty(&value).unwrap_or_default()
        ),
        replaced,
    ))
}

/// 合并 `config.toml`(没有 `mcp_servers.kb` 就追加)。
///
/// 用 TOML 解析判断而不是子串匹配:注释掉的 `# [mcp_servers.kb]` 不该被当成“已存在”,
/// `[ mcp_servers.kb ]`、内联表这类写法也要能识别。
fn merge_toml(existing: &str) -> String {
    if toml_has_kb(existing) {
        return existing.to_owned();
    }
    let mut out = existing.trim_end().to_owned();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str("[mcp_servers.kb]\ncommand = \"kb\"\nargs = [\"mcp\"]\n");
    out
}

/// 现有 `mcp_servers.kb` 是否与推荐值一致(`command = "kb"`、`args = ["mcp"]`)。
fn codex_entry_matches(existing: &str) -> bool {
    let Ok(value) = toml::from_str::<toml::Value>(existing) else {
        return false;
    };
    let Some(entry) = value
        .get("mcp_servers")
        .and_then(|servers| servers.get("kb"))
    else {
        return false;
    };
    let command_ok = entry.get("command").and_then(|v| v.as_str()) == Some("kb");
    let args_ok = entry
        .get("args")
        .and_then(|v| v.as_array())
        .is_some_and(|args| args.len() == 1 && args[0].as_str() == Some("mcp"));
    command_ok && args_ok
}

/// 现有 TOML 里是否已经有 `mcp_servers.kb`。
fn toml_has_kb(existing: &str) -> bool {
    toml::from_str::<toml::Value>(existing)
        .ok()
        .and_then(|value| value.get("mcp_servers").cloned())
        .and_then(|servers| servers.get("kb").cloned())
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kiro_merge_keeps_other_servers() {
        let existing = r#"{"mcpServers": {"other": {"command": "x"}}}"#;
        let (merged, replaced) = merge_json(existing).expect("合并");
        assert!(!replaced, "原本没有 kb 条目,不应算替换");
        let value: serde_json::Value = serde_json::from_str(&merged).expect("合法");
        assert_eq!(value["mcpServers"]["other"]["command"], "x");
        assert_eq!(value["mcpServers"]["kb"]["command"], "kb");
        assert_eq!(value["mcpServers"]["kb"]["args"][0], "mcp");
    }

    #[test]
    fn kiro_merge_on_empty_file() {
        let (merged, replaced) = merge_json("").expect("合并");
        assert!(!replaced);

        // 已经有 kb 条目 → 算替换
        let (_, replaced) = merge_json(&merged).expect("再次合并");
        assert!(replaced, "已存在 kb 条目应报告替换");
        let value: serde_json::Value = serde_json::from_str(&merged).expect("合法");
        assert_eq!(value["mcpServers"]["kb"]["timeout"], 120000);
    }

    #[test]
    fn codex_merge_appends_once() {
        let existing = "[model]\nname = \"x\"\n";
        let merged = merge_toml(existing);
        assert!(merged.contains("[mcp_servers.kb]"));
        assert!(merged.contains("[model]"));
        let again = merge_toml(&merged);
        assert_eq!(again.matches("[mcp_servers.kb]").count(), 1);
    }

    #[test]
    fn commented_out_table_is_not_treated_as_existing() {
        // 注释掉的 `[mcp_servers.kb]` 不能算“已存在”
        let existing = "# [mcp_servers.kb] was removed on purpose\n[model]\nname = \"x\"\n";
        assert!(!toml_has_kb(existing));
        let merged = merge_toml(existing);
        let headers = merged
            .lines()
            .filter(|line| line.trim() == "[mcp_servers.kb]")
            .count();
        assert_eq!(headers, 1, "应追加一个表头(注释行不算):{merged}");
        assert!(merged.contains("command = \"kb\""));
    }

    #[test]
    fn existing_table_is_left_untouched() {
        let existing = "[mcp_servers.kb]\ncommand = \"mine\"\n";
        assert!(toml_has_kb(existing));
        assert_eq!(merge_toml(existing), existing, "已有条目不应被改写");
    }

    #[test]
    fn codex_entry_content_is_compared() {
        let mine = "[mcp_servers.kb]\ncommand = \"mine\"\n";
        assert!(toml_has_kb(mine));
        assert!(!codex_entry_matches(mine), "内容不同不应算一致");

        let recommended = "[mcp_servers.kb]\ncommand = \"kb\"\nargs = [\"mcp\"]\n";
        assert!(codex_entry_matches(recommended));
    }

    #[test]
    fn inline_and_spaced_variants_are_detected() {
        let inline = "mcp_servers = { kb = { command = \"kb\" } }\n";
        assert!(toml_has_kb(inline), "内联表也算已存在");
        let spaced = "[ mcp_servers.kb ]\ncommand = \"kb\"\n";
        assert!(toml_has_kb(spaced), "带空格的表头也算已存在");
    }

    #[test]
    fn snippets_match_the_documented_format() {
        assert!(Client::Kiro.snippet().contains("\"args\": [\"mcp\"]"));
        assert!(Client::Claude.snippet().contains("claude mcp add"));
        assert!(Client::Codex.snippet().contains("[mcp_servers.kb]"));
    }
}
