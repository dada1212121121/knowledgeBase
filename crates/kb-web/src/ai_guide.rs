//! AI 接入指南:按用户生成的一份 Markdown,下载后整份发给 AI,它就能接入知识库并自测。
//!
//! 静态部分(怎么接、提示词、自测脚本)在 `ai_guide.md`;这里把「这个用户的连接信息」和
//! 「这个用户真能调用的接口清单」填进去。接口清单来自能力注册表,新增能力不用改文档。

use std::collections::BTreeMap;

use serde_json::Value;

/// 静态模板。占位符:`{{BASE}}` `{{KEY}}` `{{USERNAME}}` `{{DISPLAY}}` `{{SITE}}` `{{GENERATED}}`
/// `{{COUNT}}` `{{SELFTEST}}` `{{WHO}}` `{{DISPLAY_SUFFIX}}` `{{CAPABILITIES}}`,
/// 以及导入规范里的服务器限制 `{{TEXT_MAX_KB}}` `{{MD_MAX_MB}}` `{{DOC_MAX_MB}}` `{{UPLOAD_MAX_MB}}` `{{DEFAULT_EXCLUDE}}`。
/// 模板里除占位符外不能出现连续两个左花括号(有单元测试守着)。
const TEMPLATE: &str = include_str!("ai_guide.md");

/// 自测脚本(Python 3 标准库)。嵌进模板的 `{{SELFTEST}}`,脚本里的 `{{BASE}}` `{{KEY}}` 随后一起替换,
/// 所以用户拿到的是填好地址和 key、直接能跑的脚本。
const SELFTEST: &str = include_str!("ai_guide_selftest.py");

/// 写进「导入规范」的服务器限制:数字取自当前配置,配置改了重新下载的指南跟着变。
/// 这只是把服务器已有的规则告诉接入方,服务端不因此多拦任何东西。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuideLimits {
    /// 项目扫描时单个代码 / 其他文本文件(`.txt`、配置、数据文件等)的上限(KB),超过的会被跳过
    /// (`[index] max_file_bytes`)。**不含 Markdown**:`.md` / `.mdx` 的上限见 [`Self::md_max_mb`]。
    pub text_max_kb: u64,
    /// 项目扫描时 Markdown 文档(`.md` / `.mdx`)的上限(MB)。
    ///
    /// 与扫描器同一条规则:`max(max_file_bytes, TEXT_DOC_MAX_BYTES)`(见 `kb_index::filter` 的
    /// `size_limit_for`),所以只会放宽、不会比用户调大的 `max_file_bytes` 更小。
    pub md_max_mb: u64,
    /// 项目扫描时 PDF / Office 等办公文档的上限(MB)。
    pub doc_max_mb: u64,
    /// 单个上传文件的上限(MB):`[upload] max_file_mb` 与 `[quota] max_upload_mb` 取小。
    pub upload_max_mb: u64,
    /// 默认排除的 glob(`[index] exclude`)。
    pub default_exclude: Vec<String>,
}

impl GuideLimits {
    /// 从当前配置取。
    pub fn from_config(config: &kb_core::Config) -> Self {
        Self {
            text_max_kb: config.index.max_file_bytes.div_ceil(1024),
            // 用常量换算,不写死数字;零头进位的理由同 `text_max_kb`(免得文档写得比实际小)
            md_max_mb: config
                .index
                .max_file_bytes
                .max(kb_core::config::TEXT_DOC_MAX_BYTES)
                .div_ceil(1024 * 1024),
            doc_max_mb: kb_core::config::RICH_DOC_MAX_BYTES / (1024 * 1024),
            upload_max_mb: config.upload.max_file_mb.min(config.quota.max_upload_mb),
            default_exclude: config.index.exclude.clone(),
        }
    }

    fn exclude_text(&self) -> String {
        if self.default_exclude.is_empty() {
            return "(没有)".to_owned();
        }
        self.default_exclude
            .iter()
            .map(|glob| format!("`{glob}`"))
            .collect::<Vec<_>>()
            .join("、")
    }
}

/// 填进指南的连接信息。
pub struct GuideInput<'a> {
    /// 站点地址,不带结尾斜杠,例如 `https://kbase.example.com`。
    pub base: &'a str,
    /// 用户的 admin key 明文。
    pub key: &'a str,
    /// 登录名。
    pub username: &'a str,
    /// 显示名。
    pub display_name: &'a str,
    /// 站点名称。
    pub site: &'a str,
    /// 生成时间(站点时区文本,含 `UTC+8` 之类的偏移)。
    pub generated_at: &'a str,
    /// 导入规范里写的服务器限制。
    pub limits: &'a GuideLimits,
}

/// 清单里的一个接口:从能力注册表摘出渲染需要的字段。
#[derive(Clone, Debug)]
pub struct GuideCapability {
    /// 能力名。
    pub name: String,
    /// 一句话说明。
    pub description: String,
    /// 权限级别:`R` / `W` / `G` / `A`。
    pub permission: String,
    /// 是否在 MCP 工具里出现。
    pub mcp: bool,
    /// 需要的功能点(`base` = 不额外要求)。
    pub feature: String,
    /// 入参的 JSON Schema。
    pub schema: Value,
}

/// 清单分组:(组标题, 功能点前缀)。按这个顺序输出;没有任何前缀命中的归到最后一组。
const GROUPS: &[(&str, &[&str])] = &[
    ("基础(所有账号都有)", &["base"]),
    ("检索", &["search."]),
    ("笔记、文档与上传", &["docs."]),
    ("项目与数据源", &["sources."]),
    ("好友与分享", &["collab."]),
    ("AI 功能", &["ai."]),
    ("访问令牌", &["api."]),
    ("系统管理(需要管理员功能)", &["sys."]),
];

/// 一个属性的类型,压成一个短词:`string` / `integer` / `boolean` / `string[]` / `object`,可空的带 `?`。
fn type_of(property: &Value) -> String {
    if let Some(variants) = property.get("anyOf").and_then(Value::as_array) {
        let names: Vec<String> = variants
            .iter()
            .map(type_of)
            .filter(|name| name != "null")
            .collect();
        return names
            .first()
            .cloned()
            .unwrap_or_else(|| "object".to_owned());
    }
    if property.get("$ref").is_some() {
        return "object".to_owned();
    }
    let (kind, nullable) = match property.get("type") {
        Some(Value::String(kind)) => (kind.clone(), false),
        Some(Value::Array(kinds)) => {
            let names: Vec<&str> = kinds.iter().filter_map(Value::as_str).collect();
            let nullable = names.contains(&"null");
            let kind = names
                .iter()
                .find(|name| **name != "null")
                .copied()
                .unwrap_or("object");
            (kind.to_owned(), nullable)
        }
        _ => ("object".to_owned(), false),
    };
    let base = if kind == "array" {
        let item = property
            .get("items")
            .map_or_else(|| "any".to_owned(), type_of);
        format!("{item}[]")
    } else {
        kind
    };
    if nullable { format!("{base}?") } else { base }
}

/// 说明文字截断到 `max` 个字,去掉换行。
fn clip(text: &str, max: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let head: String = flat.chars().take(max).collect();
        format!("{head}…")
    }
}

/// 入参清单:必填的带 `*` 和说明,选填的只写名字和类型(完整说明在 `GET /api/v1/capabilities`)。
fn params_of(schema: &Value) -> String {
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return "无参数".to_owned();
    };
    if properties.is_empty() {
        return "无参数".to_owned();
    }
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut parts = Vec::new();
    for (name, property) in properties {
        let is_required = required.contains(&name.as_str());
        let kind = type_of(property);
        let note = property
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("");
        parts.push(if is_required {
            format!("`{name}`*:{kind}({})", clip(note, 40))
        } else {
            format!("`{name}`:{kind}")
        });
    }
    parts.join(" · ")
}

/// 渲染接口清单:按功能点分组,每个接口两行(名字 + 说明,下面一行入参)。
///
/// `[M]` = 也是 MCP 工具;`R/W/G/A` = 权限级别(读 / 写 / 治理 / 管理)。
pub fn render_capabilities(items: &[GuideCapability]) -> String {
    let mut buckets: BTreeMap<usize, Vec<&GuideCapability>> = BTreeMap::new();
    let other = GROUPS.len();
    for item in items {
        let slot = GROUPS
            .iter()
            .position(|(_, prefixes)| {
                prefixes.iter().any(|prefix| {
                    if *prefix == "base" {
                        item.feature == "base"
                    } else {
                        item.feature.starts_with(prefix)
                    }
                })
            })
            .unwrap_or(other);
        buckets.entry(slot).or_default().push(item);
    }
    let mut out = String::new();
    for (slot, mut list) in buckets {
        list.sort_by(|a, b| a.name.cmp(&b.name));
        let title = GROUPS.get(slot).map_or("其他", |(title, _)| *title);
        out.push_str(&format!("\n### {title}({}个)\n\n", list.len()));
        for item in list {
            let mcp = if item.mcp { " [M]" } else { "" };
            out.push_str(&format!(
                "- **{}** `{}`{mcp} — {}\n  - 参数:{}\n",
                item.name,
                item.permission,
                clip(&item.description, 80),
                params_of(&item.schema)
            ));
        }
    }
    out
}

/// 渲染整份指南。
pub fn render(input: &GuideInput<'_>, items: &[GuideCapability]) -> String {
    // 清单里的文字(来自能力说明)不再参与占位符替换:先按清单位置切开,小占位符只在模板自己的文字里替换
    let (head, tail) = TEMPLATE
        .split_once("{{CAPABILITIES}}")
        .unwrap_or((TEMPLATE, ""));
    // 显示名和登录名一样时只写一个,别写成「tester(tester)」
    let same = input.display_name.trim().is_empty() || input.display_name == input.username;
    let who = if same {
        input.username.to_owned()
    } else {
        format!("{}({})", input.display_name, input.username)
    };
    let display_suffix = if same {
        String::new()
    } else {
        format!("({})", input.display_name)
    };
    let fill = |text: &str| {
        text.replace("{{SELFTEST}}", SELFTEST)
            .replace("{{WHO}}", &who)
            .replace("{{DISPLAY_SUFFIX}}", &display_suffix)
            .replace("{{BASE}}", input.base)
            .replace("{{KEY}}", input.key)
            .replace("{{USERNAME}}", input.username)
            .replace("{{DISPLAY}}", input.display_name)
            .replace("{{SITE}}", input.site)
            .replace("{{GENERATED}}", input.generated_at)
            .replace("{{COUNT}}", &items.len().to_string())
            .replace("{{TEXT_MAX_KB}}", &input.limits.text_max_kb.to_string())
            .replace("{{MD_MAX_MB}}", &input.limits.md_max_mb.to_string())
            .replace("{{DOC_MAX_MB}}", &input.limits.doc_max_mb.to_string())
            .replace("{{UPLOAD_MAX_MB}}", &input.limits.upload_max_mb.to_string())
            .replace("{{DEFAULT_EXCLUDE}}", &input.limits.exclude_text())
    };
    format!("{}{}{}", fill(head), render_capabilities(items), fill(tail))
}

/// 站点地址必须是 `http(s)://主机[:端口]`,不带路径、查询和空白;用来拒绝把别的东西写进下载的文档。
pub fn is_plain_origin(value: &str) -> bool {
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"));
    let Some(rest) = rest else { return false };
    !rest.is_empty()
        && rest.len() <= 255
        && rest
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | ':' | '[' | ']'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cap(name: &str, feature: &str, mcp: bool, schema: Value) -> GuideCapability {
        GuideCapability {
            name: name.to_owned(),
            description: format!("{name} 的说明"),
            permission: "W".to_owned(),
            mcp,
            feature: feature.to_owned(),
            schema,
        }
    }

    static LIMITS: std::sync::LazyLock<GuideLimits> = std::sync::LazyLock::new(|| GuideLimits {
        text_max_kb: 200,
        md_max_mb: 2,
        doc_max_mb: 64,
        upload_max_mb: 150,
        default_exclude: vec!["**/node_modules/**".to_owned(), "**/*.map".to_owned()],
    });

    fn input() -> GuideInput<'static> {
        GuideInput {
            base: "https://kb.example.com",
            key: "kb_ak_0123456789abcdef",
            username: "alice",
            display_name: "爱丽丝",
            site: "团队知识库",
            generated_at: "2026-10-31 12:00:00",
            limits: &LIMITS,
        }
    }

    #[test]
    fn types_are_squeezed_into_short_words() {
        assert_eq!(type_of(&json!({"type": "string"})), "string");
        assert_eq!(type_of(&json!({"type": ["string", "null"]})), "string?");
        assert_eq!(
            type_of(&json!({"type": "array", "items": {"type": "string"}})),
            "string[]"
        );
        assert_eq!(
            type_of(&json!({"type": ["integer", "null"], "format": "uint"})),
            "integer?"
        );
        assert_eq!(type_of(&json!({"$ref": "#/$defs/X"})), "object");
        assert_eq!(
            type_of(&json!({"anyOf": [{"type": "null"}, {"type": "boolean"}]})),
            "boolean"
        );
    }

    #[test]
    fn required_params_carry_a_note_and_optional_ones_only_a_type() {
        let schema = json!({
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "标题(一句话)。"},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "标签。"}
            },
            "required": ["title"]
        });
        let text = params_of(&schema);
        assert!(text.contains("`title`*:string(标题(一句话)。)"), "{text}");
        assert!(
            text.contains("`tags`:string[]") && !text.contains("标签。"),
            "{text}"
        );
        assert_eq!(
            params_of(&json!({"type": "object", "properties": {}})),
            "无参数"
        );
    }

    #[test]
    fn capabilities_are_grouped_sorted_and_mcp_is_marked() {
        let items = vec![
            cap("save_insight", "docs.notes", true, json!({})),
            cap("list_projects", "base", true, json!({})),
            cap("add_project", "sources.local", false, json!({})),
            cap("search_knowledge", "search.basic", true, json!({})),
            cap("weird", "future.thing", false, json!({})),
        ];
        let text = render_capabilities(&items);
        let at = |needle: &str| {
            text.find(needle)
                .unwrap_or_else(|| panic!("缺少 {needle}:{text}"))
        };
        assert!(
            at("基础") < at("检索") && at("检索") < at("笔记、文档与上传"),
            "{text}"
        );
        assert!(
            at("笔记、文档与上传") < at("项目与数据源") && at("项目与数据源") < at("其他"),
            "{text}"
        );
        assert!(text.contains("**save_insight** `W` [M]"), "{text}");
        assert!(
            text.contains("**add_project** `W` —"),
            "没有 [M] 标记:{text}"
        );
    }

    #[test]
    fn rendering_fills_the_connection_info_and_never_reexpands_capability_text() {
        let mut items = vec![cap("sneaky", "base", false, json!({}))];
        items[0].description = "说明里写了 {{KEY}} 不能被替换".to_owned();
        let text = render(&input(), &items);
        assert!(text.contains("kb_ak_0123456789abcdef") && text.contains("https://kb.example.com"));
        assert!(
            text.contains("alice")
                && text.contains("爱丽丝")
                && text.contains("2026-10-31 12:00:00")
        );
        assert!(
            text.contains("说明里写了 {{KEY}} 不能被替换"),
            "清单里的文字不该再被当占位符"
        );
        for placeholder in [
            "{{BASE}}",
            "{{KEY}}",
            "{{USERNAME}}",
            "{{DISPLAY}}",
            "{{SITE}}",
            "{{GENERATED}}",
            "{{COUNT}}",
            "{{SELFTEST}}",
            "{{WHO}}",
            "{{DISPLAY_SUFFIX}}",
            "{{CAPABILITIES}}",
            "{{TEXT_MAX_KB}}",
            "{{MD_MAX_MB}}",
            "{{DOC_MAX_MB}}",
            "{{UPLOAD_MAX_MB}}",
            "{{DEFAULT_EXCLUDE}}",
        ] {
            let left = text.matches(placeholder).count();
            // 唯一允许留下的是清单里那句故意写成占位符样子的说明
            let allowed = usize::from(placeholder == "{{KEY}}");
            assert_eq!(left, allowed, "{placeholder} 没替换干净");
        }
        assert!(
            text.contains("ADMIN_KEY = \"kb_ak_0123456789abcdef\""),
            "自测脚本里的 key 要被填好"
        );
        assert!(
            text.contains("BASE = \"https://kb.example.com\""),
            "自测脚本里的地址要被填好"
        );
    }

    #[test]
    fn who_is_written_once_when_display_name_equals_username_and_the_time_has_one_utc() {
        let mut same = input();
        same.display_name = "alice";
        same.generated_at = "2026-10-31 12:00 (UTC+8)";
        let text = render(&same, &[]);
        assert!(
            text.contains("**alice**") && !text.contains("alice(alice)"),
            "{text}"
        );
        assert!(text.contains("| 账号 | `alice` |"), "{text}");
        assert_eq!(
            text.matches("(UTC+8)").count(),
            1,
            "生成时间只该带一个时区标记"
        );
        let text = render(&input(), &[]);
        assert!(
            text.contains("**爱丽丝(alice)**") && text.contains("| 账号 | `alice`(爱丽丝) |"),
            "{text}"
        );
    }

    #[test]
    fn the_guide_spells_out_the_mcp_handshake_details_a_hand_written_client_needs() {
        // 实测时 AI 只看第 4 节卡在这几处:缺 Accept 得 406、缺会话 id 得 422、响应可能是 SSE
        for needle in [
            "Accept: application/json, text/event-stream",
            "406",
            "mcp-session-id",
            "422",
            "notifications/initialized",
            "data: {",
            "空的",
        ] {
            assert!(TEMPLATE.contains(needle), "指南第 4 节缺少「{needle}」");
        }
    }

    #[test]
    fn every_section_reference_points_at_a_heading_that_exists() {
        let headings: std::collections::BTreeSet<u32> = TEMPLATE
            .lines()
            .filter_map(|line| line.strip_prefix("## "))
            .filter_map(|rest| rest.split('.').next()?.trim().parse().ok())
            .collect();
        assert!(
            headings.contains(&0) && headings.len() >= 10,
            "标题:{headings:?}"
        );
        let mut rest = TEMPLATE;
        while let Some(at) = rest.find('第') {
            let tail = &rest[at + '第'.len_utf8()..];
            let digits: String = tail
                .trim_start()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            let after = tail.trim_start()[digits.len()..].trim_start();
            if !digits.is_empty() && after.starts_with('节') {
                let number: u32 = digits.parse().expect("数字");
                assert!(
                    headings.contains(&number),
                    "文中引用了「第 {number} 节」,但没有这个标题:{headings:?}"
                );
            }
            rest = tail;
        }
    }

    #[test]
    fn the_template_only_uses_known_placeholders() {
        let known = [
            "{{BASE}}",
            "{{KEY}}",
            "{{USERNAME}}",
            "{{DISPLAY}}",
            "{{SITE}}",
            "{{GENERATED}}",
            "{{COUNT}}",
            "{{SELFTEST}}",
            "{{WHO}}",
            "{{DISPLAY_SUFFIX}}",
            "{{CAPABILITIES}}",
            "{{TEXT_MAX_KB}}",
            "{{MD_MAX_MB}}",
            "{{DOC_MAX_MB}}",
            "{{UPLOAD_MAX_MB}}",
            "{{DEFAULT_EXCLUDE}}",
        ];
        for source in [TEMPLATE, SELFTEST] {
            let mut rest = source;
            while let Some(start) = rest.find("{{") {
                let tail = &rest[start..];
                let end = tail.find("}}").map_or(tail.len(), |i| i + 2);
                let token = &tail[..end];
                assert!(
                    known.contains(&token),
                    "模板或自测脚本里有不认识的占位符 {token}"
                );
                rest = &tail[end..];
            }
        }
        assert_eq!(
            TEMPLATE.matches("{{CAPABILITIES}}").count(),
            1,
            "清单位置只能有一个"
        );
    }

    #[test]
    fn import_rules_are_rendered_with_the_servers_real_limits() {
        let text = render(&input(), &[]);
        // 服务器限制按传进来的数字写;默认排除写成代码样式的列表
        assert!(text.contains("超过 200 KB"), "文本上限没写进去");
        // 200 KB 这一行只管代码 / 其他文本,明确写了不含 Markdown(Markdown 的上限单独一行)
        let text_row = text
            .lines()
            .find(|line| line.contains("超过 200 KB"))
            .expect("文本上限那一行");
        assert!(
            text_row.contains("不含"),
            "文本上限那一行没说明不含 Markdown"
        );
        assert!(
            text.contains("Markdown 文档(`.md` / `.mdx`)超过 2 MB"),
            "Markdown 上限没单独写进去"
        );
        assert!(
            text.contains("项目扫描上限是 64 MB"),
            "办公文档上限没写进去"
        );
        assert!(text.contains("单个上传文件超过 150 MB"), "上传上限没写进去");
        assert!(
            text.contains("`**/node_modules/**`、`**/*.map`"),
            "默认排除没写进去"
        );
        // 换一组限制,文档跟着变(配置改了重新下载就是新的)
        let other = GuideLimits {
            text_max_kb: 512,
            md_max_mb: 8,
            doc_max_mb: 32,
            upload_max_mb: 20,
            default_exclude: Vec::new(),
        };
        let mut changed = input();
        changed.limits = &other;
        let text = render(&changed, &[]);
        assert!(text.contains("超过 512 KB") && !text.contains("超过 200 KB"));
        assert!(
            text.contains("Markdown 文档(`.md` / `.mdx`)超过 8 MB")
                && !text.contains("Markdown 文档(`.md` / `.mdx`)超过 2 MB"),
            "Markdown 上限要跟着配置变"
        );
        assert!(text.contains("项目扫描上限是 32 MB"));
        assert!(text.contains("单个上传文件超过 20 MB"));
        assert!(text.contains("服务器默认已经排除:(没有);"));
    }

    #[test]
    fn limits_come_from_the_live_config() {
        let mut config = kb_core::Config::default();
        config.index.max_file_bytes = 300 * 1024 + 1;
        config.upload.max_file_mb = 512;
        config.quota.max_upload_mb = 200;
        let limits = GuideLimits::from_config(&config);
        assert_eq!(
            limits.text_max_kb, 301,
            "不足 1 KB 的零头进位,免得文档写得比实际小"
        );
        assert_eq!(limits.upload_max_mb, 200, "上传上限取配置和配额里小的那个");
        assert_eq!(limits.doc_max_mb, 64, "办公文档上限就是扫描器用的那个常量");
        assert_eq!(limits.default_exclude, config.index.exclude);
        config.upload.max_file_mb = 50;
        assert_eq!(GuideLimits::from_config(&config).upload_max_mb, 50);
    }

    #[test]
    fn markdown_limit_follows_the_scanners_rule() {
        // Markdown 的上限是 max(max_file_bytes, TEXT_DOC_MAX_BYTES),用常量换算,不写死数字
        let doc_mb = kb_core::config::TEXT_DOC_MAX_BYTES.div_ceil(1024 * 1024);
        let mut config = kb_core::Config::default();
        // 默认的 max_file_bytes 比 Markdown 上限小:Markdown 取常量(2 MiB → 2 MB),代码 / 文本仍是 max_file_bytes
        let limits = GuideLimits::from_config(&config);
        assert_eq!(limits.md_max_mb, doc_mb);
        assert_eq!(limits.md_max_mb, 2, "TEXT_DOC_MAX_BYTES 是 2 MiB");
        assert!(
            limits.text_max_kb < limits.md_max_mb * 1024,
            "默认配置下 Markdown 的上限比代码 / 文本宽"
        );
        // 用户把 max_file_bytes 调得比 Markdown 上限还大:取大者,不能反过来收紧
        config.index.max_file_bytes = 5 * 1024 * 1024;
        let limits = GuideLimits::from_config(&config);
        assert_eq!(limits.md_max_mb, 5);
        assert_eq!(limits.text_max_kb, 5 * 1024);
        // 不足 1 MB 的零头进位,同 text_max_kb
        config.index.max_file_bytes = 5 * 1024 * 1024 + 1;
        assert_eq!(GuideLimits::from_config(&config).md_max_mb, 6);
        // 渲染出来的指南里,Markdown 上限就是这个数
        let mut rendered = input();
        let live = GuideLimits::from_config(&kb_core::Config::default());
        rendered.limits = &live;
        let text = render(&rendered, &[]);
        assert!(
            text.contains(&format!("Markdown 文档(`.md` / `.mdx`)超过 {doc_mb} MB")),
            "指南里的 Markdown 上限要来自常量"
        );
    }

    #[test]
    fn the_guide_carries_the_import_rules_end_to_end() {
        let text = render(&input(), &[]);
        // 第 0 节有「先读导入规范」这一步
        let zero = text.split("## 1. ").next().expect("第 0 节");
        assert!(
            zero.contains("导入规范") && zero.contains("先盘点"),
            "第 0 节缺导入规范这一步"
        );
        // 5.0 的骨架:原则、两张表、必须先问、六步
        for needle in [
            "### 5.0 导入规范",
            "只导入「以后有人会想搜到、并且读了能用」的内容",
            "自己项目里夹带的第三方库",
            "SVG 截图",
            "AI 和工具的过程产物",
            "密钥和隐私",
            "必须先问用户的情况",
            "超过 300 个文件",
            "合计超过 50 MB",
            "单个文件超过 10 MB",
            "1. **盘点。**",
            "5. **复核。**",
            "6. **大资料不整份导入。**",
        ] {
            assert!(text.contains(needle), "导入规范缺少「{needle}」");
        }
        // B:能照做的顺序(注册会立刻排索引,所以先取消再设排除)
        let b = text
            .split("**B. 接入一个项目目录**")
            .nth(1)
            .and_then(|rest| rest.split("**C. ").next())
            .expect("B 段");
        let at = |needle: &str| b.find(needle).unwrap_or_else(|| panic!("B 缺少 {needle}"));
        assert!(at("add_project") < at("job_cancel") && at("job_cancel") < at("update_project"));
        assert!(b.contains("\"reindex\": true") && b.contains("\"exclude\""));
        assert!(b.contains("立刻排一个全量索引"), "要说明注册会立刻索引");
        // 非 git 目录也能登记:用户给的常常是规则 / 资料,不是代码仓库
        assert!(b.contains("不要求是 git"), "B 要说明非 git 目录也能登记");
        // 5.2:按内容类型说明怎么保持最新,并明确数据来源不监听
        let keep = text
            .split("### 5.2 保持最新")
            .nth(1)
            .and_then(|rest| rest.split("## 6. ").next())
            .expect("5.2 段");
        for needle in [
            "是 git 仓库",
            "不是 git",
            "实时监听",
            "refresh_minutes",
            "不监听",
        ] {
            assert!(keep.contains(needle), "5.2 缺少「{needle}」");
        }
        // C / D 也要求先盘点
        assert!(text.contains("不要把整个目录原样上传"));
        assert!(text.contains("抓取深度不要超过 2"));
        // 第 7 节的提示词新增 4 条,并且仍在同一个代码块里
        let prompt = text
            .split("## 7. ")
            .nth(1)
            .and_then(|rest| rest.split("## 8. ").next())
            .expect("第 7 节");
        for rule in [
            "7. 导入任何内容前",
            "8. 一次要导入超过 300 个文件",
            "9. 注册项目或改排除规则后",
            "10. 大文件和资料包不整份导入",
        ] {
            assert!(prompt.contains(rule), "提示词缺少「{rule}」");
        }
        assert_eq!(prompt.matches("```").count(), 2, "提示词应在一个代码块里");
        // 第 12 节
        let faq = text.split("## 12. ").nth(1).expect("第 12 节");
        assert!(faq.contains("为什么有的文件没进库") && faq.contains("注册项目后才想起来要排除"));
    }

    #[test]
    fn only_plain_origins_are_accepted_as_the_site_address() {
        for good in [
            "https://kb.example.com",
            "http://127.0.0.1:17878",
            "https://kb.example.com:8443",
        ] {
            assert!(is_plain_origin(good), "{good}");
        }
        for bad in [
            "",
            "ftp://x",
            "https://",
            "https://a.com/path",
            "https://a.com?x=1",
            "https://a b",
            "javascript:alert(1)",
            "https://a.com\nHost: evil",
        ] {
            assert!(!is_plain_origin(bad), "{bad:?}");
        }
    }
}
