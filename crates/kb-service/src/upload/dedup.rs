//! 上传去重:秒传与“同名不同内容”的三种策略。
//!
//! 判定口径(与 `POST /uploads/precheck` 的返回一致):
//! - `same_content`:同 collection 里已有**内容相同**(sha256 相同)的文件 → 客户端不必传字节;
//! - `same_name_diff_content`:同 collection 的同一 `rel_path` 已存在、内容不同 → 按策略处理;
//! - `new`:全新文件。
//!
//! 三种策略:
//! - `skip`:不入库(客户端连字节都不用传);
//! - `overwrite`:新内容替换同名文件,旧文件留一份备份(`.kb-prev/<id>`),撤销批次时可还原;
//! - `keep_both`:自动改名为 `名称 (2)`(再冲突就 `(3)` …)。

use std::sync::Arc;

use kb_core::Result;
use kb_core::model::{DedupStrategy, IngestFile, IngestState};
use kb_core::ports::repo::{IngestRepo, MetaStore};
use serde::Serialize;

/// 预检状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrecheckStatus {
    /// 内容相同(秒传)。
    SameContent,
    /// 同名不同内容。
    SameNameDiffContent,
    /// 全新。
    New,
}

impl PrecheckStatus {
    /// API 里的字符串。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SameContent => "same_content",
            Self::SameNameDiffContent => "same_name_diff_content",
            Self::New => "new",
        }
    }
}

/// 预检的一条输入。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrecheckItem {
    /// 集合内相对路径。
    pub rel_path: String,
    /// 字节数。
    pub size: u64,
    /// 客户端算的 sha256。
    pub sha256: String,
}

/// 预检结果里的“已有文件”摘要(不返回正文与磁盘路径)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct IngestBrief {
    /// 已有文件 id。
    pub id: String,
    /// 已有文件的相对路径。
    pub rel_path: String,
    /// 字节数。
    pub size: u64,
    /// 内容的 sha256。
    pub sha256: Option<String>,
    /// 状态。
    pub state: IngestState,
}

impl IngestBrief {
    /// 从 `ingest_files` 行裁剪。
    pub fn of(file: &IngestFile) -> Self {
        Self {
            id: file.id.clone(),
            rel_path: file.rel_path.clone(),
            size: file.size,
            sha256: file.sha256.clone(),
            state: file.state,
        }
    }
}

/// 一条预检结果。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PrecheckResult {
    /// 输入里的相对路径。
    pub rel_path: String,
    /// 输入里的字节数。
    pub size: u64,
    /// 输入里的 sha256。
    pub sha256: String,
    /// 判定。
    pub status: PrecheckStatus,
    /// 命中的已有文件(秒传 / 同名不同内容时有)。
    pub existing: Option<IngestBrief>,
}

/// 完成上传时对“已有同名文件”的处理决定。
#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    /// 全新文件,照常入库。
    New,
    /// 同名同内容且已完成:什么也不用做(秒传)。
    AlreadyExists(IngestFile),
    /// 同名不同内容 + `skip`:不入库。
    Skip(IngestFile),
    /// 同名不同内容 + `overwrite`:替换并备份旧文件。
    Overwrite(IngestFile),
    /// 同名不同内容 + `keep_both`:换一个不冲突的路径。
    KeepBoth {
        /// 已有文件。
        existing: IngestFile,
        /// 新路径。
        rel_path: String,
    },
}

/// 去重服务(无状态,持有元数据仓储)。
pub struct DedupService {
    meta: Arc<dyn MetaStore>,
}

impl DedupService {
    /// 构造。
    pub fn new(meta: Arc<dyn MetaStore>) -> Self {
        Self { meta }
    }

    /// 预检一批文件(逐个查 `ingest_files`)。
    pub async fn precheck(
        &self,
        collection: &str,
        items: &[PrecheckItem],
    ) -> Result<Vec<PrecheckResult>> {
        let mut results = Vec::with_capacity(items.len());
        for item in items {
            let by_path =
                IngestRepo::get_by_path(self.meta.as_ref(), collection, &item.rel_path).await?;
            let (status, existing) = match &by_path {
                Some(file) if file.sha256.as_deref() == Some(item.sha256.as_str()) => {
                    (PrecheckStatus::SameContent, Some(IngestBrief::of(file)))
                }
                Some(file) => (
                    PrecheckStatus::SameNameDiffContent,
                    Some(IngestBrief::of(file)),
                ),
                None => {
                    // 换个名字的同内容文件也算秒传:客户端不用再传一遍字节
                    match IngestRepo::find_done_by_sha(self.meta.as_ref(), collection, &item.sha256)
                        .await?
                    {
                        Some(file) => (PrecheckStatus::SameContent, Some(IngestBrief::of(&file))),
                        None => (PrecheckStatus::New, None),
                    }
                }
            };
            results.push(PrecheckResult {
                rel_path: item.rel_path.clone(),
                size: item.size,
                sha256: item.sha256.clone(),
                status,
                existing,
            });
        }
        Ok(results)
    }

    /// 完成上传时决定怎么处理。
    pub async fn decide(
        &self,
        collection: &str,
        rel_path: &str,
        sha256: &str,
        strategy: DedupStrategy,
    ) -> Result<Decision> {
        let Some(existing) =
            IngestRepo::get_by_path(self.meta.as_ref(), collection, rel_path).await?
        else {
            return Ok(Decision::New);
        };
        if existing.sha256.as_deref() == Some(sha256) {
            return Ok(Decision::AlreadyExists(existing));
        }
        Ok(match strategy {
            DedupStrategy::Skip => Decision::Skip(existing),
            DedupStrategy::Overwrite => Decision::Overwrite(existing),
            DedupStrategy::KeepBoth => {
                let rel_path = self.free_rel_path(collection, rel_path).await?;
                Decision::KeepBoth { existing, rel_path }
            }
        })
    }

    /// 找一个不冲突的路径:`note.md` → `note (2).md` → `note (3).md` …
    pub async fn free_rel_path(&self, collection: &str, rel_path: &str) -> Result<String> {
        let (dir, name) = split_path(rel_path);
        let (stem, extension) = split_extension(&name);
        for index in 2..1000u32 {
            let candidate = match (&dir, &extension) {
                (Some(dir), Some(extension)) => {
                    format!("{dir}/{stem} ({index}).{extension}")
                }
                (Some(dir), None) => format!("{dir}/{stem} ({index})"),
                (None, Some(extension)) => format!("{stem} ({index}).{extension}"),
                (None, None) => format!("{stem} ({index})"),
            };
            if IngestRepo::get_by_path(self.meta.as_ref(), collection, &candidate)
                .await?
                .is_none()
            {
                return Ok(candidate);
            }
        }
        Err(kb_core::KbError::InvalidInput(format!(
            "{rel_path} 的同名文件太多,请先整理后再上传"
        )))
    }
}

/// 拆出目录部分(没有目录时为 `None`)。
fn split_path(rel_path: &str) -> (Option<String>, String) {
    match rel_path.rsplit_once('/') {
        Some((dir, name)) if !dir.is_empty() => (Some(dir.to_owned()), name.to_owned()),
        Some((_, name)) => (None, name.to_owned()),
        None => (None, rel_path.to_owned()),
    }
}

/// 拆出扩展名(点号开头或没有扩展名时为 `None`)。
fn split_extension(name: &str) -> (String, Option<String>) {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => {
            (stem.to_owned(), Some(extension.to_owned()))
        }
        _ => (name.to_owned(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_split_into_directory_and_extension() {
        assert_eq!(
            split_path("docs/readme.md"),
            (Some("docs".to_owned()), "readme.md".to_owned())
        );
        assert_eq!(split_path("readme.md"), (None, "readme.md".to_owned()));
        assert_eq!(
            split_path("a/b/c.txt"),
            (Some("a/b".to_owned()), "c.txt".to_owned())
        );
        assert_eq!(
            split_extension("readme.md"),
            ("readme".to_owned(), Some("md".to_owned()))
        );
        assert_eq!(split_extension("Makefile"), ("Makefile".to_owned(), None));
        assert_eq!(
            split_extension(".gitignore"),
            (".gitignore".to_owned(), None),
            "点开头的隐藏文件不拆扩展名"
        );
        assert_eq!(
            split_extension("a.tar.gz"),
            ("a.tar".to_owned(), Some("gz".to_owned()))
        );
    }
}
