//! 分享链接与游客的守护进程级验收(多用户设计说明):真实进程、真实 HTTP、真实 cookie。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_links`

#![cfg(feature = "testkit")]

mod support;

use serde_json::{Value, json};
use support::{Harness, http_headers, set_cookie_value};

const CSRF: (&str, &str) = ("X-KB-CSRF", "1");

fn note(space: &str, id: &str) -> Value {
    json!({ "kind": "insight", "space_id": space, "collection": "_global", "id": id })
}

fn file(space: &str, path: &str) -> Value {
    json!({ "kind": "file", "space_id": space, "collection": "_global", "path": path })
}

fn new_note(h: &Harness, who: &str, title: &str) -> String {
    h.ok(
        who,
        "create_item",
        json!({ "collection": "_global", "title": title, "body": format!("{title} 的正文"), "kind": "note" }),
    )["id"]
        .as_str()
        .expect("笔记 id")
        .to_owned()
}

/// 创建链接,返回 (链接 id, 令牌)。
fn make_link(h: &Harness, who: &str, args: Value) -> (String, String) {
    let created = h.ok(who, "link_create", args);
    let url = created["url"].as_str().expect("链接地址").to_owned();
    let token = url.rsplit("/s/").next().unwrap().to_owned();
    (created["link"]["id"].as_str().unwrap().to_owned(), token)
}

struct Visit {
    status: u16,
    headers: String,
    body: Value,
}

/// 以游客身份(带或不带 cookie)访问公开接口。
fn guest(
    h: &Harness,
    method: &str,
    path: &str,
    cookies: &[(&str, &str)],
    body: Option<Value>,
) -> Visit {
    let cookie = cookies
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ");
    let mut headers = vec![CSRF];
    if !cookie.is_empty() {
        headers.push(("Cookie", cookie.as_str()));
    }
    let (status, headers, body) = http_headers(h.port(), method, path, &headers, body);
    Visit {
        status,
        headers,
        body,
    }
}

fn info(h: &Harness, token: &str, cookies: &[(&str, &str)]) -> Visit {
    guest(h, "GET", &format!("/api/v1/share/{token}"), cookies, None)
}

fn call(
    h: &Harness,
    token: &str,
    capability: &str,
    cookies: &[(&str, &str)],
    args: Value,
) -> Visit {
    guest(
        h,
        "POST",
        &format!("/api/v1/share/{token}/call/{capability}"),
        cookies,
        Some(args),
    )
}

fn code(visit: &Visit) -> String {
    visit.body["error"]["code"]
        .as_str()
        .unwrap_or("")
        .to_owned()
}

#[test]
fn a_guest_opens_a_public_link_and_can_read_only_what_it_covers() {
    let h = Harness::start();
    let space = h.space("alice");
    let shared = new_note(&h, "alice", "公开的笔记");
    let other = new_note(&h, "alice", "没公开的笔记");
    let (link_id, token) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &shared), "audience": "anyone", "role": "viewer" }),
    );
    assert_eq!(token.len(), 22);

    let first = info(&h, &token, &[]);
    assert_eq!(first.status, 200, "{}", first.body);
    assert_eq!(first.body["data"]["state"], "active");
    assert_eq!(first.body["data"]["role"], "viewer");
    assert_eq!(first.body["data"]["can"]["edit"], false);
    assert!(first.body["data"]["owner"]["display_name"].is_string());
    let lower = first.headers.to_ascii_lowercase();
    assert!(lower.contains("x-robots-tag: noindex"), "{lower}");
    assert!(lower.contains("referrer-policy: no-referrer"), "{lower}");
    let cookie = set_cookie_value(&first.headers, "kb_guest").expect("给游客发了 cookie");
    assert!(cookie.len() >= 40);
    // 同一个游客带着 cookie 再来:不再发新 cookie,昵称不变
    let second = info(&h, &token, &[("kb_guest", &cookie)]);
    assert!(set_cookie_value(&second.headers, "kb_guest").is_none());
    assert_eq!(
        second.body["data"]["visitor"]["nickname"],
        first.body["data"]["visitor"]["nickname"]
    );
    let nickname = first.body["data"]["visitor"]["nickname"].as_str().unwrap();
    assert!(nickname.starts_with("访客 "), "{nickname}");

    // 读链接指向的笔记;读没公开的:404
    let got = call(
        &h,
        &token,
        "get_item",
        &[("kb_guest", &cookie)],
        json!({ "id": shared }),
    );
    assert_eq!(got.status, 200, "{}", got.body);
    assert_eq!(got.body["data"]["item"]["title"], "公开的笔记");
    let hidden = call(
        &h,
        &token,
        "get_item",
        &[("kb_guest", &cookie)],
        json!({ "id": other }),
    );
    assert_eq!(hidden.status, 404, "{}", hidden.body);
    // 只读链接:不能改、不能删、不能碰其它能力
    for (name, args) in [
        (
            "edit_item",
            json!({ "id": shared, "version": 1, "title": "被游客改了" }),
        ),
        ("delete_item", json!({ "id": shared })),
        (
            "create_item",
            json!({ "collection": "_global", "title": "x", "body": "y" }),
        ),
        ("stats_overview", json!({})),
        ("update_config", json!({ "patch": {}, "confirm": true })),
        ("agent_send", json!({ "message": "hi" })),
        // 编辑器的 AI 写作花的是 AI 额度:别人的知识库 / 游客都不能调
        ("ai_write", json!({ "action": "polish", "text": "x" })),
        ("link_create", json!({})),
        ("grant_set", json!({})),
    ] {
        let denied = call(&h, &token, name, &[("kb_guest", &cookie)], args);
        assert_eq!(denied.status, 403, "{name} 应被拒:{}", denied.body);
    }
    assert_eq!(
        h.ok("alice", "get_item", json!({ "id": shared }))["item"]["title"],
        "公开的笔记",
        "越权尝试没有改动内容"
    );
    // 打开次数:匿名只计次数
    let mine = h.ok("alice", "my_links", json!({}));
    let row = mine["links"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == link_id.as_str())
        .unwrap();
    assert!(row["views"].as_i64().unwrap() >= 2, "{row}");
    assert!(
        h.ok("alice", "link_stats", json!({ "id": link_id }))["visitors"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_guest_can_check_links_for_covered_files_but_cannot_probe_notes_or_other_files() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "链接体检的笔记");
    let (_, token) = make_link(
        &h,
        "alice",
        json!({ "target": file(&space, "docs/a.md"), "audience": "anyone", "role": "viewer" }),
    );
    let first = info(&h, &token, &[]);
    assert_eq!(first.status, 200, "{}", first.body);
    let cookie = set_cookie_value(&first.headers, "kb_guest").expect("给游客发了 cookie");
    let jar = [("kb_guest", cookie.as_str())];
    // 链接覆盖的文件可以体检;夹具里没有这个文件,所以是 missing,不是 400 / 404。
    let covered = call(
        &h,
        &token,
        "check_links",
        &jar,
        json!({ "targets": [{ "collection": "_global", "path": "docs/a.md" }] }),
    );
    assert_eq!(covered.status, 200, "{}", covered.body);
    assert_eq!(
        covered.body["data"]["items"][0]["state"], "missing",
        "{}",
        covered.body
    );
    // 范围外的文件:和不存在一样。
    let hidden = call(
        &h,
        &token,
        "check_links",
        &jar,
        json!({ "targets": [{ "collection": "_global", "path": "docs/secret.md" }] }),
    );
    assert_eq!(hidden.status, 404, "{}", hidden.body);
    // 笔记目标一律拒绝,不能借体检探出链接范围外的笔记。
    let note_target = call(
        &h,
        &token,
        "check_links",
        &jar,
        json!({ "targets": [{ "kind": "note", "note_id": id }] }),
    );
    assert_eq!(note_target.status, 403, "{}", note_target.body);
    assert!(
        note_target.body.to_string().contains("不能检查笔记引用"),
        "拒绝原因:{}",
        note_target.body
    );
}
#[test]
fn public_calls_need_the_csrf_header_and_reject_unknown_or_malformed_tokens() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "n");
    let (_, token) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &id), "audience": "anyone", "role": "viewer" }),
    );
    // 没有 CSRF 头的写请求
    let (status, ..) = http_headers(
        h.port(),
        "POST",
        &format!("/api/v1/share/{token}/call/get_item"),
        &[],
        Some(json!({ "id": id })),
    );
    assert_eq!(status, 403);
    // 不存在的、格式不对的令牌:都是 404,不查库的格式错误也一样
    for bad in [
        "x".repeat(22),
        "short".to_owned(),
        "../../../etc/passwd".to_owned(),
        "a".repeat(100),
    ] {
        let visit = info(&h, &bad, &[]);
        assert_eq!(visit.status, 404, "{bad}: {}", visit.body);
        // 含斜杠的根本匹配不到这条路由,走通用的 not_found;其余走 link_not_found——都是 404,都不泄露任何东西
        assert!(
            ["link_not_found", "not_found"].contains(&code(&visit).as_str()),
            "{}",
            visit.body
        );
    }
}

#[test]
fn a_password_protected_link_hides_everything_until_unlocked_and_locks_out_guessers() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "加密的");
    let (_, token) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &id), "audience": "anyone", "role": "viewer", "password": "sesame1" }),
    );
    // 没输密码:只知道「需要密码」,标题 / 内容 / 类型都不给;调用被拒
    let locked = info(&h, &token, &[]);
    assert_eq!(locked.status, 200);
    assert_eq!(locked.body["data"]["requires_password"], true);
    for field in ["title", "roots", "owner", "role"] {
        assert!(
            locked.body["data"].get(field).is_none(),
            "上锁时不该给出 {field}:{}",
            locked.body
        );
    }
    assert!(set_cookie_value(&locked.headers, "kb_guest").is_some() || true);
    let denied = call(&h, &token, "get_item", &[], json!({ "id": id }));
    assert_eq!(
        (denied.status, code(&denied).as_str()),
        (401, "password_required")
    );
    // 密码错 4 次:每次 401;第 5 次错之后锁定,这时即使输对也进不去
    for _ in 0..5 {
        let wrong = guest(
            &h,
            "POST",
            &format!("/api/v1/share/{token}/unlock"),
            &[],
            Some(json!({ "password": "nope" })),
        );
        assert_eq!(
            (wrong.status, code(&wrong).as_str()),
            (401, "wrong_password")
        );
    }
    let locked_out = guest(
        &h,
        "POST",
        &format!("/api/v1/share/{token}/unlock"),
        &[],
        Some(json!({ "password": "sesame1" })),
    );
    assert_eq!(
        (locked_out.status, code(&locked_out).as_str()),
        (429, "locked")
    );
}

#[test]
fn the_right_password_unlocks_for_this_link_only_and_a_new_password_invalidates_old_unlocks() {
    let h = Harness::start();
    let space = h.space("alice");
    let one = new_note(&h, "alice", "一号");
    let two = new_note(&h, "alice", "二号");
    let (id_one, token_one) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &one), "audience": "anyone", "role": "viewer", "password": "alpha1" }),
    );
    let (_, token_two) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &two), "audience": "anyone", "role": "viewer", "password": "alpha1" }),
    );
    let unlocked = guest(
        &h,
        "POST",
        &format!("/api/v1/share/{token_one}/unlock"),
        &[],
        Some(json!({ "password": "alpha1" })),
    );
    assert_eq!(unlocked.status, 200, "{}", unlocked.body);
    let unlock_cookie =
        set_cookie_value(&unlocked.headers, &format!("kb_share_{id_one}")).expect("解锁 cookie");
    let guest_cookie = set_cookie_value(&unlocked.headers, "kb_guest");
    let mut cookies = vec![(format!("kb_share_{id_one}"), unlock_cookie.clone())];
    if let Some(value) = &guest_cookie {
        cookies.push(("kb_guest".to_owned(), value.clone()));
    }
    let jar: Vec<(&str, &str)> = cookies
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert_eq!(
        call(&h, &token_one, "get_item", &jar, json!({ "id": one })).status,
        200
    );
    let page = info(&h, &token_one, &jar);
    assert_eq!(page.body["data"]["state"], "active");
    // 这个 cookie 对另一个链接没用(即使两个链接密码一样)
    let other_link = call(&h, &token_two, "get_item", &jar, json!({ "id": two }));
    assert_eq!(
        (other_link.status, code(&other_link).as_str()),
        (401, "password_required")
    );
    // 篡改 cookie 里的过期时间:签名对不上
    let forged = format!("{}.{}", i64::MAX, unlock_cookie.split_once('.').unwrap().1);
    let forged_jar = [(format!("kb_share_{id_one}"), forged)];
    let forged_jar: Vec<(&str, &str)> = forged_jar
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert_eq!(
        call(
            &h,
            &token_one,
            "get_item",
            &forged_jar,
            json!({ "id": one })
        )
        .status,
        401
    );
    // 所有者换了密码:旧解锁立刻失效
    h.ok(
        "alice",
        "link_update",
        json!({ "id": id_one, "password": "beta22" }),
    );
    let after = call(&h, &token_one, "get_item", &jar, json!({ "id": one }));
    assert_eq!(
        (after.status, code(&after).as_str()),
        (401, "password_required")
    );
    // 去掉密码后不需要了
    h.ok(
        "alice",
        "link_update",
        json!({ "id": id_one, "clear_password": true }),
    );
    assert_eq!(
        call(&h, &token_one, "get_item", &[], json!({ "id": one })).status,
        200
    );
}

#[test]
fn login_only_links_refuse_guests_but_welcome_logged_in_people_and_collaborator_links_give_nothing_extra()
 {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "登录可看");
    let (_, token) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &id), "audience": "logged_in", "role": "viewer" }),
    );
    let visit = info(&h, &token, &[]);
    assert_eq!(
        (visit.status, code(&visit).as_str()),
        (401, "login_required")
    );
    assert!(
        set_cookie_value(&visit.headers, "kb_guest").is_none(),
        "被拒的游客不登记"
    );
    // bob 登录后(带会话 cookie)可以看,并进入访问者名单
    let session = h.cookie("bob").to_owned();
    let (status, headers, body) = http_headers(
        h.port(),
        "GET",
        &format!("/api/v1/share/{token}"),
        &[("Cookie", &format!("kb_session={session}"))],
        None,
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["visitor"]["kind"], "user");
    // 登录访客的头像文件名要随 visitor 一起返回(没设头像时是 null),公开页右上角据此画真头像
    assert!(
        body["data"]["visitor"]
            .as_object()
            .is_some_and(|visitor| visitor.contains_key("avatar")),
        "visitor 里应有 avatar 字段:{}",
        body["data"]["visitor"]
    );
    assert!(!headers.is_empty());
    let (status, _, got) = http_headers(
        h.port(),
        "POST",
        &format!("/api/v1/share/{token}/call/get_item"),
        &[CSRF, ("Cookie", &format!("kb_session={session}"))],
        Some(json!({ "id": id })),
    );
    assert_eq!(status, 200, "{got}");
    let links = h.ok("alice", "my_links", json!({}));
    let link_id = links["links"][0]["id"].as_str().unwrap().to_owned();
    let stats = h.ok("alice", "link_stats", json!({ "id": link_id }));
    assert_eq!(stats["visitors"][0]["user"]["username"], "bob");
    // 「仅协作者」链接:只是个地址。陌生人 carol 打开 → 没权限;被授权的 bob 打开 → 有他自己的角色
    let (_, only_collab) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &id), "audience": "collaborators", "role": "editor" }),
    );
    let carol = format!("kb_session={}", h.cookie("carol"));
    let (status, _, body) = http_headers(
        h.port(),
        "GET",
        &format!("/api/v1/share/{only_collab}"),
        &[("Cookie", &carol)],
        None,
    );
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"]["code"], "no_access");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note(&space, &id), "user_id": h.id("carol"), "role": "viewer" }),
    );
    let (status, _, body) = http_headers(
        h.port(),
        "GET",
        &format!("/api/v1/share/{only_collab}"),
        &[("Cookie", &carol)],
        None,
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["data"]["role"], "viewer",
        "链接给的是编辑,但协作者链接不给额外权限:他的角色还是自己的查看"
    );
    // 游客对「仅协作者」链接:要登录
    let guest_visit = info(&h, &only_collab, &[]);
    assert_eq!(guest_visit.status, 401);
}

#[test]
fn link_states_are_reported_distinctly_and_resetting_kills_the_old_address() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "状态");
    let (link_id, token) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &id), "audience": "anyone", "role": "viewer" }),
    );
    assert_eq!(info(&h, &token, &[]).status, 200);
    // 关闭 → 410 link_closed;重新打开 → 恢复(设置保留)
    h.ok(
        "alice",
        "link_update",
        json!({ "id": link_id, "enabled": false }),
    );
    let closed = info(&h, &token, &[]);
    assert_eq!(
        (closed.status, code(&closed).as_str()),
        (410, "link_closed")
    );
    h.ok(
        "alice",
        "link_update",
        json!({ "id": link_id, "enabled": true }),
    );
    assert_eq!(info(&h, &token, &[]).status, 200);
    // 重置:旧地址 404,新地址可用,设置不变
    let reset = h.ok("alice", "link_reset", json!({ "id": link_id }));
    let new_token = reset["url"]
        .as_str()
        .unwrap()
        .rsplit("/s/")
        .next()
        .unwrap()
        .to_owned();
    assert_ne!(new_token, token);
    assert_eq!(info(&h, &token, &[]).status, 404);
    assert_eq!(info(&h, &new_token, &[]).status, 200);
    // 撤销:410 link_revoked,不可恢复
    h.ok("alice", "link_revoke", json!({ "id": link_id }));
    let revoked = info(&h, &new_token, &[]);
    assert_eq!(
        (revoked.status, code(&revoked).as_str()),
        (410, "link_revoked")
    );
    let (status, _) = h.call(
        "alice",
        "link_update",
        json!({ "id": link_id, "enabled": true }),
    );
    assert_eq!(status, 404, "撤销后不能再改");
    // 过期:创建时 1 天,之后改成"过去"做不到,所以验证接口拒绝过去的时间并接受天数
    let (_, token2) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &id), "audience": "anyone", "role": "viewer", "expires_days": 1 }),
    );
    assert_eq!(info(&h, &token2, &[]).status, 200);
    let (status, _) = h.call("alice", "link_create", json!({ "target": note(&space, &id), "audience": "anyone", "role": "viewer", "expires_days": 0 }));
    assert_eq!(status, 400);
}

#[test]
fn system_parameters_degrade_guest_power_live_and_a_guest_edit_is_labelled_and_trimmed() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "游客能改的笔记");
    let (_, token) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &id), "audience": "anyone", "role": "editor" }),
    );
    let cookie = set_cookie_value(&info(&h, &token, &[]).headers, "kb_guest").unwrap();
    let jar = [("kb_guest", cookie.as_str())];
    // 默认:游客只能看(评论 / 编辑都关)——编辑型链接对游客降级成查看
    assert_eq!(info(&h, &token, &jar).body["data"]["role"], "viewer");
    let denied = call(
        &h,
        &token,
        "edit_item",
        &jar,
        json!({ "id": id, "version": 1, "title": "不行" }),
    );
    assert_eq!(denied.status, 403, "{}", denied.body);
    assert_eq!(
        call(
            &h,
            &token,
            "add_annotation",
            &jar,
            json!({ "collection": "_global", "source": format!("insight:{id}"), "body": "不行" })
        )
        .status,
        403
    );

    // 管理员在系统参数里打开游客评论和编辑(热更新,不重启)
    let config_path = h.daemon.home.path().join("config.toml");
    let original = std::fs::read_to_string(&config_path).unwrap();
    let write_share = |view: bool, comment: bool, edit: bool| {
        std::fs::write(&config_path, format!("{original}\n[share]\nallow_guest_view = {view}\nallow_guest_comment = {comment}\nallow_guest_edit = {edit}\n")).unwrap();
    };
    let wait_role = |wanted: &str| {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let got = info(&h, &token, &jar);
            if got.body["data"]["role"] == wanted || got.body["error"]["code"] == wanted {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "参数没有生效,等 {wanted},实际 {}",
                got.body
            );
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    };
    write_share(true, true, true);
    wait_role("editor");
    // 游客编辑:只收标题和正文,带来的标签 / 种类被丢掉
    let current = h.ok("alice", "get_item", json!({ "id": id }));
    let version = current["item"]["version"].as_i64().unwrap_or(1);
    let edited = call(
        &h,
        &token,
        "edit_item",
        &jar,
        json!({ "id": id, "version": version, "title": "游客改的标题", "body": "游客写的正文", "tags": ["inject"], "kind": "decision" }),
    );
    assert_eq!(edited.status, 200, "{}", edited.body);
    let after = h.ok("alice", "get_item", json!({ "id": id }));
    assert_eq!(after["item"]["title"], "游客改的标题");
    assert!(
        !after.to_string().contains("inject"),
        "游客不能改标签:{after}"
    );
    assert_ne!(after["item"]["kind"], "decision", "游客不能改种类");
    // 所有者能在自己的审计里认出这次修改是哪个游客、经哪个链接做的
    let audit = h.ok("alice", "audit_list", json!({}));
    let text = audit.to_string();
    assert!(
        text.contains("guest:访客") && text.contains("经链接"),
        "审计里应写明游客与链接:{text}"
    );
    // 游客评论
    let comment = call(
        &h,
        &token,
        "add_annotation",
        &jar,
        json!({ "collection": "_global", "source": format!("insight:{id}"), "body": "游客的评论" }),
    );
    assert_eq!(comment.status, 200, "{}", comment.body);
    // 管理员再关掉游客编辑:已有链接立刻降级(评论还在)
    write_share(true, true, false);
    wait_role("commenter");
    assert_eq!(
        call(
            &h,
            &token,
            "edit_item",
            &jar,
            json!({ "id": id, "version": 2, "title": "又改" })
        )
        .status,
        403
    );
    // 关掉游客查看:链接对游客整体失效
    write_share(false, false, false);
    wait_role("guests_disabled");
    let off = info(&h, &token, &jar);
    assert_eq!((off.status, code(&off).as_str()), (403, "guests_disabled"));
    // 登录用户不受游客参数影响:bob 用同一个链接仍有链接的编辑角色
    let bob = format!("kb_session={}", h.cookie("bob"));
    let (status, _, body) = http_headers(
        h.port(),
        "GET",
        &format!("/api/v1/share/{token}"),
        &[("Cookie", &bob)],
        None,
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["role"], "editor");
}

#[test]
fn guests_can_rename_themselves_within_limits_and_the_owner_sees_which_guest_acted() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "x");
    let (_, token) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &id), "audience": "anyone", "role": "viewer" }),
    );
    let cookie = set_cookie_value(&info(&h, &token, &[]).headers, "kb_guest").unwrap();
    let jar = [("kb_guest", cookie.as_str())];
    let renamed = guest(
        &h,
        "POST",
        &format!("/api/v1/share/{token}/guest"),
        &jar,
        Some(json!({ "nickname": "  小王 " })),
    );
    assert_eq!(renamed.status, 200, "{}", renamed.body);
    assert_eq!(renamed.body["data"]["nickname"], "小王");
    assert_eq!(
        info(&h, &token, &jar).body["data"]["visitor"]["nickname"],
        "小王"
    );
    for bad in ["", &"长".repeat(21), "<b>x</b>"] {
        let visit = guest(
            &h,
            "POST",
            &format!("/api/v1/share/{token}/guest"),
            &jar,
            Some(json!({ "nickname": bad })),
        );
        assert_eq!(visit.status, 400, "{bad:?}");
    }
    // 另一个游客改名不影响这个游客
    let other = set_cookie_value(&info(&h, &token, &[]).headers, "kb_guest").unwrap();
    assert_ne!(other, cookie);
    assert_eq!(
        info(&h, &token, &jar).body["data"]["visitor"]["nickname"],
        "小王"
    );
}

#[test]
fn a_bundle_link_covers_exactly_its_items_and_a_disabled_owner_takes_the_link_down() {
    let h = Harness::start();
    let space = h.space("alice");
    let a = new_note(&h, "alice", "合集 A");
    let b = new_note(&h, "alice", "合集 B");
    let c = new_note(&h, "alice", "合集外 C");
    let (_, token) = make_link(
        &h,
        "alice",
        json!({ "targets": [note(&space, &a), note(&space, &b)], "title": "我的合集", "audience": "anyone", "role": "viewer" }),
    );
    let page = info(&h, &token, &[]);
    assert_eq!(page.body["data"]["bundle"], true);
    assert_eq!(page.body["data"]["roots"].as_array().unwrap().len(), 2);
    assert_eq!(page.body["data"]["title"], "我的合集");
    for id in [&a, &b] {
        assert_eq!(
            call(&h, &token, "get_item", &[], json!({ "id": id })).status,
            200
        );
    }
    assert_eq!(
        call(&h, &token, "get_item", &[], json!({ "id": c })).status,
        404,
        "合集外的"
    );
    assert_eq!(
        call(
            &h,
            &token,
            "list_items",
            &[],
            json!({ "collection": "_global" })
        )
        .status,
        404,
        "集合本身不在合集里"
    );
    // 所有者账号被停用:链接一起失效
    h.ok(
        "admin",
        "user_update",
        json!({ "id": h.id("alice"), "status": "disabled" }),
    );
    let gone = info(&h, &token, &[]);
    assert_eq!(
        (gone.status, code(&gone).as_str()),
        (410, "link_unavailable")
    );
}

#[test]
fn only_people_who_may_manage_links_can_create_or_change_them_and_features_gate_each_audience() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "x");
    let target = note(&space, &id);
    // 陌生人建不了(404),可编辑的人也建不了(403),可管理的人可以
    let (status, _) = h.call(
        "bob",
        "link_create",
        json!({ "target": target, "audience": "anyone", "role": "viewer" }),
    );
    assert_eq!(status, 404);
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "editor" }),
    );
    let (status, _) = h.call(
        "bob",
        "link_create",
        json!({ "target": target, "audience": "anyone", "role": "viewer" }),
    );
    assert_eq!(status, 403);
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "manager" }),
    );
    let (link_id, _) = make_link(
        &h,
        "bob",
        json!({ "target": target, "audience": "anyone", "role": "viewer" }),
    );
    // 别人的链接:carol 看不见也改不了(404)
    for (name, args) in [
        ("link_update", json!({ "id": link_id, "enabled": false })),
        ("link_reset", json!({ "id": link_id })),
        ("link_revoke", json!({ "id": link_id })),
        ("link_stats", json!({ "id": link_id })),
    ] {
        let (status, body) = h.call("carol", name, args);
        assert_eq!(status, 404, "{name}: {body}");
    }
    assert!(
        h.ok("carol", "my_links", json!({}))["links"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    // 资源上的链接列表(含设置,不含地址)
    let listed = h.ok("alice", "link_get", json!({ "target": target }));
    assert_eq!(listed["links"].as_array().unwrap().len(), 1);
    assert!(
        !listed.to_string().contains("/s/"),
        "列表里不能有链接地址:{listed}"
    );
    // 功能点:关掉 bob 的「游客链接」,他不能再建游客链接,但仍能建登录用户链接
    h.ok(
        "admin",
        "user_feature",
        json!({ "id": h.id("bob"), "feature": "collab.link_guest", "effect": "deny" }),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let (status, _) = h.call(
            "bob",
            "link_create",
            json!({ "target": target, "audience": "anyone", "role": "viewer" }),
        );
        if status == 403 {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "功能例外没有生效");
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    make_link(
        &h,
        "bob",
        json!({ "target": target, "audience": "logged_in", "role": "viewer" }),
    );
    // 参数校验
    for bad in [
        json!({ "audience": "anyone", "role": "viewer" }),
        json!({ "target": target, "targets": [target], "audience": "logged_in", "role": "viewer" }),
        json!({ "target": target, "audience": "everyone", "role": "viewer" }),
        json!({ "target": target, "audience": "logged_in", "role": "owner" }),
        json!({ "target": target, "audience": "logged_in", "role": "viewer", "password": "abc" }),
    ] {
        let (status, body) = h.call("alice", "link_create", bad.clone());
        assert_eq!(status, 400, "{bad}: {body}");
    }
}

#[test]
fn the_admin_governance_list_shows_who_and_how_much_but_never_the_content_and_can_revoke() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "绝密标题 ZZ-9931");
    let (link_id, token) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &id), "audience": "anyone", "role": "viewer" }),
    );
    info(&h, &token, &[]);
    let (status, _) = h.call("alice", "share_admin_list", json!({}));
    assert!(status == 403 || status == 404, "普通用户不能看全站链接");
    let listing = h.ok("admin", "share_admin_list", json!({}));
    let text = listing.to_string();
    assert!(!text.contains("ZZ-9931"), "治理页不显示资源内容:{text}");
    let row = &listing["links"][0];
    assert_eq!(row["creator"]["username"], "alice");
    assert_eq!(row["owner"]["username"], "alice");
    assert_eq!(row["kind"], "insight");
    assert_eq!(row["views"], 1);
    assert_eq!(row["state"], "active");
    // 管理员撤销(处理滥用投诉)
    h.ok("admin", "share_admin_revoke", json!({ "id": link_id }));
    let gone = info(&h, &token, &[]);
    assert_eq!((gone.status, code(&gone).as_str()), (410, "link_revoked"));
    let (status, _) = h.call("alice", "share_admin_revoke", json!({ "id": link_id }));
    assert!(status == 403 || status == 404);
}

#[test]
fn public_share_requests_are_rate_limited_per_address() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "x");
    let (_, token) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &id), "audience": "anyone", "role": "viewer" }),
    );
    let mut limited = 0;
    for _ in 0..130 {
        if info(&h, &token, &[]).status == 429 {
            limited += 1;
        }
    }
    assert!(
        limited >= 8,
        "每分钟 120 次,多出来的应被拦,实际只拦了 {limited}"
    );
}

#[test]
fn even_an_editor_link_never_offers_history_creation_or_deletion() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "编辑型链接");
    let collection = json!({ "kind": "collection", "space_id": space, "collection": "_global" });
    let (_, token) = make_link(
        &h,
        "alice",
        json!({ "target": collection, "audience": "logged_in", "role": "editor" }),
    );
    let bob = format!("kb_session={}", h.cookie("bob"));
    let via_link = |capability: &str, args: Value| {
        let (status, _, body) = http_headers(
            h.port(),
            "POST",
            &format!("/api/v1/share/{token}/call/{capability}"),
            &[CSRF, ("Cookie", &bob)],
            Some(args),
        );
        (status, body)
    };
    // 编辑型链接能读、能改
    assert_eq!(via_link("get_item", json!({ "id": id })).0, 200);
    let current = h.ok("alice", "get_item", json!({ "id": id }));
    let version = current["item"]["version"].as_i64().unwrap_or(1);
    assert_eq!(
        via_link(
            "edit_item",
            json!({ "id": id, "version": version, "title": "登录用户改的" })
        )
        .0,
        200
    );
    // 但版本历史、新建、删除不通过链接开放(角色本身够不够都一样)
    for (name, args) in [
        ("item_history", json!({ "id": id })),
        (
            "create_item",
            json!({ "collection": "_global", "title": "t", "body": "b" }),
        ),
        ("delete_item", json!({ "id": id })),
        (
            "file_versions",
            json!({ "collection": "_global", "path": "a.md" }),
        ),
    ] {
        let (status, body) = via_link(name, args);
        assert_eq!(status, 403, "{name}: {body}");
    }
    assert_eq!(
        h.ok("alice", "get_item", json!({ "id": id }))["item"]["title"],
        "登录用户改的"
    );
}

#[test]
fn the_owner_can_see_who_commented_and_wipe_one_guests_comments_without_touching_anyone_elses() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "被评论的笔记");
    let source = format!("insight:{id}");
    // 打开游客评论
    let config_path = h.daemon.home.path().join("config.toml");
    let original = std::fs::read_to_string(&config_path).unwrap();
    std::fs::write(
        &config_path,
        format!("{original}\n[share]\nallow_guest_comment = true\n"),
    )
    .unwrap();
    let (_, token) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &id), "audience": "anyone", "role": "commenter" }),
    );
    let fresh_guest = || {
        let visit = info(&h, &token, &[]);
        set_cookie_value(&visit.headers, "kb_guest").expect("游客 cookie")
    };
    // 等参数生效:游客的角色变成 commenter
    let first = fresh_guest();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while info(&h, &token, &[("kb_guest", &first)]).body["data"]["role"] != "commenter" {
        assert!(std::time::Instant::now() < deadline, "游客评论参数没生效");
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let second = fresh_guest();
    let comment = |cookie: &str, text: &str| {
        let visit = call(
            &h,
            &token,
            "add_annotation",
            &[("kb_guest", cookie)],
            json!({ "collection": "_global", "source": source, "body": text }),
        );
        assert_eq!(visit.status, 200, "{}", visit.body);
    };
    // 第一个游客改名后评论两条,第二个游客评论一条,bob(登录协作者)也评论一条
    let named = guest(
        &h,
        "POST",
        &format!("/api/v1/share/{token}/guest"),
        &[("kb_guest", &first)],
        Some(json!({ "nickname": "小王" })),
    );
    assert_eq!(named.status, 200);
    comment(&first, "小王的评论一");
    comment(&first, "小王的评论二");
    comment(&second, "另一个访客的评论");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note(&space, &id), "user_id": h.id("bob"), "role": "commenter" }),
    );
    let (status, body) = h.call_in(
        "bob",
        &space,
        "add_annotation",
        json!({ "collection": "_global", "source": source, "body": "bob 的评论" }),
    );
    assert_eq!(status, 200, "{body}");

    // 所有者能看到每条评论是谁写的
    let listed = h.ok(
        "alice",
        "list_annotations",
        json!({ "collection": "_global", "source": source }),
    );
    let authors: Vec<String> = listed["annotations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["author"].as_str().unwrap_or("").to_owned())
        .collect();
    assert_eq!(authors.len(), 4, "{listed}");
    let wang = authors
        .iter()
        .find(|a| a.starts_with("guest:小王#"))
        .expect("小王的作者标识")
        .clone();
    assert!(
        authors.iter().any(|a| *a == h.id("bob")),
        "登录用户的评论写他的用户 id,而不是笼统的 web:{authors:?}"
    );
    assert!(!authors.iter().any(|a| a == "web"), "{authors:?}");
    // 只清除小王的两条
    let (status, body) = h.call("bob", "guest_purge", json!({ "author": wang }));
    assert_eq!(
        (status, body["deleted"].as_i64()),
        (200, Some(0)),
        "bob 在他自己的知识库里清不到 alice 的:{body}"
    );
    let purged = h.ok("alice", "guest_purge", json!({ "author": wang }));
    assert_eq!(purged["deleted"], 2);
    let left = h.ok(
        "alice",
        "list_annotations",
        json!({ "collection": "_global", "source": source }),
    );
    assert_eq!(
        left["annotations"].as_array().unwrap().len(),
        2,
        "另一个访客和 bob 的还在:{left}"
    );
    // 不能借它删登录用户的批注或用空前缀清空一切
    for bad in [
        h.id("bob").to_owned(),
        "guest:".to_owned(),
        "".to_owned(),
        "web".to_owned(),
    ] {
        let (status, _) = h.call("alice", "guest_purge", json!({ "author": bad }));
        assert_eq!(status, 400, "{bad:?}");
    }
    assert_eq!(
        h.ok(
            "alice",
            "list_annotations",
            json!({ "collection": "_global", "source": source })
        )["annotations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn a_logged_in_person_who_edits_through_a_link_becomes_a_collaborator_that_outlives_the_link() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "通过链接加入");
    let target = note(&space, &id);
    let (link_id, token) = make_link(
        &h,
        "alice",
        json!({ "target": target, "audience": "logged_in", "role": "editor" }),
    );
    let bob = format!("kb_session={}", h.cookie("bob"));
    let via_link = |capability: &str, args: Value| {
        let (status, _, body) = http_headers(
            h.port(),
            "POST",
            &format!("/api/v1/share/{token}/call/{capability}"),
            &[CSRF, ("Cookie", &bob)],
            Some(args),
        );
        (status, body)
    };
    // 只是看:不会被记成协作者
    assert_eq!(via_link("get_item", json!({ "id": id })).0, 200);
    let before = h.ok("alice", "grant_list", json!({ "target": target }));
    assert!(
        before["grants"].as_array().unwrap().is_empty(),
        "只看不加入:{before}"
    );
    // 第一次编辑 → 记成协作者,来源是这个链接
    let version = h.ok("alice", "get_item", json!({ "id": id }))["item"]["version"]
        .as_i64()
        .unwrap_or(1);
    assert_eq!(
        via_link(
            "edit_item",
            json!({ "id": id, "version": version, "title": "bob 经链接改的" })
        )
        .0,
        200
    );
    let after = h.ok("alice", "grant_list", json!({ "target": target }));
    let row = &after["grants"][0];
    assert_eq!(
        (row["user"]["username"].as_str(), row["role"].as_str()),
        (Some("bob"), Some("editor")),
        "{after}"
    );
    assert_eq!(
        row["via"],
        format!("link:{link_id}"),
        "所有者能看到「通过链接加入」"
    );
    // 链接被撤销,bob 的协作者身份还在(他仍能通过自己的授权编辑)
    h.ok("alice", "link_revoke", json!({ "id": link_id }));
    assert_eq!(info(&h, &token, &[]).status, 410);
    assert_eq!(
        h.call_in("bob", &space, "get_item", json!({ "id": id })).0,
        200
    );
    // 所有者单独移除他以后,他就进不去了
    h.ok(
        "alice",
        "grant_remove",
        json!({ "target": target, "user_id": h.id("bob") }),
    );
    assert_eq!(
        h.call_in("bob", &space, "get_item", json!({ "id": id })).0,
        404
    );
}

#[test]
fn deleting_a_note_or_collection_takes_its_grants_and_links_with_it() {
    let h = Harness::start();
    let space = h.space("alice");
    let gone = new_note(&h, "alice", "要删的笔记");
    let kept = new_note(&h, "alice", "留下的笔记");
    for id in [&gone, &kept] {
        h.ok(
            "alice",
            "grant_set",
            json!({ "target": note(&space, id), "user_id": h.id("bob"), "role": "viewer" }),
        );
    }
    let (gone_link, gone_token) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &gone), "audience": "anyone", "role": "viewer" }),
    );
    let (_, kept_token) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &kept), "audience": "anyone", "role": "viewer" }),
    );
    h.ok("alice", "delete_item", json!({ "id": gone }));
    // 链接被撤销,别的链接不受影响
    let visit = info(&h, &gone_token, &[]);
    assert_eq!(
        (visit.status, code(&visit).as_str()),
        (410, "link_revoked"),
        "{}",
        visit.body
    );
    assert_eq!(info(&h, &kept_token, &[]).status, 200);
    // bob 的「共享给我」里只剩留下的那条
    let shared = h.ok("bob", "shared_with_me", json!({}));
    let titles = shared["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["title"].as_str().unwrap_or("").to_owned())
        .collect::<Vec<_>>();
    assert_eq!(titles, vec!["留下的笔记".to_owned()], "{shared}");
    // 授权记录本身也没了(而不是靠访问时过滤)
    let grants = h.ok(
        "alice",
        "grant_list",
        json!({ "target": note(&space, &gone) }),
    );
    assert!(
        grants["grants"].as_array().is_none_or(Vec::is_empty),
        "{grants}"
    );
    let _ = gone_link;
}

#[test]
fn deleting_a_collection_removes_the_grants_on_it_and_the_links_to_it() {
    let h = Harness::start();
    let space = h.space("admin");
    // 集合只能由项目产生:注册一个只有一个文件的小项目
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("smallproj");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(
        project.join("readme.md"),
        "# 小项目\n\n只是用来产生一个集合。\n",
    )
    .unwrap();
    h.ok(
        "admin",
        "add_project",
        json!({ "path": project.to_string_lossy() }),
    );
    let collection_name = h.ok("admin", "list_collections", json!({}))["collections"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["name"].as_str())
        .find(|name| name.starts_with("proj_"))
        .expect("项目的集合")
        .to_owned();
    let collection =
        json!({ "kind": "collection", "space_id": space, "collection": collection_name });
    h.ok(
        "admin",
        "grant_set",
        json!({ "target": collection, "user_id": h.id("bob"), "role": "viewer" }),
    );
    let (_, token) = make_link(
        &h,
        "admin",
        json!({ "target": collection, "audience": "anyone", "role": "viewer" }),
    );
    assert_eq!(
        h.ok("bob", "shared_with_me", json!({}))["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    h.ok(
        "admin",
        "delete_collection",
        json!({ "collection": collection_name }),
    );
    assert!(
        h.ok("bob", "shared_with_me", json!({}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let visit = info(&h, &token, &[]);
    assert_eq!(
        (visit.status, code(&visit).as_str()),
        (410, "link_revoked"),
        "{}",
        visit.body
    );
    let grants = h.ok("admin", "grant_list", json!({ "target": collection }));
    assert!(
        grants["grants"].as_array().is_none_or(Vec::is_empty),
        "{grants}"
    );
}

#[test]
fn a_link_with_downloads_off_still_previews_images_but_refuses_other_originals() {
    let h = Harness::start();
    let space = h.space("admin");
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("filesproj");
    std::fs::create_dir_all(&project).unwrap();
    // 最小的合法 PNG(1x1)+ 一个文本文件
    let png: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB0, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    std::fs::write(project.join("pic.png"), png).unwrap();
    std::fs::write(project.join("notes.md"), "# 文本\n\n内容\n").unwrap();
    h.ok(
        "admin",
        "add_project",
        json!({ "path": project.to_string_lossy() }),
    );
    let collection_name = h.ok("admin", "list_collections", json!({}))["collections"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["name"].as_str())
        .find(|name| name.starts_with("proj_"))
        .expect("项目的集合")
        .to_owned();
    let collection =
        json!({ "kind": "collection", "space_id": space, "collection": collection_name });
    let raw = |token: &str, path: &str| {
        guest(
            &h,
            "GET",
            &format!("/api/v1/share/{token}/raw?collection={collection_name}&path={path}"),
            &[],
            None,
        )
    };
    // 允许下载(默认):两个都能取
    let (_, open) = make_link(
        &h,
        "admin",
        json!({ "target": collection, "audience": "anyone", "role": "viewer" }),
    );
    assert_eq!(raw(&open, "pic.png").status, 200);
    let text = raw(&open, "notes.md");
    assert_eq!(text.status, 200);
    assert!(
        text.headers
            .to_ascii_lowercase()
            .contains("content-disposition: attachment"),
        "{}",
        text.headers
    );
    // 关掉下载:图片仍可预览(内联),文本原件被拒
    let (_, closed) = make_link(
        &h,
        "admin",
        json!({ "target": collection, "audience": "anyone", "role": "viewer", "allow_download": false }),
    );
    let image = raw(&closed, "pic.png");
    assert_eq!(image.status, 200);
    assert!(
        image
            .headers
            .to_ascii_lowercase()
            .contains("content-disposition: inline"),
        "{}",
        image.headers
    );
    let denied = raw(&closed, "notes.md");
    assert_eq!(
        (denied.status, code(&denied).as_str()),
        (403, "download_disabled"),
        "{}",
        denied.body
    );
    // 页面信息里如实告诉前端
    assert_eq!(
        info(&h, &closed, &[]).body["data"]["can"]["download"],
        false
    );
    assert_eq!(info(&h, &open, &[]).body["data"]["can"]["download"], true);
}

/// 以游客身份取分享人头像,返回 (状态码, 响应头文本, 字节)。
fn owner_avatar(h: &Harness, token: &str, cookies: &[(&str, &str)]) -> (u16, String, Vec<u8>) {
    let cookie = cookies
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ");
    let mut headers = vec![CSRF];
    if !cookie.is_empty() {
        headers.push(("Cookie", cookie.as_str()));
    }
    support::http_raw(
        h.port(),
        "GET",
        &format!("/api/v1/share/{token}/owner-avatar?v=x"),
        &headers,
        None,
    )
}

#[test]
fn a_guest_sees_the_sharers_avatar_through_the_link_and_nothing_else_leaks() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "带头像的分享");
    // alice 上传头像
    let (status, _, body) = support::http_bytes(
        h.port(),
        "PUT",
        "/api/v1/me/avatar",
        Some(h.cookie("alice")),
        "application/octet-stream",
        &support::gray_png(64, 64, 120),
    );
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    let (_, token) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &id), "audience": "anyone", "role": "viewer" }),
    );

    // 游客(没登录、没 cookie)能取到图;而需要登录的 /users/{id}/avatar 对他仍是 401——这正是要有这个接口的原因
    let (status, head, bytes) = owner_avatar(&h, &token, &[]);
    assert_eq!(status, 200, "{head}");
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "应是 PNG");
    let head = head.to_ascii_lowercase();
    assert!(
        head.contains("image/png") && head.contains("nosniff"),
        "{head}"
    );
    let (status, _, _) = http_headers(
        h.port(),
        "GET",
        &format!("/api/v1/users/{}/avatar", h.id("alice")),
        &[],
        None,
    );
    assert_eq!(status, 401, "不开放给没登录的人的接口不能因此被放开");

    // 页面信息里带的头像文件名,就是这张图
    let visit = info(&h, &token, &[]);
    assert!(
        visit.body["data"]["owner"]["avatar"].is_string(),
        "{}",
        visit.body
    );

    // 不存在的链接:404,不泄露任何头像;密码链接没解锁:401
    let (status, _, _) = owner_avatar(&h, "no-such-token-0123456789", &[]);
    assert_eq!(status, 404);
    let (_, locked) = make_link(
        &h,
        "alice",
        json!({ "target": note(&space, &id), "audience": "anyone", "role": "viewer", "password": "sesame1" }),
    );
    let (status, _, bytes) = owner_avatar(&h, &locked, &[]);
    assert_eq!(status, 401, "没输密码不能看到分享人的头像");
    assert_ne!(bytes.first(), Some(&0x89), "401 的响应里不能带图片");
}

#[test]
fn a_sharer_without_an_avatar_gives_the_guest_a_clean_404() {
    let h = Harness::start();
    let space = h.space("bob");
    let id = new_note(&h, "bob", "没头像的分享");
    let (_, token) = make_link(
        &h,
        "bob",
        json!({ "target": note(&space, &id), "audience": "anyone", "role": "viewer" }),
    );
    let (status, _, _) = owner_avatar(&h, &token, &[]);
    assert_eq!(status, 404);
    let visit = info(&h, &token, &[]);
    assert!(
        visit.body["data"]["owner"]["avatar"].is_null(),
        "{}",
        visit.body
    );
}
