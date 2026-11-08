//! 文档授权存储的测试:继承、停止继承、批量原子性、过期、隔离、清理。

use kb_core::KbError;
use kb_core::account::{NewUser, ROLE_ADMIN, ROLE_USER, UserStatus};
use kb_core::share::ResourceKey;
use kb_core::share::Role;
use kb_core::share::link::Audience;

use super::{GrantChange, MAX_BATCH_KEYS, SystemStore, UserUpdate};

const T0: i64 = 1_800_000_000_000;
const DAY: i64 = 86_400_000;

struct World {
    _dir: tempfile::TempDir,
    store: SystemStore,
    /// 知识库 id:alice 的、bob 的。
    space_a: String,
    space_b: String,
    alice: String,
    bob: String,
    carol: String,
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
    // 第一个用户会拿走主知识库,垫一个管理员
    store.create_user(make("boss", ROLE_ADMIN)).await.unwrap();
    let (alice, space_a) = store.create_user(make("alice", ROLE_USER)).await.unwrap();
    let (bob, space_b) = store.create_user(make("bob", ROLE_USER)).await.unwrap();
    let (carol, _) = store.create_user(make("carol", ROLE_USER)).await.unwrap();
    World {
        _dir: dir,
        store,
        space_a: space_a.id,
        space_b: space_b.id,
        alice: alice.id,
        bob: bob.id,
        carol: carol.id,
    }
}

impl World {
    fn dir(&self, path: &str) -> ResourceKey {
        ResourceKey::dir(&self.space_a, "proj", path).unwrap()
    }
    fn file(&self, path: &str) -> ResourceKey {
        ResourceKey::file(&self.space_a, "proj", path).unwrap()
    }
    fn col(&self) -> ResourceKey {
        ResourceKey::collection(&self.space_a, "proj").unwrap()
    }
    async fn role(&self, who: &str, key: &ResourceKey) -> Option<Role> {
        self.store
            .granted_role(who, key, T0)
            .await
            .unwrap()
            .map(|e| e.role)
    }
    async fn grant(&self, key: &ResourceKey, who: &str, role: Role) {
        self.store
            .set_grant(key, who, role, "direct", &self.alice, T0, None)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn granting_updates_in_place_and_reports_the_previous_role() {
    let w = world().await;
    let key = w.file("a.md");
    let first = w
        .store
        .set_grant(&key, &w.bob, Role::Viewer, "direct", &w.alice, T0, None)
        .await
        .unwrap();
    assert_eq!(first.previous, None);
    let second = w
        .store
        .set_grant(&key, &w.bob, Role::Editor, "direct", &w.alice, T0 + 1, None)
        .await
        .unwrap();
    assert_eq!(
        (second.previous, second.grant.role),
        (Some(Role::Viewer), Role::Editor)
    );
    assert_eq!(
        w.store.direct_grants(&key, T0).await.unwrap().len(),
        1,
        "同一个人同一个资源只有一条"
    );
    assert_eq!(w.role(&w.bob, &key).await, Some(Role::Editor));
    assert_eq!(w.role(&w.carol, &key).await, None);
    assert_eq!(
        w.store.remove_grant(&key, &w.bob).await.unwrap(),
        Some(Role::Editor)
    );
    assert_eq!(w.store.remove_grant(&key, &w.bob).await.unwrap(), None);
    assert_eq!(w.role(&w.bob, &key).await, None);
}

#[tokio::test]
async fn invalid_grants_are_refused_without_leaving_anything_behind() {
    let w = world().await;
    let key = w.file("a.md");
    // 不能给知识库的所有者再加一条授权(他本来就是所有者)
    let err = w
        .store
        .set_grant(&key, &w.alice, Role::Viewer, "direct", &w.alice, T0, None)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::InvalidInput(_)), "{err:?}");
    // 不存在 / 停用的人
    let err = w
        .store
        .set_grant(
            &key,
            "usr_ghost",
            Role::Viewer,
            "direct",
            &w.alice,
            T0,
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
    w.store
        .update_user(
            &w.carol,
            UserUpdate {
                status: Some(UserStatus::Disabled),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        w.store
            .set_grant(&key, &w.carol, Role::Viewer, "direct", &w.alice, T0, None)
            .await
            .is_err()
    );
    // 知识库不存在
    let ghost = ResourceKey::file("sp_ghost", "proj", "a.md").unwrap();
    let err = w
        .store
        .set_grant(&ghost, &w.bob, Role::Viewer, "direct", &w.alice, T0, None)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
    // 过期时间必须在将来
    assert!(
        w.store
            .set_grant(&key, &w.bob, Role::Viewer, "direct", &w.alice, T0, Some(T0))
            .await
            .is_err()
    );
    assert!(w.store.direct_grants(&key, T0).await.unwrap().is_empty());
}

#[tokio::test]
async fn expired_grants_stop_working_everywhere() {
    let w = world().await;
    let key = w.file("a.md");
    w.store
        .set_grant(
            &key,
            &w.bob,
            Role::Editor,
            "direct",
            &w.alice,
            T0,
            Some(T0 + DAY),
        )
        .await
        .unwrap();
    assert_eq!(
        w.store
            .granted_role(&w.bob, &key, T0 + DAY - 1)
            .await
            .unwrap()
            .map(|e| e.role),
        Some(Role::Editor)
    );
    assert!(
        w.store
            .granted_role(&w.bob, &key, T0 + DAY)
            .await
            .unwrap()
            .is_none(),
        "到点即失效"
    );
    assert!(
        w.store
            .direct_grants(&key, T0 + DAY)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        w.store
            .shared_with(&w.bob, false, T0 + DAY)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        w.store
            .shared_by(&w.alice, T0 + DAY)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(w.store.purge_expired_grants(T0 + DAY).await.unwrap(), 1);
}

#[tokio::test]
async fn inheritance_through_the_store_follows_the_folder_tree() {
    let w = world().await;
    w.grant(&w.dir("docs"), &w.bob, Role::Editor).await;
    assert_eq!(
        w.role(&w.bob, &w.file("docs/inner/a.md")).await,
        Some(Role::Editor),
        "文件夹里的文件"
    );
    assert_eq!(
        w.role(&w.bob, &w.dir("docs/inner")).await,
        Some(Role::Editor),
        "子文件夹"
    );
    assert_eq!(
        w.role(&w.bob, &w.file("docs2/a.md")).await,
        None,
        "名字以 docs 开头的另一个文件夹"
    );
    assert_eq!(
        w.role(&w.bob, &w.file("top.md")).await,
        None,
        "集合根下的文件"
    );
    assert_eq!(w.role(&w.bob, &w.col()).await, None);
    // 只分享文件:同目录新增的文件不可见
    w.grant(&w.file("solo/one.md"), &w.carol, Role::Viewer)
        .await;
    assert_eq!(
        w.role(&w.carol, &w.file("solo/one.md")).await,
        Some(Role::Viewer)
    );
    assert_eq!(w.role(&w.carol, &w.file("solo/two.md")).await, None);
    // 授权给集合 → 笔记也在内;别人的知识库里同名集合不受影响
    w.grant(&w.col(), &w.carol, Role::Commenter).await;
    let note = ResourceKey::insight(&w.space_a, "proj", "n1").unwrap();
    assert_eq!(w.role(&w.carol, &note).await, Some(Role::Commenter));
    let other_space_note = ResourceKey::insight(&w.space_b, "proj", "n1").unwrap();
    assert_eq!(
        w.role(&w.carol, &other_space_note).await,
        None,
        "授权不跨知识库"
    );
}

#[tokio::test]
async fn stopping_inheritance_can_be_toggled_and_only_cuts_what_is_above() {
    let w = world().await;
    w.grant(&w.col(), &w.bob, Role::Manager).await;
    w.grant(&w.dir("secret"), &w.carol, Role::Viewer).await;
    let file = w.file("secret/x.md");
    assert_eq!(w.role(&w.bob, &file).await, Some(Role::Manager));
    w.store
        .set_inherit_break(&w.dir("secret"), true, &w.alice, T0)
        .await
        .unwrap();
    assert!(w.store.is_inherit_broken(&w.dir("secret")).await.unwrap());
    assert_eq!(
        w.role(&w.bob, &file).await,
        None,
        "bob 只有集合上的授权,断点下面看不到了"
    );
    assert_eq!(
        w.role(&w.carol, &file).await,
        Some(Role::Viewer),
        "断点自己的授权照常"
    );
    assert_eq!(
        w.role(&w.bob, &w.file("open/y.md")).await,
        Some(Role::Manager),
        "别的文件夹不受影响"
    );
    // 分享面板:断点下面只列断点自己的协作者
    let listed = w.store.lineage_grants(&file, T0).await.unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|g| g.grantee.id.as_str())
            .collect::<Vec<_>>(),
        [w.carol.as_str()]
    );
    // 取消停止继承:恢复
    w.store
        .set_inherit_break(&w.dir("secret"), false, &w.alice, T0)
        .await
        .unwrap();
    assert_eq!(w.role(&w.bob, &file).await, Some(Role::Manager));
    let listed = w.store.lineage_grants(&file, T0).await.unwrap();
    assert_eq!(listed.len(), 2);
    assert!(
        listed
            .iter()
            .find(|g| g.grantee.id == w.bob)
            .unwrap()
            .inherited
    );
    // 对这个文件来说,carol 的授权挂在它上面的文件夹上,同样是继承来的;查看文件夹本身时才是直接的
    assert!(
        listed
            .iter()
            .find(|g| g.grantee.id == w.carol)
            .unwrap()
            .inherited
    );
    let on_folder = w.store.lineage_grants(&w.dir("secret"), T0).await.unwrap();
    assert!(
        !on_folder
            .iter()
            .find(|g| g.grantee.id == w.carol)
            .unwrap()
            .inherited
    );
    assert!(
        on_folder
            .iter()
            .find(|g| g.grantee.id == w.bob)
            .unwrap()
            .inherited
    );
    assert!(
        w.store
            .set_inherit_break(&ResourceKey::space(&w.space_a).unwrap(), true, &w.alice, T0)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn sharing_three_folders_and_five_files_at_once_gives_the_other_person_eight_items() {
    let w = world().await;
    let mut keys: Vec<ResourceKey> = (1..=3).map(|n| w.dir(&format!("dir{n}"))).collect();
    keys.extend((1..=5).map(|n| w.file(&format!("loose/f{n}.md"))));
    let outcome = w
        .store
        .apply_grants(
            &keys,
            &[GrantChange {
                grantee_id: w.bob.clone(),
                role: Some(Role::Editor),
            }],
            &w.alice,
            T0,
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        (outcome.changed, outcome.unchanged, outcome.removed),
        (8, 0, 0)
    );
    let mine = w.store.shared_with(&w.bob, false, T0).await.unwrap();
    assert_eq!(mine.len(), 8);
    assert!(
        mine.iter()
            .all(|s| s.owner.id == w.alice && s.grant.role == Role::Editor)
    );
    // 在共享目录里新建的文档对方可见;只分享文件的不会
    assert_eq!(
        w.role(&w.bob, &w.file("dir2/new.md")).await,
        Some(Role::Editor)
    );
    assert_eq!(w.role(&w.bob, &w.file("loose/new.md")).await, None);
    // 再分享一次相同的:全部 unchanged;改成可查看:全部 changed
    let again = w
        .store
        .apply_grants(
            &keys,
            &[GrantChange {
                grantee_id: w.bob.clone(),
                role: Some(Role::Editor),
            }],
            &w.alice,
            T0,
            None,
        )
        .await
        .unwrap();
    assert_eq!((again.changed, again.unchanged), (0, 8));
    let lowered = w
        .store
        .apply_grants(
            &keys,
            &[GrantChange {
                grantee_id: w.bob.clone(),
                role: Some(Role::Viewer),
            }],
            &w.alice,
            T0,
            None,
        )
        .await
        .unwrap();
    assert_eq!(lowered.changed, 8);
    assert_eq!(
        w.role(&w.bob, &w.file("dir1/x.md")).await,
        Some(Role::Viewer),
        "降级立即生效"
    );
    // 批量移除
    let removed = w
        .store
        .apply_grants(
            &keys,
            &[GrantChange {
                grantee_id: w.bob.clone(),
                role: None,
            }],
            &w.alice,
            T0,
            None,
        )
        .await
        .unwrap();
    assert_eq!(removed.removed, 8);
    assert!(
        w.store
            .shared_with(&w.bob, false, T0)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn a_batch_is_all_or_nothing_and_bounded() {
    let w = world().await;
    let keys = vec![w.file("a.md"), w.file("b.md")];
    // 第二个人不存在:整批回滚,bob 也没拿到
    let err = w
        .store
        .apply_grants(
            &keys,
            &[
                GrantChange {
                    grantee_id: w.bob.clone(),
                    role: Some(Role::Viewer),
                },
                GrantChange {
                    grantee_id: "usr_ghost".into(),
                    role: Some(Role::Viewer),
                },
            ],
            &w.alice,
            T0,
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
    assert!(
        w.store
            .shared_with(&w.bob, false, T0)
            .await
            .unwrap()
            .is_empty(),
        "没有分享了一半"
    );
    // 把所有者自己放进去也是整批失败
    assert!(
        w.store
            .apply_grants(
                &keys,
                &[GrantChange {
                    grantee_id: w.alice.clone(),
                    role: Some(Role::Viewer)
                }],
                &w.alice,
                T0,
                None
            )
            .await
            .is_err()
    );
    // 上限
    let many: Vec<ResourceKey> = (0..=MAX_BATCH_KEYS)
        .map(|n| w.file(&format!("f{n}.md")))
        .collect();
    assert!(
        w.store
            .apply_grants(
                &many,
                &[GrantChange {
                    grantee_id: w.bob.clone(),
                    role: Some(Role::Viewer)
                }],
                &w.alice,
                T0,
                None
            )
            .await
            .is_err()
    );
    assert!(
        w.store
            .apply_grants(
                &[],
                &[GrantChange {
                    grantee_id: w.bob.clone(),
                    role: Some(Role::Viewer)
                }],
                &w.alice,
                T0,
                None
            )
            .await
            .is_err()
    );
    assert!(
        w.store
            .apply_grants(&keys, &[], &w.alice, T0, None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn the_shared_with_me_list_can_hide_entries_without_touching_access() {
    let w = world().await;
    let key = w.dir("docs");
    w.grant(&key, &w.bob, Role::Viewer).await;
    assert_eq!(
        w.store.shared_with(&w.bob, false, T0).await.unwrap().len(),
        1
    );
    w.store.set_share_hidden(&w.bob, &key, true).await.unwrap();
    assert!(
        w.store
            .shared_with(&w.bob, false, T0)
            .await
            .unwrap()
            .is_empty()
    );
    let all = w.store.shared_with(&w.bob, true, T0).await.unwrap();
    assert!(all[0].hidden);
    assert_eq!(
        w.role(&w.bob, &w.file("docs/a.md")).await,
        Some(Role::Viewer),
        "只是不显示,权限还在"
    );
    w.store.set_share_hidden(&w.bob, &key, false).await.unwrap();
    assert_eq!(
        w.store.shared_with(&w.bob, false, T0).await.unwrap().len(),
        1
    );
    // 没有授予我的资源不能往我的隐藏表里塞
    let err = w
        .store
        .set_share_hidden(&w.carol, &key, true)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
}

#[tokio::test]
async fn my_shares_groups_collaborators_by_resource() {
    let w = world().await;
    let docs = w.dir("docs");
    w.grant(&docs, &w.bob, Role::Editor).await;
    w.grant(&docs, &w.carol, Role::Viewer).await;
    w.grant(&w.file("solo.md"), &w.bob, Role::Viewer).await;
    w.store
        .set_inherit_break(&docs, true, &w.alice, T0)
        .await
        .unwrap();
    let mine = w.store.shared_by(&w.alice, T0).await.unwrap();
    assert_eq!(mine.len(), 2);
    let docs_row = mine
        .iter()
        .find(|row| row.resource_key == docs.to_string())
        .unwrap();
    assert_eq!(docs_row.grantees.len(), 2);
    assert!(docs_row.inherit_broken);
    // 别人的知识库里的分享不会出现在我的列表里
    assert!(w.store.shared_by(&w.bob, T0).await.unwrap().is_empty());
}

#[tokio::test]
async fn forgetting_a_folder_removes_its_subtree_but_not_a_similarly_named_sibling() {
    let w = world().await;
    for key in [
        w.dir("docs"),
        w.file("docs/a.md"),
        w.dir("docs/inner"),
        w.dir("docs2"),
        w.file("keep.md"),
    ] {
        w.grant(&key, &w.bob, Role::Viewer).await;
    }
    w.store
        .set_inherit_break(&w.dir("docs/inner"), true, &w.alice, T0)
        .await
        .unwrap();
    assert_eq!(w.store.forget_resource(&w.dir("docs")).await.unwrap(), 3);
    assert_eq!(w.role(&w.bob, &w.file("docs/a.md")).await, None);
    assert!(
        !w.store
            .is_inherit_broken(&w.dir("docs/inner"))
            .await
            .unwrap()
    );
    assert_eq!(
        w.role(&w.bob, &w.dir("docs2")).await,
        Some(Role::Viewer),
        "docs2 不是 docs 的子级"
    );
    assert_eq!(w.role(&w.bob, &w.file("keep.md")).await, Some(Role::Viewer));
}

#[tokio::test]
async fn forgetting_a_folder_clears_an_inherit_break_that_has_no_grant_of_its_own() {
    let w = world().await;
    // 只停止继承、不授权:旧实现只从 grants 收集候选键,这条断点会留在已经删掉的路径上。
    w.store
        .set_inherit_break(&w.file("docs/a.md"), true, &w.alice, T0)
        .await
        .unwrap();
    assert!(
        w.store
            .is_inherit_broken(&w.file("docs/a.md"))
            .await
            .unwrap()
    );
    assert_eq!(w.store.forget_resource(&w.dir("docs")).await.unwrap(), 0);
    assert!(
        !w.store
            .is_inherit_broken(&w.file("docs/a.md"))
            .await
            .unwrap(),
        "删除文件夹要把只停止继承、没有授权行的子项一起清掉"
    );
}

#[tokio::test]
async fn deleting_an_account_removes_the_grants_it_received_and_the_ones_in_its_space() {
    let w = world().await;
    w.grant(&w.dir("docs"), &w.bob, Role::Editor).await;
    // bob 也分享一个东西给 carol
    let bobs = ResourceKey::file(&w.space_b, "mine", "n.md").unwrap();
    w.store
        .set_grant(&bobs, &w.carol, Role::Viewer, "direct", &w.bob, T0, None)
        .await
        .unwrap();
    w.store
        .set_inherit_break(&w.dir("docs"), true, &w.alice, T0)
        .await
        .unwrap();
    // 注销 alice:她的知识库里的授权、停止继承全部消失;bob 手里的(别人的知识库里的)不受影响
    w.store.request_deletion(&w.alice, T0, 10).await.unwrap();
    w.store.purge_user(&w.alice, T0 + 100).await.unwrap();
    assert!(
        w.store
            .shared_with(&w.bob, true, T0 + 100)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(!w.store.is_inherit_broken(&w.dir("docs")).await.unwrap());
    assert_eq!(
        w.store
            .shared_with(&w.carol, true, T0 + 100)
            .await
            .unwrap()
            .len(),
        1,
        "bob 分享给 carol 的还在"
    );
    // 注销 bob:他收到的、他分享出去的都清掉
    w.store.request_deletion(&w.bob, T0, 10).await.unwrap();
    w.store.purge_user(&w.bob, T0 + 100).await.unwrap();
    assert!(
        w.store
            .shared_with(&w.carol, true, T0 + 100)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn the_owner_is_owner_everywhere_in_their_space_and_admins_get_nothing_for_free() {
    let w = world().await;
    let file = w.file("a.md");
    assert_eq!(
        w.store.role_of(&w.alice, &file, T0).await.unwrap(),
        Some(Role::Owner)
    );
    assert_eq!(
        w.store.role_of(&w.alice, &w.col(), T0).await.unwrap(),
        Some(Role::Owner)
    );
    // 管理员 boss 不是 alice 知识库的主人,也没有授权:什么都没有
    let boss = w
        .store
        .find_user_by_login("boss")
        .await
        .unwrap()
        .unwrap()
        .id;
    assert_eq!(w.store.role_of(&boss, &file, T0).await.unwrap(), None);
    // 别人的知识库里 alice 同样什么都没有
    let bobs = ResourceKey::file(&w.space_b, "proj", "a.md").unwrap();
    assert_eq!(w.store.role_of(&w.alice, &bobs, T0).await.unwrap(), None);
    assert_eq!(
        w.store.role_of(&w.bob, &bobs, T0).await.unwrap(),
        Some(Role::Owner)
    );
}

#[tokio::test]
async fn requiring_a_role_hides_existence_from_strangers_and_names_the_shortfall_for_collaborators()
{
    use kb_core::share::Action;
    let w = world().await;
    let file = w.file("a.md");
    w.grant(&file, &w.bob, Role::Commenter).await;
    // 陌生人:404,不透露这个资源存在
    let err = w
        .store
        .require_role(&w.carol, &file, Action::View, T0)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
    // 协作者权限不够:403 并说明自己是什么权限
    let err = w
        .store
        .require_role(&w.bob, &file, Action::Edit, T0)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::Forbidden(_)), "{err:?}");
    assert!(err.to_string().contains("可评论"), "{err}");
    assert_eq!(
        w.store
            .require_role(&w.bob, &file, Action::Comment, T0)
            .await
            .unwrap(),
        Role::Commenter
    );
    assert_eq!(
        w.store
            .require_role(&w.alice, &file, Action::TransferOwner, T0)
            .await
            .unwrap(),
        Role::Owner
    );
    // 降级立即生效(没有缓存可以过期)
    w.grant(&file, &w.bob, Role::Viewer).await;
    assert!(
        w.store
            .require_role(&w.bob, &file, Action::Comment, T0)
            .await
            .is_err()
    );
    w.store.remove_grant(&file, &w.bob).await.unwrap();
    let err = w
        .store
        .require_role(&w.bob, &file, Action::View, T0)
        .await
        .unwrap_err();
    assert!(
        matches!(err, KbError::NotFound(_)),
        "移除后和陌生人一样:{err:?}"
    );
}

// ---------------------------------------------------------------- 访问申请

use kb_core::share::RequestState;

use super::grants::{ACCESS_REQUEST_COOLDOWN_MS, MAX_PENDING_ACCESS_REQUESTS};

#[tokio::test]
async fn asking_for_access_follows_every_rule() {
    let w = world().await;
    let key = w.file("secret.md");
    let asked = w
        .store
        .create_access_request(&key, &w.bob, Role::Editor, Some(" 想看看 "), T0)
        .await
        .unwrap()
        .expect("创建了申请");
    assert_eq!(
        (asked.state, asked.role, asked.message.as_deref()),
        (RequestState::Pending, Role::Editor, Some("想看看"))
    );
    // 24 小时内同一资源只能申请一次;过了冷却才能再来
    let err = w
        .store
        .create_access_request(&key, &w.bob, Role::Viewer, None, T0 + 1)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::Forbidden(_)), "{err:?}");
    assert!(
        w.store
            .create_access_request(
                &key,
                &w.bob,
                Role::Viewer,
                None,
                T0 + ACCESS_REQUEST_COOLDOWN_MS
            )
            .await
            .unwrap()
            .is_some()
    );
    // 只能申请查看 / 评论 / 编辑
    for bad in [Role::Manager, Role::Owner] {
        assert!(
            w.store
                .create_access_request(&w.file("x.md"), &w.carol, bad, None, T0)
                .await
                .is_err(),
            "{bad:?}"
        );
    }
    // 附言限制
    assert!(
        w.store
            .create_access_request(
                &w.file("y.md"),
                &w.carol,
                Role::Viewer,
                Some(&"字".repeat(201)),
                T0
            )
            .await
            .is_err()
    );
    assert!(
        w.store
            .create_access_request(&w.file("y.md"), &w.carol, Role::Viewer, Some("a\nb"), T0)
            .await
            .is_err()
    );
    // 知识库不存在
    let ghost = ResourceKey::file("sp_ghost", "proj", "a.md").unwrap();
    let err = w
        .store
        .create_access_request(&ghost, &w.carol, Role::Viewer, None, T0)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
    // 已经有足够的权限(或本来就是所有者):不用申请
    w.grant(&w.file("have.md"), &w.carol, Role::Editor).await;
    let err = w
        .store
        .create_access_request(&w.file("have.md"), &w.carol, Role::Viewer, None, T0)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::InvalidInput(_)), "{err:?}");
    assert!(
        w.store
            .create_access_request(&w.file("have.md"), &w.alice, Role::Viewer, None, T0)
            .await
            .is_err()
    );
    // 但可以申请比现有更高的
    assert!(
        w.store
            .create_access_request(&w.file("have.md"), &w.bob, Role::Editor, None, T0)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        w.store
            .create_access_request(&w.file("viewer.md"), &w.carol, Role::Editor, None, T0)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn an_owner_who_blocked_the_asker_sees_nothing_and_the_asker_learns_nothing() {
    let w = world().await;
    w.store.block_user(&w.alice, &w.bob, T0).await.unwrap();
    let outcome = w
        .store
        .create_access_request(&w.file("a.md"), &w.bob, Role::Viewer, None, T0)
        .await
        .unwrap();
    assert!(outcome.is_none(), "表面成功,什么都没创建");
    assert!(
        w.store
            .pending_access_requests_in(std::slice::from_ref(&w.space_a))
            .await
            .unwrap()
            .is_empty()
    );
    assert!(w.store.my_access_requests(&w.bob).await.unwrap().is_empty());
}

#[tokio::test]
async fn the_pending_cap_stops_request_spam() {
    let w = world().await;
    for n in 0..MAX_PENDING_ACCESS_REQUESTS {
        w.store
            .create_access_request(&w.file(&format!("f{n}.md")), &w.bob, Role::Viewer, None, T0)
            .await
            .unwrap();
    }
    let err = w
        .store
        .create_access_request(&w.file("one-more.md"), &w.bob, Role::Viewer, None, T0)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::Forbidden(_)), "{err:?}");
    // 别人不受影响
    assert!(
        w.store
            .create_access_request(&w.file("one-more.md"), &w.carol, Role::Viewer, None, T0)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn approving_writes_the_grant_with_the_chosen_role_and_rejecting_writes_nothing() {
    let w = world().await;
    let a = w
        .store
        .create_access_request(&w.dir("docs"), &w.bob, Role::Editor, None, T0)
        .await
        .unwrap()
        .unwrap();
    let b = w
        .store
        .create_access_request(&w.file("x.md"), &w.carol, Role::Viewer, None, T0)
        .await
        .unwrap()
        .unwrap();
    // 通过时可以改成别的角色:申请编辑,只给查看
    let done = w
        .store
        .decide_access_request(&a.id, &w.alice, true, Some(Role::Viewer), T0 + 5)
        .await
        .unwrap();
    assert_eq!(
        (done.state, done.role, done.decided_by.as_deref()),
        (RequestState::Approved, Role::Viewer, Some(w.alice.as_str()))
    );
    assert_eq!(
        w.role(&w.bob, &w.file("docs/new.md")).await,
        Some(Role::Viewer),
        "授权在文件夹上,里面的文件继承"
    );
    let grants = w.store.direct_grants(&w.dir("docs"), T0).await.unwrap();
    assert_eq!(grants[0].grant.via, format!("request:{}", a.id));
    // 拒绝:没有授权
    let done = w
        .store
        .decide_access_request(&b.id, &w.alice, false, None, T0 + 5)
        .await
        .unwrap();
    assert_eq!(done.state, RequestState::Rejected);
    assert_eq!(w.role(&w.carol, &w.file("x.md")).await, None);
    // 处理过的不能再处理
    let err = w
        .store
        .decide_access_request(&a.id, &w.alice, false, None, T0 + 6)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
    assert_eq!(
        w.role(&w.bob, &w.file("docs/new.md")).await,
        Some(Role::Viewer),
        "第二次处理没有改动已通过的授权"
    );
    assert!(
        w.store
            .pending_access_requests_in(std::slice::from_ref(&w.space_a))
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        w.store.my_access_requests(&w.bob).await.unwrap()[0].state,
        RequestState::Approved
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_managers_deciding_at_once_leave_exactly_one_outcome() {
    let w = world().await;
    let request = w
        .store
        .create_access_request(&w.file("race.md"), &w.bob, Role::Editor, None, T0)
        .await
        .unwrap()
        .unwrap();
    let race_key = w.file("race.md");
    let bob = w.bob.clone();
    let store = std::sync::Arc::new(w.store);
    let (s1, s2) = (store.clone(), store.clone());
    let (id1, id2, a1, a2) = (
        request.id.clone(),
        request.id.clone(),
        w.alice.clone(),
        w.alice.clone(),
    );
    let approve = tokio::spawn(async move {
        s1.decide_access_request(&id1, &a1, true, None, T0 + 1)
            .await
    });
    let reject = tokio::spawn(async move {
        s2.decide_access_request(&id2, &a2, false, None, T0 + 1)
            .await
    });
    let (approve, reject) = (approve.await.unwrap(), reject.await.unwrap());
    assert_eq!(approve.is_ok() as u8 + reject.is_ok() as u8, 1);
    let granted = store
        .granted_role(&bob, &race_key, T0 + 2)
        .await
        .unwrap()
        .is_some();
    assert_eq!(granted, approve.is_ok(), "有没有授权和谁赢了一致");
}

#[tokio::test]
async fn approval_fails_cleanly_if_the_asker_is_gone_and_leaves_the_request_pending() {
    let w = world().await;
    let request = w
        .store
        .create_access_request(&w.file("a.md"), &w.carol, Role::Viewer, None, T0)
        .await
        .unwrap()
        .unwrap();
    w.store
        .update_user(
            &w.carol,
            UserUpdate {
                status: Some(UserStatus::Disabled),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        w.store
            .decide_access_request(&request.id, &w.alice, true, None, T0 + 1)
            .await
            .is_err()
    );
    assert_eq!(
        w.store
            .get_access_request(&request.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        RequestState::Pending,
        "事务回滚,申请还在"
    );
}

// :文件 / 文件夹移动后,授权、停止继承、隐藏共享与分享链接都要跟着改键,
// 且只能按段边界改——`docs` 不能碰到 `docs2`。
#[tokio::test]
async fn rekey_resource_moves_grants_and_links_but_not_sibling_prefixes() {
    let w = world().await;
    let old = w.file("docs/a.md");
    let new = w.file("archive/a.md");
    let sibling = w.file("docs2/a.md");
    w.grant(&old, &w.bob, Role::Viewer).await;
    w.grant(&sibling, &w.bob, Role::Editor).await;
    w.store.set_share_hidden(&w.bob, &old, true).await.unwrap();
    let (_, token) = w
        .store
        .create_link(
            crate::system::NewLink {
                resource: Some(old.clone()),
                items: vec![],
                title: None,
                audience: Audience::Anyone,
                role: Role::Viewer,
                password_hash: None,
                expires_at: None,
                allow_download: true,
                watermark: false,
                allow_reshare: false,
                created_by: w.alice.clone(),
            },
            0,
            T0,
        )
        .await
        .unwrap();

    let changed = w.store.rekey_resource(&old, &new).await.unwrap();
    assert_eq!(changed, 3, "授权 + 隐藏共享 + 分享链接各一条");

    assert_eq!(w.role(&w.bob, &old).await, None);
    assert_eq!(w.role(&w.bob, &new).await, Some(Role::Viewer));
    assert_eq!(
        w.role(&w.bob, &sibling).await,
        Some(Role::Editor),
        "docs2 不能被 docs 的前缀改到"
    );
    assert!(w.store.links_for_resource(&old).await.unwrap().is_empty());
    assert_eq!(w.store.links_for_resource(&new).await.unwrap().len(), 1);
    assert!(w.store.find_link_by_token(&token).await.unwrap().is_some());
    // 隐藏状态跟着资源走,否则移动后会重新冒到「共享给我」顶部
    let hidden = w
        .store
        .shared_with(&w.bob, true, T0)
        .await
        .unwrap()
        .into_iter()
        .find(|root| root.grant.resource_key == new.to_string())
        .expect("新键下仍有共享");
    assert!(hidden.hidden);
}

#[tokio::test]
async fn rekey_resource_does_not_touch_the_same_path_in_another_space() {
    let w = world().await;
    let old_dir = w.dir("docs");
    let new_dir = w.dir("archive");
    w.grant(&old_dir, &w.bob, Role::Viewer).await;
    // 另一个知识库里同名集合 / 同名路径:分享链接是全局表,不能跟着 A 的移动一起改。
    let other_file = ResourceKey::file(&w.space_b, "proj", "docs/a.md").unwrap();
    w.grant(&other_file, &w.carol, Role::Editor).await;
    let (_, token) = w
        .store
        .create_link(
            crate::system::NewLink {
                resource: Some(other_file.clone()),
                items: vec![],
                title: None,
                audience: Audience::Anyone,
                role: Role::Viewer,
                password_hash: None,
                expires_at: None,
                allow_download: true,
                watermark: false,
                allow_reshare: false,
                created_by: w.bob.clone(),
            },
            0,
            T0,
        )
        .await
        .unwrap();

    w.store.rekey_resource(&old_dir, &new_dir).await.unwrap();

    assert_eq!(w.role(&w.bob, &new_dir).await, Some(Role::Viewer));
    assert_eq!(w.role(&w.carol, &other_file).await, Some(Role::Editor));
    assert_eq!(
        w.store.links_for_resource(&other_file).await.unwrap().len(),
        1
    );
    assert_eq!(
        w.store
            .find_link_by_token(&token)
            .await
            .unwrap()
            .unwrap()
            .link
            .resource_key
            .as_deref(),
        Some(other_file.to_string().as_str())
    );
    assert!(
        w.store
            .links_for_resource(&w.file("archive/a.md"))
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn rekey_resource_moves_rows_that_have_no_grant_of_their_own() {
    let w = world().await;
    let old_dir = w.dir("docs");
    let new_dir = w.dir("archive");
    let inside = w.file("docs/sub/a.md");
    // 只停止继承、只挂分享链接,都不写 grants。旧实现只从 grants 收集键,这两条会被留在旧路径。
    w.store
        .set_inherit_break(&inside, true, &w.alice, T0)
        .await
        .unwrap();
    let (_, token) = w
        .store
        .create_link(
            crate::system::NewLink {
                resource: Some(inside.clone()),
                items: vec![],
                title: None,
                audience: Audience::Anyone,
                role: Role::Viewer,
                password_hash: None,
                expires_at: None,
                allow_download: true,
                watermark: false,
                allow_reshare: false,
                created_by: w.alice.clone(),
            },
            0,
            T0,
        )
        .await
        .unwrap();

    let changed = w.store.rekey_resource(&old_dir, &new_dir).await.unwrap();

    assert_eq!(changed, 2, "停止继承 + 分享链接各一条");
    assert!(
        w.store
            .is_inherit_broken(&w.file("archive/sub/a.md"))
            .await
            .unwrap()
    );
    assert!(!w.store.is_inherit_broken(&inside).await.unwrap());
    assert_eq!(
        w.store
            .find_link_by_token(&token)
            .await
            .unwrap()
            .unwrap()
            .link
            .resource_key
            .as_deref(),
        Some(w.file("archive/sub/a.md").to_string().as_str())
    );
}

#[tokio::test]
async fn rekey_resource_moves_a_whole_folder_within_its_boundary() {
    let w = world().await;
    let old_dir = w.dir("docs");
    let new_dir = w.dir("archive");
    let inside = w.file("docs/sub/a.md");
    let sibling = w.file("docs2/a.md");
    w.grant(&old_dir, &w.bob, Role::Viewer).await;
    w.grant(&inside, &w.carol, Role::Viewer).await;
    w.grant(&sibling, &w.carol, Role::Editor).await;
    w.store
        .set_inherit_break(&inside, true, &w.alice, T0)
        .await
        .unwrap();

    w.store.rekey_resource(&old_dir, &new_dir).await.unwrap();

    assert_eq!(w.role(&w.bob, &new_dir).await, Some(Role::Viewer));
    assert_eq!(
        w.role(&w.carol, &w.file("archive/sub/a.md")).await,
        Some(Role::Viewer)
    );
    assert!(
        w.store
            .is_inherit_broken(&w.file("archive/sub/a.md"))
            .await
            .unwrap()
    );
    assert_eq!(w.role(&w.carol, &sibling).await, Some(Role::Editor));
}
