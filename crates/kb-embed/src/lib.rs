//! Embedder / Reranker 实现（设计规范）。
//!
//! - [`fastembed_worker`]:专用线程 + 查询优先 + 空闲卸载的 fastembed 封装;
//! - [`models`]:模型清单(维度、兼容组、前缀)与 fastembed 后端;
//! - [`fake`](FakeEmbedder):确定性假嵌入器,只在 `testkit` feature 下导出。

pub mod fastembed_worker;
pub mod http_embedder;
pub mod http_reranker;
pub mod models;
pub mod sidecar;

#[cfg(feature = "testkit")]
pub mod fake;

pub use fastembed_worker::{EmbedBackend, EmbedMode, EmbedWorker, spawn_fastembedder};
pub use models::{FastEmbedBackend, LoadOptions, ModelKind};

#[cfg(feature = "testkit")]
pub use fake::{FailingEmbedder, FakeEmbedder, LazyFakeEmbedder};

pub use http_embedder::HttpEmbedder;
pub use http_reranker::HttpReranker;
pub use sidecar::{Sidecar, SidecarPair, SidecarRole, SidecarSpec};
