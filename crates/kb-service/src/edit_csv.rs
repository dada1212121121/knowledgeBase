//! CSV / TSV 表格编辑(第 5 步):读一页、按操作改格子 / 加删行,其余字节原样不动。
//!
//! 字节级的修改在 `kb_extract::csv_edit`(保持编码、分隔符、引号、行尾);这里管服务层的事:
//! - 乐观锁:版本号 `expected_version` 和打开时的内容哈希 `expected_sha256` 任一对不上都拒绝,
//!   不会把别人(或别的程序)刚存的东西覆盖掉;
//! - 保存走文本编辑那条路(`FileEditService::save`):它按文件原来的编码写回、记基线版本和新版本、
//!   登记可撤销的改动、只重嵌入变了的块。所以版本恢复 / 撤销也自动保持编码;
//! - 只认 `.csv` / `.tsv`(其它文本文件走文本编辑)。

use kb_core::{KbError, Result};
use kb_extract::csv_edit::{CsvDoc, CsvFormat, CsvOp};
use kb_extract::text_codec::Decoded;
use serde::Serialize;

use crate::edit::{FileEditService, SaveFileRequest};

/// 一页最多多少行(前端分页取)。
pub const MAX_PAGE_ROWS: usize = 2000;

/// 文件的写法(给前端显示:「GB18030 · 分号 · CRLF」)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CsvFormatInfo {
    /// 编码的稳定标识(`utf-8` / `utf-8-bom` / `utf-16le` / `utf-16be` / `gb18030`)。
    pub encoding: String,
    /// 编码给人看的名字。
    pub encoding_label: String,
    /// 分隔符。
    pub delimiter: char,
    /// 行尾(`lf` / `crlf` / `cr`)。
    pub newline: String,
    /// 文件最后有没有换行。
    pub trailing_newline: bool,
}

impl From<CsvFormat> for CsvFormatInfo {
    fn from(format: CsvFormat) -> Self {
        Self {
            encoding: format.encoding.id().to_owned(),
            encoding_label: format.encoding.label().to_owned(),
            delimiter: format.delimiter,
            newline: format.newline.id().to_owned(),
            trailing_newline: format.trailing_newline,
        }
    }
}

/// 读到的一页。
#[derive(Clone, Debug, Serialize)]
pub struct CsvPage {
    /// 总行数(不含全空白的行)。
    pub total_rows: usize,
    /// 最宽的一行有几列。
    pub columns: usize,
    /// 这一页的行(`offset` 起,最多 `limit` 行)。
    pub rows: Vec<Vec<String>>,
    /// 这一页第一行在整张表里的行号(从 0 开始)。
    pub offset: usize,
    /// 文件的写法。
    pub format: CsvFormatInfo,
    /// 现在文件内容的 sha256:保存时原样带回来,文件在你打开之后被改过就会被拒绝。
    pub sha256: String,
    /// 现在的版本号(没编辑过是 0)。
    pub version: i64,
}

/// 一次编辑。
#[derive(Clone, Debug)]
pub struct CsvEditRequest {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径。
    pub path: String,
    /// 操作(行号都指修改之前的表)。
    pub ops: Vec<CsvOp>,
    /// 乐观锁:打开时看到的版本号(`None` = 不检查)。
    pub expected_version: Option<i64>,
    /// 乐观锁:打开时看到的内容哈希(`None` = 不检查)。
    pub expected_sha256: Option<String>,
    /// 谁改的。
    pub author: String,
}

/// 编辑结果。
#[derive(Clone, Debug, Serialize)]
pub struct CsvEditResult {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径。
    pub path: String,
    /// 内容有没有变(没变不产生版本、不重嵌入)。
    pub changed: bool,
    /// 保存之后的版本号。
    pub version: i64,
    /// 本次重新嵌入的块数。
    pub embedded: u64,
    /// 该文件当前的块数。
    pub chunks: u64,
    /// 版本记录 id(没变时为空)。
    pub version_id: String,
    /// 保存之后文件内容的 sha256。
    pub sha256: String,
    /// 文件的写法。
    pub format: CsvFormatInfo,
}

fn extension_of(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn require_csv(path: &str) -> Result<String> {
    let extension = extension_of(path);
    if extension == "csv" || extension == "tsv" {
        Ok(extension)
    } else {
        Err(KbError::InvalidInput(format!(
            "{path} 不是 CSV / TSV 文件,表格编辑只支持这两种;其它文本文件请用文本编辑"
        )))
    }
}

impl FileEditService {
    /// 读一页表格,连同文件的写法、内容哈希和版本号。
    pub async fn read_csv(
        &self,
        collection: &str,
        rel_path: &str,
        offset: usize,
        limit: usize,
    ) -> Result<CsvPage> {
        let extension = require_csv(rel_path)?;
        let path = self.locate(collection, rel_path).await?;
        let limit = limit.clamp(1, MAX_PAGE_ROWS);
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(&path))
            .await
            .map_err(|err| KbError::Internal(format!("读取任务异常退出: {err}")))?
            .map_err(|err| KbError::InvalidInput(format!("读取 {rel_path} 失败: {err}")))?;
        let sha256 = kb_core::hash::sha256_hex_bytes(&bytes);
        let (page, format) = tokio::task::spawn_blocking(move || -> Result<_> {
            let doc = CsvDoc::open(&bytes, &extension)?;
            Ok((
                (doc.row_count(), doc.column_count(), doc.rows(offset, limit)),
                doc.format(),
            ))
        })
        .await
        .map_err(|err| KbError::Internal(format!("解析任务异常退出: {err}")))??;
        let version = self.latest_version(collection, rel_path).await?;
        Ok(CsvPage {
            total_rows: page.0,
            columns: page.1,
            rows: page.2,
            offset,
            format: format.into(),
            sha256,
            version,
        })
    }

    /// 应用一批操作并保存。什么都没变就不写盘、不产生版本。
    pub async fn edit_csv(&self, request: CsvEditRequest) -> Result<CsvEditResult> {
        let extension = require_csv(&request.path)?;
        let path = self.locate(&request.collection, &request.path).await?;
        let latest = self
            .latest_version(&request.collection, &request.path)
            .await?;
        if let Some(expected) = request.expected_version
            && expected != latest
        {
            return Err(KbError::Conflict {
                expected,
                actual: latest,
            });
        }
        let current = std::fs::read(&path)
            .map_err(|err| KbError::InvalidInput(format!("读取 {} 失败: {err}", request.path)))?;
        let current_sha = kb_core::hash::sha256_hex_bytes(&current);
        if let Some(expected) = &request.expected_sha256
            && !expected.eq_ignore_ascii_case(&current_sha)
        {
            return Err(KbError::InvalidInput(
                "这个文件在你打开之后已被改动(可能有人保存过,或文件在磁盘上被别的程序改了);\
                 请刷新后重新编辑,你这次的修改没有保存"
                    .to_owned(),
            ));
        }
        let ops = request.ops;
        let (next, format) = tokio::task::spawn_blocking(move || -> Result<_> {
            let doc = CsvDoc::open(&current, &extension)?;
            let next = doc.apply(&ops)?;
            Ok((next, doc.format()))
        })
        .await
        .map_err(|err| KbError::Internal(format!("编辑任务异常退出: {err}")))??;
        let next_sha = kb_core::hash::sha256_hex_bytes(&next);
        let info: CsvFormatInfo = format.into();
        if next_sha == current_sha {
            let chunks = kb_core::ports::repo::ChunkRepo::by_path(
                self.meta.as_ref(),
                &request.collection,
                &request.path,
            )
            .await?
            .len() as u64;
            return Ok(CsvEditResult {
                collection: request.collection,
                path: request.path,
                changed: false,
                version: latest,
                embedded: 0,
                chunks,
                version_id: String::new(),
                sha256: current_sha,
                format: info,
            });
        }
        // 交给文本保存那条路:它用文件原来的编码写回,所以这里只要给解码后的文字
        let text = Decoded::decode(&next)?.text;
        let saved = self
            .save(SaveFileRequest {
                collection: request.collection.clone(),
                path: request.path.clone(),
                content: text,
                expected_version: Some(latest),
                author: request.author,
                tags: Vec::new(),
            })
            .await?;
        // 保存走的是另一条编码路径:确认写出去的字节就是 csv_edit 算出来的,不是「差不多」
        let written = std::fs::read(&path)
            .map_err(|err| KbError::Internal(format!("保存后读回 {} 失败: {err}", request.path)))?;
        let written_sha = kb_core::hash::sha256_hex_bytes(&written);
        if written_sha != next_sha {
            return Err(KbError::Internal(format!(
                "保存后的文件和预期不一致({} ≠ {}),请从版本历史恢复保存之前的版本",
                &written_sha[..12],
                &next_sha[..12]
            )));
        }
        Ok(CsvEditResult {
            collection: saved.collection,
            path: saved.path,
            changed: true,
            version: saved.version,
            embedded: saved.embedded,
            chunks: saved.chunks,
            version_id: saved.version_id,
            sha256: written_sha,
            format: info,
        })
    }
}
