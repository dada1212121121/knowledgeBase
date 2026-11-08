//! 存储配额的守门人(多用户设计说明):上传、新建笔记之前问一句「还装得下吗」。
//!
//! 配额按**调用者**算(全站默认 → 角色 → 用户例外),占用按调用者**自己的知识库**算(含向量索引)。
//! 本机超级用户用全站默认配额,与账号无关。超额只拦「新增」:读、删、改已有内容不受影响,
//! 否则用户满了以后连删东西腾空间都做不到。

use std::sync::Arc;

use kb_core::Result;
use kb_core::config::ConfigStore;
use kb_core::paths::KbPaths;
use kb_meta::SystemStore;
use kb_service::storage::StorageMeter;

const GIB: u64 = 1024 * 1024 * 1024;

/// 存储配额守门人。
pub struct StorageGuard {
    meter: Arc<StorageMeter>,
    system: Option<Arc<SystemStore>>,
    config: Arc<ConfigStore>,
}

impl StorageGuard {
    /// 构造。没有账号库(单库模式)时只用全站默认配额。
    pub fn new(
        meter: Arc<StorageMeter>,
        system: Option<Arc<SystemStore>>,
        config: Arc<ConfigStore>,
    ) -> Arc<Self> {
        Arc::new(Self {
            meter,
            system,
            config,
        })
    }

    /// 用量表(上传服务要用)。
    pub fn meter(&self) -> &Arc<StorageMeter> {
        &self.meter
    }

    /// 这个调用者最多能占多少字节(0 = 不限)。
    ///
    /// 本机超级用户(`kb.sock`、git hook、`kb mcp`)不限:它们是服务器主人自己的工具,
    /// 配额拦它们只会让会话 hook 在数据变大后悄悄写不进去。管理员在网页上登录则和别人一样按配额,
    /// 想放开就给自己的账号设 `storage_gb = 0`。
    pub async fn limit_bytes(&self, user_id: &str, local: bool) -> Result<u64> {
        if local {
            return Ok(0);
        }
        let defaults = self.config.get().quota.clone();
        let quota = match &self.system {
            Some(system) => system.effective_quota(user_id, &defaults).await?,
            None => defaults,
        };
        Ok(quota.storage_gb.saturating_mul(GIB))
    }

    /// 删了东西以后调:让用量缓存失效,释放出来的空间马上能被看到(否则要等缓存过期)。
    pub fn invalidate(&self, space_id: &str) {
        self.meter.invalidate(space_id);
    }

    /// 在 `space_id` 这个知识库里新增 `extra` 字节之前的检查。
    ///
    /// **谁的空间、谁的配额**:占用算在知识库的主人头上,配额也取主人的——协作者往别人分享给他的知识库里写东西
    /// (编辑、新建、传附件),是在用主人的空间,不是自己的。本机超级用户不限。
    pub async fn ensure_room(
        &self,
        principal: &kb_capability::Principal,
        space_id: &str,
        paths: &KbPaths,
        extra: u64,
    ) -> Result<()> {
        let owner = match &self.system {
            Some(system) if !principal.local => system
                .space_owner(space_id)
                .await?
                .unwrap_or_else(|| principal.user_id.clone()),
            _ => principal.user_id.clone(),
        };
        let limit = self.limit_bytes(&owner, principal.local).await?;
        self.meter.reserve(space_id, paths, extra, limit).await
    }
}
