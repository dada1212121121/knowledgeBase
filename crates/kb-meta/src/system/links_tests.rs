//! 分享链接与游客存储的测试。

use kb_core::KbError;
use kb_core::account::{NewUser, ROLE_ADMIN, ROLE_USER, UserStatus};
use kb_core::share::link::{Audience, LinkState, TOKEN_LEN, looks_like_token};
use kb_core::share::{ResourceKey, Role};

use super::{LinkUpdate, MAX_BUNDLE_ITEMS, NewLink, SystemStore};

const T0: i64 = 1_800_000_000_000;
const DAY: i64 = 86_400_000;

struct World {
    dir: tempfile::TempDir,
    store: SystemStore,
    space_a: String,
    space_b: String,
    alice: String,
    bob: String,
}

async fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let store = SystemStore::open(dir.path().join("system.db")).unwrap();
    let make = |name: &str, role: &str| NewUser {
        username: name.to_owned(),
        email: Some(format!("{name}@example.com")),
        display_name: None,
        password_hash: "x".to_owned(),
        role_id: role.to_owned(),
        status: UserStatus::Active,
        registered_via: "test".to_owned(),
        must_change_password: false,
        email_verified: true,
    };
    store.create_user(make("boss", ROLE_ADMIN)).await.unwrap();
    let (alice, space_a) = store.create_user(make("alice", ROLE_USER)).await.unwrap();
    let (bob, space_b) = store.create_user(make("bob", ROLE_USER)).await.unwrap();
    World {
        dir,
        store,
        space_a: space_a.id,
        space_b: space_b.id,
        alice: alice.id,
        bob: bob.id,
    }
}

impl World {
    fn file(&self, path: &str) -> ResourceKey {
        ResourceKey::file(&self.space_a, "proj", path).unwrap()
    }
    fn dir(&self, path: &str) -> ResourceKey {
        ResourceKey::dir(&self.space_a, "proj", path).unwrap()
    }
    fn new_link(&self, resource: ResourceKey) -> NewLink {
        NewLink {
            resource: Some(resource),
            items: vec![],
            title: None,
            audience: Audience::Anyone,
            role: Role::Viewer,
            password_hash: None,
            expires_at: None,
            allow_download: true,
            watermark: false,
            allow_reshare: false,
            created_by: self.alice.clone(),
        }
    }
}

#[tokio::test]
async fn creating_a_link_returns_the_token_once_and_the_database_only_keeps_its_hash() {
    let w = world().await;
    let (link, token) = w
        .store
        .create_link(w.new_link(w.file("a.md")), 0, T0)
        .await
        .unwrap();
    assert!(
        looks_like_token(&token) && token.len() == TOKEN_LEN,
        "{token}"
    );
    assert_eq!(link.token_hint, token[token.len() - 4..]);
    assert_eq!(link.state(T0), LinkState::Active);
    // 凭令牌能找回,凭乱七八糟的东西找不到
    let found = w.store.find_link_by_token(&token).await.unwrap().unwrap();
    assert_eq!(found.link.id, link.id);
    for bad in [
        "",
        "short",
        &"x".repeat(22),
        "../../../../etc/passwd",
        &token[..21],
    ] {
        assert!(
            w.store.find_link_by_token(bad).await.unwrap().is_none(),
            "{bad:?}"
        );
    }
    // 库文件里搜不到明文令牌
    drop(w.store);
    let bytes = std::fs::read(w.dir.path().join("system.db")).unwrap();
    let wal = std::fs::read(w.dir.path().join("system.db-wal")).unwrap_or_default();
    for blob in [&bytes, &wal] {
        assert!(
            !blob
                .windows(token.len())
                .any(|window| window == token.as_bytes()),
            "数据库里不该有令牌明文"
        );
    }
}

#[tokio::test]
async fn resetting_kills_the_old_address_and_revoking_is_permanent() {
    let w = world().await;
    let (link, old) = w
        .store
        .create_link(w.new_link(w.file("a.md")), 0, T0)
        .await
        .unwrap();
    let new = w.store.reset_link_token(&link.id).await.unwrap();
    assert_ne!(old, new);
    assert!(
        w.store.find_link_by_token(&old).await.unwrap().is_none(),
        "旧地址作废"
    );
    assert_eq!(
        w.store
            .find_link_by_token(&new)
            .await
            .unwrap()
            .unwrap()
            .link
            .id,
        link.id,
        "设置保留"
    );
    assert!(w.store.revoke_link(&link.id, T0 + 1).await.unwrap());
    assert!(
        !w.store.revoke_link(&link.id, T0 + 2).await.unwrap(),
        "重复撤销返回 false"
    );
    let revoked = w.store.find_link_by_token(&new).await.unwrap().unwrap();
    assert_eq!(revoked.link.state(T0 + 3), LinkState::Revoked);
    assert!(
        w.store.reset_link_token(&link.id).await.is_err(),
        "撤销后不能重置"
    );
    let err = w
        .store
        .update_link(
            &link.id,
            LinkUpdate {
                enabled: Some(true),
                ..Default::default()
            },
            T0,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
}

#[tokio::test]
async fn limits_and_consistency_are_enforced_on_creation() {
    let w = world().await;
    // 每人链接数上限
    for n in 0..2 {
        w.store
            .create_link(w.new_link(w.file(&format!("f{n}.md"))), 2, T0)
            .await
            .unwrap();
    }
    let err = w
        .store
        .create_link(w.new_link(w.file("f9.md")), 2, T0)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::Forbidden(_)), "{err:?}");
    // 别人不受影响;撤销释放名额
    let mut bobs = w.new_link(ResourceKey::file(&w.space_b, "p", "x.md").unwrap());
    bobs.created_by = w.bob.clone();
    w.store.create_link(bobs, 2, T0).await.unwrap();
    let first = &w.store.links_by_creator(&w.alice).await.unwrap()[0]
        .link
        .id
        .clone();
    w.store.revoke_link(first, T0).await.unwrap();
    assert!(
        w.store
            .create_link(w.new_link(w.file("f9.md")), 2, T0)
            .await
            .is_ok()
    );
    // 合集链接:同一个知识库、条数上限、不能同时带单个资源
    let mut mixed = w.new_link(w.file("a.md"));
    mixed.items = vec![w.file("b.md")];
    assert!(w.store.create_link(mixed, 0, T0).await.is_err());
    let cross = NewLink {
        resource: None,
        items: vec![
            w.file("a.md"),
            ResourceKey::file(&w.space_b, "p", "x.md").unwrap(),
        ],
        ..w.new_link(w.file("a.md"))
    };
    assert!(
        w.store.create_link(cross, 0, T0).await.is_err(),
        "不能把两个知识库的东西放进一个链接"
    );
    let many = NewLink {
        resource: None,
        items: (0..=MAX_BUNDLE_ITEMS)
            .map(|n| w.file(&format!("m{n}.md")))
            .collect(),
        ..w.new_link(w.file("a.md"))
    };
    assert!(w.store.create_link(many, 0, T0).await.is_err());
    let empty = NewLink {
        resource: None,
        items: vec![],
        ..w.new_link(w.file("a.md"))
    };
    assert!(w.store.create_link(empty, 0, T0).await.is_err());
    // 过期时间必须在将来
    let mut past = w.new_link(w.file("a.md"));
    past.expires_at = Some(T0);
    assert!(w.store.create_link(past, 0, T0).await.is_err());
}

#[tokio::test]
async fn a_bundle_link_covers_its_items_and_everything_under_them_but_nothing_else() {
    let w = world().await;
    let bundle = NewLink {
        resource: None,
        items: vec![w.dir("docs"), w.file("solo/one.md"), w.file("zeta.md")],
        title: Some("合集".into()),
        ..w.new_link(w.file("a.md"))
    };
    let (link, token) = w.store.create_link(bundle, 0, T0).await.unwrap();
    let record = w.store.find_link_by_token(&token).await.unwrap().unwrap();
    assert_eq!(record.link.title.as_deref(), Some("合集"));
    assert_eq!(
        record.items,
        vec![w.dir("docs"), w.file("solo/one.md"), w.file("zeta.md")],
        "条目顺序保留"
    );
    assert!(link.resource_key.is_none());
    assert!(record.covers(&w.file("docs/deep/x.md")), "目录里的文件");
    assert!(record.covers(&w.file("solo/one.md")));
    assert!(
        !record.covers(&w.file("solo/two.md")),
        "只选了文件,同级文件不在内"
    );
    assert!(
        !record.covers(&w.file("docs2/x.md")),
        "名字相近的目录不在内"
    );
    assert!(
        !record.covers(&ResourceKey::file(&w.space_b, "proj", "docs/x.md").unwrap()),
        "别的知识库不在内"
    );
    // 单个资源链接同理
    let (_, single_token) = w
        .store
        .create_link(w.new_link(w.dir("pub")), 0, T0)
        .await
        .unwrap();
    let single = w
        .store
        .find_link_by_token(&single_token)
        .await
        .unwrap()
        .unwrap();
    assert!(single.covers(&w.file("pub/a.md")) && !single.covers(&w.file("other/a.md")));
}

#[tokio::test]
async fn settings_can_be_changed_and_cleared_without_touching_the_rest() {
    let w = world().await;
    let mut base = w.new_link(w.file("a.md"));
    base.password_hash = Some("hash".into());
    base.expires_at = Some(T0 + DAY);
    let (link, _) = w.store.create_link(base, 0, T0).await.unwrap();
    assert!(link.has_password);
    let changed = w
        .store
        .update_link(
            &link.id,
            LinkUpdate {
                audience: Some(Audience::LoggedIn),
                role: Some(Role::Editor),
                watermark: Some(true),
                enabled: Some(false),
                ..Default::default()
            },
            T0,
        )
        .await
        .unwrap();
    assert_eq!(
        (
            changed.link.audience,
            changed.link.role,
            changed.link.watermark,
            changed.link.enabled
        ),
        (Audience::LoggedIn, Role::Editor, true, false)
    );
    assert!(
        changed.link.has_password && changed.link.expires_at == Some(T0 + DAY),
        "没提的字段不变"
    );
    assert_eq!(changed.link.state(T0), LinkState::Closed);
    // 清除密码和有效期
    let cleared = w
        .store
        .update_link(
            &link.id,
            LinkUpdate {
                password_hash: Some(None),
                expires_at: Some(None),
                enabled: Some(true),
                ..Default::default()
            },
            T0,
        )
        .await
        .unwrap();
    assert!(!cleared.link.has_password && cleared.link.expires_at.is_none());
    assert_eq!(cleared.link.state(T0 + 100 * DAY), LinkState::Active);
    // 新的过期时间必须在将来
    assert!(
        w.store
            .update_link(
                &link.id,
                LinkUpdate {
                    expires_at: Some(Some(T0)),
                    ..Default::default()
                },
                T0
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn views_count_everyone_but_only_logged_in_visitors_are_listed_and_traffic_adds_up_per_day() {
    let w = world().await;
    let (link, _) = w
        .store
        .create_link(w.new_link(w.file("a.md")), 0, T0)
        .await
        .unwrap();
    w.store
        .record_link_view(&link.id, None, T0 + 1)
        .await
        .unwrap();
    w.store
        .record_link_view(&link.id, None, T0 + 2)
        .await
        .unwrap();
    w.store
        .record_link_view(&link.id, Some(&w.bob), T0 + 3)
        .await
        .unwrap();
    w.store
        .record_link_view(&link.id, Some(&w.bob), T0 + 4)
        .await
        .unwrap();
    let after = w.store.get_link(&link.id).await.unwrap().unwrap().link;
    assert_eq!((after.views, after.last_view_at), (4, Some(T0 + 4)));
    let visitors = w.store.link_visitors(&link.id).await.unwrap();
    assert_eq!(visitors.len(), 1, "匿名的不进名单");
    assert_eq!(
        (
            visitors[0].user_id.as_str(),
            visitors[0].visits,
            visitors[0].first_at,
            visitors[0].last_at
        ),
        (w.bob.as_str(), 2, T0 + 3, T0 + 4)
    );
    // 流量按天累计
    assert_eq!(
        w.store
            .add_link_bytes(&link.id, "2027-01-15", 100)
            .await
            .unwrap(),
        100
    );
    assert_eq!(
        w.store
            .add_link_bytes(&link.id, "2027-01-15", 50)
            .await
            .unwrap(),
        150
    );
    assert_eq!(
        w.store
            .add_link_bytes(&link.id, "2027-01-16", 7)
            .await
            .unwrap(),
        7
    );
    assert_eq!(
        w.store.link_bytes(&link.id, "2027-01-15").await.unwrap(),
        150
    );
    assert_eq!(w.store.link_bytes(&link.id, "2027-01-17").await.unwrap(), 0);
    assert_eq!(
        w.store.purge_link_bytes_before("2027-01-16").await.unwrap(),
        1
    );
}

#[tokio::test]
async fn guests_get_a_default_name_keep_it_and_can_rename_within_limits() {
    let w = world().await;
    let (link, _) = w
        .store
        .create_link(w.new_link(w.file("a.md")), 0, T0)
        .await
        .unwrap();
    let hash = kb_core::token::sha256_hex("cookie-secret-1");
    let guest = w
        .store
        .touch_guest(&hash, &link.id, Some("1.2.3.4"), T0)
        .await
        .unwrap();
    assert_eq!(guest.nickname, format!("访客 {}", &hash[..4]));
    let again = w
        .store
        .touch_guest(&hash, &link.id, None, T0 + 10)
        .await
        .unwrap();
    assert_eq!(
        (again.nickname.as_str(), again.created_at, again.last_seen),
        (guest.nickname.as_str(), T0, T0 + 10)
    );
    assert_eq!(
        w.store.set_guest_nickname(&hash, "  小王 ").await.unwrap(),
        "小王"
    );
    assert_eq!(
        w.store
            .touch_guest(&hash, &link.id, None, T0 + 20)
            .await
            .unwrap()
            .nickname,
        "小王"
    );
    for bad in ["", "   ", &"长".repeat(21), "a\nb", "<script>"] {
        assert!(
            w.store.set_guest_nickname(&hash, bad).await.is_err(),
            "{bad:?}"
        );
    }
    assert!(w.store.set_guest_nickname("unknown", "x").await.is_err());
    // 很久没出现的访客记录被清理
    assert_eq!(w.store.purge_stale_guests(T0 + 21).await.unwrap(), 1);
}

#[tokio::test]
async fn deleting_a_resource_revokes_the_links_inside_it_but_not_a_similarly_named_sibling() {
    let w = world().await;
    let (inside, _) = w
        .store
        .create_link(w.new_link(w.file("docs/a.md")), 0, T0)
        .await
        .unwrap();
    let (folder, _) = w
        .store
        .create_link(w.new_link(w.dir("docs")), 0, T0)
        .await
        .unwrap();
    let (sibling, _) = w
        .store
        .create_link(w.new_link(w.file("docs2/a.md")), 0, T0)
        .await
        .unwrap();
    // 合集链接自己的 resource_key 是空的,被删的文件只在 items 里。只按 share_links.resource_key
    // 判断会漏掉它,用户点开合集还能看到一个已经删掉的文件。
    let (bundle, _) = w
        .store
        .create_link(
            NewLink {
                resource: None,
                items: vec![w.file("docs/a.md"), w.file("elsewhere.md")],
                ..w.new_link(w.file("a.md"))
            },
            0,
            T0,
        )
        .await
        .unwrap();
    assert_eq!(
        w.store
            .revoke_links_within(&w.dir("docs"), T0 + 1)
            .await
            .unwrap(),
        3
    );
    for id in [&inside.id, &folder.id, &bundle.id] {
        assert_eq!(
            w.store
                .get_link(id)
                .await
                .unwrap()
                .unwrap()
                .link
                .state(T0 + 2),
            LinkState::Revoked
        );
    }
    assert_eq!(
        w.store
            .get_link(&sibling.id)
            .await
            .unwrap()
            .unwrap()
            .link
            .state(T0 + 2),
        LinkState::Active
    );
}

#[tokio::test]
async fn deleting_an_account_removes_links_it_made_and_links_into_its_space() {
    let w = world().await;
    let (mine, my_token) = w
        .store
        .create_link(w.new_link(w.file("a.md")), 0, T0)
        .await
        .unwrap();
    let bobs_resource = ResourceKey::file(&w.space_b, "p", "x.md").unwrap();
    let mut bobs = w.new_link(bobs_resource);
    bobs.created_by = w.bob.clone();
    let (theirs, their_token) = w.store.create_link(bobs, 0, T0).await.unwrap();
    w.store
        .record_link_view(&mine.id, Some(&w.bob), T0)
        .await
        .unwrap();
    w.store.request_deletion(&w.alice, T0, 10).await.unwrap();
    w.store.purge_user(&w.alice, T0 + 100).await.unwrap();
    assert!(
        w.store
            .find_link_by_token(&my_token)
            .await
            .unwrap()
            .is_none()
    );
    assert!(w.store.link_visitors(&mine.id).await.unwrap().is_empty());
    assert_eq!(
        w.store
            .find_link_by_token(&their_token)
            .await
            .unwrap()
            .unwrap()
            .link
            .id,
        theirs.id,
        "bob 的不受影响"
    );
}

#[tokio::test]
async fn every_link_listing_is_scoped_correctly() {
    let w = world().await;
    let key = w.file("a.md");
    w.store
        .create_link(w.new_link(key.clone()), 0, T0)
        .await
        .unwrap();
    w.store
        .create_link(w.new_link(key.clone()), 0, T0 + 1)
        .await
        .unwrap();
    let mut bobs = w.new_link(ResourceKey::file(&w.space_b, "p", "x.md").unwrap());
    bobs.created_by = w.bob.clone();
    w.store.create_link(bobs, 0, T0 + 2).await.unwrap();
    assert_eq!(w.store.links_for_resource(&key).await.unwrap().len(), 2);
    assert_eq!(w.store.links_by_creator(&w.alice).await.unwrap().len(), 2);
    assert_eq!(w.store.links_by_creator(&w.bob).await.unwrap().len(), 1);
    let (page, total) = w.store.all_links(2, 0).await.unwrap();
    assert_eq!((page.len(), total), (2, 3));
    assert_eq!(w.store.all_links(2, 2).await.unwrap().0.len(), 1);
}
