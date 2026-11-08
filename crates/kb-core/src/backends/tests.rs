//! 后端注册表的五条不变量,逐条钉住。

use super::manifest::{BackendKind, BackendManifest, BackendSource, parse_manifest};
use super::registry::BackendRegistry;

/// 造一份合法 manifest 文本。
fn manifest_text(id: &str, kind: &str) -> String {
    format!(
        r#"
id = "{id}"
name = "{id} 的显示名"
kind = "{kind}"
probe = ["{id}", "--version"]
"#
    )
}

/// 在临时目录里放一份 `<dir>/manifest.toml`。
fn write_manifest(home: &std::path::Path, dir: &str, body: &str) {
    let path = home.join("backends").join(dir);
    std::fs::create_dir_all(&path).expect("建目录");
    std::fs::write(path.join("manifest.toml"), body).expect("写 manifest");
}

#[test]
fn builtins_cover_the_four_kinds() {
    let registry = BackendRegistry::builtin_only();
    assert!(registry.len() >= 6, "内置条目应有 6 条以上");
    for kind in [
        BackendKind::Ocr,
        BackendKind::Transcribe,
        BackendKind::Embed,
        BackendKind::Rerank,
    ] {
        assert!(
            !registry.by_kind(kind).is_empty(),
            "{} 一条内置都没有",
            kind.as_str()
        );
    }
    // id 与配置取值对齐:`extract.ocr_backend` 只收这两个
    assert!(registry.get("rapidocr").is_some());
    assert!(registry.get("tesseract").is_some());
    assert!(registry.get("whisper-cli").is_some());
    assert!(registry.get("fastembed").is_some());
    // 没读盘时不该有 warning
    assert!(registry.warnings().is_empty());
    assert_eq!(registry.manifest_count(), 0);
}

#[test]
fn a_missing_backends_dir_is_not_an_error() {
    let tmp = tempfile::tempdir().expect("临时目录");
    let registry = BackendRegistry::load(tmp.path());
    assert_eq!(registry.len(), BackendRegistry::builtin_only().len());
    assert!(
        registry.warnings().is_empty(),
        "目录不存在不该报问题:{:?}",
        registry.warnings()
    );
}

#[test]
fn a_manifest_can_override_a_builtin_in_place() {
    let tmp = tempfile::tempdir().expect("临时目录");
    // 同名 id 盖掉内置的 tesseract:清单条数不变,来源变 Manifest,位置也不跳到最后
    write_manifest(
        tmp.path(),
        "tesseract",
        &manifest_text("tesseract", "ocr").replace("tesseract 的显示名", "我的 tesseract 包装"),
    );
    let registry = BackendRegistry::load(tmp.path());
    assert_eq!(
        registry.len(),
        BackendRegistry::builtin_only().len(),
        "同 id 只该留一份"
    );
    assert_eq!(registry.manifest_count(), 1);
    let entry = registry.get("tesseract").expect("找得到 tesseract");
    assert_eq!(entry.manifest.name, "我的 tesseract 包装");
    assert!(entry.source.is_manifest(), "来源应标成 manifest");
    // 位置:内置清单里 tesseract 是第 2 条(rapidocr 之后),覆盖后仍在第 2 条
    assert_eq!(registry.list()[1].id(), "tesseract");
}

#[test]
fn manifests_are_listed_after_builtins_and_sorted_by_id() {
    let tmp = tempfile::tempdir().expect("临时目录");
    write_manifest(tmp.path(), "zzz-ocr", &manifest_text("zzz-ocr", "ocr"));
    write_manifest(tmp.path(), "aaa-ocr", &manifest_text("aaa-ocr", "ocr"));
    // 不是目录的文件要被忽略(免得 `backends/README.md` 被当成后端)
    std::fs::write(tmp.path().join("backends").join("README.md"), "说明").expect("写文件");

    let registry = BackendRegistry::load(tmp.path());
    let ids: Vec<&str> = registry.list().iter().map(|entry| entry.id()).collect();
    assert_eq!(
        &ids[ids.len() - 2..],
        &["aaa-ocr", "zzz-ocr"],
        "manifest 按 id 排序且在末尾"
    );
    assert_eq!(registry.manifest_count(), 2);
}

#[test]
fn a_broken_manifest_only_drops_itself() {
    let tmp = tempfile::tempdir().expect("临时目录");
    // 1) 解析不了
    write_manifest(
        tmp.path(),
        "broken",
        "id = \"broken\"\nname = 12\nkind = \"ocr\"\n",
    );
    // 2) id 与目录名不一致
    write_manifest(tmp.path(), "dir-name", &manifest_text("other-id", "ocr"));
    // 3) 版本对不上
    write_manifest(
        tmp.path(),
        "future",
        "id = \"future\"\nname = \"未来\"\nkind = \"ocr\"\napi_version = 99\n",
    );
    // 4) 种类写错
    write_manifest(
        tmp.path(),
        "wrong-kind",
        &manifest_text("wrong-kind", "paddle"),
    );
    // 5) 好的那份必须还在
    write_manifest(tmp.path(), "good", &manifest_text("good", "transcribe"));

    let registry = BackendRegistry::load(tmp.path());
    assert!(registry.get("good").is_some(), "好的那份不能受牵连");
    assert_eq!(registry.manifest_count(), 1);
    assert_eq!(
        registry.warnings().len(),
        4,
        "四条坏的各记一条:{:?}",
        registry.warnings()
    );
    let joined = registry.warnings().join("\n");
    assert!(joined.contains("dir-name"), "id 不一致要指出目录");
    assert!(joined.contains("api_version"), "版本不对要说清版本");
}

#[test]
fn unknown_keys_are_rejected_instead_of_ignored() {
    // 拼错一个键如果被静默忽略,用户看到的是「装了但没生效」;必须当场报错
    let err = parse_manifest(
        "id = \"x\"\nname = \"X\"\nkind = \"ocr\"\nprob = [\"x\"]\n",
        "x",
    )
    .expect_err("未知键应当报错");
    assert!(
        err.contains("prob") || err.contains("unknown"),
        "错误里要带上拼错的键:{err}"
    );
}

#[test]
fn probe_and_id_rules_are_checked() {
    // probe 写了但空数组:不允许(想探活就得给命令,不想就整行删掉)
    assert!(
        parse_manifest(
            "id = \"x\"\nname = \"X\"\nkind = \"ocr\"\nprobe = []\n",
            "x"
        )
        .is_err()
    );
    // 大写 / 空格 / 下划线开头都不行(要能直接当目录名与命令行参数)
    assert!(parse_manifest("id = \"X\"\nname = \"X\"\nkind = \"ocr\"\n", "X").is_err());
    assert!(parse_manifest("id = \"a b\"\nname = \"X\"\nkind = \"ocr\"\n", "a b").is_err());
    assert!(parse_manifest("id = \"_x\"\nname = \"X\"\nkind = \"ocr\"\n", "_x").is_err());
    // 合法的几档
    for id in ["a", "a1", "my-ocr", "my_ocr_v2"] {
        assert!(
            parse_manifest(
                &format!("id = \"{id}\"\nname = \"X\"\nkind = \"ocr\"\n"),
                id
            )
            .is_ok(),
            "{id} 应当合法"
        );
    }
    // name 空白
    assert!(parse_manifest("id = \"x\"\nname = \" \"\nkind = \"ocr\"\n", "x").is_err());
}

#[test]
fn api_version_defaults_to_the_current_one() {
    let manifest: BackendManifest =
        toml::from_str("id = \"x\"\nname = \"X\"\nkind = \"ocr\"\n").expect("能解析");
    assert_eq!(manifest.api_version, super::manifest::API_VERSION);
    assert!(manifest.install.is_none(), "安装命令缺省是 None,不是空串");
    assert!(
        manifest.settings.is_empty(),
        "没写 settings 就是空表,不是 panic"
    );
}

#[test]
fn entry_source_labels_are_readable() {
    let registry = BackendRegistry::builtin_only();
    let entry = registry.get("rapidocr").expect("有 rapidocr");
    assert_eq!(entry.source.label(), "内置");
    assert_eq!(entry.source, BackendSource::Builtin);
    assert_eq!(entry.kind(), BackendKind::Ocr);
}
