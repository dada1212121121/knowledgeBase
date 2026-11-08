//! 链式 git hook 安装。
//!
//! 只动**当前仓库**的 hooks 目录(尊重 worktree 与 `core.hooksPath`);
//! 每个 hook:原文件 → `<name>.kb-orig`,新文件是调用原 hook 再后台通知的脚本。
//! husky 之类的托管目录(`.husky/`)不改动,只在 `status` 里提示。

use std::path::{Path, PathBuf};

use kb_core::{KbError, Result};

/// 安装的四个 hook。
pub const HOOK_NAMES: [&str; 4] = ["post-commit", "post-merge", "post-checkout", "post-rewrite"];

/// hook 模板(仓库里的 `scripts/hooks/kb-hook.sh`)。
const TEMPLATE: &str = include_str!("../../../../scripts/hooks/kb-hook.sh");

/// 单个 hook 的状态。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HookStatus {
    /// hook 名。
    pub name: String,
    /// 是否已由 kb 安装。
    pub installed: bool,
    /// 是否有被备份的原 hook。
    pub has_original: bool,
}

/// 安装/卸载结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HookReport {
    /// hooks 目录。
    pub hooks_dir: String,
    /// 是否因为 hooksPath 被托管(husky 等)而跳过。
    pub managed_by_other: bool,
    /// 各 hook 的状态。
    pub hooks: Vec<HookStatus>,
}

/// hook 管理器。
pub struct HookManager {
    repo: git2::Repository,
    root: PathBuf,
}

impl HookManager {
    /// 打开项目根目录的仓库。
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        let repo = git2::Repository::discover(&root).map_err(|err| {
            KbError::InvalidInput(format!("{} 不是 git 仓库: {err}", root.display()))
        })?;
        Ok(Self { repo, root })
    }

    /// hooks 目录(尊重 worktree 与 `core.hooksPath`)。
    pub fn hooks_dir(&self) -> Result<PathBuf> {
        if let Ok(config) = self.repo.config()
            && let Ok(value) = config.get_string("core.hooksPath")
            && !value.trim().is_empty()
        {
            let path = PathBuf::from(value.trim());
            return Ok(if path.is_absolute() {
                path
            } else {
                self.repo.workdir().unwrap_or(&self.root).join(path)
            });
        }
        // worktree 的 hooks 在 common dir 下
        Ok(self.repo.commondir().join("hooks"))
    }

    /// 是否由别的工具托管(husky 等把 hooksPath 指到 `.husky/` 之类)。
    fn managed_by_other(&self) -> bool {
        self.repo
            .config()
            .ok()
            .and_then(|config| config.get_string("core.hooksPath").ok())
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    }

    /// 安装四个 hook(幂等)。
    pub fn install(&self, socket: &Path) -> Result<HookReport> {
        let dir = self.hooks_dir()?;
        if self.managed_by_other() {
            return self.report(&dir, true);
        }
        std::fs::create_dir_all(&dir).map_err(|err| {
            KbError::Internal(format!("创建 hooks 目录 {} 失败: {err}", dir.display()))
        })?;
        for name in HOOK_NAMES {
            self.install_one(&dir, name, socket)?;
        }
        self.report(&dir, false)
    }

    /// 卸载四个 hook,恢复原文件。
    pub fn uninstall(&self) -> Result<HookReport> {
        let dir = self.hooks_dir()?;
        if self.managed_by_other() {
            return self.report(&dir, true);
        }
        for name in HOOK_NAMES {
            let hook = dir.join(name);
            let orig = dir.join(format!("{name}.kb-orig"));
            // 只有当前 hook 是 kb 装的才动它:别的工具后来又写过,就保持原样
            let ours = is_kb_hook(&hook);
            if ours {
                std::fs::remove_file(&hook).map_err(|err| {
                    KbError::Internal(format!("删除 {} 失败: {err}", hook.display()))
                })?;
            }
            if orig.exists() && (ours || !hook.exists()) {
                std::fs::rename(&orig, &hook).map_err(|err| {
                    KbError::Internal(format!("恢复 {} 失败: {err}", hook.display()))
                })?;
            }
        }
        self.report(&dir, false)
    }

    /// 当前状态。
    pub fn status(&self) -> Result<HookReport> {
        let dir = self.hooks_dir()?;
        let managed = self.managed_by_other();
        self.report(&dir, managed)
    }

    fn install_one(&self, dir: &Path, name: &str, socket: &Path) -> Result<()> {
        let hook = dir.join(name);
        let orig = dir.join(format!("{name}.kb-orig"));
        // 已经装过:只刷新脚本(幂等),不再备份。
        // 当前 hook 不是 kb 的(别的工具后来又写过)时,换一个不冲突的备份名,绝不覆盖用户文件
        if !is_kb_hook(&hook) && hook.exists() {
            let target = if orig.exists() {
                let mut index = 1;
                loop {
                    let candidate = dir.join(format!("{name}.kb-orig.{index}"));
                    if !candidate.exists() {
                        break candidate;
                    }
                    index += 1;
                }
            } else {
                orig.clone()
            };
            std::fs::rename(&hook, &target)
                .map_err(|err| KbError::Internal(format!("备份 {} 失败: {err}", hook.display())))?;
        }
        let kind = match name {
            "post-commit" => "git_commit",
            "post-merge" => "git_merge",
            "post-checkout" => "git_checkout",
            // post-rewrite 对应 amend / rebase
            _ => "git_commit",
        };
        let script = TEMPLATE
            .replace("__KB_SOCKET__", &socket.to_string_lossy())
            .replace("__KB_KIND__", kind);
        std::fs::write(&hook, script)
            .map_err(|err| KbError::Internal(format!("写 {} 失败: {err}", hook.display())))?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755))
            .map_err(|err| KbError::Internal(format!("chmod {} 失败: {err}", hook.display())))?;
        Ok(())
    }

    fn report(&self, dir: &Path, managed: bool) -> Result<HookReport> {
        let hooks = HOOK_NAMES
            .iter()
            .map(|name| {
                let hook = dir.join(name);
                let orig = dir.join(format!("{name}.kb-orig"));
                HookStatus {
                    name: (*name).to_owned(),
                    installed: is_kb_hook(&hook),
                    has_original: orig.exists(),
                }
            })
            .collect();
        Ok(HookReport {
            hooks_dir: dir.to_string_lossy().into_owned(),
            managed_by_other: managed,
            hooks,
        })
    }
}

/// 这个文件是不是 kb 装的 hook。
fn is_kb_hook(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|text| text.contains("kb 链式 git hook 模板"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_contains_the_placeholders() {
        assert!(TEMPLATE.contains("__KB_SOCKET__"));
        assert!(TEMPLATE.contains("__KB_KIND__"));
        assert!(
            TEMPLATE.contains("exit $status"),
            "必须保留原 hook 的退出码"
        );
    }
}
