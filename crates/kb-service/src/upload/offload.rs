//! 把 CPU / 磁盘密集的同步活挪出异步工作线程。
//!
//! 上传解析是在异步任务里跑的:整文件 `std::fs::read`、同步解压 zip、逐文件算哈希、
//! OOXML 抽取里的同步 zip 解析,这些都会把一个异步工作线程占住几秒到几十秒,
//! 同一个线程上排队的请求(检索、保存、协作)跟着变慢。这里统一放进阻塞线程池。

use std::path::Path;
use std::sync::Arc;

use kb_core::model::{Doc, SourceRef};
use kb_core::ports::Extractor;
use kb_core::{KbError, Result};

/// 在阻塞线程池里跑一段同步代码;线程里 panic 也会变成错误,而不是带走调用方。
pub(crate) async fn blocking<T, F>(work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|err| KbError::Internal(format!("后台任务异常退出: {err}")))
}

/// 读整个文件(阻塞线程池里读)。
pub(crate) async fn read_file(path: &Path) -> Result<Vec<u8>> {
    let owned = path.to_path_buf();
    blocking(move || {
        std::fs::read(&owned)
            .map_err(|err| KbError::Internal(format!("读取 {} 失败: {err}", owned.display())))
    })
    .await?
}

/// 只读文件开头几个字节,判断它是不是 zip(嵌套压缩包的判断不需要把整个文件读进内存)。
pub(crate) fn file_starts_with_zip_magic(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 4];
    match std::fs::File::open(path).and_then(|mut file| file.read(&mut head)) {
        Ok(read) => crate::upload::unpack::looks_like_zip(&head[..read]),
        Err(_) => false,
    }
}

/// 抽取一份文档,整个过程放在阻塞线程池里跑。
///
/// 抽取器的接口是异步的,但办公文档的抽取主体是同步的 zip / XML 解析,直接 `.await` 会占住异步工作线程。
/// 这里在阻塞线程里用运行时句柄驱动这个 future:线程池里的线程不是异步工作线程,占它不影响别的请求。
/// 抽取器内部再 `spawn_blocking`(比如 PDF)照常可用。
pub(crate) async fn extract_off_runtime(
    extractor: Arc<dyn Extractor>,
    source: SourceRef,
    bytes: Vec<u8>,
) -> Result<Extracted> {
    let handle = tokio::runtime::Handle::current();
    blocking(move || {
        // 内容哈希和大小趁字节还在手里一并算好:调用方拿到抽取结果后不再需要原始字节,
        // 也就不用为了算哈希把整个文件多留一份(或克隆一份)
        let file_hash = crate::index::pipeline::file_hash(&bytes);
        let size = bytes.len() as u64;
        handle
            .block_on(extractor.extract(&source, &bytes))
            .map(|doc| Extracted {
                doc,
                file_hash,
                size,
            })
    })
    .await?
}

/// 一次抽取的结果:中间文档,加原始字节的内容哈希与大小。
#[derive(Debug)]
pub(crate) struct Extracted {
    pub doc: Doc,
    pub file_hash: String,
    pub size: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use kb_core::model::{Confidence, DocMeta};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    /// 同步睡一会儿(模拟 CPU 密集的同步解析);`boom` 时直接 panic。
    struct SlowExtractor {
        sleep: Duration,
        boom: bool,
    }

    #[async_trait]
    impl Extractor for SlowExtractor {
        fn id(&self) -> &str {
            "slow"
        }
        fn detect(&self, _head: &[u8], _ext: &str) -> Confidence {
            Confidence::Certain
        }
        async fn extract(&self, source: &SourceRef, _bytes: &[u8]) -> Result<Doc> {
            std::thread::sleep(self.sleep);
            if self.boom {
                panic!("抽取器内部 panic(测试)");
            }
            Ok(Doc {
                meta: DocMeta {
                    source: source.location.clone(),
                    title: None,
                    lang: "zh".to_owned(),
                    mime: None,
                    file_hash: String::new(),
                    size: 0,
                    mtime: 0,
                    project_name: String::new(),
                },
                blocks: Vec::new(),
            })
        }
    }

    fn source() -> SourceRef {
        SourceRef {
            scheme: "file".to_owned(),
            location: "a.docx".to_owned(),
            project_root: None,
        }
    }

    /// 每 10 毫秒加一的节拍器;返回计数器和任务句柄。
    fn start_ticker() -> (Arc<AtomicU64>, tokio::task::JoinHandle<()>) {
        let ticks = Arc::new(AtomicU64::new(0));
        let counter = ticks.clone();
        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(10)).await;
                counter.fetch_add(1, Ordering::SeqCst);
            }
        });
        (ticks, handle)
    }

    /// 单线程运行时上:抽取放进阻塞线程池后,同一个运行时上的别的任务照常推进。
    #[tokio::test(flavor = "current_thread")]
    async fn extraction_does_not_starve_the_async_runtime() {
        let (ticks, ticker) = start_ticker();
        tokio::task::yield_now().await;
        let extractor: Arc<dyn Extractor> = Arc::new(SlowExtractor {
            sleep: Duration::from_millis(400),
            boom: false,
        });
        let extracted = extract_off_runtime(extractor, source(), b"hello".to_vec())
            .await
            .expect("抽取");
        assert_eq!(extracted.doc.meta.source, "a.docx");
        assert_eq!(extracted.size, 5);
        assert_eq!(
            extracted.file_hash,
            crate::index::pipeline::file_hash(b"hello")
        );
        let progressed = ticks.load(Ordering::SeqCst);
        ticker.abort();
        assert!(
            progressed >= 20,
            "抽取 400 毫秒期间节拍器应推进二三十次,实际 {progressed}"
        );
    }

    /// 对照:直接在异步任务里 `.await` 同样的抽取器,节拍器几乎不动,说明上面的断言确实在量「有没有被占住」。
    #[tokio::test(flavor = "current_thread")]
    async fn control_inline_extraction_does_starve_the_runtime() {
        let (ticks, ticker) = start_ticker();
        tokio::task::yield_now().await;
        let extractor = SlowExtractor {
            sleep: Duration::from_millis(400),
            boom: false,
        };
        extractor.extract(&source(), &[]).await.expect("直接抽取");
        let progressed = ticks.load(Ordering::SeqCst);
        ticker.abort();
        assert!(
            progressed < 5,
            "直接 await 时同一线程上的任务应被占住,实际推进了 {progressed} 次"
        );
    }

    /// 抽取器 panic(畸形文档常见)变成错误,交给上层隔离,不能带走整个任务。
    #[tokio::test]
    async fn a_panicking_extractor_becomes_an_error() {
        let extractor: Arc<dyn Extractor> = Arc::new(SlowExtractor {
            sleep: Duration::from_millis(1),
            boom: true,
        });
        let err = extract_off_runtime(extractor, source(), Vec::new())
            .await
            .expect_err("panic 应变成错误");
        assert!(matches!(err, KbError::Internal(_)), "{err:?}");
    }

    #[tokio::test]
    async fn read_file_returns_bytes_and_names_the_path_on_failure() {
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join("a.bin");
        std::fs::write(&path, b"hello").expect("写");
        assert_eq!(read_file(&path).await.expect("读"), b"hello");

        let missing = dir.path().join("missing.bin");
        let err = read_file(&missing).await.expect_err("不存在的文件");
        assert!(err.to_string().contains("missing.bin"), "{err}");
    }

    #[test]
    fn zip_magic_is_read_from_the_first_bytes_only() {
        let dir = tempfile::tempdir().expect("临时目录");
        let zip = dir.path().join("a.zip");
        std::fs::write(&zip, b"PK\x03\x04rest-of-the-archive").expect("写");
        assert!(file_starts_with_zip_magic(&zip));
        let empty_zip = dir.path().join("empty.zip");
        std::fs::write(&empty_zip, b"PK\x05\x06").expect("写");
        assert!(file_starts_with_zip_magic(&empty_zip));
        let text = dir.path().join("a.txt");
        std::fs::write(&text, b"just text").expect("写");
        assert!(!file_starts_with_zip_magic(&text));
        let short = dir.path().join("short");
        std::fs::write(&short, b"PK").expect("写");
        assert!(!file_starts_with_zip_magic(&short));
        assert!(!file_starts_with_zip_magic(&dir.path().join("nope")));
    }
}
