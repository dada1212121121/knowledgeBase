//! `ProjectService::add` 登记时的 `is_git` 要与 `list` / `show` 同口径。
//!
//! 背景:`list` / `show` 用 `git2::Repository::discover`(会向上找父目录),仓库子目录里的项目也算 git;
//! `add` 却只看 `<根>/.git`,于是登记仓库子目录里的项目先记成 false,要等第一次 `list` 才被写回 true。
//! 参照 `projects_is_git.rs` 的搭法。

use kb_core::ports::repo::ProjectRepo;
use kb_service::ProjectService;
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

/// 库里存的 `is_git` 列(绕开 `list` / `show` 直接读,这样不会被它们的写回掩盖)。
async fn stored_is_git(env: &TestEnv, id: &str) -> bool {
    ProjectRepo::get(env.meta.as_ref(), id)
        .await
        .expect("读项目")
        .expect("项目存在")
        .is_git
}

/// 登记仓库子目录里的项目:`add` 的返回值和库里的值一开始就是 true,不必等第一次 `list`。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn add_records_a_subdirectory_of_a_repo_as_git() {
    let (env, service, dir) = service().await;
    git2::Repository::init(dir.path()).expect("git init");
    let sub = dir.path().join("pkg");
    std::fs::create_dir_all(&sub).expect("建子目录");
    std::fs::write(sub.join("b.rs"), "pub fn b() {}\n").expect("写文件");

    let project = service.add(&sub, Some("sub")).await.expect("添加项目");
    assert!(project.is_git, "add 的返回值:仓库子目录里的项目也是 git");
    assert!(
        stored_is_git(&env, &project.id).await,
        "库里的值在第一次 list 之前就应是 true"
    );
}

/// 登记仓库根目录(`<根>/.git` 存在):原有行为不退化。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn add_records_a_repo_root_as_git() {
    let (env, service, dir) = service().await;
    git2::Repository::init(dir.path()).expect("git init");

    let project = service
        .add(dir.path(), Some("root"))
        .await
        .expect("添加项目");
    assert!(project.is_git);
    assert!(stored_is_git(&env, &project.id).await);
}

/// 登记普通目录(上级也不是仓库):false,返回值与库里一致。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn add_records_a_plain_directory_as_not_git() {
    let (env, service, dir) = service().await;

    let project = service
        .add(dir.path(), Some("plain"))
        .await
        .expect("添加项目");
    assert!(!project.is_git, "普通目录不是 git");
    assert!(!stored_is_git(&env, &project.id).await);
}

/// 登记之后才 `git init`:`list` 仍然按现状重算并写回(原有行为不退化)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn list_still_picks_up_git_init_after_add() {
    let (env, service, dir) = service().await;
    let project = service
        .add(dir.path(), Some("late"))
        .await
        .expect("添加项目");
    assert!(!project.is_git);

    git2::Repository::init(dir.path()).expect("git init");
    let listed = service
        .list()
        .await
        .expect("列出项目")
        .into_iter()
        .find(|info| info.project.name == "late")
        .expect("项目在列表里");
    assert!(listed.project.is_git, "git init 之后 list 应为 true");
    assert!(
        stored_is_git(&env, &project.id).await,
        "list 要把新值写回库里"
    );
}
