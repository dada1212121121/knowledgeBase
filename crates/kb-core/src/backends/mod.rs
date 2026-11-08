//! 后端注册表:`<KB_HOME>/backends/<id>/manifest.toml` 的声明 + 编译进来的内置条目。
//!
//! 与 `<KB_HOME>/skills/` 那套插件分工不同:skills 贡献的是**能力**(loader rule、工具、命令),
//! backends 声明的是**可替换的实现**(哪个 OCR、哪个嵌入服务)。两者都不做进程内 `dlopen`:
//! 后端要么是程序自带实现,要么是一个外部命令 / HTTP 端点,换掉它只改声明,不改 ABI。
//!
//! 本模块只负责「读声明 + 合并 + 报问题」;构造、探活与降级归各自实现(`kb doctor backends`
//! 与 `ProviderCatalog` 消费它)。

mod manifest;
mod registry;

pub use manifest::{
    API_VERSION, BackendEntry, BackendKind, BackendManifest, BackendSource, is_valid_id,
    parse_manifest,
};
pub use registry::BackendRegistry;

#[cfg(test)]
mod tests;
