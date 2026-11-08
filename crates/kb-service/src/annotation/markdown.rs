//! 批注与“转 Markdown 副本”。
//!
//! - **批注**:锚定到页 / 单元格 / 幻灯片 / 时间点,存 `annotations` 表,同时写成一条可检索记录
//!   (`source = "<文件>#annotation:<id>"`,anchor 落库),这样检索能命中批注并跳回原位置;
//! - **转 Markdown 副本**:把中间文档渲染成 `.md`(标题层级、表格、代码块、图片导出到副本旁的
//!   `<副本名>.assets/`),副本作为独立条目入库,并用 `derived_from` 边指向原件;原件只读不变。

use std::path::Path;

use kb_core::model::{Anchor, Block, Doc, Millis};

use kb_core::{KbError, Result};

/// 渲染结果。

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rendered {
    /// Markdown 正文。
    pub markdown: String,
    /// 文档里的图片块数(落盘了的和只留占位说明的都算)。
    pub images: u32,
    /// 其中真正把原图写成文件的张数。
    pub exported: u32,
    /// 写出的图片文件名(导出目录内,去重后)。上传进来的文件要把它们登记进解析队列表才找得到。
    pub files: Vec<String>,
}

/// 把文档里的原图落盘所需的信息。
pub struct ImageExport<'a> {
    /// 原文件的完整字节。docx 这类 zip 容器里的图片,按 `Block::Image.resource` 的条目名从这里取。
    pub container: &'a [u8],
    /// 图片写进哪个目录。
    pub dir: &'a Path,
    /// Markdown 里引用这个目录用的名字(相对副本所在目录)。
    pub link_dir: &'a str,
}

/// 允许导出的图片扩展名。不含 svg:svg 里能带脚本,宁可不导。
const EXPORT_IMAGE_EXTENSIONS: [&str; 10] = [
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff", "emf", "wmf",
];

/// 一次渲染里已经写出的图片文件(同一张图被引用多次只写一份,不同张的同名文件加序号)。
#[derive(Default)]
struct ExportedFiles {
    /// 条目名 → 写出的文件名;取不到的记 `None`,免得重复去读。
    names: std::collections::HashMap<String, Option<String>>,
    used: std::collections::HashSet<String>,
    /// 实际写出的文件名(按写出顺序)。
    written: Vec<String>,
}

impl ExportedFiles {
    /// 把 `resource` 对应的图片写成文件,返回文件名;容器里取不到、扩展名不在白名单就返回 `None`
    /// (调用方退回占位说明,不让一张坏图拖垮整份转换)。写盘失败才是真错误。
    fn save(&mut self, export: &ImageExport<'_>, resource: &str) -> Result<Option<String>> {
        if let Some(name) = self.names.get(resource) {
            return Ok(name.clone());
        }
        let name = self.write(export, resource)?;
        self.names.insert(resource.to_owned(), name.clone());
        Ok(name)
    }

    fn write(&mut self, export: &ImageExport<'_>, resource: &str) -> Result<Option<String>> {
        let Some(base) = safe_image_name(resource) else {
            return Ok(None);
        };
        let Ok(Some(entry)) = kb_extract::zip::read_entry(
            export.container,
            kb_extract::zip::ZipLimits::default(),
            resource,
        ) else {
            return Ok(None);
        };
        if entry.data.is_empty() {
            return Ok(None);
        }
        let name = self.unique(base);
        std::fs::create_dir_all(export.dir).map_err(|err| {
            KbError::Internal(format!("创建目录 {} 失败: {err}", export.dir.display()))
        })?;
        let target = export.dir.join(&name);
        std::fs::write(&target, &entry.data)
            .map_err(|err| KbError::Internal(format!("写图片 {} 失败: {err}", target.display())))?;
        self.written.push(name.clone());
        Ok(Some(name))
    }

    fn unique(&mut self, name: String) -> String {
        if self.used.insert(name.clone()) {
            return name;
        }
        let (stem, ext) = name.rsplit_once('.').unwrap_or((name.as_str(), ""));
        let mut n = 2u32;
        loop {
            let candidate = format!("{stem}-{n}.{ext}");
            if self.used.insert(candidate.clone()) {
                return candidate;
            }
            n += 1;
        }
    }
}

/// 容器条目名 → 能放心写进磁盘的文件名。
///
/// 条目名来自文档里的关系表,是不可信输入:只取最后一段,扩展名必须在白名单里,
/// 主名只留字母数字和 `-_`,所以写出去的文件一定落在导出目录里、也不会是脚本之类的东西。
fn safe_image_name(resource: &str) -> Option<String> {
    let base = resource.rsplit('/').next()?;
    let (stem, ext) = base.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    if !EXPORT_IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    let stem: String = stem
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .take(60)
        .collect();
    let stem = if stem.is_empty() {
        "image".to_owned()
    } else {
        stem
    };
    Some(format!("{stem}.{ext}"))
}

/// Markdown 链接地址里的一段路径:只转义会破坏 `![](…)` 语法的字符,中文原样保留,方便直接读。
pub(crate) fn link_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for ch in segment.chars() {
        if ch.is_control()
            || matches!(
                ch,
                ' ' | '(' | ')' | '<' | '>' | '[' | ']' | '%' | '\\' | '#' | '?' | '"'
            )
        {
            let mut buffer = [0u8; 4];
            for byte in ch.encode_utf8(&mut buffer).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// 副本路径:`a/b/report.docx` → `a/b/report.md`(只换扩展名,目录结构不变)。
pub fn derived_path(path: &str) -> String {
    match path.rsplit_once('.') {
        Some((stem, _)) => format!("{stem}.md"),
        None => format!("{path}.md"),
    }
}

/// 中间文档 → Markdown(标题层级、表格、代码块、图片)。
///
/// 抽取器带出了原图(`Block::Image.resource`)且给了 `export` 时,图片写成文件并以 `![](…)` 引用,
/// 副本里就能直接看到截图;取不到原图的(PDF 页、没做 OCR 的图片)仍是一句占位说明。
pub fn render_markdown(doc: &Doc, export: Option<&ImageExport<'_>>) -> Result<Rendered> {
    let mut out = String::new();
    if let Some(title) = &doc.meta.title {
        out.push_str(&format!("# {title}\n\n"));
    }
    let mut images = 0u32;
    let mut exported = 0u32;
    let mut files = ExportedFiles::default();
    for anchored in &doc.blocks {
        match &anchored.block {
            Block::Heading { level, text } => {
                out.push_str(&format!("{} {text}\n\n", "#".repeat(*level as usize)));
            }
            Block::Paragraph { text } => {
                out.push_str(text.trim());
                out.push_str("\n\n");
            }
            Block::Code { lang, text } => {
                out.push_str(&format!("```{lang}\n{text}\n```\n\n"));
            }
            Block::Table { header, rows } => {
                if header.is_empty() {
                    continue;
                }
                out.push('|');
                for cell in header {
                    out.push_str(&format!(" {} |", cell.replace('|', "\\|")));
                }
                out.push('\n');
                out.push('|');
                for _ in header {
                    out.push_str(" --- |");
                }
                out.push('\n');
                for row in rows {
                    out.push('|');
                    for cell in row {
                        out.push_str(&format!(" {} |", cell.replace('|', "\\|")));
                    }
                    out.push('\n');
                }
                out.push('\n');
            }
            Block::Image {
                caption,
                ocr_text,
                resource,
            } => {
                images += 1;
                let saved = match (export, resource) {
                    (Some(export), Some(resource)) => {
                        files.save(export, resource)?.map(|name| (export, name))
                    }
                    _ => None,
                };
                if let Some((export, name)) = saved {
                    exported += 1;
                    // 图注里的方括号和换行会截断 `![alt](…)`,换成空格
                    let alt = caption
                        .as_deref()
                        .map(|text| text.replace(['[', ']', '\n', '\r'], " "))
                        // 方括号与换行都换成空格后可能连出多个空格;图注按普通文本折成一个。
                        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
                        .filter(|text| !text.is_empty())
                        .unwrap_or_else(|| format!("图片{images}"));
                    out.push_str(&format!(
                        "![{}]({}/{})\n\n",
                        alt.trim(),
                        link_segment(export.link_dir),
                        link_segment(&name)
                    ));
                } else {
                    let label = caption.clone().unwrap_or_else(|| "图片".to_owned());
                    out.push_str(&format!("> 图片:{label}\n\n"));
                }
                if let Some(text) = ocr_text {
                    out.push_str(&format!("> OCR:{text}\n\n"));
                }
            }
            Block::Media { transcript } => {
                let label = match &anchored.anchor {
                    Anchor::Time { start_ms, end_ms } => {
                        format!("{start_ms}–{end_ms} ms")
                    }
                    _ => "音视频".to_owned(),
                };
                out.push_str(&format!("> 转写({label})"));
                if let Some(text) = transcript {
                    out.push_str(&format!(":{text}"));
                }
                out.push_str("\n\n");
            }
        }
    }
    Ok(Rendered {
        markdown: out,
        images,
        exported,
        files: files.written,
    })
}

pub(crate) fn now_millis() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
