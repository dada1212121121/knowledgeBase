//! git 增量。
//!
//! 用 git2 计算 `projects.last_commit..HEAD` 之间变化的文件,再叠加工作区里未提交的变化
//! (index + worktree + untracked)。异常情况:
//!
//! - `last_commit` 为空、或那个提交已经不存在(rebase / force push)→ 返回 `fallback = true`,
//!   调用方改用“全量扫描 + 文件哈希”判断(设计规范的快速跳过会跳过没变的文件);
//! - HEAD 处于 detached 状态 → 照常处理(直接读 HEAD 指向的提交)。

use std::collections::BTreeSet;
use std::path::Path;

use kb_core::{KbError, Result};

/// 一次增量计算的结果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChangedFiles {
    /// 变化的文件(项目内相对路径,`/` 分隔,已排序去重)。
    pub paths: Vec<String>,
    /// 当前 HEAD 的提交 id(没有提交时为 `None`)。
    pub head: Option<String>,
    /// 是否因为 `last_commit` 不可用而无法做增量(调用方要退回全量)。
    pub fallback: bool,
}

impl ChangedFiles {
    /// 是否有变化。
    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }
}

/// 一个 git 仓库。
pub struct GitRepo {
    repo: git2::Repository,
    root: std::path::PathBuf,
}

impl GitRepo {
    /// 打开项目根目录的仓库。
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        let repo = git2::Repository::discover(&root).map_err(|err| {
            KbError::InvalidInput(format!("{} 不是 git 仓库: {err}", root.display()))
        })?;
        let workdir = repo
            .workdir()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| root.clone());
        Ok(Self {
            repo,
            root: workdir,
        })
    }

    /// 仓库工作区根目录。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 当前 HEAD 的提交 id(空仓库时 `None`)。
    pub fn head_oid(&self) -> Option<String> {
        self.repo
            .head()
            .ok()?
            .peel_to_commit()
            .ok()
            .map(|commit| commit.id().to_string())
    }

    /// 计算 `from..HEAD` 的变更 + 工作区未提交的变更。
    pub fn changed_since(&self, from: Option<&str>) -> Result<ChangedFiles> {
        let mut paths: BTreeSet<String> = BTreeSet::new();
        let head = self.head_oid();
        let mut fallback = false;

        match (from, &head) {
            (Some(from), Some(head)) => match self.diff_commits(from, head) {
                Ok(changed) => paths.extend(changed),
                // last_commit 不存在(rebase / force push):只能退回全量
                Err(_) => fallback = true,
            },
            // 没有 last_commit(第一次收到事件):同样退回全量
            _ => fallback = true,
        }

        // 工作区里未提交的变化(已暂存 + 未暂存 + untracked)
        for path in self.worktree_changes()? {
            paths.insert(path);
        }

        Ok(ChangedFiles {
            paths: paths.into_iter().collect(),
            head,
            fallback,
        })
    }

    fn diff_commits(&self, from: &str, to: &str) -> Result<Vec<String>> {
        let from_oid = git2::Oid::from_str(from)
            .map_err(|err| KbError::InvalidInput(format!("last_commit 不是合法 id: {err}")))?;
        let from_commit = self
            .repo
            .find_commit(from_oid)
            .map_err(|err| KbError::InvalidInput(format!("找不到提交 {from}: {err}")))?;
        let to_commit = self
            .repo
            .find_commit(
                git2::Oid::from_str(to)
                    .map_err(|err| KbError::InvalidInput(format!("HEAD 不是合法 id: {err}")))?,
            )
            .map_err(|err| KbError::Internal(format!("找不到 HEAD: {err}")))?;
        let from_tree = from_commit
            .tree()
            .map_err(|err| KbError::Internal(format!("读树失败: {err}")))?;
        let to_tree = to_commit
            .tree()
            .map_err(|err| KbError::Internal(format!("读树失败: {err}")))?;
        let diff = self
            .repo
            .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), None)
            .map_err(|err| KbError::Internal(format!("diff 失败: {err}")))?;

        let mut out = Vec::new();
        diff.foreach(
            &mut |delta, _| {
                for file in [delta.old_file(), delta.new_file()] {
                    if let Some(path) = file.path() {
                        out.push(normalize(&self.root, &path.to_string_lossy()));
                    }
                }
                true
            },
            None,
            None,
            None,
        )
        .map_err(|err| KbError::Internal(format!("遍历 diff 失败: {err}")))?;
        out.retain(|path| !path.is_empty());
        Ok(out)
    }

    fn worktree_changes(&self) -> Result<Vec<String>> {
        let statuses = self
            .repo
            .statuses(Some(
                git2::StatusOptions::new()
                    .include_untracked(true)
                    .recurse_untracked_dirs(true)
                    .include_ignored(false)
                    .renames_head_to_index(true),
            ))
            .map_err(|err| KbError::Internal(format!("读工作区状态失败: {err}")))?;
        let mut out = Vec::new();
        for entry in statuses.iter() {
            if let Ok(path) = entry.path() {
                out.push(path.to_owned());
            }
        }
        Ok(out)
    }
}

/// 把 git 路径规范成项目内相对路径(只统一分隔符)。
///
/// git 的 diff / status 路径**本来就是相对仓库根**的,从不带仓库目录名前缀;
/// 早期版本会剥掉一层同名前缀,导致 `webapp/webapp/main.rs` 被误改成 `main.rs`。
fn normalize(_root: &Path, path: &str) -> String {
    path.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_keeps_paths_as_git_reports_them() {
        let root = Path::new("/srv/sampleapp");
        assert_eq!(normalize(root, "src/main.rs"), "src/main.rs");
        // 仓库目录名与顶层子目录同名时不能被剥掉
        assert_eq!(
            normalize(root, "SampleApp/src/main.rs"),
            "SampleApp/src/main.rs"
        );
    }
}
