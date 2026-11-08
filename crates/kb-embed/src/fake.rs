//! 测试用的确定性嵌入器(**只在 `testkit` feature 下编译**)。
//!
//! 做法:把文本切成词元(ASCII 标识符 + 中文 2-gram),每个词元哈希到 `dim` 维中的
//! 一维并累加,最后做 L2 归一化。相同词越多,余弦相似度越高;完全不依赖模型。

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use kb_core::model::EmbedderState;
use kb_core::ports::Embedder;
use kb_core::{KbError, Result};
use xxhash_rust::xxh3::xxh3_64;

/// 确定性的假嵌入器。
pub struct FakeEmbedder {
    dim: usize,
    id: String,
    counter: Arc<AtomicUsize>,
}

impl std::fmt::Debug for FakeEmbedder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeEmbedder")
            .field("dim", &self.dim)
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl FakeEmbedder {
    /// 维度为 `dim` 的假嵌入器,id 形如 `fake:8`。
    pub fn new(dim: usize) -> Self {
        Self::with_id(dim, format!("fake:{dim}"))
    }

    /// 指定 id 的假嵌入器(测试多个 collection 时用)。
    pub fn with_id(dim: usize, id: impl Into<String>) -> Self {
        Self {
            dim: dim.max(1),
            id: id.into(),
            counter: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// 已经嵌入过的文本条数(用它断言增量索引没有重复嵌入)。
    pub fn embedding_count(&self) -> usize {
        self.counter.load(Ordering::SeqCst)
    }

    /// 计数归零。
    pub fn reset_count(&self) {
        self.counter.store(0, Ordering::SeqCst);
    }

    /// 把一段文本映射成向量。
    pub fn vector(&self, text: &str) -> Vec<f32> {
        let mut values = vec![0f32; self.dim];
        for token in tokens(text) {
            let index = (xxh3_64(token.as_bytes()) % self.dim as u64) as usize;
            values[index] += 1.0;
        }
        normalize(&mut values);
        values
    }
}

#[async_trait]
impl Embedder for FakeEmbedder {
    fn id(&self) -> &str {
        &self.id
    }

    fn dim(&self) -> usize {
        self.dim
    }

    fn compat_group(&self) -> &str {
        "fake"
    }

    async fn embed_documents(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        self.counter.fetch_add(texts.len(), Ordering::SeqCst);
        Ok(texts.iter().map(|text| self.vector(text)).collect())
    }

    async fn embed_query(&self, text: String) -> Result<Vec<f32>> {
        if text.trim().is_empty() {
            return Err(KbError::InvalidInput("查询文本不能为空".to_owned()));
        }
        self.counter.fetch_add(1, Ordering::SeqCst);
        Ok(self.vector(&text))
    }

    fn state(&self) -> EmbedderState {
        EmbedderState::Ready
    }
}

/// 词元:ASCII 标识符(已小写去重)+ 中文 2-gram。
fn tokens(text: &str) -> Vec<String> {
    let mut tokens = kb_core::text::split_identifiers(text);
    let cjk: Vec<char> = text
        .chars()
        .filter(|ch| kb_core::text::is_cjk(*ch))
        .collect();
    if cjk.len() == 1 {
        tokens.push(cjk[0].to_string());
    }
    for window in cjk.windows(2) {
        tokens.push(window.iter().collect());
    }
    tokens
}

fn normalize(values: &mut [f32]) {
    let norm = values.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in values.iter_mut() {
            *value /= norm;
        }
    } else if let Some(first) = values.first_mut() {
        // 空文本:给一个确定的单位向量,避免零向量
        *first = 1.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cosine(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    #[tokio::test]
    async fn vectors_are_deterministic_and_normalized() {
        let embedder = FakeEmbedder::new(32);
        let a = embedder
            .embed_query("增量索引 embedQuery".to_owned())
            .await
            .expect("嵌入");
        let b = embedder
            .embed_query("增量索引 embedQuery".to_owned())
            .await
            .expect("嵌入");
        assert_eq!(a, b, "相同文本必须得到相同向量");
        assert_eq!(a.len(), 32);
        let norm = a.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5, "向量应已归一化,实际 {norm}");
    }

    #[tokio::test]
    async fn shared_words_raise_similarity() {
        let embedder = FakeEmbedder::new(64);
        let query = embedder
            .embed_query("双哈希增量索引 减少重复嵌入".to_owned())
            .await
            .expect("查询");
        let related = embedder
            .embed_documents(vec!["双哈希增量索引只更新元数据,减少重复嵌入".to_owned()])
            .await
            .expect("文档")
            .remove(0);
        let unrelated = embedder
            .embed_documents(vec!["Web 管理界面的登录鉴权与 CSRF 防护".to_owned()])
            .await
            .expect("文档")
            .remove(0);
        let related_score = cosine(&query, &related);
        let unrelated_score = cosine(&query, &unrelated);
        assert!(
            related_score > unrelated_score,
            "相关文本相似度 {related_score} 应高于无关文本 {unrelated_score}"
        );
        assert!(related_score > 0.2, "相关文本相似度应明显大于 0");
    }

    #[tokio::test]
    async fn counter_tracks_embedded_texts() {
        let embedder = FakeEmbedder::new(8);
        assert_eq!(embedder.embedding_count(), 0);
        embedder
            .embed_documents(vec!["a".to_owned(), "b".to_owned()])
            .await
            .expect("批量");
        assert_eq!(embedder.embedding_count(), 2);
        embedder.embed_query("c".to_owned()).await.expect("查询");
        assert_eq!(embedder.embedding_count(), 3);
        embedder.reset_count();
        assert_eq!(embedder.embedding_count(), 0);
    }

    #[tokio::test]
    async fn metadata_is_stable() {
        let embedder = FakeEmbedder::new(8);
        assert_eq!(embedder.id(), "fake:8");
        assert_eq!(embedder.dim(), 8);
        assert_eq!(embedder.compat_group(), "fake");
        assert_eq!(embedder.state(), EmbedderState::Ready);
        assert!(embedder.embed_query("   ".to_owned()).await.is_err());
        let custom = FakeEmbedder::with_id(16, "fake:custom");
        assert_eq!(custom.id(), "fake:custom");
        assert_eq!(custom.dim(), 16);
    }

    #[test]
    fn empty_text_is_not_a_zero_vector() {
        let embedder = FakeEmbedder::new(8);
        let vector = embedder.vector("");
        assert_eq!(vector.len(), 8);
        assert!(vector.iter().any(|value| *value != 0.0));
    }
}

/// 惰性加载的假嵌入器:第一次 `embed_*` 之前 `state` 返回 `Unloaded`,之后 `Ready`。
///
/// 用来复现真实 `FastEmbedder` 的“不触发加载就永远不 Ready”行为。
pub struct LazyFakeEmbedder {
    inner: FakeEmbedder,
    loaded: Arc<std::sync::atomic::AtomicBool>,
}

impl std::fmt::Debug for LazyFakeEmbedder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LazyFakeEmbedder").finish_non_exhaustive()
    }
}

impl LazyFakeEmbedder {
    /// 维度为 `dim` 的惰性假嵌入器,id 形如 `fake-lazy:8`。
    pub fn new(dim: usize) -> Self {
        Self {
            inner: FakeEmbedder::with_id(dim, format!("fake-lazy:{dim}")),
            loaded: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    fn mark_loaded(&self) {
        self.loaded.store(true, Ordering::SeqCst);
    }
}

#[async_trait]
impl Embedder for LazyFakeEmbedder {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn dim(&self) -> usize {
        self.inner.dim()
    }

    fn compat_group(&self) -> &str {
        self.inner.compat_group()
    }

    async fn embed_documents(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        self.mark_loaded();
        self.inner.embed_documents(texts).await
    }

    async fn embed_query(&self, text: String) -> Result<Vec<f32>> {
        self.mark_loaded();
        self.inner.embed_query(text).await
    }

    fn state(&self) -> EmbedderState {
        if self.loaded.load(Ordering::SeqCst) {
            EmbedderState::Ready
        } else {
            EmbedderState::Unloaded
        }
    }
}

/// 永远失败的假嵌入器(测试 `embedder_unavailable` 降级)。
#[derive(Debug, Default)]
pub struct FailingEmbedder;

#[async_trait]
impl Embedder for FailingEmbedder {
    fn id(&self) -> &str {
        "fake-failing:8"
    }

    fn dim(&self) -> usize {
        8
    }

    fn compat_group(&self) -> &str {
        "fake-failing"
    }

    async fn embed_documents(&self, _texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        Err(KbError::Unavailable("假嵌入器按测试要求失败".to_owned()))
    }

    async fn embed_query(&self, _text: String) -> Result<Vec<f32>> {
        Err(KbError::Unavailable("假嵌入器按测试要求失败".to_owned()))
    }

    fn state(&self) -> EmbedderState {
        EmbedderState::Failed("假嵌入器按测试要求失败".to_owned())
    }
}
