//! 批注与“转 Markdown 副本”。
//!
//! - **批注**:锚定到页 / 单元格 / 幻灯片 / 时间点,存 `annotations` 表,同时写成一条可检索记录
//!   (`source = "<文件>#annotation:<id>"`,anchor 落库),这样检索能命中批注并跳回原位置;
//! - **转 Markdown 副本**:把中间文档渲染成 `.md`(标题层级、表格、代码块、图片导出到副本旁的
//!   `<副本名>.assets/`),副本作为独立条目入库,并用 `derived_from` 边指向原件;原件只读不变。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use kb_core::model::{
    Anchor, Annotation, Edge, EdgeRel, FileKind, RecordKind, RecordRow, ScanEntry,
};
use kb_core::paths::KbPaths;
use kb_core::ports::repo::{
    AnnotationRepo, ChunkRepo, CollectionRepo, EdgeRepo, IngestRepo, MetaStore, ProjectRepo,
};
use kb_core::ports::{Embedder, VectorStore};
use kb_core::{KbError, Result};
use serde::Serialize;

use crate::annotation::markdown::{ImageExport, derived_path, now_millis, render_markdown};
use crate::index::{FileIndexSpec, IndexService};

#[derive(Clone, Debug)]
pub struct AddAnnotationRequest {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径。
    pub source: String,
    /// 位置锚点。
    pub anchor: Option<Anchor>,
    /// 正文。
    pub body: String,
    /// 作者。
    pub author: String,
    /// 回复哪条评论(只能回复顶层评论,必须在同一个文件上)。回复沿用被回复评论的位置锚点。
    pub parent_id: Option<String>,
    /// 评论里 @ 到、并且调用方已经核对过「可以通知」的用户 id。
    pub mentions: Vec<String>,
}

/// 批注服务。
pub struct AnnotationService {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn Embedder>,
    /// 与索引 / 迁移共享的写闸门。
    gate: crate::write_gate::WriteGate,
}

impl AnnotationService {
    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn Embedder>,
    ) -> Self {
        Self {
            meta,
            store,
            embedder,
            gate: crate::write_gate::WriteGate::new(),
        }
    }

    /// 换用共享的写闸门。
    pub fn with_write_gate(mut self, gate: crate::write_gate::WriteGate) -> Self {
        self.gate = gate;
        self
    }

    /// 新建一条批注(同时写一条可检索记录)。
    pub async fn add(&self, request: AddAnnotationRequest) -> Result<Annotation> {
        if request.body.trim().is_empty() {
            return Err(KbError::InvalidInput("批注正文不能为空".to_owned()));
        }
        if let Some(anchor) = &request.anchor {
            anchor.validate().map_err(KbError::InvalidInput)?;
        }
        let collection = CollectionRepo::get(self.meta.as_ref(), &request.collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {}", request.collection)))?;
        // 回复:被回复的必须存在、在同一个文件上、而且本身是顶层评论(只支持一层);
        // 回复沿用它的位置锚点——回复不单独"挂"在文档上
        let mut request = request;
        if let Some(parent_id) = request.parent_id.clone() {
            let Some(parent) = AnnotationRepo::get(self.meta.as_ref(), &parent_id).await? else {
                return Err(KbError::NotFound(format!("评论 {parent_id}")));
            };
            if parent.collection != request.collection || parent.source != request.source {
                return Err(KbError::NotFound(format!("评论 {parent_id}")));
            }
            if parent.parent_id.is_some() {
                return Err(KbError::InvalidInput(
                    "回复只有一层:请回复最上面那条评论".to_owned(),
                ));
            }
            request.anchor = parent.anchor.clone();
        }
        request.mentions.sort();
        request.mentions.dedup();
        let id = uuid::Uuid::now_v7().to_string();
        let now = now_millis();
        let source = format!("{}#annotation:{id}", request.source);
        let anchor_label = request
            .anchor
            .as_ref()
            .map(Anchor::label)
            .unwrap_or_else(|| "全文".to_owned());
        let header = format!("{} · 批注 · {anchor_label}", request.source);
        let row = RecordRow {
            id: id.clone(),
            collection: collection.name.clone(),
            kind: RecordKind::Insight,
            lang: None,
            source: source.clone(),
            start_line: None,
            end_line: None,
            symbol: None,
            title: Some(format!("批注:{anchor_label}")),
            text: request.body.clone(),
            header: header.clone(),
            lex: format!("{header}\n{}\n批注 annotation", request.body),
            tags: vec!["批注".to_owned()],
            status: kb_core::model::ItemStatus::Active,
            content_hash: kb_core::hash::content_hash(&request.body),
            meta_hash: kb_core::hash::meta_hash(&kb_core::hash::MetaHashInput {
                start_line: None,
                end_line: None,
                title: Some("批注"),
                tags: &["批注".to_owned()],
                status: "active",
                symbol: None,
            }),
            embed_input_hash: kb_core::hash::embed_input_hash(
                self.embedder.id(),
                &header,
                &request.body,
            ),
            updated_at: now,
            anchor: request.anchor.clone(),
            vector: None,
        };
        // 向量化并写进 LanceDB(批注也要能语义检索)
        let mut stored = row.clone();
        stored.vector = Some(
            self.embedder
                .embed_documents(vec![format!("{header}\n{}", request.body)])
                .await?
                .into_iter()
                .next()
                .ok_or_else(|| KbError::Internal("嵌入器没有返回向量".to_owned()))?,
        );
        let (_guard, table) =
            crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                .await?;
        self.store.upsert(&table, vec![stored]).await?;

        let annotation = Annotation {
            id: id.clone(),
            collection: collection.name.clone(),
            source: request.source.clone(),
            anchor: request.anchor,
            body: request.body,
            author: Some(request.author),
            record_id: Some(id),
            parent_id: request.parent_id,
            resolved_at: None,
            resolved_by: None,
            mentions: request.mentions,
            created_at: now,
            updated_at: now,
        };
        AnnotationRepo::create(self.meta.as_ref(), annotation.clone()).await?;
        Ok(annotation)
    }

    /// 某个文件的批注。
    pub async fn list(
        &self,
        collection: &str,
        source: &str,
        limit: u32,
    ) -> Result<Vec<Annotation>> {
        AnnotationRepo::list_by_source(self.meta.as_ref(), collection, source, limit).await
    }

    /// 标记 / 取消「已解决」。只有顶层评论可以标记(回复跟着它走)。
    /// 返回更新后的评论。
    pub async fn resolve(&self, id: &str, by: &str, resolved: bool) -> Result<Annotation> {
        let Some(annotation) = AnnotationRepo::get(self.meta.as_ref(), id).await? else {
            return Err(KbError::NotFound(format!("批注 {id}")));
        };
        if annotation.parent_id.is_some() {
            return Err(KbError::InvalidInput(
                "回复不能单独标记已解决,请标记最上面那条评论".to_owned(),
            ));
        }
        let (at, who) = if resolved {
            (Some(now_millis()), Some(by))
        } else {
            (None, None)
        };
        AnnotationRepo::set_resolved(self.meta.as_ref(), id, at, who).await?;
        AnnotationRepo::get(self.meta.as_ref(), id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("批注 {id}")))
    }

    /// 删除一条批注(连同它的检索记录)。删顶层评论时,它底下的回复一起删——回复脱离了上下文没有意义。
    pub async fn delete(&self, id: &str) -> Result<()> {
        let Some(annotation) = AnnotationRepo::get(self.meta.as_ref(), id).await? else {
            return Err(KbError::NotFound(format!("批注 {id}")));
        };
        for reply in AnnotationRepo::list_replies(self.meta.as_ref(), id).await? {
            Box::pin(self.delete(&reply.id)).await?;
        }
        let collection = CollectionRepo::get(self.meta.as_ref(), &annotation.collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {}", annotation.collection)))?;
        let (_guard, table) =
            crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                .await?;
        self.store.delete_ids(&table, &[id.to_owned()]).await?;
        AnnotationRepo::delete(self.meta.as_ref(), id).await?;
        Ok(())
    }
}

/// 转 Markdown 副本的结果。
#[derive(Clone, Debug, Serialize)]
pub struct MarkdownCopyResult {
    /// 副本相对路径。
    pub path: String,
    /// 块数。
    pub chunks: u64,
    /// 原文件里的图片数(含只留占位说明的)。
    pub images: u32,
    /// 其中真正导出成图片文件、副本里能直接看到的张数。
    pub exported_images: u32,
    /// 原文件路径。
    pub original: String,
}

/// “转 Markdown 副本”服务。
pub struct MarkdownCopyService {
    meta: Arc<dyn MetaStore>,
    index: Arc<IndexService>,
    paths: KbPaths,
}

impl MarkdownCopyService {
    /// 构造。
    pub fn new(meta: Arc<dyn MetaStore>, index: Arc<IndexService>, paths: KbPaths) -> Self {
        Self { meta, index, paths }
    }

    /// 把 `collection` 里的 `path` 转成 Markdown 副本并入库。
    pub async fn convert(
        &self,
        collection: &str,
        path: &str,
        author: &str,
    ) -> Result<MarkdownCopyResult> {
        let original = self.locate(collection, path).await?;
        let bytes = std::fs::read(&original)
            .map_err(|err| KbError::Internal(format!("读取 {} 失败: {err}", original.display())))?;
        let ext = original
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let source_ref = kb_core::model::SourceRef {
            scheme: "file".to_owned(),
            location: original.to_string_lossy().into_owned(),
            project_root: None,
        };
        // 进程级注册表:与索引链路共用同一份,避免“登记了却没人用”。
        let doc = kb_extract::registry::global()
            .extract(&source_ref, &bytes, ext)
            .await?;

        let copy_path = derived_path(path);
        // `copy_path` 是 **collection 相对路径**(目录结构不变、只换扩展名);
        // 落盘位置要按原文件的父目录 + 文件名拼,不能把相对路径整个再拼一遍,
        // 否则 `docs/sub/page.html` 会写到 `docs/sub/docs/sub/page.md`。
        if copy_path == path {
            return Err(KbError::InvalidInput(format!(
                "{path} 已经是 Markdown,不需要生成副本"
            )));
        }
        let copy_name = Path::new(&copy_path)
            .file_name()
            .ok_or_else(|| KbError::Internal(format!("无法从 {copy_path} 推导副本文件名")))?;
        let target = original.parent().unwrap_or(Path::new(".")).join(copy_name);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
            })?;
        }
        // 图片放在副本旁边的 `<副本名>.assets/`,正文用相对路径引用:
        // 浏览器里按"副本所在目录"解析成知识库内的原件地址,预览和编辑都能直接看到;
        // 把副本拷到别处(Typora / Obsidian / Git 仓库)时连同图片目录一起带走也不会断链
        let assets_name = format!(
            "{}.assets",
            Path::new(copy_name)
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default()
        );
        let assets_dir = target.with_file_name(&assets_name);
        let rendered = render_markdown(
            &doc,
            Some(&ImageExport {
                container: &bytes,
                dir: &assets_dir,
                link_dir: &assets_name,
            }),
        )?;
        std::fs::write(&target, rendered.markdown.as_bytes())
            .map_err(|err| KbError::Internal(format!("写副本 {} 失败: {err}", target.display())))?;

        // 副本入库(作为独立文件)
        let collection_record = CollectionRepo::get(self.meta.as_ref(), collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {collection}")))?;
        let metadata = std::fs::metadata(&target).ok();
        let entry = ScanEntry {
            path: target.clone(),
            relative: copy_path.clone(),
            size: metadata.as_ref().map(|meta| meta.len()).unwrap_or(0),
            mtime: metadata
                .as_ref()
                .map(crate::index::millis_of)
                .unwrap_or_default(),
            lang: "markdown".to_owned(),
            kind: FileKind::Doc,
        };
        let spec = FileIndexSpec {
            source: copy_path.clone(),
            kind: FileKind::Doc,
            tags: vec!["副本".to_owned()],
        };
        let stats = self
            .index
            .index_entry_with("", &collection_record, &entry, &spec, now_millis())
            .await?;

        // 上传进来的文件:副本和截图也登记进解析队列表(状态直接是完成)。预览、读截图、保存副本都靠
        // "按集合 + 相对路径找磁盘文件"这套查找,只认解析队列表和项目根;不登记的话上传库里转出来的副本
        // 预览不出内容、不能编辑,里面的截图是裂图
        if let Some(origin) = IngestRepo::get_by_path(self.meta.as_ref(), collection, path).await? {
            let dir = match copy_path.rsplit_once('/') {
                Some((dir, _)) => format!("{dir}/"),
                None => String::new(),
            };
            self.register_derived(&origin, &copy_path, &target, stats.chunks as u64)
                .await?;
            for name in &rendered.files {
                self.register_derived(
                    &origin,
                    &format!("{dir}{assets_name}/{name}"),
                    &assets_dir.join(name),
                    0,
                )
                .await?;
            }
        }

        // 副本 → 原件:`derived_from` 边
        if let Ok(chunks) = ChunkRepo::by_path(self.meta.as_ref(), collection, &copy_path).await
            && let Some(first) = chunks.first()
        {
            let _ = EdgeRepo::add(
                self.meta.as_ref(),
                Edge {
                    src_id: first.id.clone(),
                    dst: format!("path:{path}"),
                    rel: EdgeRel::DerivedFrom,
                    created_at: now_millis(),
                },
            )
            .await;
        }
        tracing::info!(original = path, copy = %copy_path, author, "已生成 Markdown 副本");
        Ok(MarkdownCopyResult {
            path: copy_path,
            chunks: stats.chunks as u64,
            images: rendered.images,
            exported_images: rendered.exported,
            original: path.to_owned(),
        })
    }

    /// 给一个派生文件(副本 / 截图)补一条解析队列记录,来源沿用原件;已经有就不动(重复转换不会冲突)。
    async fn register_derived(
        &self,
        origin: &kb_core::model::IngestFile,
        rel_path: &str,
        abs_path: &Path,
        chunks: u64,
    ) -> Result<()> {
        if IngestRepo::get_by_path(self.meta.as_ref(), &origin.collection, rel_path)
            .await?
            .is_some()
        {
            return Ok(());
        }
        let now = now_millis();
        IngestRepo::create(
            self.meta.as_ref(),
            kb_core::model::IngestFile {
                id: uuid::Uuid::now_v7().to_string(),
                batch_id: None,
                source_id: origin.source_id.clone(),
                upload_id: origin.upload_id.clone(),
                collection: origin.collection.clone(),
                rel_path: rel_path.to_owned(),
                abs_path: abs_path.display().to_string(),
                size: std::fs::metadata(abs_path)
                    .map(|meta| meta.len())
                    .unwrap_or(0),
                sha256: None,
                state: kb_core::model::IngestState::Done,
                error: None,
                chunks,
                vectors: chunks,
                extract_meta: None,
                derived_from: Some(origin.rel_path.clone()),
                elapsed_ms: None,
                created_at: now,
                updated_at: now,
            },
        )
        .await
    }

    async fn locate(&self, collection: &str, rel_path: &str) -> Result<PathBuf> {
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
