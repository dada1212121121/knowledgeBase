//! SystemStore 的单元测试:账号、角色、会话、令牌、功能例外、审计。

use kb_core::account::{NewUser, ROLE_ADMIN, ROLE_USER, UserSession, UserStatus, UserToken};
use kb_core::{KbError, features};

use super::{RoleUpdate, SystemStore, UserFilter, UserUpdate, now_millis};

fn open() -> (tempfile::TempDir, SystemStore) {
    let dir = tempfile::tempdir().expect("临时目录");
    let store = SystemStore::open(dir.path().join("system.db")).expect("打开 system.db");
    (dir, store)
}

fn new_user(name: &str, role: &str) -> NewUser {
    NewUser {
        username: name.to_owned(),
        email: Some(format!("{name}@example.com")),
        display_name: None,
        password_hash: format!("$argon2id$fake${name}"),
        role_id: role.to_owned(),
        status: UserStatus::Active,
        registered_via: "admin".to_owned(),
        must_change_password: false,
        email_verified: true,
    }
}

/// 端口契约的接线冒烟:六个子域的实现都在 `ports.rs` 里,那里只有一行转发。
/// 转发写错(比如转成自己)能编译通过、运行时栈溢出,所以这里真走一次 `&dyn`。
#[tokio::test]
async fn every_port_works_behind_dyn() {
    use kb_core::ports::system::IdentityStore;

    let (_dir, store) = open();
    // 编译期:六个子域齐了聚合成立,且能做 trait object(A4c 起注入的就是它)
    fn assert_identity<T: IdentityStore>() {}
    assert_identity::<SystemStore>();
    let port: &dyn IdentityStore = &store;

    // AccountRepo:建人 → 查人 → 偏好往返
    let (admin, _space) = port
        .create_user(new_user("portable", ROLE_USER))
        .await
        .expect("建用户");
    let loaded = port.get_user(&admin.id).await.expect("查用户");
    assert_eq!(
        loaded.map(|user| user.username),
        Some("portable".to_owned())
    );
    port.set_prefs(
        &admin.id,
        &serde_json::json!({"density": "compact"}),
        now_millis(),
    )
    .await
    .expect("写偏好");
    assert_eq!(
        port.get_prefs(&admin.id).await.expect("读偏好")["density"],
        "compact"
    );

    // RoleRepo:内置角色在;管理员的功能集不是空的
    let roles = port.list_roles().await.expect("列角色");
    assert!(roles.iter().any(|role| role.id == ROLE_USER));
    // 功能集算得出来就行(具体哪些功能由 roles 的单测管)
    port.effective_features(&admin.id, kb_core::features::AiState::default())
        .await
        .expect("算功能");

    // NotifyRepo / SignupRepo / AdminKeyRepo:各挑一个只读入口
    assert!(
        port.list_notifications(&admin.id, false, None, 10)
            .await
            .expect("列通知")
            .is_empty()
    );
    // 活人不能被清理:端口把「不该删」翻译成 Err,而不是 Ok(No)
    assert!(port.check_purgeable(&admin.id, now_millis()).await.is_err());
    assert!(port.ensure_admin_key(&admin.id).await.is_ok());
    assert!(
        port.shared_by(&admin.id, now_millis())
            .await
            .expect("列我的分享")
            .is_empty()
    );
}

fn session(user_id: &str, hash: &str, expires_in_ms: i64) -> UserSession {
    let now = now_millis();
    UserSession {
        token_hash: hash.to_owned(),
        user_id: user_id.to_owned(),
        created_at: now,
        expires_at: now + expires_in_ms,
        last_seen: now,
        ip: Some("127.0.0.1".to_owned()),
        user_agent: Some("test".to_owned()),
    }
}

fn token(user_id: &str, id: &str, name: &str, hash: &str) -> UserToken {
    UserToken {
        id: id.to_owned(),
        user_id: user_id.to_owned(),
        name: name.to_owned(),
        token_hash: hash.to_owned(),
        scopes: "mcp".to_owned(),
        include_shared: false,
        created_at: now_millis(),
        last_used: None,
        revoked_at: None,
    }
}

#[tokio::test]
async fn open_seeds_builtin_roles_and_is_idempotent() {
    let (dir, store) = open();
    let latest = super::migrate::MIGRATIONS.last().expect("至少一个迁移").0;
    assert_eq!(store.schema_version().await.unwrap(), latest);
    let roles = store.list_roles().await.unwrap();
    assert_eq!(
        roles
            .iter()
            .map(|role| role.id.as_str())
            .collect::<Vec<_>>(),
        [ROLE_ADMIN, ROLE_USER]
    );
    let admin = &roles[0];
    assert!(admin.builtin && admin.all_features && admin.dangerous);
    let user = &roles[1];
    assert!(user.builtin && !user.all_features && !user.dangerous);
    let mut expected: Vec<String> = features::default_user_features()
        .into_iter()
        .map(str::to_owned)
        .collect();
    expected.sort();
    assert_eq!(user.features, expected, "普通用户默认功能 = 目录里的默认值");

    // 管理员改过普通用户的功能,重启(再次 open)不能被默认值覆盖
    store
        .update_role(
            ROLE_USER,
            RoleUpdate {
                features: Some(vec!["docs.notes".to_owned()]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    drop(store);
    let again = SystemStore::open(dir.path().join("system.db")).unwrap();
    assert_eq!(
        again.get_role(ROLE_USER).await.unwrap().unwrap().features,
        ["docs.notes"]
    );
    assert_eq!(again.list_roles().await.unwrap().len(), 2);
}

#[cfg(unix)]
#[tokio::test]
async fn system_db_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, _store) = open();
    let mode = std::fs::metadata(dir.path().join("system.db"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(
        mode & 0o077,
        0,
        "账号库不能被同组 / 其他用户读写,实际 {mode:o}"
    );
}

#[tokio::test]
async fn create_user_makes_a_personal_space_and_enforces_uniqueness() {
    let (_dir, store) = open();
    let (alice, space) = store
        .create_user(new_user("Alice", ROLE_USER))
        .await
        .unwrap();
    assert_eq!(alice.username, "alice", "用户名规范化为小写");
    assert!(alice.id.starts_with("usr_") && space.id.starts_with("sp_"));
    assert_eq!(space.owner_id, alice.id);
    assert_eq!(
        store.personal_space(&alice.id).await.unwrap().unwrap().id,
        space.id
    );
    assert!(alice.email_verified_at.is_some());

    // 用户名、邮箱不区分大小写,重复都是 Conflict
    let dup_name = store
        .create_user(new_user("ALICE", ROLE_USER))
        .await
        .unwrap_err();
    assert!(matches!(dup_name, KbError::Exists(_)), "{dup_name:?}");
    let mut dup_mail = new_user("alice2", ROLE_USER);
    dup_mail.email = Some("ALICE@example.com".to_owned());
    assert!(matches!(
        store.create_user(dup_mail).await.unwrap_err(),
        KbError::Exists(_)
    ));
    // 非法用户名 / 角色
    assert!(matches!(
        store
            .create_user(new_user("x", ROLE_USER))
            .await
            .unwrap_err(),
        KbError::InvalidInput(_)
    ));
    assert!(matches!(
        store
            .create_user(new_user("carol", "role_nope"))
            .await
            .unwrap_err(),
        KbError::InvalidInput(_)
    ));
    // 失败的创建不能留下半截数据
    assert_eq!(store.count_users().await.unwrap(), 1);
    assert_eq!(store.list_spaces().await.unwrap().len(), 1);
}

#[tokio::test]
async fn the_first_admin_adopts_the_primary_space_and_others_get_their_own() {
    let (_dir, store) = open();
    // 普通用户先注册,不能抢走主知识库
    let (early, early_space) = store
        .create_user(new_user("early", ROLE_USER))
        .await
        .unwrap();
    assert_ne!(early_space.id, kb_core::account::PRIMARY_SPACE_ID);
    let (first_admin, primary) = store
        .create_user(new_user("first_admin", ROLE_ADMIN))
        .await
        .unwrap();
    assert_eq!(
        primary.id,
        kb_core::account::PRIMARY_SPACE_ID,
        "第一个管理员接管主知识库"
    );
    assert_eq!(primary.owner_id, first_admin.id);
    let (_second_admin, second_space) = store
        .create_user(new_user("second_admin", ROLE_ADMIN))
        .await
        .unwrap();
    assert_ne!(
        second_space.id,
        kb_core::account::PRIMARY_SPACE_ID,
        "主知识库只有一个"
    );
    assert_eq!(
        store.personal_space(&early.id).await.unwrap().unwrap().id,
        early_space.id
    );
    assert_eq!(
        store
            .get_space(kb_core::account::PRIMARY_SPACE_ID)
            .await
            .unwrap()
            .unwrap()
            .owner_id,
        first_admin.id
    );
}

#[tokio::test]
async fn login_lookup_accepts_username_or_email_in_any_case() {
    let (_dir, store) = open();
    let (bob, _) = store.create_user(new_user("bob", ROLE_USER)).await.unwrap();
    for login in ["bob", "BOB", " bob ", "bob@example.com", "Bob@Example.COM"] {
        let found = store.find_user_by_login(login).await.unwrap();
        assert_eq!(
            found.map(|user| user.id),
            Some(bob.id.clone()),
            "登录名 {login:?}"
        );
    }
    assert!(store.find_user_by_login("nobody").await.unwrap().is_none());
    assert!(store.find_user_by_login("   ").await.unwrap().is_none());
    assert_eq!(
        store.password_hash(&bob.id).await.unwrap().as_deref(),
        Some("$argon2id$fake$bob")
    );
}

#[tokio::test]
async fn the_last_admin_cannot_be_demoted_or_disabled() {
    let (_dir, store) = open();
    let (root, _) = store
        .create_user(new_user("root_admin", ROLE_ADMIN))
        .await
        .unwrap();
    let demote = store
        .update_user(
            &root.id,
            UserUpdate {
                role_id: Some(ROLE_USER.to_owned()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(demote, KbError::Forbidden(_)), "{demote:?}");
    let disable = store
        .update_user(
            &root.id,
            UserUpdate {
                status: Some(UserStatus::Disabled),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(disable, KbError::Forbidden(_)));
    assert_eq!(store.count_admins().await.unwrap(), 1);

    // 有了第二个管理员,第一个就可以降级
    let (second, _) = store
        .create_user(new_user("second_admin", ROLE_ADMIN))
        .await
        .unwrap();
    store
        .update_user(
            &root.id,
            UserUpdate {
                role_id: Some(ROLE_USER.to_owned()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    // 现在 second 是最后一个
    let err = store
        .update_user(
            &second.id,
            UserUpdate {
                status: Some(UserStatus::Disabled),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::Forbidden(_)));
    // 改昵称之类不受影响
    store
        .update_user(
            &second.id,
            UserUpdate {
                display_name: Some("第二管理员".to_owned()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn disabling_a_user_signs_them_out_everywhere() {
    let (_dir, store) = open();
    let (admin, _) = store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (eve, _) = store.create_user(new_user("eve", ROLE_USER)).await.unwrap();
    store
        .create_session(session(&eve.id, "h1", 60_000))
        .await
        .unwrap();
    store
        .create_token(token(&eve.id, "t1", "ci", "th1"))
        .await
        .unwrap();
    let now = now_millis();
    assert!(store.session_user("h1", now).await.unwrap().is_some());
    assert!(store.find_token("th1").await.unwrap().is_some());

    store
        .update_user(
            &eve.id,
            UserUpdate {
                status: Some(UserStatus::Disabled),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        store.session_user("h1", now).await.unwrap().is_none(),
        "停用后会话失效"
    );
    assert!(
        store.find_token("th1").await.unwrap().is_none(),
        "停用后令牌也不能用"
    );
    assert!(
        store
            .list_user_sessions(&eve.id, now)
            .await
            .unwrap()
            .is_empty()
    );
    let _ = admin;
}

#[tokio::test]
async fn sessions_expire_renew_and_are_scoped_to_their_user() {
    let (_dir, store) = open();
    let (a, _) = store.create_user(new_user("aa1", ROLE_USER)).await.unwrap();
    let (b, _) = store.create_user(new_user("bb1", ROLE_USER)).await.unwrap();
    store
        .create_session(session(&a.id, "live", 60_000))
        .await
        .unwrap();
    store
        .create_session(session(&a.id, "dead", -1_000))
        .await
        .unwrap();
    store
        .create_session(session(&b.id, "bs", 60_000))
        .await
        .unwrap();
    let now = now_millis();

    let (s, user) = store.session_user("live", now).await.unwrap().unwrap();
    assert_eq!(user.id, a.id, "会话只对应创建它的用户");
    assert_eq!(s.user_id, a.id);
    assert!(
        store.session_user("dead", now).await.unwrap().is_none(),
        "过期会话不可用"
    );
    assert!(store.session_user("unknown", now).await.unwrap().is_none());

    store
        .touch_session("live", now, now + 120_000)
        .await
        .unwrap();
    assert!(
        store
            .session_user("live", now + 90_000)
            .await
            .unwrap()
            .is_some(),
        "续期后更晚才过期"
    );

    assert_eq!(
        store.purge_expired_sessions(now).await.unwrap(),
        1,
        "只清掉过期的"
    );
    // 退出其它设备:保留当前这一个
    store
        .create_session(session(&a.id, "other", 60_000))
        .await
        .unwrap();
    assert_eq!(
        store
            .delete_user_sessions(&a.id, Some("live"))
            .await
            .unwrap(),
        1
    );
    assert!(store.session_user("live", now).await.unwrap().is_some());
    assert!(store.session_user("other", now).await.unwrap().is_none());
    assert!(
        store.session_user("bs", now).await.unwrap().is_some(),
        "不影响别的用户"
    );
}

#[tokio::test]
async fn changing_the_password_signs_out_other_sessions() {
    let (_dir, store) = open();
    let (u, _) = store
        .create_user(new_user("pwuser", ROLE_USER))
        .await
        .unwrap();
    store
        .create_session(session(&u.id, "keep", 60_000))
        .await
        .unwrap();
    store
        .create_session(session(&u.id, "drop", 60_000))
        .await
        .unwrap();
    store
        .set_password_hash(&u.id, "$argon2id$new", false, Some("keep"))
        .await
        .unwrap();
    let now = now_millis();
    assert!(store.session_user("keep", now).await.unwrap().is_some());
    assert!(store.session_user("drop", now).await.unwrap().is_none());
    assert_eq!(
        store.password_hash(&u.id).await.unwrap().as_deref(),
        Some("$argon2id$new")
    );
    assert!(matches!(
        store
            .set_password_hash("usr_missing", "x", false, None)
            .await
            .unwrap_err(),
        KbError::NotFound(_)
    ));
}

#[tokio::test]
async fn tokens_belong_to_their_owner() {
    let (_dir, store) = open();
    let (a, _) = store
        .create_user(new_user("tok_a", ROLE_USER))
        .await
        .unwrap();
    let (b, _) = store
        .create_user(new_user("tok_b", ROLE_USER))
        .await
        .unwrap();
    store
        .create_token(token(&a.id, "ta", "laptop", "hash_a"))
        .await
        .unwrap();
    // 同一用户同名冲突,不同用户同名没关系
    assert!(matches!(
        store
            .create_token(token(&a.id, "ta2", "laptop", "hash_a2"))
            .await
            .unwrap_err(),
        KbError::Exists(_)
    ));
    store
        .create_token(token(&b.id, "tb", "laptop", "hash_b"))
        .await
        .unwrap();

    let (found, owner) = store.find_token("hash_a").await.unwrap().unwrap();
    assert_eq!(owner.id, a.id, "令牌解析到它的主人");
    assert_eq!(found.id, "ta");
    assert_eq!(store.list_tokens(&a.id).await.unwrap().len(), 1);

    // B 不能撤销 A 的令牌
    assert!(!store.revoke_token(&b.id, "ta", now_millis()).await.unwrap());
    assert!(store.find_token("hash_a").await.unwrap().is_some());
    assert!(store.revoke_token(&a.id, "ta", now_millis()).await.unwrap());
    assert!(store.find_token("hash_a").await.unwrap().is_none());
    // 撤销后可以重新用这个名字
    store
        .create_token(token(&a.id, "ta3", "laptop", "hash_a3"))
        .await
        .unwrap();
    assert!(store.find_token("hash_a3").await.unwrap().is_some());
}

#[tokio::test]
async fn effective_features_follow_role_overrides_and_the_ai_switch() {
    let (_dir, store) = open();
    let (admin, _) = store
        .create_user(new_user("adm", ROLE_ADMIN))
        .await
        .unwrap();
    let (user, _) = store.create_user(new_user("usr", ROLE_USER)).await.unwrap();

    let set = store.effective_features(&user.id, true).await.unwrap();
    assert!(set.allows("docs.notes") && set.allows("search.deep"));
    assert!(!set.allows("ai.assistant") && !set.allows("sys.users"));

    // 用户例外:允许 ACP、禁止上传
    store
        .set_feature_override(&user.id, "ai.acp", Some("allow"))
        .await
        .unwrap();
    store
        .set_feature_override(&user.id, "docs.upload", Some("deny"))
        .await
        .unwrap();
    let set = store.effective_features(&user.id, true).await.unwrap();
    assert!(set.allows("ai.acp") && !set.allows("docs.upload"));
    assert_eq!(store.feature_overrides(&user.id).await.unwrap().len(), 2);
    // 清除例外 = 跟随角色
    store
        .set_feature_override(&user.id, "docs.upload", None)
        .await
        .unwrap();
    assert!(
        store
            .effective_features(&user.id, true)
            .await
            .unwrap()
            .allows("docs.upload")
    );

    // 危险功能不能靠例外「偷偷」授予普通用户
    let err = store
        .set_feature_override(&user.id, "sys.users", Some("allow"))
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::InvalidInput(_)), "{err:?}");
    // 但可以给管理员单独收走某项
    store
        .set_feature_override(&admin.id, "ai.acp", Some("deny"))
        .await
        .unwrap();
    let adm = store.effective_features(&admin.id, true).await.unwrap();
    assert!(adm.allows("sys.users") && adm.allows("ai.assistant") && !adm.allows("ai.acp"));

    // AI 总开关关闭:所有人(含管理员)的 AI 功能都没了,其它不受影响
    let off = store.effective_features(&user.id, false).await.unwrap();
    assert!(!off.allows("search.deep") && !off.allows("ai.acp") && off.allows("docs.notes"));
    assert!(
        !store
            .effective_features(&admin.id, false)
            .await
            .unwrap()
            .allows("ai.assistant")
    );

    assert!(
        store
            .set_feature_override(&user.id, "no.such", Some("allow"))
            .await
            .is_err()
    );
    assert!(
        store
            .set_feature_override(&user.id, "base", Some("deny"))
            .await
            .is_err(),
        "base 不是功能点"
    );
    assert!(
        store
            .set_feature_override("usr_missing", "ai.acp", Some("allow"))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn role_crud_guards_dangerous_features_and_builtins() {
    let (_dir, store) = open();
    // 危险功能只能放进「危险」角色
    let err = store
        .create_role(
            "运维",
            "",
            vec!["docs.notes".to_owned(), "sys.ops".to_owned()],
            false,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::InvalidInput(_)), "{err:?}");
    let ops = store
        .create_role(
            "运维",
            "管备份和状态",
            vec!["docs.notes".to_owned(), "sys.ops".to_owned()],
            true,
        )
        .await
        .unwrap();
    assert!(ops.dangerous && ops.features.contains(&"sys.ops".to_owned()) && !ops.builtin);
    assert!(matches!(
        store
            .create_role("运维", "", vec![], false)
            .await
            .unwrap_err(),
        KbError::Exists(_)
    ));
    assert!(
        store
            .create_role("坏", "", vec!["nope.nope".to_owned()], false)
            .await
            .is_err()
    );

    // 收回「危险」资格时,已勾的危险功能一并拿掉
    let demoted = store
        .update_role(
            &ops.id,
            RoleUpdate {
                dangerous: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(!demoted.dangerous);
    assert_eq!(
        demoted.features,
        ["docs.notes"],
        "危险功能被清掉:{:?}",
        demoted.features
    );

    // 内置角色:管理员不可改,不可删;普通用户不可删、不可变危险
    assert!(matches!(
        store
            .update_role(
                ROLE_ADMIN,
                RoleUpdate {
                    name: Some("x".into()),
                    ..Default::default()
                }
            )
            .await
            .unwrap_err(),
        KbError::Forbidden(_)
    ));
    assert!(matches!(
        store.delete_role(ROLE_ADMIN).await.unwrap_err(),
        KbError::Forbidden(_)
    ));
    assert!(matches!(
        store.delete_role(ROLE_USER).await.unwrap_err(),
        KbError::Forbidden(_)
    ));
    assert!(matches!(
        store
            .update_role(
                ROLE_USER,
                RoleUpdate {
                    dangerous: Some(true),
                    ..Default::default()
                }
            )
            .await
            .unwrap_err(),
        KbError::Forbidden(_)
    ));

    // 还有人在用就不能删
    let (u, _) = store.create_user(new_user("inuse", &ops.id)).await.unwrap();
    assert!(matches!(
        store.delete_role(&ops.id).await.unwrap_err(),
        KbError::Exists(_)
    ));
    store
        .update_user(
            &u.id,
            UserUpdate {
                role_id: Some(ROLE_USER.to_owned()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store.delete_role(&ops.id).await.unwrap();
    assert!(store.get_role(&ops.id).await.unwrap().is_none());
    assert!(matches!(
        store.delete_role(&ops.id).await.unwrap_err(),
        KbError::NotFound(_)
    ));

    // 配额必须是合法 JSON
    assert!(
        store
            .update_role(
                ROLE_USER,
                RoleUpdate {
                    quota_json: Some("{not json".into()),
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
    store
        .update_role(
            ROLE_USER,
            RoleUpdate {
                quota_json: Some(r#"{"storage_gb":50}"#.into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store.get_role(ROLE_USER).await.unwrap().unwrap().quota_json,
        r#"{"storage_gb":50}"#
    );
}

#[tokio::test]
async fn list_users_filters_pages_and_escapes_wildcards() {
    let (_dir, store) = open();
    for name in ["amy", "ann", "bob", "a_x"] {
        store.create_user(new_user(name, ROLE_USER)).await.unwrap();
    }
    let (all, total) = store.list_users(UserFilter::default(), 2, 0).await.unwrap();
    assert_eq!((all.len(), total), (2, 4));
    let (page2, _) = store.list_users(UserFilter::default(), 2, 2).await.unwrap();
    assert_eq!(page2.len(), 2);
    let (hits, n) = store
        .list_users(
            UserFilter {
                q: Some("an".into()),
                ..Default::default()
            },
            50,
            0,
        )
        .await
        .unwrap();
    assert_eq!((hits.len(), n), (1, 1));
    // `_` 和 `%` 当字面量,不是通配符
    let (underscore, _) = store
        .list_users(
            UserFilter {
                q: Some("a_".into()),
                ..Default::default()
            },
            50,
            0,
        )
        .await
        .unwrap();
    assert_eq!(
        underscore
            .iter()
            .map(|u| u.username.as_str())
            .collect::<Vec<_>>(),
        ["a_x"]
    );
    let (percent, _) = store
        .list_users(
            UserFilter {
                q: Some("%".into()),
                ..Default::default()
            },
            50,
            0,
        )
        .await
        .unwrap();
    assert!(percent.is_empty());
    let (none, _) = store
        .list_users(
            UserFilter {
                status: Some(UserStatus::Disabled),
                ..Default::default()
            },
            50,
            0,
        )
        .await
        .unwrap();
    assert!(none.is_empty());
}

#[tokio::test]
async fn effective_quota_layers_default_then_role_then_user() {
    use kb_core::config::QuotaConfig;
    let (_dir, store) = open();
    let (user, _) = store
        .create_user(new_user("quota_u", ROLE_USER))
        .await
        .unwrap();
    let defaults = QuotaConfig::default();
    assert_eq!(
        store.effective_quota(&user.id, &defaults).await.unwrap(),
        defaults,
        "什么都没覆盖就是默认值"
    );

    store
        .update_role(
            ROLE_USER,
            RoleUpdate {
                quota_json: Some(r#"{"storage_gb": 50, "max_upload_mb": 10}"#.into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let by_role = store.effective_quota(&user.id, &defaults).await.unwrap();
    assert_eq!((by_role.storage_gb, by_role.max_upload_mb), (50, 10));

    store
        .update_user(
            &user.id,
            UserUpdate {
                quota_json: Some(r#"{"storage_gb": 7}"#.into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let by_user = store.effective_quota(&user.id, &defaults).await.unwrap();
    assert_eq!(
        (by_user.storage_gb, by_user.max_upload_mb),
        (7, 10),
        "用户覆盖角色,没写的键沿用角色"
    );

    // 全站默认改了,没被覆盖的键跟着变
    let bigger = QuotaConfig {
        llm_tokens_per_day: 1,
        ..defaults
    };
    assert_eq!(
        store
            .effective_quota(&user.id, &bigger)
            .await
            .unwrap()
            .llm_tokens_per_day,
        1
    );
    assert!(matches!(
        store
            .effective_quota("usr_missing", &bigger)
            .await
            .unwrap_err(),
        KbError::NotFound(_)
    ));
}

#[tokio::test]
async fn settings_and_audit_round_trip() {
    let (_dir, store) = open();
    assert_eq!(store.get_setting("k").await.unwrap(), None);
    store.set_setting("k", "v1").await.unwrap();
    store.set_setting("k", "v2").await.unwrap();
    assert_eq!(store.get_setting("k").await.unwrap().as_deref(), Some("v2"));

    let (u, _) = store
        .create_user(new_user("audited", ROLE_USER))
        .await
        .unwrap();
    store
        .record_audit(
            Some(&u.id),
            "login",
            Some("web"),
            &serde_json::json!({"ok": true}),
            Some("1.2.3.4"),
        )
        .await
        .unwrap();
    store
        .record_audit(None, "system.start", None, &serde_json::json!({}), None)
        .await
        .unwrap();
    let mine = store.list_audit(Some(&u.id), 50, 0).await.unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].action, "login");
    assert_eq!(mine[0].ip.as_deref(), Some("1.2.3.4"));
    let all = store.list_audit(None, 50, 0).await.unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].action, "system.start", "新的在前");
}

#[tokio::test]
async fn updating_email_requires_reverification_and_uniqueness() {
    let (_dir, store) = open();
    let (a, _) = store
        .create_user(new_user("mail_a", ROLE_USER))
        .await
        .unwrap();
    let (_b, _) = store
        .create_user(new_user("mail_b", ROLE_USER))
        .await
        .unwrap();
    assert!(a.email_verified_at.is_some());
    let err = store
        .update_user(
            &a.id,
            UserUpdate {
                email: Some(Some("MAIL_B@example.com".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::Exists(_)));
    let changed = store
        .update_user(
            &a.id,
            UserUpdate {
                email: Some(Some("New@Example.com".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(changed.email.as_deref(), Some("new@example.com"));
    assert!(changed.email_verified_at.is_none(), "换邮箱后要重新验证");
    let cleared = store
        .update_user(
            &a.id,
            UserUpdate {
                email: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(cleared.email.is_none());
}

// ---------------------------------------------------------------------------
// 注册:验证码、邀请码、发信记录
// ---------------------------------------------------------------------------

use kb_core::account::EmailPurpose;

use super::{CodeLimits, IssueOutcome, MAX_CODE_ATTEMPTS, NewInvite, VerifyOutcome};

const T0: i64 = 1_800_000_000_000;

async fn issue(
    store: &SystemStore,
    email: &str,
    hash: &str,
    ip: Option<&str>,
    now: i64,
) -> IssueOutcome {
    store
        .issue_email_code(
            email,
            EmailPurpose::Register,
            hash,
            ip,
            600_000,
            CodeLimits::default(),
            now,
        )
        .await
        .unwrap()
}

fn invite(hash: &str, max_uses: i64) -> NewInvite {
    NewInvite {
        code_hash: hash.to_owned(),
        prefix: "KB-TEST".to_owned(),
        created_by: None,
        note: String::new(),
        max_uses,
        expires_at: None,
        role_id: None,
        quota_json: "{}".to_owned(),
        auto_friend: true,
    }
}

#[tokio::test]
async fn email_code_limits_are_per_email_per_day_and_per_ip() {
    let (_dir, store) = open();
    assert!(matches!(
        issue(&store, "a@b.com", "h1", Some("1.1.1.1"), T0).await,
        IssueOutcome::Issued { .. }
    ));
    // 一分钟内再要:要等
    match issue(&store, "a@b.com", "h2", Some("1.1.1.1"), T0 + 20_000).await {
        IssueOutcome::TooSoon { wait_secs } => assert_eq!(wait_secs, 40),
        other => panic!("{other:?}"),
    }
    // 别的邮箱不受影响;同一邮箱隔一分钟后可以
    assert!(matches!(
        issue(&store, "c@d.com", "h3", Some("2.2.2.2"), T0 + 1).await,
        IssueOutcome::Issued { .. }
    ));
    assert!(matches!(
        issue(&store, "a@b.com", "h4", Some("1.1.1.1"), T0 + 61_000).await,
        IssueOutcome::Issued { .. }
    ));

    // 每天最多 10 次:隔 61 秒连发到第 10 次,第 11 次被拒
    let mut now = T0 + 61_000;
    for n in 0..8 {
        now += 61_000;
        let outcome = issue(&store, "daily@x.com", &format!("d{n}"), None, now).await;
        assert!(
            matches!(outcome, IssueOutcome::Issued { .. }),
            "第 {n} 次:{outcome:?}"
        );
    }
    now += 61_000;
    assert!(matches!(
        issue(&store, "daily@x.com", "d8", None, now).await,
        IssueOutcome::Issued { .. }
    ));
    now += 61_000;
    assert!(matches!(
        issue(&store, "daily@x.com", "d9", None, now).await,
        IssueOutcome::Issued { .. }
    ));
    now += 61_000;
    assert_eq!(
        issue(&store, "daily@x.com", "d10", None, now).await,
        IssueOutcome::EmailDailyLimit
    );
    // 超过一天后又可以了
    assert!(matches!(
        issue(&store, "daily@x.com", "d11", None, now + 24 * 3_600_000).await,
        IssueOutcome::Issued { .. }
    ));

    // 同一 IP 每小时最多 20 次(换不同邮箱绕不过去)
    for n in 0..20 {
        let outcome = issue(
            &store,
            &format!("u{n}@x.com"),
            "h",
            Some("9.9.9.9"),
            T0 + 10_000_000 + n,
        )
        .await;
        assert!(
            matches!(outcome, IssueOutcome::Issued { .. }),
            "第 {n} 个:{outcome:?}"
        );
    }
    assert_eq!(
        issue(&store, "u21@x.com", "h", Some("9.9.9.9"), T0 + 10_000_100).await,
        IssueOutcome::IpHourlyLimit
    );
    assert!(matches!(
        issue(&store, "u22@x.com", "h", Some("8.8.8.8"), T0 + 10_000_101).await,
        IssueOutcome::Issued { .. }
    ));
}

#[tokio::test]
async fn verifying_a_code_counts_wrong_attempts_and_locks_after_five() {
    let (_dir, store) = open();
    issue(&store, "a@b.com", "right", None, T0).await;
    let verify = |hash: &'static str, now: i64| {
        let store = store.clone();
        async move {
            store
                .verify_email_code("a@b.com", EmailPurpose::Register, hash, now)
                .await
                .unwrap()
        }
    };
    for left in (1..MAX_CODE_ATTEMPTS).rev() {
        assert_eq!(
            verify("wrong", T0 + 1).await,
            VerifyOutcome::Wrong {
                attempts_left: left
            }
        );
    }
    assert_eq!(
        verify("wrong", T0 + 2).await,
        VerifyOutcome::Locked,
        "第 5 次错误就作废"
    );
    // 作废之后连正确的码也不行(攻击者不能靠猜到第 6 次)
    assert_eq!(verify("right", T0 + 3).await, VerifyOutcome::Locked);
}

#[tokio::test]
async fn a_correct_code_verifies_without_consuming_until_asked() {
    let (_dir, store) = open();
    issue(&store, "a@b.com", "right", None, T0).await;
    let first = store
        .verify_email_code("a@b.com", EmailPurpose::Register, "right", T0 + 1)
        .await
        .unwrap();
    let VerifyOutcome::Verified { id } = first else {
        panic!("{first:?}")
    };
    // 没消耗之前可以再验(注册建账号失败时用户不用重新收邮件)
    assert!(matches!(
        store
            .verify_email_code("a@b.com", EmailPurpose::Register, "right", T0 + 2)
            .await
            .unwrap(),
        VerifyOutcome::Verified { .. }
    ));
    assert!(store.consume_email_code(&id, T0 + 3).await.unwrap());
    assert!(
        !store.consume_email_code(&id, T0 + 4).await.unwrap(),
        "并发的第二次消耗拿不到"
    );
    assert_eq!(
        store
            .verify_email_code("a@b.com", EmailPurpose::Register, "right", T0 + 5)
            .await
            .unwrap(),
        VerifyOutcome::NoneValid,
        "用过就失效"
    );
}

#[tokio::test]
async fn codes_expire_are_scoped_to_their_purpose_and_a_new_code_replaces_the_old() {
    let (_dir, store) = open();
    issue(&store, "a@b.com", "old", None, T0).await;
    // 10 分钟后过期
    assert_eq!(
        store
            .verify_email_code("a@b.com", EmailPurpose::Register, "old", T0 + 600_000)
            .await
            .unwrap(),
        VerifyOutcome::NoneValid
    );
    // 注册的码不能用于找回密码
    assert_eq!(
        store
            .verify_email_code("a@b.com", EmailPurpose::Reset, "old", T0 + 1)
            .await
            .unwrap(),
        VerifyOutcome::NoneValid
    );
    // 重新发一个:旧的立即作废,只有最新的有效
    issue(&store, "a@b.com", "new", None, T0 + 100_000).await;
    assert!(matches!(
        store
            .verify_email_code("a@b.com", EmailPurpose::Register, "old", T0 + 100_001)
            .await
            .unwrap(),
        VerifyOutcome::Wrong { .. }
    ));
    assert!(matches!(
        store
            .verify_email_code("a@b.com", EmailPurpose::Register, "new", T0 + 100_002)
            .await
            .unwrap(),
        VerifyOutcome::Verified { .. }
    ));
    // 别的邮箱没有码
    assert_eq!(
        store
            .verify_email_code("zzz@b.com", EmailPurpose::Register, "new", T0 + 100_003)
            .await
            .unwrap(),
        VerifyOutcome::NoneValid
    );
}

#[tokio::test]
async fn limits_and_attempts_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("system.db");
    let store = SystemStore::open(&path).unwrap();
    issue(&store, "a@b.com", "right", None, T0).await;
    for _ in 0..MAX_CODE_ATTEMPTS {
        store
            .verify_email_code("a@b.com", EmailPurpose::Register, "wrong", T0 + 1)
            .await
            .unwrap();
    }
    drop(store);
    // 重启守护进程:限速和错误次数不能被清零
    let again = SystemStore::open(&path).unwrap();
    assert_eq!(
        again
            .verify_email_code("a@b.com", EmailPurpose::Register, "right", T0 + 2)
            .await
            .unwrap(),
        VerifyOutcome::Locked
    );
    assert!(matches!(
        issue(&again, "a@b.com", "h", None, T0 + 10).await,
        IssueOutcome::TooSoon { .. }
    ));
}

#[tokio::test]
async fn an_invite_can_be_claimed_only_while_it_has_uses_left() {
    let (_dir, store) = open();
    store.create_invite(invite("hash-single", 1)).await.unwrap();
    store.create_invite(invite("hash-three", 3)).await.unwrap();
    let now = now_millis();
    assert!(
        store
            .peek_invite("hash-single", now)
            .await
            .unwrap()
            .is_some()
    );
    assert!(store.peek_invite("nope", now).await.unwrap().is_none());

    let first = store
        .claim_invite("hash-single", now)
        .await
        .unwrap()
        .expect("第一次拿到");
    assert_eq!(first.used, 1);
    assert!(
        store
            .claim_invite("hash-single", now)
            .await
            .unwrap()
            .is_none(),
        "单次码用完了"
    );
    assert!(
        store
            .peek_invite("hash-single", now)
            .await
            .unwrap()
            .is_none(),
        "用完的码查看时也视为无效"
    );
    // 归还后又能用(占用后建账号失败的情形)
    store.release_invite(&first.id).await.unwrap();
    assert!(
        store
            .claim_invite("hash-single", now)
            .await
            .unwrap()
            .is_some()
    );
    // 多次码
    for _ in 0..3 {
        assert!(
            store
                .claim_invite("hash-three", now)
                .await
                .unwrap()
                .is_some()
        );
    }
    assert!(
        store
            .claim_invite("hash-three", now)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn two_people_racing_for_a_single_use_invite_only_one_wins() {
    let (_dir, store) = open();
    store.create_invite(invite("hash-race", 1)).await.unwrap();
    let now = now_millis();
    let mut tasks = Vec::new();
    for _ in 0..20 {
        let store = store.clone();
        tasks.push(tokio::spawn(async move {
            store
                .claim_invite("hash-race", now)
                .await
                .unwrap()
                .is_some()
        }));
    }
    let mut winners = 0;
    for task in tasks {
        winners += usize::from(task.await.unwrap());
    }
    assert_eq!(winners, 1, "20 个并发只能有 1 个拿到单次邀请码");
}

#[tokio::test]
async fn revoked_and_expired_invites_cannot_be_claimed_and_owners_only_revoke_their_own() {
    let (_dir, store) = open();
    let (owner, _) = store
        .create_user(new_user("inviter", ROLE_USER))
        .await
        .unwrap();
    let now = now_millis();
    let mine = store
        .create_invite(NewInvite {
            created_by: Some(owner.id.clone()),
            ..invite("h-mine", 5)
        })
        .await
        .unwrap();
    let theirs = store.create_invite(invite("h-admin", 5)).await.unwrap();
    store
        .create_invite(NewInvite {
            expires_at: Some(now - 1),
            ..invite("h-old", 5)
        })
        .await
        .unwrap();
    assert!(
        store.claim_invite("h-old", now).await.unwrap().is_none(),
        "过期的不能用"
    );

    // 普通用户只能撤销自己创建的
    assert!(
        !store
            .revoke_invite(&theirs.id, Some(&owner.id), now)
            .await
            .unwrap()
    );
    assert!(
        store
            .revoke_invite(&mine.id, Some(&owner.id), now)
            .await
            .unwrap()
    );
    assert!(
        store.claim_invite("h-mine", now).await.unwrap().is_none(),
        "撤销后不能用"
    );
    assert!(
        !store
            .revoke_invite(&mine.id, Some(&owner.id), now)
            .await
            .unwrap(),
        "重复撤销返回 false"
    );
    // 管理员(owner = None)可以撤销任何人的
    assert!(store.revoke_invite(&theirs.id, None, now).await.unwrap());
    // 列表:普通用户只看到自己的
    assert_eq!(store.list_invites(Some(&owner.id)).await.unwrap().len(), 1);
    assert_eq!(store.list_invites(None).await.unwrap().len(), 3);
}

#[tokio::test]
async fn invites_validate_their_input_and_record_who_used_them() {
    let (_dir, store) = open();
    assert!(store.create_invite(invite("a", 0)).await.is_err());
    assert!(store.create_invite(invite("b", 10_001)).await.is_err());
    assert!(
        store
            .create_invite(NewInvite {
                quota_json: "not json".into(),
                ..invite("c", 1)
            })
            .await
            .is_err()
    );
    assert!(
        store
            .create_invite(NewInvite {
                role_id: Some("role_nope".into()),
                ..invite("d", 1)
            })
            .await
            .is_err()
    );
    store
        .create_invite(NewInvite {
            role_id: Some(ROLE_USER.into()),
            ..invite("e", 1)
        })
        .await
        .unwrap();
    assert!(
        store.create_invite(invite("e", 1)).await.is_err(),
        "同一个码不能建两次"
    );

    let created = store.create_invite(invite("f", 2)).await.unwrap();
    store
        .record_invite_use(&created.id, "usr_x", Some("1.2.3.4"), T0)
        .await
        .unwrap();
    store
        .record_invite_use(&created.id, "usr_y", None, T0 + 1)
        .await
        .unwrap();
    let uses = store.invite_uses(&created.id).await.unwrap();
    assert_eq!(
        uses.iter()
            .map(|(user, ..)| user.as_str())
            .collect::<Vec<_>>(),
        ["usr_y", "usr_x"],
        "新的在前"
    );
}

#[tokio::test]
async fn secrets_are_created_once_and_mail_is_logged_counted_and_purged() {
    let (_dir, store) = open();
    let first = store
        .get_or_create_secret("pepper", || "one".to_owned())
        .await
        .unwrap();
    let second = store
        .get_or_create_secret("pepper", || "two".to_owned())
        .await
        .unwrap();
    assert_eq!(
        (first.as_str(), second.as_str()),
        ("one", "one"),
        "只生成一次"
    );

    store
        .record_mail("a@b.com", "register_code", true, Some("primary"), None)
        .await
        .unwrap();
    store
        .record_mail("c@d.com", "reset_code", false, None, Some("SMTP 发送失败"))
        .await
        .unwrap();
    let log = store.list_mail_log(10).await.unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(
        (log[0].to_addr.as_str(), log[0].ok),
        ("c@d.com", false),
        "新的在前"
    );
    assert_eq!(log[0].error.as_deref(), Some("SMTP 发送失败"));
    assert_eq!(store.mails_since(now_millis() - 60_000).await.unwrap(), 2);
    assert_eq!(store.mails_since(now_millis() + 60_000).await.unwrap(), 0);

    issue(
        &store,
        "old@x.com",
        "h",
        None,
        now_millis() - 8 * 86_400_000,
    )
    .await;
    assert!(
        store.purge_registration_data(now_millis()).await.unwrap() >= 1,
        "7 天前的验证码被清掉"
    );
    assert_eq!(
        store.list_mail_log(10).await.unwrap().len(),
        2,
        "新的发信记录还在"
    );
}

// ------------------------------------------------------------------ 账号注销

const DAY: i64 = 86_400_000;
const WEEK: i64 = 7 * DAY;

#[tokio::test]
async fn requesting_deletion_starts_a_cooling_off_period_but_keeps_the_account_usable() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    store
        .create_session(session(&alice.id, "s1", 60_000))
        .await
        .unwrap();
    let now = 1_000_000;
    let until = store.request_deletion(&alice.id, now, WEEK).await.unwrap();
    assert_eq!(until, now + WEEK);
    let user = store.get_user(&alice.id).await.unwrap().unwrap();
    assert_eq!(
        (user.status, user.delete_after),
        (UserStatus::Deleting, Some(now + WEEK))
    );
    // 冷静期内还能登录(否则没法撤销),已有会话也不被踢
    assert!(user.status.can_sign_in());
    assert!(
        store
            .session_user("s1", now_millis())
            .await
            .unwrap()
            .is_some()
    );
    // 没到期:不会出现在待删除名单里
    assert!(
        store
            .due_for_deletion(now + WEEK - 1)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.due_for_deletion(now + WEEK).await.unwrap(),
        [alice.id]
    );
}

#[tokio::test]
async fn asking_again_does_not_move_the_deadline() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    let first = store
        .request_deletion(&alice.id, 1_000, WEEK)
        .await
        .unwrap();
    // 三天后再点一次:期限不变(不能靠反复申请把期限往后拖或往前挪)
    let again = store
        .request_deletion(&alice.id, 1_000 + 3 * DAY, WEEK)
        .await
        .unwrap();
    assert_eq!(first, again);
    assert_eq!(
        store
            .get_user(&alice.id)
            .await
            .unwrap()
            .unwrap()
            .delete_after,
        Some(first)
    );
}

#[tokio::test]
async fn cancelling_restores_the_account_and_only_works_while_deleting() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    // 没在注销中:撤销是错误,不是静默成功
    assert!(matches!(
        store.cancel_deletion(&alice.id, 1_500).await,
        Err(KbError::InvalidInput(_))
    ));
    store
        .request_deletion(&alice.id, 1_000, WEEK)
        .await
        .unwrap();
    store.cancel_deletion(&alice.id, 1_500).await.unwrap();
    let user = store.get_user(&alice.id).await.unwrap().unwrap();
    assert_eq!((user.status, user.delete_after), (UserStatus::Active, None));
    assert!(
        store.due_for_deletion(i64::MAX).await.unwrap().is_empty(),
        "撤销后不会被删"
    );
    // 撤销后可以重新申请,得到新的期限
    let again = store
        .request_deletion(&alice.id, 5_000, WEEK)
        .await
        .unwrap();
    assert_eq!(again, 5_000 + WEEK);
}

#[tokio::test]
async fn the_last_admin_cannot_delete_themselves_but_a_second_admin_can() {
    let (_dir, store) = open();
    // 第一个管理员拥有主知识库,先降成普通用户:他在这条测试里只是个占位
    let (boss, _) = store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (second, _) = store
        .create_user(new_user("second", ROLE_ADMIN))
        .await
        .unwrap();
    let (third, _) = store
        .create_user(new_user("third", ROLE_ADMIN))
        .await
        .unwrap();
    store
        .update_user(
            &boss.id,
            UserUpdate {
                role_id: Some(ROLE_USER.to_owned()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    // 现在管理员只有 second 和 third 两个。second 可以注销
    store
        .request_deletion(&second.id, 1_000, WEEK)
        .await
        .unwrap();
    // second 在冷静期里,冷静期结束他就不在了——third 就成了最后一个,不能再注销
    let error = store
        .request_deletion(&third.id, 1_000, WEEK)
        .await
        .unwrap_err();
    assert!(
        matches!(&error, KbError::Forbidden(text) if text.contains("最后一个管理员")),
        "{error:?}"
    );
    assert_eq!(
        store.get_user(&third.id).await.unwrap().unwrap().status,
        UserStatus::Active
    );
    // second 撤销之后,两个管理员又都在了,third 可以注销
    store.cancel_deletion(&second.id, 1_500).await.unwrap();
    store
        .request_deletion(&third.id, 2_000, WEEK)
        .await
        .unwrap();
    // 普通用户注销不受这条限制
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    store
        .request_deletion(&alice.id, 2_000, WEEK)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_disabled_account_cannot_start_its_own_deletion() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (bob, _) = store.create_user(new_user("bob", ROLE_USER)).await.unwrap();
    store
        .update_user(
            &bob.id,
            UserUpdate {
                status: Some(UserStatus::Disabled),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store.request_deletion(&bob.id, 1_000, WEEK).await,
        Err(KbError::Forbidden(_))
    ));
    assert!(matches!(
        store.request_deletion("usr_nobody", 1_000, WEEK).await,
        Err(KbError::NotFound(_))
    ));
}

#[tokio::test]
async fn purge_refuses_anyone_who_is_not_due_and_never_touches_other_users() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    let (bob, _) = store.create_user(new_user("bob", ROLE_USER)).await.unwrap();
    // 活人:拒绝
    assert!(matches!(
        store.purge_user(&alice.id, i64::MAX).await,
        Err(KbError::Forbidden(_))
    ));
    // 冷静期没结束:拒绝
    store
        .request_deletion(&alice.id, 1_000, WEEK)
        .await
        .unwrap();
    assert!(matches!(
        store.purge_user(&alice.id, 1_000 + WEEK - 1).await,
        Err(KbError::Forbidden(_))
    ));
    assert!(store.get_user(&alice.id).await.unwrap().is_some());
    // bob 没申请:即使时间再晚也删不掉
    assert!(matches!(
        store.purge_user(&bob.id, i64::MAX).await,
        Err(KbError::Forbidden(_))
    ));
    assert!(store.get_user(&bob.id).await.unwrap().is_some());
}

#[tokio::test]
async fn purging_removes_the_account_and_everything_hanging_off_it_but_keeps_the_audit_trail() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, space) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    let (bob, _) = store.create_user(new_user("bob", ROLE_USER)).await.unwrap();
    store
        .create_session(session(&alice.id, "alice-s", 60_000))
        .await
        .unwrap();
    store
        .create_session(session(&bob.id, "bob-s", 60_000))
        .await
        .unwrap();
    store
        .create_token(token(&alice.id, "t1", "ci", "alice-hash"))
        .await
        .unwrap();
    store
        .set_feature_override(&alice.id, "docs.notes", Some("deny"))
        .await
        .unwrap();
    store
        .set_prefs(
            &alice.id,
            &serde_json::json!({ "ui": { "sidebar": "rail" } }),
            5,
        )
        .await
        .unwrap();
    store
        .record_audit(Some(&alice.id), "login", None, &serde_json::json!({}), None)
        .await
        .unwrap();
    store
        .request_deletion(&alice.id, 1_000, WEEK)
        .await
        .unwrap();

    store.purge_user(&alice.id, 1_000 + WEEK).await.unwrap();
    // 偏好随账号一起删干净(不留别人的界面习惯在库里)
    assert_eq!(
        store.get_prefs(&alice.id).await.unwrap(),
        serde_json::json!({})
    );
    assert!(store.get_user(&alice.id).await.unwrap().is_none());
    assert!(store.personal_space(&alice.id).await.unwrap().is_none());
    assert!(store.get_space(&space.id).await.unwrap().is_none());
    assert!(
        store
            .session_user("alice-s", now_millis())
            .await
            .unwrap()
            .is_none()
    );
    assert!(store.list_tokens(&alice.id).await.unwrap().is_empty());
    assert!(store.feature_overrides(&alice.id).await.unwrap().is_empty());
    // 别人毫发无损
    assert!(store.get_user(&bob.id).await.unwrap().is_some());
    assert!(
        store
            .session_user("bob-s", now_millis())
            .await
            .unwrap()
            .is_some()
    );
    assert!(store.personal_space(&bob.id).await.unwrap().is_some());
    // 审计保留
    let audit = store.list_audit(Some(&alice.id), 50, 0).await.unwrap();
    assert_eq!(audit.len(), 1, "她的审计记录应保留");
    // 用户名可以被别人重新注册了
    store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .expect("用户名释放");
    // 重试(比如上一轮删到一半崩了)安静通过
    store.purge_user(&alice.id, 1_000 + WEEK).await.unwrap();
}

#[tokio::test]
async fn an_owner_of_a_team_space_cannot_be_purged() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    let owner = alice.id.clone();
    store
        .write(move |conn| {
            conn.execute(
                "INSERT INTO spaces (id, owner_id, name, kind, storage_bytes, created_at) VALUES ('sp_team1', ?1, '团队', 'team', 0, 1)",
                rusqlite::params![owner],
            )
            .map(|_| ())
            .map_err(crate::sql::map_sqlite_error)
        })
        .await
        .unwrap();
    store
        .request_deletion(&alice.id, 1_000, WEEK)
        .await
        .unwrap();
    let error = store.purge_user(&alice.id, 1_000 + WEEK).await.unwrap_err();
    assert!(matches!(error, KbError::Exists(_)), "{error:?}");
    assert!(
        store.get_user(&alice.id).await.unwrap().is_some(),
        "拒绝时什么都不能删"
    );
    assert!(store.personal_space(&alice.id).await.unwrap().is_some());
}

#[tokio::test]
async fn due_users_are_listed_oldest_deadline_first() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let mut ids = Vec::new();
    for (name, at) in [("user_a", 3_000), ("user_b", 1_000), ("user_c", 2_000)] {
        let (user, _) = store.create_user(new_user(name, ROLE_USER)).await.unwrap();
        store.request_deletion(&user.id, at, 0).await.unwrap();
        ids.push((name, user.id));
    }
    let due = store.due_for_deletion(10_000).await.unwrap();
    let names: Vec<_> = due
        .iter()
        .map(|id| ids.iter().find(|(_, other)| other == id).unwrap().0)
        .collect();
    assert_eq!(names, ["user_b", "user_c", "user_a"]);
}

#[tokio::test]
async fn whoever_owns_the_primary_space_can_never_be_deleted() {
    let (_dir, store) = open();
    // 第一个管理员接管主知识库(数据根目录本身)
    let (first, space) = store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    assert_eq!(space.id, kb_core::account::PRIMARY_SPACE_ID);
    // 有第二个管理员,「最后一个管理员」那条规则帮不了忙——主库这条必须独立拦住
    store
        .create_user(new_user("second", ROLE_ADMIN))
        .await
        .unwrap();
    let error = store
        .request_deletion(&first.id, 1_000, WEEK)
        .await
        .unwrap_err();
    assert!(
        matches!(&error, KbError::Forbidden(text) if text.contains("主知识库")),
        "{error:?}"
    );
    assert_eq!(
        store.get_user(&first.id).await.unwrap().unwrap().status,
        UserStatus::Active
    );

    // 纵深防御:就算状态被人直接改成 deleting(绕过申请),清理时也不碰主库的拥有者
    let id = first.id.clone();
    store
        .write(move |conn| {
            conn.execute(
                "UPDATE users SET status = 'deleting', delete_after = 1 WHERE id = ?1",
                rusqlite::params![id],
            )
            .map(|_| ())
            .map_err(crate::sql::map_sqlite_error)
        })
        .await
        .unwrap();
    let error = store.purge_user(&first.id, i64::MAX).await.unwrap_err();
    assert!(matches!(error, KbError::Forbidden(_)), "{error:?}");
    assert!(store.get_user(&first.id).await.unwrap().is_some());
    assert!(
        store
            .get_space(kb_core::account::PRIMARY_SPACE_ID)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn the_right_to_cancel_ends_exactly_when_the_account_becomes_deletable() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    let until = store
        .request_deletion(&alice.id, 1_000, WEEK)
        .await
        .unwrap();
    // 到期前最后一毫秒:还能撤销,也还不在待删除名单里
    assert!(store.due_for_deletion(until - 1).await.unwrap().is_empty());
    // 到期的那一刻:进了待删除名单,同时撤销权消失——两者严格互补,中间没有缝隙
    assert_eq!(
        store.due_for_deletion(until).await.unwrap(),
        std::slice::from_ref(&alice.id)
    );
    let error = store.cancel_deletion(&alice.id, until).await.unwrap_err();
    assert!(
        matches!(&error, KbError::Exists(text) if text.contains("不能再撤销")),
        "{error:?}"
    );
    assert_eq!(
        store.get_user(&alice.id).await.unwrap().unwrap().status,
        UserStatus::Deleting,
        "撤销失败不能改动账号"
    );
    // 反过来:差一毫秒到期时撤销成功
    let (bob, _) = store.create_user(new_user("bob", ROLE_USER)).await.unwrap();
    let until = store.request_deletion(&bob.id, 1_000, WEEK).await.unwrap();
    store.cancel_deletion(&bob.id, until - 1).await.unwrap();
    assert!(
        store
            .due_for_deletion(i64::MAX)
            .await
            .unwrap()
            .iter()
            .all(|id| *id != bob.id)
    );
    // 不存在的人
    assert!(matches!(
        store.cancel_deletion("usr_nobody", 1).await,
        Err(KbError::NotFound(_))
    ));
}

#[tokio::test]
async fn only_the_first_request_counts_as_new() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    let (first, new) = store
        .request_deletion_detailed(&alice.id, 1_000, WEEK)
        .await
        .unwrap();
    assert!(new, "第一次是新申请");
    let (again, new) = store
        .request_deletion_detailed(&alice.id, 2_000, WEEK)
        .await
        .unwrap();
    assert_eq!(
        (again, new),
        (first, false),
        "重复申请:同一个期限,不算新申请"
    );
    // 撤销后再申请,又算新的
    store.cancel_deletion(&alice.id, 3_000).await.unwrap();
    let (_, new) = store
        .request_deletion_detailed(&alice.id, 4_000, WEEK)
        .await
        .unwrap();
    assert!(new);
}

#[tokio::test]
async fn a_new_email_can_be_recorded_as_already_verified_but_defaults_to_unverified() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    assert!(
        store
            .get_user(&alice.id)
            .await
            .unwrap()
            .unwrap()
            .email_verified_at
            .is_some()
    );
    // 默认行为不变:换邮箱后要重新验证
    let user = store
        .update_user(
            &alice.id,
            UserUpdate {
                email: Some(Some("new1@example.com".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        (user.email.as_deref(), user.email_verified_at),
        (Some("new1@example.com"), None)
    );
    // 调用方刚用验证码证明了新邮箱归本人:直接记已验证
    let user = store
        .update_user(
            &alice.id,
            UserUpdate {
                email: Some(Some("new2@example.com".into())),
                email_verified_at: Some(12_345),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        (user.email.as_deref(), user.email_verified_at),
        (Some("new2@example.com"), Some(12_345))
    );
    // 清空邮箱时,即使带了验证时间也不能残留「已验证」
    let user = store
        .update_user(
            &alice.id,
            UserUpdate {
                email: Some(None),
                email_verified_at: Some(99),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!((user.email, user.email_verified_at), (None, None));
    // 单独给验证时间、不改邮箱:什么都不会发生
    let user = store
        .update_user(
            &alice.id,
            UserUpdate {
                email_verified_at: Some(7),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(user.email_verified_at, None);
}

#[tokio::test]
async fn an_email_already_used_by_someone_else_cannot_be_taken_even_with_a_verified_stamp() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    store.create_user(new_user("bob", ROLE_USER)).await.unwrap();
    let error = store
        .update_user(
            &alice.id,
            UserUpdate {
                email: Some(Some("BOB@example.com".into())),
                email_verified_at: Some(1),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(error, KbError::Exists(_)), "{error:?}");
    assert_eq!(
        store
            .get_user(&alice.id)
            .await
            .unwrap()
            .unwrap()
            .email
            .as_deref(),
        Some("alice@example.com")
    );
}

#[tokio::test]
async fn prefs_default_to_empty_and_replace_as_a_whole() {
    let (_dir, store) = open();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    let (bob, _) = store.create_user(new_user("bob", ROLE_USER)).await.unwrap();
    assert_eq!(
        store.get_prefs(&alice.id).await.unwrap(),
        serde_json::json!({})
    );

    let first = serde_json::json!({ "ui": { "sidebar": "rail", "density": "compact" } });
    store.set_prefs(&alice.id, &first, 1).await.unwrap();
    assert_eq!(store.get_prefs(&alice.id).await.unwrap(), first);
    // 整体替换:旧键不会残留
    let second = serde_json::json!({ "ui": { "sidebar": "hidden" } });
    store.set_prefs(&alice.id, &second, 2).await.unwrap();
    assert_eq!(store.get_prefs(&alice.id).await.unwrap(), second);
    // 只影响自己
    assert_eq!(
        store.get_prefs(&bob.id).await.unwrap(),
        serde_json::json!({})
    );
}

#[tokio::test]
async fn prefs_reject_non_objects_oversize_and_unknown_users() {
    let (_dir, store) = open();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    for bad in [
        serde_json::json!([1, 2]),
        serde_json::json!("text"),
        serde_json::json!(null),
        serde_json::json!(7),
    ] {
        let err = store.set_prefs(&alice.id, &bad, 1).await.unwrap_err();
        assert!(matches!(err, KbError::InvalidInput(_)), "{bad}: {err:?}");
    }
    // 刚好在上限内可以,多一个字节就不行
    let fits = serde_json::json!({ "k": "x".repeat(super::MAX_PREFS_BYTES - 8) });
    assert_eq!(
        serde_json::to_string(&fits).unwrap().len(),
        super::MAX_PREFS_BYTES
    );
    store.set_prefs(&alice.id, &fits, 1).await.unwrap();
    let over = serde_json::json!({ "k": "x".repeat(super::MAX_PREFS_BYTES - 7) });
    let err = store.set_prefs(&alice.id, &over, 2).await.unwrap_err();
    assert!(matches!(err, KbError::InvalidInput(_)), "{err:?}");
    // 被拒的写入不动原来的内容
    assert_eq!(store.get_prefs(&alice.id).await.unwrap(), fits);
    let err = store
        .set_prefs("usr_nope", &serde_json::json!({}), 3)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
}

// ---------------------------------------------------------------- LLM 用量账本

#[tokio::test]
async fn llm_usage_series_sums_everyone_per_day_and_purpose_within_the_range() {
    let (_dir, store) = open();
    for (user, day, purpose, input, output) in [
        ("u1", "2026-10-27", "extract", 1_000, 0),
        ("u1", "2026-10-28", "extract", 100, 20),
        ("u2", "2026-10-28", "extract", 50, 5),
        ("u2", "2026-10-28", "agent", 10, 1),
        ("u1", "2026-10-30", "agent", 7, 3),
        ("u1", "2026-11-05", "agent", 999, 1),
    ] {
        store
            .add_llm_usage(user, day, purpose, input, output)
            .await
            .unwrap();
    }
    let got = store
        .llm_usage_series("2026-10-28", "2026-10-31")
        .await
        .unwrap();
    assert_eq!(
        got,
        vec![
            ("2026-10-28".to_owned(), "agent".to_owned(), 1, 10, 1),
            ("2026-10-28".to_owned(), "extract".to_owned(), 2, 150, 25),
            ("2026-10-30".to_owned(), "agent".to_owned(), 1, 7, 3),
        ],
        "全站合计;范围两头含,范围外的不算;按天再按用途排"
    );
    assert!(
        store
            .llm_usage_series("2027-01-01", "2027-01-31")
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn llm_usage_accumulates_per_person_day_and_purpose() {
    let (_dir, store) = open();
    store
        .add_llm_usage("u1", "2026-10-28", "extract", 100, 20)
        .await
        .unwrap();
    store
        .add_llm_usage("u1", "2026-10-28", "extract", 50, 5)
        .await
        .unwrap();
    store
        .add_llm_usage("u1", "2026-10-28", "agent", 10, 1)
        .await
        .unwrap();
    store
        .add_llm_usage("u1", "2026-10-29", "agent", 999, 1)
        .await
        .unwrap();
    store
        .add_llm_usage("u2", "2026-10-28", "agent", 7, 3)
        .await
        .unwrap();
    // 同一人同一天所有用途合计;别的天、别的人不混进来
    assert_eq!(store.llm_tokens_on("u1", "2026-10-28").await.unwrap(), 186);
    assert_eq!(store.llm_tokens_on("u1", "2026-10-29").await.unwrap(), 1000);
    assert_eq!(store.llm_tokens_on("u2", "2026-10-28").await.unwrap(), 10);
    assert_eq!(
        store.llm_tokens_on("nobody", "2026-10-28").await.unwrap(),
        0
    );
    // 排行:用得多的在前,调用次数按用途行累计
    let ranking = store.llm_usage_ranking("2026-10-28", 10).await.unwrap();
    assert_eq!(
        ranking
            .iter()
            .map(|row| (row.user_id.as_str(), row.calls))
            .collect::<Vec<_>>(),
        [("u1", 3), ("u2", 1)]
    );
    assert_eq!(
        store
            .llm_usage_ranking("2026-10-28", 1)
            .await
            .unwrap()
            .len(),
        1
    );
    // 清理旧账:只删早于给定日期的
    assert_eq!(store.purge_llm_usage_before("2026-10-29").await.unwrap(), 3);
    assert_eq!(store.llm_tokens_on("u1", "2026-10-28").await.unwrap(), 0);
    assert_eq!(store.llm_tokens_on("u1", "2026-10-29").await.unwrap(), 1000);
}

#[tokio::test]
async fn the_ledger_limit_follows_default_then_role_then_user_and_is_read_fresh_each_time() {
    use kb_core::config::{Config, ConfigStore};
    use kb_core::ports::UserLlmLedger;
    use std::sync::Arc;

    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(SystemStore::open(dir.path().join("system.db")).unwrap());
    let (user, _) = store
        .create_user(new_user("ledger_u", ROLE_USER))
        .await
        .unwrap();
    let mut config = Config::default();
    config.quota.llm_tokens_per_day = 1_000;
    let config = Arc::new(ConfigStore::new(config));
    let ledger = super::SystemLlmLedger::new(store.clone(), config.clone());

    assert_eq!(
        ledger.daily_limit(&user.id).await.unwrap(),
        1_000,
        "全站默认"
    );
    store
        .update_role(
            ROLE_USER,
            RoleUpdate {
                quota_json: Some(r#"{"llm_tokens_per_day": 500}"#.into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        ledger.daily_limit(&user.id).await.unwrap(),
        500,
        "角色覆盖默认"
    );
    store
        .update_user(
            &user.id,
            UserUpdate {
                quota_json: Some(r#"{"llm_tokens_per_day": 0}"#.into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        ledger.daily_limit(&user.id).await.unwrap(),
        0,
        "用户例外覆盖角色(0 = 不限)"
    );

    // 记账走同一张表
    ledger
        .record(&user.id, "2026-10-28", "agent", 30, 12)
        .await
        .unwrap();
    assert_eq!(ledger.used_on(&user.id, "2026-10-28").await.unwrap(), 42);

    // 账号不存在:不是「不限」,而是拒绝
    let error = ledger.daily_limit("usr_ghost").await.unwrap_err();
    assert!(matches!(error, KbError::Forbidden(_)), "{error:?}");
}

#[tokio::test]
async fn purging_a_user_wipes_their_llm_usage_but_not_other_peoples() {
    let (_dir, store) = open();
    store
        .create_user(new_user("root_admin", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, _) = store
        .create_user(new_user("alice_l", ROLE_USER))
        .await
        .unwrap();
    let (bob, _) = store
        .create_user(new_user("bob_l", ROLE_USER))
        .await
        .unwrap();
    store
        .add_llm_usage(&alice.id, "2026-10-28", "agent", 5, 5)
        .await
        .unwrap();
    store
        .add_llm_usage(&bob.id, "2026-10-28", "agent", 6, 6)
        .await
        .unwrap();
    store.request_deletion(&alice.id, 1_000, 10).await.unwrap();
    store.purge_user(&alice.id, 2_000).await.unwrap();
    assert_eq!(
        store.llm_tokens_on(&alice.id, "2026-10-28").await.unwrap(),
        0
    );
    assert_eq!(
        store.llm_tokens_on(&bob.id, "2026-10-28").await.unwrap(),
        12
    );
}

// ---------------------------------------------------------------- 存储占用统计

fn usage(sources: u64, uploads: u64, vectors: u64, meta: u64) -> kb_core::account::SpaceUsage {
    kb_core::account::SpaceUsage {
        sources_bytes: sources,
        uploads_bytes: uploads,
        vectors_bytes: vectors,
        meta_bytes: meta,
        workspace_bytes: 0,
    }
}

#[tokio::test]
async fn space_usage_is_saved_per_part_and_also_updates_the_total_shown_on_the_user_page() {
    let (_dir, store) = open();
    store
        .create_user(new_user("first_admin", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, space) = store
        .create_user(new_user("alice_s", ROLE_USER))
        .await
        .unwrap();
    assert!(
        store.get_space_usage(&space.id).await.unwrap().is_none(),
        "没统计过"
    );

    store
        .save_space_usage(&space.id, usage(10, 2, 300, 4), 1_000)
        .await
        .unwrap();
    let got = store.get_space_usage(&space.id).await.unwrap().unwrap();
    assert_eq!(
        (got.usage.vectors_bytes, got.total_bytes, got.measured_at),
        (300, 316, 1_000)
    );
    assert_eq!(
        store
            .get_space(&space.id)
            .await
            .unwrap()
            .unwrap()
            .storage_bytes,
        316,
        "用户详情页读的合计也同步了"
    );
    // 再统计一次是替换,不是累加
    store
        .save_space_usage(&space.id, usage(1, 0, 0, 0), 2_000)
        .await
        .unwrap();
    let got = store.get_space_usage(&space.id).await.unwrap().unwrap();
    assert_eq!((got.total_bytes, got.measured_at), (1, 2_000));
    assert_eq!(alice.status, UserStatus::Active);
}

// ---------------------------------------------------------------- 两步验证

#[tokio::test]
async fn totp_needs_a_confirmation_and_a_confirmed_one_cannot_be_started_again() {
    let (_dir, store) = open();
    let (user, _) = store
        .create_user(new_user("totp_a", ROLE_USER))
        .await
        .unwrap();
    assert!(store.totp_state(&user.id).await.unwrap().is_none());
    assert!(!store.totp_enabled(&user.id).await.unwrap());
    store.begin_totp(&user.id, "AAAA", 1).await.unwrap();
    let pending = store.totp_state(&user.id).await.unwrap().unwrap();
    assert!(!pending.confirmed && pending.last_step.is_none());
    assert!(
        !store.totp_enabled(&user.id).await.unwrap(),
        "没确认不算开启"
    );
    // 没确认就重新开始:换新密钥
    store.begin_totp(&user.id, "BBBB", 2).await.unwrap();
    assert_eq!(
        store
            .totp_state(&user.id)
            .await
            .unwrap()
            .unwrap()
            .secret_b32,
        "BBBB"
    );
    // 没确认的不能被当成有效的第二因素去占时间步
    assert!(!store.claim_totp_step(&user.id, 5).await.unwrap());
    store
        .confirm_totp(&user.id, 100, &["h1".into(), "h2".into()], 3)
        .await
        .unwrap();
    assert!(store.totp_enabled(&user.id).await.unwrap());
    assert_eq!(store.recovery_codes_left(&user.id).await.unwrap(), 2);
    // 开启后:不能再「开始」(会换掉密钥),重复确认也不行
    assert!(matches!(
        store.begin_totp(&user.id, "CCCC", 4).await,
        Err(KbError::Exists(_))
    ));
    assert!(matches!(
        store.confirm_totp(&user.id, 101, &[], 5).await,
        Err(KbError::Exists(_))
    ));
    assert_eq!(
        store
            .totp_state(&user.id)
            .await
            .unwrap()
            .unwrap()
            .secret_b32,
        "BBBB"
    );
}

#[tokio::test]
async fn a_time_step_can_be_claimed_once_even_by_concurrent_requests() {
    let (_dir, store) = open();
    let (user, _) = store
        .create_user(new_user("totp_b", ROLE_USER))
        .await
        .unwrap();
    store.begin_totp(&user.id, "AAAA", 1).await.unwrap();
    store.confirm_totp(&user.id, 100, &[], 2).await.unwrap();
    assert!(
        !store.claim_totp_step(&user.id, 100).await.unwrap(),
        "确认时用掉的那一步不能再用"
    );
    assert!(
        !store.claim_totp_step(&user.id, 99).await.unwrap(),
        "更早的步更不行"
    );
    // 同一个新步,并发 16 个请求,只有一个成功
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let (store, id) = (store.clone(), user.id.clone());
        tasks.push(tokio::spawn(async move {
            store.claim_totp_step(&id, 101).await.unwrap()
        }));
    }
    let mut wins = 0;
    for task in tasks {
        wins += usize::from(task.await.unwrap());
    }
    assert_eq!(wins, 1, "同一个验证码只能成功一次");
    assert_eq!(
        store.totp_state(&user.id).await.unwrap().unwrap().last_step,
        Some(101)
    );
}

#[tokio::test]
async fn recovery_codes_work_once_can_be_replaced_and_disappear_with_the_setting_or_the_account() {
    let (_dir, store) = open();
    let (user, _) = store
        .create_user(new_user("totp_c", ROLE_USER))
        .await
        .unwrap();
    store.begin_totp(&user.id, "AAAA", 1).await.unwrap();
    store
        .confirm_totp(&user.id, 1, &["a".into(), "b".into(), "c".into()], 2)
        .await
        .unwrap();
    assert!(store.use_recovery_code(&user.id, "a", 3).await.unwrap());
    assert!(
        !store.use_recovery_code(&user.id, "a", 4).await.unwrap(),
        "一个恢复码只能用一次"
    );
    assert!(
        !store.use_recovery_code(&user.id, "zzz", 5).await.unwrap(),
        "不存在的"
    );
    assert_eq!(store.recovery_codes_left(&user.id).await.unwrap(), 2);
    // 重新生成:旧的全部作废,包括没用过的
    store
        .replace_recovery_codes(&user.id, &["x".into()])
        .await
        .unwrap();
    assert!(!store.use_recovery_code(&user.id, "b", 6).await.unwrap());
    assert_eq!(store.recovery_codes_left(&user.id).await.unwrap(), 1);
    // 别人的恢复码不能用在我头上
    let (other, _) = store
        .create_user(new_user("totp_d", ROLE_USER))
        .await
        .unwrap();
    assert!(!store.use_recovery_code(&other.id, "x", 7).await.unwrap());
    // 关闭:密钥和恢复码一起没了
    assert!(store.disable_totp(&user.id).await.unwrap());
    assert!(!store.disable_totp(&user.id).await.unwrap(), "已经关了");
    assert_eq!(store.recovery_codes_left(&user.id).await.unwrap(), 0);
    assert!(store.totp_state(&user.id).await.unwrap().is_none());
}

#[tokio::test]
async fn purging_an_account_removes_its_two_step_secrets() {
    let (_dir, store) = open();
    // 系统里必须留着一个管理员,否则最后一个人不让注销
    store
        .create_user(new_user("totp_boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (user, _) = store
        .create_user(new_user("totp_e", ROLE_USER))
        .await
        .unwrap();
    store.begin_totp(&user.id, "AAAA", 1).await.unwrap();
    store
        .confirm_totp(&user.id, 1, &["a".into()], 2)
        .await
        .unwrap();
    store.request_deletion(&user.id, 1_000, WEEK).await.unwrap();
    store.purge_user(&user.id, 1_000 + WEEK).await.unwrap();
    assert!(store.totp_state(&user.id).await.unwrap().is_none());
    assert_eq!(store.recovery_codes_left(&user.id).await.unwrap(), 0);
}

#[tokio::test]
async fn the_agent_workspace_is_part_of_the_total_and_survives_a_round_trip() {
    let (_dir, store) = open();
    let (_, space) = store
        .create_user(new_user("ws_owner", ROLE_ADMIN))
        .await
        .unwrap();
    let mut with_workspace = usage(10, 0, 0, 0);
    with_workspace.workspace_bytes = 5_000;
    store
        .save_space_usage(&space.id, with_workspace, 1_000)
        .await
        .unwrap();
    let got = store.get_space_usage(&space.id).await.unwrap().unwrap();
    assert_eq!(got.usage.workspace_bytes, 5_000);
    assert_eq!(got.total_bytes, 5_010, "代理工作目录计入配额");
    assert_eq!(
        store
            .get_space(&space.id)
            .await
            .unwrap()
            .unwrap()
            .storage_bytes,
        5_010
    );
    let ranking = store.storage_ranking(10).await.unwrap();
    assert_eq!(ranking[0].measured.usage.workspace_bytes, 5_000);
}

#[tokio::test]
async fn the_storage_ranking_orders_by_size_names_the_owner_and_totals_add_up() {
    let (_dir, store) = open();
    let (_, admin_space) = store
        .create_user(new_user("first_admin2", ROLE_ADMIN))
        .await
        .unwrap();
    let (_, a) = store
        .create_user(new_user("alice_r", ROLE_USER))
        .await
        .unwrap();
    let (_, b) = store
        .create_user(new_user("bob_r", ROLE_USER))
        .await
        .unwrap();
    let (_, _unmeasured) = store
        .create_user(new_user("carol_r", ROLE_USER))
        .await
        .unwrap();
    store
        .save_space_usage(&admin_space.id, usage(0, 0, 1_000, 0), 500)
        .await
        .unwrap();
    store
        .save_space_usage(&a.id, usage(100, 0, 50, 10), 600)
        .await
        .unwrap();
    store
        .save_space_usage(&b.id, usage(5, 5, 5, 5), 700)
        .await
        .unwrap();

    let ranking = store.storage_ranking(10).await.unwrap();
    let names: Vec<_> = ranking
        .iter()
        .map(|row| row.username.as_deref().unwrap())
        .collect();
    assert_eq!(
        names,
        ["first_admin2", "alice_r", "bob_r"],
        "大的在前,没统计过的不在排行里"
    );
    assert_eq!(store.storage_ranking(2).await.unwrap().len(), 2);

    let totals = store.storage_totals().await.unwrap();
    assert_eq!(
        (
            totals.measured_spaces,
            totals.total_spaces,
            totals.total_bytes,
            totals.vectors_bytes
        ),
        (3, 4, 1_000 + 160 + 20, 1_000 + 50 + 5)
    );
    assert_eq!(
        totals.oldest_measured_at,
        Some(500),
        "最久没更新的时间,调度器据此知道该先量谁"
    );
}

#[tokio::test]
async fn purging_a_user_removes_their_space_usage_row() {
    let (_dir, store) = open();
    store
        .create_user(new_user("root_admin2", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, space) = store
        .create_user(new_user("alice_p", ROLE_USER))
        .await
        .unwrap();
    store
        .save_space_usage(&space.id, usage(1, 1, 1, 1), 1)
        .await
        .unwrap();
    store.request_deletion(&alice.id, 1_000, 10).await.unwrap();
    store.purge_user(&alice.id, 2_000).await.unwrap();
    assert!(store.get_space_usage(&space.id).await.unwrap().is_none());
    assert_eq!(store.storage_totals().await.unwrap().measured_spaces, 0);
}

#[tokio::test]
async fn spaces_are_listed_stalest_first_with_never_measured_ones_in_front() {
    let (_dir, store) = open();
    let (_, s1) = store
        .create_user(new_user("stale_admin", ROLE_ADMIN))
        .await
        .unwrap();
    let (_, s2) = store
        .create_user(new_user("stale_a", ROLE_USER))
        .await
        .unwrap();
    let (_, s3) = store
        .create_user(new_user("stale_b", ROLE_USER))
        .await
        .unwrap();
    store
        .save_space_usage(&s1.id, usage(1, 0, 0, 0), 900)
        .await
        .unwrap();
    store
        .save_space_usage(&s2.id, usage(1, 0, 0, 0), 100)
        .await
        .unwrap();
    // s3 从没量过 → 排最前;然后是最旧的 s2,最后是 s1
    assert_eq!(
        store.spaces_by_staleness(10).await.unwrap(),
        [s3.id.clone(), s2.id.clone(), s1.id.clone()]
    );
    assert_eq!(
        store.spaces_by_staleness(1).await.unwrap(),
        std::slice::from_ref(&s3.id)
    );
    // 量完之后它就排到后面去了:一轮一轮往下轮,不会总盯着同一批
    store
        .save_space_usage(&s3.id, usage(1, 0, 0, 0), 1_000)
        .await
        .unwrap();
    assert_eq!(store.spaces_by_staleness(1).await.unwrap(), [s2.id]);
}

#[tokio::test]
async fn every_new_user_gets_their_own_admin_key_and_it_finds_them() {
    let (_dir, store) = open();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    let (bob, _) = store.create_user(new_user("bob", ROLE_USER)).await.unwrap();
    // 建用户时就同事务发好了,不是等 ensure 现发:直接数表
    let issued: i64 = store
        .read(|conn| {
            conn.query_row("SELECT COUNT(*) FROM user_admin_keys", [], |row| row.get(0))
                .map_err(crate::sql::map_sqlite_error)
        })
        .await
        .unwrap();
    assert_eq!(issued, 2, "注册时就该有 key");
    let a = store.ensure_admin_key(&alice.id).await.unwrap();
    let b = store.ensure_admin_key(&bob.id).await.unwrap();
    assert!(a.admin_key.starts_with("kb_ak_") && b.admin_key.starts_with("kb_ak_"));
    assert_ne!(a.admin_key, b.admin_key, "一人一把");
    assert_eq!(
        store.ensure_admin_key(&alice.id).await.unwrap().admin_key,
        a.admin_key,
        "重复取到的是同一把,不会每次现发"
    );
    assert_eq!(
        store
            .find_user_by_admin_key(&a.admin_key)
            .await
            .unwrap()
            .unwrap()
            .id,
        alice.id
    );
    assert!(
        store
            .find_user_by_admin_key("kb_ak_not-a-real-key")
            .await
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        store.ensure_admin_key("usr_nobody").await,
        Err(KbError::NotFound(_))
    ));
}

#[tokio::test]
async fn rotating_kills_the_old_key_at_once_and_leaves_other_users_alone() {
    let (_dir, store) = open();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    let (bob, _) = store.create_user(new_user("bob", ROLE_USER)).await.unwrap();
    let old = store.ensure_admin_key(&alice.id).await.unwrap();
    let bobs = store.ensure_admin_key(&bob.id).await.unwrap();
    assert!(old.rotated_at.is_none());

    let fresh = store.rotate_admin_key(&alice.id, 5_000).await.unwrap();
    assert_ne!(fresh.admin_key, old.admin_key);
    assert_eq!(fresh.rotated_at, Some(5_000));
    assert_eq!(fresh.created_at, old.created_at, "首次发放时间不变");
    assert!(
        store
            .find_user_by_admin_key(&old.admin_key)
            .await
            .unwrap()
            .is_none(),
        "旧 key 立刻失效"
    );
    assert_eq!(
        store
            .find_user_by_admin_key(&fresh.admin_key)
            .await
            .unwrap()
            .unwrap()
            .id,
        alice.id
    );
    assert_eq!(
        store.ensure_admin_key(&bob.id).await.unwrap().admin_key,
        bobs.admin_key,
        "别人的 key 不受影响"
    );
}

#[tokio::test]
async fn a_disabled_users_admin_key_stops_working_and_comes_back_with_the_account() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    let key = store.ensure_admin_key(&alice.id).await.unwrap().admin_key;
    store
        .update_user(
            &alice.id,
            UserUpdate {
                status: Some(UserStatus::Disabled),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        store.find_user_by_admin_key(&key).await.unwrap().is_none(),
        "停用的账号不能再用 key"
    );
    store
        .update_user(
            &alice.id,
            UserUpdate {
                status: Some(UserStatus::Active),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(store.find_user_by_admin_key(&key).await.unwrap().is_some());
}

#[tokio::test]
async fn purging_an_account_deletes_its_admin_key() {
    let (_dir, store) = open();
    store
        .create_user(new_user("boss", ROLE_ADMIN))
        .await
        .unwrap();
    let (alice, _) = store
        .create_user(new_user("alice", ROLE_USER))
        .await
        .unwrap();
    let key = store.ensure_admin_key(&alice.id).await.unwrap().admin_key;
    store
        .request_deletion(&alice.id, 1_000, WEEK)
        .await
        .unwrap();
    store.purge_user(&alice.id, 1_000 + WEEK).await.unwrap();
    assert!(store.find_user_by_admin_key(&key).await.unwrap().is_none());
    let probe = key.clone();
    let left: i64 = store
        .read(move |conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM user_admin_keys WHERE admin_key = ?1",
                rusqlite::params![probe],
                |row| row.get(0),
            )
            .map_err(crate::sql::map_sqlite_error)
        })
        .await
        .unwrap();
    assert_eq!(left, 0, "表里也不能留");
}

#[tokio::test]
async fn the_migration_gives_every_existing_user_a_distinct_key() {
    let dir = tempfile::tempdir().expect("临时目录");
    let path = dir.path().join("system.db");
    // 先把库迁到 12 版(没有 admin key 的老库),手工插两个老用户
    {
        let mut conn = rusqlite::Connection::open(&path).unwrap();
        for (version, sql) in super::migrate::MIGRATIONS.iter().filter(|(v, _)| *v <= 12) {
            let tx = conn.transaction().unwrap();
            tx.execute_batch(sql).unwrap();
            tx.pragma_update(None, "user_version", *version).unwrap();
            tx.commit().unwrap();
        }
        // 内置角色平时是 open 时播种的;这里库还没经过 open,手工放一行让外键过得去
        conn.execute(
            "INSERT INTO roles (id, name, description, builtin, all_features, dangerous, created_at, updated_at) \
             VALUES ('role_user', '普通用户', '', 1, 0, 0, 1, 1)",
            [],
        )
        .unwrap();
        for name in ["old_one", "old_two"] {
            conn.execute(
                "INSERT INTO users (id, username, display_name, password_hash, role_id, status, must_change_password, registered_via, created_at) \
                 VALUES (?1, ?2, ?2, 'x', 'role_user', 'active', 0, 'migrated', 1)",
                rusqlite::params![format!("usr_{name}"), name],
            )
            .unwrap();
        }
    }
    // 打开时跑 13 版迁移
    let store = SystemStore::open(&path).unwrap();
    let one = store.ensure_admin_key("usr_old_one").await.unwrap();
    let two = store.ensure_admin_key("usr_old_two").await.unwrap();
    assert!(one.admin_key.starts_with("kb_ak_") && two.admin_key.starts_with("kb_ak_"));
    assert_eq!(
        one.admin_key.len(),
        "kb_ak_".len() + 48,
        "格式和代码里生成的一致"
    );
    assert_ne!(one.admin_key, two.admin_key, "randomblob 每行单独求值");
    assert!(one.rotated_at.is_none());
    // 重新打开不会再补发、不会换 key
    drop(store);
    let again = SystemStore::open(&path).unwrap();
    assert_eq!(
        again
            .ensure_admin_key("usr_old_one")
            .await
            .unwrap()
            .admin_key,
        one.admin_key
    );
}
