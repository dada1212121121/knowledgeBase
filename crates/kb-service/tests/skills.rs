//! 声明式 skills 在索引链路上的效果(loader-rule 生效 / 热加载后下一个文件按新规则走)。
//!
//! 验收对应的场景:把 `**/*.rs` 映射成 `text`(行窗口分块)并附加标签 ——
//! 与设计规范里「把 `*.proto` 当作代码按窗口分块」是同一件事,只是换成一个默认有 tree-sitter 分块的扩展名,
//! 这样「规则没生效」与「规则生效」的块数差别是可断言的。

use std::path::Path;
use std::time::Duration;

use kb_core::model::{Collection, Project};
use kb_core::ports::repo::{ChunkRepo, ProjectRepo};
use kb_service::{CollectionService, IndexOptions, IndexService, SkillRegistry};
use kb_testkit::TestEnv;
use tempfile::TempDir;
use tokio::net::TcpListener;

const SAMPLE: &str = r#"fn alpha() -> u32 {
    1
}

fn beta() -> u32 {
    2
}

fn gamma() -> u32 {
    3
}
"#;

struct Fixture {
    env: TestEnv,
    dir: TempDir,
    skills_dir: TempDir,
    project: Project,
    collection: Collection,
}

async fn fixture(files: &[(&str, &str)]) -> Fixture {
    let dir = tempfile::tempdir().expect("临时项目目录");
    for (path, content) in files {
        write_file(dir.path(), path, content);
    }
    let skills_dir = tempfile::tempdir().expect("临时 skills 目录");
    let env = TestEnv::new().await;
    let project = Project {
        id: "p1".to_owned(),
        name: "demo".to_owned(),
        slug: "demo".to_owned(),
        root_path: dir.path().to_string_lossy().into_owned(),
        include: Vec::new(),
        exclude: Vec::new(),
        is_git: false,
        last_commit: None,
        last_indexed_at: None,
        allow_cloud_llm: false,
        extract_enabled: false,
        hooks_installed: false,
        created_at: 1_700_000_000_000,
    };
    ProjectRepo::create(env.meta.as_ref(), project.clone())
        .await
        .expect("写项目行");
    let collections =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let collection = collections
        .create_for_project("p1", "demo")
        .await
        .expect("建 collection");
    Fixture {
        env,
        dir,
        skills_dir,
        project,
        collection,
    }
}

fn write_file(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

fn write_skill(root: &Path, name: &str, manifest: &str) {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).expect("建 skill 目录");
    std::fs::write(dir.join("manifest.toml"), manifest).expect("写 manifest");
}

fn service(fixture: &Fixture, skills: SkillRegistry) -> IndexService {
    IndexService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
        fixture.env.chunker.clone(),
        fixture.env.scanner.clone(),
        IndexOptions::default(),
    )
    .with_skills(std::sync::Arc::new(skills))
}

#[tokio::test]
async fn loader_rule_switches_the_chunker_and_adds_tags() {
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    write_skill(
        fixture.skills_dir.path(),
        "window-rs",
        r#"
type = "loader-rule"
[loader-rule]
glob = "**/*.rs"
lang = "text"
tags = ["windowed"]
"#,
    );
    let registry = SkillRegistry::load(fixture.skills_dir.path(), false);
    assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());

    let service = service(&fixture, registry);
    let report = service
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("索引");
    assert!(report.errors.is_empty(), "{:?}", report.errors);

    let chunks = ChunkRepo::by_path(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        "src/lib.rs",
    )
    .await
    .expect("读块");
    // 默认的 tree-sitter 分块会把三个函数切成三块;规则改成行窗口后小文件只剩一块
    assert_eq!(chunks.len(), 1, "应改走行窗口分块:{chunks:?}");
    let rows = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &[chunks[0].id.clone()])
        .await
        .expect("查记录");
    assert!(
        rows[0].tags.iter().any(|tag| tag == "windowed"),
        "规则里的标签要进记录:{:?}",
        rows[0].tags
    );
}

#[tokio::test]
async fn without_a_matching_rule_the_default_chunker_is_used() {
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    let registry = SkillRegistry::load(fixture.skills_dir.path(), false);
    let service = service(&fixture, registry);
    service
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("索引");
    let chunks = ChunkRepo::by_path(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        "src/lib.rs",
    )
    .await
    .expect("读块");
    assert_eq!(chunks.len(), 3, "没有规则时按 tree-sitter 切三个函数");
}

#[tokio::test]
async fn reloading_skills_applies_to_the_next_file() {
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    let service = service(
        &fixture,
        SkillRegistry::load(fixture.skills_dir.path(), false),
    );
    service
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("首次索引");
    let before = ChunkRepo::by_path(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        "src/lib.rs",
    )
    .await
    .expect("读块");
    assert_eq!(before.len(), 3);

    // 热加载:写一个新 skill,换掉共享句柄(与守护进程的 reload_skills 走同一条路径)
    write_skill(
        fixture.skills_dir.path(),
        "window-rs",
        r#"
type = "loader-rule"
[loader-rule]
glob = "src/*.rs"
lang = "text"
tags = ["windowed"]
"#,
    );
    let next = SkillRegistry::load(fixture.skills_dir.path(), false);
    service.set_skills(std::sync::Arc::new(next));

    write_file(fixture.dir.path(), "src/other.rs", SAMPLE);
    service
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("再次索引");
    let after = ChunkRepo::by_path(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        "src/other.rs",
    )
    .await
    .expect("读块");
    assert_eq!(after.len(), 1, "热加载后新文件应按新规则分块");
    let rows = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &[after[0].id.clone()])
        .await
        .expect("查记录");
    assert!(rows[0].tags.iter().any(|tag| tag == "windowed"));
}

/// :进程插件走完整的索引链路。插件同时挂 chunk 与 enrich,断言:
/// - 分块确实由插件返回(默认 tree-sitter 会切 3 块,插件只返回 1 块);
/// - enrich 改写的文本 / header 落到了 LanceDB;
/// - `[index]` 的 tags 与 lang 生效。
#[tokio::test]
async fn plugin_hooks_drive_chunking_and_enrichment() {
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    let plugin_dir = fixture.skills_dir.path().join("upper");
    std::fs::create_dir_all(&plugin_dir).expect("建插件目录");
    std::fs::write(
        plugin_dir.join("plugin.py"),
        r#"import json
import sys

for line in sys.stdin:
    req = json.loads(line)
    rid = req.get("id")
    method = req.get("method")
    if method == "initialize":
        result = {"api_version": 1, "name": "upper"}
    elif method == "shutdown":
        break
    elif method == "chunk":
        doc = req["params"]["doc"]
        result = {"chunks": [{"key": "whole", "text": doc["text"],
                              "start_line": 1, "end_line": doc["text"].count("\n") + 1}]}
    elif method == "enrich":
        chunks = req["params"]["chunks"]
        for chunk in chunks:
            chunk["text"] = chunk["text"] + "\n[enriched]"
            chunk["header"] = "enriched-header"
        result = {"chunks": chunks}
    else:
        result = {"error": "unknown method"}
    print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}), flush=True)
"#,
    )
    .expect("写插件脚本");
    write_skill(
        fixture.skills_dir.path(),
        "upper",
        r#"
type = "plugin"
name = "upper"
version = "0.1.0"
api_version = 1
[index]
include = ["**/*.rs"]
lang = "text"
tags = ["plugin-rs"]
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["chunk", "enrich"]
"#,
    );
    let registry = SkillRegistry::load_with_options(fixture.skills_dir.path(), true, true);
    assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());

    let service = service(&fixture, registry);
    let report = service
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("索引");
    assert!(report.errors.is_empty(), "{:?}", report.errors);

    let chunks = ChunkRepo::by_path(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        "src/lib.rs",
    )
    .await
    .expect("读块");
    assert_eq!(chunks.len(), 1, "应使用插件返回的单个块:{chunks:?}");

    let rows = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &[chunks[0].id.clone()])
        .await
        .expect("查记录");
    assert_eq!(rows[0].header, "enriched-header");
    assert!(rows[0].text.ends_with("[enriched]"));
    assert_eq!(rows[0].lang.as_deref(), Some("text"));
    assert!(rows[0].tags.iter().any(|tag| tag == "plugin-rs"));
}

/// :插件 `extract` 钩子把任意格式抽成文本;extract 返回的 lang 会覆盖扫描结果。
#[tokio::test]
async fn plugin_extract_replaces_the_file_text() {
    let fixture = fixture(&[("data/a.txt", "原始文本")]).await;
    let plugin_dir = fixture.skills_dir.path().join("custom-text");
    std::fs::create_dir_all(&plugin_dir).expect("建插件目录");
    std::fs::write(
        plugin_dir.join("plugin.py"),
        r#"import base64
import json
import sys

for line in sys.stdin:
    req = json.loads(line)
    rid = req.get("id")
    if req.get("method") == "initialize":
        result = {"api_version": 1}
    elif req.get("method") == "shutdown":
        break
    elif req.get("method") == "extract":
        # 宿主必须把原文件字节完整送过来,而不是先按文本解码成替换字符
        raw = base64.b64decode(req["params"]["bytes_base64"]).decode("utf-8")
        assert raw == "原始文本", raw
        result = {"text": "来自插件", "lang": "text"}
    else:
        result = {"error": "unknown"}
    print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}), flush=True)
"#,
    )
    .expect("写插件脚本");
    write_skill(
        fixture.skills_dir.path(),
        "custom-text",
        r#"
type = "plugin"
name = "custom-text"
[index]
include = ["**/*.txt"]
tags = ["custom"]
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["extract"]
"#,
    );
    let registry = SkillRegistry::load_with_options(fixture.skills_dir.path(), true, true);
    assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());
    let service = service(&fixture, registry);
    service
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("索引");
    let chunks = ChunkRepo::by_path(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        "data/a.txt",
    )
    .await
    .expect("读块");
    let rows = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &[chunks[0].id.clone()])
        .await
        .expect("查记录");
    assert_eq!(rows[0].text, "来自插件");
    assert!(rows[0].tags.iter().any(|tag| tag == "custom"));
}

/// :纯排除规则在扫描阶段生效,文件连 `files` 行都不应留下。
#[tokio::test]
async fn plugin_exclude_rule_hides_noise_files() {
    let fixture = fixture(&[
        ("src/lib.rs", SAMPLE),
        ("noise/generated.json", "{\"generated\":true}"),
    ])
    .await;
    write_skill(
        fixture.skills_dir.path(),
        "noise",
        r#"
type = "plugin"
name = "noise"
[index]
exclude = ["noise/**"]
"#,
    );
    let registry = SkillRegistry::load(fixture.skills_dir.path(), false);
    assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());
    let service = service(&fixture, registry);
    service
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("索引");
    let noise = ChunkRepo::by_path(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        "noise/generated.json",
    )
    .await
    .expect("读块");
    assert!(noise.is_empty(), "排除的文件不应有块:{noise:?}");
}

/// :插件进程崩了只影响当前文件,索引继续走内置分块器,不能把整次索引弄失败。
#[tokio::test]
async fn a_crashing_plugin_falls_back_to_the_builtin_chunker() {
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    let plugin_dir = fixture.skills_dir.path().join("broken");
    std::fs::create_dir_all(&plugin_dir).expect("建插件目录");
    std::fs::write(
        plugin_dir.join("plugin.py"),
        r#"import json
import sys

for line in sys.stdin:
    req = json.loads(line)
    if req.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": req.get("id"),
                          "result": {"api_version": 1}}), flush=True)
    elif req.get("method") == "chunk":
        sys.exit(1)
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": req.get("id"),
                          "result": {}}), flush=True)
"#,
    )
    .expect("写插件脚本");
    write_skill(
        fixture.skills_dir.path(),
        "broken",
        r#"
type = "plugin"
name = "broken"
[index]
include = ["**/*.rs"]
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["chunk"]
"#,
    );
    let registry = SkillRegistry::load_with_options(fixture.skills_dir.path(), true, true);
    let service = service(&fixture, registry);
    let report = service
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("插件崩了也要完成索引");
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let chunks = ChunkRepo::by_path(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        "src/lib.rs",
    )
    .await
    .expect("读块");
    assert_eq!(chunks.len(), 3, "应回退到内置 tree-sitter 分块:{chunks:?}");
}

/// :插件 extract 能接管内置抽取器不认识的二进制格式(PDF 头只是假的,插件才是解析者)。
#[tokio::test]
async fn plugin_extract_handles_a_binary_format_before_the_builtin_extractor() {
    let fixture = fixture(&[("docs/manual.pdf", "PDF-BYTES-你好")]).await;
    let plugin_dir = fixture.skills_dir.path().join("pdf-plugin");
    std::fs::create_dir_all(&plugin_dir).expect("建插件目录");
    std::fs::write(
        plugin_dir.join("plugin.py"),
        r#"import base64
import json
import sys

for line in sys.stdin:
    req = json.loads(line)
    rid = req.get("id")
    if req.get("method") == "initialize":
        result = {"api_version": 1}
    elif req.get("method") == "extract":
        assert base64.b64decode(req["params"]["bytes_base64"]).startswith(b"PDF-BYTES")
        result = {"text": "PDF 来自插件", "lang": "text"}
    else:
        result = {"error": "unknown"}
    print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}), flush=True)
"#,
    )
    .expect("写插件脚本");
    write_skill(
        fixture.skills_dir.path(),
        "pdf-plugin",
        r#"
type = "plugin"
name = "pdf-plugin"
[index]
include = ["**/*.pdf"]
tags = ["pdf-custom"]
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["extract"]
"#,
    );
    let registry = SkillRegistry::load_with_options(fixture.skills_dir.path(), true, true);
    assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());
    let service = service(&fixture, registry);
    service
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("索引");
    let chunks = ChunkRepo::by_path(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        "docs/manual.pdf",
    )
    .await
    .expect("读块");
    assert!(!chunks.is_empty(), "插件抽取后应该有块");
    let rows = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &[chunks[0].id.clone()])
        .await
        .expect("查记录");
    assert_eq!(rows[0].text, "PDF 来自插件");
    assert!(rows[0].tags.iter().any(|tag| tag == "pdf-custom"));
}

/// :插件认领的“新二进制格式”要能穿过扫描器的「含 NUL 即二进制」过滤器。
///
/// 扩展名不在内置富文档列表里,内容又带 NUL;没有 `[index].include` 放行时扫描器会直接
/// 记成 Binary,插件根本看不到文件。这里用 `.blob` 验证放行 + extract 的完整链路。
#[tokio::test]
async fn plugin_extract_sees_a_binary_format_the_builtin_scanner_would_skip() {
    let fixture = fixture(&[("data/sample.blob", "BLOB\0custom-format-你好")]).await;
    let plugin_dir = fixture.skills_dir.path().join("blob-plugin");
    std::fs::create_dir_all(&plugin_dir).expect("建插件目录");
    std::fs::write(
        plugin_dir.join("plugin.py"),
        r#"import base64
import json
import sys

for line in sys.stdin:
    req = json.loads(line)
    rid = req.get("id")
    if req.get("method") == "initialize":
        result = {"api_version": 1}
    elif req.get("method") == "extract":
        assert b"\x00" in base64.b64decode(req["params"]["bytes_base64"])
        result = {"text": "BLOB 来自插件", "lang": "text"}
    else:
        result = {"error": "unknown"}
    print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}), flush=True)
"#,
    )
    .expect("写插件脚本");
    write_skill(
        fixture.skills_dir.path(),
        "blob-plugin",
        r#"
type = "plugin"
name = "blob-plugin"
[index]
include = ["**/*.blob"]
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["extract"]
"#,
    );
    let registry = SkillRegistry::load_with_options(fixture.skills_dir.path(), true, true);
    assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());
    let service = service(&fixture, registry);
    let report = service
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("索引");
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let chunks = ChunkRepo::by_path(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        "data/sample.blob",
    )
    .await
    .expect("读块");
    assert!(!chunks.is_empty(), "插件抽取后应该有块");
    let rows = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &[chunks[0].id.clone()])
        .await
        .expect("查记录");
    assert_eq!(rows[0].text, "BLOB 来自插件");
}

/// :插件升级 / 清单改标签后,内容没变的文件也要重新走插件。
///
/// 回归的是两条文件哈希快路径:第一条在 extract 之前,第二条在写库之前。只要插件命中,
/// 两条都必须让路,否则已索引的 3 万块永远不会因为装插件 / 改标签而变化。
#[tokio::test]
async fn plugin_changes_are_applied_to_unchanged_files_after_reload() {
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    let plugin_dir = fixture.skills_dir.path().join("relabel");
    std::fs::create_dir_all(&plugin_dir).expect("建插件目录");
    std::fs::write(
        plugin_dir.join("plugin.py"),
        r#"import json
import sys

for line in sys.stdin:
    req = json.loads(line)
    rid = req.get("id")
    method = req.get("method")
    if method == "initialize":
        result = {"api_version": 1}
    elif method == "chunk":
        result = {"chunks": [{"key": "whole", "text": "插件切出的正文",
                              "start_line": 1, "end_line": 1}]}
    else:
        result = {"error": "unknown"}
    print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}), flush=True)
"#,
    )
    .expect("写插件脚本");
    let manifest = |tags: &str| {
        format!(
            r#"
type = "plugin"
name = "relabel"
[index]
include = ["**/*.rs"]
tags = ["{tags}"]
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["chunk"]
"#
        )
    };
    write_skill(fixture.skills_dir.path(), "relabel", &manifest("v1"));
    let registry = SkillRegistry::load_with_options(fixture.skills_dir.path(), true, true);
    assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());
    service(&fixture, registry)
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("第一次索引");

    // 文件一个字节都没改,只改清单标签并 reload
    write_skill(fixture.skills_dir.path(), "relabel", &manifest("v2"));
    let registry = SkillRegistry::load_with_options(fixture.skills_dir.path(), true, true);
    let report = service(&fixture, registry)
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("第二次索引");
    assert!(report.errors.is_empty(), "{:?}", report.errors);

    let chunks = ChunkRepo::by_path(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        "src/lib.rs",
    )
    .await
    .expect("读块");
    assert_eq!(chunks.len(), 1, "{chunks:?}");
    let rows = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &[chunks[0].id.clone()])
        .await
        .expect("查记录");
    assert_eq!(rows[0].text, "插件切出的正文");
    assert!(
        rows[0].tags.iter().any(|tag| tag == "v2"),
        "{:?}",
        rows[0].tags
    );
    assert!(
        !rows[0].tags.iter().any(|tag| tag == "v1"),
        "{:?}",
        rows[0].tags
    );
}

/// 这个用例必须在真沙箱里跑:没有 bwrap 时直接失败,不能悄悄退化成裸跑,
/// 否则「读不到绑定外文件」测出来的是插件本身没写对,不是沙箱生效。
fn require_bwrap() {
    let true_bin = if Path::new("/bin/true").exists() {
        "/bin/true"
    } else {
        "/usr/bin/true"
    };
    let mut command = std::process::Command::new("bwrap");
    command.args([
        "--die-with-parent",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup",
        "--unshare-net",
    ]);
    let max_user_ns = std::fs::read_to_string("/proc/sys/user/max_user_namespaces")
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if max_user_ns > 0 {
        command.arg("--unshare-user");
    }
    command.args(["--ro-bind", "/", "/", "--", true_bin]);
    let ok = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    assert!(
        ok,
        "这个用例需要能建立 namespace 的 bwrap;没有就显式失败,不能退回裸跑"
    );
}

/// 插件在沙箱里探测两件事:能不能读绑定外的 secret、能不能连宿主本机的监听端口。
/// 返回插件自己写进块正文的 `fs=...;net=...`。
async fn probe_sandbox(network: bool) -> String {
    require_bwrap();
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    let secret = fixture.dir.path().join("secret.txt");
    std::fs::write(&secret, "TOP-SECRET").expect("写 secret");

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("起宿主监听");
    let port = listener.local_addr().expect("监听地址").port();
    let accept = tokio::spawn(async move {
        let _ = tokio::time::timeout(Duration::from_secs(20), listener.accept()).await;
    });

    let plugin_dir = fixture.skills_dir.path().join("probe");
    std::fs::create_dir_all(&plugin_dir).expect("建插件目录");
    std::fs::write(
        plugin_dir.join("plugin.py"),
        r#"import json
import socket
import sys

secret_path = sys.argv[1]
port = int(sys.argv[2])

def probe_fs():
    try:
        with open(secret_path, "rb") as handle:
            handle.read(1)
        return "leak"
    except Exception:
        return "blocked"

def probe_net():
    try:
        sock = socket.create_connection(("127.0.0.1", port), timeout=2)
        sock.close()
        return "leak"
    except Exception:
        return "blocked"

fs = probe_fs()
net = probe_net()
for line in sys.stdin:
    req = json.loads(line)
    rid = req.get("id")
    method = req.get("method")
    if method == "initialize":
        result = {"api_version": 1}
    elif method == "chunk":
        result = {"chunks": [{"key": "probe", "text": "fs=%s;net=%s" % (fs, net),
                              "start_line": 1, "end_line": 1}]}
    else:
        result = {"error": "unknown"}
    print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}), flush=True)
"#,
    )
    .expect("写插件脚本");

    let secret_arg = secret
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let permissions = if network {
        "\n[exec.permissions]\nnetwork = true\n"
    } else {
        ""
    };
    let manifest = format!(
        r#"
type = "plugin"
name = "probe"
version = "0.1.0"
api_version = 1
[index]
include = ["**/*.rs"]
[exec]
command = "python3"
args = ["plugin.py", "{secret_arg}", "{port}"]
hooks = ["chunk"]
timeout_ms = 10000
{permissions}"#
    );
    write_skill(fixture.skills_dir.path(), "probe", &manifest);

    let registry = SkillRegistry::load_with_options(fixture.skills_dir.path(), true, true);
    assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());
    let report = service(&fixture, registry)
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("索引");
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    accept.abort();

    let chunks = ChunkRepo::by_path(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        "src/lib.rs",
    )
    .await
    .expect("读块");
    assert_eq!(chunks.len(), 1, "插件没有接管分块: {chunks:?}");
    let rows = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &[chunks[0].id.clone()])
        .await
        .expect("查记录");
    let text = rows[0].text.clone();
    assert!(
        text.starts_with("fs="),
        "插件没有在沙箱里跑起来,拿到的是内置分块结果: {text}"
    );
    text
}

/// 文件系统隔离:secret 在项目目录,插件目录只挂了自己,cwd 之外不可见。
#[tokio::test]
async fn plugin_cannot_read_files_outside_its_directory() {
    let text = probe_sandbox(false).await;
    assert_eq!(text, "fs=blocked;net=blocked");
}

/// 网络隔离:没声明 network 时连宿主回环也连不上;声明后只放开网络,文件系统仍然关着。
#[tokio::test]
async fn plugin_network_follows_permissions() {
    let text = probe_sandbox(true).await;
    assert_eq!(text, "fs=blocked;net=leak");
}
