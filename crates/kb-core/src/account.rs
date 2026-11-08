//! 账号模型(多用户设计说明)。
//!
//! 只放数据结构和校验规则,不碰数据库;持久化在 `kb-meta` 的 `SystemStore`。
//! `User` 刻意**不含**密码哈希:它会被序列化给前端和审计,哈希只经 `SystemStore::password_hash` 单独读取。

use serde::{Deserialize, Serialize};

use crate::error::{KbError, Result};
use crate::model::Millis;

/// 主知识库的 id。
///
/// 主知识库就是 `KB_HOME` 根目录本身(`meta.db`、`lance/`、`sources/` 都在根目录),
/// 第一个管理员拥有它;其他用户的知识库在 `spaces/<id>/`。这样已有数据不用搬家,
/// 旧测试和脚本依赖的路径不变,回滚也只是删掉 `system.db`。本机 `kb.sock` 超级用户也落在这里。
pub const PRIMARY_SPACE_ID: &str = "sp_primary";

/// 内置管理员角色 id。
pub const ROLE_ADMIN: &str = "role_admin";
/// 内置普通用户角色 id。
pub const ROLE_USER: &str = "role_user";

/// 账号状态（设计规范）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserStatus {
    /// 正常。
    Active,
    /// 管理员建的账号还没验证邮箱:能登录,但不能分享、不能找回密码。
    PendingEmail,
    /// 管理员停用:不能登录,会话立即失效,数据保留。
    Disabled,
    /// 用户申请注销,冷静期内可撤销。
    Deleting,
}

impl UserStatus {
    /// 库里的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::PendingEmail => "pending_email",
            Self::Disabled => "disabled",
            Self::Deleting => "deleting",
        }
    }

    /// 从库里的字符串解析。
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "active" => Ok(Self::Active),
            "pending_email" => Ok(Self::PendingEmail),
            "disabled" => Ok(Self::Disabled),
            "deleting" => Ok(Self::Deleting),
            other => Err(KbError::Internal(format!("未知账号状态:{other}"))),
        }
    }

    /// 这个状态下能不能登录和使用。
    pub fn can_sign_in(self) -> bool {
        matches!(self, Self::Active | Self::PendingEmail | Self::Deleting)
    }
}

/// 用户。**不含密码哈希**。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct User {
    /// `usr_<uuid7>`。
    pub id: String,
    /// 登录名,小写,3–20 位 `[a-z0-9_]`。
    pub username: String,
    /// 规范化后的邮箱(小写),可空。
    pub email: Option<String>,
    /// 邮箱验证时间。
    pub email_verified_at: Option<Millis>,
    /// 显示名。
    pub display_name: String,
    /// 头像文件名(`<KB_HOME>/avatars/` 下)。
    pub avatar: Option<String>,
    /// 系统角色 id。
    pub role_id: String,
    /// 状态。
    pub status: UserStatus,
    /// 隐私设置(JSON 文本)。
    pub privacy_json: String,
    /// 覆盖角色的配额(JSON 文本,只写要覆盖的键)。
    pub quota_json: String,
    /// 下次登录必须改密码(管理员代建账号用)。
    pub must_change_password: bool,
    /// 怎么来的:`email` / `invite:<id>` / `admin` / `migrated`。
    pub registered_via: String,
    /// 创建时间。
    pub created_at: Millis,
    /// 最近登录。
    pub last_login_at: Option<Millis>,
    /// 注销生效时间(冷静期结束)。
    pub delete_after: Option<Millis>,
}

/// 新建用户的参数。密码哈希由调用方(kb-web 的 argon2)算好传入。
#[derive(Clone, Debug)]
pub struct NewUser {
    /// 登录名(会被规范化为小写)。
    pub username: String,
    /// 邮箱(会被规范化)。
    pub email: Option<String>,
    /// 显示名;为空时用登录名。
    pub display_name: Option<String>,
    /// argon2id 哈希。
    pub password_hash: String,
    /// 角色 id。
    pub role_id: String,
    /// 初始状态。
    pub status: UserStatus,
    /// 来源标记。
    pub registered_via: String,
    /// 首次登录必须改密码。
    pub must_change_password: bool,
    /// 邮箱已验证(注册流程验证过验证码时为真)。
    pub email_verified: bool,
}

/// 角色。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Role {
    /// `role_admin` / `role_user` / `role_<uuid7>`。
    pub id: String,
    /// 名字。
    pub name: String,
    /// 说明。
    pub description: String,
    /// 内置角色不能删。
    pub builtin: bool,
    /// 拥有全部功能(含以后新增的)。
    pub all_features: bool,
    /// 允许授予危险(系统级)功能。
    pub dangerous: bool,
    /// 配额(JSON 文本),覆盖系统参数里的默认值。
    pub quota_json: String,
    /// 勾选的功能点。
    pub features: Vec<String>,
    /// 创建时间。
    pub created_at: Millis,
    /// 更新时间。
    pub updated_at: Millis,
}

/// 知识库种类。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpaceKind {
    /// 个人知识库,每个用户一个。
    Personal,
    /// 团队知识库(数据模型预留)。
    Team,
}

impl SpaceKind {
    /// 库里的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Team => "team",
        }
    }

    /// 从库里的字符串解析。
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "personal" => Ok(Self::Personal),
            "team" => Ok(Self::Team),
            other => Err(KbError::Internal(format!("未知知识库种类:{other}"))),
        }
    }
}

/// 知识库(数据隔离单位,对应磁盘上的 `spaces/<id>/`)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Space {
    /// `sp_<uuid7>`。
    pub id: String,
    /// 所有者。
    pub owner_id: String,
    /// 名字。
    pub name: String,
    /// 种类。
    pub kind: SpaceKind,
    /// 已用存储(字节,定时统计)。
    pub storage_bytes: i64,
    /// 创建时间。
    pub created_at: Millis,
}

/// 一个知识库占用的磁盘空间,按「用户看得见 / 看不见」分开列。
///
/// 向量索引是用户看不见的那部分(约为原文的 2–5 倍),也计入配额,所以必须单独列出来,
/// 否则用户会奇怪「我才传了 10 GB 怎么说满了」。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceUsage {
    /// 上传后落在 `sources/` 的原始文件。
    pub sources_bytes: u64,
    /// 还没处理完的上传分片(`uploads/`)。
    pub uploads_bytes: u64,
    /// 向量与全文索引(`lance/`)。
    pub vectors_bytes: u64,
    /// 元数据库(`meta.db` 及其日志文件)。
    pub meta_bytes: u64,
    /// 代理工作目录(`agent-workspace/`):外部编码代理在里面读写的文件,计入配额。
    pub workspace_bytes: u64,
}

impl SpaceUsage {
    /// 合计,配额按它算。
    pub fn total(&self) -> u64 {
        self.sources_bytes
            .saturating_add(self.uploads_bytes)
            .saturating_add(self.vectors_bytes)
            .saturating_add(self.meta_bytes)
            .saturating_add(self.workspace_bytes)
    }
}

/// 登录会话(带用户)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserSession {
    /// 令牌 sha256。
    pub token_hash: String,
    /// 用户。
    pub user_id: String,
    /// 创建时间。
    pub created_at: Millis,
    /// 过期时间。
    pub expires_at: Millis,
    /// 最近访问。
    pub last_seen: Millis,
    /// 登录来源 IP。
    pub ip: Option<String>,
    /// User-Agent。
    pub user_agent: Option<String>,
}

/// 个人访问令牌(属于某个用户)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserToken {
    /// 主键。
    pub id: String,
    /// 所属用户。
    pub user_id: String,
    /// 名字(同一用户下唯一)。
    pub name: String,
    /// 令牌 sha256。
    #[serde(skip_serializing)]
    pub token_hash: String,
    /// `mcp` 或 `api`。
    pub scopes: String,
    /// MCP 是否包含「共享给我」的文档(默认不含,防止 AI 工具把别人的文档带进上下文)。
    pub include_shared: bool,
    /// 创建时间。
    pub created_at: Millis,
    /// 最近使用。
    pub last_used: Option<Millis>,
    /// 撤销时间。
    pub revoked_at: Option<Millis>,
}

/// 用户的 admin key(明文,一人一把)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserAdminKey {
    /// 所属用户。
    pub user_id: String,
    /// `kb_ak_…` 明文。
    pub admin_key: String,
    /// 首次发放时间。
    pub created_at: Millis,
    /// 最近一次轮换;从没轮换过是 `None`。
    pub rotated_at: Option<Millis>,
}

/// 系统审计里的一条。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemAuditEntry {
    /// 自增 id。
    pub id: i64,
    /// 时间。
    pub at: Millis,
    /// 操作者(用户 id,空 = 系统 / 本机)。
    pub user_id: Option<String>,
    /// 动作,如 `login` / `user.create` / `role.update`。
    pub action: String,
    /// 对象。
    pub target: Option<String>,
    /// 细节(JSON 文本)。
    pub detail_json: String,
    /// 来源 IP。
    pub ip: Option<String>,
}

/// 规范化登录名:去空白、转小写;不合法返回 `InvalidInput`。
pub fn normalize_username(raw: &str) -> Result<String> {
    let name = raw.trim().to_ascii_lowercase();
    let valid = (3..=20).contains(&name.len())
        && name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_');
    if !valid {
        return Err(KbError::InvalidInput(
            "用户名需要 3–20 位,只能用字母、数字或下划线".to_owned(),
        ));
    }
    // 保留名:避免和路由、系统账号混淆
    const RESERVED: &[&str] = &["root", "system", "local", "guest", "anonymous", "null"];
    if RESERVED.contains(&name.as_str()) {
        return Err(KbError::InvalidInput(format!("用户名 {name} 是保留名")));
    }
    Ok(name)
}

/// 规范化邮箱:去空白、转小写;只做形状检查(真正的有效性靠验证码)。
pub fn normalize_email(raw: &str) -> Result<String> {
    let email = raw.trim().to_ascii_lowercase();
    let mut parts = email.split('@');
    let (local, domain) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let ok = parts.next().is_none()
        && !local.is_empty()
        && local.len() <= 64
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && email.len() <= 254
        && !email
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control());
    if !ok {
        return Err(KbError::InvalidInput("邮箱格式不对".to_owned()));
    }
    Ok(email)
}

/// 邮箱验证码的用途。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmailPurpose {
    /// 注册。
    Register,
    /// 找回密码。
    Reset,
    /// 换邮箱(验证新邮箱)。
    ChangeEmail,
}

impl EmailPurpose {
    /// 库里的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Register => "register",
            Self::Reset => "reset",
            Self::ChangeEmail => "change_email",
        }
    }
}

/// 邀请码(明文只在创建时出现一次;库里只有哈希和前缀)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteCode {
    /// 主键。
    pub id: String,
    /// 前缀(如 `KB-7H2K`),管理员认人用。
    pub prefix: String,
    /// 谁创建的(用户 id;本机 / 管理员 CLI 为空)。
    pub created_by: Option<String>,
    /// 备注。
    pub note: String,
    /// 最多用几次。
    pub max_uses: i64,
    /// 已用几次。
    pub used: i64,
    /// 过期时间。
    pub expires_at: Option<Millis>,
    /// 用它注册后的角色;空 = 系统默认角色。
    pub role_id: Option<String>,
    /// 用它注册后的配额覆盖(JSON)。
    pub quota_json: String,
    /// 用它注册的人自动和邀请人(`created_by`)互为好友。
    pub auto_friend: bool,
    /// 撤销时间。
    pub revoked_at: Option<Millis>,
    /// 创建时间。
    pub created_at: Millis,
}

impl InviteCode {
    /// 现在还能不能用。
    pub fn usable(&self, now: Millis) -> bool {
        self.revoked_at.is_none()
            && self.used < self.max_uses
            && self.expires_at.is_none_or(|at| at > now)
    }
}

/// 邀请码字母表:去掉容易看混的 `0 O 1 I L`,31 个符号,8 位约 39.6 bit。
const INVITE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// 生成邀请码 `KB-XXXX-XXXX`。
pub fn generate_invite_code() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    let mut pick = || INVITE_ALPHABET[rng.random_range(0..INVITE_ALPHABET.len())] as char;
    let first: String = (0..4).map(|_| pick()).collect();
    let second: String = (0..4).map(|_| pick()).collect();
    format!("KB-{first}-{second}")
}

/// 把用户输入的邀请码规范成 `KB-XXXX-XXXX`:大写、去掉空格和横线再按格式补回。
/// 长度不对返回 `None`。
pub fn normalize_invite_code(input: &str) -> Option<String> {
    let letters: String = input
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_uppercase())
        .collect();
    let body = letters.strip_prefix("KB").unwrap_or(&letters);
    (body.len() == 8 && body.bytes().all(|byte| INVITE_ALPHABET.contains(&byte)))
        .then(|| format!("KB-{}-{}", &body[..4], &body[4..]))
}

/// 邀请码前缀(`KB-7H2K`)。
pub fn invite_prefix(code: &str) -> String {
    code.chars().take(7).collect()
}

/// 生成 6 位数字验证码(均匀分布,允许前导 0)。
pub fn generate_email_code() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    (0..6)
        .map(|_| char::from(b'0' + rng.random_range(0..10u8)))
        .collect()
}

/// 验证码 / 邀请码入库用的哈希:`sha256(pepper | 用途 | 邮箱 | 码)`。
///
/// 带 pepper(服务器私有、存在库外的设置里不会被导出)和邮箱、用途,所以:
/// 1. 只拿到库的人无法离线穷举(6 位数字只有一百万种);
/// 2. 一个邮箱的验证码不能拿去验证另一个邮箱,注册的码不能拿去找回密码。
pub fn hash_code(pepper: &str, purpose: &str, email: &str, code: &str) -> String {
    crate::token::sha256_hex(&format!("{pepper}\u{1f}{purpose}\u{1f}{email}\u{1f}{code}"))
}

/// 验证码是不是 6 位数字(不合格的直接拒绝,不进库查询)。
pub fn looks_like_email_code(input: &str) -> bool {
    input.len() == 6 && input.bytes().all(|byte| byte.is_ascii_digit())
}

/// 密码强度:至少 8 位,不能是常见弱口令,不能全是同一种字符。返回提示文案。
pub fn check_password_strength(
    password: &str,
    username: &str,
) -> std::result::Result<(), &'static str> {
    const COMMON: &[&str] = &[
        "12345678",
        "123456789",
        "1234567890",
        "password",
        "password1",
        "qwertyui",
        "qwerty123",
        "11111111",
        "00000000",
        "88888888",
        "abcd1234",
        "iloveyou",
        "admin123",
        "12341234",
        "1q2w3e4r",
        "asdfghjk",
        "zxcvbnm1",
        "a1234567",
        "aa123456",
        "123123123",
        "987654321",
    ];
    let length = password.chars().count();
    if length < 8 {
        return Err("密码至少 8 位");
    }
    if length > 128 {
        return Err("密码最多 128 位");
    }
    let lower = password.to_lowercase();
    if COMMON.contains(&lower.as_str()) {
        return Err("这个密码太常见了,换一个");
    }
    if !username.is_empty() && lower == username.to_lowercase() {
        return Err("密码不能和用户名相同");
    }
    let first = password.chars().next().unwrap_or(' ');
    if password.chars().all(|ch| ch == first) {
        return Err("密码不能全是同一个字符");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames_are_normalized_and_validated() {
        assert_eq!(normalize_username(" User_Yi01 ").unwrap(), "user_yi01");
        for bad in [
            "ab",
            "a b c",
            "名字好",
            "x".repeat(21).as_str(),
            "has-dash",
            "root",
            "Guest",
        ] {
            assert!(normalize_username(bad).is_err(), "应拒绝:{bad}");
        }
    }

    #[test]
    fn emails_are_normalized_and_validated() {
        assert_eq!(
            normalize_email(" User@Example.com ").unwrap(),
            "user@example.com"
        );
        for bad in [
            "",
            "no-at",
            "a@b",
            "a@@b.com",
            "@b.com",
            "a b@c.com",
            "a@.com",
            "a@b.",
        ] {
            assert!(normalize_email(bad).is_err(), "应拒绝:{bad}");
        }
    }

    #[test]
    fn status_round_trips_and_gates_sign_in() {
        for status in [
            UserStatus::Active,
            UserStatus::PendingEmail,
            UserStatus::Disabled,
            UserStatus::Deleting,
        ] {
            assert_eq!(UserStatus::parse(status.as_str()).unwrap(), status);
        }
        assert!(UserStatus::parse("weird").is_err());
        assert!(!UserStatus::Disabled.can_sign_in());
        assert!(UserStatus::PendingEmail.can_sign_in());
    }

    #[test]
    fn user_json_never_contains_a_password() {
        let user = User {
            id: "usr_1".into(),
            username: "lin".into(),
            email: None,
            email_verified_at: None,
            display_name: "林".into(),
            avatar: None,
            role_id: ROLE_USER.into(),
            status: UserStatus::Active,
            privacy_json: "{}".into(),
            quota_json: "{}".into(),
            must_change_password: false,
            registered_via: "admin".into(),
            created_at: 1,
            last_login_at: None,
            delete_after: None,
        };
        let text = serde_json::to_string(&user).unwrap();
        assert!(
            !text.contains("password_hash") && !text.contains("argon"),
            "用户序列化不能带密码哈希:{text}"
        );
    }

    #[test]
    fn token_hash_is_not_serialized() {
        let token = UserToken {
            id: "t".into(),
            user_id: "u".into(),
            name: "n".into(),
            token_hash: "secret-hash".into(),
            scopes: "mcp".into(),
            include_shared: false,
            created_at: 1,
            last_used: None,
            revoked_at: None,
        };
        assert!(
            !serde_json::to_string(&token)
                .unwrap()
                .contains("secret-hash")
        );
    }

    #[test]
    fn invite_codes_have_the_planned_shape_and_normalize_back() {
        for _ in 0..200 {
            let code = generate_invite_code();
            assert_eq!(code.len(), 12, "{code}");
            assert!(
                code.starts_with("KB-") && code.as_bytes()[7] == b'-',
                "{code}"
            );
            assert!(!code.contains(['0', 'O', '1', 'I', 'L']), "易混字符:{code}");
            assert_eq!(normalize_invite_code(&code).as_deref(), Some(code.as_str()));
        }
        // 用户的各种写法都能规范回来
        assert_eq!(
            normalize_invite_code(" kb-7h2k-9qxm ").as_deref(),
            Some("KB-7H2K-9QXM")
        );
        assert_eq!(
            normalize_invite_code("7H2K9QXM").as_deref(),
            Some("KB-7H2K-9QXM")
        );
        assert_eq!(
            normalize_invite_code("kb 7h2k 9qxm").as_deref(),
            Some("KB-7H2K-9QXM")
        );
        for bad in [
            "",
            "KB-7H2K",
            "KB-7H2K-9QXM-1",
            "KB-0000-0000",
            "KB-OOOO-IIII",
        ] {
            assert_eq!(normalize_invite_code(bad), None, "{bad:?}");
        }
        assert_eq!(invite_prefix("KB-7H2K-9QXM"), "KB-7H2K");
    }

    #[test]
    fn email_codes_are_six_digits_and_hashes_are_bound_to_their_context() {
        for _ in 0..200 {
            assert!(looks_like_email_code(&generate_email_code()));
        }
        assert!(
            !looks_like_email_code("12345")
                && !looks_like_email_code("12345a")
                && !looks_like_email_code("１２３４５６")
        );
        let base = hash_code("pepper", "register", "a@b.com", "123456");
        assert_eq!(base, hash_code("pepper", "register", "a@b.com", "123456"));
        assert_ne!(
            base,
            hash_code("pepper", "reset", "a@b.com", "123456"),
            "注册的码不能拿去找回密码"
        );
        assert_ne!(
            base,
            hash_code("pepper", "register", "c@d.com", "123456"),
            "别人邮箱的码不能通用"
        );
        assert_ne!(
            base,
            hash_code("other", "register", "a@b.com", "123456"),
            "pepper 不同哈希不同"
        );
        assert_ne!(base, hash_code("pepper", "register", "a@b.com", "654321"));
    }

    #[test]
    fn weak_passwords_are_refused_with_a_reason() {
        for (password, reason) in [
            ("short", "至少 8 位"),
            ("password", "太常见"),
            ("12345678", "太常见"),
            ("aaaaaaaaaa", "同一个字符"),
            ("User_Yi01", "用户名相同"),
        ] {
            let err = check_password_strength(password, "user_yi01").unwrap_err();
            assert!(err.contains(reason), "{password}:{err}");
        }
        assert!(check_password_strength(&"x".repeat(129), "").is_err());
        for good in [
            "correct horse battery",
            "密码是一段很长的中文",
            "Tr0ub4dor&3",
        ] {
            assert!(check_password_strength(good, "lin").is_ok(), "{good}");
        }
    }

    #[test]
    fn invite_usability_covers_revoked_expired_and_exhausted() {
        let base = InviteCode {
            id: "i".into(),
            prefix: "KB-AAAA".into(),
            created_by: None,
            note: String::new(),
            max_uses: 2,
            used: 0,
            expires_at: Some(1_000),
            role_id: None,
            quota_json: "{}".into(),
            auto_friend: true,
            revoked_at: None,
            created_at: 0,
        };
        assert!(base.usable(999));
        assert!(!base.usable(1_000), "到期时刻即失效");
        assert!(
            !InviteCode {
                used: 2,
                ..base.clone()
            }
            .usable(1)
        );
        assert!(
            !InviteCode {
                revoked_at: Some(5),
                ..base.clone()
            }
            .usable(1)
        );
        assert!(
            InviteCode {
                expires_at: None,
                ..base
            }
            .usable(u64::MAX as i64 / 2)
        );
    }
}
