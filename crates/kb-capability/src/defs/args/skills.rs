//! skills 与官方插件:启停、保存、草稿审阅。

use super::*;

/// `list_drafts` 的参数(审核收件箱)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ListDraftsArgs {
    /// 状态过滤:`pending`(默认)/ `approved` / `revised` / `rejected` / `duplicate` / `all`。
    #[serde(default)]
    pub state: Option<String>,
    /// 页码,从 1 起。
    #[serde(default)]
    pub page: Option<u32>,
    /// 每页条数(上限 200)。
    #[serde(default)]
    pub page_size: Option<u32>,
}

/// `review_draft` 的参数(审核收件箱)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ReviewDraftArgs {
    /// 草稿 id。
    pub id: String,
    /// `approve`(通过,可同时改内容)或 `reject`(驳回)。
    pub decision: String,
    /// 通过时的新标题(不改就不传)。
    #[serde(default)]
    pub title: Option<String>,
    /// 通过时的新正文(不改就不传)。
    #[serde(default)]
    pub body_md: Option<String>,
    /// 通过时的新标签(不改就不传)。
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// 驳回时是否「不再提炼」(写排除表并清空正文)。
    #[serde(default)]
    pub never_extract: bool,
}

/// `get_skill` / `delete_skill` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SkillIdArgs {
    /// skill 的目录名(`list_skills` 返回的 `id`)。
    pub id: String,
}

/// `save_skill` 的参数:设置页「新增 / 编辑 Skill」表单。服务端据此生成 manifest.toml,不接收原始 TOML。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SaveSkillArgs {
    /// 编辑已有 skill 时填它的目录名;不填 = 新建(目录名由显示名生成)。
    #[serde(default)]
    pub id: Option<String>,
    /// 显示名。
    pub name: String,
    /// `loader-rule`(加载规则)/ `prompt`(提示词)/ `insight-template`(笔记模板)。脚本类不能从这里创建。
    pub kind: String,
    /// 一句话说明。
    #[serde(default)]
    pub description: String,
    /// 是否启用(默认启用)。
    #[serde(default = "super::enabled_by_default")]
    pub enabled: bool,
    /// 加载规则:匹配的相对路径,如 `**/*.proto`。
    #[serde(default)]
    pub glob: String,
    /// 加载规则:按什么方式分块(`text` = 按行窗口)。
    #[serde(default)]
    pub lang: String,
    /// 加载规则:附加标签。
    #[serde(default)]
    pub tags: Vec<String>,
    /// 提示词:`extract`(提炼)/ `review`(审核)。
    #[serde(default)]
    pub stage: String,
    /// 提示词正文。
    #[serde(default)]
    pub template: String,
    /// 笔记模板:必填项(`title` / `body` / `tags`)。
    #[serde(default)]
    pub required: Vec<String>,
    /// 笔记模板:正文最多多少字。
    #[serde(default)]
    pub max_body_chars: Option<usize>,
    /// 笔记模板:标题最多多少字。
    #[serde(default)]
    pub max_title_chars: Option<usize>,
}

/// `save_plugin` 的参数:设置页「新增 / 编辑插件」表单。
///
/// `draft` 的字段与 `kb_service::PluginDraft` 一致(名称、包含规则、进程钩子、脚本文件等)。
/// 这里用 `Value` 是为了让 kb-capability 不反向依赖 kb-service;服务端反序列化时会逐项校验。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SavePluginArgs {
    /// 编辑已有插件时填目录名;不填 = 新建。
    #[serde(default)]
    pub id: Option<String>,
    /// 插件表单。
    pub draft: serde_json::Value,
}

/// `set_skill_enabled` 的参数:只切换启用状态,不改其它内容。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SetSkillEnabledArgs {
    /// skill 目录名。
    pub id: String,
    /// 是否启用。
    pub enabled: bool,
}

/// `install_official_plugin` / `uninstall_official_plugin` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct OfficialPluginArgs {
    /// 官方插件编号(`list_official_plugins` 返回的 `id`)。
    pub id: String,
    /// 安装时是否覆盖已存在的同名版本。
    #[serde(default)]
    pub overwrite: bool,
}
