//! axum:REST / WS / 鉴权 / 静态资源(rust-embed)/ 可选 /mcp。
//!
//! 提供:同一个 Router 同时服务 TCP 与 UDS、来源标记中间件、能力列表与调用接口、WS 心跳。
//! 对 TCP 来源要过鉴权(会话 cookie / Bearer),UDS 来源是本机超级用户。
//! 对 `/api/v1/ws` 通过 [`hub::EventHub`] 推送任务进度与条目变更。

//! 请求路径不许 panic:axum 里一个 `panic!` / `unwrap` 会被兜成 500 或直接断连接,
//! 调用方拿不到「哪里错了」。实测本 crate 的 src 里 0 处(2026-11-07,clippy
//! `unwrap_used` + `panic` 扫),所以这条是**棘轮**:只防新增,不豁免存量。
//! 注意 `expect` 没一起禁:剩下 12 处都是「锁中毒 / 刚判过非空 / 固定字面量」的不变量,
//! 它们真失败说明进程状态已坏,继续跑只会更糟。
#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::panic))]

pub mod admin_key;
pub mod agent_grant;
pub mod ai_guide;
pub mod api;
pub mod auth;
pub mod avatar;
pub mod collab_ws;
pub mod compress;
pub mod devices;
pub mod editor_ext;
pub mod events;
pub mod export_api;
pub mod hub;
pub mod mcp;
pub mod notify;
pub mod office_ws;
pub mod prefs;
pub mod profile;
pub mod router;
pub mod sessions_api;
pub mod share_public;
pub mod signup;
pub mod skill;
pub mod source;
pub mod ui;
pub mod upload;
pub mod ws;

pub use agent_grant::{AgentGrant, AgentGrants};
pub use api::AppState;
pub use hub::{EventHub, ServerEvent};
pub use router::{bind_tcp, bind_uds, build, serve_tcp_listener, serve_uds_listener};
pub use source::{SocketKind, Source};
pub use upload::{
    CreateUploadRequest, FileLockRequest, FileUnlockRequest, PrecheckItemRequest, PrecheckRequest,
    ReplaceFileRequest, RoundtripCheckRequest, UploadApi,
};
