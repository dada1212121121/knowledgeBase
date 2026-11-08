//! 文件:列表、预览、扫描围栏、版本、表格与 CSV 编辑。

use crate::capability_backend::*;

/// 引用选择器一次最多扫多少个文件:足够覆盖常见项目,又不会因为误指到巨大的目录把请求拖死。
const MAX_SCAN_FILES: usize = 5000;
/// 扫描目录时跳过的目录名:这些是构建产物 / 依赖缓存 / 版本库内部,不是用户会引用的知识文件。
const SKIP_SCAN_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".kb",
    ".vite",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
];

/// 引用选择器里的一个文件。扫描阶段只收元数据,过滤 / 分页在内存里做。
#[derive(Clone, Debug)]
struct ScannedFile {
    path: String,
    size: u64,
    updated_at: i64,
    source_id: Option<String>,
}

/// `path_prefix` 规整:去掉首尾斜杠,拒绝空段、`.`、`..` 和控制字符。
fn normalize_scan_prefix(raw: &str) -> Result<Option<String>> {
    let cleaned = raw.trim().replace('\\', "/");
    let cleaned = cleaned.trim_matches('/');
    if cleaned.is_empty() {
        return Ok(None);
    }
    if cleaned.contains('\0')
        || cleaned
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(KbError::InvalidInput(format!(
            "path_prefix 必须是集合内的相对目录:{raw}"
        )));
    }
    Ok(Some(cleaned.to_owned()))
}

/// `source` 是否在目录 `dir` 里(含目录本身):按路径边界判断,`docs2/x` 不算 `docs` 里的。
fn path_within(source: &str, dir: &str) -> bool {
    source == dir
        || source
            .strip_prefix(dir)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// 是否 Office / WPS 模板扩展名。模板默认下载,且不进入正文检索。
fn is_template_name(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "dotx" | "dotm" | "xltx" | "xltm" | "potx" | "potm"
    )
}

/// 引用选择器展示用的粗分类。只影响图标 / 文案,不参与权限判断。
fn scan_file_kind(path: &str) -> &'static str {
    if is_template_name(path) {
        return "template";
    }
    match path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" => "image",
        "pdf" => "pdf",
        "doc" | "docx" | "odt" | "rtf" => "doc",
        "xls" | "xlsx" | "csv" | "tsv" | "ods" => "sheet",
        "ppt" | "pptx" | "odp" => "slide",
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" => "archive",
        "mp3" | "wav" | "m4a" | "flac" | "mp4" | "mov" | "mkv" | "webm" => "media",
        "md" | "markdown" | "txt" => "text",
        "js" | "ts" | "tsx" | "jsx" | "py" | "rs" | "go" | "java" | "json" | "yaml" | "yml"
        | "toml" | "sql" | "sh" => "code",
        _ => "file",
    }
}

/// 递归扫一个目录。返回 `true` 表示碰到上限、结果被截断。
///
/// 只看普通文件和目录,软链接一律跳过:引用选择器不应该因为跟着一个指向 `/` 的链接把整机扫一遍。
fn scan_files_under(
    root: &std::path::Path,
    dir: &std::path::Path,
    depth: usize,
    source_id: Option<&str>,
    out: &mut Vec<ScannedFile>,
) -> bool {
    if depth > 16 || out.len() >= MAX_SCAN_FILES {
        return out.len() >= MAX_SCAN_FILES;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if out.len() >= MAX_SCAN_FILES {
            return true;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        // 隐藏文件 / 目录(.git、.env、macOS 的 .DS_Store)不是用来引用的知识文件
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if SKIP_SCAN_DIRS.contains(&name) {
                continue;
            }
            if scan_files_under(root, &entry.path(), depth + 1, source_id, out) {
                return true;
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let Some(relative) = relative.to_str() else {
            continue;
        };
        let path = relative.replace('\\', "/");
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let updated_at = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or_default();
        out.push(ScannedFile {
            path,
            size: meta.len(),
            updated_at,
            source_id: source_id.map(str::to_owned),
        });
    }
    false
}

#[allow(clippy::needless_question_mark)]
impl ServiceBackend {
    pub(super) async fn list_files_impl(&self, args: ListFilesArgs) -> Result<Value> {
        let runtime = self.rt();
        let collection_name = args.collection.trim();
        if collection_name.is_empty() {
            return Err(KbError::InvalidInput("collection 不能为空".to_owned()));
        }
        let collection = CollectionRepo::get(runtime.meta.as_ref(), collection_name)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {collection_name}")))?;
        let prefix = normalize_scan_prefix(args.path_prefix.as_deref().unwrap_or_default())?;
        let query = args.q.unwrap_or_default().trim().to_lowercase();
        let needles: Vec<&str> = query.split_whitespace().collect();

        // 一个 collection 可能有多份物理来源:上传 / 压缩包 / Git / 网页在 sources/<id>,
        // 项目 collection 直接读项目根目录。按来源逐个扫,最后按相对路径去重。
        let mut roots: Vec<(std::path::PathBuf, Option<String>)> = Vec::new();
        for source in SourceRepo::list(runtime.meta.as_ref()).await? {
            if source.collection != collection.name || source.kind == SourceKind::Note {
                continue;
            }
            let root = match source.kind {
                SourceKind::LocalDir => std::path::PathBuf::from(&source.uri),
                SourceKind::Git | SourceKind::Web | SourceKind::Upload | SourceKind::Archive => {
                    runtime.paths.source_dir(&source.id)
                }
                SourceKind::Note => continue,
            };
            roots.push((root, Some(source.id)));
        }
        if let Some(project_id) = &collection.project_id
            && let Some(project) = ProjectRepo::get(runtime.meta.as_ref(), project_id).await?
        {
            roots.push((
                std::path::PathBuf::from(&project.root_path),
                Some(format!("project:{project_id}")),
            ));
        }

        let indexed: std::collections::HashSet<String> =
            FileRepo::list_paths(runtime.meta.as_ref(), &collection.name)
                .await?
                .into_iter()
                .collect();
        let mut scanned: Vec<ScannedFile> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut truncated = false;
        for (root, source_id) in roots {
            if !root.is_dir() {
                continue;
            }
            let mut found = Vec::new();
            if scan_files_under(&root, &root, 0, source_id.as_deref(), &mut found) {
                truncated = true;
            }
            for file in found {
                if seen.insert(file.path.clone()) {
                    scanned.push(file);
                }
            }
        }
        scanned.sort_by(|a, b| a.path.cmp(&b.path));

        let filtered: Vec<&ScannedFile> = scanned
            .iter()
            .filter(|file| {
                prefix
                    .as_ref()
                    .is_none_or(|dir| path_within(&file.path, dir))
            })
            .filter(|file| {
                let lower = file.path.to_lowercase();
                needles.iter().all(|needle| lower.contains(needle))
            })
            .collect();

        // 目录也返回:选择器要能一层层点进去,而不是让用户猜路径前缀。
        let mut folders: Vec<String> = Vec::new();
        for file in &filtered {
            let parts: Vec<&str> = file.path.split('/').collect();
            for end in 1..parts.len() {
                let folder = parts[..end].join("/");
                if prefix.as_deref().is_none_or(|dir| folder != dir) {
                    folders.push(folder);
                }
            }
        }
        folders.sort();
        folders.dedup();

        let page = args.page.unwrap_or(1).max(1);
        let page_size = args.page_size.unwrap_or(100).clamp(1, 500);
        let total = filtered.len() as u64;
        let start = ((page - 1) as usize).saturating_mul(page_size as usize);
        let items: Vec<Value> = filtered
            .iter()
            .skip(start)
            .take(page_size as usize)
            .map(|file| {
                let name = file.path.rsplit('/').next().unwrap_or(&file.path);
                let is_indexed = indexed.contains(&file.path);
                json!({
                    // `source` 是分享闸门的行级过滤字段;文件和它同值,前端不必区分
                    "source": file.path,
                    "path": file.path,
                    "name": name,
                    "collection": collection.name,
                    "size": file.size,
                    "updated_at": file.updated_at,
                    "source_id": file.source_id,
                    "kind": scan_file_kind(&file.path),
                    "template": is_template_name(&file.path),
                    "indexed": is_indexed,
                    "status": if is_indexed { "indexed" } else { "pending" },
                })
            })
            .collect();
        Ok(json!({
            "collection": collection.name,
            "items": items,
            "folders": folders,
            "total": total,
            "page": page,
            "page_size": page_size,
            "truncated": truncated,
        }))
    }

    pub(super) async fn file_preview_impl(&self, args: FilePreviewArgs) -> Result<Value> {
        // 1) 块的落库信息(带 anchor)——检索面板与预览面板共用
        let collection = CollectionRepo::get(self.rt().meta.as_ref(), &args.collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {}", args.collection)))?;
        let chunks =
            ChunkRepo::by_path(self.rt().meta.as_ref(), &args.collection, &args.path).await?;
        let ids: Vec<String> = chunks.iter().map(|chunk| chunk.id.clone()).collect();
        let rows = if ids.is_empty() {
            Vec::new()
        } else {
            self.rt().store.get(&collection.active_table, &ids).await?
        };
        let mut by_id: std::collections::HashMap<&str, &kb_core::model::RecordRow> =
            std::collections::HashMap::new();
        for row in &rows {
            by_id.insert(row.id.as_str(), row);
        }
        let chunk_list: Vec<Value> = chunks
            .iter()
            .filter_map(|chunk| by_id.get(chunk.id.as_str()).map(|row| (chunk, *row)))
            .map(|(chunk, row)| {
                json!({
                    "id": chunk.id,
                    "ordinal": chunk.ordinal,
                    "anchor": row.anchor,
                    "start_line": row.start_line,
                    "end_line": row.end_line,
                    "title": row.title,
                    "text": row.text,
                })
            })
            .collect();

        // 2) 重新抽取一次,给前端“按格式渲染”用的结构块
        let format = args
            .path
            .rsplit_once('.')
            .map(|(_, ext)| ext.to_ascii_lowercase())
            .unwrap_or_else(|| "unknown".to_owned());
        // 抽取器 id(设计稿 的「抽取器」一行):谁把这个文件抽成块的,由注册表实际挑选决定
        let mut extractor: Option<String> = None;
        // 读不到原件时不要冒充成“空文件”:图片 / 音视频抽取器对空 bytes 也会产出占位块,
        // 那样界面会显示“抽取器 图片 OCR / 0 块”,与真的空文件无法区分
        let mut read_error: Option<String> = None;
        let mut blocks: Vec<Value> = Vec::new();
        if let Some(path) = self.locate_file(&args.collection, &args.path).await? {
            let (found, extracted, error) = preview_parts(Some(&path)).await;
            extractor = found;
            blocks = extracted;
            read_error = error;
        }
        // 文本类文件额外返回原文与“可编辑”标记(在线编辑用)。
        // 不按扩展名白名单判断(白名单之外的 .cs / .ini / .conf / .svg / .ipynb 等文本也要能改),
        // 看内容:≤512 KB、合法 UTF-8、没有 NUL 字节。GBK 等非 UTF-8 文本不提供编辑,
        // 因为保存会把编码悄悄改成 UTF-8。
        // `content` 是查看用的全文(最大 VIEWABLE_MAX_BYTES);能不能编辑另算:全文不超过编辑上限才行
        let content = match self.locate_file(&args.collection, &args.path).await? {
            Some(path) => read_text_within(&path, VIEWABLE_MAX_BYTES),
            None => String::new(),
        };
        let editable = !content.is_empty() && content.len() as u64 <= EDITABLE_MAX_BYTES;
        // Office 文件能不能在线编辑取决于它从哪来(上传的可以,项目目录里的不行),界面据此决定显不显示「编辑」
        let origin = if matches!(format.as_str(), "xlsx" | "docx" | "pptx") {
            self.file_edits()
                .origin(&args.collection, &args.path)
                .await
                .ok()
        } else {
            None
        };
        Ok(json!({
            "collection": args.collection,
            "path": args.path,
            "origin": origin,
            "format": format,
            "extractor": extractor,
            "read_error": read_error,
            "blocks": blocks,
            "chunks": chunk_list,
            "editable": editable,
            "content": content,
        }))
    }

    pub(super) async fn file_raw_impl(&self, args: FileRawArgs) -> Result<Value> {
        // 只接受 collection 内的相对路径:绝对路径与 `..` 一律拒绝
        if args.path.starts_with('/') || args.path.split('/').any(|part| part == "..") {
            return Err(KbError::InvalidInput(format!(
                "path 必须是 collection 内的相对路径:{}",
                args.path
            )));
        }
        // collection 必须存在;路径解析分两种:
        // - 上传 / 解包进来的文件:只认该 collection 的 `ingest_files.abs_path`;
        // - 项目里被索引的文件:用**该 collection 所属项目**的根 + 相对路径（否则预览页读不到项目内的图片 / 音频)。
        let collection = CollectionRepo::get(self.rt().meta.as_ref(), &args.collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {}", args.collection)))?;
        let project = match collection.project_id.clone() {
            Some(project_id) => ProjectRepo::list(self.rt().meta.as_ref())
                .await?
                .into_iter()
                .find(|project| project.id == project_id),
            None => None,
        };
        let ingest =
            IngestRepo::get_by_path(self.rt().meta.as_ref(), &args.collection, &args.path).await?;
        let candidate = match (&ingest, &project) {
            (Some(file), _) => std::path::PathBuf::from(&file.abs_path),
            (None, Some(project)) => std::path::PathBuf::from(&project.root_path).join(&args.path),
            (None, None) => {
                return Err(KbError::NotFound(format!(
                    "{} · {}",
                    args.collection, args.path
                )));
            }
        };
        // 软链要按真实路径判定:仓库里放一个 `logo.png -> ~/.ssh/id_rsa` 就能绕过字符串过滤
        let path = candidate
            .canonicalize()
            .map_err(|err| KbError::NotFound(format!("{} 不可读: {err}", candidate.display())))?;
        if !path.is_file() {
            return Err(KbError::NotFound(format!(
                "{} 不是普通文件",
                path.display()
            )));
        }
        // 真实路径必须落在允许的根里,而且**只放行与该 collection 相关的根**:
        // 上传 / 归档解出来的文件在 `KB_HOME/collections` 与 `KB_HOME/uploads` 下,
        // 项目文件在该 collection 所属项目的根下(不是“全部项目”,这是安全边界)
        let mut roots: Vec<std::path::PathBuf> = vec![
            self.rt().paths.sources_dir().to_path_buf(),
            self.rt().paths.uploads_dir().to_path_buf(),
        ];
        if let Some(project) = &project {
            roots.push(std::path::PathBuf::from(&project.root_path));
        }
        let inside = roots.iter().any(|root| {
            root.canonicalize()
                .map(|root| path.starts_with(&root))
                .unwrap_or(false)
        });
        if !inside {
            return Err(KbError::InvalidInput(format!(
                "{} 不在允许的目录内",
                path.display()
            )));
        }
        let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| args.path.clone());
        let mime = mime_of(&path);
        Ok(json!({
            "path": path.to_string_lossy(),
            "name": name,
            "size": size,
            "mime": mime,
        }))
    }

    pub(super) async fn save_file_impl(&self, args: SaveFileArgs) -> Result<Value> {
        self.refuse_while_collaborating(kb_core::share::ResourceKey::file(
            &self.call_space_id(),
            &args.collection,
            &args.path,
        ))
        .await?;
        let written_key =
            kb_core::share::ResourceKey::file(&self.call_space_id(), &args.collection, &args.path)
                .ok();
        let result = self
            .file_edits()
            .save(kb_service::edit::SaveFileRequest {
                collection: args.collection,
                path: args.path,
                content: args.content,
                expected_version: args.expected_version,
                author: self.actor_label(),
                tags: args.tags,
            })
            .await?;
        self.tell_collab_of_external_write(written_key).await;
        Ok(serde_json::to_value(result)
            .map_err(|err| KbError::Internal(format!("序列化保存结果失败: {err}")))?)
    }

    pub(super) async fn csv_read_impl(&self, args: CsvReadArgs) -> Result<Value> {
        let page = self
            .file_edits()
            .read_csv(
                &args.collection,
                &args.path,
                args.offset.unwrap_or(0) as usize,
                args.limit.unwrap_or(500) as usize,
            )
            .await?;
        Ok(serde_json::to_value(page)
            .map_err(|err| KbError::Internal(format!("序列化表格失败: {err}")))?)
    }

    pub(super) async fn csv_edit_impl(&self, args: CsvEditArgs) -> Result<Value> {
        let written_key =
            kb_core::share::ResourceKey::file(&self.call_space_id(), &args.collection, &args.path)
                .ok();
        self.refuse_while_collaborating(kb_core::share::ResourceKey::file(
            &self.call_space_id(),
            &args.collection,
            &args.path,
        ))
        .await?;
        let ops = args
            .ops
            .into_iter()
            .map(|op| match op {
                CsvEditOp::SetCell { row, col, value } => kb_extract::csv_edit::CsvOp::SetCell {
                    row: row as usize,
                    col: col as usize,
                    value,
                },
                CsvEditOp::InsertRow { at, values } => kb_extract::csv_edit::CsvOp::InsertRow {
                    at: at as usize,
                    values,
                },
                CsvEditOp::DeleteRow { row } => {
                    kb_extract::csv_edit::CsvOp::DeleteRow { row: row as usize }
                }
            })
            .collect();
        let result = self
            .file_edits()
            .edit_csv(kb_service::edit_csv::CsvEditRequest {
                collection: args.collection,
                path: args.path,
                ops,
                expected_version: args.expected_version,
                expected_sha256: args.expected_sha256,
                author: self.actor_label(),
            })
            .await?;
        if result.changed {
            self.tell_collab_of_external_write(written_key).await;
        }
        Ok(serde_json::to_value(result)
            .map_err(|err| KbError::Internal(format!("序列化保存结果失败: {err}")))?)
    }

    pub(super) async fn file_versions_impl(&self, args: FileVersionsArgs) -> Result<Value> {
        let versions = self
            .file_edits()
            .versions(&args.collection, &args.path, args.limit.unwrap_or(50))
            .await?;
        Ok(json!({
            "versions": versions
                .iter()
                .map(|version| json!({
                    "id": version.id,
                    "version": version.version,
                    "author": version.author,
                    "created_at": version.created_at,
                    "size": kb_service::edit::blob_size(&version.body).unwrap_or(version.body.len() as u64),
                    "binary": kb_service::edit::blob_size(&version.body).is_some(),
                    // 二进制版本(Word / Excel / PDF…)存的是备份标记,没有能显示的文字
                    "preview": if kb_service::edit::blob_size(&version.body).is_some() { String::new() } else { version.body.lines().take(3).collect::<Vec<_>>().join("\n") },
                }))
                .collect::<Vec<_>>(),
        }))
    }

    pub(super) async fn file_info_impl(
        &self,
        args: kb_capability::defs::FileInfoArgs,
    ) -> Result<Value> {
        let edits = self.file_edits();
        let sha256 = edits.file_sha256(&args.collection, &args.path).await?;
        let is_xlsx = args.path.to_ascii_lowercase().ends_with(".xlsx");
        // 公式格只对 xlsx 有意义;读不懂的表格(加密、损坏)不报错,只是不给公式格,编辑时会被拒绝并说明
        let formulas = if is_xlsx {
            edits
                .sheet_info(&args.collection, &args.path)
                .await
                .ok()
                .map(|(formulas, _)| formulas)
        } else {
            None
        };
        Ok(json!({
            "collection": args.collection,
            "path": args.path,
            "sha256": sha256,
            "max_replace_bytes": kb_service::edit::MAX_REPLACE_BYTES,
            "formulas": formulas,
            // upload / project / source:界面据此决定能不能原地编辑(先只开放上传到知识库的文件)
            "origin": edits.origin(&args.collection, &args.path).await?,
        }))
    }

    pub(super) async fn edit_sheet_cells_impl(
        &self,
        args: kb_capability::defs::EditSheetCellsArgs,
    ) -> Result<Value> {
        let edits: Vec<kb_extract::xlsx_edit::CellEdit> = args
            .edits
            .into_iter()
            .map(|edit| kb_extract::xlsx_edit::CellEdit {
                sheet: edit.sheet,
                cell: edit.cell,
                value: edit.value,
            })
            .collect();
        self.refuse_while_collaborating(kb_core::share::ResourceKey::file(
            &self.call_space_id(),
            &args.collection,
            &args.path,
        ))
        .await?;
        let result = self
            .file_edits()
            .edit_sheet_cells(
                &args.collection,
                &args.path,
                &edits,
                args.expected_sha256.as_deref(),
                &self.actor_label(),
            )
            .await?;
        Ok(serde_json::to_value(result)
            .map_err(|err| KbError::Internal(format!("序列化改表结果失败: {err}")))?)
    }

    /// 某一版版本的全文。二进制版本存的是备份标记、没有文字,`binary` 置 true、`body` 留空。
    pub(super) async fn file_version_impl(&self, args: FileVersionArgs) -> Result<Value> {
        let version = self
            .file_edits()
            .version(&args.version_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("版本 {}", args.version_id)))?;
        let binary = kb_service::edit::blob_size(&version.body).is_some();
        Ok(json!({
            "id": version.id,
            "item_id": version.item_id,
            "collection": version.collection,
            "source": version.source,
            "version": version.version,
            "title": version.title,
            "tags": version.tags,
            "author": version.author,
            "created_at": version.created_at,
            "binary": binary,
            "body": if binary { String::new() } else { version.body },
        }))
    }
}

/// 预览的三件套:`(抽取器 id, 块, 读失败原因)`。
///
/// 读失败与抽取失败都不报抽取器;读失败还要给出原因,别让界面把它显示成“空文件”。
/// 抽成独立函数是为了能整段测。
async fn preview_parts(
    path: Option<&std::path::Path>,
) -> (Option<String>, Vec<Value>, Option<String>) {
    let Some(path) = path else {
        return (None, Vec::new(), None);
    };
    match read_original(path) {
        Ok(bytes) => {
            let (extractor, blocks) = extract_preview(&bytes, path).await;
            (extractor, blocks, None)
        }
        Err(err) => (None, Vec::new(), Some(err)),
    }
}

/// 读原件:读不到时给出可读的原因,不要把失败伪装成空文件。
fn read_original(path: &std::path::Path) -> std::result::Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|err| format!("读不到原件: {err}"))
}

/// 抽取一个文件的预览块,返回 `(抽取器 id, 块)`。
///
/// 只有**抽取成功**时才给出抽取器 id:失败(空文件 / 不认识的格式 / 解析报错)时是 `None`,
/// 免得界面显示“抽取器 application/pdf”却没有任何块。抽成独立函数是为了能单测。
async fn extract_preview(bytes: &[u8], path: &std::path::Path) -> (Option<String>, Vec<Value>) {
    // 进程级注册表:预览要和真正入库时选到同一个抽取器。
    let registry = kb_extract::registry::global();
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let head = &bytes[..bytes.len().min(4096)];
    let picked = registry
        .pick(head, ext)
        .map(|(item, _)| item.id().to_owned());
    // location 必须是**真实路径**:图片 / 音视频抽取器要拿它去跑 OCR / 转写,CSV 用它当工作表名
    //
    let source = kb_core::model::SourceRef {
        scheme: "file".to_owned(),
        location: path.to_string_lossy().into_owned(),
        project_root: None,
    };
    match registry.extract(&source, bytes, ext).await {
        Ok(doc) => {
            let blocks = doc
                .blocks
                .iter()
                .map(|block| {
                    json!({
                        "anchor": block.anchor,
                        "kind": block_kind(&block.block),
                        "text": block.block.text(),
                    })
                })
                .collect();
            (picked, blocks)
        }
        Err(_) => (None, Vec::new()),
    }
}

impl ServiceBackend {
    /// 文本编辑服务(每次构造都很快,只持有 Arc)。
    /// 文件操作服务。每次按当前调用者所在知识库现建,和 `items` / `file_edits` 一致。
    pub(crate) fn file_ops(&self) -> kb_service::FileOpsService {
        let rt = self.rt();
        kb_service::FileOpsService::new(
            rt.meta.clone(),
            rt.store(),
            std::sync::Arc::new(rt.index_service()),
            rt.paths.clone(),
        )
    }

    /// 删除 / 移动前确认没有人在协作编辑里改这个文件。
    pub(crate) async fn guard_file_mutation(
        &self,
        collection: &str,
        path: &str,
        folder: bool,
    ) -> Result<()> {
        let key = if folder {
            kb_core::share::ResourceKey::dir(&self.call_space_id(), collection, path)
        } else {
            kb_core::share::ResourceKey::file(&self.call_space_id(), collection, path)
        };
        self.refuse_while_collaborating(key).await
    }

    /// 移动参数里的目标知识库:不传 / 空串 = 当前知识库。
    pub(crate) fn target_collection<'a>(current: &'a str, requested: Option<&'a str>) -> &'a str {
        requested
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(current)
    }

    /// 与服务端 `join_target` 同口径:首尾斜杠不算目录的一部分。
    pub(crate) fn joined_target(dir: &str, name: &str) -> String {
        let dir = dir.trim_matches('/');
        if dir.is_empty() {
            name.to_owned()
        } else {
            format!("{dir}/{name}")
        }
    }

    /// 移动后把授权 / 分享链接里的资源键改到新路径。失败只记日志:
    /// 文件已经移动成功了,残留的旧键访问不到任何东西。
    pub(crate) async fn rekey_file_shares(
        &self,
        collection: &str,
        from: &str,
        to: &str,
        folder: bool,
    ) {
        let Some(system) = &self.system else {
            return;
        };
        let from_key = if folder {
            kb_core::share::ResourceKey::dir(&self.call_space_id(), collection, from)
        } else {
            kb_core::share::ResourceKey::file(&self.call_space_id(), collection, from)
        };
        let to_key = if folder {
            kb_core::share::ResourceKey::dir(&self.call_space_id(), collection, to)
        } else {
            kb_core::share::ResourceKey::file(&self.call_space_id(), collection, to)
        };
        if let (Ok(from_key), Ok(to_key)) = (from_key, to_key)
            && let Err(err) = system.rekey_resource(&from_key, &to_key).await
        {
            tracing::warn!(error = %err, "移动后改分享资源键失败");
        }
    }

    pub(crate) fn file_edits(&self) -> kb_service::edit::FileEditService {
        let index = std::sync::Arc::new(kb_service::IndexService::new(
            self.rt().meta.clone(),
            self.rt().store.clone(),
            self.rt().embedder.clone(),
            self.rt().chunker.clone(),
            self.rt().scanner.clone(),
            kb_service::index::IndexOptions::default(),
        ));
        kb_service::edit::FileEditService::new(
            self.rt().meta.clone(),
            index,
            self.rt().paths.clone(),
        )
        .with_keep_versions(self.rt().config().office.keep_versions)
    }

    /// 找一个文件的绝对路径:先看解析队列(`abs_path`),再看项目根目录。
    async fn locate_file(
        &self,
        collection: &str,
        rel_path: &str,
    ) -> Result<Option<std::path::PathBuf>> {
        // 路径由调用者填:绝对路径和 `..` 直接拒绝(见 `kb_service::safe_path`)
        kb_service::safe_path::check_rel_path(rel_path)?;
        if let Some(file) =
            IngestRepo::get_by_path(self.rt().meta.as_ref(), collection, rel_path).await?
        {
            let path = std::path::PathBuf::from(&file.abs_path);
            if path.is_file() {
                return Ok(Some(path));
            }
        }
        let projects = ProjectRepo::list(self.rt().meta.as_ref()).await?;
        for project in projects {
            if let Some(found) = kb_service::safe_path::resolve_inside(
                std::path::Path::new(&project.root_path),
                rel_path,
            ) {
                return Ok(Some(found));
            }
        }
        Ok(None)
    }
}

/// 按扩展名给 MIME(预览页读原件用;认不出来就 `application/octet-stream`)。
fn mime_of(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod list_files_tests {
    //! 引用选择器的目录扫描:只收普通文件,跳过构建目录 / 隐藏项 / 软链接。
    use super::{
        is_template_name, normalize_scan_prefix, path_within, scan_file_kind, scan_files_under,
    };

    #[test]
    fn prefix_is_relative_and_rejects_escape() {
        assert_eq!(
            normalize_scan_prefix(" docs/表格/ ").unwrap().as_deref(),
            Some("docs/表格")
        );
        assert_eq!(normalize_scan_prefix("").unwrap(), None);
        for bad in ["..", "docs/../x", "/docs//a", "docs/./a"] {
            assert!(normalize_scan_prefix(bad).is_err(), "{bad:?} 不该通过");
        }
    }

    #[test]
    fn paths_match_on_directory_boundaries() {
        assert!(path_within("docs/a.md", "docs"));
        assert!(path_within("docs", "docs"));
        assert!(path_within("docs/sub/a.md", "docs"));
        assert!(!path_within("docs2/a.md", "docs"));
        assert!(!path_within("other/a.md", "docs"));
    }

    #[test]
    fn kinds_and_templates_are_recognised() {
        assert!(is_template_name("模板/报价单.DOTX"));
        assert!(!is_template_name("模板/报价单.docx"));
        assert_eq!(scan_file_kind("图/a.PNG"), "image");
        assert_eq!(scan_file_kind("表/a.xlsx"), "sheet");
        assert_eq!(scan_file_kind("模板/a.xltx"), "template");
        assert_eq!(scan_file_kind("README"), "file");
    }

    #[test]
    fn scan_skips_hidden_build_dirs_and_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("docs/sub")).unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("docs/a.md"), "a").unwrap();
        std::fs::write(root.join("docs/sub/b.xlsx"), "b").unwrap();
        std::fs::write(root.join("target/debug/noise.md"), "n").unwrap();
        std::fs::write(root.join(".git/config"), "g").unwrap();
        std::fs::write(root.join(".hidden.md"), "h").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("docs/a.md"), root.join("link.md")).unwrap();

        let mut out = Vec::new();
        assert!(!scan_files_under(root, root, 0, Some("src-1"), &mut out));
        let mut paths: Vec<&str> = out.iter().map(|file| file.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, ["docs/a.md", "docs/sub/b.xlsx"]);
        assert!(
            out.iter()
                .all(|file| file.source_id.as_deref() == Some("src-1"))
        );
    }
}

#[cfg(test)]
mod preview_tests {
    //! `file_preview` 的抽取器判定与路径传递。
    use super::{EDITABLE_MAX_BYTES, VIEWABLE_MAX_BYTES, extract_preview, read_text_within};

    /// 临时文件:`tempfile` 已经是 dev-dependency,用它管生命周期(手搓目录不会自己清理）
    fn temp_file(name: &str, bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("建临时目录");
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).expect("写临时文件");
        (dir, path)
    }

    #[tokio::test]
    async fn extractor_is_reported_only_when_extraction_succeeds() {
        let (_dir, path) = temp_file("empty.pdf", b"");
        let (extractor, blocks) = extract_preview(b"", &path).await;
        assert_eq!(extractor, None, "抽取失败时不该报抽取器");
        assert!(blocks.is_empty());

        let (_dir, path) = temp_file("x.unknownext", b"");
        let (extractor, blocks) = extract_preview(b"", &path).await;
        assert_eq!(extractor, None);
        assert!(blocks.is_empty());
    }

    #[tokio::test]
    async fn extractor_id_matches_the_registry_choice() {
        let (_dir, path) = temp_file("a.md", "# 标题\n\n正文一段。".as_bytes());
        let bytes = std::fs::read(&path).expect("读回");
        let (extractor, blocks) = extract_preview(&bytes, &path).await;
        assert_eq!(extractor.as_deref(), Some("text/markdown"));
        assert!(!blocks.is_empty(), "markdown 应该能抽出块");
    }

    /// 真实路径必须传下去:图片 OCR 要拿它去跑外部命令。
    /// 抽取配置在进程内只能注入一次;这个二进制里没有别的测试做抽取,所以由这一条负责装。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn image_ocr_gets_the_real_path() {
        let dir = tempfile::tempdir().expect("建临时目录");
        // 假 tesseract:输出固定文本,不依赖本机是否装了 OCR
        let script = dir.path().join("fake-ocr.sh");
        std::fs::write(&script, "#!/bin/sh\ncat <<'EOF'\n发票金额 1200 元\nEOF\n").expect("写脚本");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script).expect("元数据").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script, perms).expect("加执行位");
        }
        let installed = kb_extract::install(kb_core::config::ExtractConfig {
            ocr_enabled: true,
            ocr_backend: "tesseract".to_owned(),
            ocr_fallback_command: script.to_string_lossy().into_owned(),
            ..kb_core::config::ExtractConfig::default()
        });
        assert!(installed, "本测试应第一个注入抽取配置");

        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&[0u8; 64]);
        let path = dir.path().join("invoice.png");
        std::fs::write(&path, &png).expect("写图片");

        let (extractor, blocks) = extract_preview(&png, &path).await;
        assert_eq!(extractor.as_deref(), Some("image/*"));
        let text = blocks
            .iter()
            .filter_map(|block| block.get("text"))
            .filter_map(|text| text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("发票金额"), "OCR 文本应进块:{text}");
        assert!(
            !text.contains("没有本地路径"),
            "不该因为丢了路径而跳过 OCR:{text}"
        );
    }

    /// 读不到原件要给出原因,而不是变成“空文件”。
    #[tokio::test]
    async fn preview_parts_reports_a_read_error_for_missing_files() {
        let dir = tempfile::tempdir().expect("建临时目录");
        let missing = dir.path().join("nope.png");
        let (extractor, blocks, error) = super::preview_parts(Some(&missing)).await;
        assert_eq!(extractor, None);
        assert!(blocks.is_empty());
        assert!(
            error.as_deref().unwrap_or_default().contains("读不到原件"),
            "{error:?}"
        );

        // 正常文件:没有错误
        let (_dir, path) = temp_file("ok.md", "# 标题\n".as_bytes());
        let (extractor, blocks, error) = super::preview_parts(Some(&path)).await;
        assert_eq!(error, None);
        assert_eq!(extractor.as_deref(), Some("text/markdown"));
        assert!(!blocks.is_empty());

        // 没有路径(文件没入过库):三样都是空,不算读失败
        let (extractor, blocks, error) = super::preview_parts(None).await;
        assert_eq!((extractor, blocks.len(), error), (None, 0, None));
    }

    /// 读不到原件要给出原因,而不是变成“空文件”。
    #[test]
    fn missing_original_reports_a_read_error() {
        let missing = std::env::temp_dir().join("kb-preview-not-there-xyz.png");
        let error = super::read_original(&missing).expect_err("不存在的文件应该报错");
        assert!(error.contains("读不到原件"), "{error}");
    }

    /// 真实路径必须传下去:CSV 抽取器拿路径末段当工作表名。
    #[tokio::test]
    async fn csv_sheet_name_comes_from_the_real_file_name() {
        let (_dir, path) = temp_file("scores.csv", b"name,score\nalice,1\nbob,2\n");
        let bytes = std::fs::read(&path).expect("读回");
        let (extractor, blocks) = extract_preview(&bytes, &path).await;
        assert_eq!(extractor.as_deref(), Some("text/csv"));
        let sheet = blocks
            .iter()
            .find_map(|block| block.get("anchor"))
            .and_then(|anchor| anchor.get("sheet"))
            .and_then(|sheet| sheet.as_str())
            .unwrap_or_default()
            .to_owned();
        assert_eq!(sheet, "scores", "工作表名应该是文件名,不是 preview");
    }

    #[test]
    fn editable_text_is_decided_by_content_not_extension() {
        let dir = tempfile::tempdir().expect("tempdir");
        let write = |name: &str, bytes: &[u8]| {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).expect("write");
            path
        };
        // 白名单之外的扩展名,只要是 UTF-8 文本就能改
        assert_eq!(
            read_text_within(&write("a.cs", b"class A {}"), EDITABLE_MAX_BYTES),
            "class A {}"
        );
        assert_eq!(
            read_text_within(&write("app.ini", b"[x]\na=1"), EDITABLE_MAX_BYTES),
            "[x]\na=1"
        );
        assert_eq!(
            read_text_within(&write("noext", "你好".as_bytes()), EDITABLE_MAX_BYTES),
            "你好"
        );
        // 含 NUL 的二进制、非 UTF-8(GBK)、空文件、过大的文件都不可编辑
        assert!(read_text_within(&write("b.bin", b"ab\0cd"), EDITABLE_MAX_BYTES).is_empty());
        assert!(
            read_text_within(
                &write("gbk.txt", &[0xc4, 0xe3, 0xba, 0xc3]),
                EDITABLE_MAX_BYTES
            )
            .is_empty()
        );
        assert!(read_text_within(&write("empty.txt", b""), EDITABLE_MAX_BYTES).is_empty());
        let big = vec![b'a'; (EDITABLE_MAX_BYTES + 1) as usize];
        assert!(read_text_within(&write("big.txt", &big), EDITABLE_MAX_BYTES).is_empty());
        let edge = vec![b'a'; EDITABLE_MAX_BYTES as usize];
        assert_eq!(
            read_text_within(&write("edge.txt", &edge), EDITABLE_MAX_BYTES).len(),
            EDITABLE_MAX_BYTES as usize
        );
        assert!(read_text_within(&dir.path().join("missing.txt"), EDITABLE_MAX_BYTES).is_empty());
        // 查看的上限比编辑大得多:超过编辑上限的文本照样能读到全文(页面显示整份文档,不能退回去显示片段)
        assert_eq!(
            read_text_within(&write("big.txt", &big), VIEWABLE_MAX_BYTES).len(),
            big.len(),
            "略大于编辑上限的文本,查看时要给全文"
        );
        assert!(
            read_text_within(
                &write("gbk2.txt", &[0xc4, 0xe3, 0xba, 0xc3]),
                VIEWABLE_MAX_BYTES
            )
            .is_empty()
        );
        assert!(read_text_within(&write("nul.txt", b"a\0b"), VIEWABLE_MAX_BYTES).is_empty());
        let over = vec![b'a'; (VIEWABLE_MAX_BYTES + 1) as usize];
        assert!(
            read_text_within(&write("over.txt", &over), VIEWABLE_MAX_BYTES).is_empty(),
            "超过查看上限的由页面改用原件地址"
        );
    }
}
