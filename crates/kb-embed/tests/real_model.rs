//! 真实模型测试(验收的后半段)。
//!
//! 需要 `~/.cache/kb-models` 里已下载好的 BGE-M3 int8 模型;默认被忽略。
//! 运行:`cargo test -p kb-embed -- --ignored`

use std::path::PathBuf;
use std::time::{Duration, Instant};

use kb_core::ports::Embedder;
use kb_embed::{LoadOptions, ModelKind, spawn_fastembedder};

/// 模型目录:优先 `KB_TEST_MODELS_DIR`,否则 `~/.cache/kb-models`。
fn models_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("KB_TEST_MODELS_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME").unwrap_or_default();
    PathBuf::from(home).join(".cache/kb-models")
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm_a = a.iter().map(|v| v * v).sum::<f32>().sqrt();
    let norm_b = b.iter().map(|v| v * v).sum::<f32>().sqrt();
    dot / (norm_a * norm_b).max(f32::EPSILON)
}

#[tokio::test]
#[ignore = "需要真实 BGE-M3 模型(~/.cache/kb-models)"]
async fn bge_m3_int8_matches_the_documented_quality_and_latency() {
    let options = LoadOptions {
        max_tokens: 512,
        batch_size: 8,
        threads: 0,
        cache_dir: Some(models_dir()),
    };
    let embedder =
        spawn_fastembedder(ModelKind::BgeM3Int8, options, None).expect("启动嵌入工作线程");

    // ARCHITECTURE 设计规范(双哈希增量索引)的段落
    let related = "问题: 原设计规范仅靠单一文件 hash,文件任何改动都会整文件重嵌入,浪费算力。\
优化: 每个 chunk 保存两个哈希:content_hash(针对切块后的文本)与 meta_hash(针对元数据)。\
重索引决策表:content_hash 变则重嵌入 + 重写向量;meta_hash 变则只更新元数据、跳过 embedding;\
都不变则跳过。收益: 仅挪动文件、改权限、换行号这类高频但语义不变的改动不再触发昂贵的 embedding。";
    // 无关段落(Web 鉴权)
    let unrelated = "Web 管理界面的登录鉴权:密码用 argon2id 哈希后存 settings 表,会话令牌只存 sha256,\
写操作需要 CSRF 请求头,登录失败按 IP 限速,连续失败返回 429。";

    let docs = embedder
        .embed_documents(vec![related.to_owned(), unrelated.to_owned()])
        .await
        .expect("嵌入文档");
    assert_eq!(docs.len(), 2);
    assert_eq!(docs[0].len(), 1024, "bge-m3 的维度应为 1024");
    assert_eq!(docs[1].len(), 1024);

    let query = embedder
        .embed_query("双哈希增量索引怎么判断是否需要重新嵌入".to_owned())
        .await
        .expect("嵌入查询");
    assert_eq!(query.len(), 1024);

    let related_score = cosine(&query, &docs[0]);
    let unrelated_score = cosine(&query, &docs[1]);
    println!("设计规范相似度 = {related_score:.4},无关段落相似度 = {unrelated_score:.4}");
    assert!(
        related_score > unrelated_score,
        "设计规范段落相似度 {related_score} 应高于无关段落 {unrelated_score}"
    );

    // 查询延迟(模型已加载):取 5 次平均
    let started = Instant::now();
    for _ in 0..5 {
        embedder
            .embed_query("增量索引".to_owned())
            .await
            .expect("嵌入查询");
    }
    let average = started.elapsed() / 5;
    println!("查询平均延迟 = {average:?}");
    assert!(
        average < Duration::from_millis(100),
        "查询平均延迟 {average:?} 应小于 100ms"
    );

    assert_eq!(embedder.id(), "fastembed:bge-m3-int8");
    assert_eq!(embedder.dim(), 1024);
    assert_eq!(embedder.compat_group(), "bge-m3");
}

/// 回归:空闲卸载之后再次加载模型必须成功。
///
/// ONNX Runtime 一个进程只许建一次环境;fastembed 不传环境时每次加载都自己建,第二次加载报
/// "`environment` must be specified if using multiple models per process",嵌入器从此是 Failed,
/// 向量检索一直降级成纯关键词,直到重启。假后端的单测测不出这个,必须用真模型。
#[tokio::test]
#[ignore = "需要真实 BGE-M3 模型(~/.cache/kb-models 或 KB_TEST_MODELS_DIR)"]
async fn the_model_can_be_reloaded_after_an_idle_unload() {
    let options = LoadOptions {
        max_tokens: 512,
        batch_size: 8,
        threads: 2,
        cache_dir: Some(models_dir()),
    };
    let embedder = spawn_fastembedder(ModelKind::BgeM3Int8, options, Some(Duration::from_secs(1)))
        .expect("启动嵌入工作线程");

    let first = embedder
        .embed_query("第一次加载".to_owned())
        .await
        .expect("第一次加载并嵌入");
    assert_eq!(first.len(), 1024);
    assert_eq!(embedder.state(), kb_core::model::EmbedderState::Ready);

    // 空闲 1 秒后模型被卸载
    let deadline = Instant::now() + Duration::from_secs(15);
    while embedder.state() != kb_core::model::EmbedderState::Unloaded {
        assert!(
            Instant::now() < deadline,
            "空闲后应卸载,实际 {:?}",
            embedder.state()
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let second = embedder
        .embed_query("卸载之后再加载".to_owned())
        .await
        .expect("卸载后应能重新加载");
    assert_eq!(second.len(), 1024);
    assert_eq!(embedder.state(), kb_core::model::EmbedderState::Ready);
}
