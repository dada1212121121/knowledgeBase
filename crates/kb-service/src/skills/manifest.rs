//! `manifest.toml` 的形状、默认值与字段校验（设计规范）。
//!
//! 清单是运维手写的,所以这里的原则是**先解析、再逐项校验**,不让半个坏清单走到加载流程里:
//! - 缺省值集中在 `default_*` 与 serde 的 `default` 里,写清单位置没有默认值就是默认值;
//! - 长度、条数、字符集都在这里卡住,免得坏数据跑到索引与提示词里才发现;
//! - `allow_exec` 之外的钩子字段一律先当作「声明」,能不能真跑由注册表在加载时决定。

use super::*;

/// 一个 skill 的清单(TOML)。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    /// 显示名(缺省用目录名)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
    /// 类型。
    #[serde(rename = "type")]
    pub(crate) kind: SkillKind,
    /// 是否启用(缺省 true)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) enabled: Option<bool>,
    /// 说明。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    /// loader-rule 段。
    #[serde(
        default,
        rename = "loader-rule",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) loader_rule: Option<LoaderRuleManifest>,
    /// prompt 段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) prompt: Option<PromptManifest>,
    /// insight-template 段。
    #[serde(
        default,
        rename = "insight-template",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) insight_template: Option<InsightTemplateManifest>,
    /// 插件版本(仅 `type = "plugin"` 使用)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    /// 插件协议版本(目前只支持 1)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) api_version: Option<u32>,
    /// 声明式索引策略(不需要进程)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) index: Option<IndexManifest>,
    /// 可执行钩子(需要 `skills.allow_exec = true`)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) exec: Option<ExecManifest>,
    /// 数据源规则(只有 `source` 钩子用)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<SourceManifest>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LoaderRuleManifest {
    /// 匹配的项目内相对路径(支持 `*` / `**` / `?`)。
    pub(crate) glob: String,
    /// 匹配后的语言(决定分块器)。
    pub(crate) lang: String,
    /// 附加标签。
    #[serde(default)]
    pub(crate) tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PromptManifest {
    /// `extract` / `review`。
    pub(crate) stage: PromptStage,
    /// 模板正文。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) template: Option<String>,
    /// 模板文件(相对 skill 目录)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) file: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InsightTemplateManifest {
    /// 必填字段。
    #[serde(default)]
    pub(crate) required: Vec<String>,
    /// 正文长度上限。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) max_body_chars: Option<usize>,
    /// 标题长度上限。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) max_title_chars: Option<usize>,
}

/// 插件的声明式索引策略。
///
/// - `include` 非空:规则作用于命中的文件,可覆盖 `lang` / 追加 `tags`,并参与文件级钩子选择;
/// - `include` 为空、`exclude` 非空:纯排除规则,用来治理噪音(如打包产物 / 预览截图);
/// - `projects` 为空表示所有项目;匹配时按项目名做大小写不敏感归一化。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct IndexManifest {
    /// 只在哪些项目生效(项目名或 slug)。
    #[serde(default)]
    pub(crate) projects: Vec<String>,
    /// 命中哪些相对路径。
    #[serde(default)]
    pub(crate) include: Vec<String>,
    /// 排除哪些相对路径(纯排除规则可以只写它)。
    #[serde(default)]
    pub(crate) exclude: Vec<String>,
    /// 追加标签。
    #[serde(default)]
    pub(crate) tags: Vec<String>,
    /// 覆盖语言(决定内置分块器)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) lang: Option<String>,
    /// 多条规则同时命中时,数值越大越先;同优先级按插件名排序。
    #[serde(default)]
    pub(crate) priority: i32,
}

/// 插件的外部进程配置。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExecManifest {
    /// 可执行文件(裸命令走 PATH,带 `/` 的相对路径按插件目录解析)。
    pub(crate) command: String,
    /// 参数。
    #[serde(default)]
    pub(crate) args: Vec<String>,
    /// 实现的钩子。
    #[serde(default)]
    pub(crate) hooks: Vec<PluginHook>,
    /// 单次调用超时(毫秒)。
    #[serde(default = "default_timeout_ms")]
    pub(crate) timeout_ms: u64,
    /// 单次响应大小上限(字节)。
    #[serde(default = "default_max_output_bytes")]
    pub(crate) max_output_bytes: usize,
    /// 权限声明。v1 只开放 `network`;另外两项写 true 会拒绝加载。
    #[serde(default)]
    pub(crate) permissions: PermissionsManifest,
}

/// 插件的 `source` 钩子匹配规则。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SourceManifest {
    /// 匹配的数据源 URI(glob);至少一条,避免插件无意中接管所有来源。
    #[serde(default, rename = "match")]
    pub(crate) match_uri: Vec<String>,
    /// 数据源种类,缺省 `["web"]`(v1 只支持 web)。
    #[serde(default)]
    pub(crate) kinds: Vec<String>,
    /// 多条规则同时命中时,数值越大越先。
    #[serde(default)]
    pub(crate) priority: i32,
}

/// 插件权限声明。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PermissionsManifest {
    /// 是否允许联网。false 时插件在独立 network namespace 里,连宿主回环都不通。
    #[serde(default)]
    pub(crate) network: bool,
    /// 是否允许读项目目录。v1 未开放:true 会被拒绝,插件只能处理宿主传入的文件字节。
    #[serde(default)]
    pub(crate) read_project: bool,
    /// 是否允许调用 LLM。v1 未开放:true 会被拒绝,插件不能自带模型凭据。
    #[serde(default)]
    pub(crate) llm: bool,
}

impl PermissionsManifest {
    /// v1 只实现 network。未实现的能力直接拒绝,而不是只记 warning:
    /// 清单声明 true 却拿不到能力,插件作者会把它当成运行时故障去排查,
    /// 比在加载时明确失败更难发现。
    pub(crate) fn validate(&self, name: &str) -> Result<()> {
        if self.read_project {
            return Err(KbError::InvalidInput(format!(
                "插件 {name} 声明 read_project = true,但 v1 未开放项目目录读取;插件只能处理宿主传入的文件内容,请改成 false"
            )));
        }
        if self.llm {
            return Err(KbError::InvalidInput(format!(
                "插件 {name} 声明 llm = true,但 v1 未开放模型调用,宿主没有提供模型接口,请改成 false"
            )));
        }
        Ok(())
    }
}

pub(crate) fn default_timeout_ms() -> u64 {
    15_000
}

pub(crate) fn default_max_output_bytes() -> usize {
    // 与 extract 的文本上限(16MB)对齐:默认 8MB 会让大文件抽出的文本在回包时被拒。
    16 * 1024 * 1024
}

pub(crate) fn compile_globs(values: &[String], label: &str) -> Result<Vec<GlobMatcher>> {
    if values.len() > 64 {
        return Err(KbError::InvalidInput(format!("{label} 不能超过 64 条")));
    }
    values
        .iter()
        .map(|value| {
            check_text(value, label, 512)?;
            Glob::new(value)
                .map(|glob| glob.compile_matcher())
                .map_err(|err| KbError::InvalidInput(format!("{label} glob {value} 非法: {err}")))
        })
        .collect()
}

pub(crate) fn check_text(value: &str, label: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() {
        return Err(KbError::InvalidInput(format!("{label} 不能为空")));
    }
    if value.chars().count() > max {
        return Err(KbError::InvalidInput(format!(
            "{label} 不能超过 {max} 个字符"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(KbError::InvalidInput(format!("{label} 里有不能用的字符")));
    }
    Ok(())
}

/// 项目名归一化:忽略大小写、下划线和 `proj_` 前缀,让清单里写 `sampleproj` /
/// `proj_sampleproj` / `Sampleproj` 都能命中。
pub(crate) fn normalize_project(value: &str) -> String {
    let lower = value.trim().to_lowercase();
    let lower = lower.strip_prefix("proj_").unwrap_or(&lower);
    lower.chars().filter(|ch| ch.is_alphanumeric()).collect()
}

/// 读提示词正文:内联模板优先,其次读 skill 目录内的文件。
pub(crate) fn prompt_body(dir: &Path, prompt: &PromptManifest) -> Result<String> {
    let body = match (&prompt.template, &prompt.file) {
        (Some(template), _) => template.clone(),
        (None, Some(file)) => std::fs::read_to_string(dir.join(file))
            .map_err(|err| KbError::InvalidInput(format!("读不到提示词文件 {file}: {err}")))?,
        (None, None) => {
            return Err(KbError::InvalidInput(
                "prompt 需要 template 或 file".to_owned(),
            ));
        }
    };
    if body.trim().is_empty() {
        return Err(KbError::InvalidInput("提示词是空的".to_owned()));
    }
    Ok(body)
}

pub(crate) fn template_of(name: &str, template: &InsightTemplateManifest) -> InsightTemplate {
    InsightTemplate {
        name: name.to_owned(),
        required: template.required.clone(),
        max_body_chars: template.max_body_chars,
        max_title_chars: template.max_title_chars,
    }
}

/// 校验 `[exec]`,返回去重后的钩子列表。
pub(crate) fn validate_exec(name: &str, exec: &ExecManifest) -> Result<Vec<PluginHook>> {
    exec.permissions.validate(name)?;
    check_text(&exec.command, "exec.command", 512)?;
    if exec.args.len() > 32 {
        return Err(KbError::InvalidInput("exec.args 不能超过 32 项".to_owned()));
    }
    for arg in &exec.args {
        if arg.contains('\0') || arg.chars().count() > 1024 {
            return Err(KbError::InvalidInput(
                "exec.args 单项不能含 NUL 或超过 1024 字符".to_owned(),
            ));
        }
    }
    if exec.hooks.is_empty() {
        return Err(KbError::InvalidInput(format!(
            "插件 {name} 的 [exec] 没有声明 hooks"
        )));
    }
    if !(100..=120_000).contains(&exec.timeout_ms) {
        return Err(KbError::InvalidInput(
            "exec.timeout_ms 必须在 100..=120000".to_owned(),
        ));
    }
    if !(1024..=16 * 1024 * 1024).contains(&exec.max_output_bytes) {
        return Err(KbError::InvalidInput(
            "exec.max_output_bytes 必须在 1024..=16777216".to_owned(),
        ));
    }
    let mut hooks = exec.hooks.clone();
    hooks.sort();
    hooks.dedup();
    Ok(hooks)
}
