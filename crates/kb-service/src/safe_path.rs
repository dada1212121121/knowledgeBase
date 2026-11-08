//! 用户传来的「集合内相对路径」的统一守卫。
//!
//! 背景:`save_file` / `convert_to_markdown` / `file_preview` 的 `path` 参数由调用者自己填。
//! 以前在项目根和数据源目录下直接 `join(rel_path)`,而 `Path::join` 遇到绝对路径会**整体替换**基准路径,
//! 遇到 `..` 又能一路跳出去。单用户时代调用者就是机器主人,不算问题;多用户之后普通用户也能调这些能力,
//! 等于能读写服务器上任意文件(别人的 `meta.db`、`secrets.toml`……)。所以:
//!
//! 1. 先在字符串层面拒绝绝对路径和 `..`;
//! 2. 再把拼出来的路径做 `canonicalize`(软链接也一并解开),要求真实位置仍在基准目录里。

use std::path::{Path, PathBuf};

use kb_core::{KbError, Result};

/// 相对路径必须是「集合内的相对路径」:非空、不含 NUL、不是绝对路径、没有 `..` 段。
///
/// 反斜杠也按分隔符处理:上传来的文件名可能带 `\`,而 Windows 风格的 `..\..\x` 不该因此漏过去。
pub fn check_rel_path(rel: &str) -> Result<()> {
    let bad = rel.is_empty()
        || rel.contains('\0')
        || rel.starts_with('/')
        || rel.starts_with('\\')
        // `C:\x`、`C:/x` 这种带盘符的写法
        || rel.as_bytes().get(1) == Some(&b':')
        || rel.split(['/', '\\']).any(|part| part == "..");
    if bad {
        return Err(KbError::InvalidInput(format!(
            "path 必须是集合内的相对路径(不能是绝对路径,也不能含 ..):{rel}"
        )));
    }
    Ok(())
}

/// 在 `base` 下找 `rel` 这个普通文件;**真实路径**不在 `base` 里(软链接指到外面)就当没找到。
///
/// 返回规范化后的绝对路径。`rel` 要先过 [`check_rel_path`]。
pub fn resolve_inside(base: &Path, rel: &str) -> Option<PathBuf> {
    let real = base.join(rel).canonicalize().ok()?;
    let base = base.canonicalize().ok()?;
    (real.starts_with(&base) && real.is_file()).then_some(real)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_parent_and_odd_paths() {
        for bad in [
            "",
            "/etc/passwd",
            "\\windows\\x",
            "../x",
            "a/../../x",
            "a\\..\\..\\x",
            "..",
            "C:\\x",
            "C:/x",
            "a\0b",
        ] {
            assert!(check_rel_path(bad).is_err(), "应拒绝:{bad:?}");
        }
        for good in [
            "a.md",
            "docs/a.md",
            "docs/..hidden/a.md",
            "a..b/c.md",
            "中文/笔记.md",
        ] {
            assert!(check_rel_path(good).is_ok(), "应放行:{good:?}");
        }
    }

    #[test]
    fn resolve_inside_stays_inside_the_base_even_through_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(base.join("sub/ok.md"), "ok").unwrap();
        std::fs::write(outside.join("secret.md"), "secret").unwrap();
        // 软链接指到外面:字符串上看不出问题,真实路径出了界
        std::os::unix::fs::symlink(&outside, base.join("link")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.md"), base.join("secret-link.md")).unwrap();

        assert!(resolve_inside(&base, "sub/ok.md").is_some());
        assert!(resolve_inside(&base, "link/secret.md").is_none());
        assert!(resolve_inside(&base, "secret-link.md").is_none());
        assert!(resolve_inside(&base, "sub").is_none(), "目录不是文件");
        assert!(resolve_inside(&base, "nope.md").is_none());
    }
}
