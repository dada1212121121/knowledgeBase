//! 身份域的端口(账号、角色、授权、访问链接、通知、注册、管理员密钥)。
//!
//! `system.db` 的实现(`kb_meta::SystemStore`)与消费者(`kb-web` / `kb-cli`)分在两个 crate:
//! 消费者只依赖这里的 trait,不依赖适配器 crate —— 这一层的意义就是把「多用户/权限」
//! 这条产品主线的**能力契约**钉在 `kb-core`,换存储不动调用方。
//!
//! 切分口径与 [`crate::ports::repo`] 一致:**一 trait 一子域**,按「谁和谁一起改」聚合,
//! 不做成一个大 trait —— 一个大 trait 等于没端口,任何一处的改动都会让所有实现方重编译,
//! 也让 `dyn` 调用点的依赖面失去意义。六个子域最后由 [`IdentityStore`] 聚合成
//! 「一个账号库」的整体,注入方只需要 `Arc<dyn IdentityStore>`。
//!
//! 三条约束(写 trait 时踩过的坑,改签名前先看):
//!
//! 1. **对象安全**:聚合之后要能以 `dyn IdentityStore` 注入,所以泛型方法一律不许出现。
//!    需要「调用方传个生成函数」的地方用 `Box<dyn FnOnce(..)>`,需要 `impl Into<T>`
//!    的地方直接写具体类型(`AiState`),由调用方先 `.into`。
//! 2. **同名方法**:`SystemStore` 上保留了这批方法的固有实现,所以同一类型同时有
//!    「固有方法」与「trait 方法」两个同名入口时,方法调用语法会静默选固有方法。
//!    `dyn` 之后只剩 trait 方法,这条只在直接持 `SystemStore` 的地方(组合根、单测)成立,
//!    需要 trait 语义时用全限定语法 `AccountRepo::get_user(&store, id)`。
//! 3. **错误口径**:找不到就是 `Ok(None)`,「本该存在」的地方由实现方给
//!    [`crate::KbError::NotFound`],与 [`crate::ports::repo`] 保持一致。
//!
//! **不进来的东西**(刻意留在实现里):`open` / `schema_version` 是打开库与迁移,
//! `get_setting` / `set_setting` 是服务器私有配置(pepper 之类由 `get_or_create_secret` 包住),
//! 它们只有组合根和实现自己用,进端口只会让每个实现方多写一遍转发。

use std::collections::HashMap;

use async_trait::async_trait;
use serde_json::Value;

use crate::Result;
use crate::account::{
    EmailPurpose, InviteCode, NewUser, Space, SpaceUsage, SystemAuditEntry, User, UserAdminKey,
    UserSession, UserToken,
};
use crate::config::QuotaConfig;
use crate::features::{AiState, FeatureSet};
use crate::model::identity::{
    BatchOutcome, Caps, CodeLimits, Decision, Digest, GrantChange, GrantView, Guest, IssueOutcome,
    LinkRecord, LinkUpdate, LinkVisitor, MailLogEntry, MeasuredUsage, NewInvite, NewLink,
    Purgeable, RequestOutcome, RoleUpdate, SetGrant, SharedByMe, SharedRoot, StorageRankRow,
    StorageTotals, SystemRetentionTable, TotpState, UserFilter, UserLlmUsage, UserUpdate,
    VerifyOutcome,
};
use crate::model::{MetricRow, Millis};
use crate::share::link::ShareLink;
use crate::share::{AccessRequest, Action, Effective, ResourceKey, Role};
use crate::social::{Friend, FriendRequest, Notification, Privacy, PublicProfile, Relation};

/// 账号、偏好、会话与容量。
///
/// 账号本身、个人偏好、登录会话与存储用量。
///
/// 这些是**每次请求都要碰**的东西(会话校验、配额判定),所以端口只描述读写,
/// 不描述「怎么缓存」:缓存策略属于实现侧。
#[async_trait]
pub trait AccountRepo: Send + Sync {
    /// 建用户,同时建他的个人知识库(同一个事务)。返回用户和知识库。
    async fn create_user(&self, new: NewUser) -> Result<(User, Space)>;

    /// 按 id 取用户。
    async fn get_user(&self, id: &str) -> Result<Option<User>>;

    /// 用「用户名或邮箱」找用户(登录用,不区分大小写)。
    async fn find_user_by_login(&self, login: &str) -> Result<Option<User>>;

    /// 读密码哈希(只给登录校验用)。
    async fn password_hash(&self, user_id: &str) -> Result<Option<String>>;

    /// 改密码哈希;改完让这个用户的全部会话失效(`keep_session` 除外)。
    async fn set_password_hash(
        &self,
        user_id: &str,
        hash: &str,
        must_change: bool,
        keep_session: Option<&str>,
    ) -> Result<()>;

    /// 分页列用户,返回(本页, 总数)。
    async fn list_users(
        &self,
        filter: UserFilter,
        limit: u32,
        offset: u32,
    ) -> Result<(Vec<User>, i64)>;

    /// 更新用户。降级或停用**最后一个管理员**会被拒绝(系统里必须至少留一个)。
    async fn update_user(&self, id: &str, update: UserUpdate) -> Result<User>;

    /// 记一次登录。
    async fn touch_login(&self, user_id: &str, at: Millis) -> Result<()>;

    /// 某个用户**最终生效**的配额:全站默认 → 角色覆盖 → 用户覆盖,后者盖前者。
    async fn effective_quota(&self, user_id: &str, defaults: &QuotaConfig) -> Result<QuotaConfig>;

    /// 总用户数(判断「系统里还没有任何用户」用)。
    async fn count_users(&self) -> Result<i64>;

    /// 能用的管理员数量。
    async fn count_admins(&self) -> Result<i64>;

    /// 设置 / 清除某个用户的功能例外。`effect` 为 `None` 表示清除(跟随角色)。
    async fn set_feature_override(
        &self,
        user_id: &str,
        feature: &str,
        effect: Option<&str>,
    ) -> Result<()>;

    /// 某个用户的全部功能例外:`(feature, effect)`。
    async fn feature_overrides(&self, user_id: &str) -> Result<Vec<(String, String)>>;

    /// 某用户的个人知识库。
    async fn personal_space(&self, user_id: &str) -> Result<Option<Space>>;

    /// 按 id 取知识库。
    async fn get_space(&self, id: &str) -> Result<Option<Space>>;

    /// 全部知识库(调度器、备份、用量统计用)。
    async fn list_spaces(&self) -> Result<Vec<Space>>;

    /// 更新知识库已用存储(定时统计写入)。
    async fn set_space_storage(&self, id: &str, bytes: i64) -> Result<()>;

    /// 读一个人的偏好;从没存过返回空对象。
    async fn get_prefs(&self, user_id: &str) -> Result<Value>;

    /// 整体替换一个人的偏好。不是对象或超过大小上限返回 `InvalidInput`。
    async fn set_prefs(&self, user_id: &str, prefs: &Value, now: Millis) -> Result<()>;

    /// 新建会话。
    async fn create_session(&self, session: UserSession) -> Result<()>;

    /// 凭会话令牌哈希找到会话和用户。已过期、用户被停用的都返回 `None`。
    async fn session_user(
        &self,
        token_hash: &str,
        now: Millis,
    ) -> Result<Option<(UserSession, User)>>;

    /// 续期:更新最近访问和过期时间。
    async fn touch_session(
        &self,
        token_hash: &str,
        last_seen: Millis,
        expires_at: Millis,
    ) -> Result<()>;

    /// 退出登录。
    async fn delete_session(&self, token_hash: &str) -> Result<()>;

    /// 让某个用户的全部会话失效(`except` 那一个保留,用于「退出其它设备」)。返回删了几个。
    async fn delete_user_sessions(&self, user_id: &str, except: Option<&str>) -> Result<usize>;

    /// 清掉已过期的会话。
    async fn purge_expired_sessions(&self, now: Millis) -> Result<usize>;

    /// 某个用户当前有效的全部会话(设置页「登录设备」)。
    async fn list_user_sessions(&self, user_id: &str, now: Millis) -> Result<Vec<UserSession>>;

    /// 新建个人访问令牌(明文由调用方生成并只返回一次,这里只存哈希)。
    async fn create_token(&self, token: UserToken) -> Result<()>;

    /// 凭令牌哈希找到令牌和主人。已撤销、主人被停用的都返回 `None`。
    async fn find_token(&self, token_hash: &str) -> Result<Option<(UserToken, User)>>;

    /// 某个用户的令牌(含已撤销的,新的在前)。
    async fn list_tokens(&self, user_id: &str) -> Result<Vec<UserToken>>;

    /// 撤销令牌。只能撤销**自己的**:`user_id` 不匹配时当作不存在。返回是否撤销了。
    async fn revoke_token(&self, user_id: &str, token_id: &str, at: Millis) -> Result<bool>;

    /// 记一次使用时间。
    async fn touch_token(&self, token_id: &str, at: Millis) -> Result<()>;

    /// 停用 / 删除用户时使用:撤销其全部令牌。
    async fn revoke_user_tokens(&self, user_id: &str, at: Millis) -> Result<usize>;

    /// 记下一个知识库的统计结果,同时更新 `spaces.storage_bytes`(用户详情页读的合计)。
    async fn save_space_usage(&self, space_id: &str, usage: SpaceUsage, now: Millis) -> Result<()>;

    /// 一个知识库最近一次统计的结果;从没统计过返回 `None`。
    async fn get_space_usage(&self, space_id: &str) -> Result<Option<MeasuredUsage>>;

    /// 占用最多的知识库,最多 `limit` 个。
    async fn storage_ranking(&self, limit: u32) -> Result<Vec<StorageRankRow>>;

    /// 最久没统计的知识库(从没统计过的排最前),最多 `limit` 个。定时任务按它挨个量,
    /// 每一轮只量一小批,上千个知识库也不会一次把磁盘读爆。
    async fn spaces_by_staleness(&self, limit: u32) -> Result<Vec<String>>;

    /// 全站合计。
    async fn storage_totals(&self) -> Result<StorageTotals>;

    /// 记一条审计(登录成功 / 失败、改密、轮换密钥…)。`user_id` 为空表示「还不知道是谁」。
    ///
    /// 审计行和账号同库、按 actor 建索引,而且读写审计总是和看用户一起发生(管理端的
    /// 「这个用户做了什么」),所以放在这里,不单开一个只有两个方法的 trait。
    async fn record_audit(
        &self,
        user_id: Option<&str>,
        action: &str,
        target: Option<&str>,
        detail: &Value,
        ip: Option<&str>,
    ) -> Result<()>;

    /// 按 actor 分页读审计,新的在前;`user_id` 为空表示全站。
    async fn list_audit(
        &self,
        user_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<SystemAuditEntry>>;
}

/// 角色与资源授权。
///
/// 角色定义,以及「谁对哪个资源有什么角色」。
///
/// 授权判定(继承、断点、过期)在实现侧完成,端口只给结果:
/// 调用方拿 `Role` 直接用,不需要知道 lineage 是怎么算的。
#[async_trait]
pub trait RoleRepo: Send + Sync {
    /// 全部角色(带功能勾选),内置的在前。
    async fn list_roles(&self) -> Result<Vec<crate::account::Role>>;

    /// 按 id 取角色。
    async fn get_role(&self, id: &str) -> Result<Option<crate::account::Role>>;

    /// 新建自定义角色。
    async fn create_role(
        &self,
        name: &str,
        description: &str,
        features: Vec<String>,
        dangerous: bool,
    ) -> Result<crate::account::Role>;

    /// 更新角色。管理员角色不可改(它永远是「全部功能」)。
    async fn update_role(&self, id: &str, update: RoleUpdate) -> Result<crate::account::Role>;

    /// 删除自定义角色。内置角色不能删;还有用户在用时要先把他们移走。
    async fn delete_role(&self, id: &str) -> Result<()>;

    /// 每个角色下有几个用户:`(角色 id, 人数)`。
    async fn role_user_counts(&self) -> Result<Vec<(String, i64)>>;

    /// 某个用户**最终生效**的功能集合(角色勾选 + 用户例外 + AI 总开关)。
    async fn effective_features(&self, user_id: &str, ai: AiState) -> Result<FeatureSet>;

    /// 给某人在某个资源上写一条授权(已有就改),返回写入后的授权与「之前是什么角色」。
    ///
    /// `via` 记这条授权的来源(分享面板 / 访问申请通过 / 链接),`expires_at` 为过期时间。
    #[allow(clippy::too_many_arguments)] // 授权形状本身就是「谁 / 什么资源 / 什么角色 / 来源 / 谁给的 / 什么时候 / 过期」
    async fn set_grant(
        &self,
        key: &ResourceKey,
        grantee_id: &str,
        role: Role,
        via: &str,
        created_by: &str,
        now: Millis,
        expires_at: Option<Millis>,
    ) -> Result<SetGrant>;

    /// 移除一个人在一个资源上的授权。返回之前的角色(没有授权返回 `None`)。
    async fn remove_grant(&self, key: &ResourceKey, grantee_id: &str) -> Result<Option<Role>>;

    /// 批量授权 / 改角色 / 移除:对 `keys` 里的**每一个**资源应用 `changes`。整批在一个事务里,
    /// 任何一项不合法整批回滚——不会出现「分享了一半」。
    async fn apply_grants(
        &self,
        keys: &[ResourceKey],
        changes: &[GrantChange],
        created_by: &str,
        now: Millis,
        expires_at: Option<Millis>,
    ) -> Result<BatchOutcome>;

    /// 一个资源上**直接**授予的协作者(不含继承)。
    async fn direct_grants(&self, key: &ResourceKey, now: Millis) -> Result<Vec<GrantView>>;

    /// 分享面板要的完整列表:这个资源上直接授予的 + 从上级继承来的(尊重停止继承)。
    async fn lineage_grants(&self, key: &ResourceKey, now: Millis) -> Result<Vec<GrantView>>;

    /// 一个人在一个资源上的有效授权角色(**不含**所有者身份——那来自「是不是知识库的主人」)。
    async fn granted_role(
        &self,
        user_id: &str,
        key: &ResourceKey,
        now: Millis,
    ) -> Result<Option<Effective>>;

    /// 能处理这个资源的访问申请的人:知识库的主人 + 沿继承链(尊重停止继承)授予了「可管理」的人。
    async fn managers_of(&self, key: &ResourceKey, now: Millis) -> Result<Vec<String>>;

    /// 一个人对一个资源的**最终**角色:知识库的主人是所有者;否则是授权算出来的角色;都没有就是 `None`。
    ///
    /// 系统管理员**不**因为是管理员就拥有别人知识库的权限（设计规范）:这里不看账号角色。
    async fn role_of(&self, user_id: &str, key: &ResourceKey, now: Millis) -> Result<Option<Role>>;

    /// 要求某人对资源至少能做 `action`。没有任何权限 → `NotFound`(不暴露资源存在);
    /// 有权限但不够 → `Forbidden`。返回他的角色。
    async fn require_role(
        &self,
        user_id: &str,
        key: &ResourceKey,
        action: Action,
        now: Millis,
    ) -> Result<Role>;

    /// 这个人在这个知识库里有没有任何(未过期的)授权。是给「点名别人的知识库」做的一道便宜的前置检查。
    async fn has_grant_in_space(&self, user_id: &str, space_id: &str, now: Millis) -> Result<bool>;

    /// 这个集合里有没有设过「停止继承」的子级(决定列表要不要按行过滤)。
    /// 只是个快速判断:宁可误报(多过滤一次),不可漏报,所以按「同一知识库同一集合」前缀粗匹配。
    async fn has_inherit_breaks_in(&self, space_id: &str, collection: &str) -> Result<bool>;

    /// 知识库的主人。
    async fn space_owner(&self, space_id: &str) -> Result<Option<String>>;

    /// 设置 / 取消「不继承上级协作者」。
    async fn set_inherit_break(
        &self,
        key: &ResourceKey,
        broken: bool,
        by: &str,
        now: Millis,
    ) -> Result<()>;

    /// 这个资源是不是停止了继承。
    async fn is_inherit_broken(&self, key: &ResourceKey) -> Result<bool>;

    /// 共享给我的:直接授予我的资源,每条带所有者资料与「是否被我移出列表」。过期的不显示。
    async fn shared_with(
        &self,
        user_id: &str,
        include_hidden: bool,
        now: Millis,
    ) -> Result<Vec<SharedRoot>>;

    /// 把一条共享从我的「共享给我」里移出 / 放回(只影响显示,不影响授权)。
    /// 只能动**确实授予了我**的资源:否则别人可以往我的隐藏表里塞任意垃圾。
    async fn set_share_hidden(&self, user_id: &str, key: &ResourceKey, hidden: bool) -> Result<()>;

    /// 我分享出去的:我的知识库里有协作者的资源,每个资源带协作者列表。
    async fn shared_by(&self, owner_id: &str, now: Millis) -> Result<Vec<SharedByMe>>;

    /// 清掉过期的授权。返回清掉几条。
    async fn purge_expired_grants(&self, now: Millis) -> Result<usize>;

    /// 文件 / 文件夹移动后把授权、停止继承、隐藏分享、分享链接里的资源键一起改名。
    ///
    /// 只映射 `from` 自己以及它底下、且属于同一集合的键:`docs` 不会匹配 `docs2`,
    /// 因为 `is_within` 走的是 `lineage` 的段边界。移动后旧的继承授权自然失效,
    /// 新位置从目标目录继承——这正是 要的语义。
    async fn rekey_resource(&self, from: &ResourceKey, to: &ResourceKey) -> Result<usize>;

    /// 删掉某个资源**及它底下所有东西**的授权与停止继承(删除目录 / 文档 / 集合时调用)。
    /// 返回删掉几条授权。
    async fn forget_resource(&self, key: &ResourceKey) -> Result<usize>;

    /// 申请访问。规则(都在事务里):
    /// - 知识库必须存在(不存在 → `NotFound`);
    /// - 申请的角色只能是查看 / 评论 / 编辑,而且必须比申请人现有的更高(已经够了 → `InvalidInput`);
    /// - 同一个人对同一资源 24 小时内只能申请一次;同时挂着的待处理申请最多 30 个;
    /// - 所有者拉黑了申请人 → 返回 `Ok(None)`:表面成功,什么都不创建(不暴露自己拉黑了对方)。
    async fn create_access_request(
        &self,
        key: &ResourceKey,
        requester_id: &str,
        role: Role,
        message: Option<&str>,
        now: Millis,
    ) -> Result<Option<AccessRequest>>;

    /// 某些知识库里待处理的申请(调用方再按「我对资源是不是可管理」过滤)。
    async fn pending_access_requests_in(&self, space_ids: &[String]) -> Result<Vec<AccessRequest>>;

    /// 我自己发出的申请(最近 50 条)。
    async fn my_access_requests(&self, requester_id: &str) -> Result<Vec<AccessRequest>>;

    /// 按 id 取一条申请。
    async fn get_access_request(&self, id: &str) -> Result<Option<AccessRequest>>;

    /// 处理申请:通过(写入授权,角色可以改成别的)或拒绝。只能处理待处理的;并发的两次处理只有一次生效。
    /// 调用方已经确认过处理人对这个资源有「可管理」。通过时申请人必须仍是可用账号。
    async fn decide_access_request(
        &self,
        id: &str,
        decided_by: &str,
        approve: bool,
        granted_role: Option<Role>,
        now: Millis,
    ) -> Result<AccessRequest>;
}

/// 访问链接与社交关系。
///
/// 对外分享用的访问链接,以及用户之间的社交关系(好友、拉黑、申请)。
#[async_trait]
pub trait AccessLinkRepo: Send + Sync {
    /// 新建链接,返回 `(链接, 令牌明文)`。明文只此一次。
    ///
    /// `max_links` 是创建人可以同时拥有的(未撤销的)链接数上限,0 = 不限。
    /// 所有资源必须都在同一个知识库里;合集链接 1–500 项。
    async fn create_link(
        &self,
        new: NewLink,
        max_links: u32,
        now: Millis,
    ) -> Result<(ShareLink, String)>;

    /// 凭令牌找链接。令牌格式不对直接 `None`,不去查库。
    async fn find_link_by_token(&self, token: &str) -> Result<Option<LinkRecord>>;

    /// 按 id 取链接。
    async fn get_link(&self, id: &str) -> Result<Option<LinkRecord>>;

    /// 一个资源上的链接(未撤销的)。
    async fn links_for_resource(&self, key: &ResourceKey) -> Result<Vec<LinkRecord>>;

    /// 某人创建的链接(含已撤销的,我的分享页要显示状态)。
    async fn links_by_creator(&self, user_id: &str) -> Result<Vec<LinkRecord>>;

    /// 全站链接(管理员治理用),新的在前,分页。
    async fn all_links(&self, limit: u32, offset: u32) -> Result<(Vec<LinkRecord>, i64)>;

    /// 修改链接设置。已撤销的不能改。
    async fn update_link(&self, id: &str, update: LinkUpdate, now: Millis) -> Result<LinkRecord>;

    /// 重置链接:换一个新令牌,旧地址立刻作废。返回新令牌明文(只此一次)。
    async fn reset_link_token(&self, id: &str) -> Result<String>;

    /// 撤销链接(不可恢复)。返回之前是否有效。
    async fn revoke_link(&self, id: &str, now: Millis) -> Result<bool>;

    /// 记一次打开。登录访问者进名单,匿名的只加次数。
    async fn record_link_view(
        &self,
        link_id: &str,
        user_id: Option<&str>,
        now: Millis,
    ) -> Result<()>;

    /// 链接的登录访问者名单。
    async fn link_visitors(&self, link_id: &str) -> Result<Vec<LinkVisitor>>;

    /// 当天这个链接已经发出去多少字节,并累加 `add`。返回累加**后**的总数。
    async fn add_link_bytes(&self, link_id: &str, day: &str, add: u64) -> Result<u64>;

    /// 当天已发出的字节数。
    async fn link_bytes(&self, link_id: &str, day: &str) -> Result<u64>;

    /// 取或建一个游客。`secret_hash` 是 cookie 里随机串的 sha256。已有的更新「最近出现」。
    async fn touch_guest(
        &self,
        secret_hash: &str,
        link_id: &str,
        ip: Option<&str>,
        now: Millis,
    ) -> Result<Guest>;

    /// 游客自己改昵称。
    async fn set_guest_nickname(&self, guest_id: &str, nickname: &str) -> Result<String>;

    /// 清掉很久没出现的游客记录。
    async fn purge_stale_guests(&self, before: Millis) -> Result<usize>;

    /// 清理过期的流量记录(只留最近几天)。
    async fn purge_link_bytes_before(&self, day: &str) -> Result<usize>;

    /// 删掉一个资源(及它底下)上的链接:撤销。资源被删除时调用,别让链接指向不存在的东西。
    async fn revoke_links_within(&self, key: &ResourceKey, now: Millis) -> Result<usize>;

    /// 按**完整**用户名或邮箱找人。找不到 / 不允许被搜到 / 把我拉黑了 / 是我自己,都返回 `None`,
    /// 外界分辨不出是哪一种。返回的 `Relation` 告诉界面该显示「加好友」「已是好友」还是「等待中」。
    async fn find_for_friending(
        &self,
        searcher_id: &str,
        query: &str,
        now: Millis,
    ) -> Result<Option<(PublicProfile, Relation)>>;

    /// 发好友申请。所有规则都在一个事务里:
    /// 不能加自己;对方不存在 / 不可用 → 找不到;对方拉黑了我 → [`RequestOutcome::Silent`];
    /// 已是好友 → 不重复;对方已经向我发过申请 → 直接互为好友;我发的还在等 → 不重复;
    /// 被拒后 24 小时内不能再申请;自己同时挂着的申请有上限;自己的好友数不能已满。
    async fn send_friend_request(
        &self,
        from_id: &str,
        to_id: &str,
        message: Option<&str>,
        caps: Caps,
        now: Millis,
    ) -> Result<RequestOutcome>;

    /// 处理一条发给我的申请。只有接收人能处理;已处理 / 已过期 / 已被取消的都当作不存在。
    /// 返回处理后的申请(接口据此给发起人发通知)。
    async fn decide_friend_request(
        &self,
        request_id: &str,
        decider_id: &str,
        decision: Decision,
        caps: Caps,
        now: Millis,
    ) -> Result<FriendRequest>;

    /// 发给我的、等我处理的申请(带发起人资料),新的在前。已忽略的不再显示。
    async fn incoming_friend_requests(
        &self,
        user_id: &str,
        now: Millis,
    ) -> Result<Vec<(FriendRequest, PublicProfile)>>;

    /// 我发出的、还在等的申请(带对方资料)。被对方忽略的仍显示为「等待中」。
    async fn outgoing_friend_requests(
        &self,
        user_id: &str,
        now: Millis,
    ) -> Result<Vec<(FriendRequest, PublicProfile)>>;

    /// 好友列表(带备注与分组),按备注名 / 昵称排序。账号已不可用的好友不显示。
    async fn list_friends(&self, user_id: &str) -> Result<Vec<Friend>>;

    /// 改好友的备注名和分组(只改我这一行,对方看到的不变)。`None` = 不动,`Some(None)` = 清空。
    async fn update_friend(
        &self,
        user_id: &str,
        friend_id: &str,
        remark: Option<Option<String>>,
        group_name: Option<Option<String>>,
    ) -> Result<()>;

    /// 删除好友(双向)。已有的分享不动——分享和好友是两回事,由调用方提示是否一并移除。
    /// 返回之前是不是好友。
    async fn remove_friend(&self, user_id: &str, friend_id: &str) -> Result<bool>;

    /// 拉黑:同时解除好友关系、作废两人之间所有没处理完的申请。对方不会收到任何通知。
    async fn block_user(&self, user_id: &str, target_id: &str, now: Millis) -> Result<()>;

    /// 取消拉黑。
    async fn unblock_user(&self, user_id: &str, target_id: &str) -> Result<bool>;

    /// 我拉黑的人。
    async fn list_blocks(&self, user_id: &str) -> Result<Vec<(PublicProfile, Millis)>>;

    /// 两人是不是好友(分享、@ 提及判断用)。
    async fn are_friends(&self, a: &str, b: &str) -> Result<bool>;

    /// 两人之间有没有任何一方拉黑了另一方。
    async fn is_blocked_between(&self, a: &str, b: &str) -> Result<bool>;

    /// 我现在有几个好友。
    async fn friend_count(&self, user_id: &str) -> Result<i64>;

    /// 读隐私设置(缺的键按默认)。
    async fn privacy_of(&self, user_id: &str) -> Result<Privacy>;

    /// 写隐私设置。
    async fn set_privacy(&self, user_id: &str, privacy: Privacy) -> Result<()>;

    /// 自动成为好友(邀请码带「自动加好友」时,新用户和邀请人)。已是好友或被拉黑都安静地跳过。
    /// 返回是否新建了好友关系。
    async fn make_friends(&self, a: &str, b: &str, caps: Caps, now: Millis) -> Result<bool>;
}

/// 通知、历史清理与采样。
///
/// 站内通知、保留期清理与资源采样。
#[async_trait]
pub trait NotifyRepo: Send + Sync {
    /// 给一个人发一条站内通知,返回通知 id。种类必须是已知的;内容必须是对象且不超过 4 KB。
    /// 收件人不存在时返回 `NotFound`(调用方通常忽略:对方刚注销了不是发送方的错)。
    async fn add_notification(
        &self,
        user_id: &str,
        notification_kind: &str,
        data: &Value,
        now: Millis,
    ) -> Result<i64>;

    /// 读通知,新的在前。`before_id` 是翻页游标(上一页最后一条的 id)。
    async fn list_notifications(
        &self,
        user_id: &str,
        unread_only: bool,
        before_id: Option<i64>,
        limit: u32,
    ) -> Result<Vec<Notification>>;

    /// 未读条数。
    async fn unread_notifications(&self, user_id: &str) -> Result<u64>;

    /// 把这几条标为已读(只动属于自己的)。返回实际改了几条。
    async fn mark_notifications_read(
        &self,
        user_id: &str,
        ids: &[i64],
        now: Millis,
    ) -> Result<usize>;

    /// 全部标为已读。
    async fn mark_all_notifications_read(&self, user_id: &str, now: Millis) -> Result<usize>;

    /// 清理超过保留期(90 天)的通知,顺带清掉没发出去的陈旧邮件队列项。返回清掉几条通知。
    async fn purge_old_notifications(&self, now: Millis) -> Result<usize>;

    /// 一个人每种通知要不要同时发邮件(没设过的按种类默认)。
    async fn notify_email_prefs(&self, user_id: &str) -> Result<HashMap<String, bool>>;

    /// 改某几种通知的邮件开关。未知的种类整个请求拒绝(不悄悄忽略一部分)。
    async fn set_notify_email_prefs(
        &self,
        user_id: &str,
        changes: &HashMap<String, bool>,
    ) -> Result<()>;

    /// 把一条通知排进邮件队列(等着和同一个人的其它通知合并)。
    async fn queue_notification_mail(
        &self,
        user_id: &str,
        notification_id: i64,
        now: Millis,
    ) -> Result<()>;

    /// 现在该发的合并邮件:有排队项、且距上一封已经超过 `min_gap_ms` 的人,最多 `max_users` 个。
    /// 已经在网页上读过的通知不再发邮件(人都看到了,没必要再打扰)。
    async fn due_notification_digests(
        &self,
        now: Millis,
        min_gap_ms: i64,
        max_users: u32,
    ) -> Result<Vec<Digest>>;

    /// 一封合并邮件处理完了(发出去了,或者里面的通知都已读不用发):删掉队列项,记下发送时间。
    /// `sent = false` 时不更新发送时间(没发就不占 10 分钟的间隔)。
    async fn finish_notification_digest(
        &self,
        user_id: &str,
        queue_ids: &[i64],
        sent: bool,
        now: Millis,
    ) -> Result<()>;

    /// 删掉 `before` 之前的行,返回删了几行(或 `dry_run` 时会删几行)。
    async fn prune_history(
        &self,
        table: SystemRetentionTable,
        before: i64,
        dry_run: bool,
    ) -> Result<u64>;

    /// 写一行(同一分钟已有就覆盖)。
    async fn put_metric(&self, row: MetricRow) -> Result<()>;

    /// 删掉 `before` 之前的行,返回删了几行。
    async fn prune_metrics(&self, before: i64) -> Result<u64>;

    /// `[since, until]` 之间的读数,按 `bucket_ms` 分桶取平均(`bucket_ms` 为 60 000 时就是原始行)。
    /// 返回按时间升序;空桶不出现(采样器没跑的时段就是断开的)。
    async fn metric_series(&self, since: i64, until: i64, bucket_ms: i64)
    -> Result<Vec<MetricRow>>;
}

/// 注册、注销与两步验证。
///
/// 邀请码 / 邮箱验证码 / 好友申请之外的注册流程,账号冷却期删除,以及 TOTP。
///
/// 验证码与邀请码只过哈希,**明文不进这个端口**。
#[async_trait]
pub trait SignupRepo: Send + Sync {
    /// 读一个服务器私有的值;没有就用 `make` 生成并保存(pepper 用)。并发时只有一个会落库。
    async fn get_or_create_secret(
        &self,
        key: &str,
        make: Box<dyn FnOnce() -> String + Send>,
    ) -> Result<String>;

    /// 发验证码前先记账并做限速:同一邮箱有最小间隔与每日上限,同一 IP 有每小时上限。
    ///
    /// 返回 [`IssueOutcome`] 由调用方决定要不要真的发信 —— 限速命中时**不**发。
    #[allow(clippy::too_many_arguments)] // 限速参数与验证码本体是两件事,拆结构体会让调用方多写一层包装
    async fn issue_email_code(
        &self,
        email: &str,
        purpose: EmailPurpose,
        code_hash: &str,
        ip: Option<&str>,
        ttl_ms: i64,
        limits: CodeLimits,
        now: Millis,
    ) -> Result<IssueOutcome>;

    /// 校验验证码。不对就记一次错误,到 `MAX_CODE_ATTEMPTS` 次作废。对了**不**消耗:
    /// 注册还要建账号、占用户名,失败时用户不该被迫重新收一封邮件;建成功后再 [`Self::consume_email_code`]。
    async fn verify_email_code(
        &self,
        email: &str,
        purpose: EmailPurpose,
        candidate_hash: &str,
        now: Millis,
    ) -> Result<VerifyOutcome>;

    /// 消耗验证码(用过即失效)。返回是否真的消耗了——并发的第二次返回 `false`。
    async fn consume_email_code(&self, id: &str, now: Millis) -> Result<bool>;

    /// 新建邀请码。
    async fn create_invite(&self, new: NewInvite) -> Result<InviteCode>;

    /// 列出邀请码,新的在前;`created_by` 给定时只看这个人创建的。
    async fn list_invites(&self, created_by: Option<&str>) -> Result<Vec<InviteCode>>;

    /// 撤销邀请码。`owner` 给定时只能撤销自己创建的。返回是否撤销了。
    async fn revoke_invite(&self, id: &str, owner: Option<&str>, at: Millis) -> Result<bool>;

    /// 只读地看一眼邀请码(注册页输入后立刻提示「邀请码无效」用,不占用次数)。
    async fn peek_invite(&self, code_hash: &str, now: Millis) -> Result<Option<InviteCode>>;

    /// 原子占用一次邀请码:有效且还有次数才成功。两个人同时用同一个单次码,只有一个拿到。
    async fn claim_invite(&self, code_hash: &str, now: Millis) -> Result<Option<InviteCode>>;

    /// 归还一次占用(占用后建账号失败时用)。
    async fn release_invite(&self, id: &str) -> Result<()>;

    /// 记下谁用了哪个邀请码。
    async fn record_invite_use(
        &self,
        invite_id: &str,
        user_id: &str,
        ip: Option<&str>,
        at: Millis,
    ) -> Result<()>;

    /// 一个邀请码的使用记录:`(用户 id, IP, 时间)`。
    async fn invite_uses(&self, invite_id: &str) -> Result<Vec<(String, Option<String>, Millis)>>;

    /// 记一条发信结果。
    async fn record_mail(
        &self,
        to: &str,
        kind: &str,
        ok: bool,
        via: Option<&str>,
        error: Option<&str>,
    ) -> Result<()>;

    /// 最近的发信记录,新的在前。
    async fn list_mail_log(&self, limit: u32) -> Result<Vec<MailLogEntry>>;

    /// 某个时间点之后发出的邮件数(全站每分钟上限用)。
    async fn mails_since(&self, since: Millis) -> Result<i64>;

    /// 清理过期数据:验证码留 7 天(排查用),发信记录留 30 天。返回清掉的行数。
    async fn purge_registration_data(&self, now: Millis) -> Result<usize>;

    /// 申请注销。返回冷静期结束的时间。
    ///
    /// - 已经在冷静期:返回**原来的**结束时间,不重置(不能靠重复申请把期限往后拖或往前挪)。
    /// - 最后一个管理员不能注销:冷静期结束后他就不在了,系统里必须至少留一个。
    /// - 被停用的账号不能自助注销(需要管理员处理)。
    async fn request_deletion(
        &self,
        user_id: &str,
        now: Millis,
        cooling_off_ms: i64,
    ) -> Result<Millis>;

    /// 同 `request_deletion`,另外告诉调用方这次是不是**新申请**(账号刚从正常变成注销中)。
    /// 通知邮件只在新申请时发:重复点击或网络重试不该把原主人的邮箱刷屏。
    async fn request_deletion_detailed(
        &self,
        user_id: &str,
        now: Millis,
        cooling_off_ms: i64,
    ) -> Result<(Millis, bool)>;

    /// 撤销注销:回到正常状态。
    ///
    /// **冷静期一结束就不能再撤销**(`delete_after <= now`)。这是故意的:清理任务只处理已到期的账号,
    /// 到期的那一刻撤销权同时消失,中间不留缝——否则「任务列出他之后、删文件之前他刚好撤销」
    /// 会让账号恢复正常而数据已经被删。边界和 `due_for_deletion` 严格互补。
    async fn cancel_deletion(&self, user_id: &str, now: Millis) -> Result<()>;

    /// 冷静期已经结束、该真正删除的用户 id。
    async fn due_for_deletion(&self, now: Millis) -> Result<Vec<String>>;

    /// 只读地检查:现在能不能清理这个用户。清理任务**在删任何文件之前**先调它,
    /// 否则会出现「目录已经删了,库里却因为团队知识库等原因拒绝删账号」的半截状态。
    /// 规则与 `purge_user` 完全一致(共用同一个函数)。
    async fn check_purgeable(&self, user_id: &str, now: Millis) -> Result<Purgeable>;

    /// 删除库里这个用户的所有行(账号、个人知识库记录、会话、令牌、功能例外)。
    ///
    /// 只肯删**已经到期的注销中账号**:误传一个活人的 id 不会删掉他。
    /// 主知识库的拥有者、仍拥有团队知识库的用户拒绝删除。
    /// 审计记录与邀请码使用记录**保留**(它们没有外键,里面的用户 id 之后显示为「账号已删除」)。
    /// 磁盘上的知识库目录与头像由调用方**先**清理,见模块说明。
    async fn purge_user(&self, user_id: &str, now: Millis) -> Result<()>;

    /// 开始设置:存下一个**待确认**的密钥(覆盖之前没确认完的)。已经开启的要先关掉。
    async fn begin_totp(&self, user_id: &str, secret_b32: &str, now: Millis) -> Result<()>;

    /// 读状态;从没设置过返回 `None`。
    async fn totp_state(&self, user_id: &str) -> Result<Option<TotpState>>;

    /// 是否已经正式开启(登录时每次都问,所以单独一个轻量查询)。
    async fn totp_enabled(&self, user_id: &str) -> Result<bool>;

    /// 第一个码验证通过:正式开启,记下这一步(防重放),并换上一批恢复码(只存哈希)。
    /// 已经开启的(重复确认)返回 `Exists`,待确认的才行。
    async fn confirm_totp(
        &self,
        user_id: &str,
        step: u64,
        recovery_hashes: &[String],
        now: Millis,
    ) -> Result<()>;

    /// 占用一个时间步:成功返回 `true`;这一步(或更晚的)已经被用过则 `false`。
    /// 是一条带条件的 UPDATE,两个并发请求拿同一个码,只有一个能成功。
    async fn claim_totp_step(&self, user_id: &str, step: u64) -> Result<bool>;

    /// 用掉一个恢复码:成功返回 `true`;不存在或已经用过 `false`。
    async fn use_recovery_code(&self, user_id: &str, code_hash: &str, now: Millis) -> Result<bool>;

    /// 还剩几个没用过的恢复码。
    async fn recovery_codes_left(&self, user_id: &str) -> Result<u32>;

    /// 重新生成恢复码(旧的全部作废)。
    async fn replace_recovery_codes(&self, user_id: &str, hashes: &[String]) -> Result<()>;

    /// 关闭两步验证(自己输对密码和验证码后关,或管理员替用户重置)。返回原来有没有开着。
    async fn disable_totp(&self, user_id: &str) -> Result<bool>;
}

/// 管理员密钥与 LLM 用量。
///
/// 管理员密钥轮换,以及按天的 LLM 用量记账。
#[async_trait]
pub trait AdminKeyRepo: Send + Sync {
    /// 取某个用户的 admin key;还没有就现发一把。用户不存在返回 `NotFound`。
    async fn ensure_admin_key(&self, user_id: &str) -> Result<UserAdminKey>;

    /// 轮换:换一把新的,旧的立刻失效。用户不存在返回 `NotFound`。
    async fn rotate_admin_key(&self, user_id: &str, at: Millis) -> Result<UserAdminKey>;

    /// 凭 admin key 找到主人。key 不存在、主人被停用都返回 `None`。
    async fn find_user_by_admin_key(&self, admin_key: &str) -> Result<Option<User>>;

    /// 累加一次调用。同一个人同一天同一用途合并成一行。
    async fn add_llm_usage(
        &self,
        user_id: &str,
        day: &str,
        purpose: &str,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<()>;

    /// `[first_day, last_day]`(含,`YYYY-MM-DD`)里每天每个用途全站合计的 token:`(day, purpose, calls, 输入, 输出)`。
    /// 日期是字符串比较,所以必须是规整的 `YYYY-MM-DD`(调用方校验)。管理员的 AI 用量趋势图用。
    async fn llm_usage_series(
        &self,
        first_day: &str,
        last_day: &str,
    ) -> Result<Vec<(String, String, u64, u64, u64)>>;

    /// 一个人某天用掉的 token(输入 + 输出,所有用途合计)。
    async fn llm_tokens_on(&self, user_id: &str, day: &str) -> Result<u64>;

    /// 某天按用户合计的用量,用得多的在前,最多 `limit` 个。
    async fn llm_usage_ranking(&self, day: &str, limit: u32) -> Result<Vec<UserLlmUsage>>;

    /// 删掉 `before_day`(不含)之前的用量行,账本不无限增长。
    async fn purge_llm_usage_before(&self, before_day: &str) -> Result<usize>;
}

/// 一个账号库的门面:六个子域拼起来就是「谁是谁、谁能做什么、谁能进站」。
///
/// 空实现是故意的 —— 实现方不需要额外写一行:任何一个 `T: AccountRepo + RoleRepo + ..`
/// 自动就是 `IdentityStore`,注入方写 `Arc<dyn IdentityStore>` 即可。
pub trait IdentityStore:
    AccountRepo + RoleRepo + AccessLinkRepo + NotifyRepo + SignupRepo + AdminKeyRepo
{
}

impl<T> IdentityStore for T where
    T: AccountRepo + RoleRepo + AccessLinkRepo + NotifyRepo + SignupRepo + AdminKeyRepo
{
}

#[cfg(test)]
mod tests {
    /// 端口必须能当 `dyn` 注入(A4c 起 `kb-web` 就靠 `Arc<dyn IdentityStore>`)。
    ///
    /// 只写类型不调方法:**给任何子域加一个泛型方法,这条就会编译失败**。这是故意的 ——
    /// 端口失去对象安全之后,所有注入点都得退回泛型参数,那等于把适配器 crate 的
    /// 依赖重新引进消费者,端口也就白做了。
    #[test]
    fn ports_stay_object_safe() {
        let _: Option<&dyn super::IdentityStore> = None;
        let _: Option<&dyn super::AccountRepo> = None;
        let _: Option<&dyn super::RoleRepo> = None;
        let _: Option<&dyn super::AccessLinkRepo> = None;
        let _: Option<&dyn super::NotifyRepo> = None;
        let _: Option<&dyn super::SignupRepo> = None;
        let _: Option<&dyn super::AdminKeyRepo> = None;
    }
}
