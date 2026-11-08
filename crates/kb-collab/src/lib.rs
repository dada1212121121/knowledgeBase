//! 多人在线编辑(多用户设计说明):服务端的 Yjs 房间。
//!
//! 分层:
//! - `core`:一个房间的全部**同步**逻辑(协议、权限、在线状态、落地者、初始化、待持久化的更新),
//!   不碰网络、不碰时钟、不碰存储,所有输入输出都是参数和返回值,所以能确定性地测。
//! - `hub`:把房间放进异步世界——按文档找房间、加载 / 持久化、定时器(刷盘、落地去抖、
//!   保存点、空闲回收)、会话(一条连接)。
//! - `store`:持久化接口与内存实现(守护进程用 SQLite 实现,在 `kb-meta`)。
//! - `hooks`:房间需要外面做的事(读正文、把内容落回 Markdown、生成版本),由守护进程实现。
//!
//! 存储格式始终是 Markdown / 文本;Yjs 状态只是协作期间的中间态（设计规范）。

pub mod core;
pub mod hooks;
pub mod hub;
pub mod store;
pub mod types;

pub use hooks::{Access, Body, CollabAuth, CollabHooks, Landing};
pub use hub::{CollabHub, JoinRequest, RoomInfo, Session};
pub use store::{CollabStore, MemoryStore, StoredDoc};
pub use types::{DocKind, DocRef, Frame, Limits, Participant};
