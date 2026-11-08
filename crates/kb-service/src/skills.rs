//! 声明式 skills 与插件。
//!
//! 约定目录 `<KB_HOME>/skills/<name>/manifest.toml`,每个子目录一个 skill / 插件。
//! 兼容旧的三种声明式类型(可执行脚本默认拒绝,`[skills] allow_exec = true` 才放行):
//!
//! - `loader-rule`:glob → 指定语言 / 分块方式 / 附加标签(例如把 `*.proto` 当代码按窗口分块);
//! - `prompt`:按项目覆盖提炼 / 审核提示词(`extract` / `review`);
//! - `insight-template`:沉淀经验时的必填字段与长度上限。
//!
//! 新增 `type = "plugin"`:一个插件可以同时声明索引策略(`[index]`)、提示词 / 笔记模板,
//! 以及外部进程钩子(`[exec]`,支持 `extract` / `chunk` / `enrich` / `source`)。
//! 进程钩子默认拒绝,必须显式打开 `skills.allow_exec`;宿主只用 JSON-RPC/stdio 通信,
//! 插件崩溃或超时只会让当前文件回退到内置实现,不会带走守护进程。
//!
//! 扫描是**尽力而为**的:某个 skill 写坏了只记一条 warning 并跳过,不影响其它 skill 与守护进程启动。
//!
//! 这一层按职责拆在同目录的文件里:`manifest`(清单形状与校验)、`rules`(索引 / 来源规则编译)、
//! `registry`(已加载集合与匹配调度)、`kinds`(对外的小类型)、`plugin_index`(插件返回体),
//! 以及 `host` / `sandbox` / `write` / `plugin` / `official`(进程宿主与设置页写盘)。
//! 本文件只留转发、`is_scratch` 和测试。

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use globset::{Glob, GlobMatcher};
use kb_core::model::{Chunk, Source, SourceDoc};
use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

mod host;
mod official;
mod plugin;
mod sandbox;
mod write;
use host::PluginHost;
pub use official::{
    OfficialPluginInfo, catalog as official_plugins, catalog_with as official_plugins_with,
    install as install_official_plugin, uninstall as uninstall_official_plugin,
};
pub use plugin::{
    PluginDraft, PluginExecDraft, PluginFileDraft, PluginPermissionsDraft, PluginSourceDraft,
};
use sandbox::SandboxMode;
pub use write::SkillDraft;

mod kinds;
mod manifest;
mod plugin_index;
mod registry;
mod rules;

pub use kinds::{
    InsightTemplate, LoaderMatch, LoaderRule, PluginHook, PromptStage, SkillInfo, SkillKind,
    SkillSummary,
};
pub(crate) use manifest::*;
pub(crate) use plugin_index::*;
pub use plugin_index::{ExtractedText, PluginIndexMatch, SourcePage};
pub use registry::SkillRegistry;
pub(crate) use rules::*;

/// 点开头的目录是保存 skill 时的临时目录(校验通过才改名成正式的),扫描时当它不存在。
fn is_scratch(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with('.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, name: &str, manifest: &str) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).expect("建 skill 目录");
        std::fs::write(dir.join("manifest.toml"), manifest).expect("写 manifest");
    }

    #[test]
    fn loader_rule_matches_and_carries_tags() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_skill(
            dir.path(),
            "proto",
            r#"
type = "loader-rule"
[loader-rule]
glob = "**/*.proto"
lang = "text"
tags = ["proto", "schema"]
"#,
        );
        let registry = SkillRegistry::load(dir.path(), false);
        assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());
        let hit = registry.apply_loader("schemas/user.proto").expect("应命中");
        assert_eq!(hit.lang, "text");
        assert_eq!(hit.tags, vec!["proto".to_owned(), "schema".to_owned()]);
        assert!(registry.apply_loader("src/main.rs").is_none());
    }

    #[test]
    fn missing_sandbox_disables_hooks_unless_explicitly_allowed() {
        let strict = SkillRegistry {
            allow_exec: true,
            sandbox_available: false,
            allow_unsandboxed: false,
            ..SkillRegistry::default()
        };
        assert!(!strict.exec_enabled());
        assert!(
            strict
                .exec_disabled_reason()
                .contains("skills.allow_unsandboxed = false"),
            "{}",
            strict.exec_disabled_reason()
        );

        let explicit = SkillRegistry {
            allow_exec: true,
            sandbox_available: false,
            allow_unsandboxed: true,
            ..SkillRegistry::default()
        };
        assert!(explicit.exec_enabled());

        let off = SkillRegistry {
            allow_exec: false,
            sandbox_available: true,
            ..SkillRegistry::default()
        };
        assert!(!off.exec_enabled());
        assert!(off.exec_disabled_reason().contains("skills.allow_exec"));
    }

    #[test]
    fn summary_lists_every_skill_including_disabled_and_exec() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_skill(
            dir.path(),
            "proto",
            "type = \"loader-rule\"\n[loader-rule]\nglob = \"**/*.proto\"\nlang = \"text\"\ntags = [\"proto\"]\n",
        );
        write_skill(
            dir.path(),
            "tone",
            "type = \"prompt\"\n[prompt]\nstage = \"review\"\ntemplate = \"只挑具体的问题\"\n",
        );
        write_skill(
            dir.path(),
            "strict",
            "type = \"insight-template\"\n[insight-template]\nrequired = [\"body\"]\nmax_body_chars = 400\n",
        );
        write_skill(
            dir.path(),
            "off",
            "type = \"prompt\"\nenabled = false\n[prompt]\nstage = \"extract\"\ntemplate = \"不该生效\"\n",
        );
        write_skill(
            dir.path(),
            "script",
            "type = \"exec\"\n[exec]\nrun = \"echo hi\"\n",
        );

        let registry = SkillRegistry::load(dir.path(), false);
        let summary = registry.summary();
        assert_eq!(
            summary.dir.as_deref(),
            Some(dir.path().to_string_lossy().as_ref())
        );
        assert!(!summary.allow_exec);
        // 四个声明式 skill 都登记了(含被停用的),脚本类被拒绝(只留告警)
        let names: Vec<&str> = summary
            .skills
            .iter()
            .map(|skill| skill.name.as_str())
            .collect();
        assert_eq!(names, vec!["off", "proto", "strict", "tone"], "{summary:?}");
        let proto = summary
            .skills
            .iter()
            .find(|skill| skill.name == "proto")
            .expect("proto");
        assert_eq!(proto.kind, "loader-rule");
        assert!(proto.enabled);
        assert_eq!(proto.rules, vec!["**/*.proto → text +proto".to_owned()]);
        let tone = summary
            .skills
            .iter()
            .find(|skill| skill.name == "tone")
            .expect("tone");
        assert_eq!(tone.prompt_stages, vec!["review".to_owned()]);
        let strict = summary
            .skills
            .iter()
            .find(|skill| skill.name == "strict")
            .expect("strict");
        assert_eq!(strict.template_required, vec!["body".to_owned()]);
        let off = summary
            .skills
            .iter()
            .find(|skill| skill.name == "off")
            .expect("off");
        assert!(!off.enabled, "停用的 skill 也要列出来");
        // 停用的 prompt 没有生效
        assert!(registry.prompt(PromptStage::Extract).is_none());
        // 脚本类被拒绝:有告警,但没有登记成 skill
        assert!(
            summary.warnings.iter().any(|text| text.contains("script")),
            "{summary:?}"
        );
        assert!(!names.contains(&"script"));
    }

    #[test]
    fn prompt_skill_overrides_the_stage() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_skill(
            dir.path(),
            "prompt",
            r#"
type = "prompt"
[prompt]
stage = "review"
template = "只保留可执行的结论。"
"#,
        );
        let registry = SkillRegistry::load(dir.path(), false);
        assert_eq!(
            registry.prompt(PromptStage::Review),
            Some("只保留可执行的结论。")
        );
        assert_eq!(registry.prompt(PromptStage::Extract), None);
    }

    #[test]
    fn prompt_skill_can_override_the_web_extract_stage() {
        // :网页规范化的提示词也能整体覆盖;`web_extract` 与 `web-extract` 两种写法都认
        for (index, stage) in ["web_extract", "web-extract"].iter().enumerate() {
            let dir = tempfile::tempdir().expect("临时目录");
            write_skill(
                dir.path(),
                &format!("web{index}"),
                &format!(
                    "type = \"prompt\"\n[prompt]\nstage = \"{stage}\"\ntemplate = \"只要价格和规格。\"\n"
                ),
            );
            let registry = SkillRegistry::load(dir.path(), false);
            assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());
            assert_eq!(
                registry.prompt(PromptStage::WebExtract),
                Some("只要价格和规格。"),
                "stage = {stage}"
            );
            assert_eq!(registry.prompt(PromptStage::Review), None);
            assert_eq!(
                registry.summary().skills[0].prompt_stages,
                vec!["web_extract".to_owned()]
            );
        }
    }

    #[test]
    fn insight_template_validates_required_fields_and_length() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_skill(
            dir.path(),
            "template",
            r#"
type = "insight-template"
[insight-template]
required = ["title", "body", "tags"]
max_body_chars = 10
"#,
        );
        let registry = SkillRegistry::load(dir.path(), false);
        assert!(
            registry
                .validate_insight("t", "short", &["x".to_owned()])
                .is_ok()
        );
        assert!(
            registry
                .validate_insight("", "short", &["x".to_owned()])
                .is_err()
        );
        assert!(
            registry
                .validate_insight("t", "", &["x".to_owned()])
                .is_err()
        );
        assert!(registry.validate_insight("t", "short", &[]).is_err());
        assert!(
            registry
                .validate_insight("t", "01234567890", &["x".to_owned()])
                .is_err()
        );
    }

    #[test]
    fn exec_skill_is_rejected_unless_allowed() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_skill(dir.path(), "script", "type = \"exec\"\n");
        let denied = SkillRegistry::load(dir.path(), false);
        assert!(
            denied.warnings().iter().any(|w| w.contains("allow_exec")),
            "{:?}",
            denied.warnings()
        );
        let allowed = SkillRegistry::load_with_options(dir.path(), true, true);
        assert!(
            allowed.warnings().iter().any(|w| w.contains("不执行")),
            "{:?}",
            allowed.warnings()
        );
    }

    #[test]
    fn broken_manifest_only_produces_a_warning() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_skill(dir.path(), "bad", "type = \"loader-rule\"\n");
        write_skill(
            dir.path(),
            "good",
            "type = \"loader-rule\"\n[loader-rule]\nglob = \"*.sql\"\nlang = \"text\"\n",
        );
        let registry = SkillRegistry::load(dir.path(), false);
        assert_eq!(registry.loader_rules().len(), 1, "好的 skill 仍要加载");
        assert!(
            registry.warnings().iter().any(|w| w.contains("bad")),
            "{:?}",
            registry.warnings()
        );
    }

    #[test]
    fn source_rules_require_a_match_and_the_source_hook() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_skill(
            dir.path(),
            "no-match",
            r#"
type = "plugin"
[source]
kinds = ["web"]
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["source"]
"#,
        );
        let registry = SkillRegistry::load_with_options(dir.path(), true, true);
        assert!(
            registry.warnings().iter().any(|w| w.contains("no-match")),
            "{:?}",
            registry.warnings()
        );

        let dir = tempfile::tempdir().expect("临时目录");
        write_skill(
            dir.path(),
            "wrong-kind",
            r#"
type = "plugin"
[source]
match = ["https://example.com/*"]
kinds = ["git"]
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["source"]
"#,
        );
        let registry = SkillRegistry::load_with_options(dir.path(), true, true);
        assert!(
            registry.warnings().iter().any(|w| w.contains("只支持 web")),
            "{:?}",
            registry.warnings()
        );

        // allow_exec=false 时 source 只停用,不算坏清单
        let dir = tempfile::tempdir().expect("临时目录");
        write_skill(
            dir.path(),
            "denied",
            r#"
type = "plugin"
[source]
match = ["https://example.com/*"]
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["source"]
"#,
        );
        let registry = SkillRegistry::load(dir.path(), false);
        assert!(registry.warnings().iter().any(|w| w.contains("allow_exec")));
        assert_eq!(registry.source_plugin("web", "https://example.com/a"), None);
    }

    #[test]
    fn missing_directory_is_not_an_error() {
        let dir = tempfile::tempdir().expect("临时目录");
        let registry = SkillRegistry::load(&dir.path().join("nope"), false);
        assert!(registry.warnings().is_empty());
        assert!(registry.loader_rules().is_empty());
    }

    #[test]
    fn plugin_index_rules_merge_tags_and_pick_the_highest_priority_lang() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_skill(
            dir.path(),
            "low",
            r#"
type = "plugin"
name = "low"
[index]
include = ["**/*.vue"]
lang = "text"
tags = ["low"]
priority = 1
"#,
        );
        write_skill(
            dir.path(),
            "high",
            r#"
type = "plugin"
name = "high"
[index]
include = ["src/**"]
lang = "markdown"
tags = ["high"]
priority = 10
"#,
        );
        write_skill(
            dir.path(),
            "noise",
            r#"
type = "plugin"
name = "noise"
[index]
exclude = ["dist/**"]
"#,
        );
        let registry = SkillRegistry::load(dir.path(), false);
        assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());

        let hit = registry.match_plugins("demo", "src/App.vue");
        assert_eq!(hit.lang.as_deref(), Some("markdown"), "高优先级覆盖 lang");
        assert_eq!(hit.tags, vec!["high".to_owned(), "low".to_owned()]);

        let only_low = registry.match_plugins("demo", "other/App.vue");
        assert_eq!(only_low.lang.as_deref(), Some("text"));
        assert_eq!(only_low.tags, vec!["low".to_owned()]);

        assert!(registry.is_excluded("demo", "dist/app.js"));
        assert!(!registry.is_excluded("demo", "src/App.vue"));
    }

    #[test]
    fn plugin_index_rules_are_scoped_to_projects() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_skill(
            dir.path(),
            "sampleproj",
            r#"
type = "plugin"
name = "sampleproj"
[index]
projects = ["proj_Sampleproj"]
include = ["**/*.csv"]
tags = ["sampleproj"]
"#,
        );
        let registry = SkillRegistry::load(dir.path(), false);
        assert!(
            !registry
                .match_plugins("sampleproj", "a.csv")
                .tags
                .is_empty()
        );
        assert!(registry.match_plugins("other", "a.csv").tags.is_empty());
    }

    #[test]
    fn plugin_index_rules_reject_unsafe_or_meaningless_manifests() {
        let dir = tempfile::tempdir().expect("临时目录");
        write_skill(
            dir.path(),
            "bad",
            r#"
type = "plugin"
[index]
include = ["**/*.rs"]
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["chunk"]
"#,
        );
        let registry = SkillRegistry::load(dir.path(), false);
        // allow_exec=false 只禁用进程钩子,声明式 [index] 仍应加载
        assert!(registry.warnings().iter().any(|w| w.contains("allow_exec")));
        let hit = registry.match_plugins("demo", "src/lib.rs");
        assert!(hit.tags.is_empty(), "只有 include 的规则不应凭空加标签");
        assert!(hit.lang.is_none(), "没有 lang 时不应覆盖扫描结果");
    }

    #[test]
    fn unimplemented_permissions_are_rejected_instead_of_downgraded() {
        for field in ["read_project", "llm"] {
            let dir = tempfile::tempdir().expect("临时目录");
            write_skill(
                dir.path(),
                "unsupported",
                &format!(
                    r#"
type = "plugin"
name = "unsupported"
[index]
include = ["**/*.vue"]
lang = "vue"
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["chunk"]
[exec.permissions]
{field} = true
"#
                ),
            );
            let registry = SkillRegistry::load_with_options(dir.path(), true, true);
            let warnings = registry.warnings().join("\n");
            assert!(warnings.contains(field), "{field}: {warnings}");
            assert!(warnings.contains("未开放"), "{field}: {warnings}");
            // 整个插件都不登记:既没有进程钩子,也不能留下半套索引规则。
            assert_eq!(registry.plugin_count(), 0, "{field}");
            assert!(
                registry.match_plugins("demo", "src/App.vue").lang.is_none(),
                "{field}"
            );
        }
    }
}
