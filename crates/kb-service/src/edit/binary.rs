//! 二进制文件(Word / Excel / PPT / PDF / 图片…)的"上传新版本替换原件",带版本历史。
//!
//! 文本文件的版本把整份正文存进 `item_versions.body`;二进制文件放不进去,改成**按内容寻址的备份**:
//! 每份字节存成 `<KB_HOME>/file-versions/<sha256 前两位>/<sha256>`,版本行的 body 只记一个标记
//! `\0kb-blob:<sha256>:<字节数>`。正文开头不可能是 NUL(可编辑文本不含 NUL),所以和文本版本不会混淆;
//! 同样的内容只存一份,反复改回改去不会越占越多。
//!
//! 替换流程:校验(大小 / 非空 / 可选的乐观锁)→ 第一次替换时把**原来的字节**记成基线版本 →
//! 新字节写进备份库并记一版 → 临时文件 + 改名原子地写回原位置 → 重新索引(办公文档走抽取器)。

use std::io::Write;
use std::path::{Path, PathBuf};

use kb_core::model::ItemVersion;
use kb_core::ports::repo::VersionRepo;
use kb_core::{KbError, Result};
use serde::Serialize;

use super::{FileEditService, now_millis};

/// 版本 body 里二进制备份的标记前缀。
pub const BINARY_MARK: &str = "\0kb-blob:";

/// 替换原件的大小上限(与上传分片的请求体上限一致)。更大的文件请用"导入"上传成新文件。
pub const MAX_REPLACE_BYTES: u64 = 64 * 1024 * 1024;

/// 一份二进制备份的引用。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlobRef {
    /// 内容的 sha256(十六进制)。
    pub sha256: String,
    /// 字节数。
    pub size: u64,
}

/// 写进版本 body 的标记。
pub fn blob_ref(sha256: &str, size: u64) -> String {
    format!("{BINARY_MARK}{sha256}:{size}")
}

/// 二进制版本的字节数;文本版本返回 `None`(版本列表据此显示大小、不给文字预览)。
pub fn blob_size(body: &str) -> Option<u64> {
    blob_of(body).map(|blob| blob.size)
}

/// 从版本 body 里认出二进制备份;不是就返回 `None`(普通文本版本)。
pub(crate) fn blob_of(body: &str) -> Option<BlobRef> {
    let rest = body.strip_prefix(BINARY_MARK)?;
    let (sha256, size) = rest.split_once(':')?;
    let valid = sha256.len() == 64 && sha256.bytes().all(|byte| byte.is_ascii_hexdigit());
    valid.then(|| BlobRef {
        sha256: sha256.to_ascii_lowercase(),
        size: size.parse().unwrap_or(0),
    })
}

/// 替换的结果。
#[derive(Clone, Debug, Serialize)]
pub struct ReplaceFileResult {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径。
    pub path: String,
    /// 新版本号。
    pub version: i64,
    /// 版本记录 id。
    pub version_id: String,
    /// 新内容的 sha256。
    pub sha256: String,
    /// 新内容的字节数。
    pub size: u64,
    /// 重新嵌入的块数。
    pub embedded: u64,
    /// 文件当前的块数。
    pub chunks: u64,
    /// 内容和原来完全一样,什么都没做。
    pub unchanged: bool,
    /// 原件是完整的 Office 包时:原件里有、新文件里没有的部件(编辑器清理了没人引用的图片之类,通常没问题,
    /// 但也可能是编辑器丢了东西)。界面把它告诉用户;原件作为旧版本留着,随时可以恢复。
    pub parts_removed: Vec<String>,
}
/// 「不改直接保存」的无损检查结果:编辑器把没改过的文档重新保存了一遍,这份字节和原件比。
#[derive(Clone, Debug, Serialize)]
pub struct RoundtripReport {
    /// 重新保存的字节本身是不是完整的 Office 包。
    pub valid: bool,
    /// 不完整时的原因。
    pub reason: Option<String>,
    /// 无损:完整,并且每个部件都和原件一样(XML 按结构比,忽略空白和属性顺序)。
    pub lossless: bool,
    /// 内容不一样的部件。
    pub changed_parts: Vec<String>,
    /// 原件有、重新保存后没有的部件(通常意味着丢了东西)。
    pub removed_parts: Vec<String>,
    /// 重新保存后多出来的部件。
    pub added_parts: Vec<String>,
    /// 抽出来的文字是否一样(部件不同但文字一样,多半只是格式细节变了)。
    pub text_equal: bool,
}

impl FileEditService {
    /// 编辑器把**没改过**的文档重新保存了一遍:和原件比,看这个引擎能不能无损地处理这份文档。
    /// 不能的话(页脚被重写成了别的样子、图片丢了…)界面就不该让人在这份文档上直接编辑。
    pub async fn roundtrip_report(
        &self,
        collection: &str,
        rel_path: &str,
        resaved: &[u8],
    ) -> Result<RoundtripReport> {
        let extension = rel_path
            .rsplit_once('.')
            .map(|(_, extension)| extension.to_owned())
            .unwrap_or_default();
        if kb_extract::office_check::OfficeKind::from_extension(&extension).is_none() {
            return Err(KbError::InvalidInput(format!(
                "{rel_path} 不是 Word / Excel / PowerPoint 文件"
            )));
        }
        if resaved.is_empty() || resaved.len() as u64 > MAX_REPLACE_BYTES {
            return Err(KbError::InvalidInput(
                "重新保存的文件是空的或太大".to_owned(),
            ));
        }
        let path = self.locate(collection, rel_path).await?;
        let original = std::fs::read(&path)
            .map_err(|err| KbError::Internal(format!("读取原件 {} 失败: {err}", path.display())))?;
        let (old, new, ext) = (original.clone(), resaved.to_vec(), extension.clone());
        let (verdict, diff) = tokio::task::spawn_blocking(move || {
            let verdict = kb_extract::office_check::validate(&new, &ext);
            let diff = kb_extract::office_check::compare(&old, &new);
            (verdict, diff)
        })
        .await
        .map_err(|err| KbError::Internal(format!("检查的线程异常: {err}")))?;
        let valid = verdict.is_ok();
        let diff = diff.unwrap_or_default();
        let identical = valid && diff.is_identical();
        let text_equal = identical
            || self
                .same_text(rel_path, &extension, &original, resaved)
                .await;
        Ok(RoundtripReport {
            valid,
            reason: verdict.err(),
            lossless: identical,
            changed_parts: diff.changed,
            removed_parts: diff.removed,
            added_parts: diff.added,
            text_equal,
        })
    }

    /// 两份文档抽出来的文字一样吗(抽取失败按不一样算)。
    async fn same_text(&self, rel_path: &str, extension: &str, left: &[u8], right: &[u8]) -> bool {
        let source = kb_core::model::SourceRef {
            scheme: "file".to_owned(),
            location: rel_path.to_owned(),
            project_root: None,
        };
        // 进程级注册表:插件/测试注入的抽取器与这里看到的是同一份。
        let registry = kb_extract::registry::global();
        let (left, right) = tokio::join!(
            registry.extract(&source, left, extension),
            registry.extract(&source, right, extension)
        );
        match (left, right) {
            (Ok(left), Ok(right)) => left.text() == right.text(),
            _ => false,
        }
    }

    /// 备份库的根目录。
    fn blob_root(&self) -> PathBuf {
        self.paths.home().join("file-versions")
    }

    fn blob_path(&self, sha256: &str) -> PathBuf {
        self.blob_root().join(&sha256[..2]).join(sha256)
    }

    /// 把一份字节存进备份库(已有同样内容就不重复写),返回它的引用。
    fn store_blob(&self, bytes: &[u8]) -> Result<BlobRef> {
        let sha256 = kb_core::hash::sha256_hex_bytes(bytes);
        let target = self.blob_path(&sha256);
        if !target.is_file() {
            let dir = target.parent().unwrap_or(Path::new("."));
            std::fs::create_dir_all(dir)
                .map_err(|err| KbError::Internal(format!("创建版本备份目录失败: {err}")))?;
            write_atomically(&target, bytes)?;
        }
        Ok(BlobRef {
            sha256,
            size: bytes.len() as u64,
        })
    }

    /// 读一份备份;丢了(被人手工删掉)要说清楚,不能当成空文件恢复回去。
    pub(super) fn read_blob(&self, blob: &BlobRef) -> Result<Vec<u8>> {
        let bytes = std::fs::read(self.blob_path(&blob.sha256)).map_err(|err| {
            KbError::NotFound(format!("这一版的备份文件找不到了,不能恢复: {err}"))
        })?;
        if kb_core::hash::sha256_hex_bytes(&bytes) != blob.sha256 {
            return Err(KbError::Internal(
                "这一版的备份文件内容对不上(可能被改过),不能恢复".to_owned(),
            ));
        }
        Ok(bytes)
    }

    /// 用新内容替换一个文件(上传新版本 / 恢复二进制旧版本 / 表格改值都走这里)。
    ///
    /// `expected_sha256`:调用方看到的那份内容的 sha256;给了就做乐观锁,文件这期间被别人换过就返回冲突,
    /// 而不是悄悄盖掉别人的改动。
    pub async fn replace_bytes(
        &self,
        collection: &str,
        rel_path: &str,
        bytes: &[u8],
        expected_sha256: Option<&str>,
        author: &str,
    ) -> Result<ReplaceFileResult> {
        self.replace_bytes_in(collection, rel_path, bytes, expected_sha256, author, None)
            .await
    }

    /// 多人协同的一次会话落地:和 [`Self::replace_bytes`] 一样检查、写回、重新索引,
    /// 但同一个会话(`session`)的多次落地**合并成一个版本**——第一次新增,之后更新它的内容和作者。
    /// 否则停手 2 秒就落地一次,保留份数一满,协同之前的原件就被挤掉了。
    pub async fn land_session(
        &self,
        collection: &str,
        rel_path: &str,
        bytes: &[u8],
        expected_sha256: Option<&str>,
        authors: &str,
        session: &str,
    ) -> Result<ReplaceFileResult> {
        self.replace_bytes_in(
            collection,
            rel_path,
            bytes,
            expected_sha256,
            authors,
            Some(session),
        )
        .await
    }

    /// 协同房间的底稿:把文件现在的内容存进按内容寻址的备份库(已有就不重复写),返回它的引用和备份文件路径。
    /// 房间开着期间所有人都从这份字节打开(从落地后的新文件打开会得到另一套协同身份,和房间里的内容重复)。
    pub async fn session_base(
        &self,
        collection: &str,
        rel_path: &str,
    ) -> Result<(String, u64, PathBuf)> {
        let path = self.locate(collection, rel_path).await?;
        let bytes = std::fs::read(&path)
            .map_err(|err| KbError::Internal(format!("读取原件 {} 失败: {err}", path.display())))?;
        if bytes.len() as u64 > MAX_REPLACE_BYTES {
            return Err(KbError::InvalidInput(format!(
                "文件超过 {} MB,不能在线编辑",
                MAX_REPLACE_BYTES / 1024 / 1024
            )));
        }
        let blob = self.store_blob(&bytes)?;
        let file = self.blob_path(&blob.sha256);
        Ok((blob.sha256, blob.size, file))
    }

    /// 备份库里某份内容的路径(sha256 不合法或不存在返回 `None`)。
    pub fn blob_file(&self, sha256: &str) -> Option<PathBuf> {
        if sha256.len() != 64
            || !sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return None;
        }
        let path = self.blob_path(sha256);
        path.is_file().then_some(path)
    }

    async fn replace_bytes_in(
        &self,
        collection: &str,
        rel_path: &str,
        bytes: &[u8],
        expected_sha256: Option<&str>,
        author: &str,
        session: Option<&str>,
    ) -> Result<ReplaceFileResult> {
        if bytes.is_empty() {
            return Err(KbError::InvalidInput("新文件是空的".to_owned()));
        }
        if bytes.len() as u64 > MAX_REPLACE_BYTES {
            return Err(KbError::InvalidInput(format!(
                "新文件超过 {} MB,请用「导入」上传成新文件",
                MAX_REPLACE_BYTES / 1024 / 1024
            )));
        }
        let path = self.locate(collection, rel_path).await?;
        let before = std::fs::read(&path)
            .map_err(|err| KbError::Internal(format!("读取原件 {} 失败: {err}", path.display())))?;
        let before_sha = kb_core::hash::sha256_hex_bytes(&before);
        // 编辑器是浏览器里的引擎,服务器不能照单全收:原件是个完整的 Office 包,新文件也必须是,
        // 否则 Word / Excel 打开时会提示「需要修复」,而用户的原件已经被换掉了。
        // 原件本身就不完整的(手工拼的测试文件、损坏的)不设这个门槛——不能比原来更糟,但也不拦着换成好的
        let mut parts_removed: Vec<String> = Vec::new();
        if let Some(extension) = rel_path
            .rsplit_once('.')
            .map(|(_, extension)| extension.to_owned())
            && kb_extract::office_check::OfficeKind::from_extension(&extension).is_some()
        {
            let (old, new) = (before.clone(), bytes.to_vec());
            let (verdict, removed) = tokio::task::spawn_blocking(move || {
                if kb_extract::office_check::validate(&old, &extension).is_ok() {
                    let verdict = kb_extract::office_check::validate(&new, &extension).map(|_| ());
                    let removed = if verdict.is_ok() {
                        kb_extract::office_check::compare(&old, &new)
                            .map(|diff| diff.removed)
                            .unwrap_or_default()
                    } else {
                        Vec::new()
                    };
                    (verdict, removed)
                } else {
                    (Ok(()), Vec::new())
                }
            })
            .await
            .map_err(|err| KbError::Internal(format!("检查新文件的线程异常: {err}")))?;
            parts_removed = removed;
            if let Err(reason) = verdict {
                return Err(KbError::InvalidInput(format!(
                    "新文件不是完整的 Office 文件,没有保存,原文件没动:{reason}"
                )));
            }
        }
        if let Some(expected) = expected_sha256
            && !expected.eq_ignore_ascii_case(&before_sha)
        {
            return Err(KbError::InvalidInput(
                "这个文件在你打开之后被别人换过了,请刷新后再替换".to_owned(),
            ));
        }
        let item_id = Self::item_id(collection, rel_path);
        let latest = VersionRepo::latest_version(self.meta.as_ref(), &item_id).await?;
        let new_sha = kb_core::hash::sha256_hex_bytes(bytes);
        if new_sha == before_sha {
            let chunks =
                kb_core::ports::repo::ChunkRepo::by_path(self.meta.as_ref(), collection, rel_path)
                    .await?
                    .len() as u64;
            return Ok(ReplaceFileResult {
                collection: collection.to_owned(),
                path: rel_path.to_owned(),
                version: latest,
                version_id: String::new(),
                sha256: new_sha,
                size: bytes.len() as u64,
                embedded: 0,
                chunks,
                unchanged: true,
                parts_removed: Vec::new(),
            });
        }

        let now = now_millis();
        // 第一次替换:原来的内容记成基线版本 1,否则版本历史里只有替换后的内容,没法换回去
        let mut version = latest;
        if latest == 0 && !before.is_empty() {
            let blob = self.store_blob(&before)?;
            self.record(
                &item_id, collection, rel_path, 1, &blob, "baseline", now, None,
            )
            .await?;
            version = 1;
        }
        let blob = self.store_blob(bytes)?;
        // 同一个协同会话的后续落地:更新这个会话的那一版,不新增
        let current = match session {
            Some(session) => VersionRepo::list(self.meta.as_ref(), &item_id, 1)
                .await?
                .into_iter()
                .next()
                .filter(|latest| latest.batch_id.as_deref() == Some(session)),
            None => None,
        };
        let (version, version_id) = match current {
            Some(latest) => {
                VersionRepo::amend(
                    self.meta.as_ref(),
                    &latest.id,
                    &blob_ref(&blob.sha256, blob.size),
                    author,
                    now,
                )
                .await?;
                (latest.version, latest.id)
            }
            None => {
                let version = version + 1;
                let id = self
                    .record(
                        &item_id, collection, rel_path, version, &blob, author, now, session,
                    )
                    .await?;
                (version, id)
            }
        };

        write_atomically(&path, bytes)?;
        let (embedded, chunks) = self.reindex(collection, rel_path, &path).await?;
        // 清理只是回收空间,失败不能让已经成功的保存变成失败
        if let Err(err) = self.prune_binary_versions(&item_id).await {
            tracing::warn!(error = %err, file = rel_path, "清理旧版本备份失败");
        }
        Ok(ReplaceFileResult {
            collection: collection.to_owned(),
            path: rel_path.to_owned(),
            version,
            version_id,
            sha256: blob.sha256,
            size: blob.size,
            embedded,
            chunks,
            unchanged: false,
            parts_removed,
        })
    }

    /// 二进制版本只留当前这一版加 `keep_versions` 份旧的,更早的删掉记录;备份文件没有任何版本引用了才删。
    /// 文本版本(同一个文件以前当文本编辑过)不动。
    async fn prune_binary_versions(&self, item_id: &str) -> Result<()> {
        let versions = VersionRepo::list(self.meta.as_ref(), item_id, 10_000).await?;
        let doomed: Vec<(String, BlobRef)> = versions
            .into_iter()
            .filter_map(|version| blob_of(&version.body).map(|blob| (version.id, blob)))
            .skip(1 + self.keep_versions)
            .collect();
        if doomed.is_empty() {
            return Ok(());
        }
        let ids: Vec<String> = doomed.iter().map(|(id, _)| id.clone()).collect();
        VersionRepo::delete_many(self.meta.as_ref(), &ids).await?;
        for (_, blob) in doomed {
            // 同样内容的备份可能被别的版本(甚至别的文件)引用着,没人引用了才删文件
            if VersionRepo::count_body_containing(self.meta.as_ref(), &blob.sha256).await? == 0 {
                let _ = std::fs::remove_file(self.blob_path(&blob.sha256));
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn record(
        &self,
        item_id: &str,
        collection: &str,
        rel_path: &str,
        version: i64,
        blob: &BlobRef,
        author: &str,
        now: kb_core::model::Millis,
        session: Option<&str>,
    ) -> Result<String> {
        let id = uuid::Uuid::now_v7().to_string();
        VersionRepo::create(
            self.meta.as_ref(),
            ItemVersion {
                id: id.clone(),
                item_id: item_id.to_owned(),
                collection: collection.to_owned(),
                source: rel_path.to_owned(),
                version,
                title: None,
                body: blob_ref(&blob.sha256, blob.size),
                tags: Vec::new(),
                author: Some(author.to_owned()),
                // 协同会话的标记:同一会话的后续落地据此找到这一版并更新它(二进制版本本来不用这个字段)
                batch_id: session.map(str::to_owned),
                created_at: now,
            },
        )
        .await?;
        Ok(id)
    }
}

impl FileEditService {
    /// 改 Excel 里几个单元格的值(其余原样保留,见 `kb_extract::xlsx_edit`),作为新的一版保存并重新索引。
    pub async fn edit_sheet_cells(
        &self,
        collection: &str,
        rel_path: &str,
        edits: &[kb_extract::xlsx_edit::CellEdit],
        expected_sha256: Option<&str>,
        author: &str,
    ) -> Result<ReplaceFileResult> {
        if !rel_path.to_ascii_lowercase().ends_with(".xlsx") {
            return Err(KbError::InvalidInput(
                "只有 .xlsx 表格能在这里改值(旧版 .xls / .csv 请用 Excel 打开改)".to_owned(),
            ));
        }
        let path = self.locate(collection, rel_path).await?;
        let bytes = std::fs::read(&path)
            .map_err(|err| KbError::Internal(format!("读取 {} 失败: {err}", path.display())))?;
        let edits = edits.to_vec();
        let edited =
            tokio::task::spawn_blocking(move || kb_extract::xlsx_edit::edit_xlsx(&bytes, &edits))
                .await
                .map_err(|err| KbError::Internal(format!("改表格的线程异常: {err}")))?
                .map_err(|err| KbError::InvalidInput(err.0))?;
        self.replace_bytes(collection, rel_path, &edited, expected_sha256, author)
            .await
    }

    /// 表格里每张工作表的公式格(界面标成只读),和当前内容的 sha256(保存时做乐观锁)。
    pub async fn sheet_info(
        &self,
        collection: &str,
        rel_path: &str,
    ) -> Result<(std::collections::BTreeMap<String, Vec<String>>, String)> {
        let path = self.locate(collection, rel_path).await?;
        let bytes = std::fs::read(&path)
            .map_err(|err| KbError::Internal(format!("读取 {} 失败: {err}", path.display())))?;
        let sha256 = kb_core::hash::sha256_hex_bytes(&bytes);
        let formulas =
            tokio::task::spawn_blocking(move || kb_extract::xlsx_edit::formula_cells(&bytes))
                .await
                .map_err(|err| KbError::Internal(format!("读表格的线程异常: {err}")))?
                .map_err(|err| KbError::InvalidInput(err.0))?;
        Ok((formulas, sha256))
    }

    /// 当前内容的 sha256(上传新版本前,界面拿它做乐观锁)。
    pub async fn file_sha256(&self, collection: &str, rel_path: &str) -> Result<String> {
        let path = self.locate(collection, rel_path).await?;
        let bytes = std::fs::read(&path)
            .map_err(|err| KbError::Internal(format!("读取 {} 失败: {err}", path.display())))?;
        Ok(kb_core::hash::sha256_hex_bytes(&bytes))
    }
}

/// 写到同目录的临时文件再改名:写到一半出错(磁盘满、进程被杀),原件不会变成半个文件。
fn write_atomically(target: &Path, bytes: &[u8]) -> Result<()> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = dir.join(format!(".{name}.kb-{}", uuid::Uuid::now_v7().simple()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, target)
    })();
    if let Err(err) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(KbError::Internal(format!(
            "写入 {} 失败: {err}",
            target.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_markers_roundtrip_and_text_is_never_mistaken_for_one() {
        let sha = "a".repeat(64);
        let marker = blob_ref(&sha, 1234);
        assert_eq!(
            blob_of(&marker),
            Some(BlobRef {
                sha256: sha.clone(),
                size: 1234
            })
        );
        // 普通文本版本(哪怕内容就写着这串字)不以 NUL 开头,不会被当成备份
        assert_eq!(blob_of(&format!("kb-blob:{sha}:1")), None);
        assert_eq!(blob_of("# 标题\n\n正文"), None);
        // 坏标记(长度不对 / 不是十六进制)不认
        assert_eq!(blob_of(&format!("{BINARY_MARK}abc:1")), None);
        assert_eq!(blob_of(&format!("{BINARY_MARK}{}:1", "z".repeat(64))), None);
    }

    #[test]
    fn atomic_write_replaces_the_file_and_leaves_no_temp_behind() {
        let dir = tempfile::tempdir().expect("目录");
        let target = dir.path().join("报告.docx");
        std::fs::write(&target, b"old").expect("写");
        write_atomically(&target, b"new bytes").expect("替换");
        assert_eq!(std::fs::read(&target).expect("读"), b"new bytes");
        assert_eq!(
            std::fs::read_dir(dir.path()).expect("读目录").count(),
            1,
            "不留临时文件"
        );
    }
}
