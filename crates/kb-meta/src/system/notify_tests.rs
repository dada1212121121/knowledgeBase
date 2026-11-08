//! 站内通知与通知邮件队列的测试。

use std::collections::HashMap;

use kb_core::KbError;
use kb_core::account::{NewUser, ROLE_ADMIN, ROLE_USER, UserStatus};
use kb_core::social::{NOTIFICATION_KEEP_MS, kind};
use serde_json::json;

use super::SystemStore;

const T0: i64 = 1_800_000_000_000;
const GAP: i64 = 10 * 60_000;

fn open() -> (tempfile::TempDir, SystemStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = SystemStore::open(dir.path().join("system.db")).unwrap();
    (dir, store)
}

async fn people(store: &SystemStore, names: &[&str]) -> Vec<String> {
    let user = |name: &str, role: &str| NewUser {
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
    store
        .create_user(user("root_admin", ROLE_ADMIN))
        .await
        .unwrap();
    let mut ids = Vec::new();
    for name in names {
        ids.push(store.create_user(user(name, ROLE_USER)).await.unwrap().0.id);
    }
    ids
}

#[tokio::test]
async fn notifications_are_listed_newest_first_with_paging_and_unread_counts() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice"]).await;
    let mut made = Vec::new();
    for n in 0..5 {
        made.push(
            store
                .add_notification(&ids[0], kind::FRIEND_REQUEST, &json!({ "n": n }), T0 + n)
                .await
                .unwrap(),
        );
    }
    assert_eq!(store.unread_notifications(&ids[0]).await.unwrap(), 5);
    let page = store
        .list_notifications(&ids[0], false, None, 2)
        .await
        .unwrap();
    assert_eq!(
        page.iter()
            .map(|n| n.data["n"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        [4, 3]
    );
    let next = store
        .list_notifications(&ids[0], false, Some(page[1].id), 10)
        .await
        .unwrap();
    assert_eq!(
        next.iter()
            .map(|n| n.data["n"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        [2, 1, 0]
    );
    // 标已读:只剩未读的出现在 unread_only 里
    assert_eq!(
        store
            .mark_notifications_read(&ids[0], &made[..2], T0 + 100)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        store
            .mark_notifications_read(&ids[0], &made[..2], T0 + 101)
            .await
            .unwrap(),
        0,
        "已读的不重复算"
    );
    assert_eq!(store.unread_notifications(&ids[0]).await.unwrap(), 3);
    let unread = store
        .list_notifications(&ids[0], true, None, 10)
        .await
        .unwrap();
    assert_eq!(unread.len(), 3);
    assert!(unread.iter().all(|n| n.read_at.is_none()));
    assert_eq!(
        store
            .mark_all_notifications_read(&ids[0], T0 + 200)
            .await
            .unwrap(),
        3
    );
    assert_eq!(store.unread_notifications(&ids[0]).await.unwrap(), 0);
    // 单页上限
    assert!(
        store
            .list_notifications(&ids[0], false, None, 10_000)
            .await
            .unwrap()
            .len()
            <= 100
    );
}

#[tokio::test]
async fn nobody_can_read_or_mark_someone_elses_notifications() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob"]).await;
    let secret = store
        .add_notification(
            &ids[0],
            kind::SHARE_RECEIVED,
            &json!({ "title": "alice 的秘密" }),
            T0,
        )
        .await
        .unwrap();
    assert!(
        store
            .list_notifications(&ids[1], false, None, 50)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.unread_notifications(&ids[1]).await.unwrap(), 0);
    assert_eq!(
        store
            .mark_notifications_read(&ids[1], &[secret], T0)
            .await
            .unwrap(),
        0,
        "bob 拿着 alice 的通知 id 也改不动"
    );
    assert_eq!(
        store
            .mark_all_notifications_read(&ids[1], T0)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        store.unread_notifications(&ids[0]).await.unwrap(),
        1,
        "alice 的仍是未读"
    );
}

#[tokio::test]
async fn invalid_notifications_are_rejected() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice"]).await;
    let err = store
        .add_notification(&ids[0], "made_up", &json!({}), T0)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::InvalidInput(_)), "{err:?}");
    for bad in [json!([1]), json!("x"), json!(null)] {
        assert!(
            store
                .add_notification(&ids[0], kind::MENTION, &bad, T0)
                .await
                .is_err(),
            "{bad}"
        );
    }
    let big = json!({ "k": "x".repeat(5_000) });
    assert!(
        store
            .add_notification(&ids[0], kind::MENTION, &big, T0)
            .await
            .is_err()
    );
    let err = store
        .add_notification("usr_ghost", kind::MENTION, &json!({}), T0)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
    assert_eq!(
        store.unread_notifications(&ids[0]).await.unwrap(),
        0,
        "被拒的什么都没写"
    );
}

#[tokio::test]
async fn old_notifications_are_purged_after_ninety_days() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice"]).await;
    store
        .add_notification(&ids[0], kind::ANNOUNCEMENT, &json!({ "t": "old" }), T0)
        .await
        .unwrap();
    store
        .add_notification(
            &ids[0],
            kind::ANNOUNCEMENT,
            &json!({ "t": "new" }),
            T0 + NOTIFICATION_KEEP_MS,
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .purge_old_notifications(T0 + NOTIFICATION_KEEP_MS + 1)
            .await
            .unwrap(),
        1
    );
    let left = store
        .list_notifications(&ids[0], false, None, 10)
        .await
        .unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].data["t"], "new");
}

#[tokio::test]
async fn email_preferences_default_by_kind_and_unknown_kinds_reject_the_whole_change() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice"]).await;
    let defaults = store.notify_email_prefs(&ids[0]).await.unwrap();
    assert_eq!(defaults.len(), kind::ALL.len());
    assert!(defaults[kind::FRIEND_REQUEST] && defaults[kind::ACCESS_REQUEST]);
    assert!(!defaults[kind::COMMENT_REPLY] && !defaults[kind::LINK_EXPIRING]);
    let change = HashMap::from([
        (kind::FRIEND_REQUEST.to_owned(), false),
        (kind::COMMENT_REPLY.to_owned(), true),
    ]);
    store
        .set_notify_email_prefs(&ids[0], &change)
        .await
        .unwrap();
    let after = store.notify_email_prefs(&ids[0]).await.unwrap();
    assert!(!after[kind::FRIEND_REQUEST] && after[kind::COMMENT_REPLY]);
    assert!(after[kind::ACCESS_REQUEST], "没动的保持默认");
    // 带一个不认识的种类:整个请求都不生效
    let mixed = HashMap::from([
        (kind::MENTION.to_owned(), false),
        ("bogus".to_owned(), true),
    ]);
    assert!(store.set_notify_email_prefs(&ids[0], &mixed).await.is_err());
    assert!(
        store.notify_email_prefs(&ids[0]).await.unwrap()[kind::MENTION],
        "没有部分生效"
    );
}

#[tokio::test]
async fn queued_mail_is_merged_per_person_and_limited_to_one_per_ten_minutes() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob"]).await;
    let mut alice_notes = Vec::new();
    for n in 0..3 {
        let id = store
            .add_notification(&ids[0], kind::FRIEND_REQUEST, &json!({ "n": n }), T0 + n)
            .await
            .unwrap();
        store
            .queue_notification_mail(&ids[0], id, T0 + n)
            .await
            .unwrap();
        alice_notes.push(id);
    }
    let bob_note = store
        .add_notification(&ids[1], kind::MENTION, &json!({}), T0)
        .await
        .unwrap();
    store
        .queue_notification_mail(&ids[1], bob_note, T0)
        .await
        .unwrap();

    let due = store
        .due_notification_digests(T0 + 5, GAP, 10)
        .await
        .unwrap();
    assert_eq!(due.len(), 2, "每个人一封,不是每条通知一封");
    let alice = due.iter().find(|d| d.user_id == ids[0]).unwrap();
    assert_eq!(alice.items.len(), 3);
    assert_eq!(alice.queue_ids.len(), 3);
    // 限制一次处理的人数
    assert_eq!(
        store
            .due_notification_digests(T0 + 5, GAP, 1)
            .await
            .unwrap()
            .len(),
        1
    );

    // 发出去之后:同一个人的新通知要等满 10 分钟才发下一封
    store
        .finish_notification_digest(&ids[0], &alice.queue_ids, true, T0 + 10)
        .await
        .unwrap();
    let more = store
        .add_notification(&ids[0], kind::FRIEND_REQUEST, &json!({ "n": 9 }), T0 + 20)
        .await
        .unwrap();
    store
        .queue_notification_mail(&ids[0], more, T0 + 20)
        .await
        .unwrap();
    let due_now = store
        .due_notification_digests(T0 + 30, GAP, 10)
        .await
        .unwrap();
    assert!(
        due_now.iter().all(|d| d.user_id != ids[0]),
        "10 分钟内不再发"
    );
    assert!(due_now.iter().any(|d| d.user_id == ids[1]), "别人不受影响");
    let later = store
        .due_notification_digests(T0 + 10 + GAP, GAP, 10)
        .await
        .unwrap();
    let again = later
        .iter()
        .find(|d| d.user_id == ids[0])
        .expect("满 10 分钟后又可以发");
    assert_eq!(again.items.len(), 1, "只剩新的那条");
}

#[tokio::test]
async fn notifications_already_read_in_the_browser_are_not_emailed_and_unsent_digests_keep_no_cooldown()
 {
    let (_dir, store) = open();
    let ids = people(&store, &["alice"]).await;
    let seen = store
        .add_notification(&ids[0], kind::FRIEND_REQUEST, &json!({}), T0)
        .await
        .unwrap();
    let unseen = store
        .add_notification(&ids[0], kind::FRIEND_REQUEST, &json!({}), T0 + 1)
        .await
        .unwrap();
    for id in [seen, unseen] {
        store
            .queue_notification_mail(&ids[0], id, T0)
            .await
            .unwrap();
    }
    store
        .mark_notifications_read(&ids[0], &[seen], T0 + 2)
        .await
        .unwrap();
    let due = store
        .due_notification_digests(T0 + 3, GAP, 10)
        .await
        .unwrap();
    assert_eq!(due[0].items.len(), 1, "人已经在网页上看过的那条不再发邮件");
    assert_eq!(due[0].items[0].id, unseen);
    // 没发出去(例如邮箱没验证 / 发信失败):清掉队列但不记发送时间,以后的新通知立刻可发
    store
        .finish_notification_digest(&ids[0], &due[0].queue_ids, false, T0 + 3)
        .await
        .unwrap();
    let fresh = store
        .add_notification(&ids[0], kind::FRIEND_REQUEST, &json!({}), T0 + 4)
        .await
        .unwrap();
    store
        .queue_notification_mail(&ids[0], fresh, T0 + 4)
        .await
        .unwrap();
    assert_eq!(
        store
            .due_notification_digests(T0 + 5, GAP, 10)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn a_digest_for_a_deleted_notification_does_not_stall_the_queue() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice"]).await;
    let id = store
        .add_notification(&ids[0], kind::MENTION, &json!({}), T0)
        .await
        .unwrap();
    store
        .queue_notification_mail(&ids[0], id, T0)
        .await
        .unwrap();
    // 通知被 90 天清理删掉了,队列项还在:digest 里没有可发的内容,但队列项要能被清掉
    store
        .purge_old_notifications(T0 + NOTIFICATION_KEEP_MS + 1)
        .await
        .unwrap();
    let due = store
        .due_notification_digests(T0 + NOTIFICATION_KEEP_MS + 2, GAP, 10)
        .await
        .unwrap();
    if let Some(digest) = due.first() {
        assert!(digest.items.is_empty());
        store
            .finish_notification_digest(&ids[0], &digest.queue_ids, false, T0)
            .await
            .unwrap();
    }
    assert!(
        store
            .due_notification_digests(T0 + NOTIFICATION_KEEP_MS + 3, GAP, 10)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn purging_a_user_removes_notifications_prefs_and_queue() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice"]).await;
    let id = store
        .add_notification(&ids[0], kind::MENTION, &json!({}), T0)
        .await
        .unwrap();
    store
        .queue_notification_mail(&ids[0], id, T0)
        .await
        .unwrap();
    store
        .set_notify_email_prefs(&ids[0], &HashMap::from([(kind::MENTION.to_owned(), false)]))
        .await
        .unwrap();
    store.request_deletion(&ids[0], T0, 10).await.unwrap();
    store.purge_user(&ids[0], T0 + 100).await.unwrap();
    assert!(
        store
            .list_notifications(&ids[0], false, None, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .due_notification_digests(T0 + 200, GAP, 10)
            .await
            .unwrap()
            .is_empty()
    );
}
