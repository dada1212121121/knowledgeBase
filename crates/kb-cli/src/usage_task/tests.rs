use kb_core::account::{NewUser, PRIMARY_SPACE_ID, ROLE_ADMIN, ROLE_USER, UserStatus};

use super::*;

fn new_user(name: &str, role: &str) -> NewUser {
    NewUser {
        username: name.to_owned(),
        email: Some(format!("{name}@example.com")),
        display_name: None,
        password_hash: "x".to_owned(),
        role_id: role.to_owned(),
        status: UserStatus::Active,
        registered_via: "test".to_owned(),
        must_change_password: false,
        email_verified: true,
    }
}

fn put(path: &std::path::Path, bytes: usize) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, vec![1u8; bytes]).unwrap();
}

#[tokio::test]
async fn a_round_measures_each_space_into_the_table_and_rotates_through_all_of_them() {
    let dir = tempfile::tempdir().unwrap();
    let paths = KbPaths::from_home(dir.path());
    paths.ensure_dirs().unwrap();
    let system = Arc::new(SystemStore::open(paths.system_db()).unwrap());
    let (_, primary) = system
        .create_user(new_user("first_admin", ROLE_ADMIN))
        .await
        .unwrap();
    let mut users = vec![primary];
    for i in 0..(PER_ROUND + 4) {
        let (_, space) = system
            .create_user(new_user(&format!("user_{i}"), ROLE_USER))
            .await
            .unwrap();
        users.push(space);
    }
    // 主知识库(数据根目录)和第一个普通用户各放一点东西
    put(&paths.sources_dir().join("admin.txt"), 700);
    let alice_paths = paths.for_space(&users[1].id).unwrap();
    put(&alice_paths.sources_dir().join("a.txt"), 300);
    put(&alice_paths.lance_dir().join("t/x"), 1_000);

    let first = measure_round(&system, &paths, 1_000, Duration::ZERO).await;
    assert_eq!(first, PER_ROUND as usize, "一轮最多量一批");
    let second = measure_round(&system, &paths, 2_000, Duration::ZERO).await;
    // 第二轮先量剩下 5 个从没量过的,再接着量最旧的 15 个:一轮轮往下转,不会总盯着同一批
    assert_eq!(second, PER_ROUND as usize);
    assert_eq!(
        system.storage_totals().await.unwrap().measured_spaces,
        25,
        "两轮之后每个都量过"
    );

    let admin_row = system
        .get_space_usage(PRIMARY_SPACE_ID)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        admin_row.usage.sources_bytes, 700,
        "主知识库按数据根目录量,不是 spaces/ 下"
    );
    let alice_row = system.get_space_usage(&users[1].id).await.unwrap().unwrap();
    assert_eq!(
        (
            alice_row.usage.sources_bytes,
            alice_row.usage.vectors_bytes,
            alice_row.total_bytes
        ),
        (300, 1_000, 1_300)
    );
    // 其它用户的目录一个字节都没算进别人名下
    assert!(admin_row.total_bytes < 1_000);
}

#[tokio::test]
async fn old_llm_usage_rows_are_swept_in_the_same_round() {
    let dir = tempfile::tempdir().unwrap();
    let paths = KbPaths::from_home(dir.path());
    paths.ensure_dirs().unwrap();
    let system = Arc::new(SystemStore::open(paths.system_db()).unwrap());
    let now: Millis = 1_800_000_000_000; // 2027-01-15
    let old_day = kb_service::llm_gate::day_text(now - 41 * 86_400_000);
    let recent_day = kb_service::llm_gate::day_text(now - 5 * 86_400_000);
    system
        .add_llm_usage("u", &old_day, "agent", 1, 1)
        .await
        .unwrap();
    system
        .add_llm_usage("u", &recent_day, "agent", 1, 1)
        .await
        .unwrap();
    measure_round(&system, &paths, now, Duration::ZERO).await;
    assert_eq!(
        system.llm_tokens_on("u", &old_day).await.unwrap(),
        0,
        "40 天前的删了"
    );
    assert_eq!(system.llm_tokens_on("u", &recent_day).await.unwrap(), 2);
}

#[test]
fn day_text_uses_the_site_calendar_not_utc() {
    assert_eq!(kb_service::llm_gate::day_text(0), "1970-01-01");
    assert_eq!(
        kb_service::llm_gate::day_text(1_800_000_000_000),
        "2027-01-15"
    );
    // UTC 1969-12-31 23:59:59.999 在上海已经是 1970-01-01 07:59:59
    assert_eq!(kb_service::llm_gate::day_text(-1), "1970-01-01");
}
