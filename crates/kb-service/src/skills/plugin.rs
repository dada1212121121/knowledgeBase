//! 插件的设置页编辑与安装(`type = "plugin"`)。
//!
//! 和声明式 skill 一样,界面只提交结构化字段和脚本文本;这里逐项校验后自己生成
//! `manifest.toml`,不接收原始 TOML。写入仍是"临时目录 → 用启动时的加载逻辑校验 → 改名"，
//! 校验失败不会在 skills 目录里留下半成品。
//!
//! 官方插件不依赖部署目录里的额外文件:脚本与清单都编进二进制,安装时写到
//! `<KB_HOME>/skills/<id>`。这样升级宿主后,设置页仍能一键装回五个官方插件。

use std::path::{Component, Path};

use kb_core::{KbError, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::write::{line, scratch_dir, skill_dir, unique_slug, write_manifest};
use super::{
    ExecManifest, IndexManifest, Manifest, PermissionsManifest, PluginHook, SkillKind,
    SkillRegistry, SourceManifest,
};

/// 一个插件文件(设置页上传的脚本 / 配置)。只收 UTF-8 文本。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PluginFileDraft {
    /// 插件目录内的相对路径,例如 `plugin.py` / `lib/helpers.py`。
    pub path: String,
    /// 文件内容。
    pub content: String,
}

/// 插件 `[exec]` 段。没有进程钩子时整个 `exec` 为 `None`。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PluginExecDraft {
    /// 可执行命令(裸命令走 PATH,相对路径按插件目录解析)。
    pub command: String,
    /// 命令参数。
    #[serde(default)]
    pub args: Vec<String>,
    /// 实现的钩子:`extract` / `chunk` / `enrich` / `source`。
    #[serde(default)]
    pub hooks: Vec<String>,
    /// 单次调用超时(毫秒)。
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    /// 单次响应大小上限(字节)。
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: usize,
}

/// 插件 `[source]` 段。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PluginSourceDraft {
    /// URI glob,至少一条。
    #[serde(default, rename = "match")]
    pub match_uri: Vec<String>,
    /// 数据源种类(v1 只支持 web)。
    #[serde(default)]
    pub kinds: Vec<String>,
    /// 匹配优先级。
    #[serde(default)]
    pub priority: i32,
}

/// 插件权限声明:`network` 驱动沙箱放行网络;`read_project` / `llm` 当前版本未开放,
/// 表单不提供开关,提交 true 会被拒绝。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PluginPermissionsDraft {
    /// 是否声明需要联网。
    #[serde(default)]
    pub network: bool,
    /// 是否声明需要读项目目录。v1 未开放,不能为 true。
    #[serde(default)]
    pub read_project: bool,
    /// 是否声明需要调用模型。v1 未开放,不能为 true。
    #[serde(default)]
    pub llm: bool,
}

/// 设置页「新增 / 编辑插件」的完整内容。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginDraft {
    /// 显示名。
    pub name: String,
    /// 插件版本。
    #[serde(default)]
    pub version: String,
    /// 一句话说明。
    #[serde(default)]
    pub description: String,
    /// 是否启用。
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 声明式索引:命中哪些文件。
    #[serde(default)]
    pub include: Vec<String>,
    /// 声明式索引:排除哪些文件。
    #[serde(default)]
    pub exclude: Vec<String>,
    /// 只对哪些项目生效。
    #[serde(default)]
    pub projects: Vec<String>,
    /// 覆盖语言。
    #[serde(default)]
    pub lang: String,
    /// 附加标签。
    #[serde(default)]
    pub tags: Vec<String>,
    /// 多条规则命中时的优先级。
    #[serde(default)]
    pub priority: i32,
    /// 进程钩子;不配置就是纯声明式插件。
    #[serde(default)]
    pub exec: Option<PluginExecDraft>,
    /// 数据源规则。
    #[serde(default)]
    pub source: Option<PluginSourceDraft>,
    /// 权限声明。
    #[serde(default)]
    pub permissions: PluginPermissionsDraft,
    /// 随插件安装的文本文件。保存时整目录以这份列表为准,没列出的旧文件会被删掉。
    #[serde(default)]
    pub files: Vec<PluginFileDraft>,
}

fn default_true() -> bool {
    true
}

fn default_timeout_ms() -> u64 {
    20_000
}

fn default_max_output_bytes() -> usize {
    16 * 1024 * 1024
}

const MAX_NAME_CHARS: usize = 60;
const MAX_VERSION_CHARS: usize = 32;
const MAX_DESCRIPTION_CHARS: usize = 300;
const MAX_PATTERN_CHARS: usize = 200;
const MAX_LANG_CHARS: usize = 30;
const MAX_TAGS: usize = 20;
const MAX_TAG_CHARS: usize = 30;
const MAX_LIST: usize = 64;
const MAX_FILES: usize = 32;
const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_FILE_PATH_CHARS: usize = 160;

fn invalid(message: impl Into<String>) -> KbError {
    KbError::InvalidInput(message.into())
}

/// 路径必须是插件目录内的普通相对路径:挡住绝对路径、`..`、反斜杠和隐藏文件。
fn check_file_path(path: &str) -> Result<()> {
    let path = path.trim();
    if path.is_empty() || path.chars().count() > MAX_FILE_PATH_CHARS {
        return Err(invalid("插件文件名不能为空,也不能超过 160 个字符"));
    }
    if path.contains('\\') || path.contains('\0') {
        return Err(invalid(format!("插件文件名 {path} 不合法")));
    }
    // 只有根目录的 manifest.toml 由宿主生成;子目录里的同名文件是插件自己的资源。
    if !path.contains('/') && path.eq_ignore_ascii_case("manifest.toml") {
        return Err(invalid("manifest.toml 由系统生成,不能作为插件文件上传"));
    }
    // `Path::components` 会吞掉重复斜杠和末尾斜杠;这几类写法在保存时只会变成
    // “目录不存在 / 写到了别处”的笼统错误,不如在这里直接说清楚。
    if path.ends_with('/') || path.split('/').any(|part| part.is_empty()) {
        return Err(invalid(format!(
            "插件文件名 {path} 不合法:不能有空的路径段"
        )));
    }
    let candidate = Path::new(path);
    if !candidate.is_relative() {
        return Err(invalid(format!("插件文件名 {path} 必须是相对路径")));
    }
    for component in candidate.components() {
        match component {
            Component::Normal(name) => {
                let name = name.to_string_lossy();
                if name.starts_with('.') {
                    return Err(invalid(format!("插件文件名 {path} 不能以点开头")));
                }
            }
            _ => {
                return Err(invalid(format!(
                    "插件文件名 {path} 不能包含 ..、根目录或前缀"
                )));
            }
        }
    }
    Ok(())
}

/// 写入一个已经通过 `check_file_path` 的文件;父目录逐层创建。
fn write_plugin_file(root: &Path, file: &PluginFileDraft) -> Result<()> {
    check_file_path(&file.path)?;
    let path = root.join(file.path.trim());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            KbError::Internal(format!("创建插件目录 {} 失败: {err}", parent.display()))
        })?;
    }
    std::fs::write(&path, &file.content)
        .map_err(|err| KbError::Internal(format!("写插件文件 {} 失败: {err}", path.display())))
}

/// 读回插件目录里的文本文件,供设置页编辑。二进制 / 超大文件跳过,避免把设置页拖垮。
fn read_files(dir: &Path) -> Vec<PluginFileDraft> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<PluginFileDraft>, depth: usize) {
        if depth > 4 || out.len() >= MAX_FILES {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if out.len() >= MAX_FILES {
                return;
            }
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                let hidden = entry.file_name().to_string_lossy().starts_with('.');
                if !hidden {
                    walk(&path, root, out, depth + 1);
                }
                continue;
            }
            if !meta.is_file() || meta.len() > MAX_FILE_BYTES as u64 {
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            // 只有根目录的 manifest.toml 是系统生成的;子目录里的同名文件是插件自己的资源。
            if relative == "manifest.toml" || check_file_path(&relative).is_err() {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            // NUL 是“这不是文本脚本”的最低成本判据;真放进来也只会让宿主/解释器报错。
            if content.contains('\0') {
                continue;
            }
            out.push(PluginFileDraft {
                path: relative,
                content,
            });
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out, 0);
    out
}

/// 编辑已有插件前确认目录里的内容都能在表单里显示。
///
/// 保存是整目录替换:`read_files` 读不到的文件(二进制、软链、隐藏文件、超大文件、
/// 超过 32 个或超过 8MB)如果就这么提交,会在用户没看见的情况下被删掉。这里宁可拒绝,
/// 让管理员直接改目录,也不做静默删除。
fn check_editable_dir(dir: &Path) -> Result<()> {
    fn walk(
        dir: &Path,
        root: &Path,
        depth: usize,
        seen: &mut usize,
        total: &mut usize,
    ) -> Result<()> {
        if depth > 4 {
            return Err(invalid(
                "插件目录超过 4 层,设置页读不全;请把文件放到更浅的目录",
            ));
        }
        let entries = std::fs::read_dir(dir)
            .map_err(|err| KbError::Internal(format!("读插件目录失败: {err}")))?;
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path)
                .map_err(|err| KbError::Internal(format!("读插件文件信息失败: {err}")))?;
            if meta.file_type().is_symlink() {
                return Err(invalid(format!(
                    "插件目录里有软链 {};设置页不能安全编辑,请先手动处理",
                    path.display()
                )));
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if meta.is_dir() {
                if name.starts_with('.') {
                    return Err(invalid(format!(
                        "插件目录里有隐藏目录 {name};设置页不会显示,保存会丢掉它"
                    )));
                }
                walk(&path, root, depth + 1, seen, total)?;
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            if relative == "manifest.toml" {
                continue;
            }
            if meta.len() > MAX_FILE_BYTES as u64 {
                return Err(invalid(format!(
                    "插件文件 {relative} 超过 1MB;设置页读不了,保存会丢掉它"
                )));
            }
            check_file_path(&relative)?;
            let content = std::fs::read_to_string(&path).map_err(|_| {
                invalid(format!(
                    "插件文件 {relative} 不是 UTF-8 文本;设置页读不了,保存会丢掉它"
                ))
            })?;
            if content.contains('\0') {
                return Err(invalid(format!(
                    "插件文件 {relative} 看起来是二进制;设置页读不了,保存会丢掉它"
                )));
            }
            *seen += 1;
            *total += usize::try_from(meta.len()).unwrap_or(usize::MAX);
            if *seen > MAX_FILES {
                return Err(invalid(format!("插件文件超过 {MAX_FILES} 个,设置页读不全")));
            }
            if *total > MAX_TOTAL_FILE_BYTES {
                return Err(invalid("插件文件总量超过 8MB,设置页读不全"));
            }
        }
        Ok(())
    }

    let mut seen = 0;
    let mut total = 0;
    walk(dir, dir, 0, &mut seen, &mut total)
}

fn clean_patterns(values: &[String], label: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for value in values {
        let value = line(value, label, MAX_PATTERN_CHARS, false)?;
        if value.is_empty() || out.contains(&value) {
            continue;
        }
        // 在加载阶段也会编译;这里提前报错,错误信息更贴近表单字段。
        globset::Glob::new(&value)
            .map_err(|err| invalid(format!("{label} {value} 写得不对:{err}")))?;
        out.push(value);
    }
    if out.len() > MAX_LIST {
        return Err(invalid(format!("{label}最多 {MAX_LIST} 条")));
    }
    Ok(out)
}

fn clean_tags(tags: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag = line(tag, "标签", MAX_TAG_CHARS, false)?;
        if tag.is_empty() || out.contains(&tag) {
            continue;
        }
        if tag.contains(',') {
            return Err(invalid("标签里不能有逗号"));
        }
        out.push(tag);
    }
    if out.len() > MAX_TAGS {
        return Err(invalid(format!("标签最多 {MAX_TAGS} 个")));
    }
    Ok(out)
}

fn clean_args(args: &[String]) -> Result<Vec<String>> {
    if args.len() > 32 {
        return Err(invalid("命令参数最多 32 项"));
    }
    let mut out = Vec::new();
    for arg in args {
        if arg.contains('\0') || arg.chars().count() > 1024 {
            return Err(invalid("命令参数不能含 NUL,单项也不能超过 1024 个字符"));
        }
        out.push(arg.clone());
    }
    Ok(out)
}

fn clean_hooks(hooks: &[String]) -> Result<Vec<PluginHook>> {
    let mut out = Vec::new();
    for hook in hooks {
        let hook = match hook.trim() {
            "extract" => PluginHook::Extract,
            "chunk" => PluginHook::Chunk,
            "enrich" => PluginHook::Enrich,
            "source" => PluginHook::Source,
            other => {
                return Err(invalid(format!(
                    "未知的插件钩子 {other}(只能选 extract / chunk / enrich / source)"
                )));
            }
        };
        if !out.contains(&hook) {
            out.push(hook);
        }
    }
    if out.is_empty() {
        return Err(invalid("配置了进程插件就至少选一个钩子"));
    }
    Ok(out)
}

fn clean_files(files: &[PluginFileDraft]) -> Result<Vec<PluginFileDraft>> {
    if files.len() > MAX_FILES {
        return Err(invalid(format!("插件文件最多 {MAX_FILES} 个")));
    }
    let mut total = 0usize;
    let mut out = Vec::new();
    for file in files {
        check_file_path(&file.path)?;
        let path = file.path.trim().to_owned();
        if file.content.len() > MAX_FILE_BYTES {
            return Err(invalid(format!("插件文件 {path} 超过 1MB")));
        }
        if file.content.contains('\0') {
            return Err(invalid(format!("插件文件 {path} 含 NUL,不是文本脚本")));
        }
        total += file.content.len();
        if total > MAX_TOTAL_FILE_BYTES {
            return Err(invalid("插件文件总大小不能超过 8MB"));
        }
        if out
            .iter()
            .any(|existing: &PluginFileDraft| existing.path == path)
        {
            return Err(invalid(format!("插件文件 {path} 重复")));
        }
        out.push(PluginFileDraft {
            path,
            content: file.content.clone(),
        });
    }
    Ok(out)
}

/// 命令或参数里引用的相对脚本(`python/plugin.py` / `plugin.py`)必须随本次提交。
///
/// 参数不是命令,不能像命令那样区分“裸命令走 PATH”;这里只认明显的脚本形态:
/// 带路径分隔符、以已知脚本后缀结尾,或以 `./` 开头。`vue` 这类模式参数不会被误判。
fn known_script_extension(value: &str) -> bool {
    let extension = Path::new(value)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    matches!(
        extension.as_deref(),
        Some(
            "py" | "js"
                | "mjs"
                | "cjs"
                | "ts"
                | "sh"
                | "rb"
                | "pl"
                | "php"
                | "lua"
                | "jar"
                | "exe"
                | "bat"
                | "cmd"
                | "ps1"
        )
    )
}

fn check_command_file(command: &str, args: &[String], files: &[PluginFileDraft]) -> Result<()> {
    let mut scripts = Vec::new();
    let command_path = Path::new(command);
    // 裸命令(如 `python3`)走 PATH;带路径分隔符或以脚本后缀结尾的才按插件内脚本检查。
    if command_path.is_relative()
        && (command.contains(['/', '\\']) || known_script_extension(command))
    {
        scripts.push(command.to_owned());
    }
    for arg in args {
        // URL / 选项、以及 `key=value` 这种参数不是文件引用;模式参数(如 `vue`)也不带后缀。
        if arg.starts_with('-') || arg.contains("://") || arg.contains('=') {
            continue;
        }
        let path = Path::new(arg);
        if path.is_absolute() {
            continue;
        }
        if known_script_extension(arg) || arg.starts_with('.') {
            scripts.push(arg.clone());
        }
    }
    for script in scripts {
        let normalized = script.replace('\\', "/");
        let normalized = normalized.trim_start_matches("./");
        if !files.iter().any(|file| file.path == normalized) {
            return Err(invalid(format!(
                "命令或参数引用的脚本 {script} 不在这次提交的文件里;保存会删掉旧文件,请把脚本一起传上来"
            )));
        }
    }
    Ok(())
}

/// 表单 → 清单。所有校验尽量给出表单字段能直接对应的中文说明。
fn to_manifest(draft: &PluginDraft) -> Result<(Manifest, Vec<PluginFileDraft>)> {
    let name = line(&draft.name, "名称", MAX_NAME_CHARS, true)?;
    let version = line(&draft.version, "版本", MAX_VERSION_CHARS, false)?;
    let description = line(&draft.description, "说明", MAX_DESCRIPTION_CHARS, false)?;
    let lang = line(&draft.lang, "语言", MAX_LANG_CHARS, false)?;
    if !lang.is_empty()
        && !lang
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '+' | '#'))
    {
        return Err(invalid("语言只能用英文字母、数字和 - _ + #"));
    }
    let files = clean_files(&draft.files)?;

    let include = clean_patterns(&draft.include, "include")?;
    let exclude = clean_patterns(&draft.exclude, "exclude")?;
    let projects = clean_patterns(&draft.projects, "projects")?;
    let tags = clean_tags(&draft.tags)?;
    let index = if include.is_empty()
        && exclude.is_empty()
        && projects.is_empty()
        && lang.is_empty()
        && tags.is_empty()
        && draft.priority == 0
    {
        None
    } else {
        if include.is_empty() && exclude.is_empty() {
            return Err(invalid("[index] 至少要写一条 include 或 exclude"));
        }
        if include.is_empty() && (!lang.is_empty() || !tags.is_empty()) {
            return Err(invalid("纯排除规则不能设置语言或标签"));
        }
        if !(-1000..=1000).contains(&draft.priority) {
            return Err(invalid("priority 必须在 -1000 到 1000 之间"));
        }
        Some(IndexManifest {
            projects,
            include,
            exclude,
            tags,
            lang: (!lang.is_empty()).then_some(lang),
            priority: draft.priority,
        })
    };

    let exec = match &draft.exec {
        Some(exec) => {
            let command = line(&exec.command, "命令", 512, true)?;
            let hooks = clean_hooks(&exec.hooks)?;
            if !(100..=120_000).contains(&exec.timeout_ms) {
                return Err(invalid("超时必须在 100 到 120000 毫秒之间"));
            }
            if !(1024..=16 * 1024 * 1024).contains(&exec.max_output_bytes) {
                return Err(invalid("响应上限必须在 1KB 到 16MB 之间"));
            }
            let permissions = PermissionsManifest {
                network: draft.permissions.network,
                read_project: draft.permissions.read_project,
                llm: draft.permissions.llm,
            };
            permissions.validate(&name)?;
            Some(ExecManifest {
                command,
                args: clean_args(&exec.args)?,
                hooks,
                timeout_ms: exec.timeout_ms,
                max_output_bytes: exec.max_output_bytes,
                permissions,
            })
        }
        None => None,
    };

    let source = match &draft.source {
        Some(source) => {
            let match_uri = clean_patterns(&source.match_uri, "source.match")?;
            if match_uri.is_empty() {
                return Err(invalid("[source] 至少要写一条匹配地址"));
            }
            let kinds: Vec<String> = source
                .kinds
                .iter()
                .map(|kind| kind.trim().to_owned())
                .filter(|kind| !kind.is_empty())
                .collect();
            if kinds.iter().any(|kind| kind != "web") {
                return Err(invalid("v1 的数据源插件只支持 web"));
            }
            if !(-1000..=1000).contains(&source.priority) {
                return Err(invalid("来源优先级必须在 -1000 到 1000 之间"));
            }
            Some(SourceManifest {
                match_uri,
                kinds: if kinds.is_empty() {
                    vec!["web".to_owned()]
                } else {
                    kinds
                },
                priority: source.priority,
            })
        }
        None => None,
    };

    if source.is_some()
        && !exec
            .as_ref()
            .is_some_and(|exec| exec.hooks.contains(&PluginHook::Source))
    {
        return Err(invalid("填了数据源规则,就要在钩子里勾上 source"));
    }
    if exec
        .as_ref()
        .is_some_and(|exec| exec.hooks.contains(&PluginHook::Source))
        && source.is_none()
    {
        return Err(invalid("勾了 source 钩子,就要填写来源匹配规则"));
    }
    if exec.is_none() && source.is_some() {
        return Err(invalid("数据源插件需要配置进程命令"));
    }

    let manifest = Manifest {
        name: Some(name),
        kind: SkillKind::Plugin,
        enabled: Some(draft.enabled),
        description: (!description.is_empty()).then_some(description),
        loader_rule: None,
        prompt: None,
        insight_template: None,
        version: Some(if version.is_empty() {
            "0.1.0".to_owned()
        } else {
            version
        }),
        api_version: Some(1),
        index,
        exec,
        source,
    };
    Ok((manifest, files))
}

/// 读回一个已落盘插件的可编辑内容。含提示词 / 笔记模板段的插件暂不支持表单编辑。
pub(super) fn draft_of(dir: &Path) -> Result<PluginDraft> {
    let text = std::fs::read_to_string(dir.join("manifest.toml")).map_err(|err| {
        KbError::InvalidInput(format!(
            "读不到 {}: {err}",
            dir.join("manifest.toml").display()
        ))
    })?;
    let manifest: Manifest = toml::from_str(&text)
        .map_err(|err| KbError::InvalidInput(format!("manifest.toml 解析失败: {err}")))?;
    if manifest.kind != SkillKind::Plugin {
        return Err(invalid("这个 skill 不是插件"));
    }
    if manifest.prompt.is_some() || manifest.insight_template.is_some() {
        return Err(invalid(
            "这个插件还包含提示词或笔记模板段落,暂不支持在设置页编辑;请直接改 manifest.toml",
        ));
    }
    let (include, exclude, projects, lang, tags, priority) = manifest
        .index
        .as_ref()
        .map(|index| {
            (
                index.include.clone(),
                index.exclude.clone(),
                index.projects.clone(),
                index.lang.clone().unwrap_or_default(),
                index.tags.clone(),
                index.priority,
            )
        })
        .unwrap_or_default();
    let (exec, permissions) = match &manifest.exec {
        Some(exec) => (
            Some(PluginExecDraft {
                command: exec.command.clone(),
                args: exec.args.clone(),
                hooks: exec
                    .hooks
                    .iter()
                    .map(|hook| hook.as_str().to_owned())
                    .collect(),
                timeout_ms: exec.timeout_ms,
                max_output_bytes: exec.max_output_bytes,
            }),
            PluginPermissionsDraft {
                network: exec.permissions.network,
                // v1 未开放这两项。老清单即使写了 true,读回表单时也按 false 展示,
                // 下次保存会清掉;否则表单没有开关可改,用户会被卡在无法保存的状态。
                read_project: false,
                llm: false,
            },
        ),
        None => (None, PluginPermissionsDraft::default()),
    };
    Ok(PluginDraft {
        name: manifest.name.clone().unwrap_or_default(),
        version: manifest
            .version
            .clone()
            .unwrap_or_else(|| "0.1.0".to_owned()),
        description: manifest.description.clone().unwrap_or_default(),
        enabled: manifest.enabled.unwrap_or(true),
        include,
        exclude,
        projects,
        lang,
        tags,
        priority,
        exec,
        source: manifest.source.map(|source| PluginSourceDraft {
            match_uri: source.match_uri,
            kinds: source.kinds,
            priority: source.priority,
        }),
        permissions,
        files: read_files(dir),
    })
}

impl SkillRegistry {
    /// 新建或修改插件。返回目录名;`id = None` 时按名称生成。
    pub fn save_plugin(root: &Path, id: Option<&str>, draft: &PluginDraft) -> Result<String> {
        let (mut manifest, files) = to_manifest(draft)?;
        let existing = id.map(|id| skill_dir(root, id)).transpose()?;
        // 只允许覆盖“能在设置页编辑的插件”:否则一个 id 传错就会把同名声明式 skill
        // 甚至带提示词段的插件整目录替换掉,而用户根本没看到那些内容。
        if let Some(dir) = &existing {
            draft_of(dir)?;
            check_editable_dir(dir)?;
        }
        // 保存会整目录替换,所以命令引用的脚本必须在这次提交的文件里。
        if let Some(exec) = &manifest.exec {
            check_command_file(&exec.command, &exec.args, &files)?;
        }
        std::fs::create_dir_all(root)
            .map_err(|err| KbError::Internal(format!("创建 skills 目录失败: {err}")))?;
        let scratch = scratch_dir(root);
        std::fs::create_dir(&scratch)
            .map_err(|err| KbError::Internal(format!("创建临时目录失败: {err}")))?;
        let result = (|| {
            for file in &files {
                write_plugin_file(&scratch, file)?;
            }
            // 校验时按启用加载:停用插件会被 load_one 直接跳过,内部错误发现不了。
            let real_enabled = manifest.enabled;
            manifest.enabled = Some(true);
            write_manifest(&scratch.join("manifest.toml"), &manifest)?;
            SkillRegistry::default()
                .load_one(&scratch, true)
                .map_err(|err| invalid(format!("这个插件加载不了:{err}")))?;
            manifest.enabled = real_enabled;
            write_manifest(&scratch.join("manifest.toml"), &manifest)?;
            commit(root, &scratch, existing.as_deref(), &manifest)
        })();
        let _ = std::fs::remove_dir_all(&scratch);
        result
    }

    /// 取插件可编辑内容(设置页点「编辑」)。
    pub fn plugin_draft(&self, id: &str) -> Result<PluginDraft> {
        let info = self
            .skills
            .iter()
            .find(|info| info.id == id)
            .ok_or_else(|| KbError::NotFound(format!("skill {id}")))?;
        if info.kind != SkillKind::Plugin.as_str() {
            return Err(invalid("这个 skill 不是插件"));
        }
        let root = self
            .dir
            .as_ref()
            .ok_or_else(|| KbError::NotFound("skills 目录".to_owned()))?;
        draft_of(&root.join(id))
    }

    /// 只翻转 `enabled`,不重写插件文件。用于列表里的启用 / 停用。
    pub fn set_enabled(root: &Path, id: &str, enabled: bool) -> Result<()> {
        let dir = skill_dir(root, id)?;
        let path = dir.join("manifest.toml");
        let text = std::fs::read_to_string(&path)
            .map_err(|err| KbError::Internal(format!("读 {} 失败: {err}", path.display())))?;
        let mut manifest: Manifest = toml::from_str(&text)
            .map_err(|err| invalid(format!("manifest.toml 解析失败: {err}")))?;
        manifest.enabled = Some(enabled);
        let temp = dir.join(format!(".manifest-{}.tmp", uuid::Uuid::now_v7().simple()));
        write_manifest(&temp, &manifest)?;
        std::fs::rename(&temp, &path)
            .map_err(|err| KbError::Internal(format!("保存插件状态失败: {err}")))
    }
}

/// 提交临时目录:新装直接改名;覆盖时先把旧目录挪到备份,失败则挪回来。
fn commit(
    root: &Path,
    scratch: &Path,
    existing: Option<&Path>,
    manifest: &Manifest,
) -> Result<String> {
    match existing {
        Some(dir) => {
            let backup = root.join(format!(".backup-{}", uuid::Uuid::now_v7().simple()));
            std::fs::rename(dir, &backup)
                .map_err(|err| KbError::Internal(format!("准备替换旧插件失败: {err}")))?;
            if let Err(err) = std::fs::rename(scratch, dir) {
                let _ = std::fs::rename(&backup, dir);
                return Err(KbError::Internal(format!("保存插件失败: {err}")));
            }
            let _ = std::fs::remove_dir_all(&backup);
            Ok(dir_id(dir))
        }
        None => {
            let name = manifest.name.clone().unwrap_or_default();
            let slug = unique_slug(root, &name);
            std::fs::rename(scratch, root.join(&slug))
                .map_err(|err| KbError::Internal(format!("保存插件失败: {err}")))?;
            Ok(slug)
        }
    }
}

fn dir_id(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(name: &str) -> PluginDraft {
        PluginDraft {
            name: name.to_owned(),
            version: "0.1.0".to_owned(),
            include: vec!["**/*.vue".to_owned()],
            lang: "vue".to_owned(),
            exec: Some(PluginExecDraft {
                command: "python3".to_owned(),
                args: vec!["plugin.py".to_owned()],
                hooks: vec!["chunk".to_owned()],
                timeout_ms: 20_000,
                max_output_bytes: 1024 * 1024,
            }),
            files: vec![PluginFileDraft {
                path: "plugin.py".to_owned(),
                content: "print('ok')".to_owned(),
            }],
            ..PluginDraft::default()
        }
    }

    #[test]
    fn plugin_draft_round_trips_through_manifest() {
        let (manifest, files) = to_manifest(&draft("demo")).expect("生成清单");
        assert_eq!(files.len(), 1);
        assert_eq!(manifest.kind, SkillKind::Plugin);
        assert_eq!(manifest.version.as_deref(), Some("0.1.0"));
        assert_eq!(
            manifest.index.as_ref().expect("index").include,
            ["**/*.vue"]
        );
        assert_eq!(
            manifest.exec.as_ref().expect("exec").hooks,
            vec![PluginHook::Chunk]
        );
    }

    #[test]
    fn unsupported_permissions_are_rejected_before_writing_a_manifest() {
        for field in ["read_project", "llm"] {
            let mut draft = draft("demo");
            match field {
                "read_project" => draft.permissions.read_project = true,
                "llm" => draft.permissions.llm = true,
                _ => unreachable!(),
            }
            let err = to_manifest(&draft).expect_err("未开放权限必须拒绝");
            let message = err.to_string();
            assert!(message.contains(field), "{field}: {message}");
            assert!(message.contains("未开放"), "{field}: {message}");
        }
    }

    #[test]
    fn save_plugin_refuses_to_replace_a_non_plugin_skill() {
        let root = std::env::temp_dir().join(format!(
            "kb-plugin-save-guard-{}",
            uuid::Uuid::now_v7().simple()
        ));
        let dir = root.join("notes");
        std::fs::create_dir_all(&dir).expect("建目录");
        std::fs::write(
 dir.join("manifest.toml"),
 "type = \"insight-template\"\nname = \"notes\"\n[\"insight-template\"]\nrequired = [\"title\"]\n",
 )
 .expect("写清单");
        let err = SkillRegistry::save_plugin(&root, Some("notes"), &draft("notes"))
            .expect_err("不能把笔记模板覆盖成插件");
        assert!(err.to_string().contains("不是插件"), "{err}");
        assert!(dir.join("manifest.toml").is_file(), "原 skill 必须原样保留");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn save_plugin_refuses_files_the_form_cannot_show() {
        let root = std::env::temp_dir().join(format!(
            "kb-plugin-save-files-{}",
            uuid::Uuid::now_v7().simple()
        ));
        let mut draft = draft("demo");
        let exec = draft.exec.as_mut().expect("exec");
        exec.command = "scripts/plugin.py".to_owned();
        exec.args = vec!["scripts/plugin.py".to_owned()];
        draft.files = vec![PluginFileDraft {
            path: "scripts/plugin.py".to_owned(),
            content: "print('ok')".to_owned(),
        }];
        let id = SkillRegistry::save_plugin(&root, None, &draft).expect("先装一个插件");
        let dir = root.join(&id);

        // 命令引用的脚本被移除:保存后插件就起不来了,必须在提交前拒绝。
        let mut missing_script = draft.clone();
        missing_script.files.clear();
        let err = SkillRegistry::save_plugin(&root, Some(&id), &missing_script)
            .expect_err("不能删掉命令引用的脚本");
        assert!(err.to_string().contains("不在这次提交"), "{err}");

        // 表单读不出来的文件会被整目录替换静默删掉,也要拒绝。
        std::fs::write(dir.join("blob.bin"), [0u8, 1, 2]).expect("写二进制");
        let err = SkillRegistry::save_plugin(&root, Some(&id), &draft)
            .expect_err("不能静默删掉读不到的文件");
        assert!(err.to_string().contains("二进制"), "{err}");
        assert!(
            dir.join("scripts/plugin.py").is_file(),
            "旧插件必须原样保留"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn plugin_args_that_point_at_missing_scripts_are_rejected() {
        let files = vec![PluginFileDraft {
            path: "plugin.py".to_owned(),
            content: String::new(),
        }];
        assert!(check_command_file("python3", &["plugin.py".to_owned()], &files).is_ok());
        assert!(check_command_file("plugin.py", &[], &files).is_ok());
        let err = check_command_file("missing.py", &[], &files).expect_err("裸脚本命令也要存在");
        assert!(err.to_string().contains("missing.py"), "{err}");
        assert!(check_command_file("python3", &["./plugin.py".to_owned()], &files).is_ok());
        // 模式参数 / URL / 选项不是文件引用,不能误伤。
        assert!(check_command_file("python3", &["vue".to_owned()], &files).is_ok());
        assert!(
            check_command_file("python3", &["https://example.com/x".to_owned()], &files).is_ok()
        );
        assert!(check_command_file("python3", &["--config=x.json".to_owned()], &files).is_ok());
        let err = check_command_file("python3", &["missing.py".to_owned()], &files)
            .expect_err("缺脚本必须拒绝");
        assert!(err.to_string().contains("missing.py"), "{err}");
    }

    #[test]
    fn plugin_file_paths_cannot_escape_or_shadow_manifest() {
        for path in [
            "../x.py",
            "/x.py",
            ".env",
            "manifest.toml",
            "a\\b.py",
            "a/",
            "a//b.py",
        ] {
            let mut bad = draft("bad");
            bad.files[0].path = path.to_owned();
            let err = to_manifest(&bad).expect_err("必须拒绝");
            assert!(matches!(err, KbError::InvalidInput(_)), "{path}: {err}");
        }
        // 子目录里的 manifest.toml 是插件资源,不能被当成根清单挡掉。
        let mut nested = draft("nested");
        nested.files[0].path = "nested/manifest.toml".to_owned();
        assert!(to_manifest(&nested).is_ok());
    }

    #[test]
    fn hooks_and_source_must_match() {
        let mut bad = draft("bad");
        bad.source = Some(PluginSourceDraft {
            match_uri: vec!["https://example.com/*".to_owned()],
            ..PluginSourceDraft::default()
        });
        let err = to_manifest(&bad).expect_err("没有 source 钩子");
        assert!(err.to_string().contains("source"), "{err}");
        bad.exec.as_mut().expect("exec").hooks = vec!["source".to_owned()];
        bad.source = None;
        let err = to_manifest(&bad).expect_err("没有来源规则");
        assert!(err.to_string().contains("来源"), "{err}");
        bad.source = Some(PluginSourceDraft {
            match_uri: vec!["https://example.com/*".to_owned()],
            priority: 2000,
            ..PluginSourceDraft::default()
        });
        let err = to_manifest(&bad).expect_err("来源优先级越界");
        assert!(err.to_string().contains("优先级"), "{err}");
    }
}
