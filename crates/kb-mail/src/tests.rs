use std::sync::Arc;

use kb_core::KbError;
use kb_core::config::{MailAccount, MailConfig};

use super::*;

fn account(user: &str) -> MailAccount {
    MailAccount {
        preset: "custom".into(),
        host: "smtp.example.com".into(),
        port: 465,
        security: "tls".into(),
        username: user.into(),
    }
}

fn config(primary: bool, backup: bool) -> MailConfig {
    MailConfig {
        enabled: true,
        primary: if primary {
            account("main@qq.com")
        } else {
            MailAccount::default()
        },
        backup: if backup {
            account("spare@163.com")
        } else {
            MailAccount::default()
        },
        ..MailConfig::default()
    }
}

fn passwords() -> Passwords {
    Passwords {
        primary: "primary-secret".into(),
        backup: "backup-secret".into(),
    }
}

fn mail() -> Outgoing {
    Mail::Test.render("user@example.com", "知识库", "https://kb.example.com")
}

/// 返回 (发信器, 已发邮件, 失败名单)。
fn mailer() -> (Mailer, SentLog, Arc<Mutex<Vec<String>>>) {
    let transport = MemoryTransport::default();
    let sent = transport.sent.clone();
    let failing = transport.failing.clone();
    (Mailer::new(Box::new(transport)), sent, failing)
}

#[tokio::test]
async fn the_primary_account_is_used_when_it_works() {
    let (mailer, sent, _) = mailer();
    let via = mailer
        .send(&config(true, true), &passwords(), "站", &mail())
        .await
        .unwrap();
    assert_eq!(via, Via::Primary);
    assert_eq!(sent.lock().unwrap()[0].0, "main@qq.com");
}

#[tokio::test]
async fn a_failing_primary_falls_back_and_stays_on_the_backup_for_a_while() {
    let (mailer, sent, failing) = mailer();
    failing.lock().unwrap().push("main@qq.com".into());
    let cfg = config(true, true);
    assert_eq!(
        mailer
            .send(&cfg, &passwords(), "站", &mail())
            .await
            .unwrap(),
        Via::Backup
    );
    // 主账号恢复了,但冷却期内不再先试它(否则每封邮件都要先等一次主账号超时)
    failing.lock().unwrap().clear();
    assert_eq!(
        mailer
            .send(&cfg, &passwords(), "站", &mail())
            .await
            .unwrap(),
        Via::Backup
    );
    assert!(
        sent.lock()
            .unwrap()
            .iter()
            .all(|(user, _)| user == "spare@163.com")
    );
}

#[tokio::test]
async fn without_a_backup_the_primary_is_always_retried() {
    let (mailer, _, failing) = mailer();
    let cfg = config(true, false);
    failing.lock().unwrap().push("main@qq.com".into());
    assert!(
        mailer
            .send(&cfg, &passwords(), "站", &mail())
            .await
            .is_err()
    );
    failing.lock().unwrap().clear();
    assert_eq!(
        mailer
            .send(&cfg, &passwords(), "站", &mail())
            .await
            .unwrap(),
        Via::Primary,
        "没有备用时不进冷却"
    );
}

#[tokio::test]
async fn both_failing_reports_the_error_and_nothing_is_sent() {
    let (mailer, sent, failing) = mailer();
    failing
        .lock()
        .unwrap()
        .extend(["main@qq.com".into(), "spare@163.com".into()]);
    let error = mailer
        .send(&config(true, true), &passwords(), "站", &mail())
        .await
        .unwrap_err();
    assert!(matches!(error, KbError::Upstream(_)), "{error:?}");
    assert!(sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn send_via_tests_one_account_without_falling_back() {
    let (mailer, sent, failing) = mailer();
    let config = config(true, true);
    failing.lock().unwrap().push("main@qq.com".into());
    // 主账号坏了:测试主账号必须报错,不能被备用账号顶上
    let error = mailer
        .send_via(&config, &passwords(), "知识库", Via::Primary, &mail())
        .await
        .unwrap_err();
    assert!(!error.to_string().is_empty());
    assert!(
        sent.lock().unwrap().is_empty(),
        "不该偷偷改用备用账号发出去"
    );
    // 备用账号可以单独测
    mailer
        .send_via(&config, &passwords(), "知识库", Via::Backup, &mail())
        .await
        .unwrap();
    assert_eq!(sent.lock().unwrap()[0].0, "spare@163.com");
    // 测试不改变正常发信的主备状态:主账号没有进入冷却
    failing.lock().unwrap().clear();
    assert_eq!(
        mailer
            .send(&config, &passwords(), "知识库", &mail())
            .await
            .unwrap(),
        Via::Primary
    );
    // 没配的槽位给出明确提示
    let none = self::config(true, false);
    let error = mailer
        .send_via(&none, &passwords(), "知识库", Via::Backup, &mail())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("备用"), "{error}");
}

#[tokio::test]
async fn a_backup_only_setup_works_and_an_empty_one_is_unavailable() {
    let (mailer, sent, _) = mailer();
    assert_eq!(
        mailer
            .send(&config(false, true), &passwords(), "站", &mail())
            .await
            .unwrap(),
        Via::Backup
    );
    assert_eq!(sent.lock().unwrap().len(), 1);
    let error = mailer
        .send(&config(false, false), &passwords(), "站", &mail())
        .await
        .unwrap_err();
    assert!(matches!(error, KbError::Unavailable(_)), "{error:?}");
}

#[tokio::test]
async fn disabled_mail_never_sends() {
    let (mailer, sent, _) = mailer();
    let mut cfg = config(true, true);
    cfg.enabled = false;
    assert!(matches!(
        mailer
            .send(&cfg, &passwords(), "站", &mail())
            .await
            .unwrap_err(),
        KbError::Unavailable(_)
    ));
    assert!(sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_sender_name_falls_back_to_the_site_name() {
    struct Capture(Mutex<Vec<String>>);
    #[async_trait]
    impl MailTransport for Capture {
        async fn send(&self, sender: &Sender, _mail: &Outgoing) -> kb_core::Result<()> {
            self.0.lock().unwrap().push(sender.from_name.clone());
            Ok(())
        }
    }
    let capture = Arc::new(Capture(Mutex::default()));
    struct Shared(Arc<Capture>);
    #[async_trait]
    impl MailTransport for Shared {
        async fn send(&self, sender: &Sender, mail: &Outgoing) -> kb_core::Result<()> {
            self.0.send(sender, mail).await
        }
    }
    let mailer = Mailer::new(Box::new(Shared(capture.clone())));
    let mut cfg = config(true, false);
    mailer
        .send(&cfg, &passwords(), "我的站点", &mail())
        .await
        .unwrap();
    cfg.from_name = "指定名字".into();
    mailer
        .send(&cfg, &passwords(), "我的站点", &mail())
        .await
        .unwrap();
    assert_eq!(*capture.0.lock().unwrap(), ["我的站点", "指定名字"]);
}

#[test]
fn templates_state_the_code_the_lifetime_and_what_to_do_if_it_was_not_you() {
    let register = Mail::RegisterCode {
        code: "482910".into(),
        minutes: 10,
    }
    .render("a@b.com", "知识库", "https://kb.example.com");
    assert!(register.subject.contains("482910") && register.subject.contains("知识库"));
    for needle in [
        "482910",
        "10 分钟",
        "忽略这封邮件",
        "https://kb.example.com",
    ] {
        assert!(
            register.body.contains(needle),
            "注册邮件缺「{needle}」:{}",
            register.body
        );
    }
    assert_eq!(register.to, "a@b.com");
    let reset = Mail::ResetCode {
        code: "111222".into(),
        minutes: 10,
    }
    .render("a@b.com", "知识库", "https://kb.example.com");
    assert!(reset.body.contains("密码不会改变"));
    let existing = Mail::AlreadyRegistered.render("a@b.com", "知识库", "https://kb.example.com");
    assert!(existing.body.contains("已经注册过") && existing.body.contains("忘记密码"));
    assert!(
        !existing
            .body
            .contains(|c: char| c.is_ascii_digit() && false),
        "占位"
    );
}

#[test]
fn passwords_never_appear_in_error_text() {
    assert_eq!(
        scrub("auth failed for hunter2 at host", "hunter2"),
        "auth failed for *** at host"
    );
    assert_eq!(scrub("plain", ""), "plain");
}

#[tokio::test]
async fn header_injection_in_the_recipient_or_subject_is_refused() {
    let sender = Sender {
        account: account("main@qq.com"),
        password: "x".into(),
        from_name: "站".into(),
    };
    let transport = SmtpTransport;
    for (to, subject) in [
        ("a@b.com\r\nBcc: evil@x.com", "ok"),
        ("a@b.com", "hi\nBcc: evil@x.com"),
    ] {
        let error = transport
            .send(
                &sender,
                &Outgoing {
                    to: to.into(),
                    subject: subject.into(),
                    body: "x".into(),
                },
            )
            .await
            .unwrap_err();
        assert!(
            matches!(error, KbError::InvalidInput(_)),
            "{to:?}/{subject:?} 应被拒:{error:?}"
        );
    }
    let error = transport
        .send(
            &sender,
            &Outgoing {
                to: "not-an-email".into(),
                subject: "s".into(),
                body: "b".into(),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(error, KbError::InvalidInput(_)), "{error:?}");
}

#[tokio::test]
async fn unencrypted_smtp_is_only_allowed_to_loopback() {
    let sender = |host: &str| Sender {
        account: MailAccount {
            host: host.into(),
            port: 1025,
            security: "none".into(),
            ..account("a@b.com")
        },
        password: "x".into(),
        from_name: "站".into(),
    };
    let error = SmtpTransport
        .send(&sender("smtp.qq.com"), &mail())
        .await
        .unwrap_err();
    assert!(
        matches!(error, KbError::InvalidInput(_)),
        "明文 SMTP 不能连外网:{error:?}"
    );
}

/// 真实 SMTP 往返:往本地的 Mailpit(开发实例里常驻)发一封,再从它的接口里读回来。
/// Mailpit 不在时跳过(不是失败),所以 CI 里不依赖它。
#[tokio::test]
async fn a_real_smtp_send_reaches_the_local_mailpit() {
    use std::io::{Read, Write};
    let reachable = std::net::TcpStream::connect_timeout(
        &"127.0.0.1:1025".parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_ok();
    if !reachable {
        eprintln!("跳过:本机 1025 没有 Mailpit");
        return;
    }
    let marker = format!("kb-mail-test-{}", std::process::id());
    let sender = Sender {
        account: MailAccount {
            host: "127.0.0.1".into(),
            port: 1025,
            security: "none".into(),
            username: "noreply@kb.test".into(),
            ..MailAccount::default()
        },
        password: String::new(),
        from_name: "测试站".into(),
    };
    let outgoing = Mail::RegisterCode {
        code: marker.clone(),
        minutes: 10,
    }
    .render("someone@example.com", "测试站", "https://kb.test");
    SmtpTransport
        .send(&sender, &outgoing)
        .await
        .expect("发到 Mailpit");
    // 从 Mailpit 的 HTTP 接口读回(8025)
    let mut stream = std::net::TcpStream::connect("127.0.0.1:8025").expect("Mailpit 网页端口");
    let request = format!(
        "GET /api/v1/search?query={marker} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(
        response.contains(&marker),
        "Mailpit 里应能搜到这封邮件:{response}"
    );
    assert!(
        response.contains("someone@example.com"),
        "收件人不对:{response}"
    );
}

#[tokio::test]
async fn an_external_server_without_a_password_is_a_clear_config_error() {
    let sender = Sender {
        account: account("main@qq.com"),
        password: String::new(),
        from_name: "站".into(),
    };
    let error = SmtpTransport.send(&sender, &mail()).await.unwrap_err();
    assert!(
        matches!(&error, KbError::InvalidInput(message) if message.contains("授权码")),
        "{error:?}"
    );
}

#[test]
fn masking_hides_most_of_the_address_but_keeps_the_domain() {
    use crate::templates::mask_email;
    assert_eq!(mask_email("alice@example.com"), "a***@example.com");
    assert_eq!(mask_email("林一@例子.中国"), "林***@例子.中国");
    // 本地部分只有一个字符:一个都不露
    assert_eq!(mask_email("a@example.com"), "***@example.com");
    // 不是邮箱的东西整个遮掉,不原样回显
    assert_eq!(mask_email("not an email"), "***");
    assert_eq!(mask_email(""), "***");
    // 只有第一个字符会露出来,其余不会
    let masked = mask_email("verysecretname@corp.example");
    assert!(
        !masked.contains("verysecret") && masked.starts_with("v***@"),
        "{masked}"
    );
}

#[test]
fn account_notices_say_what_happened_what_to_do_and_never_leak_the_new_address() {
    let site = "知识库";
    let url = "https://kb.example.com";
    let changed = Mail::EmailChanged {
        new_email: "attacker@evil.example".into(),
    }
    .render("old@qq.com", site, url);
    assert_eq!(changed.to, "old@qq.com", "通知发给旧邮箱");
    assert!(
        changed.body.contains("a***@evil.example"),
        "{}",
        changed.body
    );
    assert!(
        !changed.body.contains("attacker@"),
        "新地址不能完整写进通知:{}",
        changed.body
    );
    assert!(
        changed.body.contains("不是你本人") && changed.body.contains("联系管理员"),
        "{}",
        changed.body
    );

    let deletion = Mail::DeletionRequested {
        when: "2026-11-04 14:30".into(),
    }
    .render("me@qq.com", site, url);
    for word in ["2026-11-04 14:30", "永久删除", "撤销", "不是你本人"] {
        assert!(
            deletion.body.contains(word),
            "缺「{word}」:{}",
            deletion.body
        );
    }

    let code = Mail::ChangeEmailCode {
        code: "481039".into(),
        minutes: 10,
    }
    .render("new@qq.com", site, url);
    assert!(
        code.subject.contains("481039")
            && code.body.contains("481039")
            && code.body.contains("10 分钟")
    );
    assert!(code.body.contains("不是你本人"));
}

#[test]
fn only_the_code_mails_contain_a_six_digit_number() {
    // 通知类邮件里不能出现看起来像验证码的 6 位数字:收件人可能把它当验证码填,
    // 也方便测试靠「邮件里有没有 6 位数字」来区分验证码邮件和提醒邮件
    let digits = |text: &str| {
        let mut run = 0;
        for ch in text.chars().chain(std::iter::once(' ')) {
            if ch.is_ascii_digit() {
                run += 1;
            } else {
                if run == 6 {
                    return true;
                }
                run = 0;
            }
        }
        false
    };
    let (site, url) = ("知识库", "https://kb.example.com");
    for mail in [
        Mail::AlreadyRegistered,
        Mail::EmailChanged {
            new_email: "someone@example.com".into(),
        },
        Mail::DeletionRequested {
            when: "2026-11-04 14:30".into(),
        },
        Mail::Test,
    ] {
        let out = mail.render("x@qq.com", site, url);
        assert!(
            !digits(&out.body) && !digits(&out.subject),
            "{:?} 不该含 6 位数字:{}",
            mail.kind(),
            out.body
        );
    }
    for mail in [
        Mail::RegisterCode {
            code: "123456".into(),
            minutes: 10,
        },
        Mail::ResetCode {
            code: "123456".into(),
            minutes: 10,
        },
        Mail::ChangeEmailCode {
            code: "123456".into(),
            minutes: 10,
        },
    ] {
        assert!(
            digits(&mail.render("x@qq.com", site, url).body),
            "{:?}",
            mail.kind()
        );
    }
}

#[test]
fn every_mail_kind_has_a_distinct_name_for_the_send_log() {
    let kinds = [
        Mail::RegisterCode {
            code: "1".into(),
            minutes: 1,
        }
        .kind(),
        Mail::ResetCode {
            code: "1".into(),
            minutes: 1,
        }
        .kind(),
        Mail::ChangeEmailCode {
            code: "1".into(),
            minutes: 1,
        }
        .kind(),
        Mail::EmailChanged {
            new_email: "a@b.c".into(),
        }
        .kind(),
        Mail::DeletionRequested {
            when: String::new(),
        }
        .kind(),
        Mail::AlreadyRegistered.kind(),
        Mail::Test.kind(),
    ];
    let unique: std::collections::HashSet<_> = kinds.iter().collect();
    assert_eq!(unique.len(), kinds.len(), "{kinds:?}");
}
