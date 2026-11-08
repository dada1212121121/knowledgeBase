//! Markdown 分块器的复杂度验收。
//!
//! 改造前,分块耗时随输入变大增长得比线性快(debug 实测):每两行一个标题的 512KB 文档 17.6 秒,
//! 单个 128KB 围栏代码块 8.8 秒,128KB 重复同名标题 6.55 秒。2 MiB 的文档上限放宽后,
//! 这样的病态输入会让唯一的写 worker 卡住几分钟(而且分块是在 async 函数里同步调用的)。
//!
//! 这里只设「粗界」:界宽到在负载很高的共享机器上也不会抖,但又远低于改造前的耗时,
//! 二次复杂度一旦回来就会红。另有一条「输入翻倍,耗时应约翻倍(4 倍以内)」的增长倍数检查,
//! 它不依赖机器快慢,抓的是复杂度阶数本身。
//!
//! 计时口径:优先量**当前线程的 CPU 时间**(Linux 读 `/proc/thread-self/stat`),读不到才退回墙钟。
//! 原因:这台共享机器上常有别的进程在编译,墙钟会被拉长到真实耗时的两三倍(实测一轮用户态 CPU 只有
//! 1.5 分钟,墙钟却是 3.8 分钟),按墙钟设界就成了抖动用例;CPU 时间不受别人抢占的影响。
//!
//! 输出是否逐字节不变由 `markdown_equivalence.rs` 负责,这里只量时间。
//! 本文件单独成一个测试二进制:不与对拍用例的大量并行计算抢 CPU,计时才可信。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use kb_core::model::SourceDoc;
use kb_core::ports::Chunker;
use kb_index::chunk::{ChunkOptions, MarkdownChunker};

const KB: usize = 1024;

/// 计时用例互相串行:`cargo test` 默认并行跑多个 `#[test]`,并行会把每个用例的耗时都拉长。
static SERIAL: Mutex<()> = Mutex::new(());

fn doc(text: String) -> SourceDoc {
    SourceDoc {
        source: "docs/guide.md".to_owned(),
        lang: "markdown".to_owned(),
        size: text.len() as u64,
        text,
        file_hash: "h".to_owned(),
        mtime: 0,
        project_name: "demo".to_owned(),
    }
}

/// 每两行一个标题,标题互不相同(验收基线:512KB 约 2.1 万块)。
fn heading_every_two_lines(bytes: usize) -> String {
    let mut text = String::with_capacity(bytes + 32);
    let mut index = 0usize;
    while text.len() < bytes {
        text.push_str(&format!("# 标题{index}\n正文{index}\n"));
        index += 1;
    }
    text
}

/// 一个巨大的围栏代码块:整段都在 `in_code` 里,`current` 会一路长成整个代码块。
fn single_fence(bytes: usize) -> String {
    let mut text = String::with_capacity(bytes + 64);
    text.push_str("# 代码\n\n```text\n");
    let mut index = 0usize;
    while text.len() < bytes {
        text.push_str(&format!("let value_{index} = {index};\n"));
        index += 1;
    }
    text.push_str("```\n");
    text
}

/// 重复同名标题:每个标题的 key 都要加后缀。
fn repeated_title(bytes: usize) -> String {
    let mut text = String::with_capacity(bytes + 32);
    while text.len() < bytes {
        text.push_str("# 示例\n正文\n");
    }
    text
}

/// 无标题 + 大量小围栏代码块:一个小节里有上万个代码块区间。
fn many_small_fences(bytes: usize) -> String {
    let mut text = String::with_capacity(bytes + 32);
    let mut index = 0usize;
    while text.len() < bytes {
        text.push_str(&format!("```\nc{index}\n```\n\n"));
        index += 1;
    }
    text
}

/// 无标题的 ASCII 超长单行:整份文档是一个超预算小节,走窗口兜底里的 `split_long_line`。
fn long_ascii_line(bytes: usize) -> String {
    "abcdefgh".repeat(bytes / 8) + "\n"
}

/// 无标题的 CJK 超长单行(每字符 3 字节,按字节数折算字符数)。
fn long_cjk_line(bytes: usize) -> String {
    "增量索引".repeat(bytes / 12) + "\n"
}

/// 标题里夹一大段空白:空白不算 token,header 截断永远不会提前停,要把整个标题扫完。
fn whitespace_heading(bytes: usize) -> String {
    format!("# a{}b\n\n正文\n", " ".repeat(bytes))
}

/// 当前线程已用的 CPU 时间(用户态 + 内核态)。只在 Linux 上可用;
/// `/proc/<tid>/stat` 的 utime / stime 以 USER_HZ(Linux 上恒为 100)为单位,精度 10ms,
/// 对秒级的界足够,倍数检查另有 50ms 的分母下限。
fn thread_cpu_time() -> Option<Duration> {
    let stat = std::fs::read_to_string("/proc/thread-self/stat").ok()?;
    // 第 2 个字段是括号包起来的进程名,里面可能有空格和括号,所以从最后一个 `)` 往后切;
    // 切开后第 0 项是第 3 个字段(state),utime / stime 是第 14 / 15 个字段,即下标 11 / 12
    let rest = stat.get(stat.rfind(')')? + 1..)?;
    let mut fields = rest.split_whitespace();
    let utime: u64 = fields.nth(11)?.parse().ok()?;
    let stime: u64 = fields.next()?.parse().ok()?;
    Some(Duration::from_millis((utime + stime) * 10))
}

/// 一次分块的耗时与块数。
struct Timing {
    /// 用来和界比较的耗时:有线程 CPU 时间用它,否则用墙钟。
    elapsed: Duration,
    /// 墙钟,只用于打印,方便看出机器当时是不是很忙。
    wall: Duration,
    chunks: usize,
}

/// 跑一次分块并计时。
fn run_once(text: &str) -> Timing {
    let doc = doc(text.to_owned());
    let chunker = MarkdownChunker::new(ChunkOptions::default());
    let cpu_before = thread_cpu_time();
    let start = Instant::now();
    let chunks = chunker.chunk(&doc);
    let wall = start.elapsed();
    let elapsed = match (cpu_before, thread_cpu_time()) {
        (Some(before), Some(after)) => after.saturating_sub(before),
        _ => wall,
    };
    Timing {
        elapsed,
        wall,
        chunks: chunks.len(),
    }
}

/// 取两次里较快的一次,滤掉缓存冷热和偶发毛刺;
/// 第一次就超过 3 秒的(复杂度已经出问题)不再重复,免得失败时白等。
fn best_of_two(text: &str) -> Timing {
    let first = run_once(text);
    if first.elapsed > Duration::from_secs(3) {
        return first;
    }
    let second = run_once(text);
    if second.elapsed < first.elapsed {
        second
    } else {
        first
    }
}

fn report(name: &str, bytes: usize, timing: &Timing) {
    eprintln!(
        "[perf] {name}: {} KB → {} 块,耗时 {:.3} 秒(CPU 口径;墙钟 {:.3} 秒)",
        bytes / KB,
        timing.chunks,
        timing.elapsed.as_secs_f64(),
        timing.wall.as_secs_f64()
    );
}

/// 粗界用例的公共体:块数用来确认文档真的被切成了预期的形状,而不是提前返回的平凡结果。
fn assert_under(name: &str, text: &str, limit: Duration, min_chunks: usize) {
    let _guard = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let timing = best_of_two(text);
    report(name, text.len(), &timing);
    assert!(
        timing.chunks >= min_chunks,
        "{name}:块数 {} 少于预期的 {min_chunks},文档形状不对",
        timing.chunks
    );
    assert!(
        timing.elapsed < limit,
        "{name}:耗时 {:.3} 秒,超过粗界 {:.1} 秒(二次复杂度回来了?)",
        timing.elapsed.as_secs_f64(),
        limit.as_secs_f64()
    );
}

#[test]
fn heading_every_two_lines_512kb_stays_under_3s() {
    // 改造前 17.6 秒
    let text = heading_every_two_lines(512 * KB);
    assert_under("每两行一个标题", &text, Duration::from_secs(3), 20_000);
}

#[test]
fn single_fenced_block_128kb_stays_under_2s() {
    // 改造前 8.8 秒
    let text = single_fence(128 * KB);
    assert_under("单个巨大围栏块", &text, Duration::from_secs(2), 100);
}

#[test]
fn repeated_title_128kb_stays_under_3s() {
    // 改造前 6.55 秒
    let text = repeated_title(128 * KB);
    assert_under("重复同名标题", &text, Duration::from_secs(3), 5_000);
}

#[test]
fn many_small_fences_512kb_stays_under_3s() {
    // 改造前 512KB 约 13.5 秒
    let text = many_small_fences(512 * KB);
    assert_under("大量小围栏", &text, Duration::from_secs(3), 100);
}

#[test]
fn long_ascii_single_line_256kb_stays_under_3s() {
    let text = long_ascii_line(256 * KB);
    assert_under("ASCII 超长单行", &text, Duration::from_secs(3), 100);
}

#[test]
fn long_cjk_single_line_256kb_stays_under_3s() {
    let text = long_cjk_line(256 * KB);
    assert_under("CJK 超长单行", &text, Duration::from_secs(3), 100);
}

#[test]
fn whitespace_heavy_heading_64kb_stays_under_2s() {
    let text = whitespace_heading(64 * KB);
    assert_under("全是空白的超长标题", &text, Duration::from_secs(2), 1);
}

/// 输入翻倍,耗时应约翻倍:取 4 倍以内的宽松界。分母给 50ms 的下限,
/// 免得第一档快到几毫秒时,计时分辨率和调度噪声把倍数放大成假红。
#[test]
fn doubling_the_input_roughly_doubles_the_time() {
    let _guard = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    type Shape = (&'static str, fn(usize) -> String, [usize; 3]);
    let shapes: [Shape; 7] = [
        ("每两行一个标题", heading_every_two_lines, [128, 256, 512]),
        ("单个巨大围栏块", single_fence, [64, 128, 256]),
        ("重复同名标题", repeated_title, [64, 128, 256]),
        ("大量小围栏", many_small_fences, [128, 256, 512]),
        ("ASCII 超长单行", long_ascii_line, [64, 128, 256]),
        ("CJK 超长单行", long_cjk_line, [64, 128, 256]),
        ("全是空白的超长标题", whitespace_heading, [16, 32, 64]),
    ];
    let floor = Duration::from_millis(50);
    for (name, build, sizes) in shapes {
        let mut previous: Option<(usize, Duration)> = None;
        for kb in sizes {
            let text = build(kb * KB);
            let timing = best_of_two(&text);
            report(name, text.len(), &timing);
            let elapsed = timing.elapsed;
            if let Some((prev_kb, prev_elapsed)) = previous {
                let ratio = elapsed.as_secs_f64() / prev_elapsed.max(floor).as_secs_f64();
                eprintln!("[perf] {name}: {prev_kb} KB → {kb} KB,倍数 {ratio:.2}");
                assert!(
                    ratio < 4.0,
                    "{name}:输入从 {prev_kb} KB 翻到 {kb} KB,耗时 {:.3} 秒 → {:.3} 秒(倍数 {ratio:.2} ≥ 4),不是线性增长",
                    prev_elapsed.as_secs_f64(),
                    elapsed.as_secs_f64()
                );
            }
            previous = Some((kb, elapsed));
        }
    }
}
