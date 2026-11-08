//! 编辑器扩展的本地可信目录加载器。
//!
//! 第三方扩展 v1 只支持「管理员自己放进 `<KB_HOME>/editor-extensions/<id>/` 的目录」:
//! - `GET /api/v1/editor/extensions`:列出目录下每个扩展的清单(`manifest.toml` 由这里解析并校验);
//! - `GET /api/v1/editor/extensions/{id}/{file}`:下发扩展目录里的静态文件(`.js` / `.css` / `.json` / `.svg`)。
//!
//! 守护进程**不执行**任何扩展代码:入口脚本由浏览器用同源的动态 `import` 加载,所以站点 CSP
//! (`script-src 'self'`)不需要放宽。正因为脚本会在页面里以登录者的权限运行,两个接口都只对管理员开放,
//! 并且 `[editor] extensions` 默认关。
//!
//! 清单校验规则与前端 `web-ui/src/editor/extensions/manifest.ts` 逐条一致;两边共用
//! `tests/fixtures/editor-manifest-cases.json` 里的用例,改规则时两边的测试会一起变红。

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Component, Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Value, json};

use crate::api::{self, AppState};
use crate::auth::Identity;

/// 清单文件名。
pub const MANIFEST_FILE: &str = "manifest.toml";
/// 当前宿主支持的扩展 API 版本(`api_version` 必须等于它)。
pub const API_VERSION: u64 = 1;
/// 清单文件大小上限:一份清单不该超过几 KB,更大的多半不是清单。
pub const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
/// 单个扩展文件大小上限。扩展脚本是人写的源码,8 MB 已经远超需要;防的是误放一个大文件拖垮内存。
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// 一次最多扫描的扩展目录个数,防止目录里被塞进成千上万个子目录拖慢清单接口。
pub const MAX_EXTENSIONS: usize = 128;

/// 可声明的权限(与前端 `permissions.ts` 的 `PERMISSIONS` 一致)。
pub const PERMISSIONS: [&str; 6] = [
    "document.read",
    "document.write",
    "clipboard",
    "network",
    "ai",
    "ui",
];

/// 允许下发的文件类型 → `Content-Type`。白名单之外(含 `manifest.toml` 本身)一律不给。
const SERVED_TYPES: [(&str, &str); 4] = [
    ("js", "text/javascript; charset=utf-8"),
    ("css", "text/css; charset=utf-8"),
    ("json", "application/json"),
    ("svg", "image/svg+xml"),
];

/// 带标题的贡献项(命令、AI 工具)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Titled {
    /// 贡献 id(以扩展 id + `.` 开头)。
    pub id: String,
    /// 给人看的名字。
    pub title: String,
}

/// 只有 id 的贡献项(工具栏按钮、斜杠菜单项)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct IdOnly {
    /// 贡献 id。
    pub id: String,
}

/// 面板声明。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PanelDecl {
    /// 贡献 id。
    pub id: String,
    /// 面板标题。
    pub title: String,
    /// 工具栏开关按钮上的短图标(可选)。
    pub icon: Option<String>,
}

/// 声明接管若干扩展名的贡献项(Codec、内容面)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FormatDecl {
    /// 贡献 id。
    pub id: String,
    /// 接管的扩展名(小写、不带点)。
    pub extensions: Vec<String>,
}

/// `[contributes]`:扩展声明自己会注册哪些东西。运行时注册的 id 必须在这里出现过。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Contributes {
    /// 命令。
    pub commands: Vec<Titled>,
    /// 工具栏按钮。
    pub toolbar: Vec<IdOnly>,
    /// 斜杠菜单项。
    pub slash: Vec<IdOnly>,
    /// 面板。
    pub panels: Vec<PanelDecl>,
    /// Codec。
    pub codecs: Vec<FormatDecl>,
    /// 内容面。
    pub surfaces: Vec<FormatDecl>,
    /// AI 工具。
    pub ai_tools: Vec<Titled>,
}

/// 通过校验的清单(JSON 形状就是接口返回的 `manifest`)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Manifest {
    /// 扩展 id,必须等于目录名。
    pub id: String,
    /// 显示名。
    pub name: String,
    /// semver 版本。
    pub version: String,
    /// 扩展 API 版本。
    pub api_version: u64,
    /// 一句话说明。
    pub description: Option<String>,
    /// 入口脚本(相对扩展目录)。
    pub entry: String,
    /// 申请的权限(去重、保持声明顺序)。
    pub permissions: Vec<String>,
    /// 声明的贡献。
    pub contributes: Contributes,
}

// ---------------------------------------------------------------- 清单校验

/// 扩展 id:`^[a-z0-9]+([.-][a-z0-9]+)*$`,最长 64。
pub fn is_valid_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 {
        return false;
    }
    let mut previous_separator = true; // 开头按「刚遇到分隔符」处理,于是开头不能是分隔符
    for ch in id.chars() {
        match ch {
            'a'..='z' | '0'..='9' => previous_separator = false,
            '.' | '-' if !previous_separator => previous_separator = true,
            _ => return false,
        }
    }
    !previous_separator
}

/// 贡献 id 的后缀:`^[A-Za-z0-9]+([._-][A-Za-z0-9]+)*$`。
fn is_valid_suffix(suffix: &str) -> bool {
    let mut previous_separator = true;
    for ch in suffix.chars() {
        match ch {
            c if c.is_ascii_alphanumeric() => previous_separator = false,
            '.' | '_' | '-' if !previous_separator => previous_separator = true,
            _ => return false,
        }
    }
    !previous_separator
}

/// semver 2.0:`MAJOR.MINOR.PATCH[-预发布][+构建]`,数字段不带前导零。
pub fn is_valid_semver(version: &str) -> bool {
    fn numeric_ok(part: &str) -> bool {
        !part.is_empty()
            && part.chars().all(|ch| ch.is_ascii_digit())
            && (part == "0" || !part.starts_with('0'))
    }
    fn identifiers_ok(text: &str, forbid_leading_zero: bool) -> bool {
        !text.is_empty()
            && text.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
                    && !(forbid_leading_zero
                        && part.chars().all(|ch| ch.is_ascii_digit())
                        && part.len() > 1
                        && part.starts_with('0'))
            })
    }
    if version.len() > 64 {
        return false;
    }
    let (rest, build) = match version.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (version, None),
    };
    if build.is_some_and(|build| !identifiers_ok(build, false)) {
        return false;
    }
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    if pre.is_some_and(|pre| !identifiers_ok(pre, true)) {
        return false;
    }
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|part| numeric_ok(part))
}

/// 入口 / 内部文件的相对路径:每段 `[A-Za-z0-9._-]+`,不以 `.` 开头,总长 ≤ 128。
fn is_safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 128
        && path.split('/').all(|segment| {
            !segment.is_empty()
                && !segment.starts_with('.')
                && segment
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        })
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}

/// 校验并规范化一份清单(`raw` 是 `manifest.toml` 转出来的 JSON 树)。
///
/// 一次报出所有问题(而不是遇到第一个就停),管理员改一遍就能过。
/// 未识别的键一律忽略:`api_version` 不变的前提下允许新增可选字段,旧宿主不能因此拒绝新清单。
pub fn validate_manifest(raw: &Value) -> Result<Manifest, Vec<String>> {
    let mut errors = Vec::new();
    let Some(table) = raw.as_object() else {
        return Err(vec!["清单必须是一个键值表".to_owned()]);
    };

    let id = match table.get("id").and_then(Value::as_str) {
        Some(id) if is_valid_id(id) => id.to_owned(),
        Some(id) => {
            errors.push(format!(
                "id「{id}」不合法:只能用小写字母、数字、`.` 和 `-`,不能以分隔符开头或结尾,最长 64 个字符"
            ));
            String::new()
        }
        None => {
            errors.push("缺少 id(字符串)".to_owned());
            String::new()
        }
    };

    let name = match table.get("name").and_then(Value::as_str).map(str::trim) {
        Some(name) if !name.is_empty() && char_len(name) <= 80 => name.to_owned(),
        Some(_) => {
            errors.push("name 不能为空,且不超过 80 个字符".to_owned());
            String::new()
        }
        None => {
            errors.push("缺少 name(字符串)".to_owned());
            String::new()
        }
    };

    let version = match table.get("version").and_then(Value::as_str) {
        Some(version) if is_valid_semver(version) => version.to_owned(),
        Some(version) => {
            errors.push(format!(
                "version「{version}」不是 semver(形如 1.2.3、1.0.0-beta.1)"
            ));
            String::new()
        }
        None => {
            errors.push("缺少 version(semver 字符串)".to_owned());
            String::new()
        }
    };

    let api_version = match table.get("api_version") {
        Some(value) => match value.as_u64() {
            Some(API_VERSION) => API_VERSION,
            Some(other) if other > API_VERSION => {
                errors.push(format!(
                    "api_version = {other} 需要更新版本的编辑器扩展 API(这个编辑器支持 {API_VERSION}),请升级编辑器,或使用面向 {API_VERSION} 的扩展版本"
                ));
                0
            }
            _ => {
                errors.push(format!("api_version 必须是整数 {API_VERSION}"));
                0
            }
        },
        None => {
            errors.push(format!("缺少 api_version(当前为 {API_VERSION})"));
            0
        }
    };

    let description = match table.get("description") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if char_len(text) <= 500 => Some(text.clone()),
        Some(_) => {
            errors.push("description 必须是不超过 500 个字符的字符串".to_owned());
            None
        }
    };

    let entry = match table.get("entry") {
        None | Some(Value::Null) => "index.js".to_owned(),
        Some(Value::String(entry)) if is_safe_relative_path(entry) && entry.ends_with(".js") => {
            entry.clone()
        }
        Some(_) => {
            errors.push(
                "entry 必须是扩展目录内的 .js 文件(相对路径,每段只含字母、数字、`.`、`_`、`-`,不能以 `.` 开头)"
                    .to_owned(),
            );
            "index.js".to_owned()
        }
    };

    let mut permissions: Vec<String> = Vec::new();
    match table.get("permissions") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => {
            for (index, item) in list.iter().enumerate() {
                match item.as_str() {
                    Some(name) if PERMISSIONS.contains(&name) => {
                        if !permissions.iter().any(|existing| existing == name) {
                            permissions.push(name.to_owned());
                        }
                    }
                    Some(name) => errors.push(format!(
                        "permissions[{index}] 是未知权限「{name}」(可用:{})",
                        PERMISSIONS.join("、")
                    )),
                    None => errors.push(format!("permissions[{index}] 必须是字符串")),
                }
            }
        }
        Some(_) => errors.push("permissions 必须是字符串数组".to_owned()),
    }

    let contributes = match table.get("contributes") {
        None | Some(Value::Null) => Contributes::default(),
        Some(Value::Object(section)) => parse_contributes(section, &id, &mut errors),
        Some(_) => {
            errors.push("contributes 必须是一个表".to_owned());
            Contributes::default()
        }
    };

    if errors.is_empty() {
        Ok(Manifest {
            id,
            name,
            version,
            api_version,
            description,
            entry,
            permissions,
            contributes,
        })
    } else {
        Err(errors)
    }
}

/// 取 `contributes.<key>` 的数组;缺省当空;不是数组记一条错。
fn contribution_list<'a>(
    section: &'a serde_json::Map<String, Value>,
    key: &str,
    errors: &mut Vec<String>,
) -> &'a [Value] {
    match section.get(key) {
        None | Some(Value::Null) => &[],
        Some(Value::Array(list)) => list,
        Some(_) => {
            errors.push(format!(
                "contributes.{key} 必须是数组(用 [[contributes.{key}]] 书写)"
            ));
            &[]
        }
    }
}

/// 校验一条贡献的 id:必须带扩展 id 前缀,同一类里不能重复。
fn contribution_id(
    item: &serde_json::Map<String, Value>,
    where_: &str,
    extension_id: &str,
    seen: &mut BTreeSet<String>,
    errors: &mut Vec<String>,
) -> Option<String> {
    let Some(id) = item.get("id").and_then(Value::as_str) else {
        errors.push(format!("{where_}.id 缺失(字符串)"));
        return None;
    };
    let prefix = format!("{extension_id}.");
    let suffix_ok = id.strip_prefix(&prefix).is_some_and(is_valid_suffix);
    // 扩展 id 本身不合法时已经报过错,这里不再重复指责前缀
    if !extension_id.is_empty() && (!suffix_ok || id.len() > 128) {
        errors.push(format!(
            "{where_}.id「{id}」必须以「{prefix}」开头,后面只含字母、数字、`.`、`_`、`-`(带上扩展 id 前缀才不会和内置功能或别的扩展重名)"
        ));
        return None;
    }
    if !seen.insert(id.to_owned()) {
        errors.push(format!("{where_}.id「{id}」重复"));
        return None;
    }
    Some(id.to_owned())
}

fn required_title(
    item: &serde_json::Map<String, Value>,
    where_: &str,
    errors: &mut Vec<String>,
) -> Option<String> {
    match item.get("title").and_then(Value::as_str).map(str::trim) {
        Some(title) if !title.is_empty() && char_len(title) <= 80 => Some(title.to_owned()),
        _ => {
            errors.push(format!("{where_}.title 必须是 1 到 80 个字符的字符串"));
            None
        }
    }
}

/// 扩展名:小写字母数字、1..=16 个字符、不带点。
fn extension_list(
    item: &serde_json::Map<String, Value>,
    where_: &str,
    errors: &mut Vec<String>,
) -> Vec<String> {
    let mut out = Vec::new();
    match item.get("extensions") {
        Some(Value::Array(list)) if !list.is_empty() && list.len() <= 8 => {
            for (index, value) in list.iter().enumerate() {
                match value.as_str() {
                    Some(ext)
                        if (1..=16).contains(&ext.len())
                            && ext
                                .chars()
                                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit()) =>
                    {
                        if !out.iter().any(|existing| existing == ext) {
                            out.push(ext.to_owned());
                        }
                    }
                    _ => errors.push(format!(
                        "{where_}.extensions[{index}] 必须是小写字母数字组成的扩展名(不带点,最长 16 个字符)"
                    )),
                }
            }
        }
        _ => errors.push(format!("{where_}.extensions 必须是 1 到 8 个扩展名的数组")),
    }
    out
}

fn parse_contributes(
    section: &serde_json::Map<String, Value>,
    extension_id: &str,
    errors: &mut Vec<String>,
) -> Contributes {
    let mut out = Contributes::default();

    // 取出每一项的表;不是表的记错并跳过
    fn tables<'a>(
        list: &'a [Value],
        key: &str,
        errors: &mut Vec<String>,
    ) -> Vec<(String, &'a serde_json::Map<String, Value>)> {
        list.iter()
            .enumerate()
            .filter_map(|(index, value)| {
                let where_ = format!("contributes.{key}[{index}]");
                match value.as_object() {
                    Some(table) => Some((where_, table)),
                    None => {
                        errors.push(format!("{where_} 必须是一个表"));
                        None
                    }
                }
            })
            .collect()
    }

    for key in ["commands", "ai_tools"] {
        let mut seen = BTreeSet::new();
        for (where_, item) in tables(contribution_list(section, key, errors), key, errors) {
            let id = contribution_id(item, &where_, extension_id, &mut seen, errors);
            let title = required_title(item, &where_, errors);
            if let (Some(id), Some(title)) = (id, title) {
                let target = if key == "commands" {
                    &mut out.commands
                } else {
                    &mut out.ai_tools
                };
                target.push(Titled { id, title });
            }
        }
    }

    for key in ["toolbar", "slash"] {
        let mut seen = BTreeSet::new();
        for (where_, item) in tables(contribution_list(section, key, errors), key, errors) {
            if let Some(id) = contribution_id(item, &where_, extension_id, &mut seen, errors) {
                let target = if key == "toolbar" {
                    &mut out.toolbar
                } else {
                    &mut out.slash
                };
                target.push(IdOnly { id });
            }
        }
    }

    let mut seen = BTreeSet::new();
    for (where_, item) in tables(
        contribution_list(section, "panels", errors),
        "panels",
        errors,
    ) {
        let id = contribution_id(item, &where_, extension_id, &mut seen, errors);
        let title = required_title(item, &where_, errors);
        let icon = match item.get("icon") {
            None | Some(Value::Null) => None,
            Some(Value::String(icon)) if !icon.is_empty() && char_len(icon) <= 8 => {
                Some(icon.clone())
            }
            Some(_) => {
                errors.push(format!("{where_}.icon 必须是不超过 8 个字符的字符串"));
                None
            }
        };
        if let (Some(id), Some(title)) = (id, title) {
            out.panels.push(PanelDecl { id, title, icon });
        }
    }

    for key in ["codecs", "surfaces"] {
        let mut seen = BTreeSet::new();
        for (where_, item) in tables(contribution_list(section, key, errors), key, errors) {
            let id = contribution_id(item, &where_, extension_id, &mut seen, errors);
            let extensions = extension_list(item, &where_, errors);
            if let Some(id) = id
                && !extensions.is_empty()
            {
                let target = if key == "codecs" {
                    &mut out.codecs
                } else {
                    &mut out.surfaces
                };
                target.push(FormatDecl { id, extensions });
            }
        }
    }
    out
}

/// 解析 `manifest.toml` 文本并校验。TOML 语法错误也按「清单问题」返回,不抛。
pub fn parse_manifest_toml(text: &str) -> Result<Manifest, Vec<String>> {
    let value: toml::Value =
        toml::from_str(text).map_err(|err| vec![format!("manifest.toml 不是合法的 TOML:{err}")])?;
    // toml::Value → serde_json::Value:日期时间等 TOML 独有类型会变成表,随后被字段类型校验拒绝
    let json =
        serde_json::to_value(value).map_err(|err| vec![format!("manifest.toml 无法转换:{err}")])?;
    validate_manifest(&json)
}

// ---------------------------------------------------------------- 目录扫描

/// 清单接口里的一项。
#[derive(Debug, Serialize)]
pub struct ExtensionEntry {
    /// 扩展 id;清单读不出来时用目录名。
    pub id: String,
    /// 目录名(相对扩展根目录)。
    pub dir: String,
    /// 通过校验的清单;有问题时为 `null`。
    pub manifest: Option<Manifest>,
    /// 有问题时的原因(多条用「;」连接)。
    pub error: Option<String>,
}

/// 读取一个扩展目录:清单、目录名 = id、入口文件存在。
fn read_extension(root: &FsPath, dir_name: &str) -> ExtensionEntry {
    let fail = |message: String| ExtensionEntry {
        id: dir_name.to_owned(),
        dir: dir_name.to_owned(),
        manifest: None,
        error: Some(message),
    };
    if !is_valid_id(dir_name) {
        return fail(format!(
            "目录名「{dir_name}」不是合法的扩展 id(小写字母、数字、`.`、`-`),请改目录名"
        ));
    }
    let ext_dir = root.join(dir_name);
    let manifest_path = match resolve_inside(&ext_dir, MANIFEST_FILE) {
        Ok(path) => path,
        Err(FileError::NotFound) => return fail("缺少 manifest.toml".to_owned()),
        Err(err) => return fail(format!("manifest.toml 不可用:{}", err.message())),
    };
    let text = match read_capped(&manifest_path, MAX_MANIFEST_BYTES) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => return fail("manifest.toml 不是 UTF-8 文本".to_owned()),
        },
        Err(FileError::TooLarge) => {
            return fail(format!(
                "manifest.toml 超过 {} KB",
                MAX_MANIFEST_BYTES / 1024
            ));
        }
        Err(err) => return fail(format!("读取 manifest.toml 失败:{}", err.message())),
    };
    let manifest = match parse_manifest_toml(&text) {
        Ok(manifest) => manifest,
        Err(errors) => return fail(errors.join(";")),
    };
    if manifest.id != dir_name {
        return fail(format!(
            "目录名「{dir_name}」与清单里的 id「{}」不一致(目录名必须等于 id)",
            manifest.id
        ));
    }
    // 入口必须真的在:否则前端 import 会得到一个 404,报错信息反而更难懂
    if let Err(err) = resolve_inside(&ext_dir, &manifest.entry) {
        return fail(format!(
            "入口文件 {} 不可用:{}",
            manifest.entry,
            err.message()
        ));
    }
    ExtensionEntry {
        id: manifest.id.clone(),
        dir: dir_name.to_owned(),
        manifest: Some(manifest),
        error: None,
    }
}

/// 扫描扩展根目录。根目录不存在 = 一个扩展都没有(不是错误)。
pub fn scan_extensions(root: &FsPath) -> Vec<ExtensionEntry> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        // 扩展根目录下的子目录(含指向目录的符号链接:管理员有意把开发中的目录链进来);
        // 普通文件、隐藏项忽略
        .filter(|entry| std::fs::metadata(entry.path()).is_ok_and(|meta| meta.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort();
    names.truncate(MAX_EXTENSIONS);
    names
        .iter()
        .map(|name| read_extension(root, name))
        .collect()
}

// ---------------------------------------------------------------- 安全取文件

/// 取文件失败的原因。
#[derive(Debug, PartialEq, Eq)]
pub enum FileError {
    /// 请求路径的形状不对(含 `..`、非法字符、不在白名单里的类型)。
    Invalid(String),
    /// 路径上有符号链接。
    Symlink,
    /// 不存在或不是普通文件。
    NotFound,
    /// 超过大小上限。
    TooLarge,
    /// 读取失败。
    Io(String),
}

impl FileError {
    fn message(&self) -> String {
        match self {
            Self::Invalid(message) | Self::Io(message) => message.clone(),
            Self::Symlink => "扩展目录里不允许符号链接".to_owned(),
            Self::NotFound => "文件不存在".to_owned(),
            Self::TooLarge => "文件过大".to_owned(),
        }
    }
}

/// 把请求里的相对路径拆成安全的段:每段 `[A-Za-z0-9._-]+`、不以 `.` 开头。
///
/// 白名单字符集一并挡住了反斜杠、`%`(二次编码)、NUL、空格与各种控制字符;
/// `..` 因为以 `.` 开头被挡。
fn safe_segments(path: &str) -> Result<Vec<&str>, FileError> {
    if !is_safe_relative_path(path) {
        return Err(FileError::Invalid(
            "文件路径不合法:每段只能含字母、数字、`.`、`_`、`-`,且不能以 `.` 开头".to_owned(),
        ));
    }
    Ok(path.split('/').collect())
}

/// 在扩展目录 `ext_dir` 里解析 `relative`,返回规范化后的真实文件路径。
///
/// 防护三层(任何一层不过都拒绝):
/// 1. 路径段白名单(见 [`safe_segments`]),不给 `..`、绝对路径、编码绕过留空间;
/// 2. 逐段 `symlink_metadata`:扩展目录**里面**不允许符号链接(`ext_dir` 本身可以是链接,
///    那是管理员自己放的);
/// 3. 最终 `canonicalize` 后必须仍在 `ext_dir` 的真实路径之内。
pub fn resolve_inside(ext_dir: &FsPath, relative: &str) -> Result<PathBuf, FileError> {
    let segments = safe_segments(relative)?;
    let base = std::fs::canonicalize(ext_dir).map_err(|_| FileError::NotFound)?;
    if !base.is_dir() {
        return Err(FileError::NotFound);
    }
    let mut current = base.clone();
    for (index, segment) in segments.iter().enumerate() {
        current.push(segment);
        let meta = std::fs::symlink_metadata(&current).map_err(|_| FileError::NotFound)?;
        if meta.file_type().is_symlink() {
            return Err(FileError::Symlink);
        }
        let last = index + 1 == segments.len();
        if last && !meta.is_file() {
            return Err(FileError::NotFound);
        }
        if !last && !meta.is_dir() {
            return Err(FileError::NotFound);
        }
    }
    let real = std::fs::canonicalize(&current).map_err(|_| FileError::NotFound)?;
    // 路径组件里不会再有 `..`(第 1 层已挡),这里是兜底:任何手段把路径带到目录外都会在此失败
    if !real.starts_with(&base)
        || real
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(FileError::Invalid("文件不在扩展目录内".to_owned()));
    }
    Ok(real)
}

/// 读文件,最多 `limit` 字节;超过就报 [`FileError::TooLarge`](不是截断)。
fn read_capped(path: &FsPath, limit: u64) -> Result<Vec<u8>, FileError> {
    let file = std::fs::File::open(path).map_err(|err| FileError::Io(err.to_string()))?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| FileError::Io(err.to_string()))?;
    if bytes.len() as u64 > limit {
        return Err(FileError::TooLarge);
    }
    Ok(bytes)
}

/// 文件名 → 下发时的 `Content-Type`;不在白名单里返回 `None`。
fn served_type(file: &str) -> Option<&'static str> {
    let ext = file.rsplit_once('.')?.1.to_ascii_lowercase();
    SERVED_TYPES
        .iter()
        .find(|(known, _)| *known == ext)
        .map(|(_, mime)| *mime)
}

/// 取一个扩展文件的内容和类型(同步,放进 `spawn_blocking` 里用)。
pub fn read_extension_file(
    root: &FsPath,
    id: &str,
    file: &str,
) -> Result<(Vec<u8>, &'static str), FileError> {
    if !is_valid_id(id) {
        return Err(FileError::Invalid("扩展 id 不合法".to_owned()));
    }
    let Some(mime) = served_type(file) else {
        return Err(FileError::Invalid(
            "只提供 .js / .css / .json / .svg 文件".to_owned(),
        ));
    };
    let path = resolve_inside(&root.join(id), file)?;
    let bytes = read_capped(&path, MAX_FILE_BYTES)?;
    Ok((bytes, mime))
}

// ---------------------------------------------------------------- HTTP

fn deny(status: StatusCode, code: &str, message: &str) -> Response {
    api::error(status, code, message)
}

/// 只允许管理员(能改系统参数)用:浏览器会话、admin key 或本机 socket,API 令牌 / ACP 伴生不行。
///
/// 扩展脚本会在页面里以登录者的权限运行,所以「谁能拿到扩展清单和代码」也只给负责系统参数的人。
#[allow(clippy::result_large_err)]
fn require_admin(identity: Option<&Identity>) -> Result<(), Response> {
    let Some(identity) = identity else {
        return Err(deny(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录"));
    };
    if !(identity.acts_as_account() || identity.is_local())
        || !identity.principal.features.allows("sys.settings")
    {
        return Err(deny(
            StatusCode::FORBIDDEN,
            "forbidden",
            "编辑器扩展只对管理员开放",
        ));
    }
    Ok(())
}

/// `GET /api/v1/editor/extensions`:列出扩展目录里的所有扩展。
pub async fn list(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
) -> Response {
    if let Err(response) = require_admin(extensions.get::<Identity>()) {
        return response;
    }
    // 开关每个请求现读:改了 config.toml 立即生效,不用重启
    let config = state.account.config.get();
    if !config.editor.extensions {
        return api::ok(json!({ "enabled": false, "extensions": [] }));
    }
    let root = config.editor.resolved_dir(&state.account.home);
    let shown = root.display().to_string();
    let scanned = tokio::task::spawn_blocking(move || scan_extensions(&root)).await;
    match scanned {
        Ok(entries) => api::ok(json!({ "enabled": true, "dir": shown, "extensions": entries })),
        Err(_) => deny(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "扫描扩展目录失败",
        ),
    }
}

/// `GET /api/v1/editor/extensions/{id}/{file}`:下发扩展目录里的一个静态文件。
pub async fn file(
    State(state): State<Arc<AppState>>,
    Path((id, file)): Path<(String, String)>,
    extensions: axum::http::Extensions,
) -> Response {
    if let Err(response) = require_admin(extensions.get::<Identity>()) {
        return response;
    }
    let config = state.account.config.get();
    if !config.editor.extensions {
        return deny(StatusCode::NOT_FOUND, "not_found", "编辑器扩展未启用");
    }
    let root = config.editor.resolved_dir(&state.account.home);
    let is_svg = file.to_ascii_lowercase().ends_with(".svg");
    let read = tokio::task::spawn_blocking(move || read_extension_file(&root, &id, &file)).await;
    let result = match read {
        Ok(result) => result,
        Err(_) => {
            return deny(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "读取扩展文件失败",
            );
        }
    };
    match result {
        Ok((bytes, mime)) => {
            let mut response = (StatusCode::OK, bytes).into_response();
            let headers = response.headers_mut();
            headers.insert(CONTENT_TYPE, HeaderValue::from_static(mime));
            // 改了脚本要立刻看到:不缓存(扩展是开发中的东西,文件很小)
            headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            if is_svg {
                // 直接打开 SVG 会在管理端同源执行其中的脚本;沙箱化让它只能当图片用
                headers.insert(CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox"));
            }
            headers.remove(CONTENT_LENGTH); // 交给 hyper 按实际正文重算
            response
        }
        Err(FileError::Invalid(message)) => {
            deny(StatusCode::BAD_REQUEST, "invalid_input", &message)
        }
        Err(FileError::Symlink) => deny(
            StatusCode::FORBIDDEN,
            "forbidden",
            "扩展目录里不允许符号链接",
        ),
        Err(FileError::NotFound) => deny(StatusCode::NOT_FOUND, "not_found", "找不到这个扩展文件"),
        Err(FileError::TooLarge) => deny(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "扩展文件超过 8 MB",
        ),
        Err(FileError::Io(_)) => deny(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "读取扩展文件失败",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与前端 `manifest.spec.ts` 共用的用例:同一份清单两边必须给出同样的结论。
    const CASES: &str = include_str!("../tests/fixtures/editor-manifest-cases.json");

    #[test]
    fn manifest_cases_shared_with_the_frontend_agree() {
        let cases: Vec<Value> = serde_json::from_str(CASES).expect("用例是合法 JSON");
        assert!(cases.len() >= 20, "用例太少说明夹具没读对");
        for case in &cases {
            let name = case["name"].as_str().expect("用例要有名字");
            let result = validate_manifest(&case["manifest"]);
            let expected_ok = case["ok"].as_bool().expect("用例要标 ok");
            assert_eq!(
                result.is_ok(),
                expected_ok,
                "用例「{name}」:期望 ok={expected_ok},实际 {result:?}"
            );
            if let (Err(errors), Some(needle)) = (&result, case["error_contains"].as_str()) {
                assert!(
                    errors.iter().any(|error| error.contains(needle)),
                    "用例「{name}」:错误里应出现「{needle}」,实际 {errors:?}"
                );
            }
        }
    }

    fn valid() -> Value {
        json!({
            "id": "kb.demo",
            "name": "演示",
            "version": "1.2.3",
            "api_version": 1,
            "permissions": ["ui", "document.read", "ui"],
            "contributes": {
                "commands": [{ "id": "kb.demo.run", "title": "运行" }],
                "panels": [{ "id": "kb.demo.panel", "title": "面板", "icon": "∑" }],
                "codecs": [{ "id": "kb.demo.codec", "extensions": ["foo", "bar"] }],
            },
        })
    }

    #[test]
    fn a_valid_manifest_is_normalized() {
        let manifest = validate_manifest(&valid()).expect("合法");
        assert_eq!(manifest.entry, "index.js", "entry 缺省 index.js");
        assert_eq!(manifest.permissions, ["ui", "document.read"], "去重且保序");
        assert_eq!(manifest.contributes.panels[0].icon.as_deref(), Some("∑"));
        assert!(manifest.contributes.toolbar.is_empty());
        let json = serde_json::to_value(&manifest).unwrap();
        assert_eq!(json["api_version"], 1);
        assert!(json["description"].is_null());
        assert!(
            json["contributes"]["ai_tools"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn newer_api_versions_are_refused_with_a_reason() {
        let mut manifest = valid();
        manifest["api_version"] = json!(2);
        let errors = validate_manifest(&manifest).expect_err("2 不被支持");
        assert!(errors.iter().any(|e| e.contains("更新版本")), "{errors:?}");
    }

    #[test]
    fn every_problem_is_reported_in_one_pass() {
        let errors = validate_manifest(&json!({
            "id": "Bad Id",
            "version": "1.0",
            "api_version": "1",
            "permissions": ["root"],
        }))
        .expect_err("全是问题");
        assert!(errors.len() >= 5, "{errors:?}");
    }

    #[test]
    fn toml_syntax_and_shape_errors_are_manifest_problems_not_panics() {
        assert!(parse_manifest_toml("id = ").is_err());
        assert!(parse_manifest_toml("id = 1\nname = 2").is_err());
        let ok = parse_manifest_toml(
            "id = \"kb.a\"\nname = \"A\"\nversion = \"0.1.0\"\napi_version = 1\n\
             permissions = [\"ui\"]\n[[contributes.panels]]\nid = \"kb.a.p\"\ntitle = \"P\"\n",
        )
        .expect("合法 TOML");
        assert_eq!(ok.contributes.panels.len(), 1);
        // 日期时间不是字符串
        assert!(parse_manifest_toml("id = 1979-05-27\nname = \"x\"").is_err());
    }

    #[test]
    fn ids_and_versions_follow_their_grammar() {
        for good in ["a", "kb.word-count", "a1.b2-c3", "0"] {
            assert!(is_valid_id(good), "{good}");
        }
        for bad in [
            "",
            ".a",
            "a.",
            "a..b",
            "a--b",
            "A",
            "a_b",
            "a b",
            "a/b",
            &"a".repeat(65),
        ] {
            assert!(!is_valid_id(bad), "{bad}");
        }
        for good in [
            "0.0.0",
            "1.2.3",
            "10.20.30",
            "1.0.0-alpha.1",
            "1.0.0+build.5",
            "1.0.0-rc.1+x",
        ] {
            assert!(is_valid_semver(good), "{good}");
        }
        for bad in [
            "1", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.3-", "1.2.3-01", "v1.2.3", "1.2.3+",
            "a.b.c",
        ] {
            assert!(!is_valid_semver(bad), "{bad}");
        }
    }

    // ---------------- 路径安全(纯文件系统层)

    fn tree() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = dir.path().join("editor-extensions");
        let ext = root.join("kb.demo");
        std::fs::create_dir_all(ext.join("lib")).unwrap();
        std::fs::write(ext.join("index.js"), "export default {}").unwrap();
        std::fs::write(ext.join("lib/util.js"), "export const a = 1").unwrap();
        std::fs::write(ext.join("style.css"), "a{}").unwrap();
        std::fs::write(ext.join("data.json"), "{}").unwrap();
        std::fs::write(ext.join("icon.svg"), "<svg/>").unwrap();
        std::fs::write(ext.join("notes.txt"), "x").unwrap();
        std::fs::write(
            ext.join(MANIFEST_FILE),
            "id = \"kb.demo\"\nname = \"D\"\nversion = \"1.0.0\"\napi_version = 1\n",
        )
        .unwrap();
        // 目录之外的机密文件:所有穿越尝试都不能读到它
        std::fs::write(dir.path().join("secret.js"), "SECRET").unwrap();
        std::fs::write(root.join("secret.js"), "SECRET").unwrap();
        (dir, root)
    }

    #[test]
    fn serves_whitelisted_files_with_the_right_type() {
        let (_guard, root) = tree();
        for (file, mime) in [
            ("index.js", "text/javascript; charset=utf-8"),
            ("lib/util.js", "text/javascript; charset=utf-8"),
            ("style.css", "text/css; charset=utf-8"),
            ("data.json", "application/json"),
            ("icon.svg", "image/svg+xml"),
        ] {
            let (_, served) = read_extension_file(&root, "kb.demo", file).expect(file);
            assert_eq!(served, mime, "{file}");
        }
    }

    #[test]
    fn refuses_types_outside_the_whitelist_including_the_manifest() {
        let (_guard, root) = tree();
        for file in ["notes.txt", "manifest.toml", "noext", "index.js.bak"] {
            let err = read_extension_file(&root, "kb.demo", file).expect_err(file);
            assert!(matches!(err, FileError::Invalid(_)), "{file}: {err:?}");
        }
    }

    #[test]
    fn path_traversal_attempts_never_leave_the_extension_directory() {
        let (_guard, root) = tree();
        let attempts = [
            "../secret.js",
            "../../secret.js",
            "lib/../../secret.js",
            "./index.js",
            "lib/./util.js",
            "/etc/passwd.js",
            "/index.js",
            "..%2Fsecret.js",
            "%2e%2e/secret.js",
            "%252e%252e/secret.js",
            "..\\secret.js",
            "lib\\..\\..\\secret.js",
            "index.js\0.css",
            "index.js%00.css",
            ".hidden.js",
            "lib//util.js",
            "lib/",
            "",
            "..",
            ".../secret.js",
            "index.js ",
        ];
        for attempt in attempts {
            let result = read_extension_file(&root, "kb.demo", attempt);
            assert!(
                !matches!(&result, Ok((bytes, _)) if bytes == b"SECRET"),
                "{attempt:?} 读到了目录外的文件"
            );
            assert!(result.is_err(), "{attempt:?} 应被拒绝:{result:?}");
        }
        // id 段里的穿越
        for id in [
            "..",
            "kb.demo/..",
            "../kb.demo",
            "kb.demo/../kb.demo",
            "%2e%2e",
            "",
        ] {
            assert!(
                read_extension_file(&root, id, "secret.js").is_err(),
                "{id:?}"
            );
        }
    }

    #[test]
    fn symlinks_inside_an_extension_are_refused_even_when_they_point_inside() {
        let (guard, root) = tree();
        let ext = root.join("kb.demo");
        // 指向目录外的文件
        std::os::unix::fs::symlink(guard.path().join("secret.js"), ext.join("leak.js")).unwrap();
        // 指向目录外的目录
        std::os::unix::fs::symlink(guard.path(), ext.join("up")).unwrap();
        // 指向扩展内部的文件:同样不给(规则简单,没有「安全的链接」要判断)
        std::os::unix::fs::symlink(ext.join("index.js"), ext.join("alias.js")).unwrap();
        for file in ["leak.js", "up/secret.js", "alias.js"] {
            assert_eq!(
                read_extension_file(&root, "kb.demo", file).expect_err(file),
                FileError::Symlink,
                "{file}"
            );
        }
    }

    #[test]
    fn the_extension_directory_itself_may_be_a_symlink_the_admin_placed() {
        let (guard, root) = tree();
        let real = guard.path().join("dev-checkout");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("index.js"), "ok").unwrap();
        std::os::unix::fs::symlink(&real, root.join("kb.linked")).unwrap();
        let (bytes, _) = read_extension_file(&root, "kb.linked", "index.js").expect("目录链接可用");
        assert_eq!(bytes, b"ok");
        // 但链进来的目录里面仍然不许再有链接逃逸
        std::os::unix::fs::symlink(guard.path().join("secret.js"), real.join("leak.js")).unwrap();
        assert_eq!(
            read_extension_file(&root, "kb.linked", "leak.js").expect_err("leak"),
            FileError::Symlink
        );
    }

    #[test]
    fn missing_files_and_oversized_files_are_distinguished() {
        let (_guard, root) = tree();
        assert_eq!(
            read_extension_file(&root, "kb.demo", "nope.js").expect_err("nope"),
            FileError::NotFound
        );
        assert_eq!(
            read_extension_file(&root, "kb.nothing", "index.js").expect_err("no ext"),
            FileError::NotFound
        );
        // 目录当文件
        std::fs::create_dir(root.join("kb.demo").join("dir.js")).unwrap();
        assert_eq!(
            read_extension_file(&root, "kb.demo", "dir.js").expect_err("dir"),
            FileError::NotFound
        );
        let big = vec![b'a'; (MAX_FILE_BYTES + 1) as usize];
        std::fs::write(root.join("kb.demo").join("big.js"), big).unwrap();
        assert_eq!(
            read_extension_file(&root, "kb.demo", "big.js").expect_err("big"),
            FileError::TooLarge
        );
    }

    // ---------------- 目录扫描

    #[test]
    fn scanning_lists_valid_extensions_and_explains_broken_ones() {
        let (_guard, root) = tree();
        // 缺清单
        std::fs::create_dir_all(root.join("kb.nomanifest")).unwrap();
        // 清单里 id 与目录名不一致
        std::fs::create_dir_all(root.join("kb.mismatch")).unwrap();
        std::fs::write(
            root.join("kb.mismatch").join(MANIFEST_FILE),
            "id = \"kb.other\"\nname = \"x\"\nversion = \"1.0.0\"\napi_version = 1\n",
        )
        .unwrap();
        std::fs::write(root.join("kb.mismatch").join("index.js"), "").unwrap();
        // 入口缺失
        std::fs::create_dir_all(root.join("kb.noentry")).unwrap();
        std::fs::write(
            root.join("kb.noentry").join(MANIFEST_FILE),
            "id = \"kb.noentry\"\nname = \"x\"\nversion = \"1.0.0\"\napi_version = 1\n",
        )
        .unwrap();
        // 目录名不是合法 id
        std::fs::create_dir_all(root.join("Bad Name")).unwrap();
        // 隐藏目录与普通文件被忽略
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("README.md"), "x").unwrap();

        let entries = scan_extensions(&root);
        let by_dir = |dir: &str| entries.iter().find(|entry| entry.dir == dir).expect(dir);
        assert!(
            by_dir("kb.demo").manifest.is_some(),
            "{:?}",
            by_dir("kb.demo")
        );
        assert!(
            by_dir("kb.nomanifest")
                .error
                .as_deref()
                .unwrap()
                .contains("manifest.toml")
        );
        assert!(
            by_dir("kb.mismatch")
                .error
                .as_deref()
                .unwrap()
                .contains("不一致")
        );
        assert!(
            by_dir("kb.noentry")
                .error
                .as_deref()
                .unwrap()
                .contains("入口")
        );
        assert!(
            by_dir("Bad Name")
                .error
                .as_deref()
                .unwrap()
                .contains("目录名")
        );
        assert!(
            entries
                .iter()
                .all(|entry| entry.dir != ".git" && entry.dir != "README.md")
        );
        let names: Vec<&str> = entries.iter().map(|entry| entry.dir.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted, "按目录名排序,输出稳定");
    }

    #[test]
    fn a_missing_root_means_no_extensions() {
        let dir = tempfile::tempdir().unwrap();
        assert!(scan_extensions(&dir.path().join("absent")).is_empty());
    }

    #[test]
    fn an_oversized_manifest_is_rejected_without_being_parsed() {
        let (_guard, root) = tree();
        let ext = root.join("kb.big");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(ext.join("index.js"), "").unwrap();
        std::fs::write(
            ext.join(MANIFEST_FILE),
            format!("id = \"kb.big\"\n# {}", "x".repeat(70 * 1024)),
        )
        .unwrap();
        let entry = read_extension(&root, "kb.big");
        assert!(
            entry.error.as_deref().unwrap().contains("超过"),
            "{entry:?}"
        );
    }
}
