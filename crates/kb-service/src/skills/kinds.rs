//! 能力面上的小类型:skill 种类、插件钩子、提示词阶段、加载规则、模板与摘要。
//!
//! 这些类型同时出现在两处,所以单独放一层:一处是界面(`/api/plugins` 之类的返回体),
//! 一处是 manifest 反序列化。放一起是为了让「清单里能写什么」和「界面能显示什么」
//! 用同一套枚举,不会出现清单认 `enrich`、界面只列 `extract` 这种错位。
//!
//! 字段一律 crate 可见:同目录的 `registry` / `write` 要读它们拼返回体。

use super::*;

/// skill 类型。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillKind {
    /// 加载规则:glob → 语言 / 分块 / 标签。
    LoaderRule,
    /// 提示词覆盖:提炼或审核。
    Prompt,
    /// insight 模板:字段与校验规则。
    InsightTemplate,
    /// 可执行脚本(旧类型,默认拒绝)。
    Exec,
    /// 插件:声明式索引 / 提示词 / 模板 + 可选的进程钩子。
    Plugin,
}

impl SkillKind {
    /// 字符串形式(清单里的取值,也是设置页展示用的名字)。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LoaderRule => "loader-rule",
            Self::Prompt => "prompt",
            Self::InsightTemplate => "insight-template",
            Self::Exec => "exec",
            Self::Plugin => "plugin",
        }
    }
}

/// 插件可以实现的钩子。文件级钩子(`extract` / `chunk` / `enrich`)必须有 `[index] include`,
/// `source` 是数据源级钩子,不按文件匹配。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginHook {
    /// 把原始字节抽成文本(新格式解析)。
    Extract,
    /// 把文本切成块(索引策略)。
    Chunk,
    /// 对块做上下文增强 / 重写(数据增强)。
    Enrich,
    /// 拉取外部数据源(来源连接)。
    Source,
}

impl PluginHook {
    /// 字符串形式(日志 / 设置页展示)。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Extract => "extract",
            Self::Chunk => "chunk",
            Self::Enrich => "enrich",
            Self::Source => "source",
        }
    }

    /// 是否按文件匹配(需要 `[index] include`)。
    pub fn is_file_hook(self) -> bool {
        matches!(self, Self::Extract | Self::Chunk | Self::Enrich)
    }
}

/// 提示词阶段。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PromptStage {
    /// 自动提炼。
    Extract,
    /// 审核。
    Review,
    /// 网页来源的 AI 规范化。清单里写 `stage = "web_extract"`(也认 `web-extract`)。
    #[serde(rename = "web_extract", alias = "web-extract")]
    WebExtract,
}

impl PromptStage {
    /// 字符串形式(日志与错误信息用)。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Extract => "extract",
            Self::Review => "review",
            Self::WebExtract => "web_extract",
        }
    }
}

/// 一条 loader 规则(已编译 glob)。
#[derive(Clone, Debug)]
pub struct LoaderRule {
    /// skill 名(目录名或 manifest 的 `name`)。
    pub name: String,
    /// 编译后的 glob。
    pub(crate) matcher: GlobMatcher,
    /// 匹配后使用的语言(决定分块方式;`text` = 行窗口)。
    pub lang: String,
    /// 附加标签。
    pub tags: Vec<String>,
}

impl LoaderRule {
    /// 路径(项目内相对路径,正斜杠)是否命中。
    pub fn matches(&self, relative: &str) -> bool {
        self.matcher.is_match(relative)
    }
}

/// 一条 insight 模板规则。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InsightTemplate {
    /// skill 名。
    pub name: String,
    /// 必填字段(`title` / `body` / `tags` / `kind`)。
    pub required: Vec<String>,
    /// 正文长度上限(字符)。
    pub max_body_chars: Option<usize>,
    /// 标题长度上限(字符)。
    pub max_title_chars: Option<usize>,
}

/// 一个 skill 的登记信息(给设置页「Skills」用)。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct SkillInfo {
    /// 目录名,编辑 / 删除时用它指明是哪一个(显示名可以重名、可以是中文,目录名不会)。
    pub id: String,
    /// 可编辑的完整内容(脚本类和读不出清单的没有)。不进 `list_skills` 的返回:那个能力普通用户也能读,
    /// 提示词模板是管理员的配置;设置页"编辑"时由只给管理员的 `get_skill` 单独取。
    #[serde(skip)]
    pub draft: Option<SkillDraft>,
    /// skill 名(manifest 的 `name`,缺省用目录名)。
    pub name: String,
    /// 清单文件路径。
    pub manifest: String,
    /// 类型(`loader-rule` / `prompt` / `insight-template` / `exec` / `plugin`)。
    pub kind: String,
    /// manifest 里 `enabled = false` 时是 `false`(被跳过,只登记)。
    pub enabled: bool,
    /// 插件版本(非插件为空)。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub version: String,
    /// 插件已启用的钩子(`extract` / `chunk` / `enrich` / `source`)。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hooks: Vec<String>,
    /// 说明。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// loader-rule / 插件索引规则(给人看的 `glob → lang` 文本)。
    pub rules: Vec<String>,
    /// prompt 覆盖的阶段。
    pub prompt_stages: Vec<String>,
    /// insight-template 的必填字段。
    pub template_required: Vec<String>,
}

/// 设置页「Skills」分区的视图。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct SkillSummary {
    /// 扫描的目录(没有就是 `None`)。
    pub dir: Option<String>,
    /// 脚本类 skill 是否允许登记。
    pub allow_exec: bool,
    /// 这台机器上 bwrap 沙箱是否真的能启动(启动时探测一次)。
    pub sandbox_available: bool,
    /// bwrap 不可用时是否允许插件进程裸跑(`skills.allow_unsandboxed`)。
    pub allow_unsandboxed: bool,
    /// 已登记的 skill(按目录名顺序)。
    pub skills: Vec<SkillInfo>,
    /// 加载告警(坏清单 / 被拒绝的脚本类 / 已停用)。
    pub warnings: Vec<String>,
}

/// 一次 loader 匹配的结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoaderMatch {
    /// 命中的 skill 名。
    pub skill: String,
    /// 覆盖后的语言。
    pub lang: String,
    /// 需要追加的标签。
    pub tags: Vec<String>,
}
