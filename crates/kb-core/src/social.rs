//! 好友与通知的共享类型(多用户设计说明)。

use serde::{Deserialize, Serialize};

use crate::model::Millis;

/// 好友申请附言最长字符数。
pub const MAX_REQUEST_MESSAGE: usize = 100;
/// 备注名最长字符数。
pub const MAX_REMARK: usize = 30;
/// 分组名最长字符数。
pub const MAX_GROUP: usize = 20;
/// 申请 7 天没人处理就过期。
pub const REQUEST_TTL_MS: i64 = 7 * 86_400_000;
/// 被拒绝后,24 小时内不能再申请同一个人。
pub const REJECT_COOLDOWN_MS: i64 = 24 * 3_600_000;
/// 同时最多挂着多少个自己发出的、还没人处理的申请(防止拿申请刷屏)。
pub const MAX_OUTGOING_PENDING: i64 = 20;
/// 通知保留 90 天。
pub const NOTIFICATION_KEEP_MS: i64 = 90 * 86_400_000;

/// 谁可以把文档分享给我。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShareFrom {
    /// 所有人。
    #[default]
    Everyone,
    /// 只有好友。
    Friends,
}

/// 隐私设置(存在 `users.privacy_json`)。缺的键一律按默认值,所以老账号不用迁移。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Privacy {
    /// 允许别人用完整邮箱搜到我。默认关:邮箱比用户名更敏感。
    #[serde(default)]
    pub searchable_by_email: bool,
    /// 允许别人用完整用户名搜到我。默认开。
    #[serde(default = "yes")]
    pub searchable_by_username: bool,
    /// 谁可以把文档分享给我。
    #[serde(default)]
    pub share_from: ShareFrom,
}

fn yes() -> bool {
    true
}

impl Default for Privacy {
    fn default() -> Self {
        Self {
            searchable_by_email: false,
            searchable_by_username: true,
            share_from: ShareFrom::Everyone,
        }
    }
}

impl Privacy {
    /// 从库里的 JSON 读;坏了或缺键都退回默认,不让一个手工改坏的字段挡住账号。
    pub fn parse(text: &str) -> Self {
        serde_json::from_str(text).unwrap_or_default()
    }
}

/// 别人能看到的一个人的资料(搜索结果、好友列表、申请列表)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicProfile {
    /// 用户 id。
    pub id: String,
    /// 登录名。
    pub username: String,
    /// 昵称。
    pub display_name: String,
    /// 头像文件名(没有就是 `None`,界面用首字母)。
    pub avatar: Option<String>,
}

/// 搜索结果里这个人和我的关系。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Relation {
    /// 没关系。
    None,
    /// 已经是好友。
    Friend,
    /// 我已经向他发了申请,还在等。
    PendingOut,
    /// 他向我发了申请,等我处理。
    PendingIn,
}

/// 好友申请的状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestState {
    /// 等待处理。
    Pending,
    /// 已通过。
    Accepted,
    /// 已拒绝。
    Rejected,
    /// 对方选了忽略(发起人看到的仍是「等待中」,不暴露)。
    Ignored,
    /// 过期。
    Expired,
}

impl RequestState {
    /// 库里的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Ignored => "ignored",
            Self::Expired => "expired",
        }
    }

    /// 从库里的字符串读。
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "pending" => Self::Pending,
            "accepted" => Self::Accepted,
            "rejected" => Self::Rejected,
            "ignored" => Self::Ignored,
            "expired" => Self::Expired,
            _ => return None,
        })
    }
}

/// 一条好友申请(带对方资料)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FriendRequest {
    /// 申请 id。
    pub id: String,
    /// 发起人 id。
    pub from_id: String,
    /// 接收人 id。
    pub to_id: String,
    /// 附言。
    pub message: Option<String>,
    /// 状态。
    pub state: RequestState,
    /// 发起时间。
    pub created_at: Millis,
    /// 过期时间。
    pub expires_at: Millis,
    /// 处理时间。
    pub decided_at: Option<Millis>,
}

/// 好友列表里的一行。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Friend {
    /// 对方资料。
    #[serde(flatten)]
    pub profile: PublicProfile,
    /// 我给他起的备注名。
    pub remark: Option<String>,
    /// 我给他分的组。
    pub group_name: Option<String>,
    /// 成为好友的时间。
    pub since: Millis,
}

/// 通知的种类。字符串写进库和推送,前端按它决定图标和跳转。
pub mod kind {
    /// 收到好友申请。
    pub const FRIEND_REQUEST: &str = "friend_request";
    /// 好友申请的结果(通过 / 拒绝)。
    pub const FRIEND_RESULT: &str = "friend_result";
    /// 收到分享。
    pub const SHARE_RECEIVED: &str = "share_received";
    /// 有人申请访问我的文档。
    pub const ACCESS_REQUEST: &str = "access_request";
    /// 访问申请的结果。
    pub const ACCESS_RESULT: &str = "access_result";
    /// 评论有回复。
    pub const COMMENT_REPLY: &str = "comment_reply";
    /// 被 @ 提到。
    pub const MENTION: &str = "mention";
    /// 被从协作者里移除。
    pub const COLLABORATOR_REMOVED: &str = "collaborator_removed";
    /// 分享链接快到期。
    pub const LINK_EXPIRING: &str = "link_expiring";
    /// 系统公告。
    pub const ANNOUNCEMENT: &str = "announcement";

    /// 全部种类(通知偏好页按这个顺序列)。
    pub const ALL: &[&str] = &[
        FRIEND_REQUEST,
        FRIEND_RESULT,
        SHARE_RECEIVED,
        ACCESS_REQUEST,
        ACCESS_RESULT,
        COMMENT_REPLY,
        MENTION,
        COLLABORATOR_REMOVED,
        LINK_EXPIRING,
        ANNOUNCEMENT,
    ];

    /// 中文名(邮件、通知偏好页用)。
    pub fn label(kind: &str) -> &'static str {
        match kind {
            FRIEND_REQUEST => "好友申请",
            FRIEND_RESULT => "好友申请结果",
            SHARE_RECEIVED => "收到分享",
            ACCESS_REQUEST => "访问申请",
            ACCESS_RESULT => "访问申请结果",
            COMMENT_REPLY => "评论回复",
            MENTION => "有人提到我",
            COLLABORATOR_REMOVED => "被移出协作者",
            LINK_EXPIRING => "分享链接即将到期",
            ANNOUNCEMENT => "系统公告",
            _ => "通知",
        }
    }

    /// 默认要不要同时发邮件:需要对方「马上知道并回应」的默认发,噪声大的默认不发。
    pub fn email_by_default(kind: &str) -> bool {
        matches!(
            kind,
            FRIEND_REQUEST | SHARE_RECEIVED | ACCESS_REQUEST | ACCESS_RESULT | MENTION
        )
    }
}

/// 一条站内通知。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Notification {
    /// 自增 id(也是翻页游标)。
    pub id: i64,
    /// 种类,见 [`kind`]。
    pub kind: String,
    /// 内容(各种类自己定义,只含展示和跳转需要的字段)。
    pub data: serde_json::Value,
    /// 已读时间。
    pub read_at: Option<Millis>,
    /// 产生时间。
    pub created_at: Millis,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privacy_defaults_are_conservative_and_survive_bad_json() {
        let default = Privacy::default();
        assert!(!default.searchable_by_email, "邮箱默认搜不到");
        assert!(default.searchable_by_username);
        assert_eq!(default.share_from, ShareFrom::Everyone);
        assert_eq!(Privacy::parse("{}"), default, "老账号的空对象 = 默认值");
        assert_eq!(Privacy::parse("这不是 json"), default);
        assert_eq!(
            Privacy::parse(r#"{"searchable_by_email": 5}"#),
            default,
            "类型错也退回默认"
        );
        let custom = Privacy::parse(r#"{"searchable_by_email": true, "share_from": "friends"}"#);
        assert!(custom.searchable_by_email && custom.searchable_by_username);
        assert_eq!(custom.share_from, ShareFrom::Friends);
    }

    #[test]
    fn request_states_round_trip() {
        for state in [
            RequestState::Pending,
            RequestState::Accepted,
            RequestState::Rejected,
            RequestState::Ignored,
            RequestState::Expired,
        ] {
            assert_eq!(RequestState::parse(state.as_str()), Some(state));
        }
        assert_eq!(RequestState::parse("nope"), None);
    }

    #[test]
    fn every_notification_kind_is_listed_once_and_email_defaults_are_the_actionable_ones() {
        let mut seen = std::collections::HashSet::new();
        for item in kind::ALL {
            assert!(seen.insert(*item), "重复:{item}");
        }
        assert!(kind::email_by_default(kind::FRIEND_REQUEST));
        assert!(kind::email_by_default(kind::ACCESS_REQUEST));
        assert!(!kind::email_by_default(kind::COMMENT_REPLY));
        assert!(!kind::email_by_default(kind::LINK_EXPIRING));
        assert!(!kind::email_by_default("unknown_kind"));
    }
}
