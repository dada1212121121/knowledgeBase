//! 任务队列（设计规范）。
//!
//! - 并发分片:一个知识库的后台开多条循环并行跑**不同**任务,能同时干几片由全站名额
//!   `index.parallel_slices` 决定(热读);认领任务是一个写事务(`claim_next`),不会重复执行;
//! - 优先级:编辑单条 100 > save_insight 90 > hook 增量 80 > review/extract 60 >
//!   全量索引 20 > 迁移 10 > 维护 5;
//! - 长任务分片:每个分片保存检查点,发现更高优先级的任务就让出;
//! - 去重合并:同一 collection 排队中的增量索引任务会合并 paths;
//! - 重启恢复:启动时把 `running` 改回 `queued`,从检查点继续。

pub mod index_handler;
pub mod migrate_handler;
pub mod queue;
pub mod slots;
pub mod worker;

pub use index_handler::{IndexCheckpoint, IndexJobHandler, IndexPayload};
pub use migrate_handler::{MigrateJobHandler, MigratePayload};
pub use queue::{JobQueue, NewJob, priority};
pub use worker::{JobHandler, JobObserver, JobRouter, SliceProgress, Worker};
