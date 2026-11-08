//! 插件返回的索引结果与抽取文本——跨进程边界的数据形状。
//!
//! 这些类型只在插件钩子这条路上用:插件进程吐 JSON,宿主按这里的形状反序列化并校验。
//! 所以字段都是「扁平、可空、带默认」的,少一个字段不该让整份结果作废。

use super::*;

/// 插件 `source` 钩子返回的一个页面 / 文件。
#[derive(Clone, Debug, Deserialize)]
pub struct SourcePage {
    /// 原始地址(URL / 仓库路径),用于溯源。
    pub url: String,
    /// 落盘用的相对路径(不能是绝对路径、不能含 `..`)。
    pub rel_path: String,
    /// 正文。
    pub content: String,
    /// MIME 类型(可选,目前只用于日志)。
    #[serde(default)]
    pub content_type: Option<String>,
}

/// 一个已加载的外部进程插件。
#[derive(Debug)]
pub(crate) struct LoadedPlugin {
    /// 插件名。
    pub(crate) name: String,
    /// 版本。
    pub(crate) version: String,
    /// 已启用的钩子。
    pub(crate) hooks: Vec<PluginHook>,
    /// 进程宿主。
    pub(crate) host: Arc<PluginHost>,
}

/// 一次插件索引匹配的结果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PluginIndexMatch {
    /// 覆盖语言(优先级最高的规则)。
    pub lang: Option<String>,
    /// 需要追加的标签(按优先级合并去重)。
    pub tags: Vec<String>,
    /// 负责抽取文本的插件。
    pub extract_plugin: Option<String>,
    /// 负责分块的插件。
    pub chunk_plugin: Option<String>,
    /// 负责增强的插件。
    pub enrich_plugin: Option<String>,
}

impl PluginIndexMatch {
    /// 是否没有任何实际效果(语言 / 标签 / 三个钩子都没命中)。
    ///
    /// 只有 `[index].include` 而没有 lang / tags / 钩子的规则不算“有插件参与”;
    /// 索引时仍可走文件哈希快路径,不必为了一个空规则重读文件。
    pub fn is_empty(&self) -> bool {
        self.lang.is_none()
            && self.tags.is_empty()
            && self.extract_plugin.is_none()
            && self.chunk_plugin.is_none()
            && self.enrich_plugin.is_none()
    }
}

/// 插件 `extract` 钩子的返回。
#[derive(Clone, Debug, Deserialize)]
pub struct ExtractedText {
    /// 抽取出的正文。
    pub text: String,
    /// 插件建议的语言(缺省沿用扫描结果)。
    #[serde(default)]
    pub lang: Option<String>,
}
