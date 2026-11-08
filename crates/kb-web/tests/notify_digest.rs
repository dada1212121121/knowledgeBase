//! 通知邮件的合并发送(多用户设计说明):同一个人 10 分钟内的通知合成一封。

use std::sync::Arc;

use kb_core::account::{NewUser, ROLE_ADMIN, ROLE_USER, UserStatus};
use kb_core::config::{Config, MailAccount};
use kb_core::social::kind;
use kb_mail::{Mailer, MemoryTransport, Passwords};
use kb_meta::SystemStore;
use kb_web::notify::{DIGEST_GAP_MS, DIGEST_LINES, Notifier, send_due_digests};
use serde_json::json;

const T0: i64 = 1_800_000_000_000;

struct Env {
    _dir: tempfile::TempDir,
    system: Arc<SystemStore>,
    mailer: Mailer,
    sent: kb_mail::SentLog,
    failing: Arc<std::sync::Mutex<Vec<String>>>,
    config: Config,
}

fn env(mail_on: bool) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let system = Arc::new(SystemStore::open(dir.path().join("system.db")).unwrap());
    let transport = MemoryTransport::default();
    let (sent, failing) = (transport.sent.clone(), transport.failing.clone());
    let mut config = Config::default();
    if mail_on {
        config.mail.enabled = true;
        config.mail.primary = MailAccount {
            host: "smtp.example.com".into(),
            username: "noreply@example.com".into(),
            ..Default::default()
        };
    }
    Env {
        _dir: dir,
        system,
        mailer: Mailer::new(Box::new(transport)),
        sent,
        failing,
        config,
    }
}

async fn user(env: &Env, name: &str, verified: bool) -> String {
    env.system
        .create_user(NewUser {
            username: name.to_owned(),
            email: Some(format!("{name}@example.com")),
            display_name: None,
            password_hash: "x".to_owned(),
            role_id: if name == "boss" {
                ROLE_ADMIN
            } else {
                ROLE_USER
            }
            .to_owned(),
            status: UserStatus::Active,
            registered_via: "test".to_owned(),
            must_change_password: false,
            email_verified: verified,
        })
        .await
        .unwrap()
        .0
        .id
}

fn notifier(env: &Env) -> Arc<Notifier> {
    Notifier::new(
        env.system.clone(),
        None,
        Arc::new(kb_core::config::ConfigStore::new(env.config.clone())),
    )
}

async fn run(env: &Env, now: i64) -> usize {
    send_due_digests(
        env.system.as_ref(),
        &env.mailer,
        &Passwords::default(),
        &env.config,
        now,
    )
    .await
}

fn friend_request(name: &str) -> serde_json::Value {
    json!({ "from": { "id": "x", "username": name, "display_name": format!("{name}的昵称") }, "message": "你好" })
}

#[tokio::test]
async fn several_notifications_become_one_mail_and_the_next_waits_ten_minutes() {
    let env = env(true);
    user(&env, "boss", true).await;
    let alice = user(&env, "alice", true).await;
    let n = notifier(&env);
    for who in ["bob", "carol", "dave"] {
        n.send(&alice, kind::FRIEND_REQUEST, friend_request(who), T0)
            .await;
    }
    assert_eq!(run(&env, T0 + 1).await, 1);
    let sent = env.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 1, "三条通知合成一封");
    let mail = &sent[0].1;
    assert_eq!(mail.to, "alice@example.com");
    assert!(mail.subject.contains("3 条新通知"), "{}", mail.subject);
    for who in ["bob", "carol", "dave"] {
        assert!(mail.body.contains(&format!("@{who}")), "{}", mail.body);
    }
    assert!(mail.body.contains("你好"), "附言带进邮件");
    assert!(mail.body.contains("个人设置"), "告诉对方怎么关");
    // 10 分钟内又来一条:先不发
    n.send(
        &alice,
        kind::FRIEND_REQUEST,
        friend_request("erin"),
        T0 + 60_000,
    )
    .await;
    assert_eq!(run(&env, T0 + 120_000).await, 0);
    assert_eq!(env.sent.lock().unwrap().len(), 1);
    // 满 10 分钟:只发新的那一条
    assert_eq!(run(&env, T0 + 1 + DIGEST_GAP_MS).await, 1);
    let sent = env.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    assert!(
        sent[1].1.subject.contains("1 条新通知"),
        "{}",
        sent[1].1.subject
    );
}

#[tokio::test]
async fn kinds_with_email_switched_off_never_reach_the_queue() {
    let env = env(true);
    user(&env, "boss", true).await;
    let alice = user(&env, "alice", true).await;
    env.system
        .set_notify_email_prefs(
            &alice,
            &std::collections::HashMap::from([(kind::FRIEND_REQUEST.to_owned(), false)]),
        )
        .await
        .unwrap();
    let n = notifier(&env);
    n.send(&alice, kind::FRIEND_REQUEST, friend_request("bob"), T0)
        .await;
    n.send(&alice, kind::COMMENT_REPLY, json!({}), T0).await; // 默认不发邮件
    assert_eq!(run(&env, T0 + 1).await, 0);
    assert!(env.sent.lock().unwrap().is_empty());
    // 站内通知照常有
    assert_eq!(env.system.unread_notifications(&alice).await.unwrap(), 2);
}

#[tokio::test]
async fn nothing_is_queued_when_mail_is_off_or_the_address_is_unverified() {
    let off = env(false);
    user(&off, "boss", true).await;
    let a = user(&off, "alice", true).await;
    notifier(&off)
        .send(&a, kind::FRIEND_REQUEST, friend_request("bob"), T0)
        .await;
    assert_eq!(
        off.system.unread_notifications(&a).await.unwrap(),
        1,
        "站内通知不受邮件开关影响"
    );
    assert_eq!(run(&off, T0 + 1).await, 0);
    assert!(
        off.system
            .due_notification_digests(T0 + 1, DIGEST_GAP_MS, 10)
            .await
            .unwrap()
            .is_empty()
    );

    let on = env(true);
    user(&on, "boss", true).await;
    let unverified = user(&on, "alice", false).await;
    notifier(&on)
        .send(&unverified, kind::FRIEND_REQUEST, friend_request("bob"), T0)
        .await;
    assert_eq!(run(&on, T0 + 1).await, 0);
    assert!(
        on.sent.lock().unwrap().is_empty(),
        "没验证的邮箱不发(那可能是别人的地址)"
    );
}

#[tokio::test]
async fn notifications_already_read_in_the_browser_are_not_emailed() {
    let env = env(true);
    user(&env, "boss", true).await;
    let alice = user(&env, "alice", true).await;
    notifier(&env)
        .send(&alice, kind::FRIEND_REQUEST, friend_request("bob"), T0)
        .await;
    env.system
        .mark_all_notifications_read(&alice, T0 + 5)
        .await
        .unwrap();
    assert_eq!(run(&env, T0 + 10).await, 0);
    assert!(env.sent.lock().unwrap().is_empty());
    // 队列已清,不会反复检查
    assert!(
        env.system
            .due_notification_digests(T0 + 20, DIGEST_GAP_MS, 10)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn a_failing_mailbox_is_logged_and_not_retried_every_minute() {
    let env = env(true);
    user(&env, "boss", true).await;
    let alice = user(&env, "alice", true).await;
    env.failing
        .lock()
        .unwrap()
        .push("noreply@example.com".into());
    notifier(&env)
        .send(&alice, kind::FRIEND_REQUEST, friend_request("bob"), T0)
        .await;
    assert_eq!(run(&env, T0 + 1).await, 0);
    assert!(
        env.system
            .due_notification_digests(T0 + 60_000, DIGEST_GAP_MS, 10)
            .await
            .unwrap()
            .is_empty(),
        "失败后队列清掉,不再重试"
    );
    let log = env.system.list_mail_log(10).await.unwrap();
    assert!(
        log.iter()
            .any(|entry| entry.kind == "notification_digest" && !entry.ok),
        "{log:?}"
    );
}

#[tokio::test]
async fn a_huge_burst_is_capped_in_the_mail_with_a_count_of_the_rest() {
    let env = env(true);
    user(&env, "boss", true).await;
    let alice = user(&env, "alice", true).await;
    let n = notifier(&env);
    for i in 0..(DIGEST_LINES + 7) {
        n.send(
            &alice,
            kind::FRIEND_REQUEST,
            friend_request(&format!("user{i}")),
            T0,
        )
        .await;
    }
    assert_eq!(run(&env, T0 + 1).await, 1);
    let mail = env.sent.lock().unwrap()[0].1.clone();
    assert_eq!(mail.body.matches("  · ").count(), DIGEST_LINES);
    assert!(mail.body.contains("还有 7 条"), "{}", mail.body);
    assert!(
        mail.subject
            .contains(&format!("{} 条新通知", DIGEST_LINES + 7)),
        "{}",
        mail.subject
    );
}
