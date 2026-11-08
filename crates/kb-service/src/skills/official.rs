//! 随二进制分发的官方索引插件。
//!
//! 官方插件针对生产库里数量最大、内置分块器又处理不好的格式(以及索引前后的常见治理):
//! Vue 单文件组件、JSON/JSONC、SQL、SVG、Dart/Flutter、Kotlin、构建目录噪音排除、
//! 索引前密钥脱敏。它们共享一份 Python 实现(`plugin.py`),清单和脚本都编进二进制,
//! 不依赖部署目录里额外拷贝文件;设置页“安装官方插件”时再写到 `<KB_HOME>/skills/<id>`,
//! 让管理员能像普通插件一样停用、删除、改参数。
//!
//! 为什么打包进宿主而不是放进仓库根的 `skills/`:后者是 Codeg 的技能目录,
//! 知识库进程不读它;这里的清单必须落在 `<KB_HOME>/skills` 才会被 `load_all` 加载。

use std::path::Path;

use serde::{Deserialize, Serialize};

use kb_core::{KbError, Result};

use super::write::{check_id, scratch_dir};
use super::{Manifest, SkillKind, SkillRegistry};

/// 官方插件目录里展示给设置页的一项。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OfficialPluginInfo {
    /// 安装后的目录名,也是 `skill_id`。
    pub id: String,
    /// 显示名。
    pub name: String,
    /// 说明。
    pub description: String,
    /// 随宿主分发的版本。
    pub version: String,
    /// 标签。
    pub tags: Vec<String>,
    /// 实现的进程钩子(格式插件是 `chunk`,脱敏插件是 `enrich`;纯排除规则为空)。
    pub hooks: Vec<String>,
    /// 命中的文件(纯排除规则显示为 `**/*`,表示“全部文件都要检查排除项”)。
    pub include: Vec<String>,
    /// 排除的文件(纯声明式规则才有;没有时为空)。
    #[serde(default)]
    pub exclude: Vec<String>,
    /// 当前 skills 目录里是否已有同编号插件。
    pub installed: bool,
    /// 已安装版本(没装时为 `None`)。
    pub installed_version: Option<String>,
}

struct Definition {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    version: &'static str,
    tags: &'static [&'static str],
    hooks: &'static [&'static str],
    include: &'static [&'static str],
    exclude: &'static [&'static str],
    manifest: &'static str,
}

const DEFINITIONS: &[Definition] = &[
    Definition {
        id: "official-vue",
        name: "Vue 单文件组件",
        description: "把 template / script 分开切块,跳过 style",
        version: "0.1.0",
        tags: &["vue", "frontend"],
        hooks: &["chunk"],
        include: &["**/*.vue"],
        exclude: &[],
        manifest: include_str!("official/manifests/vue.toml"),
    },
    Definition {
        id: "official-json",
        name: "JSON / JSONC",
        description: "按顶层键 / 数组项切开 JSON,大配置文件不再是一整块",
        version: "0.1.0",
        tags: &["json", "config"],
        hooks: &["chunk"],
        include: &["**/*.json", "**/*.jsonc"],
        exclude: &[],
        manifest: include_str!("official/manifests/json.toml"),
    },
    Definition {
        id: "official-sql",
        name: "SQL 语句",
        description: "按语句切块,保留注释和表名,字符串里的分号不会切错",
        version: "0.1.0",
        tags: &["sql", "database"],
        hooks: &["chunk"],
        include: &["**/*.sql"],
        exclude: &[],
        manifest: include_str!("official/manifests/sql.toml"),
    },
    Definition {
        id: "official-svg",
        name: "SVG 图形",
        description: "抽出 title / desc / text 和图形概况,不再索引大段路径坐标",
        version: "0.1.0",
        tags: &["svg", "design"],
        hooks: &["chunk"],
        include: &["**/*.svg"],
        exclude: &[],
        manifest: include_str!("official/manifests/svg.toml"),
    },
    Definition {
        id: "official-dart",
        name: "Dart / Flutter",
        description: "按顶层声明切块,类和方法不会被拆散",
        version: "0.1.0",
        tags: &["dart", "flutter"],
        hooks: &["chunk"],
        include: &["**/*.dart"],
        exclude: &[],
        manifest: include_str!("official/manifests/dart.toml"),
    },
    Definition {
        id: "official-kotlin",
        name: "Kotlin",
        description: "按顶层声明切块,imports 单独成块,类、对象和函数不会被拆散",
        version: "0.1.0",
        tags: &["kotlin", "jvm"],
        hooks: &["chunk"],
        include: &["**/*.kt", "**/*.kts"],
        exclude: &["**/build/**", "**/out/**", "**/.gradle/**"],
        manifest: include_str!("official/manifests/kotlin.toml"),
    },
    Definition {
        id: "official-noise",
        name: "构建产物与依赖噪音",
        description: "排除 node_modules、构建目录、快照、压缩产物和锁文件;可装后按项目再改",
        version: "0.1.0",
        tags: &["index", "noise"],
        hooks: &[],
        include: &["**/*"],
        exclude: &[
            "**/node_modules/**",
            "**/dist/**",
            "**/build/**",
            "**/out/**",
            "**/target/**",
            "**/coverage/**",
            "**/.next/**",
            "**/.nuxt/**",
            "**/.svelte-kit/**",
            "**/.cache/**",
            "**/__pycache__/**",
            "**/.pytest_cache/**",
            "**/.venv/**",
            "**/venv/**",
            "**/previews/**",
            "**/fixtures/**",
            "**/__snapshots__/**",
            "**/snapshots/**",
            "**/*.min.js",
            "**/*.min.css",
            "**/*.map",
            "**/*.lock",
            "**/package-lock.json",
            "**/pnpm-lock.yaml",
            "**/yarn.lock",
            "**/Cargo.lock",
            "**/go.sum",
        ],
        manifest: include_str!("official/manifests/noise.toml"),
    },
    Definition {
        id: "official-redact",
        name: "索引前脱敏",
        description: "在嵌入前遮蔽常见密钥、令牌、私钥和密码赋值,避免敏感值进入向量库",
        version: "0.1.0",
        tags: &[],
        hooks: &["enrich"],
        include: &[
            "**/*.md",
            "**/*.mdx",
            "**/*.txt",
            "**/*.log",
            "**/*.json",
            "**/*.jsonc",
            "**/*.yaml",
            "**/*.yml",
            "**/*.toml",
            "**/*.ini",
            "**/*.conf",
            "**/*.cfg",
            "**/*.properties",
            "**/*.env",
            "**/.env",
            "**/.env.*",
            "**/*.sql",
            "**/*.csv",
        ],
        exclude: &[],
        manifest: include_str!("official/manifests/redact.toml"),
    },
];

/// 官方插件的静态清单(不含安装状态)。
pub fn catalog() -> Vec<OfficialPluginInfo> {
    DEFINITIONS
        .iter()
        .map(|definition| OfficialPluginInfo {
            id: definition.id.to_owned(),
            name: definition.name.to_owned(),
            description: definition.description.to_owned(),
            version: definition.version.to_owned(),
            tags: definition
                .tags
                .iter()
                .map(|tag| (*tag).to_owned())
                .collect(),
            hooks: definition
                .hooks
                .iter()
                .map(|hook| (*hook).to_owned())
                .collect(),
            include: definition
                .include
                .iter()
                .map(|pattern| (*pattern).to_owned())
                .collect(),
            exclude: definition
                .exclude
                .iter()
                .map(|pattern| (*pattern).to_owned())
                .collect(),
            installed: false,
            installed_version: None,
        })
        .collect()
}

/// 结合当前 registry,标出哪些官方插件已经装了、装的是哪个版本。
pub fn catalog_with(registry: &SkillRegistry) -> Vec<OfficialPluginInfo> {
    let mut list = catalog();
    for item in &mut list {
        if let Some(info) = registry
            .skills
            .iter()
            .find(|info| info.id == item.id && info.kind == SkillKind::Plugin.as_str())
        {
            item.installed = true;
            item.installed_version = Some(info.version.clone());
        }
    }
    list
}

fn find(id: &str) -> Result<&'static Definition> {
    DEFINITIONS
        .iter()
        .find(|definition| definition.id == id)
        .ok_or_else(|| KbError::NotFound(format!("官方插件 {id}")))
}

/// 安装一个官方插件。`overwrite = false` 时目录已存在就报冲突。
///
/// 和设置页保存普通插件一样,先在 `.saving-*` 临时目录里写清单 + 脚本,用启动时
/// 同一套 `load_one` 校验通过后再整体改名到正式位置;失败不会留下半个目录。
pub fn install(root: &Path, id: &str, overwrite: bool) -> Result<OfficialPluginInfo> {
    let definition = find(id)?;
    check_id(id)?;
    std::fs::create_dir_all(root)
        .map_err(|err| KbError::Internal(format!("创建 skills 目录失败: {err}")))?;
    let target = root.join(id);
    let _existing = match std::fs::symlink_metadata(&target) {
        Ok(meta) => {
            if !meta.is_dir() {
                return Err(KbError::Exists(format!(
                    "{} 已经存在且不是插件目录",
                    definition.id
                )));
            }
            if !overwrite {
                return Err(KbError::Exists(format!("官方插件 {}", definition.id)));
            }
            ensure_official(&target, definition)?;
            Some(target.clone())
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => {
            return Err(KbError::Internal(format!(
                "检查插件目录 {} 失败: {err}",
                target.display()
            )));
        }
    };
    let scratch = scratch_dir(root);
    std::fs::create_dir(&scratch)
        .map_err(|err| KbError::Internal(format!("创建临时目录失败: {err}")))?;
    let result = (|| {
        std::fs::write(scratch.join("manifest.toml"), definition.manifest)
            .map_err(|err| KbError::Internal(format!("写插件清单失败: {err}")))?;
        std::fs::write(
            scratch.join("plugin.py"),
            include_str!("official/plugin.py"),
        )
        .map_err(|err| KbError::Internal(format!("写插件脚本失败: {err}")))?;
        SkillRegistry::default()
            .load_one(&scratch, true)
            .map_err(|err| KbError::InvalidInput(format!("官方插件加载失败:{err}")))?;
        commit(&scratch, &target)
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result.map(|_| {
        let mut info = catalog()
            .into_iter()
            .find(|item| item.id == definition.id)
            .expect("官方插件清单刚查过");
        info.installed = true;
        info.installed_version = Some(definition.version.to_owned());
        info
    })
}

/// 覆盖安装前确认目标确实是同名官方插件,避免误删用户自己起的同编号 skill。
fn ensure_official(dir: &Path, definition: &Definition) -> Result<()> {
    let text = std::fs::read_to_string(dir.join("manifest.toml"))
        .map_err(|err| KbError::Exists(format!("{} 不是官方插件目录:{}", definition.id, err)))?;
    let manifest: Manifest = toml::from_str(&text)
        .map_err(|err| KbError::Exists(format!("{} 的清单无法解析:{err}", definition.id)))?;
    if manifest.kind != SkillKind::Plugin || manifest.name.as_deref() != Some(definition.id) {
        return Err(KbError::Exists(format!(
            "{} 已被同名 skill 占用,请先改名或删除",
            definition.id
        )));
    }
    Ok(())
}

fn commit(scratch: &Path, target: &Path) -> Result<()> {
    if !target.exists() {
        return std::fs::rename(scratch, target)
            .map_err(|err| KbError::Internal(format!("安装官方插件失败: {err}")));
    }
    let backup = target.with_file_name(format!(".backup-{}", uuid::Uuid::now_v7().simple()));
    std::fs::rename(target, &backup)
        .map_err(|err| KbError::Internal(format!("准备替换旧插件失败: {err}")))?;
    if let Err(err) = std::fs::rename(scratch, target) {
        let _ = std::fs::rename(&backup, target);
        return Err(KbError::Internal(format!("安装官方插件失败: {err}")));
    }
    let _ = std::fs::remove_dir_all(&backup);
    Ok(())
}

/// 卸载官方插件:只删确认过的官方目录。
pub fn uninstall(root: &Path, id: &str) -> Result<()> {
    let definition = find(id)?;
    check_id(id)?;
    let dir = root.join(id);
    let meta = std::fs::symlink_metadata(&dir)
        .map_err(|_| KbError::NotFound(format!("官方插件 {}", definition.id)))?;
    if !meta.is_dir() {
        return Err(KbError::Exists(format!("{} 不是插件目录", definition.id)));
    }
    ensure_official(&dir, definition)?;
    std::fs::remove_dir_all(&dir)
        .map_err(|err| KbError::Internal(format!("卸载官方插件失败: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::{Chunk, SourceDoc};

    #[test]
    fn official_manifests_load() {
        for definition in DEFINITIONS {
            let temp = std::env::temp_dir().join(format!(
                "kb-official-{}-{}",
                definition.id,
                uuid::Uuid::now_v7().simple()
            ));
            std::fs::create_dir_all(&temp).expect("临时目录");
            std::fs::write(temp.join("manifest.toml"), definition.manifest).expect("写清单");
            std::fs::write(temp.join("plugin.py"), include_str!("official/plugin.py"))
                .expect("写脚本");
            let mut registry = SkillRegistry::default();
            registry.load_one(&temp, true).unwrap_or_else(|err| {
                panic!("{} 加载失败:{err}", definition.id);
            });
            let _ = std::fs::remove_dir_all(&temp);
        }
    }

    /// 真实拉起 Python 宿主,确认清单里的命令 / 参数和 `plugin.py` 的协议确实对得上。
    /// 默认不跑:CI 不一定有 python3;`cargo test -p kb-service --lib official -- --ignored`。
    #[tokio::test]
    #[ignore = "需要 python3;真实宿主进程验证官方插件"]
    async fn official_plugins_chunk_through_the_host() {
        let root = std::env::temp_dir().join(format!(
            "kb-official-host-{}",
            uuid::Uuid::now_v7().simple()
        ));
        let cases = [
            (
                "official-vue",
                "src/App.vue",
                "<template><div>hello</div></template>\n<script setup>\nconst x = 1\n</script>\n<style>.a { color: red; }</style>",
                &["hello", "const x"][..],
                &["color: red"][..],
            ),
            (
                "official-json",
                "config/app.json",
                "{\"name\":\"kb\",\"nested\":{\"a\":1}}",
                &["kb"][..],
                &[][..],
            ),
            (
                "official-sql",
                "db/schema.sql",
                "CREATE TABLE users (id int);\nINSERT INTO users VALUES ('a;b');",
                &["CREATE TABLE", "users", "'a;b'"][..],
                &[][..],
            ),
            (
                "official-svg",
                "assets/logo.svg",
                "<svg><title>图标</title><desc>说明</desc><path d=\"M0 0 L10 10\"/><text>文字</text></svg>",
                &["图标", "说明", "文字"][..],
                &["M0 0"][..],
            ),
            (
                "official-dart",
                "lib/main.dart",
                "import 'package:flutter/material.dart';\n\nclass A {\n void b() {\n print('x');\n }\n}\n",
                &["class A", "void b"][..],
                &[][..],
            ),
            (
                "official-kotlin",
                "src/User.kt",
                "package com.example\n\nimport kotlinx.serialization.Serializable\n\n@Serializable\ndata class User(\n val id: Int,\n val name: String,\n)\n\nfun greet(user: User): String {\n return \"hi ${user.name}\"\n}\n\nprivate val version = 1\n",
                &[
                    "package com.example",
                    "data class User",
                    "val id: Int",
                    "val name: String",
                    "fun greet",
                    "version = 1",
                ][..],
                &[][..],
            ),
        ];
        for (id, _, _, _, _) in cases {
            install(&root, id, false).expect("安装官方插件");
        }
        // 纯声明式噪音规则与索引前脱敏也走同一套安装 / 加载流程。
        install(&root, "official-noise", false).expect("安装噪音规则");
        install(&root, "official-redact", false).expect("安装脱敏插件");
        let registry = SkillRegistry::load_with_options(&root, true, true);
        assert!(registry.warnings.is_empty(), "{:?}", registry.warnings);
        for (id, source, text, must, must_not) in cases {
            let matched = registry.match_plugins("proj", source);
            assert_eq!(matched.chunk_plugin.as_deref(), Some(id), "{source}");
            let doc = SourceDoc {
                source: source.to_owned(),
                lang: "text".to_owned(),
                text: text.to_owned(),
                file_hash: "hash".to_owned(),
                size: 1,
                mtime: 0,
                project_name: "proj".to_owned(),
            };
            let chunks = registry
                .chunk_with_plugin(id, &doc)
                .await
                .unwrap_or_else(|err| panic!("{id} 切块失败:{err}"));
            if id == "official-kotlin" {
                let class = chunks
                    .iter()
                    .find(|chunk| chunk.text.contains("data class User"))
                    .expect("Kotlin 类块");
                assert!(class.text.contains("val id: Int"), "构造参数被拆出类块");
                assert!(
                    class.text.contains("val name: String"),
                    "构造参数被拆出类块"
                );
                let function = chunks
                    .iter()
                    .find(|chunk| chunk.text.contains("fun greet"))
                    .expect("Kotlin 函数块");
                assert!(function.text.contains("return \"hi"), "函数体被拆散");
            }
            let joined = chunks
                .iter()
                .map(|chunk| chunk.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            for expected in must {
                assert!(joined.contains(expected), "{id} 缺少 {expected}:{joined}");
            }
            for forbidden in must_not {
                assert!(
                    !joined.contains(forbidden),
                    "{id} 不应包含 {forbidden}:{joined}"
                );
            }
        }
        // 噪音规则没有任何进程钩子,只应影响排除判断。
        assert!(registry.is_excluded("proj", "node_modules/pkg/index.js"));
        assert!(registry.is_excluded("proj", "web-ui/dist/app.js"));
        assert!(!registry.is_excluded("proj", "src/main.ts"));

        // 脱敏插件走 enrich,块数 / key / 顺序必须保持,密钥不能留在块文本里。
        let source = "docs/secret.md";
        assert_eq!(
            registry
                .match_plugins("proj", source)
                .enrich_plugin
                .as_deref(),
            Some("official-redact")
        );
        let doc = SourceDoc {
            source: source.to_owned(),
            lang: "text".to_owned(),
            text: "token = abcdefgh12345678".to_owned(),
            file_hash: "hash".to_owned(),
            size: 1,
            mtime: 0,
            project_name: "proj".to_owned(),
        };
        let original = vec![Chunk {
            key: "c1".to_owned(),
            text: "password = hunter2hunter2".to_owned(),
            start_line: 1,
            end_line: 1,
            symbol: None,
            title: None,
            header: source.to_owned(),
            anchor: None,
        }];
        let enriched = registry
            .enrich_with_plugin("official-redact", &doc, &original)
            .await
            .expect("脱敏");
        assert_eq!(enriched.len(), 1);
        assert_eq!(enriched[0].key, "c1");
        assert!(!enriched[0].text.contains("hunter2hunter2"));
        assert!(enriched[0].text.contains("[REDACTED]"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_and_uninstall_round_trip() {
        let root = std::env::temp_dir().join(format!(
            "kb-official-root-{}",
            uuid::Uuid::now_v7().simple()
        ));
        install(&root, "official-vue", false).expect("安装");
        assert!(root.join("official-vue/plugin.py").is_file());
        let registry = SkillRegistry::load(&root, false);
        let list = catalog_with(&registry);
        let vue = list
            .iter()
            .find(|item| item.id == "official-vue")
            .expect("vue");
        assert!(vue.installed);
        assert_eq!(vue.installed_version.as_deref(), Some("0.1.0"));
        assert!(install(&root, "official-vue", false).is_err());
        install(&root, "official-vue", true).expect("覆盖安装");
        uninstall(&root, "official-vue").expect("卸载");
        assert!(!root.join("official-vue").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
