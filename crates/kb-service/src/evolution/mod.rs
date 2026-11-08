//! 进化回路:事件、git 增量、文件监听、调度。

pub mod consolidate;
pub mod drafts;
pub mod events;
pub mod extract;
pub mod git;
pub mod hooks;
pub mod inbox;
pub mod quality;
pub mod review;
pub mod session;
pub mod watch;
pub mod watch_registry;

pub use consolidate::{
    ClusterOutcome, ConsolidateReport, ConsolidateService, TopicCluster, TopicMember,
};
pub use drafts::{CandidateOutcome, EvolutionService, ProcessOutcome};
pub use events::{
    EventKind, EventOutcome, EventRequest, EventService, recover_interrupted_pending,
};
pub use extract::{Candidate, ExtractInput};
pub use git::{ChangedFiles, GitRepo};
pub use hooks::{HOOK_NAMES, HookManager, HookReport, HookStatus};
pub use inbox::{ApproveEdits, ApproveOutcome, DraftInbox, InboxItem, InboxPage, RejectOutcome};
pub use quality::{DedupPlan, DedupService, QualityReport};
pub use review::{Decision, Review, SimilarItem};
pub use session::{
    claude_project_slug, claude_project_slug_variants, collect_dialogue, find_claude_session,
    find_kiro_session, kiro_session_by_id, read_session_text,
};
pub use watch_registry::{SyncReport, WatchRegistry};
