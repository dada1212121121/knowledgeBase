//! PDF 抽取器:逐页取文字层,没有文字层的页标记 `needs_ocr`。
//!
//! **为什么先走 poppler**:内置 `pdf-extract` 对“正文放在 Form XObject 里、或者用了复杂
//! 字体定位”的公文 / 表格类 PDF 会整份抽空(实测一批 365 份 PDF 只抽到 poppler 的 27%,
//! 其中 14 份整份 0 字、另有 2 份直接 panic),而这些文件恰恰是清单、表格类的主体内容。
//! 所以默认用 poppler 的 `pdftotext -layout -`(stdin 读、stdout 出,不落临时文件):
//! 它按 `\f` 分页、对表格的列对齐更稳;它拿不到字(或压根没装)时再用内置解析器兜底,
//! 两者取字数多的那份 —— 任何一台机器上都不能因为少一个外部命令就抽不出 PDF。
//!
//! 位置用 [`Anchor::Page`];一页的文字整段成块,超长由 `DocChunker` 再切。
//!
//! **没有文字层的页**(扫描件、纯图片页):开了 `[extract] ocr_enabled` 就逐页转图再 OCR
//! ([`populate_ocr_pages`])。以前这类页只留一句 `needs_ocr` 提示,整份扫描件搜不到任何字 ——
//! 生产上 130 份扫描件就是这么「入库成功但等于没入」的。转图走 poppler 的 `pdftocairo`
//! (stdin 进、PNG 从 stdout 出,不落中间文件),识别走 [`crate::ocr`] 的既有后端;
//! 页数与总时长都有上限,超出的页继续留提示,不会把入库队列卡在一个大文件上。
//!
//! 两个实现都是同步的:`pdf-extract` 遇到畸形文件会 panic,放进 `spawn_blocking` 并用
//! `catch_unwind` 兜住;poppler 是子进程,另加硬超时,卡死不会拖住整条解析队列。

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

use async_trait::async_trait;
use kb_core::model::{Anchor, AnchoredBlock, Block, Confidence, Doc, DocMeta, SourceRef};
use kb_core::ports::Extractor;
use kb_core::{KbError, Result};

/// poppler 的文字提取命令(走 PATH;没装就退回内置解析器)。
const POPPLER: &str = "pdftotext";
/// 平均每页至少拿到这么多字,才算 poppler 抽到了正文。
///
/// 低于它就再用内置解析器比一遍、取多的那份:poppler 对个别字体子集 / 加密壳会只吐出
/// 表头几行,这时内置解析器可能反而完整(反过来也一样),两边都试一次最稳。
const POOR_CHARS_PER_PAGE: usize = 20;
/// poppler 子进程硬超时。几百页的公文一般 1 秒级;卡住说明文件畸形或管道异常。
const POPPLER_TIMEOUT: Duration = Duration::from_secs(120);
/// 单页转图命令(poppler 的 `pdftocairo`)。选它而不是 `pdftoppm`:
/// 只有 `pdftocairo` 支持输出到 stdout(`-`),`pdftoppm` 会把 `-` 当成文件名写盘。
const POPPLER_RASTER: &str = "pdftocairo";
/// 转图分辨率。150 dpi 是 OCR 的通用下限:再低小字会糊,再高只是白花时间。
const RASTER_DPI: u32 = 150;
/// 单页转图的硬超时。
const RASTER_TIMEOUT: Duration = Duration::from_secs(60);

/// PDF。
pub struct PdfExtractor;

#[async_trait]
impl Extractor for PdfExtractor {
    fn id(&self) -> &str {
        "application/pdf"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        if head.starts_with(b"%PDF") {
            return Confidence::Certain;
        }
        if ext.eq_ignore_ascii_case("pdf") {
            Confidence::Probable
        } else {
            Confidence::Unlikely
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let mut pages = extract_pages(bytes).await?;
        // 扫描件:没有文字层的页先 OCR 出文字再分块。失败不影响入库(退回提示)
        populate_ocr_pages(&mut pages, bytes).await;

        let mut blocks = Vec::new();
        for (index, text) in pages.iter().enumerate() {
            let page = index as u32 + 1;
            let body = text.trim();
            if body.is_empty() {
                // 没有文字层:留给 OCR。这句图注是给预览看的提示,
                // 分块器会按 `Block::is_ocr_hint` 跳过它(不能进索引)
                blocks.push(AnchoredBlock {
                    anchor: Anchor::Page { page },
                    block: Block::Image {
                        caption: Some(format!("第 {page} 页没有文字层(needs_ocr)")),
                        ocr_text: None,
                        resource: None,
                    },
                });
                continue;
            }
            blocks.push(AnchoredBlock {
                anchor: Anchor::Page { page },
                block: Block::Paragraph {
                    text: body.to_owned(),
                },
            });
        }

        Ok(Doc {
            meta: DocMeta {
                source: source.location.clone(),
                title: None,
                lang: "zh".to_owned(),
                mime: Some("application/pdf".to_owned()),
                // 与文件索引链路的 `file_hash` 同源(对原始字节取 xxh3):
                // 以前是 `content_hash(&from_utf8_lossy(bytes))`,二进制字节全被替换成
                // U+FFFD 后,内容不同的 PDF 会算出同一个哈希
                file_hash: kb_core::hash::xxh3_hex(bytes),
                size: bytes.len() as u64,
                mtime: 0,
                project_name: source
                    .project_root
                    .as_ref()
                    .and_then(|root| root.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            },
            blocks: blocks
                .into_iter()
                .filter(|block| !block.block.is_empty())
                .collect(),
        })
    }
}

/// 把没有文字层的页 OCR 一遍,结果写回 `pages`。
///
/// 三条退出条件:`[extract] ocr_enabled` 没开、没有空页、后端不可用。
/// 单个文件最多 `[extract.ocr] max_pages` 页 / `budget_secs` 时间;OCR 本身出错不报错
/// —— 抽取失败会把一份本来只是"没字"的文件判成"坏文件",那是更糟的结果。
async fn populate_ocr_pages(pages: &mut [String], bytes: &[u8]) {
    let config = crate::ocr::config();
    if !config.ocr_enabled {
        return;
    }
    // 上限与预算从注入的 `[extract]` 配置里取:`main.rs` 启动时注入一次,所以改配置要重启
    let budget = config.ocr.budget();
    let targets = ocr_targets(pages, config.ocr.page_cap());
    if targets.is_empty() {
        return;
    }
    // 名额先领、再起预算计时:排队时间不算在 `budget_secs` 里
    let _slot = match ocr_slots().acquire().await {
        Ok(slot) => slot,
        Err(_) => {
            tracing::warn!("OCR 名额信号量已关闭,这一份不做 OCR");
            return;
        }
    };
    let started = std::time::Instant::now();
    let mut filled = 0usize;
    let mut gave_up: Option<String> = None;
    for index in targets {
        if started.elapsed() >= budget {
            gave_up = Some(format!("超过 {} 秒预算", budget.as_secs()));
            break;
        }
        let page = index as u32 + 1;
        match ocr_page(bytes, page).await {
            Ok(Some(text)) => {
                pages[index] = text;
                filled += 1;
            }
            // 这一页确实没字(白页 / 纯图),继续下一页
            Ok(None) => {}
            Err(KbError::Unavailable(reason)) => {
                // 后端不可用是全局问题:后面的页只会一样失败,不必再跑
                gave_up = Some(reason);
                break;
            }
            Err(err) => {
                tracing::warn!(page, error = %err, "PDF 页 OCR 失败,保留 needs_ocr 提示");
            }
        }
    }
    if let Some(reason) = gave_up {
        tracing::warn!(
            pages = pages.len(),
            ocr_pages = filled,
            reason = %reason,
            "PDF 逐页 OCR 提前结束,剩下的页继续留 needs_ocr 提示"
        );
    }
    if filled > 0 {
        tracing::info!(
            pages = pages.len(),
            ocr_pages = filled,
            took_ms = started.elapsed().as_millis() as u64,
            "PDF 扫描页 OCR 完成"
        );
    }
}

/// 哪些页需要 OCR(空页),最多 `cap` 页。抽出来单独测:预算与上限的边界最容易写错。
fn ocr_targets(pages: &[String], cap: usize) -> Vec<usize> {
    pages
        .iter()
        .enumerate()
        .filter(|(_, text)| text.trim().is_empty())
        .map(|(index, _)| index)
        .take(cap)
        .collect()
}

/// 同时 OCR 几份文件。核数的 1/4,最少 1、最多 4。
///
/// OCR 后端是**多线程子进程**(实测一页能吃 3~6 个核):后台允许多个批量分片并行以后,
/// 一个知识库最多 4 个分片 × 每片 3 个文件 = 12 份扫描件一起 OCR,16 核的机器会被压到
/// load 89、swap 打满,每份从 55 秒涨到 150 秒。所以 OCR 自己限流,别的活(文本抽取、
/// 分块、嵌入)照旧并发 —— 一份扫描件在等 OCR 名额时,别的文件照样在推进。
///
/// 名额按**文件**算(一份扫描件从第一页做到最后一页持有同一个),这样排队时间不会算进
/// 单文件的 `budget_secs`:名额紧时等几分钟是在排队,不是在跑它,不该因此判「超时」把剩下的页
/// 丢成 `needs_ocr`。
fn ocr_slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    SLOTS.get_or_init(|| {
        let cores = std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(4);
        // 名额数在第一次用到时定下来:信号量不支持改大小,再加上整份 `[extract]` 是启动时
        // 注入一次 —— 改 `[extract.ocr] slots` 要重启守护进程。`kb doctor` 会把算出来的生效值印出来。
        let slots = crate::ocr::config().ocr.effective_slots(cores);
        tracing::info!(slots, cores, "OCR 名额已确定");
        tokio::sync::Semaphore::new(slots)
    })
}

/// OCR 一页:转图 → 识别。
///
/// 返回 `Ok(None)` 表示"识别了但这页没有字",`Err(Unavailable)` 表示后端不可用
/// (调用方据此提前收工)。
///
/// **不在这里领 [`ocr_slots`] 的名额**:名额是调用方([`populate_ocr_pages`])按整份文件
/// 持有的,同一把信号量再领一次会互等 —— 同时跑的扫描件到上限(核数/4,最多 4)时,
/// 每份手里攥着 1 个、又都在等第 2 个,谁都不会放。表现是入库队列整体停摆:
/// 文件永远停在 `extracting`、机器没有子进程也没有 CPU、只能重启守护进程才能解开。
async fn ocr_page(bytes: &[u8], page: u32) -> Result<Option<String>> {
    let input = bytes.to_vec();
    let png = tokio::task::spawn_blocking(move || rasterize_page(&input, page))
        .await
        .map_err(|err| KbError::Internal(format!("PDF 转图线程异常: {err}")))??;
    if png.is_empty() {
        return Ok(None);
    }
    let file = tempfile::Builder::new()
        .prefix("kb-pdf-ocr-")
        .suffix(".png")
        .tempfile()
        .map_err(|err| KbError::Internal(format!("建临时文件失败: {err}")))?;
    std::fs::write(file.path(), &png)
        .map_err(|err| KbError::Internal(format!("写临时图片失败: {err}")))?;
    // OCR 后端只吃文件路径(外部命令),所以必须先落地一张图;`NamedTempFile` 出了作用域即删
    let path = file.path().to_path_buf();
    let outcome = tokio::task::spawn_blocking(move || {
        let outcome = crate::ocr::ocr_image(&path);
        // 文件句柄要活到命令跑完,别提前删
        drop(file);
        outcome
    })
    .await
    .map_err(|err| KbError::Internal(format!("OCR 线程异常: {err}")))?;

    match outcome {
        crate::ocr::OcrOutcome::Text(text) => {
            let text = text.trim().to_owned();
            Ok((!text.is_empty()).then_some(text))
        }
        crate::ocr::OcrOutcome::Empty => Ok(None),
        crate::ocr::OcrOutcome::Disabled => Err(KbError::Unavailable(
            "OCR 已关闭([extract] ocr_enabled = false)".to_owned(),
        )),
        crate::ocr::OcrOutcome::Unavailable(reason) => Err(KbError::Unavailable(reason)),
    }
}

/// 把 PDF 的第 `page` 页(1 起)转成 PNG 字节。
///
/// stdin 进、stdout 出:不留中间文件,超时被杀也不会剩垃圾。
///
/// 注意别图省事用 `wait_with_output`:一页 150 dpi 的 PNG 有几十上百 KB,超过管道缓冲区
/// (64 KB)后子进程会写满管道阻塞、永远等不到退出,最后只能被超时杀掉。
/// 所以 stdout / stderr 各开一个线程边跑边读。
fn rasterize_page(bytes: &[u8], page: u32) -> Result<Vec<u8>> {
    let mut child = Command::new(POPPLER_RASTER)
        .args([
            "-png",
            "-singlefile",
            "-f",
            &page.to_string(),
            "-l",
            &page.to_string(),
            "-r",
            &RASTER_DPI.to_string(),
            "-",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| KbError::Unavailable(format!("启动 {POPPLER_RASTER} 失败: {err}")))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| KbError::Internal(format!("{POPPLER_RASTER} 的 stdin 不可用")))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| KbError::Internal(format!("{POPPLER_RASTER} 的 stdout 不可用")))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| KbError::Internal(format!("{POPPLER_RASTER} 的 stderr 不可用")))?;

    let input = bytes.to_vec();
    let writer = std::thread::spawn(move || {
        use std::io::Write as _;
        let _ = stdin.write_all(&input);
    });
    let out_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut buffer);
        buffer
    });
    let err_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stderr, &mut buffer);
        buffer
    });

    let started = std::time::Instant::now();
    // `None` 表示超时被杀;`Some(status)` 是子进程自己的退出码
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > RASTER_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = writer.join();
                let _ = out_reader.join();
                let _ = err_reader.join();
                return Err(KbError::Internal(format!(
                    "等待 {POPPLER_RASTER} 失败: {err}"
                )));
            }
        }
    };
    let _ = writer.join();
    let png = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    let Some(status) = exit else {
        return Err(KbError::Unavailable(format!(
            "{POPPLER_RASTER} 转第 {page} 页超过 {} 秒",
            RASTER_TIMEOUT.as_secs()
        )));
    };
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr);
        let reason = stderr.trim();
        return Err(KbError::InvalidInput(if reason.is_empty() {
            format!(
                "{POPPLER_RASTER} 转第 {page} 页失败(退出码 {:?})",
                status.code()
            )
        } else {
            format!("{POPPLER_RASTER} 转第 {page} 页失败: {reason}")
        }));
    }
    Ok(png)
}

/// 逐页取出文字:poppler 优先、内置解析器兜底,取能拿到更多正文的那份。
async fn extract_pages(bytes: &[u8]) -> Result<Vec<String>> {
    let mut poppler_error: Option<KbError> = None;
    let poppler = match poppler_pages(bytes.to_vec()).await {
        Ok(pages) => Some(pages),
        Err(err) => {
            poppler_error = Some(err);
            None
        }
    };

    // poppler 一页十几字都没抽到(扫描件、或只吐出表头):再用内置解析器比一次
    let poor = poppler
        .as_ref()
        .is_none_or(|pages| total_chars(pages) < POOR_CHARS_PER_PAGE * pages.len().max(1));
    if !poor {
        return Ok(poppler.unwrap_or_default());
    }

    let owned = bytes.to_vec();
    let builtin = tokio::task::spawn_blocking(move || builtin_pages(&owned))
        .await
        .map_err(|err| KbError::Internal(format!("PDF 解析线程异常: {err}")))?;

    match builtin {
        Ok(pages) => Ok(match poppler {
            // 两边都有字:取多的(相等时留 poppler 的,它的分页和列对齐更可信)
            Some(poppler) if total_chars(&pages) > total_chars(&poppler) => pages,
            Some(poppler) => poppler,
            None => pages,
        }),
        // 内置解析器也失败:只要 poppler 拿到过字(哪怕是表头),就用它的
        Err(builtin_error) => match poppler {
            Some(poppler) => Ok(poppler),
            None => Err(poppler_error.unwrap_or(builtin_error)),
        },
    }
}

/// 调 poppler(`pdftotext -layout - -`)取逐页文字。
///
/// 输入走 stdin、输出走 stdout:不落临时文件,超时被杀也不会留下垃圾。
async fn poppler_pages(bytes: Vec<u8>) -> Result<Vec<String>> {
    let joined = tokio::time::timeout(
        POPPLER_TIMEOUT,
        tokio::task::spawn_blocking(move || run_poppler(&bytes)),
    )
    .await
    .map_err(|_| {
        KbError::Unavailable(format!(
            "{POPPLER} 超过 {} 秒没有结束,跳过这份 PDF",
            POPPLER_TIMEOUT.as_secs()
        ))
    })?
    .map_err(|err| KbError::Internal(format!("PDF 解析线程异常: {err}")))?;

    joined.map_err(KbError::InvalidInput)
}

/// 同步跑一次 poppler。
fn run_poppler(bytes: &[u8]) -> std::result::Result<Vec<String>, String> {
    let mut child = Command::new(POPPLER)
        .args(["-layout", "-enc", "UTF-8", "-", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("启动 {POPPLER} 失败: {err}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| format!("{POPPLER} 的 stdin 不可用"))?;
    // 写入放独立线程:大文件写满管道时仍在读 stdout,两边不会互相卡住
    let input = bytes.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let output = child
        .wait_with_output()
        .map_err(|err| format!("等待 {POPPLER} 失败: {err}"))?;
    let _ = writer.join();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr.trim();
        return Err(if reason.is_empty() {
            format!("{POPPLER} 退出码 {}", output.status)
        } else {
            format!("{POPPLER} 失败: {reason}")
        });
    }
    Ok(split_pages(&String::from_utf8_lossy(&output.stdout)))
}

/// 内置解析器(`pdf-extract`)。畸形文件会 panic,这里兜住转成错误。
fn builtin_pages(bytes: &[u8]) -> Result<Vec<String>> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pdf_extract::extract_text_from_mem_by_pages(bytes)
    })) {
        Ok(Ok(pages)) => Ok(pages),
        Ok(Err(err)) => Err(KbError::InvalidInput(format!("PDF 解析失败: {err}"))),
        Err(_) => Err(KbError::InvalidInput(
            "PDF 解析器崩溃(文件可能已损坏)".to_owned(),
        )),
    }
}

/// 按 `\f`(poppler 的换页符)切页;末尾多出来的空页丢掉。
fn split_pages(text: &str) -> Vec<String> {
    let mut pages: Vec<String> = text.split('\u{c}').map(str::to_owned).collect();
    if pages.len() > 1 && pages.last().is_some_and(|page| page.trim().is_empty()) {
        pages.pop();
    }
    pages
}

/// 真实正文字数(不数空白):判“这份 PDF 抽到东西了没有”。
fn total_chars(pages: &[String]) -> usize {
    pages
        .iter()
        .map(|page| page.chars().filter(|ch| !ch.is_whitespace()).count())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个最小的单页 PDF(Helvetica + 一行英文),xref 偏移按实际字节算。
    fn minimal_pdf(text: &str) -> Vec<u8> {
        let content = format!("BT /F1 12 Tf 20 100 Td ({text}) Tj ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R \
             /Resources << /Font << /F1 5 0 R >> >> >>"
                .to_owned(),
            format!(
                "<< /Length {} >>\nstream\n{content}\nendstream",
                content.len() + 1
            ),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
        ];
        let mut out = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (index, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", index + 1));
        }
        let xref_at = out.len();
        out.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
        out.push_str("0000000000 65535 f \n");
        for offset in &offsets {
            out.push_str(&format!("{offset:010} 00000 n \n"));
        }
        out.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
            objects.len() + 1
        ));
        out.into_bytes()
    }

    /// 正文放在 Form XObject 里的单页 PDF:内置解析器抽不到,poppler 能抽到。
    ///
    /// 这正是今晚整份 0 字的那 14 份公文的形状(`/Subtype /Form` 64~78 个)。
    fn form_xobject_pdf(text: &str) -> Vec<u8> {
        let content = format!("BT /F1 12 Tf 20 100 Td ({text}) Tj ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 6 0 R \
             /Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 4 0 R >> >> >>"
                .to_owned(),
            format!(
                "<< /Type /XObject /Subtype /Form /BBox [0 0 300 200] \
                 /Resources << /Font << /F1 5 0 R >> >> /Length {} >>\nstream\n{content}\nendstream",
                content.len() + 1
            ),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
            {
                // 页面内容只是“把 Form XObject 贴上来”,正文全在对象 4 里
                let body = "q /Fm1 Do Q";
                format!(
                    "<< /Length {} >>\nstream\n{body}\nendstream",
                    body.len() + 1
                )
            },
        ];
        let mut out = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (index, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", index + 1));
        }
        let xref_at = out.len();
        out.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
        out.push_str("0000000000 65535 f \n");
        for offset in &offsets {
            out.push_str(&format!("{offset:010} 00000 n \n"));
        }
        out.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
            objects.len() + 1
        ));
        out.into_bytes()
    }

    fn source(location: &str) -> SourceRef {
        SourceRef {
            scheme: "file".to_owned(),
            location: location.to_owned(),
            project_root: None,
        }
    }

    /// 本机有没有 poppler(没有就跳过依赖它的用例,不能因为少个外部命令就红)。
    fn has_poppler() -> bool {
        Command::new(POPPLER)
            .arg("-v")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[tokio::test]
    async fn extracts_text_with_page_anchor() {
        let bytes = minimal_pdf("Hello knowledge base");
        let doc = PdfExtractor
            .extract(&source("报告.pdf"), &bytes)
            .await
            .expect("抽取");
        assert_eq!(doc.blocks.len(), 1, "{:?}", doc.blocks);
        assert_eq!(doc.blocks[0].anchor, Anchor::Page { page: 1 });
        let text = doc.blocks[0].block.text();
        assert!(text.contains("Hello knowledge base"), "{text}");
    }

    /// 正文在 Form XObject 里:内置解析器整份抽空,poppler 能拿到 —— 这是今晚
    /// “14 份公文 245 万字全丢”的根因,必须钉住。
    #[tokio::test]
    async fn form_xobject_body_is_not_lost() {
        if !has_poppler() {
            eprintln!("跳过:本机没有 {POPPLER}");
            return;
        }
        let bytes = form_xobject_pdf("Form XObject body text");
        let doc = PdfExtractor
            .extract(&source("公文.pdf"), &bytes)
            .await
            .expect("抽取");
        let text = doc.text();
        assert!(text.contains("Form XObject body text"), "正文丢了:{text}");
    }

    /// 本机有没有转图命令(没有就跳过依赖它的用例)。
    fn has_raster() -> bool {
        Command::new(POPPLER_RASTER)
            .arg("-v")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    /// 空页才算 OCR 目标;有字的页(哪怕只有几行)不许再花一次 OCR。
    #[test]
    fn only_empty_pages_are_ocr_targets() {
        let pages = vec![
            "第一页有字".to_owned(),
            String::new(),
            "   \n\t ".to_owned(),
            "第三页有字".to_owned(),
        ];
        assert_eq!(ocr_targets(&pages, 40), vec![1, 2]);
        // 上限按页号从小到大截断:先识别靠前的页,后面的留提示
        assert_eq!(ocr_targets(&pages, 1), vec![1]);
        assert!(ocr_targets(&pages, 0).is_empty());
        assert!(ocr_targets(&["都有字".to_owned()], 40).is_empty());
    }

    /// 转图:PNG 字节要从 stdout 拿到,而且不能被管道缓冲卡死(页图远超 64 KB)。
    #[test]
    fn rasterize_page_returns_png_bytes() {
        if !has_raster() {
            eprintln!("跳过:本机没有 {POPPLER_RASTER}");
            return;
        }
        let bytes = minimal_pdf("rasterized page");
        let png = rasterize_page(&bytes, 1).expect("转图");
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']), "应是 PNG 头");
        assert!(png.len() > 1024, "图太小说明没画出来:{} 字节", png.len());
    }

    /// 越界的页号:poppler 会失败,这是可跳过的 `InvalidInput`,不是内部错误。
    #[test]
    fn rasterize_missing_page_is_an_input_error() {
        if !has_raster() {
            eprintln!("跳过:本机没有 {POPPLER_RASTER}");
            return;
        }
        let bytes = minimal_pdf("only one page");
        let error = rasterize_page(&bytes, 9).expect_err("第 9 页不存在");
        assert!(
            matches!(error, KbError::InvalidInput(_) | KbError::Unavailable(_)),
            "应是可跳过 / 可重试的错误:{error}"
        );
    }

    /// 端到端:真扫描件(整页是图、没有文字层)要 OCR 出文字。
    ///
    /// 需要真样本(仓库里不能塞扫描件),用 `KB_PDF_SCAN_SAMPLE=/path/to.pdf` 指定,
    /// 没给或本机没 OCR 后端就跳过。手工验证方式:
    /// `KB_PDF_SCAN_SAMPLE=… cargo test -p kb-extract --lib pdf::tests::scanned_pdf_is_ocrd -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "需要 KB_PDF_SCAN_SAMPLE 指向真实的扫描件 PDF"]
    async fn scanned_pdf_is_ocrd() {
        let Ok(path) = std::env::var("KB_PDF_SCAN_SAMPLE") else {
            eprintln!("跳过:没设 KB_PDF_SCAN_SAMPLE");
            return;
        };
        // 测试进程默认没注入配置(OCR 关),这里显式打开;
        // 想验证 rapidocr 就把 `KB_OCR_MODEL_DIR` 指到模型目录,否则走 tesseract 降级
        let mut config = kb_core::config::ExtractConfig {
            ocr_enabled: true,
            ..Default::default()
        };
        if let Ok(dir) = std::env::var("KB_OCR_MODEL_DIR") {
            config.ocr_model_dir = Some(dir);
        }
        crate::ocr::install(config);
        let bytes = std::fs::read(&path).expect("读样本");
        let doc = PdfExtractor
            .extract(&source(&path), &bytes)
            .await
            .expect("抽取");
        let text = doc.text();
        let chars = text.chars().filter(|ch| !ch.is_whitespace()).count();
        eprintln!(
            "OCR 出 {chars} 字:{:?}",
            text.chars().take(120).collect::<String>()
        );
        assert!(
            chars > 20,
            "扫描件应该 OCR 出正文,只拿到 {chars} 字(本机 OCR 后端是否就绪?)"
        );
    }

    /// 两个解析器都抽不到(扫描件):保留逐页 `needs_ocr` 提示,交给 OCR 链路。
    #[tokio::test]
    async fn scanned_pdf_marks_every_page_needs_ocr() {
        let bytes = minimal_pdf("");
        let doc = PdfExtractor
            .extract(&source("扫描件.pdf"), &bytes)
            .await
            .expect("抽取");
        assert_eq!(doc.blocks.len(), 1, "{:?}", doc.blocks);
        assert!(
            doc.blocks[0].block.is_ocr_hint(),
            "空页要留 needs_ocr 提示:{:?}",
            doc.blocks
        );
        assert!(kb_core::model::ExtractMeta::from_doc(&doc).needs_ocr);
    }

    /// 按 `\f` 分页,末尾空页要丢掉(poppler 每页后面都跟一个换页符)。
    #[test]
    fn pages_are_split_on_form_feed() {
        assert_eq!(
            split_pages("第一页\u{c}第二页\u{c}"),
            vec!["第一页".to_owned(), "第二页".to_owned()]
        );
        assert_eq!(split_pages("只有一页"), vec!["只有一页".to_owned()]);
        assert_eq!(
            split_pages("一\u{c}\u{c}三\u{c}"),
            vec!["一".to_owned(), String::new(), "三".to_owned()]
        );
    }

    #[test]
    fn detect_uses_magic_then_extension() {
        assert_eq!(PdfExtractor.detect(b"%PDF-1.7", "bin"), Confidence::Certain);
        assert_eq!(PdfExtractor.detect(b"hello", "pdf"), Confidence::Probable);
        assert_eq!(PdfExtractor.detect(b"hello", "md"), Confidence::Unlikely);
    }

    /// 名额公式 + 「单页不会二次领名额」合在一个用例里:名额是进程级静态信号量,
    /// 拆成两个用例会同时跑、互相把名额占走(实测另一条用例断言时拿到 0 个)。
    #[tokio::test]
    async fn ocr_slots_bound_files_and_a_page_never_reacquires() {
        let cores = std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(4);
        assert_eq!(
            ocr_slots().available_permits(),
            (cores / 4).clamp(1, 4),
            "OCR 名额应是核数的 1/4、最少 1 个最多 4 个"
        );
        // 回归:名额被「同时跑的那几份文件」占满时,单页 OCR 不能再领一次,
        // 否则它们互相等对方释放(生产上就是整条入库队列静止不动)
        let cap = ocr_slots().available_permits();
        let mut held = Vec::new();
        for _ in 0..cap {
            held.push(ocr_slots().acquire().await.expect("名额"));
        }
        let done = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            ocr_page(b"%PDF-1.4\nnot really", 1),
        )
        .await;
        assert!(
            done.is_ok(),
            "名额全被占住时单页 OCR 卡住了(说明又去领了一次名额)"
        );
        drop(held);
    }

    #[tokio::test]
    async fn broken_pdf_is_an_error_not_a_panic() {
        let error = PdfExtractor
            .extract(&source("bad.pdf"), b"%PDF-1.4\nnot really")
            .await
            .expect_err("坏文件应报错");
        assert!(
            matches!(error, KbError::InvalidInput(_) | KbError::Unavailable(_)),
            "应是可跳过 / 可重试的错误:{error}"
        );
    }
}
