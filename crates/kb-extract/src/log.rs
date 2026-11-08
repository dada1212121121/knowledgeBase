//! 日志文件抽取:按时间窗口分组,合并连续重复行。
//!
//! 日志检索的痛点是“同样的行刷了几百遍”,直接切块会把整个索引塞满重复内容。
//! 这里做两件事:
//! 1. **去重复**:连续相同的行只保留一次,后面跟 `(×N)`;
//! 2. **按时间窗口分组**:识别行首时间戳(`2025-10-20 10:00:01` / `10:00:01` / `[10:00:01]`),
//!    同一分钟内的行合成一个块,anchor 用 `Anchor::Time`(毫秒),这样命中后能定位到时刻。
//!
//! 识别不出时间戳就退化成“每 200 行一块”,不阻塞入库。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{Anchor, AnchoredBlock, Block, Confidence, Doc, DocMeta, SourceRef};
use kb_core::ports::Extractor;

/// 日志抽取器。
pub struct LogExtractor;

/// 一个时间窗口最多多少行(避免一分钟里几千行合成巨块)。
const MAX_LINES_PER_WINDOW: usize = 200;

#[async_trait]
impl Extractor for LogExtractor {
    fn id(&self) -> &str {
        "text/x-log"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        if head.contains(&0u8) {
            return Confidence::Unlikely;
        }
        if ext.eq_ignore_ascii_case("log") {
            return Confidence::Certain;
        }
        // 内容识别:前 20 行里有 3 行带时间戳就算日志
        let head_text = String::from_utf8_lossy(&head[..head.len().min(8192)]);
        let stamped = head_text
            .lines()
            .take(20)
            .filter(|line| timestamp_of(line).is_some())
            .count();
        if stamped >= 3 {
            Confidence::Probable
        } else {
            Confidence::Unlikely
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let text = String::from_utf8_lossy(bytes).into_owned();
        let blocks = log_blocks(&text);
        Ok(Doc {
            meta: DocMeta {
                source: source.location.clone(),
                title: None,
                lang: "text".to_owned(),
                mime: Some("text/x-log".to_owned()),
                file_hash: kb_core::hash::content_hash(&text),
                size: bytes.len() as u64,
                mtime: 0,
                project_name: source
                    .project_root
                    .as_ref()
                    .and_then(|root| root.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            },
            blocks,
        })
    }
}

/// 日志正文 → 块。
pub fn log_blocks(text: &str) -> Vec<AnchoredBlock> {
    let mut blocks = Vec::new();
    // 当前窗口:起始毫秒 + 已折叠的行
    let mut window_start: Option<u64> = None;
    let mut lines: Vec<String> = Vec::new();
    // 连续重复折叠:(行内容, 次数)
    let mut pending: Option<(String, usize)> = None;

    fn flush_pending(pending: &mut Option<(String, usize)>, lines: &mut Vec<String>) {
        if let Some((line, count)) = pending.take() {
            if count > 1 {
                lines.push(format!("{line} (×{count})"));
            } else {
                lines.push(line);
            }
        }
    }

    fn flush_window(
        window_start: &mut Option<u64>,
        lines: &mut Vec<String>,
        blocks: &mut Vec<AnchoredBlock>,
    ) {
        if lines.is_empty() {
            *window_start = None;
            return;
        }
        let body = std::mem::take(lines).join("\n");
        let anchor = match *window_start {
            Some(ms) => Anchor::Time {
                start_ms: ms,
                end_ms: ms + 60_000,
            },
            None => Anchor::Line {
                start: 1,
                end: body.lines().count().max(1) as u32,
            },
        };
        *window_start = None;
        blocks.push(AnchoredBlock {
            anchor,
            block: Block::Paragraph { text: body },
        });
    }

    for line in text.lines() {
        // 1) 连续重复行:只记次数
        if let Some((previous, count)) = pending.as_mut()
            && previous == line
        {
            *count += 1;
            continue;
        }
        flush_pending(&mut pending, &mut lines);
        pending = Some((line.to_owned(), 1));

        // 2) 跨分钟就收尾(只有能识别时间戳时才切窗口)
        if let Some(stamp) = timestamp_of(line) {
            match window_start {
                Some(start) if stamp >= start + 60_000 => {
                    flush_pending(&mut pending, &mut lines);
                    flush_window(&mut window_start, &mut lines, &mut blocks);
                    window_start = Some(stamp);
                }
                None => window_start = Some(stamp),
                _ => {}
            }
        }
        // 3) 一分钟里行太多也要切,避免巨块
        if lines.len() >= MAX_LINES_PER_WINDOW {
            flush_pending(&mut pending, &mut lines);
            flush_window(&mut window_start, &mut lines, &mut blocks);
        }
    }
    flush_pending(&mut pending, &mut lines);
    flush_window(&mut window_start, &mut lines, &mut blocks);
    blocks
}

/// 行首时间戳 → Unix 毫秒(只认常见的几种写法,认不出返回 `None`)。
pub fn timestamp_of(line: &str) -> Option<u64> {
    let line = line.trim_start_matches(['[', '(']);
    // 2025-10-20 10:00:01 / 2025-10-20T10:00:01
    // 注意:日志里常见中文紧跟时间戳,切片前必须确认字符边界(否则会切在多字节字符中间)
    if line.len() >= 19
        && line.as_bytes().get(4) == Some(&b'-')
        && matches!(line.as_bytes().get(10), Some(b' ') | Some(b'T'))
        && line.is_char_boundary(10)
        && line.is_char_boundary(11)
        && line.is_char_boundary(19)
    {
        return combine(&line[..10], &line[11..19]);
    }
    // 10:00:01(只有时间,按 1970-01-01 算)
    if line.len() >= 8 && line.as_bytes().get(2) == Some(&b':') && line.is_char_boundary(8) {
        return combine("1970-01-01", &line[..8]);
    }
    None
}

fn combine(date: &str, time: &str) -> Option<u64> {
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    let mut clock = time.split(':');
    let hour: i64 = clock.next()?.parse().ok()?;
    let minute: i64 = clock.next()?.parse().ok()?;
    let second: i64 = clock.next().unwrap_or("0").parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // 天数用“年月日 → 1970 起的天数”近似公式(日志排序够用,不做闰秒处理)
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;
    u64::try_from(seconds * 1000).ok()
}

/// Howard Hinnant 的 days_from_civil 算法。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> SourceRef {
        SourceRef {
            scheme: "file".to_owned(),
            location: "app.log".to_owned(),
            project_root: None,
        }
    }

    #[tokio::test]
    async fn repeated_lines_are_collapsed_and_windows_are_minutes() {
        let mut log = String::new();
        for _ in 0..50 {
            log.push_str("2025-10-20 10:00:01 INFO 心跳正常\n");
        }
        log.push_str("2025-10-20 10:01:30 ERROR 连接超时 host=db\n");
        log.push_str("2025-10-20 10:02:10 INFO 恢复\n");
        let doc = LogExtractor
            .extract(&source(), log.as_bytes())
            .await
            .expect("抽取");
        let text = doc.text();
        assert!(text.contains("(×50)"), "重复行应折叠:{text}");
        assert!(text.contains("连接超时"), "{text}");
        // 两个时间窗口(10:00 与 10:01/10:02 各一分钟)
        assert!(doc.blocks.len() >= 2, "{:?}", doc.blocks);
        assert!(
            doc.blocks
                .iter()
                .all(|block| matches!(block.anchor, Anchor::Time { .. })),
            "有时间戳时应使用时间锚点:{:?}",
            doc.blocks
        );
    }

    #[test]
    fn timestamps_parse_in_common_shapes() {
        assert_eq!(
            timestamp_of("2025-10-20 10:00:01 INFO x"),
            Some(1_760_954_401_000)
        );
        assert_eq!(
            timestamp_of("[2025-10-20T10:00:01] x"),
            Some(1_760_954_401_000)
        );
        assert_eq!(timestamp_of("10:00:01 x"), Some(36_001_000));
        assert_eq!(timestamp_of("no timestamp here"), None);
    }

    #[tokio::test]
    async fn without_timestamps_it_still_chunks() {
        let log = (0..500)
            .map(|index| format!("第 {index} 行日志内容"))
            .collect::<Vec<_>>()
            .join("\n");
        let doc = LogExtractor
            .extract(&source(), log.as_bytes())
            .await
            .expect("抽取");
        assert!(doc.blocks.len() >= 3, "{}", doc.blocks.len());
        assert!(matches!(doc.blocks[0].anchor, Anchor::Line { .. }));
    }

    #[test]
    fn detection_prefers_log_extension() {
        assert_eq!(LogExtractor.detect(b"x", "log"), Confidence::Certain);
        let stamped = "2025-10-20 10:00:01 a\n2025-10-20 10:00:02 b\n2025-10-20 10:00:03 c\n";
        assert_eq!(
            LogExtractor.detect(stamped.as_bytes(), "txt"),
            Confidence::Probable
        );
        assert_eq!(LogExtractor.detect(b"plain", "txt"), Confidence::Unlikely);
    }
}
