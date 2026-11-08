//! 设置页新增 / 修改 / 删除 skill:服务端自己生成清单,校验不过不留任何东西,编号不能带路径。

use std::path::Path;

use kb_core::KbError;
use kb_service::{SkillDraft, SkillRegistry};

fn names(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn rule(name: &str, glob: &str) -> SkillDraft {
    SkillDraft {
        name: name.to_owned(),
        kind: "loader-rule".to_owned(),
        description: "把 proto 当文本按行窗口分块".to_owned(),
        enabled: true,
        glob: glob.to_owned(),
        lang: "text".to_owned(),
        tags: vec![
            "proto".to_owned(),
            " proto ".to_owned(),
            "schema".to_owned(),
            String::new(),
        ],
        ..SkillDraft::default()
    }
}

#[test]
fn a_new_loader_rule_is_written_loaded_and_applied() {
    let root = tempfile::tempdir().expect("目录");
    let id =
        SkillRegistry::save(root.path(), None, &rule("Proto 文件", "**/*.proto")).expect("保存");
    // 目录名只取名字里的英文字母数字;显示名原样保留中文
    assert_eq!(id, "proto");
    assert_eq!(names(root.path()), vec!["proto"]);

    let registry = SkillRegistry::load(root.path(), false);
    assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());
    let hit = registry.apply_loader("schemas/user.proto").expect("应命中");
    assert_eq!(hit.lang, "text");
    assert_eq!(
        hit.tags,
        vec!["proto", "schema"],
        "标签去空白去重、丢掉空串"
    );
    let info = &registry.summary().skills[0];
    assert_eq!(info.id, "proto");
    assert_eq!(info.name, "Proto 文件");

    // 全是中文的名字没有可用字符,目录名退回 skill
    let plain =
        SkillRegistry::save(root.path(), None, &rule("文件规则", "**/*.thrift")).expect("保存");
    assert_eq!(plain, "skill");
}

#[test]
fn directory_names_come_from_the_name_and_never_collide() {
    let root = tempfile::tempdir().expect("目录");
    let first =
        SkillRegistry::save(root.path(), None, &rule("Proto Rules", "**/*.proto")).expect("1");
    let second =
        SkillRegistry::save(root.path(), None, &rule("Proto Rules", "**/*.thrift")).expect("2");
    let third =
        SkillRegistry::save(root.path(), None, &rule("proto rules!", "**/*.avsc")).expect("3");
    assert_eq!(
        (first.as_str(), second.as_str(), third.as_str()),
        ("proto-rules", "proto-rules-2", "proto-rules-3")
    );
}

#[test]
fn editing_replaces_the_manifest_in_place_and_keeps_the_directory() {
    let root = tempfile::tempdir().expect("目录");
    let id = SkillRegistry::save(root.path(), None, &rule("Proto", "**/*.proto")).expect("保存");
    let changed = SkillDraft {
        glob: "**/*.thrift".to_owned(),
        name: "改名之后".to_owned(),
        ..rule("x", "")
    };
    assert_eq!(
        SkillRegistry::save(root.path(), Some(&id), &changed).expect("修改"),
        id
    );
    assert_eq!(
        names(root.path()),
        vec![id.clone()],
        "不会多出目录,也不留临时目录"
    );

    let registry = SkillRegistry::load(root.path(), false);
    assert!(registry.apply_loader("a.thrift").is_some());
    assert!(registry.apply_loader("a.proto").is_none(), "旧规则不再生效");
    assert_eq!(registry.summary().skills[0].name, "改名之后");
}

#[test]
fn a_disabled_skill_is_saved_validated_listed_but_not_applied() {
    let root = tempfile::tempdir().expect("目录");
    let draft = SkillDraft {
        enabled: false,
        ..rule("Proto", "**/*.proto")
    };
    SkillRegistry::save(root.path(), None, &draft).expect("保存");
    let registry = SkillRegistry::load(root.path(), false);
    assert!(registry.apply_loader("a.proto").is_none());
    let info = &registry.summary().skills[0];
    assert!(!info.enabled);
    assert!(
        !registry.draft(&info.id).expect("取草稿").enabled,
        "停用状态要能原样取回编辑"
    );

    // 停用的也要校验:写坏了不能因为停用就放过
    let broken = SkillDraft {
        enabled: false,
        glob: "[".to_owned(),
        ..rule("坏的", "")
    };
    assert!(SkillRegistry::save(root.path(), None, &broken).is_err());
}

#[test]
fn prompts_and_insight_templates_roundtrip_through_the_editor() {
    let root = tempfile::tempdir().expect("目录");
    let prompt = SkillDraft {
        name: "审核更严格".to_owned(),
        kind: "prompt".to_owned(),
        enabled: true,
        stage: "review".to_owned(),
        template: "只通过有明确结论的经验。\n\n多行\t也行。".to_owned(),
        ..SkillDraft::default()
    };
    let template = SkillDraft {
        name: "笔记要求".to_owned(),
        kind: "insight-template".to_owned(),
        enabled: true,
        required: vec!["title".to_owned(), "tags".to_owned(), "title".to_owned()],
        max_body_chars: Some(2000),
        ..SkillDraft::default()
    };
    let p = SkillRegistry::save(root.path(), None, &prompt).expect("提示词");
    let t = SkillRegistry::save(root.path(), None, &template).expect("模板");

    let registry = SkillRegistry::load(root.path(), false);
    assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());
    assert_eq!(
        registry.prompt(kb_service::PromptStage::Review),
        Some(prompt.template.as_str())
    );
    assert!(
        registry
            .validate_insight("", "正文", &["a".to_owned()])
            .is_err(),
        "标题必填"
    );
    assert!(
        registry
            .validate_insight("标题", "正文", &["a".to_owned()])
            .is_ok()
    );

    // 编辑器取回的内容和存进去的一致(必填项去重)
    assert_eq!(registry.draft(&p).expect("取回"), prompt);
    assert_eq!(
        registry.draft(&t).expect("取回").required,
        vec!["title", "tags"]
    );
}

#[test]
fn invalid_drafts_are_refused_and_leave_nothing_behind() {
    let root = tempfile::tempdir().expect("目录");
    let cases: Vec<(&str, SkillDraft)> = vec![
        ("名称为空", rule("  ", "**/*.proto")),
        ("名称太长", rule(&"长".repeat(61), "**/*.proto")),
        ("glob 为空", rule("a", "")),
        ("glob 写错", rule("a", "[")),
        (
            "分块方式有怪字符",
            SkillDraft {
                lang: "te xt;".to_owned(),
                ..rule("a", "*.x")
            },
        ),
        (
            "标签带逗号",
            SkillDraft {
                tags: vec!["a,b".to_owned()],
                ..rule("a", "*.x")
            },
        ),
        (
            "标签太多",
            SkillDraft {
                tags: (0..11).map(|n| format!("t{n}")).collect(),
                ..rule("a", "*.x")
            },
        ),
        (
            "脚本类不能建",
            SkillDraft {
                kind: "exec".to_owned(),
                ..rule("a", "*.x")
            },
        ),
        (
            "未知类型",
            SkillDraft {
                kind: "magic".to_owned(),
                ..rule("a", "*.x")
            },
        ),
        (
            "提示词没选阶段",
            SkillDraft {
                kind: "prompt".to_owned(),
                template: "x".to_owned(),
                ..rule("a", "")
            },
        ),
        (
            "提示词是空的",
            SkillDraft {
                kind: "prompt".to_owned(),
                stage: "extract".to_owned(),
                ..rule("a", "")
            },
        ),
        (
            "模板没有任何要求",
            SkillDraft {
                kind: "insight-template".to_owned(),
                ..rule("a", "")
            },
        ),
        (
            "模板必填项不认识",
            SkillDraft {
                kind: "insight-template".to_owned(),
                required: vec!["author".to_owned()],
                ..rule("a", "")
            },
        ),
        (
            "字数上限是 0",
            SkillDraft {
                kind: "insight-template".to_owned(),
                max_body_chars: Some(0),
                ..rule("a", "")
            },
        ),
    ];
    for (label, draft) in cases {
        let err = SkillRegistry::save(root.path(), None, &draft).expect_err(label);
        assert!(matches!(err, KbError::InvalidInput(_)), "{label}: {err}");
    }
    assert!(
        names(root.path()).is_empty(),
        "校验不过不能留下目录或临时目录:{:?}",
        names(root.path())
    );
}

#[test]
fn ids_cannot_escape_the_skills_directory() {
    let parent = tempfile::tempdir().expect("目录");
    let root = parent.path().join("skills");
    SkillRegistry::save(&root, None, &rule("a", "*.x")).expect("保存");
    // 兄弟目录里有个带 manifest.toml 的"skill",不能被编号够到
    let sibling = parent.path().join("victim");
    std::fs::create_dir(&sibling).expect("建");
    std::fs::write(sibling.join("manifest.toml"), "type = \"loader-rule\"\n").expect("写");

    // 这两个不以点开头、也不含控制字符,只有"不许带路径分隔符"这一条能挡住它们:
    // 绝对路径(join 会整个替换掉前面的目录)和先进入已有的 skill 目录再 `..` 出去
    let absolute = sibling.display().to_string();
    let climbing = "a/../../victim".to_owned();
    for bad in [&absolute, &climbing] {
        assert!(
            SkillRegistry::delete(&root, bad).is_err(),
            "删除 {bad:?} 应被拒绝"
        );
        assert!(
            SkillRegistry::save(&root, Some(bad), &rule("x", "*.x")).is_err(),
            "修改 {bad:?} 应被拒绝"
        );
    }
    assert!(
        sibling.join("manifest.toml").is_file(),
        "别的目录一个字节都没动"
    );

    for bad in ["../victim", "..", ".", "a/b", "a\\b", "", ".hidden", "/etc"] {
        assert!(
            SkillRegistry::delete(&root, bad).is_err(),
            "删除 {bad:?} 应被拒绝"
        );
        assert!(
            SkillRegistry::save(&root, Some(bad), &rule("x", "*.x")).is_err(),
            "修改 {bad:?} 应被拒绝"
        );
    }
    assert!(
        sibling.join("manifest.toml").is_file(),
        "别的目录一个字节都没动"
    );
}

#[test]
fn delete_only_removes_real_skill_directories() {
    let root = tempfile::tempdir().expect("目录");
    let id = SkillRegistry::save(root.path(), None, &rule("a", "*.x")).expect("保存");
    // 没有 manifest.toml 的目录不是 skill,不能被删
    std::fs::create_dir(root.path().join("notes")).expect("建");
    std::fs::write(root.path().join("notes/keep.txt"), "x").expect("写");
    assert!(matches!(
        SkillRegistry::delete(root.path(), "notes"),
        Err(KbError::NotFound(_))
    ));
    assert!(root.path().join("notes/keep.txt").is_file());
    // 软链指到别处也不能删
    #[cfg(unix)]
    {
        let elsewhere = tempfile::tempdir().expect("目录");
        std::fs::write(elsewhere.path().join("manifest.toml"), "x").expect("写");
        std::os::unix::fs::symlink(elsewhere.path(), root.path().join("linked")).expect("软链");
        assert!(SkillRegistry::delete(root.path(), "linked").is_err());
        assert!(elsewhere.path().join("manifest.toml").is_file());
    }
    SkillRegistry::delete(root.path(), &id).expect("删除");
    assert!(!root.path().join(&id).exists());
    assert!(
        matches!(
            SkillRegistry::delete(root.path(), &id),
            Err(KbError::NotFound(_))
        ),
        "再删一次是没找到"
    );
}

#[test]
fn hand_written_manifests_are_listed_and_editable_unless_they_reach_outside() {
    let root = tempfile::tempdir().expect("目录");
    let dir = root.path().join("handmade");
    std::fs::create_dir(&dir).expect("建");
    std::fs::write(
        dir.join("manifest.toml"),
        "type = \"prompt\"\n[prompt]\nstage = \"extract\"\nfile = \"p.md\"\n",
    )
    .expect("写");
    std::fs::write(dir.join("p.md"), "目录内的提示词文件").expect("写");
    let outside = root.path().join("outside");
    std::fs::create_dir(&outside).expect("建");
    std::fs::write(
        outside.join("manifest.toml"),
        "type = \"prompt\"\n[prompt]\nstage = \"review\"\nfile = \"../handmade/p.md\"\n",
    )
    .expect("写");

    let registry = SkillRegistry::load(root.path(), false);
    assert_eq!(
        registry
            .draft("handmade")
            .expect("目录内的文件可以读")
            .template,
        "目录内的提示词文件"
    );
    // 引用目录外文件的,运行时照常加载,但不给界面编辑(取回内容会把外面的文件读出来)
    assert!(registry.draft("outside").is_err());
    assert!(registry.draft("nope").is_err());
}
