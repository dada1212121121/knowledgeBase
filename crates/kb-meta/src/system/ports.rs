//! `SystemStore` 对 `kb_core::ports::system` 六个端口的实现。
//!
//! 这里**只有一行转发**:实体仍留在各域文件(`users.rs` / `grants.rs` / …)的固有方法里,
//! 那是唯一真源,这一层只负责让 `SystemStore` 满足端口契约(于是 `kb-web` 可以拿
//! `Arc<dyn IdentityStore>` 而不知道 `kb-meta` 存在)。
//!
//! 为什么不把方法体直接搬进 trait impl:一个 trait 对一个类型只能 impl 一次,而这些方法
//! 分散在二十个域文件里,搬过来等价于把账号库的全部实体塞进一个文件。
//! 保留一层转发也让 `kb-cli` 组合根那 209 个调用点一处都不用改。

use std::collections::HashMap;

use async_trait::async_trait;
use kb_core::Result;
use kb_core::account::{
    EmailPurpose, InviteCode, NewUser, Space, SpaceUsage, SystemAuditEntry, User, UserAdminKey,
    UserSession, UserToken,
};
use kb_core::features::{AiState, FeatureSet};
use kb_core::model::{MetricRow, Millis};
use kb_core::ports::system::{
    AccessLinkRepo, AccountRepo, AdminKeyRepo, NotifyRepo, RoleRepo, SignupRepo,
};
use kb_core::share::link::ShareLink;
use kb_core::share::{AccessRequest, Effective, ResourceKey, Role};
use kb_core::social::{Friend, FriendRequest, Notification, Privacy, PublicProfile, Relation};
use serde_json::Value;

use super::SystemStore;
use super::{
    BatchOutcome, Caps, CodeLimits, Decision, Digest, GrantChange, GrantView, Guest, IssueOutcome,
    LinkRecord, LinkUpdate, LinkVisitor, MailLogEntry, MeasuredUsage, NewInvite, NewLink,
    Purgeable, RequestOutcome, RoleUpdate, SetGrant, SharedByMe, SharedRoot, StorageRankRow,
    StorageTotals, SystemRetentionTable, TotpState, UserFilter, UserLlmUsage, UserUpdate,
    VerifyOutcome,
};

#[async_trait]
impl AccountRepo for SystemStore {
    async fn record_audit(
        &self,
        user_id: Option<&str>,
        action: &str,
        target: Option<&str>,
        detail: &serde_json::Value,
        ip: Option<&str>,
    ) -> Result<()> {
        SystemStore::record_audit(self, user_id, action, target, detail, ip).await
    }
    async fn list_audit(
        &self,
        user_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<SystemAuditEntry>> {
        SystemStore::list_audit(self, user_id, limit, offset).await
    }
    async fn create_user(&self, new: NewUser) -> Result<(User, Space)> {
        SystemStore::create_user(self, new).await
    }
    async fn get_user(&self, id: &str) -> Result<Option<User>> {
        SystemStore::get_user(self, id).await
    }
    async fn find_user_by_login(&self, login: &str) -> Result<Option<User>> {
        SystemStore::find_user_by_login(self, login).await
    }
    async fn password_hash(&self, user_id: &str) -> Result<Option<String>> {
        SystemStore::password_hash(self, user_id).await
    }
    async fn set_password_hash(
        &self,
        user_id: &str,
        hash: &str,
        must_change: bool,
        keep_session: Option<&str>,
    ) -> Result<()> {
        SystemStore::set_password_hash(self, user_id, hash, must_change, keep_session).await
    }
    async fn list_users(
        &self,
        filter: UserFilter,
        limit: u32,
        offset: u32,
    ) -> Result<(Vec<User>, i64)> {
        SystemStore::list_users(self, filter, limit, offset).await
    }
    async fn update_user(&self, id: &str, update: UserUpdate) -> Result<User> {
        SystemStore::update_user(self, id, update).await
    }
    async fn touch_login(&self, user_id: &str, at: Millis) -> Result<()> {
        SystemStore::touch_login(self, user_id, at).await
    }
    async fn effective_quota(
        &self,
        user_id: &str,
        defaults: &kb_core::config::QuotaConfig,
    ) -> Result<kb_core::config::QuotaConfig> {
        SystemStore::effective_quota(self, user_id, defaults).await
    }
    async fn count_users(&self) -> Result<i64> {
        SystemStore::count_users(self).await
    }
    async fn count_admins(&self) -> Result<i64> {
        SystemStore::count_admins(self).await
    }
    async fn set_feature_override(
        &self,
        user_id: &str,
        feature: &str,
        effect: Option<&str>,
    ) -> Result<()> {
        SystemStore::set_feature_override(self, user_id, feature, effect).await
    }
    async fn feature_overrides(&self, user_id: &str) -> Result<Vec<(String, String)>> {
        SystemStore::feature_overrides(self, user_id).await
    }
    async fn personal_space(&self, user_id: &str) -> Result<Option<Space>> {
        SystemStore::personal_space(self, user_id).await
    }
    async fn get_space(&self, id: &str) -> Result<Option<Space>> {
        SystemStore::get_space(self, id).await
    }
    async fn list_spaces(&self) -> Result<Vec<Space>> {
        SystemStore::list_spaces(self).await
    }
    async fn set_space_storage(&self, id: &str, bytes: i64) -> Result<()> {
        SystemStore::set_space_storage(self, id, bytes).await
    }
    async fn get_prefs(&self, user_id: &str) -> Result<Value> {
        SystemStore::get_prefs(self, user_id).await
    }
    async fn set_prefs(&self, user_id: &str, prefs: &Value, now: Millis) -> Result<()> {
        SystemStore::set_prefs(self, user_id, prefs, now).await
    }
    async fn create_session(&self, session: UserSession) -> Result<()> {
        SystemStore::create_session(self, session).await
    }
    async fn session_user(
        &self,
        token_hash: &str,
        now: Millis,
    ) -> Result<Option<(UserSession, User)>> {
        SystemStore::session_user(self, token_hash, now).await
    }
    async fn touch_session(
        &self,
        token_hash: &str,
        last_seen: Millis,
        expires_at: Millis,
    ) -> Result<()> {
        SystemStore::touch_session(self, token_hash, last_seen, expires_at).await
    }
    async fn delete_session(&self, token_hash: &str) -> Result<()> {
        SystemStore::delete_session(self, token_hash).await
    }
    async fn delete_user_sessions(&self, user_id: &str, except: Option<&str>) -> Result<usize> {
        SystemStore::delete_user_sessions(self, user_id, except).await
    }
    async fn purge_expired_sessions(&self, now: Millis) -> Result<usize> {
        SystemStore::purge_expired_sessions(self, now).await
    }
    async fn list_user_sessions(&self, user_id: &str, now: Millis) -> Result<Vec<UserSession>> {
        SystemStore::list_user_sessions(self, user_id, now).await
    }
    async fn create_token(&self, token: UserToken) -> Result<()> {
        SystemStore::create_token(self, token).await
    }
    async fn find_token(&self, token_hash: &str) -> Result<Option<(UserToken, User)>> {
        SystemStore::find_token(self, token_hash).await
    }
    async fn list_tokens(&self, user_id: &str) -> Result<Vec<UserToken>> {
        SystemStore::list_tokens(self, user_id).await
    }
    async fn revoke_token(&self, user_id: &str, token_id: &str, at: Millis) -> Result<bool> {
        SystemStore::revoke_token(self, user_id, token_id, at).await
    }
    async fn touch_token(&self, token_id: &str, at: Millis) -> Result<()> {
        SystemStore::touch_token(self, token_id, at).await
    }
    async fn revoke_user_tokens(&self, user_id: &str, at: Millis) -> Result<usize> {
        SystemStore::revoke_user_tokens(self, user_id, at).await
    }
    async fn save_space_usage(&self, space_id: &str, usage: SpaceUsage, now: Millis) -> Result<()> {
        SystemStore::save_space_usage(self, space_id, usage, now).await
    }
    async fn get_space_usage(&self, space_id: &str) -> Result<Option<MeasuredUsage>> {
        SystemStore::get_space_usage(self, space_id).await
    }
    async fn storage_ranking(&self, limit: u32) -> Result<Vec<StorageRankRow>> {
        SystemStore::storage_ranking(self, limit).await
    }
    async fn spaces_by_staleness(&self, limit: u32) -> Result<Vec<String>> {
        SystemStore::spaces_by_staleness(self, limit).await
    }
    async fn storage_totals(&self) -> Result<StorageTotals> {
        SystemStore::storage_totals(self).await
    }
}

#[async_trait]
impl RoleRepo for SystemStore {
    async fn list_roles(&self) -> Result<Vec<kb_core::account::Role>> {
        SystemStore::list_roles(self).await
    }
    async fn get_role(&self, id: &str) -> Result<Option<kb_core::account::Role>> {
        SystemStore::get_role(self, id).await
    }
    async fn create_role(
        &self,
        name: &str,
        description: &str,
        features: Vec<String>,
        dangerous: bool,
    ) -> Result<kb_core::account::Role> {
        SystemStore::create_role(self, name, description, features, dangerous).await
    }
    async fn update_role(&self, id: &str, update: RoleUpdate) -> Result<kb_core::account::Role> {
        SystemStore::update_role(self, id, update).await
    }
    async fn delete_role(&self, id: &str) -> Result<()> {
        SystemStore::delete_role(self, id).await
    }
    async fn role_user_counts(&self) -> Result<Vec<(String, i64)>> {
        SystemStore::role_user_counts(self).await
    }
    async fn effective_features(&self, user_id: &str, ai: AiState) -> Result<FeatureSet> {
        SystemStore::effective_features(self, user_id, ai).await
    }
    async fn set_grant(
        &self,
        key: &ResourceKey,
        grantee_id: &str,
        role: Role,
        via: &str,
        created_by: &str,
        now: Millis,
        expires_at: Option<Millis>,
    ) -> Result<SetGrant> {
        SystemStore::set_grant(
            self, key, grantee_id, role, via, created_by, now, expires_at,
        )
        .await
    }
    async fn remove_grant(&self, key: &ResourceKey, grantee_id: &str) -> Result<Option<Role>> {
        SystemStore::remove_grant(self, key, grantee_id).await
    }
    async fn apply_grants(
        &self,
        keys: &[ResourceKey],
        changes: &[GrantChange],
        created_by: &str,
        now: Millis,
        expires_at: Option<Millis>,
    ) -> Result<BatchOutcome> {
        SystemStore::apply_grants(self, keys, changes, created_by, now, expires_at).await
    }
    async fn direct_grants(&self, key: &ResourceKey, now: Millis) -> Result<Vec<GrantView>> {
        SystemStore::direct_grants(self, key, now).await
    }
    async fn lineage_grants(&self, key: &ResourceKey, now: Millis) -> Result<Vec<GrantView>> {
        SystemStore::lineage_grants(self, key, now).await
    }
    async fn granted_role(
        &self,
        user_id: &str,
        key: &ResourceKey,
        now: Millis,
    ) -> Result<Option<Effective>> {
        SystemStore::granted_role(self, user_id, key, now).await
    }
    async fn managers_of(&self, key: &ResourceKey, now: Millis) -> Result<Vec<String>> {
        SystemStore::managers_of(self, key, now).await
    }
    async fn role_of(&self, user_id: &str, key: &ResourceKey, now: Millis) -> Result<Option<Role>> {
        SystemStore::role_of(self, user_id, key, now).await
    }
    async fn require_role(
        &self,
        user_id: &str,
        key: &ResourceKey,
        action: kb_core::share::Action,
        now: Millis,
    ) -> Result<Role> {
        SystemStore::require_role(self, user_id, key, action, now).await
    }
    async fn has_grant_in_space(&self, user_id: &str, space_id: &str, now: Millis) -> Result<bool> {
        SystemStore::has_grant_in_space(self, user_id, space_id, now).await
    }
    async fn has_inherit_breaks_in(&self, space_id: &str, collection: &str) -> Result<bool> {
        SystemStore::has_inherit_breaks_in(self, space_id, collection).await
    }
    async fn space_owner(&self, space_id: &str) -> Result<Option<String>> {
        SystemStore::space_owner(self, space_id).await
    }
    async fn set_inherit_break(
        &self,
        key: &ResourceKey,
        broken: bool,
        by: &str,
        now: Millis,
    ) -> Result<()> {
        SystemStore::set_inherit_break(self, key, broken, by, now).await
    }
    async fn is_inherit_broken(&self, key: &ResourceKey) -> Result<bool> {
        SystemStore::is_inherit_broken(self, key).await
    }
    async fn shared_with(
        &self,
        user_id: &str,
        include_hidden: bool,
        now: Millis,
    ) -> Result<Vec<SharedRoot>> {
        SystemStore::shared_with(self, user_id, include_hidden, now).await
    }
    async fn set_share_hidden(&self, user_id: &str, key: &ResourceKey, hidden: bool) -> Result<()> {
        SystemStore::set_share_hidden(self, user_id, key, hidden).await
    }
    async fn shared_by(&self, owner_id: &str, now: Millis) -> Result<Vec<SharedByMe>> {
        SystemStore::shared_by(self, owner_id, now).await
    }
    async fn purge_expired_grants(&self, now: Millis) -> Result<usize> {
        SystemStore::purge_expired_grants(self, now).await
    }
    async fn rekey_resource(&self, from: &ResourceKey, to: &ResourceKey) -> Result<usize> {
        SystemStore::rekey_resource(self, from, to).await
    }
    async fn forget_resource(&self, key: &ResourceKey) -> Result<usize> {
        SystemStore::forget_resource(self, key).await
    }
    async fn create_access_request(
        &self,
        key: &ResourceKey,
        requester_id: &str,
        role: Role,
        message: Option<&str>,
        now: Millis,
    ) -> Result<Option<AccessRequest>> {
        SystemStore::create_access_request(self, key, requester_id, role, message, now).await
    }
    async fn pending_access_requests_in(&self, space_ids: &[String]) -> Result<Vec<AccessRequest>> {
        SystemStore::pending_access_requests_in(self, space_ids).await
    }
    async fn my_access_requests(&self, requester_id: &str) -> Result<Vec<AccessRequest>> {
        SystemStore::my_access_requests(self, requester_id).await
    }
    async fn get_access_request(&self, id: &str) -> Result<Option<AccessRequest>> {
        SystemStore::get_access_request(self, id).await
    }
    async fn decide_access_request(
        &self,
        id: &str,
        decided_by: &str,
        approve: bool,
        granted_role: Option<Role>,
        now: Millis,
    ) -> Result<AccessRequest> {
        SystemStore::decide_access_request(self, id, decided_by, approve, granted_role, now).await
    }
}

#[async_trait]
impl AccessLinkRepo for SystemStore {
    async fn create_link(
        &self,
        new: NewLink,
        max_links: u32,
        now: Millis,
    ) -> Result<(ShareLink, String)> {
        SystemStore::create_link(self, new, max_links, now).await
    }
    async fn find_link_by_token(&self, token: &str) -> Result<Option<LinkRecord>> {
        SystemStore::find_link_by_token(self, token).await
    }
    async fn get_link(&self, id: &str) -> Result<Option<LinkRecord>> {
        SystemStore::get_link(self, id).await
    }
    async fn links_for_resource(&self, key: &ResourceKey) -> Result<Vec<LinkRecord>> {
        SystemStore::links_for_resource(self, key).await
    }
    async fn links_by_creator(&self, user_id: &str) -> Result<Vec<LinkRecord>> {
        SystemStore::links_by_creator(self, user_id).await
    }
    async fn all_links(&self, limit: u32, offset: u32) -> Result<(Vec<LinkRecord>, i64)> {
        SystemStore::all_links(self, limit, offset).await
    }
    async fn update_link(&self, id: &str, update: LinkUpdate, now: Millis) -> Result<LinkRecord> {
        SystemStore::update_link(self, id, update, now).await
    }
    async fn reset_link_token(&self, id: &str) -> Result<String> {
        SystemStore::reset_link_token(self, id).await
    }
    async fn revoke_link(&self, id: &str, now: Millis) -> Result<bool> {
        SystemStore::revoke_link(self, id, now).await
    }
    async fn record_link_view(
        &self,
        link_id: &str,
        user_id: Option<&str>,
        now: Millis,
    ) -> Result<()> {
        SystemStore::record_link_view(self, link_id, user_id, now).await
    }
    async fn link_visitors(&self, link_id: &str) -> Result<Vec<LinkVisitor>> {
        SystemStore::link_visitors(self, link_id).await
    }
    async fn add_link_bytes(&self, link_id: &str, day: &str, add: u64) -> Result<u64> {
        SystemStore::add_link_bytes(self, link_id, day, add).await
    }
    async fn link_bytes(&self, link_id: &str, day: &str) -> Result<u64> {
        SystemStore::link_bytes(self, link_id, day).await
    }
    async fn touch_guest(
        &self,
        secret_hash: &str,
        link_id: &str,
        ip: Option<&str>,
        now: Millis,
    ) -> Result<Guest> {
        SystemStore::touch_guest(self, secret_hash, link_id, ip, now).await
    }
    async fn set_guest_nickname(&self, guest_id: &str, nickname: &str) -> Result<String> {
        SystemStore::set_guest_nickname(self, guest_id, nickname).await
    }
    async fn purge_stale_guests(&self, before: Millis) -> Result<usize> {
        SystemStore::purge_stale_guests(self, before).await
    }
    async fn purge_link_bytes_before(&self, day: &str) -> Result<usize> {
        SystemStore::purge_link_bytes_before(self, day).await
    }
    async fn revoke_links_within(&self, key: &ResourceKey, now: Millis) -> Result<usize> {
        SystemStore::revoke_links_within(self, key, now).await
    }
    async fn find_for_friending(
        &self,
        searcher_id: &str,
        query: &str,
        now: Millis,
    ) -> Result<Option<(PublicProfile, Relation)>> {
        SystemStore::find_for_friending(self, searcher_id, query, now).await
    }
    async fn send_friend_request(
        &self,
        from_id: &str,
        to_id: &str,
        message: Option<&str>,
        caps: Caps,
        now: Millis,
    ) -> Result<RequestOutcome> {
        SystemStore::send_friend_request(self, from_id, to_id, message, caps, now).await
    }
    async fn decide_friend_request(
        &self,
        request_id: &str,
        decider_id: &str,
        decision: Decision,
        caps: Caps,
        now: Millis,
    ) -> Result<FriendRequest> {
        SystemStore::decide_friend_request(self, request_id, decider_id, decision, caps, now).await
    }
    async fn incoming_friend_requests(
        &self,
        user_id: &str,
        now: Millis,
    ) -> Result<Vec<(FriendRequest, PublicProfile)>> {
        SystemStore::incoming_friend_requests(self, user_id, now).await
    }
    async fn outgoing_friend_requests(
        &self,
        user_id: &str,
        now: Millis,
    ) -> Result<Vec<(FriendRequest, PublicProfile)>> {
        SystemStore::outgoing_friend_requests(self, user_id, now).await
    }
    async fn list_friends(&self, user_id: &str) -> Result<Vec<Friend>> {
        SystemStore::list_friends(self, user_id).await
    }
    async fn update_friend(
        &self,
        user_id: &str,
        friend_id: &str,
        remark: Option<Option<String>>,
        group_name: Option<Option<String>>,
    ) -> Result<()> {
        SystemStore::update_friend(self, user_id, friend_id, remark, group_name).await
    }
    async fn remove_friend(&self, user_id: &str, friend_id: &str) -> Result<bool> {
        SystemStore::remove_friend(self, user_id, friend_id).await
    }
    async fn block_user(&self, user_id: &str, target_id: &str, now: Millis) -> Result<()> {
        SystemStore::block_user(self, user_id, target_id, now).await
    }
    async fn unblock_user(&self, user_id: &str, target_id: &str) -> Result<bool> {
        SystemStore::unblock_user(self, user_id, target_id).await
    }
    async fn list_blocks(&self, user_id: &str) -> Result<Vec<(PublicProfile, Millis)>> {
        SystemStore::list_blocks(self, user_id).await
    }
    async fn are_friends(&self, a: &str, b: &str) -> Result<bool> {
        SystemStore::are_friends(self, a, b).await
    }
    async fn is_blocked_between(&self, a: &str, b: &str) -> Result<bool> {
        SystemStore::is_blocked_between(self, a, b).await
    }
    async fn friend_count(&self, user_id: &str) -> Result<i64> {
        SystemStore::friend_count(self, user_id).await
    }
    async fn privacy_of(&self, user_id: &str) -> Result<Privacy> {
        SystemStore::privacy_of(self, user_id).await
    }
    async fn set_privacy(&self, user_id: &str, privacy: Privacy) -> Result<()> {
        SystemStore::set_privacy(self, user_id, privacy).await
    }
    async fn make_friends(&self, a: &str, b: &str, caps: Caps, now: Millis) -> Result<bool> {
        SystemStore::make_friends(self, a, b, caps, now).await
    }
}

#[async_trait]
impl NotifyRepo for SystemStore {
    async fn add_notification(
        &self,
        user_id: &str,
        notification_kind: &str,
        data: &Value,
        now: Millis,
    ) -> Result<i64> {
        SystemStore::add_notification(self, user_id, notification_kind, data, now).await
    }
    async fn list_notifications(
        &self,
        user_id: &str,
        unread_only: bool,
        before_id: Option<i64>,
        limit: u32,
    ) -> Result<Vec<Notification>> {
        SystemStore::list_notifications(self, user_id, unread_only, before_id, limit).await
    }
    async fn unread_notifications(&self, user_id: &str) -> Result<u64> {
        SystemStore::unread_notifications(self, user_id).await
    }
    async fn mark_notifications_read(
        &self,
        user_id: &str,
        ids: &[i64],
        now: Millis,
    ) -> Result<usize> {
        SystemStore::mark_notifications_read(self, user_id, ids, now).await
    }
    async fn mark_all_notifications_read(&self, user_id: &str, now: Millis) -> Result<usize> {
        SystemStore::mark_all_notifications_read(self, user_id, now).await
    }
    async fn purge_old_notifications(&self, now: Millis) -> Result<usize> {
        SystemStore::purge_old_notifications(self, now).await
    }
    async fn notify_email_prefs(&self, user_id: &str) -> Result<HashMap<String, bool>> {
        SystemStore::notify_email_prefs(self, user_id).await
    }
    async fn set_notify_email_prefs(
        &self,
        user_id: &str,
        changes: &HashMap<String, bool>,
    ) -> Result<()> {
        SystemStore::set_notify_email_prefs(self, user_id, changes).await
    }
    async fn queue_notification_mail(
        &self,
        user_id: &str,
        notification_id: i64,
        now: Millis,
    ) -> Result<()> {
        SystemStore::queue_notification_mail(self, user_id, notification_id, now).await
    }
    async fn due_notification_digests(
        &self,
        now: Millis,
        min_gap_ms: i64,
        max_users: u32,
    ) -> Result<Vec<Digest>> {
        SystemStore::due_notification_digests(self, now, min_gap_ms, max_users).await
    }
    async fn finish_notification_digest(
        &self,
        user_id: &str,
        queue_ids: &[i64],
        sent: bool,
        now: Millis,
    ) -> Result<()> {
        SystemStore::finish_notification_digest(self, user_id, queue_ids, sent, now).await
    }
    async fn prune_history(
        &self,
        table: SystemRetentionTable,
        before: i64,
        dry_run: bool,
    ) -> Result<u64> {
        SystemStore::prune_history(self, table, before, dry_run).await
    }
    async fn put_metric(&self, row: MetricRow) -> Result<()> {
        SystemStore::put_metric(self, row).await
    }
    async fn prune_metrics(&self, before: i64) -> Result<u64> {
        SystemStore::prune_metrics(self, before).await
    }
    async fn metric_series(
        &self,
        since: i64,
        until: i64,
        bucket_ms: i64,
    ) -> Result<Vec<MetricRow>> {
        SystemStore::metric_series(self, since, until, bucket_ms).await
    }
}

#[async_trait]
impl SignupRepo for SystemStore {
    async fn get_or_create_secret(
        &self,
        key: &str,
        make: Box<dyn FnOnce() -> String + Send>,
    ) -> Result<String> {
        SystemStore::get_or_create_secret(self, key, make).await
    }
    async fn issue_email_code(
        &self,
        email: &str,
        purpose: EmailPurpose,
        code_hash: &str,
        ip: Option<&str>,
        ttl_ms: i64,
        limits: CodeLimits,
        now: Millis,
    ) -> Result<IssueOutcome> {
        SystemStore::issue_email_code(self, email, purpose, code_hash, ip, ttl_ms, limits, now)
            .await
    }
    async fn verify_email_code(
        &self,
        email: &str,
        purpose: EmailPurpose,
        candidate_hash: &str,
        now: Millis,
    ) -> Result<VerifyOutcome> {
        SystemStore::verify_email_code(self, email, purpose, candidate_hash, now).await
    }
    async fn consume_email_code(&self, id: &str, now: Millis) -> Result<bool> {
        SystemStore::consume_email_code(self, id, now).await
    }
    async fn create_invite(&self, new: NewInvite) -> Result<InviteCode> {
        SystemStore::create_invite(self, new).await
    }
    async fn list_invites(&self, created_by: Option<&str>) -> Result<Vec<InviteCode>> {
        SystemStore::list_invites(self, created_by).await
    }
    async fn revoke_invite(&self, id: &str, owner: Option<&str>, at: Millis) -> Result<bool> {
        SystemStore::revoke_invite(self, id, owner, at).await
    }
    async fn peek_invite(&self, code_hash: &str, now: Millis) -> Result<Option<InviteCode>> {
        SystemStore::peek_invite(self, code_hash, now).await
    }
    async fn claim_invite(&self, code_hash: &str, now: Millis) -> Result<Option<InviteCode>> {
        SystemStore::claim_invite(self, code_hash, now).await
    }
    async fn release_invite(&self, id: &str) -> Result<()> {
        SystemStore::release_invite(self, id).await
    }
    async fn record_invite_use(
        &self,
        invite_id: &str,
        user_id: &str,
        ip: Option<&str>,
        at: Millis,
    ) -> Result<()> {
        SystemStore::record_invite_use(self, invite_id, user_id, ip, at).await
    }
    async fn invite_uses(&self, invite_id: &str) -> Result<Vec<(String, Option<String>, Millis)>> {
        SystemStore::invite_uses(self, invite_id).await
    }
    async fn record_mail(
        &self,
        to: &str,
        kind: &str,
        ok: bool,
        via: Option<&str>,
        error: Option<&str>,
    ) -> Result<()> {
        SystemStore::record_mail(self, to, kind, ok, via, error).await
    }
    async fn list_mail_log(&self, limit: u32) -> Result<Vec<MailLogEntry>> {
        SystemStore::list_mail_log(self, limit).await
    }
    async fn mails_since(&self, since: Millis) -> Result<i64> {
        SystemStore::mails_since(self, since).await
    }
    async fn purge_registration_data(&self, now: Millis) -> Result<usize> {
        SystemStore::purge_registration_data(self, now).await
    }
    async fn request_deletion(
        &self,
        user_id: &str,
        now: Millis,
        cooling_off_ms: i64,
    ) -> Result<Millis> {
        SystemStore::request_deletion(self, user_id, now, cooling_off_ms).await
    }
    async fn request_deletion_detailed(
        &self,
        user_id: &str,
        now: Millis,
        cooling_off_ms: i64,
    ) -> Result<(Millis, bool)> {
        SystemStore::request_deletion_detailed(self, user_id, now, cooling_off_ms).await
    }
    async fn cancel_deletion(&self, user_id: &str, now: Millis) -> Result<()> {
        SystemStore::cancel_deletion(self, user_id, now).await
    }
    async fn due_for_deletion(&self, now: Millis) -> Result<Vec<String>> {
        SystemStore::due_for_deletion(self, now).await
    }
    async fn check_purgeable(&self, user_id: &str, now: Millis) -> Result<Purgeable> {
        SystemStore::check_purgeable(self, user_id, now).await
    }
    async fn purge_user(&self, user_id: &str, now: Millis) -> Result<()> {
        SystemStore::purge_user(self, user_id, now).await
    }
    async fn begin_totp(&self, user_id: &str, secret_b32: &str, now: Millis) -> Result<()> {
        SystemStore::begin_totp(self, user_id, secret_b32, now).await
    }
    async fn totp_state(&self, user_id: &str) -> Result<Option<TotpState>> {
        SystemStore::totp_state(self, user_id).await
    }
    async fn totp_enabled(&self, user_id: &str) -> Result<bool> {
        SystemStore::totp_enabled(self, user_id).await
    }
    async fn confirm_totp(
        &self,
        user_id: &str,
        step: u64,
        recovery_hashes: &[String],
        now: Millis,
    ) -> Result<()> {
        SystemStore::confirm_totp(self, user_id, step, recovery_hashes, now).await
    }
    async fn claim_totp_step(&self, user_id: &str, step: u64) -> Result<bool> {
        SystemStore::claim_totp_step(self, user_id, step).await
    }
    async fn use_recovery_code(&self, user_id: &str, code_hash: &str, now: Millis) -> Result<bool> {
        SystemStore::use_recovery_code(self, user_id, code_hash, now).await
    }
    async fn recovery_codes_left(&self, user_id: &str) -> Result<u32> {
        SystemStore::recovery_codes_left(self, user_id).await
    }
    async fn replace_recovery_codes(&self, user_id: &str, hashes: &[String]) -> Result<()> {
        SystemStore::replace_recovery_codes(self, user_id, hashes).await
    }
    async fn disable_totp(&self, user_id: &str) -> Result<bool> {
        SystemStore::disable_totp(self, user_id).await
    }
}

#[async_trait]
impl AdminKeyRepo for SystemStore {
    async fn ensure_admin_key(&self, user_id: &str) -> Result<UserAdminKey> {
        SystemStore::ensure_admin_key(self, user_id).await
    }
    async fn rotate_admin_key(&self, user_id: &str, at: Millis) -> Result<UserAdminKey> {
        SystemStore::rotate_admin_key(self, user_id, at).await
    }
    async fn find_user_by_admin_key(&self, admin_key: &str) -> Result<Option<User>> {
        SystemStore::find_user_by_admin_key(self, admin_key).await
    }
    async fn add_llm_usage(
        &self,
        user_id: &str,
        day: &str,
        purpose: &str,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<()> {
        SystemStore::add_llm_usage(self, user_id, day, purpose, input_tokens, output_tokens).await
    }
    async fn llm_usage_series(
        &self,
        first_day: &str,
        last_day: &str,
    ) -> Result<Vec<(String, String, u64, u64, u64)>> {
        SystemStore::llm_usage_series(self, first_day, last_day).await
    }
    async fn llm_tokens_on(&self, user_id: &str, day: &str) -> Result<u64> {
        SystemStore::llm_tokens_on(self, user_id, day).await
    }
    async fn llm_usage_ranking(&self, day: &str, limit: u32) -> Result<Vec<UserLlmUsage>> {
        SystemStore::llm_usage_ranking(self, day, limit).await
    }
    async fn purge_llm_usage_before(&self, before_day: &str) -> Result<usize> {
        SystemStore::purge_llm_usage_before(self, before_day).await
    }
}
