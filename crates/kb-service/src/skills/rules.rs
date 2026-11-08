//! 索引规则(`[index]`)与来源规则(`[source]`):把清单里的字符串规则编译成可执行的匹配器。
//!
//! 编译一次、匹配多次:目录扫描是热路径,跟着每个文件去解析 glob 会把扫描拖成秒级。
//! 编译失败按「这条规则作废」处理,由调用方记 warning,不影响其它规则和守护进程启动。

use super::*;

/// 一条已编译的插件索引规则。
#[derive(Clone, Debug)]
pub(crate) struct IndexRule {
    /// 所属插件名。
    pub(crate) plugin: String,
    /// 插件版本(写进日志 / 后续溯源)。
    pub(crate) version: String,
    /// 项目过滤。
    pub(crate) projects: Vec<String>,
    /// 命中的相对路径。
    pub(crate) include: Vec<GlobMatcher>,
    /// 原始 include 文本(扫描器放行插件认领的二进制文件时要用)。
    pub(crate) include_patterns: Vec<String>,
    /// 排除的相对路径。
    pub(crate) exclude: Vec<GlobMatcher>,
    /// 覆盖语言。
    pub(crate) lang: Option<String>,
    /// 追加标签。
    pub(crate) tags: Vec<String>,
    /// 优先级。
    pub(crate) priority: i32,
    /// 插件实现的钩子。
    pub(crate) hooks: Vec<PluginHook>,
}

impl IndexRule {
    pub(crate) fn compile(
        plugin: &str,
        version: &str,
        manifest: &IndexManifest,
        hooks: &[PluginHook],
    ) -> Result<Self> {
        if manifest.include.is_empty() && manifest.exclude.is_empty() {
            return Err(KbError::InvalidInput(
                "插件 [index] 至少要声明 include 或 exclude".to_owned(),
            ));
        }
        if manifest.include.is_empty() && (manifest.lang.is_some() || !manifest.tags.is_empty()) {
            return Err(KbError::InvalidInput(
                "纯排除规则不能设置 lang / tags(它不作用于具体文件)".to_owned(),
            ));
        }
        if manifest.include.is_empty() && hooks.iter().any(|hook| hook.is_file_hook()) {
            return Err(KbError::InvalidInput(
                "文件级钩子需要在 [index] 里声明 include".to_owned(),
            ));
        }
        if manifest.projects.len() > 64 {
            return Err(KbError::InvalidInput("projects 不能超过 64 项".to_owned()));
        }
        for project in &manifest.projects {
            check_text(project, "projects", 64)?;
        }
        if manifest.tags.len() > 20 {
            return Err(KbError::InvalidInput("tags 不能超过 20 个".to_owned()));
        }
        for tag in &manifest.tags {
            check_text(tag, "tags", 64)?;
            if tag.contains(',') {
                return Err(KbError::InvalidInput("标签里不能有逗号".to_owned()));
            }
        }
        if let Some(lang) = &manifest.lang {
            check_text(lang, "lang", 32)?;
        }
        if !(-1000..=1000).contains(&manifest.priority) {
            return Err(KbError::InvalidInput(
                "priority 必须在 -1000..=1000".to_owned(),
            ));
        }
        Ok(Self {
            plugin: plugin.to_owned(),
            version: version.to_owned(),
            projects: manifest.projects.clone(),
            include: compile_globs(&manifest.include, "include")?,
            include_patterns: manifest.include.clone(),
            exclude: compile_globs(&manifest.exclude, "exclude")?,
            lang: manifest.lang.clone(),
            tags: manifest.tags.clone(),
            priority: manifest.priority,
            hooks: hooks.to_vec(),
        })
    }

    pub(crate) fn for_project(&self, project: &str) -> bool {
        self.projects.is_empty()
            || self
                .projects
                .iter()
                .any(|candidate| normalize_project(candidate) == normalize_project(project))
    }

    pub(crate) fn includes(&self, relative: &str) -> bool {
        self.include
            .iter()
            .any(|matcher| matcher.is_match(relative))
    }

    pub(crate) fn excludes(&self, relative: &str) -> bool {
        self.exclude
            .iter()
            .any(|matcher| matcher.is_match(relative))
    }

    pub(crate) fn is_exclude_only(&self) -> bool {
        self.include.is_empty()
    }
}

/// 一条已编译的 source 规则。
#[derive(Clone, Debug)]
pub(crate) struct SourceRule {
    /// 所属插件名。
    pub(crate) plugin: String,
    /// 匹配的数据源 URI。
    pub(crate) matchers: Vec<GlobMatcher>,
    /// 数据源种类。
    pub(crate) kinds: Vec<String>,
    /// 优先级。
    pub(crate) priority: i32,
}

impl SourceRule {
    pub(crate) fn compile(plugin: &str, manifest: &SourceManifest) -> Result<Self> {
        if manifest.match_uri.is_empty() {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 的 [source] 至少要声明一条 match"
            )));
        }
        let kinds = if manifest.kinds.is_empty() {
            vec!["web".to_owned()]
        } else {
            manifest.kinds.clone()
        };
        for kind in &kinds {
            check_text(kind, "source.kinds", 32)?;
            if kind != "web" {
                return Err(KbError::InvalidInput(format!(
                    "插件 {plugin} 的 source.kinds 只支持 web(v1),收到 {kind}"
                )));
            }
        }
        if !(-1000..=1000).contains(&manifest.priority) {
            return Err(KbError::InvalidInput(
                "source.priority 必须在 -1000..=1000".to_owned(),
            ));
        }
        Ok(Self {
            plugin: plugin.to_owned(),
            matchers: compile_globs(&manifest.match_uri, "source.match")?,
            kinds,
            priority: manifest.priority,
        })
    }

    pub(crate) fn matches(&self, kind: &str, uri: &str) -> bool {
        self.kinds.iter().any(|candidate| candidate == kind)
            && self.matchers.iter().any(|matcher| matcher.is_match(uri))
    }
}

/// 解析并校验插件返回的块数组。
pub(crate) fn parse_chunks(plugin: &str, value: Value, field: &str) -> Result<Vec<Chunk>> {
    let chunks_value = value
        .get(field)
        .cloned()
        .ok_or_else(|| KbError::InvalidInput(format!("插件 {plugin} 的结果缺少 {field} 字段")))?;
    let chunks: Vec<Chunk> = serde_json::from_value(chunks_value)
        .map_err(|err| KbError::InvalidInput(format!("插件 {plugin} 的 {field} 不合法: {err}")))?;
    if chunks.len() > 10_000 {
        return Err(KbError::InvalidInput(format!(
            "插件 {plugin} 返回的块超过 10000 个"
        )));
    }
    let mut keys = HashSet::with_capacity(chunks.len());
    let mut total_bytes = 0usize;
    for chunk in &chunks {
        if chunk.key.trim().is_empty() {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 返回了空 key 的块"
            )));
        }
        if !keys.insert(chunk.key.as_str()) {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 返回了重复的块 key: {}",
                chunk.key
            )));
        }
        if chunk.text.len() > 1_000_000 {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 的块 {} 超过 1MB",
                chunk.key
            )));
        }
        total_bytes += chunk.text.len();
        if total_bytes > 16 * 1024 * 1024 {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 返回的块总大小超过 16MB"
            )));
        }
        if chunk.start_line < 0 || chunk.end_line < chunk.start_line {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 的块 {} 行号不合法({}-{})",
                chunk.key, chunk.start_line, chunk.end_line
            )));
        }
        if chunk.header.chars().count() > 4096 {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 的块 {} header 超过 4096 字符",
                chunk.key
            )));
        }
        if let Some(symbol) = &chunk.symbol
            && symbol.chars().count() > 512
        {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 的块 {} symbol 超过 512 字符",
                chunk.key
            )));
        }
        if let Some(title) = &chunk.title
            && title.chars().count() > 512
        {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 的块 {} title 超过 512 字符",
                chunk.key
            )));
        }
    }
    Ok(chunks)
}

/// 插件没给 header 时补一个最小上下文头,避免检索时丢掉项目和路径。
pub(crate) fn fill_headers(doc: &SourceDoc, mut chunks: Vec<Chunk>) -> Vec<Chunk> {
    let fallback = format!("{} › {}", doc.project_name, doc.source);
    for chunk in &mut chunks {
        if chunk.header.trim().is_empty() {
            chunk.header = fallback.clone();
        }
    }
    chunks
}

/// 给设置页看的索引规则文本。
pub(crate) fn index_rule_text(index: &IndexManifest, hooks: &[PluginHook]) -> String {
    if index.include.is_empty() {
        return format!("排除 {}", index.exclude.join(","));
    }
    format!(
        "{} → {}{}{}",
        index.include.join(","),
        index.lang.as_deref().unwrap_or("默认"),
        if index.tags.is_empty() {
            String::new()
        } else {
            format!(" +{}", index.tags.join(","))
        },
        if hooks.is_empty() {
            String::new()
        } else {
            format!(
                " [{}]",
                hooks
                    .iter()
                    .map(|hook| hook.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    )
}
