//! 会话:登录后签发 32 字节令牌,库里只存 sha256,7 天有效并滑动续期。
//!
//! 多用户起会话属于某个用户,存在 `system.db`;续期只在距离上次访问超过 [`RENEW_AFTER_MS`] 时才写库,
//! 否则每个请求都要写一次(热路径)。

use kb_core::Result;
use kb_core::account::{User, UserSession};
use kb_core::model::Millis;
use kb_core::ports::system::IdentityStore;

use super::token::{SESSION_TTL_MS, random_secret, sha256_hex};

/// 距离上次访问超过这么久才续期写库(5 分钟)。有效期是 7 天,5 分钟的误差可以忽略。
pub const RENEW_AFTER_MS: i64 = 5 * 60 * 1000;

/// 当前时间(Unix 毫秒)。
pub fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 为某个用户新建会话,返回**明文令牌**(只此一次)。
pub async fn create(
    system: &dyn IdentityStore,
    user_id: &str,
    ip: Option<String>,
    user_agent: Option<String>,
    now: Millis,
) -> Result<String> {
    let plaintext = random_secret();
    system
        .create_session(UserSession {
            token_hash: sha256_hex(&plaintext),
            user_id: user_id.to_owned(),
            created_at: now,
            expires_at: now + SESSION_TTL_MS,
            last_seen: now,
            ip,
            user_agent,
        })
        .await?;
    Ok(plaintext)
}

/// 校验会话令牌:不存在、已过期、用户被停用都返回 `None`;有效时(必要时)滑动续期。
pub async fn authenticate(
    system: &dyn IdentityStore,
    plaintext: &str,
    now: Millis,
) -> Result<Option<(UserSession, User)>> {
    let hash = sha256_hex(plaintext);
    let Some((mut session, user)) = system.session_user(&hash, now).await? else {
        return Ok(None);
    };
    if now - session.last_seen > RENEW_AFTER_MS {
        session.last_seen = now;
        session.expires_at = now + SESSION_TTL_MS;
        system
            .touch_session(&hash, session.last_seen, session.expires_at)
            .await?;
    }
    Ok(Some((session, user)))
}

/// 登出:删掉会话(重复登出不报错)。
pub async fn logout(system: &dyn IdentityStore, plaintext: &str) -> Result<()> {
    system.delete_session(&sha256_hex(plaintext)).await
}

/// 从 `Cookie` 头里取会话令牌。
pub fn cookie_token(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let (name, value) = part.split_once('=')?;
        if name.trim() == super::token::SESSION_COOKIE {
            let value = value.trim();
            if value.is_empty() {
                return None;
            }
            return Some(value.to_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::account::{NewUser, ROLE_USER, UserStatus};

    async fn store_with_user() -> (tempfile::TempDir, kb_meta::SystemStore, User) {
        let dir = tempfile::tempdir().expect("临时目录");
        let store = kb_meta::SystemStore::open(dir.path().join("system.db")).expect("打开");
        let (user, _) = store
            .create_user(NewUser {
                username: "sess_user".into(),
                email: None,
                display_name: None,
                password_hash: "$argon2id$x".into(),
                role_id: ROLE_USER.into(),
                status: UserStatus::Active,
                registered_via: "admin".into(),
                must_change_password: false,
                email_verified: false,
            })
            .await
            .expect("建用户");
        (dir, store, user)
    }

    #[tokio::test]
    async fn create_authenticate_logout_round_trip() {
        let (_dir, store, user) = store_with_user().await;
        let now = now_millis();
        let token = create(&store, &user.id, Some("1.2.3.4".into()), None, now)
            .await
            .unwrap();
        let (_, found) = authenticate(&store, &token, now)
            .await
            .unwrap()
            .expect("有效");
        assert_eq!(found.id, user.id, "会话解析回创建它的用户");
        assert!(
            authenticate(&store, "not-a-token", now)
                .await
                .unwrap()
                .is_none()
        );
        logout(&store, &token).await.unwrap();
        assert!(authenticate(&store, &token, now).await.unwrap().is_none());
        logout(&store, &token).await.expect("重复登出不报错");
    }

    #[tokio::test]
    async fn renewal_only_writes_after_the_renew_interval() {
        let (_dir, store, user) = store_with_user().await;
        let now = now_millis();
        let token = create(&store, &user.id, None, None, now).await.unwrap();
        let hash = sha256_hex(&token);
        // 刚登录就访问:不续期(省一次写)
        let (before, _) = store.session_user(&hash, now).await.unwrap().unwrap();
        authenticate(&store, &token, now + 1_000).await.unwrap();
        let (after, _) = store
            .session_user(&hash, now + 1_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(before.expires_at, after.expires_at, "间隔很短不该续期");
        // 过了续期间隔:有效期被推后
        authenticate(&store, &token, now + RENEW_AFTER_MS + 1)
            .await
            .unwrap();
        let (renewed, _) = store
            .session_user(&hash, now + RENEW_AFTER_MS + 1)
            .await
            .unwrap()
            .unwrap();
        assert!(renewed.expires_at > before.expires_at);
    }

    #[tokio::test]
    async fn expired_sessions_do_not_authenticate() {
        let (_dir, store, user) = store_with_user().await;
        let now = now_millis();
        let token = create(&store, &user.id, None, None, now).await.unwrap();
        assert!(
            authenticate(&store, &token, now + SESSION_TTL_MS + 1)
                .await
                .unwrap()
                .is_none()
        );
    }
}
