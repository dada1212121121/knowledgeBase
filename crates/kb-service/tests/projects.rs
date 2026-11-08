//! 项目编辑(`update_project`):只改给出的字段,名字与根目录不变。

use kb_core::ports::repo::ProjectRepo;
use kb_service::{ProjectPatch, ProjectService};
use kb_testkit::TestEnv;

async fn service() -> (TestEnv, ProjectService, tempfile::TempDir) {
    let env = TestEnv::new().await;
    let service = ProjectService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let dir = tempfile::tempdir().expect("项目目录");
    std::fs::create_dir_all(dir.path().join("src")).expect("建目录");
    std::fs::write(dir.path().join("src/lib.rs"), "pub fn f() {}\n").expect("写文件");
    (env, service, dir)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn update_changes_only_the_given_fields() {
    let (env, service, dir) = service().await;
    let project = service
        .add(dir.path(), Some("demo"))
        .await
        .expect("添加项目");
    assert!(project.include.is_empty());
    assert!(!project.allow_cloud_llm);

    // 只改 include / exclude
    let updated = service
        .update(
            "demo",
            ProjectPatch {
                include: Some(vec!["src/**".to_owned(), " docs/** ".to_owned()]),
                exclude: Some(vec!["vendor/**".to_owned()]),
                ..ProjectPatch::default()
            },
        )
        .await
        .expect("更新项目");
    assert_eq!(updated.include, vec!["src/**", "docs/**"], "空白要去掉");
    assert_eq!(updated.exclude, vec!["vendor/**"]);
    assert!(!updated.allow_cloud_llm, "没给的字段不变");
    assert_eq!(updated.root_path, project.root_path, "根目录不可改");

    // 再改两个开关
    let updated = service
        .update(
            "demo",
            ProjectPatch {
                allow_cloud_llm: Some(true),
                extract_enabled: Some(true),
                ..ProjectPatch::default()
            },
        )
        .await
        .expect("更新开关");
    assert!(updated.allow_cloud_llm);
    assert!(updated.extract_enabled);
    assert_eq!(
        updated.include,
        vec!["src/**", "docs/**"],
        "上一次的改动要保留"
    );

    // 落库了
    let stored = ProjectRepo::get(env.meta.as_ref(), &project.id)
        .await
        .expect("读项目")
        .expect("项目存在");
    assert_eq!(stored.include, vec!["src/**", "docs/**"]);
    assert_eq!(stored.exclude, vec!["vendor/**"]);
    assert!(stored.allow_cloud_llm && stored.extract_enabled);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn update_rejects_unknown_project() {
    let (_env, service, _dir) = service().await;
    let error = service
        .update(
            "nope",
            ProjectPatch {
                include: Some(vec!["src/**".to_owned()]),
                ..ProjectPatch::default()
            },
        )
        .await
        .expect_err("不存在的项目应报错");
    assert!(matches!(error, kb_core::KbError::NotFound(_)), "{error}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn empty_lists_mean_scan_everything() {
    let (_env, service, dir) = service().await;
    service
        .add(dir.path(), Some("demo"))
        .await
        .expect("添加项目");
    let updated = service
        .update(
            "demo",
            ProjectPatch {
                include: Some(Vec::new()),
                exclude: Some(vec!["  ".to_owned()]),
                ..ProjectPatch::default()
            },
        )
        .await
        .expect("更新项目");
    assert!(updated.include.is_empty(), "空数组 = 全部");
    assert!(updated.exclude.is_empty(), "全是空白的项要被丢掉");
}
