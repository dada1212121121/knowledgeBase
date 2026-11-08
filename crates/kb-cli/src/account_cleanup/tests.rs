use kb_core::account::{NewUser, PRIMARY_SPACE_ID, ROLE_ADMIN, ROLE_USER, UserStatus};
use kb_core::paths::KbPaths;
use kb_meta::system::UserUpdate;

use super::*;

const WEEK: i64 = 7 * 86_400_000;

struct Env {
    _home: tempfile::TempDir,
    paths: KbPaths,
    system: SystemStore,
}

fn env() -> Env {
    let home = tempfile::tempdir().unwrap();
    let paths = KbPaths::from_home(home.path());
    paths.ensure_dirs().unwrap();
    let system = SystemStore::open(paths.system_db()).unwrap();
    Env {
        _home: home,
        paths,
        system,
    }
}

fn new_user(name: &str, role: &str) -> NewUser {
    NewUser {
        username: name.to_owned(),
        email: Some(format!("{name}@example.com")),
        display_name: None,
        password_hash: "$argon2id$x".to_owned(),
        role_id: role.to_owned(),
        status: UserStatus::Active,
        registered_via: "test".to_owned(),
        must_change_password: false,
        email_verified: true,
    }
}

/// 建一个普通用户,并在磁盘上给他的知识库和头像放一点东西。
async fn user_with_files(
    env: &Env,
    name: &str,
) -> (kb_core::account::User, std::path::PathBuf, String) {
    let (user, space) = env
        .system
        .create_user(new_user(name, ROLE_USER))
        .await
        .unwrap();
    let dir = env.paths.space_dir(&space.id).unwrap();
    std::fs::create_dir_all(dir.join("sources")).unwrap();
    std::fs::write(dir.join("meta.db"), b"notes").unwrap();
    std::fs::write(dir.join("sources/secret.txt"), b"private").unwrap();
    let avatar = avatar::new_file_name(&user.id);
    avatar::write_atomic(env.paths.avatars_dir(), &avatar, b"png").unwrap();
    env.system
        .update_user(
            &user.id,
            UserUpdate {
                avatar: Some(Some(avatar.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    (user, dir, avatar)
}

#[tokio::test]
async fn an_expired_account_is_removed_with_its_knowledge_base_and_avatar_and_nobody_elses() {
    let env = env();
    // 第一个管理员接管主知识库
    let (boss, _) = env
        .system
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, alice_dir, alice_avatar) = user_with_files(&env, "alice").await;
    let (bob, bob_dir, bob_avatar) = user_with_files(&env, "bob").await;
    env.system
        .request_deletion(&alice.id, 1_000, WEEK)
        .await
        .unwrap();

    // 冷静期没结束:什么都不删
    let early = purge_due_accounts(&env.system, None, &env.paths, 1_000 + WEEK - 1)
        .await
        .unwrap();
    assert!(early.is_empty());
    assert!(alice_dir.exists());

    let done = purge_due_accounts(&env.system, None, &env.paths, 1_000 + WEEK)
        .await
        .unwrap();
    assert_eq!(done, [(alice.id.clone(), Purge::Done)]);
    assert!(!alice_dir.exists(), "她的知识库目录应被删除");
    assert!(!env.paths.avatars_dir().join(&alice_avatar).exists());
    assert!(env.system.get_user(&alice.id).await.unwrap().is_none());
    // 别人和系统本身毫发无损
    assert!(bob_dir.join("sources/secret.txt").exists());
    assert!(env.paths.avatars_dir().join(&bob_avatar).exists());
    assert!(env.system.get_user(&bob.id).await.unwrap().is_some());
    assert!(env.system.get_user(&boss.id).await.unwrap().is_some());
    assert!(env.paths.system_db().exists() && env.paths.spaces_dir().is_dir());
    // 再跑一轮:没有可处理的了
    assert!(
        purge_due_accounts(&env.system, None, &env.paths, 1_000 + WEEK)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn sessions_are_cleared_before_anything_is_deleted() {
    let env = env();
    env.system
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, ..) = user_with_files(&env, "alice").await;
    env.system
        .create_session(kb_core::account::UserSession {
            token_hash: "alice-session".into(),
            user_id: alice.id.clone(),
            created_at: 1,
            expires_at: i64::MAX,
            last_seen: 1,
            ip: None,
            user_agent: None,
        })
        .await
        .unwrap();
    env.system
        .request_deletion(&alice.id, 1_000, WEEK)
        .await
        .unwrap();
    purge_due_accounts(&env.system, None, &env.paths, 1_000 + WEEK)
        .await
        .unwrap();
    assert!(
        env.system
            .session_user("alice-session", 2)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn the_owner_of_the_primary_space_is_skipped_and_the_data_root_survives() {
    let env = env();
    let (boss, space) = env
        .system
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    assert_eq!(space.id, PRIMARY_SPACE_ID);
    env.system
        .create_user(new_user("second", ROLE_ADMIN))
        .await
        .unwrap();
    std::fs::write(env.paths.home().join("precious.txt"), b"everything").unwrap();
    // 申请阶段就被拒绝;这里模拟「有人绕过去,直接把状态改成了 deleting」(同一个 system.db,另开一个连接改)
    let conn = rusqlite::Connection::open(env.paths.system_db()).unwrap();
    conn.execute(
        "UPDATE users SET status = 'deleting', delete_after = 1 WHERE id = ?1",
        rusqlite::params![boss.id],
    )
    .unwrap();
    drop(conn);
    let results = purge_due_accounts(&env.system, None, &env.paths, i64::MAX)
        .await
        .unwrap();
    assert!(
        matches!(&results[0].1, Purge::Skipped(reason) if reason.contains("主知识库")),
        "{results:?}"
    );
    assert!(
        env.paths.home().join("precious.txt").exists(),
        "数据根目录一个字节都不能动"
    );
    assert!(env.paths.system_db().exists());
    assert!(env.system.get_user(&boss.id).await.unwrap().is_some());
}

#[tokio::test]
async fn a_half_finished_cleanup_is_picked_up_again_next_round() {
    let env = env();
    env.system
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, dir, avatar_name) = user_with_files(&env, "alice").await;
    env.system
        .request_deletion(&alice.id, 1_000, WEEK)
        .await
        .unwrap();
    // 上一轮目录已经删掉、但还没来得及删账号行就崩了
    std::fs::remove_dir_all(&dir).unwrap();
    avatar::remove(env.paths.avatars_dir(), &avatar_name);
    let results = purge_due_accounts(&env.system, None, &env.paths, 1_000 + WEEK)
        .await
        .unwrap();
    assert_eq!(
        results,
        [(alice.id.clone(), Purge::Done)],
        "文件已不在不算错,继续把账号行删掉"
    );
    assert!(env.system.get_user(&alice.id).await.unwrap().is_none());
}

#[test]
fn the_directory_to_delete_must_be_a_valid_space_inside_spaces() {
    let paths = KbPaths::from_home("/data/kb");
    assert_eq!(
        safe_space_dir(&paths, "sp_alice").unwrap(),
        std::path::Path::new("/data/kb/spaces/sp_alice")
    );
    // 主知识库就是数据根目录:无论如何都不给路径
    assert!(matches!(
        safe_space_dir(&paths, PRIMARY_SPACE_ID),
        Err(KbError::Forbidden(_))
    ));
    for bad in [
        "",
        "..",
        "../etc",
        "sp_",
        "sp_a/b",
        "sp_../x",
        "/etc",
        "SP_ALICE",
        "sp_a\0b",
        "spaces",
        "sp_alice/..",
    ] {
        assert!(safe_space_dir(&paths, bad).is_err(), "{bad:?} 不该得到路径");
    }
}

#[tokio::test]
async fn a_refusal_from_the_store_happens_before_any_file_is_touched() {
    let env = env();
    env.system
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, dir, avatar_name) = user_with_files(&env, "alice").await;
    env.system
        .request_deletion(&alice.id, 1_000, WEEK)
        .await
        .unwrap();
    // 她还拥有一个团队知识库:存储层会拒绝删除她
    let conn = rusqlite::Connection::open(env.paths.system_db()).unwrap();
    conn.execute(
        "INSERT INTO spaces (id, owner_id, name, kind, storage_bytes, created_at) VALUES ('sp_team1', ?1, '团队', 'team', 0, 1)",
        rusqlite::params![alice.id],
    )
    .unwrap();
    drop(conn);
    let results = purge_due_accounts(&env.system, None, &env.paths, 1_000 + WEEK)
        .await
        .unwrap();
    assert!(
        matches!(&results[0].1, Purge::Skipped(reason) if reason.contains("团队知识库")),
        "{results:?}"
    );
    // 关键:被拒绝时她的知识库目录和头像一个字节都没少(不能「先删了文件、再发现不让删账号」)
    assert!(
        dir.join("sources/secret.txt").exists(),
        "目录不能在被拒绝之前就被删"
    );
    assert!(env.paths.avatars_dir().join(&avatar_name).exists());
    assert!(env.system.get_user(&alice.id).await.unwrap().is_some());
}

#[test]
fn an_export_file_is_attributed_to_exactly_one_user() {
    assert_eq!(export_owner("usr_a-0123456789abcdef.tar.gz"), Some("usr_a"));
    assert_eq!(
        export_owner("usr_a-0123456789abcdef.tar.gz.part"),
        Some("usr_a")
    );
    // 一个 id 是另一个的前缀:各归各的
    assert_eq!(
        export_owner("usr_ab-0123456789abcdef.tar.gz"),
        Some("usr_ab")
    );
    for bad in [
        "usr_a-xyz.tar.gz",
        "usr_a-0123456789abcdef.zip",
        "usr_a.tar.gz",
        "random.txt",
        "usr_a-0123456789ABCDEF.tar.gz",
        "",
    ] {
        assert_eq!(export_owner(bad), None, "{bad:?}");
    }
}

#[tokio::test]
async fn purging_an_account_removes_only_that_users_exports() {
    let env = env();
    env.system
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, ..) = user_with_files(&env, "alice").await;
    let (bob, ..) = user_with_files(&env, "bob").await;
    std::fs::create_dir_all(env.paths.exports_dir()).unwrap();
    let alice_file = env
        .paths
        .exports_dir()
        .join(format!("{}-0123456789abcdef.tar.gz", alice.id));
    let alice_part = env
        .paths
        .exports_dir()
        .join(format!("{}-fedcba9876543210.tar.gz.part", alice.id));
    let bob_file = env
        .paths
        .exports_dir()
        .join(format!("{}-0123456789abcdef.tar.gz", bob.id));
    for file in [&alice_file, &alice_part, &bob_file] {
        std::fs::write(file, b"x").unwrap();
    }
    env.system
        .request_deletion(&alice.id, 1_000, WEEK)
        .await
        .unwrap();
    purge_due_accounts(&env.system, None, &env.paths, 1_000 + WEEK)
        .await
        .unwrap();
    assert!(
        !alice_file.exists() && !alice_part.exists(),
        "她的导出(含没写完的)应一起删掉"
    );
    assert!(bob_file.exists(), "别人的导出不能动");
}
