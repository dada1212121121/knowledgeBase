//! `kb skill`:打印公开 Agent Skill,或写到文件。
//!
//! 正文唯一真源是 `kb_core::SKILL_MD`,与 Web 的 `/skill.md`、`/api/v1/skill` 完全一致。
//! 这里不生成、不替换、不追加任何账号信息,保证输出可以安全地公开。

use std::path::Path;

use kb_core::{KbError, Result};

/// 打印或写出公开 Skill。
pub fn run(out: Option<&Path>) -> Result<()> {
    let text = text();
    match out {
        Some(path) => {
            std::fs::write(path, text)
                .map_err(|err| KbError::Internal(format!("写入 {} 失败: {err}", path.display())))?;
            println!("已写入 {} ({} 字节)", path.display(), text.len());
        }
        None => print!("{text}"),
    }
    Ok(())
}

/// 公开 Skill 正文;测试与 Web 都从这里取,避免出现第二份。
pub fn text() -> &'static str {
    kb_core::SKILL_MD
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_exact_same_bytes_as_the_embedded_copy() {
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join("SKILL.md");
        run(Some(&path)).expect("写出");
        assert_eq!(std::fs::read_to_string(&path).expect("读回"), text());
    }

    #[test]
    fn output_has_no_credentials_or_template_placeholders() {
        for forbidden in ["kb_ak_", "Bearer kb_", "{{"] {
            assert!(
                !text().contains(forbidden),
                "公开 Skill 不能包含 {forbidden:?}"
            );
        }
    }

    #[test]
    fn output_is_a_usable_agent_skill() {
        assert!(text().starts_with("---\nname: knowledgebase\n"));
        assert!(text().contains("search_knowledge"));
        assert!(text().contains("doc_read"));
    }
}
