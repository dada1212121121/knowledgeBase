//! 领域模型、端口 trait 与纯逻辑(RRF、哈希、标识符拆分、token 估算、脱敏、作用域解析、错误类型、配置结构)。
//!
//! 依赖规则（设计规范）:本 crate **不得**依赖 lancedb / fastembed / axum / rusqlite,
//! 也不依赖任何其它 `kb-*` crate;单元测试必须能在几秒内跑完。

pub mod account;
pub mod backends;
pub mod config;
pub mod error;
pub mod features;
pub mod filter;
pub mod hash;
pub mod ids;
pub mod model;
pub mod paths;
pub mod pct;
pub mod ports;
pub mod query;
pub mod redact;
pub mod render;
pub mod rrf;
pub mod share;
pub mod social;
pub mod text;
pub mod timezone;
pub mod token;
pub mod totp;

pub use config::Config;
pub use error::{KbError, Result};
pub use filter::Filter;
pub use paths::KbPaths;

/// 公开 Agent Skill 的正文(唯一真源)。
///
/// HTTP 的 `/skill.md`、`/api/v1/skill` 与 CLI 的 `kb skill` 都读这一份,保证三处逐字节一致;
/// 它不能带任何密钥、用户数据或内部主机名,因为对外是免登录可取的。
pub const SKILL_MD: &str = include_str!("../assets/SKILL.md");
