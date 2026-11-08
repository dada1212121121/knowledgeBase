//! 分享链接的类型与纯逻辑(多用户设计说明)。

use serde::{Deserialize, Serialize};

use crate::config::ShareConfig;
use crate::model::Millis;
use crate::share::Role;
use crate::{KbError, Result};

/// 链接令牌长度(128 位随机 → base64url 无填充 22 个字符)。
pub const TOKEN_LEN: usize = 22;
/// 访问密码长度范围。
pub const PASSWORD_LEN: std::ops::RangeInclusive<usize> = 4..=12;
/// 密码输错几次锁定。
pub const MAX_PASSWORD_FAILURES: u32 = 5;
/// 锁定多久(毫秒)。
pub const LOCKOUT_MS: i64 = 10 * 60_000;

/// 生成一个新的链接令牌。
pub fn new_token() -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 令牌格式是否合法(进入数据库查询之前先挡掉垃圾输入)。
pub fn looks_like_token(text: &str) -> bool {
    text.len() == TOKEN_LEN
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 谁能通过链接访问。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Audience {
    /// 仅协作者:链接只是个地址,没有额外权限。
    Collaborators,
    /// 登录用户。
    LoggedIn,
    /// 任何人,包括没登录的游客。
    Anyone,
}

impl Audience {
    /// 库里的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Collaborators => "collaborators",
            Self::LoggedIn => "logged_in",
            Self::Anyone => "anyone",
        }
    }

    /// 解析。
    pub fn parse(text: &str) -> Result<Self> {
        Ok(match text {
            "collaborators" => Self::Collaborators,
            "logged_in" => Self::LoggedIn,
            "anyone" => Self::Anyone,
            other => return Err(KbError::InvalidInput(format!("未知的访问范围 {other:?}"))),
        })
    }
}

/// 一条分享链接(不含令牌明文:库里只有哈希)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ShareLink {
    /// 主键。
    pub id: String,
    /// 令牌的最后 4 位,让所有者认得出是哪条(不足以还原令牌)。
    pub token_hint: String,
    /// 资源所在知识库。
    pub space_id: String,
    /// 单个资源的键;合集链接为 `None`,内容在 `items` 里。
    pub resource_key: Option<String>,
    /// 合集链接的名字。
    pub title: Option<String>,
    /// 谁能访问。
    pub audience: Audience,
    /// 链接给的角色。
    pub role: Role,
    /// 有没有访问密码(密码哈希不外泄)。
    pub has_password: bool,
    /// 过期时间。
    pub expires_at: Option<Millis>,
    /// 允许下载 / 复制 / 打印。
    pub allow_download: bool,
    /// 页面上显示水印。
    pub watermark: bool,
    /// 编辑者可再分享。
    pub allow_reshare: bool,
    /// 链接开着吗(关了可以再打开,设置保留)。
    pub enabled: bool,
    /// 打开次数。
    pub views: i64,
    /// 最近访问。
    pub last_view_at: Option<Millis>,
    /// 谁创建的。
    pub created_by: String,
    /// 创建时间。
    pub created_at: Millis,
    /// 彻底撤销的时间(撤销后不能恢复)。
    pub revoked_at: Option<Millis>,
}

/// 链接此刻的状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkState {
    /// 可以用。
    Active,
    /// 所有者关掉了(可再打开)。
    Closed,
    /// 过期了。
    Expired,
    /// 被撤销了。
    Revoked,
}

impl ShareLink {
    /// 链接在 `now` 的状态。
    pub fn state(&self, now: Millis) -> LinkState {
        if self.revoked_at.is_some() {
            LinkState::Revoked
        } else if self.expires_at.is_some_and(|at| at <= now) {
            LinkState::Expired
        } else if !self.enabled {
            LinkState::Closed
        } else {
            LinkState::Active
        }
    }
}

/// 游客在系统参数下最多能有的角色(管理员关掉某项后,已有链接按允许的最高级别降级生效)。
/// 没有任何一项允许时返回 `None`:游客完全不能用链接。
pub fn guest_ceiling(share: &ShareConfig) -> Option<Role> {
    if share.allow_guest_edit {
        Some(Role::Editor)
    } else if share.allow_guest_comment {
        Some(Role::Commenter)
    } else if share.allow_guest_view {
        Some(Role::Viewer)
    } else {
        None
    }
}

/// 一个访问者通过链接能拿到的角色。`logged_in` 表示访问者有没有登录。
///
/// - 链接已不可用(关闭 / 过期 / 撤销)→ `None`;
/// - `collaborators`:链接不给额外权限 → `None`(访问者靠自己的授权);
/// - `logged_in`:登录用户拿链接的角色,游客不行;
/// - `anyone`:登录用户拿链接的角色,游客拿 `min(链接角色, 系统参数允许的最高级别)`。
pub fn link_role(
    link: &ShareLink,
    logged_in: bool,
    share: &ShareConfig,
    now: Millis,
) -> Option<Role> {
    if link.state(now) != LinkState::Active {
        return None;
    }
    match link.audience {
        Audience::Collaborators => None,
        Audience::LoggedIn => logged_in.then_some(link.role),
        Audience::Anyone if logged_in => Some(link.role),
        Audience::Anyone => guest_ceiling(share).map(|ceiling| link.role.min(ceiling)),
    }
}

/// 校验访问密码的长度(4–12 位)。
pub fn check_password_shape(password: &str) -> Result<()> {
    let length = password.chars().count();
    if !PASSWORD_LEN.contains(&length) || password.chars().any(char::is_control) {
        return Err(KbError::InvalidInput(
            "访问密码需要 4–12 位,不能含控制字符".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(audience: Audience, role: Role) -> ShareLink {
        ShareLink {
            id: "lnk_1".into(),
            token_hint: "abcd".into(),
            space_id: "sp_1".into(),
            resource_key: Some("space:sp_1".into()),
            title: None,
            audience,
            role,
            has_password: false,
            expires_at: None,
            allow_download: true,
            watermark: false,
            allow_reshare: false,
            enabled: true,
            views: 0,
            last_view_at: None,
            created_by: "usr_1".into(),
            created_at: 0,
            revoked_at: None,
        }
    }

    fn share(view: bool, comment: bool, edit: bool) -> ShareConfig {
        ShareConfig {
            allow_guest_view: view,
            allow_guest_comment: comment,
            allow_guest_edit: edit,
            ..ShareConfig::default()
        }
    }

    #[test]
    fn tokens_are_22_url_safe_characters_and_never_repeat() {
        let a = new_token();
        let b = new_token();
        assert_ne!(a, b);
        assert!(looks_like_token(&a) && a.len() == TOKEN_LEN, "{a}");
        for bad in [
            "",
            "short",
            &"a".repeat(23),
            "has space 0123456789ab",
            "../../../etc/passwd0",
            "中文中文中文中文中文中文",
        ] {
            assert!(!looks_like_token(bad), "{bad:?}");
        }
    }

    #[test]
    fn states_follow_revocation_then_expiry_then_the_enabled_switch() {
        let mut l = link(Audience::Anyone, Role::Viewer);
        assert_eq!(l.state(10), LinkState::Active);
        l.enabled = false;
        assert_eq!(l.state(10), LinkState::Closed);
        l.expires_at = Some(10);
        assert_eq!(l.state(9), LinkState::Closed);
        assert_eq!(
            l.state(10),
            LinkState::Expired,
            "到点即过期,优先于「已关闭」"
        );
        l.revoked_at = Some(1);
        assert_eq!(l.state(0), LinkState::Revoked, "撤销优先于一切");
    }

    #[test]
    fn the_role_a_visitor_gets_depends_on_audience_login_and_guest_settings() {
        let defaults = ShareConfig::default(); // 游客:看 开 / 评论 关 / 编辑 关
        let all_on = share(true, true, true);
        let all_off = share(false, false, false);
        let editor_link = |a| link(a, Role::Editor);
        // 仅协作者:链接不给任何额外权限
        assert_eq!(
            link_role(&editor_link(Audience::Collaborators), true, &all_on, 0),
            None
        );
        // 登录用户可访问:游客拿不到
        assert_eq!(
            link_role(&editor_link(Audience::LoggedIn), true, &defaults, 0),
            Some(Role::Editor)
        );
        assert_eq!(
            link_role(&editor_link(Audience::LoggedIn), false, &all_on, 0),
            None
        );
        // 游客可访问:按系统参数降级
        assert_eq!(
            link_role(&editor_link(Audience::Anyone), false, &defaults, 0),
            Some(Role::Viewer),
            "默认只允许游客查看"
        );
        assert_eq!(
            link_role(
                &editor_link(Audience::Anyone),
                false,
                &share(true, true, false),
                0
            ),
            Some(Role::Commenter)
        );
        assert_eq!(
            link_role(&editor_link(Audience::Anyone), false, &all_on, 0),
            Some(Role::Editor)
        );
        assert_eq!(
            link_role(&editor_link(Audience::Anyone), false, &all_off, 0),
            None,
            "管理员关掉游客功能:已有链接对游客失效"
        );
        // 链接本身只给查看:参数再宽松也不会升级
        assert_eq!(
            link_role(&link(Audience::Anyone, Role::Viewer), false, &all_on, 0),
            Some(Role::Viewer)
        );
        // 登录用户走「anyone」链接不受游客参数限制
        assert_eq!(
            link_role(&editor_link(Audience::Anyone), true, &all_off, 0),
            Some(Role::Editor)
        );
        // 链接不可用:谁都没有
        let mut closed = editor_link(Audience::Anyone);
        closed.enabled = false;
        assert_eq!(link_role(&closed, true, &all_on, 0), None);
    }

    #[test]
    fn guest_ceiling_picks_the_highest_enabled_level_even_if_lower_ones_are_off() {
        assert_eq!(
            guest_ceiling(&share(true, false, false)),
            Some(Role::Viewer)
        );
        assert_eq!(
            guest_ceiling(&share(false, true, false)),
            Some(Role::Commenter)
        );
        assert_eq!(
            guest_ceiling(&share(false, false, true)),
            Some(Role::Editor)
        );
        assert_eq!(guest_ceiling(&share(false, false, false)), None);
    }

    #[test]
    fn passwords_must_be_4_to_12_printable_characters() {
        for ok in ["abcd", "123456789012", "密码1234"] {
            assert!(check_password_shape(ok).is_ok(), "{ok}");
        }
        for bad in ["", "abc", "1234567890123", "ab\ncd", "a\tbcd"] {
            assert!(check_password_shape(bad).is_err(), "{bad:?}");
        }
    }
}
