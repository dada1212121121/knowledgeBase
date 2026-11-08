use kb_core::account::{NewUser, ROLE_ADMIN, ROLE_USER, UserStatus};
use kb_core::share::{ResourceKey, Role};

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

#[tokio::test]
async fn expired_grants_old_guests_and_old_traffic_rows_go_while_fresh_ones_stay() {
    let dir = tempfile::tempdir().unwrap();
    let system = SystemStore::open(dir.path().join("system.db")).unwrap();
    let (admin, space) = system
        .create_user(new_user("owner", ROLE_ADMIN))
        .await
        .unwrap();
    let (bob, _) = system
        .create_user(new_user("bob", ROLE_USER))
        .await
        .unwrap();
    let t0: Millis = 1_800_000_000_000;
    let key = ResourceKey::space(&space.id).unwrap();
    // 一条一小时后到期的授权,另一条永久
    system
        .set_grant(
            &key,
            &bob.id,
            Role::Viewer,
            "direct",
            &admin.id,
            t0,
            Some(t0 + 3_600_000),
        )
        .await
        .unwrap();
    // 游客:一个 t0 出现过,一个在 100 天后才出现
    let day_100 = t0 + 100 * 86_400_000;
    system
        .touch_guest(&"a".repeat(64), "lnk_x", None, t0)
        .await
        .unwrap();
    system
        .touch_guest(&"b".repeat(64), "lnk_x", None, day_100)
        .await
        .unwrap();

    let (grants, guests, _) = run(&system, day_100 + 1).await;
    assert_eq!(grants, 1, "过期授权清掉");
    assert_eq!(guests, 1, "100 天没出现的游客清掉,刚出现的留着");
    let (grants, guests, _) = run(&system, day_100 + 2).await;
    assert_eq!((grants, guests), (0, 0), "重复跑是空操作");
}
