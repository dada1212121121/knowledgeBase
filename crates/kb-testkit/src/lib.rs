//! 测试辅助:临时 `KB_HOME`、注入好的适配器、fixture 语料（设计规范）。
//!
//! **只能作为 dev-dependency 使用**。`TestEnv::new` 创建一个临时目录作为 `KB_HOME`,
//! 里面是真实的 SQLite(`meta.db`)和真实的 LanceDB 目录(`lance/`),
//! 嵌入器用 [`FakeEmbedder`](kb_embed::FakeEmbedder),完全确定性、不下载模型。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use kb_core::paths::KbPaths;
use kb_core::ports::repo::MetaStore;
use kb_core::ports::{Chunker, Embedder, Scanner, VectorStore};
use kb_embed::FakeEmbedder;
pub use kb_embed::{FailingEmbedder, LazyFakeEmbedder};
use kb_index::chunk::{ChunkOptions, DefaultChunker};
use kb_index::scan::FsScanner;
use kb_meta::SqliteMetaStore;
use kb_store_lance::LanceStore;
use tempfile::TempDir;

pub mod multiuser;
pub mod pdf;
pub mod zip;

/// 测试环境:临时 KB_HOME + 注入好的三个端口实现。
pub struct TestEnv {
    home: TempDir,
    /// 真实的 SQLite 元数据存储。
    pub meta: Arc<dyn MetaStore>,
    /// 真实的 LanceDB 存储(临时目录)。
    pub store: Arc<dyn VectorStore>,
    /// 确定性假嵌入器(端口视图)。
    pub embedder: Arc<dyn Embedder>,
    /// 同一个假嵌入器的具体类型句柄,便于断言嵌入次数。
    pub fake: Arc<FakeEmbedder>,
    /// 真实的文件扫描器(`kb-index::FsScanner`)。
    pub scanner: Arc<dyn Scanner>,
    /// 默认分块器(Markdown → tree-sitter → 窗口)。
    pub chunker: Arc<dyn Chunker>,
}

impl TestEnv {
    /// 8 维假向量的测试环境。
    pub async fn new() -> Self {
        Self::with_dim(8).await
    }

    /// 指定向量维度的测试环境。
    pub async fn with_dim(dim: usize) -> Self {
        let home = tempfile::tempdir().expect("创建临时目录");
        let meta: Arc<dyn MetaStore> =
            Arc::new(SqliteMetaStore::open(home.path().join("meta.db")).expect("打开 meta.db"));
        let store: Arc<dyn VectorStore> = Arc::new(
            LanceStore::connect(home.path().join("lance").to_string_lossy().to_string())
                .await
                .expect("连接 LanceDB"),
        );
        let fake = Arc::new(FakeEmbedder::new(dim));
        let embedder: Arc<dyn Embedder> = fake.clone();
        let scanner: Arc<dyn Scanner> = Arc::new(FsScanner);
        let chunker: Arc<dyn Chunker> = Arc::new(DefaultChunker::new(ChunkOptions::default()));
        Self {
            home,
            meta,
            store,
            embedder,
            fake,
            scanner,
            chunker,
        }
    }

    /// 临时 `KB_HOME`。
    pub fn home(&self) -> &Path {
        self.home.path()
    }

    /// 与临时目录对应的 [`KbPaths`]。
    pub fn paths(&self) -> KbPaths {
        KbPaths::from_home(self.home.path())
    }

    /// LanceDB 目录。
    pub fn lance_dir(&self) -> PathBuf {
        self.home.path().join("lance")
    }

    /// 物理表是否存在(通过 `count` 是否返回 `NotFound` 判断)。
    pub async fn table_exists(&self, table: &str) -> bool {
        self.store.count(table, None).await.is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_env_provides_working_adapters() {
        let env = TestEnv::new().await;
        assert!(env.home().join("meta.db").exists(), "meta.db 应已创建");
        assert!(env.lance_dir().exists(), "lance 目录应已创建");
        assert_eq!(env.embedder.dim(), 8);
        assert_eq!(env.embedder.id(), "fake:8");
        assert_eq!(env.paths().home(), env.home());
        // 端口可用
        let vectors = env
            .embedder
            .embed_documents(vec!["测试文本".to_owned()])
            .await
            .expect("嵌入");
        assert_eq!(vectors.len(), 1);
        assert_eq!(vectors[0].len(), 8);
    }
}
