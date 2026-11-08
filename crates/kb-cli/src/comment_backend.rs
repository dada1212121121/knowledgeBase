//! 评论的「通讯录」:@ 到谁、对方能不能看到这篇文档、作者的资料、发通知。
//!
//! 评论本身存在各知识库自己的 `meta.db` 里(`AnnotationService`),而用户、授权和通知都在全站共用的
//! `system.db`。能力的处理函数(`capability_backend.rs`)跑在某个知识库里,够不到后者,
//! 所以守护进程启动时把这个对象事后注入进去。嵌入式、测试里没有注入就什么也不做:评论照常写,只是没有 @ 通知。

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use kb_core::share::ResourceKey;
use kb_meta::SystemStore;
use serde_json::{Value, json};

/// 一个可以被 @ 的人。
#[derive(Clone, Debug)]
pub(crate) struct MentionTarget {
    pub user_id: String,
}

#[async_trait]
pub(crate) trait CommentDirectory: Send + Sync {
    /// 用户名 → 存在、账号可用的用户。不存在 / 已停用的人直接缺席,不告诉调用方为什么。
    async fn resolve_mentions(&self, usernames: &[String]) -> Vec<MentionTarget>;
    /// 这个人能不能看到这篇文档(所有者,或有任意授权)。
    async fn can_view(&self, user_id: &str, space_id: &str, collection: &str, source: &str)
    -> bool;
    /// 作者资料(显示名、头像)。只返回查得到的。
    async fn profiles(&self, ids: &[String]) -> HashMap<String, Value>;
    /// 发一条站内通知(失败不影响评论本身)。
    async fn notify(&self, to: &str, kind: &str, data: Value);
}

/// 基于 `system.db` 和通知器的实现。
pub(crate) struct SystemCommentDirectory {
    system: Arc<SystemStore>,
    notifier: Arc<kb_web::notify::Notifier>,
}

impl SystemCommentDirectory {
    pub(crate) fn new(
        system: Arc<SystemStore>,
        notifier: Arc<kb_web::notify::Notifier>,
    ) -> Arc<Self> {
        Arc::new(Self { system, notifier })
    }
}

/// 评论所在的文档对应的资源键:`insight:<id>` 是笔记,其余是文件路径。
pub(crate) fn document_key(space_id: &str, collection: &str, source: &str) -> Option<ResourceKey> {
    match source.strip_prefix("insight:") {
        Some(id) => ResourceKey::insight(space_id, collection, id).ok(),
        None => ResourceKey::file(space_id, collection, source).ok(),
    }
}

fn now_ms() -> i64 {
    kb_service::llm_gate::today_now_millis()
}

#[async_trait]
impl CommentDirectory for SystemCommentDirectory {
    async fn resolve_mentions(&self, usernames: &[String]) -> Vec<MentionTarget> {
        let mut out = Vec::new();
        // 一条评论最多 @ 10 个人:再多就是在刷屏
        for name in usernames.iter().take(10) {
            let name = name.trim().trim_start_matches('@');
            if name.is_empty() || name.len() > 64 {
                continue;
            }
            // 只按用户名找,不按邮箱:@ 一个邮箱地址不该成为确认某邮箱是否注册的办法
            let Ok(Some(user)) = self.system.find_user_by_login(name).await else {
                continue;
            };
            if user.username.eq_ignore_ascii_case(name) && user.status.can_sign_in() {
                out.push(MentionTarget { user_id: user.id });
            }
        }
        out
    }

    async fn can_view(
        &self,
        user_id: &str,
        space_id: &str,
        collection: &str,
        source: &str,
    ) -> bool {
        if matches!(self.system.space_owner(space_id).await, Ok(Some(owner)) if owner == user_id) {
            return true;
        }
        let Some(key) = document_key(space_id, collection, source) else {
            return false;
        };
        matches!(
            self.system.role_of(user_id, &key, now_ms()).await,
            Ok(Some(_))
        )
    }

    async fn profiles(&self, ids: &[String]) -> HashMap<String, Value> {
        let mut out = HashMap::new();
        for id in ids {
            if let Ok(Some(user)) = self.system.get_user(id).await {
                out.insert(
                    id.clone(),
                    json!({
                        "id": user.id,
                        "username": user.username,
                        "display_name": user.display_name,
                        "avatar": user.avatar,
                    }),
                );
            }
        }
        out
    }

    async fn notify(&self, to: &str, kind: &str, data: Value) {
        self.notifier.send(to, kind, data, now_ms()).await;
    }
}
