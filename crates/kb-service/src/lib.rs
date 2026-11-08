//! 应用服务层（设计规范）。
//!
//! 只依赖 `kb-core` 的 trait;真实适配器由 `kb-cli` 在组装根注入,
//! 集成测试通过 dev-dependency `kb-testkit` 拿到真实的 SQLite / LanceDB 与 Fake embedder。

//! 服务层不许 panic:这里的函数都在请求 / 任务路径上,`panic!` 会让调用方
//! 拿到「任务没了」而不是一条 `KbError`。实测本 crate 的 src 里 0 处(2026-11-07,
//! clippy `unwrap_used` + `panic` 扫),所以这条是**棘轮**:只防新增。
//! 注意 `expect` 没一起禁:剩下 12 处都是「锁中毒 / 刚插入过的元素 / 固定字面量」的
//! 不变量,真失败说明进程状态已坏。
#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::panic))]

pub mod acp_registry;
pub mod agent;
pub mod annotation;
pub mod backup;
pub mod collections;
pub mod config_reload;
pub mod context;
pub mod doc_links;
pub mod edit;
pub mod edit_csv;
pub mod evolution;
pub mod export;
pub mod file_ops;
pub mod index;
pub mod ingest;
pub mod insight;
pub mod items;
pub mod jobs;
pub mod llm_gate;
pub mod llm_providers;
pub mod metrics;
pub mod migration;
pub mod office_convert;
pub mod office_install;
pub mod projects;
pub mod providers;
pub mod query_enhance;
pub mod refresh;
pub mod revert;
pub mod safe_path;
pub mod scheduler;
pub mod search;
pub mod skills;
pub mod skills_watch;
pub mod sources;
pub mod sources_web;
pub mod stats;
pub mod storage;
pub mod supervise;
pub mod system_status;
pub mod tuning;
pub mod upload;
pub mod web;
pub mod web_extract;
pub mod write_assist;
pub mod write_gate;

pub use collections::{CollectionInfo, CollectionService};
pub use config_reload::{
    CONFIG_DEBOUNCE_MS, ConfigObserver, ConfigReloader, ConfigWatcher, EmbedMigrationPlan,
    ReloadOutcome,
};
pub use evolution::{EventKind, EventOutcome, EventRequest, EventService};
pub use file_ops::{FileOpsService, MAX_FOLDER_FILES, TRASH_RETENTION_MS};
pub use index::{FileStats, IndexOptions, IndexReport, IndexService, IndexStage};
pub use ingest::{
    BatchProgress, BatchService, CancelReport, FileTimeline, ProgressTracker, StageEntry,
};
pub use insight::{
    FeedbackRequest, InsightJobHandler, InsightService, ReindexRequest, SaveInsightRequest,
    SaveInsightResult,
};
pub use items::{
    BatchTagResult, CreateRequest, DeleteResult, EditRequest, EditResult, ItemService, ItemSummary,
    ListRequest, ListResponse, TaggedItem,
};
pub use jobs::{
    IndexCheckpoint, IndexJobHandler, IndexPayload, JobHandler, JobObserver, JobQueue, JobRouter,
    NewJob, SliceProgress, Worker,
};
pub use llm_providers::{LlmProviderInfo, catalog as llm_provider_catalog};
pub use projects::{ProjectInfo, ProjectPatch, ProjectService};
pub use revert::{RevertReport, RevertService};
pub use search::{NoopReranker, SearchOptions, SearchRequest, SearchResponse, SearchService};
pub use skills::{
    InsightTemplate, LoaderMatch, LoaderRule, OfficialPluginInfo, PluginDraft, PluginExecDraft,
    PluginFileDraft, PluginPermissionsDraft, PluginSourceDraft, PromptStage, SkillDraft, SkillKind,
    SkillRegistry, install_official_plugin, official_plugins, official_plugins_with,
    uninstall_official_plugin,
};
pub use sources::{
    AddSourceRequest, RemovedSource, SourceService, SyncOutcome, UpdateSourceRequest,
};
pub use stats::{Overview, StatsService};
pub use tuning::{FeedbackTuning, TuneOptions, TunePlan, UsefulnessGroup, WeightSuggestion};
pub use upload::{
    CompletedUpload, IngestJobHandler, IngestPayload, IngestService, IngestStatus, NewUpload,
    PartAck, PrecheckItem, PrecheckResult, RetryReport, UploadObserver, UploadService,
    UploadSession,
};
pub use web::{
    AuditListResponse, BatchListResponse, BatchView, ChangeView, ConfigUpdate, CreatedToken,
    DeletedCollection, MigrationPlan, RevokedToken, WebService,
};
pub use write_gate::WriteGate;
