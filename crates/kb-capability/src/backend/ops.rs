//! 运维与配置:配置、令牌、组件(provider / OCR)、索引维护与备份:改这些都会影响整台机器。
//!
//! 见 [`super::CapabilityBackend`](CapabilityBackend)。

use super::*;

#[async_trait]
pub trait OpsBackend: Send + Sync {
    /// 每张物理表的实际状况(碎片 / 版本 / 索引覆盖)。默认不可用:内存实现没有这些概念。
    async fn index_stats(&self) -> Result<Value> {
        Err(kb_core::KbError::Unavailable(
            "表状况诊断没有启用".to_owned(),
        ))
    }

    /// 现在就整理索引与碎片。默认不可用。
    async fn maintain_indexes(&self, _args: crate::defs::MaintainIndexesArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("索引维护没有启用".to_owned()))
    }

    /// 条目去重。
    async fn dedup_insights(&self, args: crate::defs::DedupArgs) -> Result<Value>;

    /// 质量报告。
    async fn quality_report(&self, args: crate::defs::QualityReportArgs) -> Result<Value>;

    /// 主题归纳。
    async fn consolidate_project(&self, args: crate::defs::ConsolidateArgs) -> Result<Value>;

    /// OCR 后端状态(可用性 / 当前选用 / 安装进度)。
    async fn ocr_status(&self) -> Result<Value>;

    /// 切换 OCR 后端。
    async fn set_ocr_backend(&self, args: crate::defs::SetOcrBackendArgs) -> Result<Value>;

    /// 下载 / 安装 OCR 运行时与模型(后台跑,进度用 `ocr_status` 查)。
    async fn ocr_install(&self) -> Result<Value>;

    /// 组件目录(OCR / 转写 / 嵌入 / 重排)。
    async fn provider_list(&self) -> Result<Value>;

    /// 安装 / 下载一个组件。
    async fn provider_install(&self, args: crate::defs::ProviderArgs) -> Result<Value>;

    /// 把某个组件设为默认。
    async fn provider_set_default(&self, args: crate::defs::ProviderArgs) -> Result<Value>;

    /// 卸载一个组件(只清模型,不动运行时)。
    async fn provider_uninstall(&self, args: crate::defs::ProviderArgs) -> Result<Value>;

    /// 环境检测(CPU / 内存 / 磁盘 / GPU / 已装工具)。
    async fn env_profile(&self) -> Result<Value>;

    /// 按环境给出组件推荐。
    async fn recommend_providers(&self) -> Result<Value>;

    /// 系统状态(六块:总览 / 资源 / 组件 / 任务 / 网络 / 日志)。
    async fn system_status(&self) -> Result<Value>;

    /// 备份状态:归档列表、各部分占用、备份范围说明。
    async fn backup_status(&self) -> Result<Value>;

    /// 备份的轻量状态:正在打包的进度 + 未解决的失败告警(外壳横幅用,不统计磁盘占用)。
    async fn backup_state(&self) -> Result<Value>;

    /// 校验一份归档(gzip / tar 结构、manifest 与 meta.db;只读)。
    async fn backup_verify(&self, args: crate::defs::BackupVerifyArgs) -> Result<Value>;

    /// 新建一份备份(元数据 + 配置 + skills + 评测;原件可选)。
    async fn backup_create(&self, args: crate::defs::BackupCreateArgs) -> Result<Value>;

    /// 删除一份备份。
    async fn backup_delete(&self, args: crate::defs::BackupDeleteArgs) -> Result<Value>;

    /// 按保留策略清理旧备份(可预演)。
    async fn backup_prune(&self, args: crate::defs::BackupPruneArgs) -> Result<Value>;

    /// 读配置。
    async fn get_config(&self) -> Result<Value>;

    /// 改配置。
    async fn update_config(&self, args: crate::defs::UpdateConfigArgs) -> Result<Value>;

    /// 重新读一次 `config.toml`。
    async fn reload_config(&self) -> Result<Value>;

    /// LLM 提供商清单与配置状态(只读)。
    async fn llm_providers(&self) -> Result<Value>;

    /// 反馈调权:给建议;`dry_run = false` 时写配置并在前后跑评测。
    async fn tune_retrieval(&self, args: crate::defs::TuneRetrievalArgs) -> Result<Value>;

    /// 新建 API 令牌。
    async fn create_token(&self, args: crate::defs::CreateTokenArgs) -> Result<Value>;

    /// 撤销 API 令牌。
    async fn revoke_token(&self, args: crate::defs::TokenIdArgs) -> Result<Value>;

    /// 保存 / 清除 LLM 的 API key。
    async fn set_llm_key(&self, args: crate::defs::SetLlmKeyArgs) -> Result<Value>;

    /// 用当前 LLM 配置发一次最小请求。
    async fn test_llm(&self, args: crate::defs::TestLlmArgs) -> Result<Value>;
}
