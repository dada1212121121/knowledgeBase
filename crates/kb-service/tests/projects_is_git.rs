//! `list` / `show` 的 `is_git` 按磁盘现状重算(体检 后续)。
//!
//! 背景:`projects.is_git` 只在 `add` 时写一次,项目登记之后才 `git init` 的目录(例如登记后才初始化仓库)
//! 会一直显示「不是 git 仓库」,界面上「提交后自动索引」开关因此被误判。

use kb_core::ports::repo::ProjectRepo;
use kb_service::evolution::HookManager;
use kb_service::{ProjectInfo, ProjectService};
use kb_testkit::TestEnv;

async fn service() -> (TestEnv, ProjectService, tempfile::TempDir) {
    let env = TestEnv::new().await;
    let service = ProjectService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let dir = tempfile::tempdir().expect("项目目录");
    std::fs::write(dir.path().join("a.rs"), "pub fn a() {}\n").expect("写文件");
    // 前提:临时目录本身(含它的上级目录)不在任何 git 仓库里,否则「非 git」的断言没有意义
    assert!(
        git2::Repository::discover(dir.path()).is_err(),
        "测试目录 {} 的上级已经是 git 仓库,换一个临时目录位置再跑",
        dir.path().display()
    );
    (env, service, dir)
}

/// 取某个项目的 `list` 结果。
async fn listed(service: &ProjectService, name: &str) -> ProjectInfo {
    service
        .list()
        .await
        .expect("列出项目")
        .into_iter()
        .find(|info| info.project.name == name)
        .expect("项目在列表里")
}

/// 库里存的 `is_git` 列(绕开 `list` / `show` 直接读)。
async fn stored_is_git(env: &TestEnv, id: &str) -> bool {
    ProjectRepo::get(env.meta.as_ref(), id)
        .await
        .expect("读项目")
        .expect("项目存在")
        .is_git
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn list_recomputes_is_git_from_disk() {
    let (env, service, dir) = service().await;
    let project = service
        .add(dir.path(), Some("demo"))
        .await
        .expect("添加项目");
    let root = project.root_path.clone();

    // 1. 非 git 目录:false
    let info = listed(&service, "demo").await;
    assert!(!info.project.is_git, "非 git 目录应为 false");
    assert!(!stored_is_git(&env, &project.id).await);

    // 2. 登记之后才 git init(EA 的情况):list 立刻变 true,并写回库里
    git2::Repository::init(dir.path()).expect("git init");
    let info = listed(&service, "demo").await;
    assert!(info.project.is_git, "git init 之后应为 true");
    assert!(
        stored_is_git(&env, &project.id).await,
        "发现与库里不同时要写回"
    );
    assert_eq!(
        info.project.is_git,
        HookManager::open(&root).is_ok(),
        "必须与 HookManager::open 同口径,否则开关可点却报「不是 git 仓库」"
    );

    // 3. 删掉 .git:又变回 false,库里也跟着改
    std::fs::remove_dir_all(dir.path().join(".git")).expect("删 .git");
    let info = listed(&service, "demo").await;
    assert!(!info.project.is_git, "删掉 .git 之后应为 false");
    assert!(!stored_is_git(&env, &project.id).await);
    assert_eq!(info.project.is_git, HookManager::open(&root).is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn show_recomputes_is_git_too() {
    let (env, service, dir) = service().await;
    let project = service
        .add(dir.path(), Some("demo"))
        .await
        .expect("添加项目");
    assert!(!service.show("demo").await.expect("详情").project.is_git);

    git2::Repository::init(dir.path()).expect("git init");
    let shown = service.show("demo").await.expect("详情");
    assert!(shown.project.is_git, "show 也要按现状重算");
    assert!(stored_is_git(&env, &project.id).await, "show 同样写回");

    std::fs::remove_dir_all(dir.path().join(".git")).expect("删 .git");
    assert!(!service.show("demo").await.expect("详情").project.is_git);
    assert!(!stored_is_git(&env, &project.id).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refresh_only_touches_is_git() {
    let (env, service, dir) = service().await;
    let project = service
        .add(dir.path(), Some("demo"))
        .await
        .expect("添加项目");
    // 模拟索引任务已经写过的字段
    let mut row = ProjectRepo::get(env.meta.as_ref(), &project.id)
        .await
        .expect("读项目")
        .expect("项目存在");
    row.last_commit = Some("abc1234".to_owned());
    row.last_indexed_at = Some(1_700_000_000_000);
    row.include = vec!["src/**".to_owned()];
    row.hooks_installed = false;
    ProjectRepo::update(env.meta.as_ref(), row.clone())
        .await
        .expect("更新项目");

    git2::Repository::init(dir.path()).expect("git init");
    let info = listed(&service, "demo").await;
    assert!(info.project.is_git);

    // 写回只改 is_git 这一列,其它字段原样
    let stored = ProjectRepo::get(env.meta.as_ref(), &project.id)
        .await
        .expect("读项目")
        .expect("项目存在");
    assert!(stored.is_git);
    assert_eq!(stored.last_commit.as_deref(), Some("abc1234"));
    assert_eq!(stored.last_indexed_at, Some(1_700_000_000_000));
    assert_eq!(stored.include, vec!["src/**".to_owned()]);
    assert_eq!(stored.name, row.name);
    assert_eq!(stored.root_path, row.root_path);
    assert_eq!(info.collection, format!("proj_{}", project.slug));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn subdirectory_of_a_repo_counts_as_git() {
    // HookManager::open 用 discover(向上找父目录),项目根在仓库子目录里也装得上钩子,所以同样算 git
    let (_env, service, dir) = service().await;
    git2::Repository::init(dir.path()).expect("git init");
    let sub = dir.path().join("pkg");
    std::fs::create_dir_all(&sub).expect("建子目录");
    let project = service.add(&sub, Some("sub")).await.expect("添加项目");
    // add 与 list/show 同口径(discover),登记时就记 true;这条以前断言 false,那正是被修掉的缺陷
    // (新口径的完整覆盖见 projects_add_is_git.rs)
    assert!(project.is_git);

    let info = listed(&service, "sub").await;
    assert!(info.project.is_git, "子目录也属于上级仓库");
    assert_eq!(
        info.project.is_git,
        HookManager::open(&project.root_path).is_ok()
    );
}
