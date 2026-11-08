//! 事件接收与 git 增量。
//!
//! 每个场景都在临时 git 仓库里跑,用 FakeEmbedder 的嵌入次数断言
//! “只重新索引确实变化的文件”。

use std::path::Path;
use std::sync::Arc;

use kb_core::model::{Collection, Project};
use kb_core::ports::repo::ProjectRepo;
use kb_service::evolution::{EventRequest, EventService};
use kb_service::jobs::IndexJobHandler;
use kb_service::jobs::queue::JobQueue;
use kb_service::jobs::worker::{JobRouter, Worker};
use kb_service::{CollectionService, IndexOptions, IndexService};
use kb_testkit::TestEnv;
use tempfile::TempDir;

struct Fixture {
    env: TestEnv,
    dir: TempDir,
    project: Project,
    #[allow(dead_code)]
    collection: Collection,
    index: Arc<IndexService>,
}

fn write_file(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

fn sample(tag: &str) -> String {
    format!("fn alpha_{tag}() -> u32 {{\n    1\n}}\n\nfn beta_{tag}() -> u32 {{\n    2\n}}\n")
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("临时项目");
    let repo = git2::Repository::init(dir.path()).expect("git init");
    {
        let mut config = repo.config().expect("config");
        config.set_str("user.name", "kb-test").expect("name");
        config
            .set_str("user.email", "kb@test.local")
            .expect("email");
    }
    write_file(dir.path(), "src/a.rs", &sample("a"));
    write_file(dir.path(), "src/b.rs", &sample("b"));
    write_file(dir.path(), ".gitignore", "target/\n");

    let env = TestEnv::new().await;
    let project = Project {
        id: "p1".to_owned(),
        name: "demo".to_owned(),
        slug: "demo".to_owned(),
        root_path: dir.path().to_string_lossy().into_owned(),
        include: Vec::new(),
        exclude: Vec::new(),
        is_git: true,
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
    let index = Arc::new(IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    ));
    Fixture {
        env,
        dir,
        project,
        collection,
        index,
    }
}

fn commit_all(dir: &Path, message: &str) -> String {
    let repo = git2::Repository::open(dir).expect("打开仓库");
    let mut index = repo.index().expect("index");
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .expect("add");
    index.write().expect("写 index");
    let tree_id = index.write_tree().expect("写 tree");
    let tree = repo.find_tree(tree_id).expect("找 tree");
    let signature = repo.signature().expect("签名");
    let parents: Vec<git2::Commit> = match repo.head() {
        Ok(head) => vec![head.peel_to_commit().expect("HEAD commit")],
        Err(_) => Vec::new(),
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &parent_refs,
    )
    .expect("提交")
    .to_string()
}

async fn run_jobs(fixture: &Fixture) {
    let queue = Arc::new(JobQueue::new(fixture.env.meta.clone()));
    let mut router = JobRouter::new();
    router.register(
        "index",
        Arc::new(IndexJobHandler::new(
            fixture.index.clone(),
            fixture.env.meta.clone(),
            50,
        )),
    );
    let (tx, rx) = tokio::sync::watch::channel(false);
    let worker = Worker::new(queue, Arc::new(router), rx);
    worker.run_until_idle().await.expect("跑任务");
    drop(tx);
}

async fn handle(fixture: &Fixture, kind: &str) -> kb_service::evolution::EventOutcome {
    let service = EventService::new(fixture.env.meta.clone());
    service
        .handle(EventRequest {
            kind: kind.to_owned(),
            project_root: fixture.dir.path().to_string_lossy().into_owned(),
            head: None,
            payload: None,
        })
        .await
        .expect("处理事件")
}

#[tokio::test]
async fn first_event_falls_back_to_full_index() {
    let fixture = fixture().await;
    commit_all(fixture.dir.path(), "init");
    // last_commit 为空 → 全量
    let outcome = handle(&fixture, "git_commit").await;
    assert_eq!(outcome.mode, "full", "{outcome:?}");
    assert!(outcome.job_id.is_some());
    run_jobs(&fixture).await;
    assert!(fixture.env.fake.embedding_count() > 0);
}

#[tokio::test]
async fn commit_only_reindexes_changed_files() {
    let fixture = fixture().await;
    let first = commit_all(fixture.dir.path(), "init");
    // 先做一次全量,把 last_commit 设好
    let outcome = handle(&fixture, "git_commit").await;
    assert_eq!(outcome.mode, "full");
    run_jobs(&fixture).await;
    let after_full = fixture.env.fake.embedding_count();
    assert!(after_full >= 4, "两个文件各两块:{after_full}");

    // 只改 a.rs 并提交
    write_file(fixture.dir.path(), "src/a.rs", &sample("a2"));
    let second = commit_all(fixture.dir.path(), "change a");
    assert_ne!(first, second);

    let outcome = handle(&fixture, "git_commit").await;
    assert_eq!(outcome.mode, "incremental", "{outcome:?}");
    assert_eq!(outcome.changed_files, 1, "{outcome:?}");
    run_jobs(&fixture).await;
    let delta = fixture.env.fake.embedding_count() - after_full;
    assert_eq!(delta, 2, "只应重新嵌入 a.rs 的两块,实际 {delta}");
}

#[tokio::test]
async fn amend_is_detected_as_a_change() {
    let fixture = fixture().await;
    commit_all(fixture.dir.path(), "init");
    handle(&fixture, "git_commit").await;
    run_jobs(&fixture).await;
    let after_full = fixture.env.fake.embedding_count();

    // amend:改内容并改写 HEAD
    write_file(fixture.dir.path(), "src/b.rs", &sample("b3"));
    {
        let repo = git2::Repository::open(fixture.dir.path()).expect("打开");
        let mut index = repo.index().expect("index");
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .expect("add");
        index.write().expect("写");
        let tree_id = index.write_tree().expect("tree");
        let tree = repo.find_tree(tree_id).expect("找 tree");
        let head = repo.head().expect("head").peel_to_commit().expect("commit");
        let signature = repo.signature().expect("签名");
        head.amend(
            Some("HEAD"),
            Some(&signature),
            Some(&signature),
            Some("amended"),
            None,
            Some(&tree),
        )
        .expect("amend");
    }

    let outcome = handle(&fixture, "git_commit").await;
    assert_eq!(outcome.mode, "incremental", "{outcome:?}");
    assert_eq!(outcome.changed_files, 1, "{outcome:?}");
    run_jobs(&fixture).await;
    let delta = fixture.env.fake.embedding_count() - after_full;
    assert_eq!(delta, 2, "amend 只应重新嵌入 b.rs:{delta}");
}

#[tokio::test]
async fn branch_switch_indexes_the_target_tree() {
    let fixture = fixture().await;
    commit_all(fixture.dir.path(), "init");
    handle(&fixture, "git_commit").await;
    run_jobs(&fixture).await;
    let after_full = fixture.env.fake.embedding_count();

    // 建分支,改 a.rs 并提交,再切回来
    {
        let repo = git2::Repository::open(fixture.dir.path()).expect("打开");
        let head = repo.head().expect("head").peel_to_commit().expect("commit");
        repo.branch("feature", &head, false).expect("建分支");
        repo.set_head("refs/heads/feature").expect("切分支");
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .expect("checkout");
    }
    write_file(fixture.dir.path(), "src/a.rs", &sample("branch"));
    commit_all(fixture.dir.path(), "feature change");

    let outcome = handle(&fixture, "git_checkout").await;
    assert_eq!(outcome.mode, "incremental", "{outcome:?}");
    assert_eq!(outcome.changed_files, 1, "{outcome:?}");
    run_jobs(&fixture).await;
    let delta = fixture.env.fake.embedding_count() - after_full;
    assert_eq!(delta, 2, "切分支后只应重新嵌入 a.rs:{delta}");
}

#[tokio::test]
async fn unknown_last_commit_falls_back_to_full() {
    let fixture = fixture().await;
    commit_all(fixture.dir.path(), "init");
    // 把 last_commit 设成一个不存在的提交(rebase / force push 之后)
    let mut project = fixture.project.clone();
    project.last_commit = Some("0".repeat(40));
    ProjectRepo::update(fixture.env.meta.as_ref(), project)
        .await
        .expect("更新项目");

    let outcome = handle(&fixture, "git_commit").await;
    assert_eq!(
        outcome.mode, "full",
        "找不到 last_commit 时应退回全量:{outcome:?}"
    );
}

#[tokio::test]
async fn uncommitted_worktree_changes_are_included() {
    let fixture = fixture().await;
    commit_all(fixture.dir.path(), "init");
    handle(&fixture, "git_commit").await;
    run_jobs(&fixture).await;

    // 不提交,只改工作区
    write_file(fixture.dir.path(), "src/b.rs", &sample("dirty"));
    let outcome = handle(&fixture, "git_commit").await;
    assert_eq!(outcome.mode, "incremental", "{outcome:?}");
    assert_eq!(outcome.changed_files, 1, "{outcome:?}");
}
