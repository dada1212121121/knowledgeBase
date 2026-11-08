//! 模型清单与 fastembed 后端（设计规范）。
//!
//! - `bge-m3-int8`:`Bgem3Embedding` + `Bgem3Model::BGEM3Q`,只取 dense 输出;
//! - `bge-m3`:`TextEmbedding` + `EmbeddingModel::BGEM3`;
//! - `multilingual-minilm`:`EmbeddingModel::ParaphraseMLMiniLML12V2`;
//! - `multilingual-e5-base`:`EmbeddingModel::MultilingualE5Base`(查询加 `query: `,
//!   文档加 `passage: ` 前缀)。

use std::path::PathBuf;

use fastembed::{
    Bgem3Embedding, Bgem3InitOptions, Bgem3Model, EmbeddingModel, TextEmbedding, TextInitOptions,
};
use kb_core::config::EmbedConfig;
use kb_core::{KbError, Result};

use crate::fastembed_worker::{EmbedBackend, EmbedMode};

/// 支持的嵌入模型。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelKind {
    /// `bge-m3-int8`(默认,570MB)。
    BgeM3Int8,
    /// `bge-m3`(fp32,2.27GB)。
    BgeM3,
    /// `multilingual-minilm`。
    MultilingualMiniLm,
    /// `multilingual-e5-base`。
    MultilingualE5Base,
}

impl ModelKind {
    /// 按配置里的名字解析。
    pub fn from_name(name: &str) -> Result<Self> {
        match name {
            "bge-m3-int8" => Ok(Self::BgeM3Int8),
            "bge-m3" => Ok(Self::BgeM3),
            "multilingual-minilm" => Ok(Self::MultilingualMiniLm),
            "multilingual-e5-base" => Ok(Self::MultilingualE5Base),
            other => Err(KbError::InvalidInput(format!(
                "未知的 embed.model {other:?}:只支持 bge-m3-int8 / bge-m3 / multilingual-minilm / multilingual-e5-base"
            ))),
        }
    }

    /// 向量维度。
    pub fn dim(self) -> usize {
        match self {
            Self::BgeM3Int8 | Self::BgeM3 => 1024,
            Self::MultilingualMiniLm => 384,
            Self::MultilingualE5Base => 768,
        }
    }

    /// 兼容组:同组切换可以免迁移。
    pub fn compat_group(self) -> &'static str {
        match self {
            Self::BgeM3Int8 | Self::BgeM3 => "bge-m3",
            Self::MultilingualMiniLm => "minilm",
            Self::MultilingualE5Base => "e5",
        }
    }

    /// 写进 `collections.embedder_id` 的标识。
    pub fn embedder_id(self) -> String {
        let name = match self {
            Self::BgeM3Int8 => "bge-m3-int8",
            Self::BgeM3 => "bge-m3",
            Self::MultilingualMiniLm => "multilingual-minilm",
            Self::MultilingualE5Base => "multilingual-e5-base",
        };
        format!("fastembed:{name}")
    }

    /// 查询前缀(e5 需要,其余为空)。
    pub fn query_prefix(self) -> &'static str {
        match self {
            Self::MultilingualE5Base => "query: ",
            _ => "",
        }
    }

    /// 文档前缀(e5 需要,其余为空)。
    pub fn passage_prefix(self) -> &'static str {
        match self {
            Self::MultilingualE5Base => "passage: ",
            _ => "",
        }
    }
}

/// 加载参数。
#[derive(Clone, Debug)]
pub struct LoadOptions {
    /// 单条文本的 token 上限。
    pub max_tokens: usize,
    /// 每次 `embed` 的批大小。
    pub batch_size: usize,
    /// ONNX 线程数,0 = 自动。
    pub threads: usize,
    /// 模型缓存目录;`None` 时用 `FASTEMBED_CACHE_DIR` / 默认目录。
    pub cache_dir: Option<PathBuf>,
}

impl LoadOptions {
    /// 从配置构造(`paths.models_dir` 由调用方传入)。
    pub fn from_config(config: &EmbedConfig, models_dir: Option<PathBuf>) -> Self {
        Self {
            max_tokens: config.max_tokens,
            batch_size: config.batch_size.clamp(1, 64),
            threads: config.threads,
            cache_dir: models_dir,
        }
    }
}

/// 进程里唯一的 ONNX 运行环境。
///
/// ONNX Runtime 一个进程只允许建一次环境(建过之后即使释放了也不能再建)。fastembed 不传环境时每次
/// 加载模型都会自己建一个,所以第一次加载没问题,**空闲卸载后第二次加载必然报
/// "`environment` must be specified if using multiple models per process"**,向量检索从此一直降级成
/// 纯关键词,直到重启进程。这里建一次、一直持有,每次加载都传同一个。
fn shared_environment() -> std::result::Result<ort::environment::Environment, String> {
    static ENV: std::sync::Mutex<Option<ort::environment::Environment>> =
        std::sync::Mutex::new(None);
    let mut slot = ENV.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some(env) = slot.as_ref() {
        return Ok(env.clone());
    }
    let env = ort::init()
        .build()
        .map_err(|err| format!("初始化 ONNX 运行环境失败: {err}"))?;
    *slot = Some(env.clone());
    Ok(env)
}

/// 真正持有 ONNX 会话的 fastembed 后端。
pub struct FastEmbedBackend {
    kind: ModelKind,
    model: Loaded,
    batch_size: usize,
}

enum Loaded {
    BgeM3(Box<Bgem3Embedding>),
    Text(Box<TextEmbedding>),
}

impl std::fmt::Debug for FastEmbedBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FastEmbedBackend")
            .field("kind", &self.kind)
            .field("batch_size", &self.batch_size)
            .finish_non_exhaustive()
    }
}

impl FastEmbedBackend {
    /// 加载模型(首次会下载到缓存目录)。
    pub fn load(kind: ModelKind, options: &LoadOptions) -> Result<Self> {
        let max_length = options.max_tokens.max(1);
        let batch_size = options.batch_size.clamp(1, 64);
        let environment = shared_environment().map_err(KbError::Unavailable)?;
        let model = match kind {
            ModelKind::BgeM3Int8 => {
                let mut init = Bgem3InitOptions::new(Bgem3Model::BGEM3Q)
                    .with_max_length(max_length)
                    .with_environment(environment)
                    .with_show_download_progress(false);
                if let Some(dir) = &options.cache_dir {
                    init = init.with_cache_dir(dir.clone());
                }
                if options.threads > 0 {
                    init = init.with_intra_threads(options.threads);
                }
                let embedding = Bgem3Embedding::try_new(init)
                    .map_err(|err| KbError::Unavailable(format!("加载 bge-m3-int8 失败: {err}")))?;
                Loaded::BgeM3(Box::new(embedding))
            }
            other => {
                let model_name = match other {
                    ModelKind::BgeM3 => EmbeddingModel::BGEM3,
                    ModelKind::MultilingualMiniLm => EmbeddingModel::ParaphraseMLMiniLML12V2,
                    ModelKind::MultilingualE5Base => EmbeddingModel::MultilingualE5Base,
                    ModelKind::BgeM3Int8 => {
                        return Err(KbError::Internal(
                            "bge-m3-int8 应走 Bgem3Embedding 分支".to_owned(),
                        ));
                    }
                };
                let mut init = TextInitOptions::new(model_name)
                    .with_max_length(max_length)
                    .with_environment(environment)
                    .with_show_download_progress(false);
                if let Some(dir) = &options.cache_dir {
                    init = init.with_cache_dir(dir.clone());
                }
                if options.threads > 0 {
                    init = init.with_intra_threads(options.threads);
                }
                let embedding = TextEmbedding::try_new(init)
                    .map_err(|err| KbError::Unavailable(format!("加载模型失败: {err}")))?;
                Loaded::Text(Box::new(embedding))
            }
        };
        Ok(Self {
            kind,
            model,
            batch_size,
        })
    }

    /// 模型种类。
    pub fn kind(&self) -> ModelKind {
        self.kind
    }
}

impl EmbedBackend for FastEmbedBackend {
    fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        match &mut self.model {
            Loaded::BgeM3(model) => {
                let output = model
                    .embed(texts, Some(self.batch_size))
                    .map_err(|err| KbError::Internal(format!("bge-m3 嵌入失败: {err}")))?;
                // 只取 dense 输出
                Ok(output.dense)
            }
            Loaded::Text(model) => model
                .embed(texts, Some(self.batch_size))
                .map_err(|err| KbError::Internal(format!("嵌入失败: {err}"))),
        }
    }

    fn dim(&self) -> usize {
        self.kind.dim()
    }

    fn prefix(&self, mode: EmbedMode) -> &'static str {
        match mode {
            EmbedMode::Query => self.kind.query_prefix(),
            EmbedMode::Document => self.kind.passage_prefix(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_names_map_to_dimensions_and_groups() {
        assert_eq!(
            ModelKind::from_name("bge-m3-int8").expect("int8").dim(),
            1024
        );
        assert_eq!(ModelKind::from_name("bge-m3").expect("fp32").dim(), 1024);
        assert_eq!(
            ModelKind::from_name("multilingual-minilm")
                .expect("minilm")
                .dim(),
            384
        );
        assert_eq!(
            ModelKind::from_name("multilingual-e5-base")
                .expect("e5")
                .dim(),
            768
        );
        assert!(ModelKind::from_name("bogus").is_err());
    }

    #[test]
    fn compat_group_pairs_bge_m3_variants() {
        assert_eq!(ModelKind::BgeM3Int8.compat_group(), "bge-m3");
        assert_eq!(ModelKind::BgeM3.compat_group(), "bge-m3");
        assert_ne!(ModelKind::MultilingualMiniLm.compat_group(), "bge-m3");
    }

    #[test]
    fn embedder_ids_match_the_documented_examples() {
        assert_eq!(ModelKind::BgeM3Int8.embedder_id(), "fastembed:bge-m3-int8");
        assert_eq!(ModelKind::BgeM3.embedder_id(), "fastembed:bge-m3");
        assert_eq!(
            ModelKind::MultilingualMiniLm.embedder_id(),
            "fastembed:multilingual-minilm"
        );
    }

    #[test]
    fn only_e5_uses_prefixes() {
        assert_eq!(ModelKind::MultilingualE5Base.query_prefix(), "query: ");
        assert_eq!(ModelKind::MultilingualE5Base.passage_prefix(), "passage: ");
        assert_eq!(ModelKind::BgeM3Int8.query_prefix(), "");
        assert_eq!(ModelKind::BgeM3Int8.passage_prefix(), "");
    }

    #[test]
    fn load_options_clamp_batch_size() {
        let zero = EmbedConfig {
            batch_size: 0,
            ..EmbedConfig::default()
        };
        assert_eq!(LoadOptions::from_config(&zero, None).batch_size, 1);
        let huge = EmbedConfig {
            batch_size: 1000,
            ..EmbedConfig::default()
        };
        assert_eq!(LoadOptions::from_config(&huge, None).batch_size, 64);
        let config = EmbedConfig {
            batch_size: 8,
            max_tokens: 256,
            ..EmbedConfig::default()
        };
        let options = LoadOptions::from_config(&config, Some(PathBuf::from("/models")));
        assert_eq!(options.batch_size, 8);
        assert_eq!(options.max_tokens, 256);
        assert_eq!(options.cache_dir, Some(PathBuf::from("/models")));
    }
}
