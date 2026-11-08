//! 文本类在线编辑与版本历史。
//!
//! - **改源文件**:本地目录源写回原文件,上传 / 归档源写回 KB 存储(`sources/<id>/…`);
//! - **只重嵌入变化的块**:写入后走既有的单文件索引(`IndexService::index_entry_with`),
//!   它按块内容哈希做 diff,没变的块不重新嵌入;
//! - **版本历史**:每次保存写一条 `item_versions`(恢复旧版本也是**新**版本),
//!   并通过 `changes` 表登记一次可撤销的改动(`file.edit`);
//! - **乐观锁**:`expected_version` 与最新版本不一致时返回 [`KbError::Conflict`](Web 端映射 409)。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use kb_core::model::{ItemVersion, Millis, ScanEntry};
use kb_core::paths::KbPaths;
use kb_core::ports::repo::{
    ChunkRepo, CollectionRepo, IngestRepo, MetaStore, ProjectRepo, VersionRepo,
};
use kb_core::{KbError, Result};
use kb_extract::text_codec::{Decoded, Encoding, encode};
use serde::Serialize;

use crate::index::{FileIndexSpec, IndexService};
use crate::revert::{OP_FILE_EDIT, record_op};

pub(crate) mod binary;
pub mod lock;
pub use binary::{
    BINARY_MARK, MAX_REPLACE_BYTES, ReplaceFileResult, RoundtripReport, blob_ref, blob_size,
};

fn now_millis() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 读一个文件的文字和它的编码。文件不存在 / 读不了按「空文件、UTF-8」处理(新建);
/// 存在但不是任何受支持的编码(二进制、损坏)报错,不去覆盖它。
pub(crate) fn read_with_encoding(path: &Path) -> Result<(String, Encoding)> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok((String::new(), Encoding::Utf8)),
    };
    let decoded = Decoded::decode(&bytes)?;
    // 解码再编码不能还原原来的字节(GB18030 里少数一对多的映射):写回会改动没碰过的内容,不允许
    if !decoded.round_trips(&bytes) {
        return Err(KbError::InvalidInput(format!(
            "{} 的编码无法逐字节还原,在线编辑可能改动没碰过的内容;请先另存为 UTF-8",
            path.display()
        )));
    }
    Ok((decoded.text, decoded.encoding))
}

/// 这个文件在版本表里有没有记录。
pub async fn has_versions(meta: &dyn MetaStore, collection: &str, rel_path: &str) -> Result<bool> {
    let item_id = FileEditService::item_id(collection, rel_path);
    Ok(VersionRepo::latest_version(meta, &item_id).await? > 0)
}

/// 把一份内容记成文件的一个版本(入库 / 上传覆盖时用):和最新一版一样就不重复记。
///
/// 入库时先落一条 v1,文件的历史才是从「刚进来的那一版」开始的;重新上传 / 同步覆盖了同名文件
/// 也走这里,否则历史里最新那条的正文会和磁盘上的对不上(面板上又会说那就是「当前」)。
/// 返回是否新记了一条。
pub async fn record_version_from_content(
    meta: &dyn MetaStore,
    collection: &str,
    rel_path: &str,
    body: &str,
    author: &str,
) -> Result<bool> {
    let latest = VersionRepo::list_by_source(meta, collection, rel_path, 1).await?;
    if latest.first().is_some_and(|last| last.body == body) {
        return Ok(false);
    }
    let version = latest.first().map_or(0, |last| last.version) + 1;
    VersionRepo::create(
        meta,
        ItemVersion {
            id: uuid::Uuid::now_v7().to_string(),
            item_id: FileEditService::item_id(collection, rel_path),
            collection: collection.to_owned(),
            source: rel_path.to_owned(),
            version,
            title: None,
            body: body.to_owned(),
            tags: latest
                .first()
                .map(|last| last.tags.clone())
                .unwrap_or_default(),
            author: Some(author.to_owned()),
            batch_id: None,
            created_at: now_millis(),
        },
    )
    .await?;
    Ok(true)
}

/// 给一个文本文件记一条基线版本(版本 1):已经有版本记录、或者正文是空的,就什么也不做。
///
/// 协作开始前走这里。注意上传入库用的是 [`record_version_from_content`]:
/// 同名文件重新上传时它会把新内容接在后面,而不是当成已经有了基线就不管。
pub async fn record_baseline(
    meta: &dyn MetaStore,
    collection: &str,
    rel_path: &str,
    body: &str,
    author: &str,
) -> Result<()> {
    if body.is_empty() {
        return Ok(());
    }
    let item_id = FileEditService::item_id(collection, rel_path);
    if VersionRepo::latest_version(meta, &item_id).await? > 0 {
        return Ok(());
    }
    record_version_from_content(meta, collection, rel_path, body, author).await?;
    Ok(())
}

/// 内容开头多出一个 BOM 字符、而文件本来就带 BOM(编码层会再加一个):去掉多的,免得出现两个 BOM。
/// 旧版本记录里的文字是带着 BOM 字符存的,恢复它们时会遇到。
fn restore_bom(content: &str, encoding: Encoding) -> String {
    match (encoding, content.strip_prefix('\u{feff}')) {
        (Encoding::Utf8Bom | Encoding::Utf16Le | Encoding::Utf16Be, Some(rest)) => rest.to_owned(),
        _ => content.to_owned(),
    }
}

/// 保存一次文件编辑的请求。
#[derive(Clone, Debug)]
pub struct SaveFileRequest {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径(与检索结果里的 `source` 一致)。
    pub path: String,
    /// 新的整份内容。
    pub content: String,
    /// 乐观锁:期望的当前版本(`None` = 不检查)。
    pub expected_version: Option<i64>,
    /// 谁改的。
    pub author: String,
    /// 标签(留空 = 保持原样)。
    pub tags: Vec<String>,
}

/// 保存结果。
#[derive(Clone, Debug, Serialize)]
pub struct SaveFileResult {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径。
    pub path: String,
    /// 新版本号。
    pub version: i64,
    /// 本次重新嵌入的块数(验收用:改一行只应重嵌入受影响的块)。
    pub embedded: u64,
    /// 该文件当前的块数。
    pub chunks: u64,
    /// 版本记录 id。
    pub version_id: String,
}

/// 文本编辑服务。
pub struct FileEditService {
    pub(crate) meta: Arc<dyn MetaStore>,
    index: Arc<IndexService>,
    paths: KbPaths,
    /// 二进制文件除了当前这一版,再留几份旧版本(`[office] keep_versions`)。
    keep_versions: usize,
}

impl FileEditService {
    /// 构造。
    pub fn new(meta: Arc<dyn MetaStore>, index: Arc<IndexService>, paths: KbPaths) -> Self {
        Self {
            meta,
            index,
            paths,
            keep_versions: kb_core::config::OfficeConfig::default().keep_versions,
        }
    }

    /// 二进制文件(Word / Excel / PDF…)替换后,除了当前这一版,再留几份旧版本;超出的从最旧的删。
    pub fn with_keep_versions(mut self, keep: usize) -> Self {
        self.keep_versions = keep;
        self
    }

    /// 一个文件在版本表里的稳定 id。
    pub fn item_id(collection: &str, path: &str) -> String {
        format!("file:{collection}:{path}")
    }

    /// 一个文件现在的版本号(没编辑过是 0)。
    pub(crate) async fn latest_version(&self, collection: &str, rel_path: &str) -> Result<i64> {
        VersionRepo::latest_version(self.meta.as_ref(), &Self::item_id(collection, rel_path)).await
    }

    /// 保存一次编辑。
    pub async fn save(&self, request: SaveFileRequest) -> Result<SaveFileResult> {
        let path = self.locate(&request.collection, &request.path).await?;
        let item_id = Self::item_id(&request.collection, &request.path);
        let latest = VersionRepo::latest_version(self.meta.as_ref(), &item_id).await?;
        if let Some(expected) = request.expected_version
            && expected != latest
        {
            return Err(KbError::Conflict {
                expected,
                actual: latest,
            });
        }
        // 读出现在的内容,并记下它的编码:GBK / UTF-16 / 带 BOM 的文件改完要用**原来的编码**写回。
        // 以前这里 `read_to_string` 读不出 GBK 就当成空文件,保存时再把整份写成 UTF-8,等于悄悄毁掉原文件
        let (before, encoding) = read_with_encoding(&path)?;
        let content = restore_bom(&request.content, encoding);
        if before == content {
            // 内容没变:不产生新版本,也不重嵌入
            let chunks = ChunkRepo::by_path(self.meta.as_ref(), &request.collection, &request.path)
                .await?
                .len() as u64;
            return Ok(SaveFileResult {
                collection: request.collection,
                path: request.path,
                version: latest,
                embedded: 0,
                chunks,
                version_id: String::new(),
            });
        }
        let bytes = encode(&content, encoding)?;
        std::fs::write(&path, &bytes)
            .map_err(|err| KbError::Internal(format!("写回 {} 失败: {err}", path.display())))?;

        let now = now_millis();
        // 第一次编辑时,先把“改动前的内容”记成基线版本 1,否则版本历史里只有改动后的内容,
        // 恢复旧版本会变成空操作
        let mut version = latest;
        if latest == 0 && !before.is_empty() {
            let baseline_id = uuid::Uuid::now_v7().to_string();
            VersionRepo::create(
                self.meta.as_ref(),
                ItemVersion {
                    id: baseline_id,
                    item_id: item_id.clone(),
                    collection: request.collection.clone(),
                    source: request.path.clone(),
                    version: 1,
                    title: None,
                    body: before.clone(),
                    tags: Vec::new(),
                    author: Some("baseline".to_owned()),
                    batch_id: None,
                    created_at: now,
                },
            )
            .await?;
            version = 1;
        }
        let version_id = uuid::Uuid::now_v7().to_string();
        let version = version + 1;
        VersionRepo::create(
            self.meta.as_ref(),
            ItemVersion {
                id: version_id.clone(),
                item_id: item_id.clone(),
                collection: request.collection.clone(),
                source: request.path.clone(),
                version,
                title: None,
                body: content.clone(),
                tags: request.tags.clone(),
                author: Some(request.author.clone()),
                batch_id: None,
                created_at: now,
            },
        )
        .await?;

        // 只对变化的块重嵌入:单文件索引内部按内容哈希 diff
        let stats = self
            .reindex(&request.collection, &request.path, &path)
            .await?;

        // 可撤销:记一次 `file.edit`,撤销时把内容写回 before 并重新索引
        let batch_id = uuid::Uuid::now_v7().to_string();
        kb_core::ports::repo::AuditRepo::ensure_batch(
            self.meta.as_ref(),
            &batch_id,
            &request.author,
            &format!("编辑文件 {}", request.path),
        )
        .await?;
        record_op(
            self.meta.as_ref(),
            &batch_id,
            &item_id,
            OP_FILE_EDIT,
            Some(serde_json::json!({
                "collection": request.collection,
                "path": request.path,
                "content": before,
            })),
            Some(serde_json::json!({
                "collection": request.collection,
                "path": request.path,
                "content": content,
                "version": version,
            })),
        )
        .await?;

        Ok(SaveFileResult {
            collection: request.collection,
            path: request.path,
            version,
            embedded: stats.0,
            chunks: stats.1,
            version_id,
        })
    }

    // ---------------------------------------------------------------- 多人协作落地

    /// 文件当前的文本内容。
    pub async fn read_text(&self, collection: &str, rel_path: &str) -> Result<String> {
        let path = self.locate(collection, rel_path).await?;
        if !path.is_file() {
            return Err(KbError::NotFound(format!("{rel_path} 不存在")));
        }
        // 按文件原来的编码解(GBK、UTF-16、带 BOM 的都行):协作编辑和单人编辑一样,不能只认 UTF-8
        let (text, _) = read_with_encoding(&path).map_err(|err| {
            KbError::InvalidInput(format!("{rel_path} 不是可编辑的文本文件: {err}"))
        })?;
        Ok(text)
    }

    /// 协作开始前给文件留一个基线版本(此前没有任何版本记录且文件不空时)。
    pub async fn baseline(&self, collection: &str, rel_path: &str) -> Result<()> {
        let before = self.read_text(collection, rel_path).await?;
        record_baseline(
            self.meta.as_ref(),
            collection,
            rel_path,
            &before,
            "baseline",
        )
        .await?;
        Ok(())
    }

    /// 协作落地:只把内容写回文件。不生成版本(保存点才生成)、不重新索引(调用方去抖后再调
    /// [`FileEditService::reindex_file`])。内容没变就不写。返回 `(是否写入了, 内容哈希)`。
    pub async fn land(
        &self,
        collection: &str,
        rel_path: &str,
        content: &str,
    ) -> Result<(bool, String)> {
        let path = self.locate(collection, rel_path).await?;
        let hash = kb_core::hash::content_hash(content);
        // 按文件原来的编码写回(GBK 仍是 GBK、带 BOM 仍带 BOM),和单人保存一致
        let (before, encoding) = read_with_encoding(&path)?;
        if before == content {
            return Ok((false, hash));
        }
        let bytes = encode(&restore_bom(content, encoding), encoding)?;
        std::fs::write(&path, bytes)
            .map_err(|err| KbError::Internal(format!("写回 {} 失败: {err}", path.display())))?;
        Ok((true, hash))
    }

    /// 保存点:把文件当前内容记成版本历史里的一条;和最新一版一样就不重复记。
    pub async fn savepoint(&self, collection: &str, rel_path: &str, author: &str) -> Result<bool> {
        let content = self.read_text(collection, rel_path).await?;
        let item_id = Self::item_id(collection, rel_path);
        let latest =
            VersionRepo::list_by_source(self.meta.as_ref(), collection, rel_path, 1).await?;
        if latest.first().is_some_and(|last| last.body == content) {
            return Ok(false);
        }
        let version = latest.first().map_or(0, |last| last.version) + 1;
        VersionRepo::create(
            self.meta.as_ref(),
            ItemVersion {
                id: uuid::Uuid::now_v7().to_string(),
                item_id,
                collection: collection.to_owned(),
                source: rel_path.to_owned(),
                version,
                title: None,
                body: content,
                tags: Vec::new(),
                author: Some(author.to_owned()),
                batch_id: None,
                created_at: now_millis(),
            },
        )
        .await?;
        Ok(true)
    }

    /// 协作落地之后重新索引(调用方去抖)。
    pub async fn reindex_file(&self, collection: &str, rel_path: &str) -> Result<(u64, u64)> {
        let path = self.locate(collection, rel_path).await?;
        self.reindex(collection, rel_path, &path).await
    }

    /// 版本列表(新 → 旧)。
    pub async fn versions(
        &self,
        collection: &str,
        path: &str,
        limit: u32,
    ) -> Result<Vec<ItemVersion>> {
        VersionRepo::list_by_source(self.meta.as_ref(), collection, path, limit).await
    }

    /// 按 id 取一版。
    pub async fn version(&self, id: &str) -> Result<Option<ItemVersion>> {
        VersionRepo::get(self.meta.as_ref(), id).await
    }

    /// 恢复到某一版(恢复本身产生一个新版本)。
    pub async fn restore(&self, version_id: &str, author: &str) -> Result<SaveFileResult> {
        let version = VersionRepo::get(self.meta.as_ref(), version_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("版本 {version_id}")))?;
        // 二进制文件(Word / Excel / PDF / 图片…)的版本存的是一个指向备份字节的标记,不能当文本写回
        if let Some(blob) = binary::blob_of(&version.body) {
            let bytes = self.read_blob(&blob)?;
            let result = self
                .replace_bytes(&version.collection, &version.source, &bytes, None, author)
                .await?;
            return Ok(SaveFileResult {
                collection: result.collection,
                path: result.path,
                version: result.version,
                embedded: result.embedded,
                chunks: result.chunks,
                version_id: result.version_id,
            });
        }
        self.save(SaveFileRequest {
            collection: version.collection,
            path: version.source,
            content: version.body,
            expected_version: None,
            author: author.to_owned(),
            tags: version.tags,
        })
        .await
    }

    /// 写回内容并重新索引一个文件,返回(重嵌入块数, 总块数)。
    pub(crate) async fn reindex(
        &self,
        collection: &str,
        rel_path: &str,
        path: &Path,
    ) -> Result<(u64, u64)> {
        let collection_record = CollectionRepo::get(self.meta.as_ref(), collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {collection}")))?;
        let metadata = std::fs::metadata(path).ok();
        let entry = ScanEntry {
            path: path.to_path_buf(),
            relative: rel_path.to_owned(),
            size: metadata.as_ref().map(|meta| meta.len()).unwrap_or(0),
            mtime: metadata
                .as_ref()
                .map(crate::index::millis_of)
                .unwrap_or_default(),
            lang: kb_index::lang::detect_lang(path).to_owned(),
            kind: kb_index::lang::kind_of(path),
        };
        let spec = FileIndexSpec {
            source: rel_path.to_owned(),
            kind: entry.kind,
            tags: Vec::new(),
        };
        let stats = self
            .index
            .index_entry_with("", &collection_record, &entry, &spec, now_millis())
            .await?;
        Ok((stats.embedded as u64, stats.chunks as u64))
    }

    /// 找文件的绝对路径:先看解析队列,再看项目根目录,最后看 KB 存储。
    /// 文件来自哪里:`upload`(上传到知识库的)、`project`(项目目录里的,属于代码仓库)、`source`(其它数据源目录)。
    /// 在线编辑 Office 文件先只开放 `upload`:项目目录里的文件写回会弄脏用户的仓库。
    pub async fn origin(&self, collection: &str, rel_path: &str) -> Result<&'static str> {
        crate::safe_path::check_rel_path(rel_path)?;
        if let Some(file) =
            IngestRepo::get_by_path(self.meta.as_ref(), collection, rel_path).await?
            && Path::new(&file.abs_path).is_file()
        {
            return Ok("upload");
        }
        for project in ProjectRepo::list(self.meta.as_ref()).await? {
            if crate::safe_path::resolve_inside(Path::new(&project.root_path), rel_path).is_some() {
                return Ok("project");
            }
        }
        Ok("source")
    }

    pub(crate) async fn locate(&self, collection: &str, rel_path: &str) -> Result<PathBuf> {
        // 调用者自己填的路径:绝对路径和 `..` 在这里就拦下,否则下面的 join 能跳出知识库去读写任意文件
        crate::safe_path::check_rel_path(rel_path)?;
        if let Some(file) =
            IngestRepo::get_by_path(self.meta.as_ref(), collection, rel_path).await?
        {
            let path = PathBuf::from(&file.abs_path);
            if path.is_file() {
                return Ok(path);
            }
        }
        for project in ProjectRepo::list(self.meta.as_ref()).await? {
            // 真实路径(软链接已解开)也必须还在项目根里
            if let Some(found) =
                crate::safe_path::resolve_inside(Path::new(&project.root_path), rel_path)
            {
                return Ok(found);
            }
        }
        // 兜底:任何数据源目录下的同名文件
        if let Ok(entries) = std::fs::read_dir(self.paths.sources_dir()) {
            for entry in entries.flatten() {
                if let Some(found) = crate::safe_path::resolve_inside(&entry.path(), rel_path) {
                    return Ok(found);
                }
            }
        }
        Err(KbError::NotFound(format!(
            "找不到文件 {rel_path}(collection {collection})"
        )))
    }
}
