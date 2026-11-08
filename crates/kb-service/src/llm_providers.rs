//! LLM 提供商清单(后续 之后的设置页补全)。
//!
//! 设置页要展示「这台机器上有哪些 LLM 提供商、密钥是不是已设置、当前用的是哪个」。
//! 这里只做**静态目录 + 状态判定**,不发任何网络请求:
//! - `configured`:该提供商的环境变量已设置,或当前就是它且 `~/.kb/secrets.toml` 里有 key;
//! - `current`:与 `[llm] provider` 一致。
//!
//! Anthropic 不是 OpenAI 兼容接口,本版本不支持直连——照样列出来,但标成「未支持」,
//! 避免用户在设置页里找不到它又不知道为什么。

use kb_core::config::LlmConfig;
use serde::Serialize;

/// 一个 LLM 提供商的展示信息。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LlmProviderInfo {
    /// 标识(`[llm] provider` 用的值)。
    pub id: String,
    /// 显示名。
    pub name: String,
    /// 环境变量名(没有则为空)。
    pub env_var: Option<String>,
    /// 默认地址。
    pub base_url: String,
    /// 是否已配置(环境变量已设置,或当前提供商 + secrets.toml 有 key)。
    pub configured: bool,
    /// 是否是当前选用的提供商。
    pub current: bool,
    /// 当前提供商用的模型(其它提供商为 `None`)。
    pub model: Option<String>,
    /// 补充说明(例如“未支持”)。
    pub note: Option<String>,
    /// 本版本是否支持直连(Anthropic 为 false,设置页据此禁用按钮)。
    pub supported: bool,
}

/// 静态目录里的一个条目。
struct ProviderEntry {
    /// 标识。
    id: &'static str,
    /// 显示名。
    name: &'static str,
    /// 环境变量名。
    env_var: Option<&'static str>,
    /// 默认地址。
    base_url: &'static str,
    /// 补充说明。
    note: Option<&'static str>,
}

/// 静态目录:四项。
const PROVIDERS: [ProviderEntry; 4] = [
    ProviderEntry {
        id: "deepseek",
        name: "DeepSeek",
        env_var: Some("DEEPSEEK_API_KEY"),
        base_url: "https://api.deepseek.com",
        note: None,
    },
    ProviderEntry {
        id: "openai",
        name: "OpenAI",
        env_var: Some("OPENAI_API_KEY"),
        base_url: "https://api.openai.com/v1",
        note: None,
    },
    ProviderEntry {
        id: "anthropic",
        name: "Anthropic",
        env_var: Some("ANTHROPIC_API_KEY"),
        base_url: "https://api.anthropic.com",
        note: Some("Anthropic 不是 OpenAI 兼容接口,本版本不支持直连"),
    },
    ProviderEntry {
        id: "ollama",
        name: "本地 Ollama",
        env_var: None,
        base_url: "http://127.0.0.1:11434",
        note: Some("本机模型,不需要密钥"),
    },
];

/// 某个提供商对应的环境变量名(运行时也用它做回退,见 `chat_model`)。
pub fn env_var_of(provider: &str) -> Option<&'static str> {
    PROVIDERS
        .iter()
        .find(|entry| entry.id == provider)
        .and_then(|entry| entry.env_var)
}

/// 生成提供商清单。
///
/// `secret_present`:`~/.kb/secrets.toml` 里是否有 `[llm] api_key`;
/// `env`:读环境变量的函数(测试里注入,生产传 `std::env::var` 的包装)。
///
/// `configured` 的判定与**运行时一致**:运行时会用 `secrets.toml` 的 key,
/// 没有就按当前提供商回退读它自己的环境变量(见 `chat_model`),所以两者都算已配置;
/// 非当前提供商只有在**自己的**环境变量已设置时才算已配置。
pub fn catalog(
    config: &LlmConfig,
    secret_present: bool,
    env: impl Fn(&str) -> Option<String>,
) -> Vec<LlmProviderInfo> {
    PROVIDERS
        .iter()
        .map(|entry| {
            let current = config.provider == entry.id;
            let env_set = entry
                .env_var
                .and_then(&env)
                .is_some_and(|value| !value.trim().is_empty());
            // 不支持的提供商(带 note 的 Anthropic)不判“已配置”,否则会误导
            let supported = entry.id != "anthropic";
            // 本地 Ollama 没有密钥:只要当前选的就是它,就算“已连接”(真正的连通性由调用时判断)
            let configured =
                supported && (env_set || (current && (secret_present || entry.id == "ollama")));
            LlmProviderInfo {
                id: entry.id.to_owned(),
                name: entry.name.to_owned(),
                env_var: entry.env_var.map(str::to_owned),
                // 当前提供商显示运行时真正在用的地址(可能被 config.toml 改过)
                base_url: if current {
                    config.base_url.clone()
                } else {
                    entry.base_url.to_owned()
                },
                configured,
                current,
                model: current.then(|| config.extract_model.clone()),
                note: entry.note.map(str::to_owned),
                supported,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(provider: &str) -> LlmConfig {
        LlmConfig {
            provider: provider.to_owned(),
            extract_model: "deepseek-chat".to_owned(),
            ..LlmConfig::default()
        }
    }

    #[test]
    fn current_provider_with_secret_is_configured() {
        let list = catalog(&config("deepseek"), true, |_| None);
        let deepseek = list
            .iter()
            .find(|item| item.id == "deepseek")
            .expect("有 DeepSeek");
        assert!(deepseek.configured);
        assert!(deepseek.current);
        assert_eq!(deepseek.model.as_deref(), Some("deepseek-chat"));
        assert_eq!(deepseek.env_var.as_deref(), Some("DEEPSEEK_API_KEY"));
    }

    #[test]
    fn env_var_marks_a_provider_configured_even_when_not_current() {
        let list = catalog(&config("deepseek"), false, |key| {
            (key == "OPENAI_API_KEY").then(|| "sk-test".to_owned())
        });
        let openai = list
            .iter()
            .find(|item| item.id == "openai")
            .expect("有 OpenAI");
        assert!(openai.configured, "环境变量设置即算已配置");
        assert!(!openai.current);
        assert!(openai.model.is_none());
    }

    #[test]
    fn blank_env_var_does_not_count() {
        let list = catalog(&config("deepseek"), false, |_| Some("  ".to_owned()));
        let deepseek = list
            .iter()
            .find(|item| item.id == "deepseek")
            .expect("有 DeepSeek");
        assert!(!deepseek.configured);
    }

    #[test]
    fn current_provider_shows_the_runtime_base_url() {
        let mut config = config("deepseek");
        config.base_url = "http://127.0.0.1:9999/v1".to_owned();
        let list = catalog(&config, true, |_| None);
        let deepseek = list
            .iter()
            .find(|item| item.id == "deepseek")
            .expect("有 DeepSeek");
        assert_eq!(deepseek.base_url, "http://127.0.0.1:9999/v1");
    }

    #[test]
    fn anthropic_is_never_configured() {
        // 不支持直连:即使环境变量有值也不判“已配置”
        let list = catalog(&config("deepseek"), false, |key| {
            (key == "ANTHROPIC_API_KEY").then(|| "sk-ant".to_owned())
        });
        let anthropic = list
            .iter()
            .find(|item| item.id == "anthropic")
            .expect("有 Anthropic");
        assert!(!anthropic.configured);
    }

    #[test]
    fn ollama_needs_no_secret_when_current() {
        let list = catalog(&config("ollama"), false, |_| None);
        let ollama = list
            .iter()
            .find(|item| item.id == "ollama")
            .expect("有 Ollama");
        assert!(ollama.configured, "本机 Ollama 不需要密钥");
        assert!(ollama.env_var.is_none());
    }

    #[test]
    fn anthropic_is_listed_with_a_note() {
        let list = catalog(&config("deepseek"), true, |_| None);
        let anthropic = list
            .iter()
            .find(|item| item.id == "anthropic")
            .expect("有 Anthropic");
        assert!(anthropic.note.is_some(), "要说明不支持直连");
    }
}
