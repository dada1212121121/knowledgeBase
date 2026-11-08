//! 能力参数结构体(按域分文件)。
//!
//! 参数本身带 `JsonSchema`,schema 由 schemars 生成;`serde(default = "...")` 用的三个
//! 小函数也在这里(`super::` 前缀留给各域文件引用)。

use super::*;

fn default_dry_run() -> bool {
    true
}

fn default_true() -> bool {
    true
}

fn enabled_by_default() -> bool {
    true
}

pub mod acp;
pub mod admin;
pub mod docs;
pub mod files;
pub mod search;
pub mod skills;
pub mod sources;
pub use acp::*;
pub use admin::*;
pub use docs::*;
pub use files::*;
pub use search::*;
pub use skills::*;
pub use sources::*;
