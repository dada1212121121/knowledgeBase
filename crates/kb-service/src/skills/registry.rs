//! 已加载的 skill 集合:扫目录、按规则匹配、按钩子调度（设计规范）。
//!
//! 扫描是尽力而为的:某个 skill 写坏了只记一条 warning 并跳过,不影响其它 skill
//! 和守护进程启动。`load_one` 也被设置页复用(先写临时目录、用同一套逻辑校验、通过了才改名)。

use super::*;

/// 已加载的 skill 集合。
#[derive(Debug, Default)]
pub struct SkillRegistry {
    pub(crate) loader_rules: Vec<LoaderRule>,
    /// 插件索引规则(按 priority 降序,同优先级按插件名)。
    pub(crate) index_rules: Vec<IndexRule>,
    /// 插件 source 规则(按 priority 降序)。
    pub(crate) source_rules: Vec<SourceRule>,
    /// 已加载的外部进程插件。
    pub(crate) plugins: Vec<LoadedPlugin>,
    pub(crate) prompts: BTreeMap<PromptStage, String>,
    pub(crate) templates: Vec<InsightTemplate>,
    pub(crate) warnings: Vec<String>,
    /// 扫描的目录(空表示没有配置目录)。
    pub(crate) dir: Option<PathBuf>,
    /// 逐个 skill 的登记信息(给设置页列出来,含被停用 / 被拒绝的)。
    pub(crate) skills: Vec<SkillInfo>,
    /// `skills.allow_exec` 的取值(展示用)。
    pub(crate) allow_exec: bool,
    /// bwrap 是否可用;不可用时进程钩子默认禁用。
    pub(crate) sandbox_available: bool,
    /// bwrap 不可用时是否允许裸跑;只有管理员显式配置才为 true。
    pub(crate) allow_unsandboxed: bool,
}

impl SkillRegistry {
    /// 空集合(没有 skills 目录时用)。
    pub fn empty() -> Self {
        Self::default()
    }

    /// 扫描目录并加载;返回的 registry 里带 warnings(坏 skill 只记一条,不中断)。
    ///
    /// `allow_exec = false` 时拒绝 `type = "exec"` 的 skill,并在 warnings 里说明。
    /// 这个入口保留给「只关心开关、不关心沙箱回退」的调用方;它等价于
    /// `allow_unsandboxed = false`,即 bwrap 不可用时进程钩子不启动。
    pub fn load(dir: &Path, allow_exec: bool) -> Self {
        Self::load_with_options(dir, allow_exec, false)
    }

    /// 带沙箱回退开关的加载入口;`allow_unsandboxed` 只应在管理员显式配置时传 true。
    pub fn load_with_options(dir: &Path, allow_exec: bool, allow_unsandboxed: bool) -> Self {
        let mut registry = Self {
            dir: Some(dir.to_path_buf()),
            allow_exec,
            allow_unsandboxed,
            sandbox_available: sandbox::available(),
            ..Self::default()
        };
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(err) => {
                // 目录不存在是正常情况(没装任何 skill),其它错误才记 warning
                if err.kind() != std::io::ErrorKind::NotFound {
                    registry
                        .warnings
                        .push(format!("读取 skills 目录 {} 失败: {err}", dir.display()));
                }
                return registry;
            }
        };
        let mut dirs: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            // 点开头的目录是保存时的临时目录(写完校验通过才改名成正式的),不是 skill
            .filter(|path| path.is_dir() && !is_scratch(path))
            .collect();
        dirs.sort();
        for path in dirs {
            let before = registry.skills.len();
            match registry.load_one(&path, allow_exec) {
                Ok(()) => {
                    // load_one 每个分支各登记一条信息;目录名和可编辑内容统一在这里补上
                    if let Some(info) = registry.skills.get_mut(before) {
                        info.id = path
                            .file_name()
                            .map(|value| value.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        info.draft = write::draft_of(&path);
                    }
                }
                Err(err) => registry
                    .warnings
                    .push(format!("skill {} 未加载: {err}", path.display())),
            }
        }
        registry
    }

    /// 进程钩子是否真的可以启动:总开关打开,并且有沙箱或管理员显式允许裸跑。
    pub(crate) fn exec_enabled(&self) -> bool {
        self.allow_exec && (self.sandbox_available || self.allow_unsandboxed)
    }

    /// 进程钩子被禁用的原因;同时用于普通钩子与 source 钩子的 warning。
    pub(crate) fn exec_disabled_reason(&self) -> &'static str {
        if !self.allow_exec {
            " skills.allow_exec = false 禁用"
        } else {
            "禁用:没有可用的 bwrap 沙箱,且 skills.allow_unsandboxed = false"
        }
    }

    pub(crate) fn load_one(&mut self, dir: &Path, allow_exec: bool) -> Result<()> {
        let manifest_path = dir.join("manifest.toml");
        let text = std::fs::read_to_string(&manifest_path).map_err(|err| {
            KbError::InvalidInput(format!("读不到 {}: {err}", manifest_path.display()))
        })?;
        let manifest: Manifest = toml::from_str(&text)
            .map_err(|err| KbError::InvalidInput(format!("manifest.toml 解析失败: {err}")))?;
        let dir_name = dir
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = manifest.name.clone().unwrap_or(dir_name);
        if self.skills.iter().any(|skill| skill.name == name) {
            return Err(KbError::InvalidInput(format!("skill 名 {name} 重复")));
        }
        if let Some(description) = &manifest.description {
            tracing::debug!(skill = %name, description = %description, "加载声明式 skill");
        }
        let description = manifest.description.clone().unwrap_or_default();
        let declared_hooks: Vec<String> = manifest
            .exec
            .as_ref()
            .map(|exec| {
                let mut hooks = exec.hooks.clone();
                hooks.sort();
                hooks.dedup();
                hooks
                    .into_iter()
                    .map(|hook| hook.as_str().to_owned())
                    .collect()
            })
            .unwrap_or_default();
        if manifest.enabled == Some(false) {
            self.warnings.push(format!("skill {name} 已停用,跳过"));
            self.skills.push(SkillInfo {
                name,
                manifest: manifest_path.display().to_string(),
                kind: manifest.kind.as_str().to_owned(),
                enabled: false,
                version: manifest.version.clone().unwrap_or_default(),
                hooks: declared_hooks,
                description,
                ..SkillInfo::default()
            });
            return Ok(());
        }
        match manifest.kind {
            SkillKind::LoaderRule => {
                let rule = manifest.loader_rule.ok_or_else(|| {
                    KbError::InvalidInput("loader-rule 类型缺少 [loader-rule] 段".to_owned())
                })?;
                let glob = Glob::new(&rule.glob).map_err(|err| {
                    KbError::InvalidInput(format!("glob {} 非法: {err}", rule.glob))
                })?;
                let rule_text = format!(
                    "{} → {}{}",
                    rule.glob,
                    rule.lang,
                    if rule.tags.is_empty() {
                        String::new()
                    } else {
                        format!(" +{}", rule.tags.join(","))
                    }
                );
                self.loader_rules.push(LoaderRule {
                    name: name.clone(),
                    matcher: glob.compile_matcher(),
                    lang: rule.lang,
                    tags: rule.tags,
                });
                self.skills.push(SkillInfo {
                    name,
                    manifest: manifest_path.display().to_string(),
                    kind: SkillKind::LoaderRule.as_str().to_owned(),
                    enabled: true,
                    description,
                    rules: vec![rule_text],
                    ..SkillInfo::default()
                });
            }
            SkillKind::Prompt => {
                let prompt = manifest.prompt.ok_or_else(|| {
                    KbError::InvalidInput("prompt 类型缺少 [prompt] 段".to_owned())
                })?;
                let body = prompt_body(dir, &prompt)?;
                // 同一阶段多个 skill 时按目录名顺序,后者覆盖前者(确定性)
                self.prompts.insert(prompt.stage, body);
                self.skills.push(SkillInfo {
                    name,
                    manifest: manifest_path.display().to_string(),
                    kind: SkillKind::Prompt.as_str().to_owned(),
                    enabled: true,
                    description,
                    prompt_stages: vec![prompt.stage.as_str().to_owned()],
                    ..SkillInfo::default()
                });
            }
            SkillKind::InsightTemplate => {
                let template = manifest.insight_template.ok_or_else(|| {
                    KbError::InvalidInput(
                        "insight-template 类型缺少 [insight-template] 段".to_owned(),
                    )
                })?;
                let template_required = template.required.clone();
                self.templates.push(template_of(&name, &template));
                self.skills.push(SkillInfo {
                    name,
                    manifest: manifest_path.display().to_string(),
                    kind: SkillKind::InsightTemplate.as_str().to_owned(),
                    enabled: true,
                    description,
                    template_required,
                    ..SkillInfo::default()
                });
            }
            SkillKind::Exec => {
                if !allow_exec {
                    return Err(KbError::InvalidInput(
                        "可执行脚本类 skill 被拒绝(skills.allow_exec = false)".to_owned(),
                    ));
                }
                // 旧类型仍只登记、不执行;需要真正执行请改用 type = "plugin" 的 [exec]。
                self.warnings.push(format!(
                    "skill {name} 是旧脚本类,已登记但本版本不执行;请改用 type = \"plugin\""
                ));
                self.skills.push(SkillInfo {
                    name,
                    manifest: manifest_path.display().to_string(),
                    kind: SkillKind::Exec.as_str().to_owned(),
                    enabled: true,
                    description,
                    ..SkillInfo::default()
                });
            }
            SkillKind::Plugin => {
                let api_version = manifest.api_version.unwrap_or(1);
                if api_version != 1 {
                    return Err(KbError::InvalidInput(format!(
                        "插件 {name} 的 api_version 是 {api_version},宿主只支持 1"
                    )));
                }
                let version = manifest
                    .version
                    .clone()
                    .unwrap_or_else(|| "0.0.0".to_owned());
                check_text(&version, "version", 32)?;

                let mut hooks = Vec::new();
                if let Some(exec) = &manifest.exec {
                    let declared = validate_exec(&name, exec)?;
                    if self.exec_enabled() {
                        hooks = declared;
                        tracing::debug!(
                            plugin = %name,
                            network = exec.permissions.network,
                            sandboxed = self.sandbox_available,
                            "插件权限声明"
                        );
                        if !self.sandbox_available {
                            // 兜底路径也必须让管理员在设置页看得见,不能悄悄裸跑。
                            self.warnings.push(format!(
                                "插件 {name} 在没有沙箱的情况下运行:没有可用的 bwrap,管理员打开了 skills.allow_unsandboxed"
                            ));
                        }
                        let sandbox = if self.sandbox_available {
                            SandboxMode::Bwrap {
                                network: exec.permissions.network,
                            }
                        } else {
                            SandboxMode::Direct
                        };
                        let host = PluginHost::new(
                            name.clone(),
                            version.clone(),
                            exec.command.clone(),
                            exec.args.clone(),
                            dir.to_path_buf(),
                            hooks.iter().map(|hook| hook.as_str().to_owned()).collect(),
                            Duration::from_millis(exec.timeout_ms),
                            exec.max_output_bytes,
                            sandbox,
                        );
                        self.plugins.push(LoadedPlugin {
                            name: name.clone(),
                            version: version.clone(),
                            hooks: hooks.clone(),
                            host: Arc::new(host),
                        });
                    } else {
                        // 默认安全:进程钩子被禁用,但插件里的声明式 [index] / 提示词 / 模板仍然可用。
                        // 这样管理员可以先只启用规则,确认效果后再打开 allow_exec。
                        self.warnings.push(format!(
                            "插件 {name} 的进程钩子被{};只加载声明式部分",
                            self.exec_disabled_reason()
                        ));
                    }
                }

                let mut rules = Vec::new();
                if let Some(index) = &manifest.index {
                    let rule = IndexRule::compile(&name, &version, index, &hooks)?;
                    rules.push(index_rule_text(index, &hooks));
                    self.index_rules.push(rule);
                } else if hooks.iter().any(|hook| hook.is_file_hook()) {
                    return Err(KbError::InvalidInput(format!(
                        "插件 {name} 的文件级钩子需要在 [index] 里声明 include"
                    )));
                }

                if let Some(source) = &manifest.source {
                    if !hooks.contains(&PluginHook::Source) {
                        // 进程钩子被开关或沙箱策略剥掉时,只停用 source,不算坏清单。
                        if self.exec_enabled() {
                            return Err(KbError::InvalidInput(format!(
                                "插件 {name} 有 [source] 段,但 [exec] hooks 里没有 source"
                            )));
                        }
                        self.warnings.push(format!(
                            "插件 {name} 的 source 钩子被{}",
                            self.exec_disabled_reason()
                        ));
                    } else {
                        self.source_rules.push(SourceRule::compile(&name, source)?);
                    }
                } else if hooks.contains(&PluginHook::Source) {
                    return Err(KbError::InvalidInput(format!(
                        "插件 {name} 的 source 钩子需要在 [source] 里声明 match"
                    )));
                }

                let mut prompt_stages = Vec::new();
                if let Some(prompt) = &manifest.prompt {
                    let body = prompt_body(dir, prompt)?;
                    self.prompts.insert(prompt.stage, body);
                    prompt_stages.push(prompt.stage.as_str().to_owned());
                }

                let mut template_required = Vec::new();
                if let Some(template) = &manifest.insight_template {
                    template_required = template.required.clone();
                    self.templates.push(template_of(&name, template));
                }

                self.skills.push(SkillInfo {
                    name,
                    manifest: manifest_path.display().to_string(),
                    kind: SkillKind::Plugin.as_str().to_owned(),
                    enabled: true,
                    version,
                    hooks: hooks.iter().map(|hook| hook.as_str().to_owned()).collect(),
                    description,
                    rules,
                    prompt_stages,
                    template_required,
                    ..SkillInfo::default()
                });
            }
        }
        // 索引 / source 规则按 priority 降序;同优先级按插件名,保证同一份磁盘内容每次加载结果一致。
        self.index_rules.sort_by(|left, right| {
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| left.plugin.cmp(&right.plugin))
        });
        self.source_rules.sort_by(|left, right| {
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| left.plugin.cmp(&right.plugin))
        });
        Ok(())
    }

    /// 扫描过的目录。
    pub fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    /// 加载过程中的告警(坏 skill / 被拒绝的脚本类)。
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// 设置页「Skills」用的视图:目录、开关、逐个 skill 的登记信息、告警。
    pub fn summary(&self) -> SkillSummary {
        SkillSummary {
            dir: self.dir.as_ref().map(|dir| dir.display().to_string()),
            allow_exec: self.allow_exec,
            sandbox_available: self.sandbox_available,
            allow_unsandboxed: self.allow_unsandboxed,
            skills: self.skills.clone(),
            warnings: self.warnings.clone(),
        }
    }

    /// 已加载的 loader 规则(按目录名排序,先匹配先用)。
    pub fn loader_rules(&self) -> &[LoaderRule] {
        &self.loader_rules
    }

    /// 已加载的插件数(含只声明了 `[index]`、没有进程钩子的插件)。
    pub fn plugin_count(&self) -> usize {
        self.skills
            .iter()
            .filter(|info| info.enabled && info.kind == SkillKind::Plugin.as_str())
            .count()
    }

    /// 已加载的 source 规则数。
    pub fn source_rule_count(&self) -> usize {
        self.source_rules.len()
    }

    /// 对一条相对路径套用第一条命中的 loader 规则。
    pub fn apply_loader(&self, relative: &str) -> Option<LoaderMatch> {
        let normalized = relative.replace('\\', "/");
        self.loader_rules
            .iter()
            .find(|rule| rule.matches(&normalized))
            .map(|rule| LoaderMatch {
                skill: rule.name.clone(),
                lang: rule.lang.clone(),
                tags: rule.tags.clone(),
            })
    }

    /// 某个项目里被插件 extract 认领的 glob(交给扫描器放行二进制文件)。
    ///
    /// 只收带 `extract` 钩子的规则:没有 extract 的插件认领了二进制也没法解析,
    /// 放行只会把原始字节当文本塞进索引。
    pub fn extract_globs(&self, project: &str) -> Vec<String> {
        let mut globs = Vec::new();
        for rule in &self.index_rules {
            if rule.hooks.contains(&PluginHook::Extract) && rule.for_project(project) {
                globs.extend(rule.include_patterns.iter().cloned());
            }
        }
        globs
    }

    /// 路径是否被插件的排除规则挡掉。
    ///
    /// 纯排除规则(`include` 为空)直接按 `exclude` 命中;带 `include` 的规则只在
    /// 自己负责的范围内排除,不会误伤别的插件。扫描阶段用它过滤,文件从清单里消失后
    /// `remove_vanished` 会清掉旧块。
    pub fn is_excluded(&self, project: &str, relative: &str) -> bool {
        let normalized = relative.replace('\\', "/");
        self.index_rules.iter().any(|rule| {
            if !rule.for_project(project) {
                return false;
            }
            if rule.is_exclude_only() {
                rule.excludes(&normalized)
            } else {
                rule.includes(&normalized) && rule.excludes(&normalized)
            }
        })
    }

    /// 找接管某个数据源的插件(按 priority 排序后的第一条)。
    pub fn source_plugin(&self, kind: &str, uri: &str) -> Option<&str> {
        self.source_rules
            .iter()
            .find(|rule| rule.matches(kind, uri))
            .map(|rule| rule.plugin.as_str())
    }

    /// 调插件的 `source` 钩子,返回要落盘的页面 / 文件。
    ///
    /// 宿主只校验协议与路径边界,内容语义由插件负责;返回空数组表示“这次没有内容”,
    /// 调用方仍应按数据源刷新成功处理(只是没新文件),而不是当成错误。
    pub async fn source_with_plugin(
        &self,
        plugin: &str,
        source: &Source,
    ) -> Result<Vec<SourcePage>> {
        let host = self.plugin(plugin)?.host.clone();
        let result = host
            .call(
                "source",
                json!({
                    "api_version": 1,
                    "source": source,
                    "options": {
                        "depth": source.depth,
                        "allow_hosts": source.allow_hosts,
                    },
                }),
            )
            .await?;
        let pages_value = result.get("pages").cloned().ok_or_else(|| {
            KbError::InvalidInput(format!("插件 {plugin} 的 source 结果缺少 pages 字段"))
        })?;
        let pages: Vec<SourcePage> = serde_json::from_value(pages_value).map_err(|err| {
            KbError::InvalidInput(format!("插件 {plugin} 的 source 结果不合法: {err}"))
        })?;
        if pages.len() > 500 {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 一次返回了 {} 个页面,超过 500",
                pages.len()
            )));
        }
        let mut rel_paths = HashSet::with_capacity(pages.len());
        let mut total_bytes = 0usize;
        for page in &pages {
            if page.url.trim().is_empty() {
                return Err(KbError::InvalidInput(format!(
                    "插件 {plugin} 返回了空 url 的页面"
                )));
            }
            crate::safe_path::check_rel_path(&page.rel_path)?;
            if page.rel_path.chars().count() > 1024 {
                return Err(KbError::InvalidInput(format!(
                    "插件 {plugin} 的 rel_path 超过 1024 字符"
                )));
            }
            if !rel_paths.insert(page.rel_path.as_str()) {
                return Err(KbError::InvalidInput(format!(
                    "插件 {plugin} 返回了重复的 rel_path: {}",
                    page.rel_path
                )));
            }
            if page.content.len() > 8 * 1024 * 1024 {
                return Err(KbError::InvalidInput(format!(
                    "插件 {plugin} 的页面 {} 超过 8MB",
                    page.rel_path
                )));
            }
            total_bytes += page.content.len();
            if total_bytes > 64 * 1024 * 1024 {
                return Err(KbError::InvalidInput(format!(
                    "插件 {plugin} 返回的页面总大小超过 64MB"
                )));
            }
        }
        Ok(pages)
    }

    /// 按项目 + 相对路径匹配插件的索引策略 / 钩子。
    ///
    /// 规则已按 priority 降序排好:标签合并去重,`lang` 和三个文件级钩子取优先级最高的一条。
    /// 旧 `loader-rule` 不在这里处理,调用方仍用 [`Self::apply_loader`],避免改变旧行为。
    pub fn match_plugins(&self, project: &str, relative: &str) -> PluginIndexMatch {
        let normalized = relative.replace('\\', "/");
        let mut matched = PluginIndexMatch::default();
        for rule in &self.index_rules {
            if !rule.for_project(project) || rule.is_exclude_only() {
                continue;
            }
            if !rule.includes(&normalized) || rule.excludes(&normalized) {
                continue;
            }
            for tag in &rule.tags {
                if !matched.tags.contains(tag) {
                    matched.tags.push(tag.clone());
                }
            }
            if matched.lang.is_none() {
                matched.lang = rule.lang.clone();
            }
            if matched.extract_plugin.is_none() && rule.hooks.contains(&PluginHook::Extract) {
                matched.extract_plugin = Some(rule.plugin.clone());
            }
            if matched.chunk_plugin.is_none() && rule.hooks.contains(&PluginHook::Chunk) {
                matched.chunk_plugin = Some(rule.plugin.clone());
            }
            if matched.enrich_plugin.is_none() && rule.hooks.contains(&PluginHook::Enrich) {
                matched.enrich_plugin = Some(rule.plugin.clone());
            }
            tracing::trace!(
                plugin = %rule.plugin,
                version = %rule.version,
                path = %normalized,
                "插件索引规则命中"
            );
        }
        matched
    }

    /// 调插件的 `extract` 钩子,把原始字节抽成文本。
    pub async fn extract_with_plugin(
        &self,
        plugin: &str,
        path: &str,
        project: &str,
        size: u64,
        mtime: kb_core::model::Millis,
        bytes: &[u8],
    ) -> Result<ExtractedText> {
        let host = self.plugin(plugin)?.host.clone();
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        let result = host
            .call(
                "extract",
                json!({
                    "api_version": 1,
                    "file": {"path": path, "project": project, "size": size, "mtime": mtime},
                    "bytes_base64": encoded,
                }),
            )
            .await?;
        let extracted: ExtractedText = serde_json::from_value(result).map_err(|err| {
            KbError::InvalidInput(format!("插件 {plugin} 的 extract 结果不合法: {err}"))
        })?;
        if extracted.text.len() > 16 * 1024 * 1024 {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 抽出的文本超过 16MB"
            )));
        }
        if let Some(lang) = &extracted.lang {
            check_text(lang, "extract.lang", 32)?;
        }
        Ok(extracted)
    }

    /// 调插件的 `chunk` 钩子。返回的块逐项校验,不合格就报错让调用方回退内置分块器。
    pub async fn chunk_with_plugin(&self, plugin: &str, doc: &SourceDoc) -> Result<Vec<Chunk>> {
        let host = self.plugin(plugin)?.host.clone();
        let result = host
            .call("chunk", json!({"api_version": 1, "doc": doc}))
            .await?;
        let chunks = parse_chunks(plugin, result, "chunks")?;
        if chunks.is_empty() && !doc.text.trim().is_empty() {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 对非空文档返回了 0 个块"
            )));
        }
        Ok(fill_headers(doc, chunks))
    }

    /// 调插件的 `enrich` 钩子。插件可以改写块文本 / header / 标签;失败时调用方保留原块。
    pub async fn enrich_with_plugin(
        &self,
        plugin: &str,
        doc: &SourceDoc,
        chunks: &[Chunk],
    ) -> Result<Vec<Chunk>> {
        let host = self.plugin(plugin)?.host.clone();
        let result = host
            .call(
                "enrich",
                json!({"api_version": 1, "doc": doc, "chunks": chunks}),
            )
            .await?;
        let enriched = parse_chunks(plugin, result, "chunks")?;
        if enriched.is_empty() && !chunks.is_empty() {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 对非空输入返回了 0 个块"
            )));
        }
        // enrich 只能改上下文,不能增删块或换顺序:否则后面的写库会悄悄丢内容。
        if enriched.len() != chunks.len()
            || enriched
                .iter()
                .zip(chunks)
                .any(|(left, right)| left.key != right.key)
        {
            return Err(KbError::InvalidInput(format!(
                "插件 {plugin} 的 enrich 结果与输入块不一致(数量或顺序变了)"
            )));
        }
        Ok(fill_headers(doc, enriched))
    }

    fn plugin(&self, name: &str) -> Result<&LoadedPlugin> {
        let plugin = self
            .plugins
            .iter()
            .find(|plugin| plugin.name == name)
            .ok_or_else(|| KbError::NotFound(format!("插件 {name}")))?;
        tracing::trace!(
            plugin = %plugin.name,
            version = %plugin.version,
            hooks = ?plugin.hooks,
            "选择插件"
        );
        Ok(plugin)
    }

    /// 某个阶段的提示词覆盖。
    pub fn prompt(&self, stage: PromptStage) -> Option<&str> {
        self.prompts.get(&stage).map(String::as_str)
    }

    /// 已加载的 insight 模板。
    pub fn templates(&self) -> &[InsightTemplate] {
        &self.templates
    }

    /// 按模板校验一条 insight;没有模板时直接通过。
    pub fn validate_insight(&self, title: &str, body: &str, tags: &[String]) -> Result<()> {
        for template in &self.templates {
            for field in &template.required {
                let present = match field.as_str() {
                    "title" => !title.trim().is_empty(),
                    "body" => !body.trim().is_empty(),
                    "tags" => !tags.is_empty(),
                    other => {
                        return Err(KbError::InvalidInput(format!(
                            "skill {} 要求未知字段 {other}",
                            template.name
                        )));
                    }
                };
                if !present {
                    return Err(KbError::InvalidInput(format!(
                        "skill {} 要求 {field} 不能为空",
                        template.name
                    )));
                }
            }
            if let Some(limit) = template.max_body_chars
                && body.chars().count() > limit
            {
                return Err(KbError::InvalidInput(format!(
                    "skill {} 要求正文不超过 {limit} 字(当前 {})",
                    template.name,
                    body.chars().count()
                )));
            }
            if let Some(limit) = template.max_title_chars
                && title.chars().count() > limit
            {
                return Err(KbError::InvalidInput(format!(
                    "skill {} 要求标题不超过 {limit} 字",
                    template.name
                )));
            }
        }
        Ok(())
    }
}
