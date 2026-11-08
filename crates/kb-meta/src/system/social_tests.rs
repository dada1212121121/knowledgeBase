//! 好友规则的测试。每条规则单独一个用例,并发场景用真正并行的两个请求。

use std::sync::Arc;

use kb_core::KbError;
use kb_core::account::{NewUser, ROLE_ADMIN, ROLE_USER, UserStatus};
use kb_core::social::{
    Privacy, REJECT_COOLDOWN_MS, REQUEST_TTL_MS, Relation, RequestState, ShareFrom,
};

use super::{Caps, Decision, RequestOutcome, SystemStore, UserUpdate};

const T0: i64 = 1_800_000_000_000;
const NO_CAP: Caps = Caps { me: 0, other: 0 };

fn open() -> (tempfile::TempDir, Arc<SystemStore>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(SystemStore::open(dir.path().join("system.db")).unwrap());
    (dir, store)
}

fn new_user(name: &str, role: &str) -> NewUser {
    NewUser {
        username: name.to_owned(),
        email: Some(format!("{name}@example.com")),
        display_name: Some(format!("{name}的昵称")),
        password_hash: "x".to_owned(),
        role_id: role.to_owned(),
        status: UserStatus::Active,
        registered_via: "test".to_owned(),
        must_change_password: false,
        email_verified: true,
    }
}

/// 建一批普通用户(第一个用户会成为主知识库的拥有者,所以先建一个管理员垫底)。
async fn people(store: &SystemStore, names: &[&str]) -> Vec<String> {
    store
        .create_user(new_user("root_admin", ROLE_ADMIN))
        .await
        .unwrap();
    let mut ids = Vec::new();
    for name in names {
        ids.push(
            store
                .create_user(new_user(name, ROLE_USER))
                .await
                .unwrap()
                .0
                .id,
        );
    }
    ids
}

fn created(outcome: RequestOutcome) -> kb_core::social::FriendRequest {
    match outcome {
        RequestOutcome::Created(request) => request,
        other => panic!("应该新建申请,实际 {other:?}"),
    }
}

#[tokio::test]
async fn search_needs_the_complete_username_and_respects_privacy() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob"]).await;
    let found = store.find_for_friending(&ids[0], "bob", T0).await.unwrap();
    let (profile, relation) = found.expect("完整用户名能找到");
    assert_eq!(
        (profile.id.as_str(), relation),
        (ids[1].as_str(), Relation::None)
    );
    assert_eq!(profile.display_name, "bob的昵称");
    // 大小写和首尾空格不影响;片段不行(不做模糊搜索,防止把用户列表扫出来)
    assert!(
        store
            .find_for_friending(&ids[0], "  BOB ", T0)
            .await
            .unwrap()
            .is_some()
    );
    for partial in ["bo", "ob", "b", "bob_", "%", "*"] {
        assert!(
            store
                .find_for_friending(&ids[0], partial, T0)
                .await
                .unwrap()
                .is_none(),
            "{partial}"
        );
    }
    // 邮箱默认搜不到;对方打开后才行
    assert!(
        store
            .find_for_friending(&ids[0], "bob@example.com", T0)
            .await
            .unwrap()
            .is_none()
    );
    store
        .set_privacy(
            &ids[1],
            Privacy {
                searchable_by_email: true,
                ..Privacy::default()
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .find_for_friending(&ids[0], "bob@example.com", T0)
            .await
            .unwrap()
            .is_some()
    );
    // 关掉「用户名可搜」之后用户名搜不到
    store
        .set_privacy(
            &ids[1],
            Privacy {
                searchable_by_username: false,
                ..Privacy::default()
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .find_for_friending(&ids[0], "bob", T0)
            .await
            .unwrap()
            .is_none()
    );
    // 不能搜到自己
    assert!(
        store
            .find_for_friending(&ids[0], "alice", T0)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn not_found_unsearchable_blocked_disabled_and_unverified_look_exactly_the_same() {
    let (_dir, store) = open();
    let ids = people(
        &store,
        &["alice", "ghosty", "hidden", "blocker", "gone", "fresh"],
    )
    .await;
    store
        .set_privacy(
            &ids[2],
            Privacy {
                searchable_by_username: false,
                ..Privacy::default()
            },
        )
        .await
        .unwrap();
    store.block_user(&ids[3], &ids[0], T0).await.unwrap();
    store
        .update_user(
            &ids[4],
            UserUpdate {
                status: Some(UserStatus::Disabled),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    // 不存在的、不允许被搜的、把我拉黑的、被停用的、格式不合法的:答案完全一样(都是「没有」)
    for query in [
        "no_such_user",
        "hidden",
        "blocker",
        "gone",
        "x",
        "ghosty@@",
        "",
    ] {
        assert!(
            store
                .find_for_friending(&ids[0], query, T0)
                .await
                .unwrap()
                .is_none(),
            "{query:?} 不能被区分于「不存在」"
        );
    }
    // 对照:没被拦的正常能搜到,说明上面的 None 是规则造成的,不是搜索坏了
    assert!(
        store
            .find_for_friending(&ids[0], "ghosty", T0)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        store
            .find_for_friending(&ids[0], "fresh", T0)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn search_reports_how_i_am_related_to_the_person() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob", "carol", "dave"]).await;
    let rel = |who: usize, query: &'static str| {
        let (store, ids) = (store.clone(), ids.clone());
        async move {
            store
                .find_for_friending(&ids[who], query, T0)
                .await
                .unwrap()
                .unwrap()
                .1
        }
    };
    created(
        store
            .send_friend_request(&ids[0], &ids[1], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    assert_eq!(rel(0, "bob").await, Relation::PendingOut);
    assert_eq!(rel(1, "alice").await, Relation::PendingIn);
    let request = store
        .incoming_friend_requests(&ids[1], T0)
        .await
        .unwrap()
        .remove(0)
        .0;
    store
        .decide_friend_request(&request.id, &ids[1], Decision::Accept, NO_CAP, T0)
        .await
        .unwrap();
    assert_eq!(rel(0, "bob").await, Relation::Friend);
    assert_eq!(rel(0, "carol").await, Relation::None);
}

#[tokio::test]
async fn sending_requests_follows_every_rule() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob", "carol"]).await;
    let (a, b, c) = (&ids[0], &ids[1], &ids[2]);
    let err = store
        .send_friend_request(a, a, None, NO_CAP, T0)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::InvalidInput(_)), "{err:?}");
    let err = store
        .send_friend_request(a, "usr_ghost", None, NO_CAP, T0)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
    // 附言长度与控制字符
    let long = "字".repeat(101);
    assert!(
        store
            .send_friend_request(a, b, Some(&long), NO_CAP, T0)
            .await
            .is_err()
    );
    assert!(
        store
            .send_friend_request(a, b, Some("你好\n我是…"), NO_CAP, T0)
            .await
            .is_err()
    );
    let request = created(
        store
            .send_friend_request(a, b, Some(" 我是 alice "), NO_CAP, T0)
            .await
            .unwrap(),
    );
    assert_eq!(
        request.message.as_deref(),
        Some("我是 alice"),
        "首尾空白去掉"
    );
    assert_eq!(request.expires_at, T0 + REQUEST_TTL_MS);
    // 重复申请不新建,返回原来那条
    match store
        .send_friend_request(a, b, None, NO_CAP, T0 + 1)
        .await
        .unwrap()
    {
        RequestOutcome::AlreadyPending(again) => assert_eq!(again.id, request.id),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        store.outgoing_friend_requests(a, T0).await.unwrap().len(),
        1
    );
    // 一个无关的人不受影响
    created(
        store
            .send_friend_request(c, b, None, NO_CAP, T0)
            .await
            .unwrap(),
    );
}

#[tokio::test]
async fn a_blocked_sender_learns_nothing_and_leaves_no_trace() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob"]).await;
    store.block_user(&ids[1], &ids[0], T0).await.unwrap(); // bob 拉黑了 alice
    let outcome = store
        .send_friend_request(&ids[0], &ids[1], Some("hi"), NO_CAP, T0)
        .await
        .unwrap();
    assert_eq!(outcome, RequestOutcome::Silent, "表面成功,实际什么都没发生");
    assert!(
        store
            .incoming_friend_requests(&ids[1], T0)
            .await
            .unwrap()
            .is_empty(),
        "bob 收不到"
    );
    assert!(
        store
            .outgoing_friend_requests(&ids[0], T0)
            .await
            .unwrap()
            .is_empty()
    );
    // 反过来:我拉黑了他,就不能再向他申请(要先取消拉黑)
    let err = store
        .send_friend_request(&ids[1], &ids[0], None, NO_CAP, T0)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::InvalidInput(_)), "{err:?}");
}

#[tokio::test]
async fn accepting_makes_both_sides_friends_and_only_the_receiver_may_decide() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob", "mallory"]).await;
    let request = created(
        store
            .send_friend_request(&ids[0], &ids[1], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    // 发起人自己、无关的人都不能处理 → 当作没有这条申请
    for who in [&ids[0], &ids[2]] {
        let err = store
            .decide_friend_request(&request.id, who, Decision::Accept, NO_CAP, T0)
            .await
            .unwrap_err();
        assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
    }
    assert!(
        !store.are_friends(&ids[0], &ids[1]).await.unwrap(),
        "没人有资格,所以什么都没发生"
    );
    let done = store
        .decide_friend_request(&request.id, &ids[1], Decision::Accept, NO_CAP, T0 + 5)
        .await
        .unwrap();
    assert_eq!(
        (done.state, done.decided_at),
        (RequestState::Accepted, Some(T0 + 5))
    );
    assert!(store.are_friends(&ids[0], &ids[1]).await.unwrap());
    assert!(store.are_friends(&ids[1], &ids[0]).await.unwrap(), "双向");
    // 已处理的不能再处理
    let err = store
        .decide_friend_request(&request.id, &ids[1], Decision::Reject, NO_CAP, T0 + 6)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
    assert!(
        store.are_friends(&ids[0], &ids[1]).await.unwrap(),
        "拒绝没有生效"
    );
    assert!(
        store
            .incoming_friend_requests(&ids[1], T0 + 6)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn rejection_blocks_a_repeat_for_24_hours_but_ignoring_does_not_reveal_itself() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob", "carol"]).await;
    let first = created(
        store
            .send_friend_request(&ids[0], &ids[1], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    store
        .decide_friend_request(&first.id, &ids[1], Decision::Reject, NO_CAP, T0 + 10)
        .await
        .unwrap();
    let err = store
        .send_friend_request(&ids[0], &ids[1], None, NO_CAP, T0 + 11)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::Forbidden(_)), "{err:?}");
    assert!(err.to_string().contains("24 小时"), "{err}");
    // 过了冷却可以再申请
    created(
        store
            .send_friend_request(&ids[0], &ids[1], None, NO_CAP, T0 + 10 + REJECT_COOLDOWN_MS)
            .await
            .unwrap(),
    );
    // 忽略:接收人的列表里消失,发起人看到的仍是「等待中」,也不能重复申请
    let ignored = created(
        store
            .send_friend_request(&ids[0], &ids[2], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    store
        .decide_friend_request(&ignored.id, &ids[2], Decision::Ignore, NO_CAP, T0 + 1)
        .await
        .unwrap();
    assert!(
        store
            .incoming_friend_requests(&ids[2], T0 + 2)
            .await
            .unwrap()
            .is_empty()
    );
    let outgoing = store
        .outgoing_friend_requests(&ids[0], T0 + 2)
        .await
        .unwrap();
    let to_carol = outgoing
        .iter()
        .find(|(r, _)| r.to_id == ids[2])
        .expect("仍在发起人的列表里");
    assert_eq!(to_carol.0.state, RequestState::Pending, "不暴露「被忽略」");
    assert!(matches!(
        store
            .send_friend_request(&ids[0], &ids[2], None, NO_CAP, T0 + 3)
            .await
            .unwrap(),
        RequestOutcome::AlreadyPending(_)
    ));
}

#[tokio::test]
async fn requests_expire_after_seven_days_and_can_then_be_renewed() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob"]).await;
    let request = created(
        store
            .send_friend_request(&ids[0], &ids[1], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    assert_eq!(
        store
            .incoming_friend_requests(&ids[1], T0 + REQUEST_TTL_MS - 1)
            .await
            .unwrap()
            .len(),
        1
    );
    let later = T0 + REQUEST_TTL_MS;
    assert!(
        store
            .incoming_friend_requests(&ids[1], later)
            .await
            .unwrap()
            .is_empty()
    );
    let err = store
        .decide_friend_request(&request.id, &ids[1], Decision::Accept, NO_CAP, later)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
    created(
        store
            .send_friend_request(&ids[0], &ids[1], None, NO_CAP, later)
            .await
            .unwrap(),
    );
}

#[tokio::test]
async fn mutual_requests_become_friends_at_once() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob"]).await;
    created(
        store
            .send_friend_request(&ids[0], &ids[1], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    let outcome = store
        .send_friend_request(&ids[1], &ids[0], None, NO_CAP, T0 + 1)
        .await
        .unwrap();
    assert_eq!(outcome, RequestOutcome::AutoAccepted);
    assert!(store.are_friends(&ids[0], &ids[1]).await.unwrap());
    assert!(
        store
            .incoming_friend_requests(&ids[1], T0 + 2)
            .await
            .unwrap()
            .is_empty(),
        "第一条申请已了结"
    );
    assert_eq!(
        store
            .send_friend_request(&ids[0], &ids[1], None, NO_CAP, T0 + 3)
            .await
            .unwrap(),
        RequestOutcome::AlreadyFriends
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn racing_accept_and_reject_leave_one_consistent_outcome() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob"]).await;
    let request = created(
        store
            .send_friend_request(&ids[0], &ids[1], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    let (s1, s2) = (store.clone(), store.clone());
    let (id1, id2, bob1, bob2) = (
        request.id.clone(),
        request.id.clone(),
        ids[1].clone(),
        ids[1].clone(),
    );
    let accept = tokio::spawn(async move {
        s1.decide_friend_request(&id1, &bob1, Decision::Accept, NO_CAP, T0 + 1)
            .await
    });
    let reject = tokio::spawn(async move {
        s2.decide_friend_request(&id2, &bob2, Decision::Reject, NO_CAP, T0 + 1)
            .await
    });
    let (accept, reject) = (accept.await.unwrap(), reject.await.unwrap());
    assert_eq!(
        accept.is_ok() as u8 + reject.is_ok() as u8,
        1,
        "恰好一个成功:{accept:?} / {reject:?}"
    );
    // 结果必须自洽:通过 ⇔ 是好友
    assert_eq!(
        accept.is_ok(),
        store.are_friends(&ids[0], &ids[1]).await.unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn racing_mutual_requests_never_create_duplicates() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob"]).await;
    let (s1, s2) = (store.clone(), store.clone());
    let (a1, b1, a2, b2) = (
        ids[0].clone(),
        ids[1].clone(),
        ids[0].clone(),
        ids[1].clone(),
    );
    let first =
        tokio::spawn(async move { s1.send_friend_request(&a1, &b1, None, NO_CAP, T0).await });
    let second =
        tokio::spawn(async move { s2.send_friend_request(&b2, &a2, None, NO_CAP, T0).await });
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    // 要么互为好友(后到的把先到的接受了),要么各有一条在等——不会出现「既是好友又有待处理」或重复行
    let friends = store.are_friends(&ids[0], &ids[1]).await.unwrap();
    let pending = store
        .incoming_friend_requests(&ids[0], T0)
        .await
        .unwrap()
        .len()
        + store
            .incoming_friend_requests(&ids[1], T0)
            .await
            .unwrap()
            .len();
    assert!(
        friends && pending == 0 || !friends && pending == 2,
        "friends={friends} pending={pending}"
    );
    assert_eq!(
        store.friend_count(&ids[0]).await.unwrap(),
        i64::from(friends)
    );
}

#[tokio::test]
async fn friend_caps_are_enforced_for_both_people() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob", "carol", "dave"]).await;
    // 上限 1:alice 和 bob 成为好友后,alice 不能再加 carol,carol 也不能通过 alice 的名额
    let request = created(
        store
            .send_friend_request(&ids[0], &ids[1], None, Caps::same(1), T0)
            .await
            .unwrap(),
    );
    store
        .decide_friend_request(&request.id, &ids[1], Decision::Accept, Caps::same(1), T0)
        .await
        .unwrap();
    let err = store
        .send_friend_request(&ids[0], &ids[2], None, Caps::same(1), T0)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::InvalidInput(_)), "{err:?}");
    // carol 先发给 alice(carol 自己没满);alice 已满,不能通过,申请仍在
    let from_carol = created(
        store
            .send_friend_request(&ids[2], &ids[0], None, Caps::same(1), T0)
            .await
            .unwrap(),
    );
    let err = store
        .decide_friend_request(&from_carol.id, &ids[0], Decision::Accept, Caps::same(1), T0)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("你的好友数已达上限"), "{err}");
    assert!(!store.are_friends(&ids[0], &ids[2]).await.unwrap());
    // 对方满了:dave 发给 bob(bob 已满),bob 通过不了,提示说的是「对方」不是「你」时也要对
    let from_dave = created(
        store
            .send_friend_request(&ids[3], &ids[1], None, Caps::same(1), T0)
            .await
            .unwrap(),
    );
    let err = store
        .decide_friend_request(&from_dave.id, &ids[1], Decision::Accept, Caps::same(1), T0)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("你的好友数已达上限"), "{err}");
    // 0 = 不限
    let free = created(
        store
            .send_friend_request(&ids[2], &ids[3], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    store
        .decide_friend_request(&free.id, &ids[3], Decision::Accept, NO_CAP, T0)
        .await
        .unwrap();
}

#[tokio::test]
async fn remarks_groups_and_removal() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob", "zed"]).await;
    let request = created(
        store
            .send_friend_request(&ids[0], &ids[1], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    store
        .decide_friend_request(&request.id, &ids[1], Decision::Accept, NO_CAP, T0)
        .await
        .unwrap();
    let request = created(
        store
            .send_friend_request(&ids[2], &ids[0], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    store
        .decide_friend_request(&request.id, &ids[0], Decision::Accept, NO_CAP, T0)
        .await
        .unwrap();
    // 备注与分组:各记各的
    store
        .update_friend(
            &ids[0],
            &ids[1],
            Some(Some(" 老同学 ".to_owned())),
            Some(Some("同学".to_owned())),
        )
        .await
        .unwrap();
    let mine = store.list_friends(&ids[0]).await.unwrap();
    let bob = mine.iter().find(|f| f.profile.id == ids[1]).unwrap();
    assert_eq!(
        (bob.remark.as_deref(), bob.group_name.as_deref()),
        (Some("老同学"), Some("同学"))
    );
    let theirs = store.list_friends(&ids[1]).await.unwrap();
    assert_eq!(theirs[0].remark, None, "对方看不到我给他起的备注");
    // 排序用备注名优先("老同学" 在 "zed的昵称" 之前或之后都行,但必须稳定且按备注/昵称)
    assert_eq!(mine.len(), 2);
    // 校验
    assert!(
        store
            .update_friend(&ids[0], &ids[1], Some(Some("长".repeat(31))), None)
            .await
            .is_err()
    );
    assert!(
        store
            .update_friend(&ids[0], &ids[1], None, Some(Some("组".repeat(21))))
            .await
            .is_err()
    );
    assert!(
        store
            .update_friend(&ids[0], &ids[1], Some(Some("a\nb".to_owned())), None)
            .await
            .is_err()
    );
    // 空串 = 清除;None = 不动
    store
        .update_friend(&ids[0], &ids[1], Some(Some("  ".to_owned())), None)
        .await
        .unwrap();
    let mine = store.list_friends(&ids[0]).await.unwrap();
    let bob = mine.iter().find(|f| f.profile.id == ids[1]).unwrap();
    assert_eq!(
        (bob.remark.as_deref(), bob.group_name.as_deref()),
        (None, Some("同学"))
    );
    // 不是好友 → 找不到
    let err = store
        .update_friend(&ids[1], &ids[2], Some(None), None)
        .await
        .unwrap_err();
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
    // 删除:双向
    assert!(store.remove_friend(&ids[0], &ids[1]).await.unwrap());
    assert!(!store.are_friends(&ids[1], &ids[0]).await.unwrap());
    assert!(
        !store.remove_friend(&ids[0], &ids[1]).await.unwrap(),
        "再删一次返回 false"
    );
    // 删除后没有冷却,可以重新申请
    created(
        store
            .send_friend_request(&ids[0], &ids[1], None, NO_CAP, T0 + 1)
            .await
            .unwrap(),
    );
}

#[tokio::test]
async fn blocking_ends_the_friendship_and_pending_requests_both_ways() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob", "carol"]).await;
    let request = created(
        store
            .send_friend_request(&ids[0], &ids[1], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    store
        .decide_friend_request(&request.id, &ids[1], Decision::Accept, NO_CAP, T0)
        .await
        .unwrap();
    let pending = created(
        store
            .send_friend_request(&ids[2], &ids[0], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    store.block_user(&ids[0], &ids[1], T0 + 1).await.unwrap();
    store.block_user(&ids[0], &ids[2], T0 + 1).await.unwrap();
    assert!(!store.are_friends(&ids[0], &ids[1]).await.unwrap());
    assert!(!store.are_friends(&ids[1], &ids[0]).await.unwrap());
    assert!(
        store.is_blocked_between(&ids[1], &ids[0]).await.unwrap(),
        "任一方向都算"
    );
    let err = store
        .decide_friend_request(&pending.id, &ids[0], Decision::Accept, NO_CAP, T0 + 2)
        .await
        .unwrap_err();
    assert!(
        matches!(err, KbError::NotFound(_)),
        "拉黑后的待处理申请作废:{err:?}"
    );
    assert_eq!(store.list_blocks(&ids[0]).await.unwrap().len(), 2);
    // 重复拉黑无害;不能拉黑自己;取消后可以重新往来
    store.block_user(&ids[0], &ids[1], T0 + 3).await.unwrap();
    assert_eq!(store.list_blocks(&ids[0]).await.unwrap().len(), 2);
    assert!(store.block_user(&ids[0], &ids[0], T0).await.is_err());
    assert!(store.unblock_user(&ids[0], &ids[1]).await.unwrap());
    assert!(!store.unblock_user(&ids[0], &ids[1]).await.unwrap());
    assert!(!store.is_blocked_between(&ids[0], &ids[1]).await.unwrap());
    created(
        store
            .send_friend_request(&ids[1], &ids[0], None, NO_CAP, T0 + 4)
            .await
            .unwrap(),
    );
}

#[tokio::test]
async fn privacy_round_trips_and_defaults_apply_to_old_accounts() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice"]).await;
    assert_eq!(store.privacy_of(&ids[0]).await.unwrap(), Privacy::default());
    let custom = Privacy {
        searchable_by_email: true,
        searchable_by_username: false,
        share_from: ShareFrom::Friends,
    };
    store.set_privacy(&ids[0], custom).await.unwrap();
    assert_eq!(store.privacy_of(&ids[0]).await.unwrap(), custom);
    assert!(matches!(
        store.set_privacy("usr_ghost", custom).await.unwrap_err(),
        KbError::NotFound(_)
    ));
}

#[tokio::test]
async fn invited_users_can_be_made_friends_idempotently_and_politely() {
    let (_dir, store) = open();
    let ids = people(&store, &["inviter", "newbie", "blocked_one"]).await;
    assert!(
        store
            .make_friends(&ids[0], &ids[1], NO_CAP, T0)
            .await
            .unwrap()
    );
    assert!(
        !store
            .make_friends(&ids[0], &ids[1], NO_CAP, T0)
            .await
            .unwrap(),
        "已是好友:安静地跳过"
    );
    assert!(
        !store
            .make_friends(&ids[0], &ids[0], NO_CAP, T0)
            .await
            .unwrap()
    );
    store.block_user(&ids[2], &ids[0], T0).await.unwrap();
    assert!(
        !store
            .make_friends(&ids[0], &ids[2], NO_CAP, T0)
            .await
            .unwrap(),
        "对方拉黑了邀请人:不强行加"
    );
    // 邀请人好友已满:新用户照样能注册,只是没自动加上
    assert!(
        !store
            .make_friends(&ids[0], &ids[2], Caps::same(1), T0)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn purging_a_user_removes_their_social_graph() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob", "carol"]).await;
    let request = created(
        store
            .send_friend_request(&ids[0], &ids[1], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    store
        .decide_friend_request(&request.id, &ids[1], Decision::Accept, NO_CAP, T0)
        .await
        .unwrap();
    created(
        store
            .send_friend_request(&ids[0], &ids[2], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    store.block_user(&ids[1], &ids[0], T0).await.unwrap();
    store.request_deletion(&ids[0], T0, 10).await.unwrap();
    store.purge_user(&ids[0], T0 + 100).await.unwrap();
    assert!(store.list_friends(&ids[1]).await.unwrap().is_empty());
    assert!(store.list_blocks(&ids[1]).await.unwrap().is_empty());
    assert!(
        store
            .incoming_friend_requests(&ids[2], T0 + 100)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.friend_count(&ids[1]).await.unwrap(), 0);
}

#[tokio::test]
async fn each_side_is_checked_against_their_own_cap() {
    let (_dir, store) = open();
    let ids = people(&store, &["alice", "bob", "carol"]).await;
    // bob 的上限是 1,已经有一个好友(carol);alice 的上限很宽
    let first = created(
        store
            .send_friend_request(&ids[2], &ids[1], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    store
        .decide_friend_request(&first.id, &ids[1], Decision::Accept, NO_CAP, T0)
        .await
        .unwrap();
    let request = created(
        store
            .send_friend_request(&ids[0], &ids[1], None, Caps { me: 100, other: 1 }, T0)
            .await
            .unwrap(),
    );
    // bob 通过时:他自己是 me(上限 1,已满)→ 说的是「你的」
    let err = store
        .decide_friend_request(
            &request.id,
            &ids[1],
            Decision::Accept,
            Caps { me: 1, other: 100 },
            T0,
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("你的好友数已达上限"), "{err}");
    // 如果 bob 上限放宽、但 alice 的上限(other)是 0 以外且已满,说的是「对方」
    let second = created(
        store
            .send_friend_request(&ids[2], &ids[0], None, NO_CAP, T0)
            .await
            .unwrap(),
    );
    store
        .decide_friend_request(&second.id, &ids[0], Decision::Accept, NO_CAP, T0)
        .await
        .unwrap();
    let err = store
        .decide_friend_request(
            &request.id,
            &ids[1],
            Decision::Accept,
            Caps { me: 100, other: 1 },
            T0,
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("对方的好友数已达上限"), "{err}");
    assert!(!store.are_friends(&ids[0], &ids[1]).await.unwrap());
}
