//! 管理员只读查看闸门(MULTI_USER_ADMIN 扩展):`X-KB-Admin-View` 指向谁,就把调用路由到谁的知识库。
//!
//! 和 `shared_gate.rs` 的区别:
//! - **不做逐资源授权**:管理员既然被授予 `sys.inspect`,就能看整库;
//! - **只开只读白名单**:写操作、AI、分享、管理能力即使带了这个头也一律拒绝;
//! - 目标用户必须存在且有个人知识库;看不到的一律 404,不暴露知识库是否存在。
//!
//! 调用者身份仍是管理员本人(审计里的 actor 也是管理员),这里只换知识库,不换人。

use std::sync::Arc;

use async_trait::async_trait;
use kb_capability::Principal;
use kb_capability::invoke::{AdminViewGate, ResolvedSpace};
use kb_core::config::ConfigStore;
use kb_core::{KbError, Result};
use kb_meta::SystemStore;

use crate::spaces::SpaceRegistry;

/// 管理员在别人的知识库里**只读**能调的能力。
///
/// 清单之外的一律拒绝:预览、列表、任务详情、导入记录够用;任何会写盘 / 调模型 /
/// 改账号的能力都不在这里(前端也会把入口藏掉,这里是后端的底线)。
pub const READONLY: &[&str] = &[
    "activity_series",
    "batch_list",
    "file_preview",
    "file_raw",
    "file_versions",
    "get_batch_progress",
    "get_item",
    "item_facets",
    "item_history",
    "job_files",
    "job_get",
    "job_list",
    "job_stats",
    "list_annotations",
    "list_collections",
    "list_ingest",
    "list_items",
    "list_sources",
    "stats_overview",
];

/// 这个能力在「管理员查看」下是否只读可用。
pub fn is_readonly(name: &str) -> bool {
    READONLY.contains(&name)
}

/// 管理员查看闸门。
pub struct AdminViewGateImpl {
    system: Arc<SystemStore>,
    spaces: Arc<SpaceRegistry>,
    config: Arc<ConfigStore>,
}

impl AdminViewGateImpl {
    /// 构造。
    pub fn new(
        system: Arc<SystemStore>,
        spaces: Arc<SpaceRegistry>,
        config: Arc<ConfigStore>,
    ) -> Arc<Self> {
        Arc::new(Self {
            system,
            spaces,
            config,
        })
    }
}

#[async_trait]
impl AdminViewGate for AdminViewGateImpl {
    async fn authorize(
        &self,
        principal: &Principal,
        capability: &str,
        target_user: &str,
    ) -> Result<ResolvedSpace> {
        if !self.config.get().admin.inspect_enabled {
            return Err(KbError::Forbidden("管理员查看功能已关闭".to_owned()));
        }
        if principal.local {
            return Err(KbError::Forbidden(
                "本机超级用户请直接使用主知识库".to_owned(),
            ));
        }
        if !principal.features.allows("sys.inspect") {
            return Err(KbError::Forbidden(
                "你的账号没有开通「查看他人知识库」".to_owned(),
            ));
        }
        if target_user == principal.user_id {
            return Err(KbError::Forbidden(
                "这是你自己的知识库,直接打开就行".to_owned(),
            ));
        }
        if !is_readonly(capability) {
            return Err(KbError::Forbidden(
                "管理员查看是只读的,这个操作不可用".to_owned(),
            ));
        }
        let Some(user) = self.system.get_user(target_user).await? else {
            return Err(KbError::NotFound(format!("用户 {target_user}")));
        };
        let Some(space) = self.system.personal_space(&user.id).await? else {
            return Err(KbError::NotFound("这个用户还没有个人知识库".to_owned()));
        };
        let runtime = self.spaces.get(&space.id).await?;
        Ok(ResolvedSpace {
            space_id: space.id,
            audit: runtime.meta.clone(),
            handle: runtime,
        })
    }
}
