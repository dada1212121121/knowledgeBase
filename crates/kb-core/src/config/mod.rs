//! 配置结构（设计规范）。
//!
//! 所有字段都有默认值:文件里缺省的段落或键取默认值,所以 `config.toml` 可以只写要改的项。
//! 路径类配置为空时一律从 `KB_HOME` 派生,见 [`crate::paths`]。

use crate::error::{KbError, Result};
use change::collect_changed_keys;
use serde::{Deserialize, Serialize};
use std::path::Path;

mod accounts;
mod change;
mod extract;
mod index;
mod llm;
mod mail;
mod search;
mod server;

#[cfg(test)]
mod tests;
pub use accounts::*;
pub use change::*;
pub use extract::*;
pub use index::*;
pub use llm::*;
pub use mail::*;
pub use search::*;
pub use server::*;

/// 全局配置,对应 `<KB_HOME>/config.toml`。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// 监听与 socket。
    pub server: ServerConfig,
    /// 路径覆盖(为空则从 `KB_HOME` 派生)。
    pub paths: PathsConfig,
    /// 网络相关。
    pub network: NetworkConfig,
    /// 嵌入后端。
    pub embed: EmbedConfig,
    /// 重排。
    pub rerank: RerankConfig,
    /// 核显 sidecar。
    pub accel: AccelConfig,
    /// 索引。
    pub index: IndexConfig,
    /// 检索。
    pub search: SearchConfig,
    /// MCP 传输模式。
    pub mcp: McpConfig,
    /// 云端 LLM(AI)。
    pub llm: LlmConfig,
    /// 自动进化。
    pub evolution: EvolutionConfig,
    /// 调度。
    pub schedule: ScheduleConfig,
    /// 备份(定时备份 + 保留策略)。
    pub backup: BackupConfig,
    /// 数据保留(历史表清理).
    pub retention: RetentionConfig,
    /// 元数据库。
    pub meta: MetaConfig,
    /// 上传。
    pub upload: UploadConfig,
    /// 多格式抽取:OCR 与音视频转写。
    pub extract: ExtractConfig,
    /// 旧格式 Office 文件入库时转成 OOXML(LibreOffice 无界面),默认关。
    pub convert: ConvertConfig,
    /// 办公文档在线编辑(浏览器里的编辑器保存回原文件)。
    pub office: OfficeConfig,
    /// 编辑器扩展:从本地可信目录加载第三方扩展,默认关。
    pub editor: EditorConfig,
    /// 声明式 skills。
    pub skills: SkillsConfig,
    /// 日志。
    pub log: LogConfig,
    /// AI 总开关与子功能开关(关了就从界面和后台一起消失)。
    pub ai: AiConfig,
    /// 注册与账号。
    pub accounts: AccountsConfig,
    /// 管理员只读查看他人知识库。
    pub admin: AdminConfig,
    /// 默认配额与限制(角色、单个用户可覆盖)。
    pub quota: QuotaConfig,
    /// 分享与游客。
    pub share: ShareConfig,
    /// 站点名称与对外地址。
    pub site: SiteConfig,
    /// 发信邮箱(SMTP):注册验证码、找回密码、通知。
    pub mail: MailConfig,
    /// 网页来源的 AI 规范化。
    pub web_extract: WebExtractConfig,
}

impl Config {
    /// 读取并校验配置文件。
    ///
    /// 文件不存在时返回默认配置(首次启动即用默认值);解析或校验失败返回
    /// [`KbError::InvalidInput`]。
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(err) => {
                return Err(KbError::Internal(format!(
                    "读取配置 {} 失败: {err}",
                    path.display()
                )));
            }
        };
        let config: Self = toml::from_str(&text).map_err(|err| {
            KbError::InvalidInput(format!("解析配置 {} 失败: {err}", path.display()))
        })?;
        config.validate()?;
        Ok(config)
    }

    /// 校验配置。
    ///
    /// 本阶段只校验:监听地址必须能解析成 `SocketAddr`;非回环地址必须同时设置
    /// `server.allow_remote = true`;`embed.batch_size` 在 1..=64。
    /// “已设置密码”的条件在守护进程启动时校验。
    pub fn validate(&self) -> Result<()> {
        let addr = parse_listen(&self.server.listen)?;
        if !addr.ip().is_loopback() && !self.server.allow_remote {
            return Err(KbError::InvalidInput(format!(
                "server.listen = {} 不是回环地址,需要同时设置 server.allow_remote = true",
                self.server.listen
            )));
        }
        for (collection, weight) in &self.search.collection_weights {
            if !(0.2..=2.0).contains(weight) {
                return Err(KbError::InvalidInput(format!(
                    "search.collection_weights.{collection} 必须在 0.2..=2.0 之间,当前为 {weight}"
                )));
            }
        }
        for transport in &self.mcp.transports {
            if !matches!(transport.as_str(), "stdio" | "http") {
                return Err(KbError::InvalidInput(format!(
                    "mcp.transports 只能取 stdio / http,收到 {transport}"
                )));
            }
        }
        if !(1..=64).contains(&self.embed.batch_size) {
            return Err(KbError::InvalidInput(format!(
                "embed.batch_size 必须在 1..=64 之间,当前为 {}",
                self.embed.batch_size
            )));
        }
        if !WebExtractConfig::INPUT_CHARS_RANGE.contains(&self.web_extract.max_input_chars) {
            return Err(KbError::InvalidInput(format!(
                "web_extract.max_input_chars 必须在 {}..={} 之间,当前为 {}",
                WebExtractConfig::INPUT_CHARS_RANGE.start(),
                WebExtractConfig::INPUT_CHARS_RANGE.end(),
                self.web_extract.max_input_chars
            )));
        }
        if !(1..=WebExtractConfig::MAX_PARTS).contains(&self.web_extract.max_parts) {
            return Err(KbError::InvalidInput(format!(
                "web_extract.max_parts 必须在 1..={} 之间,当前为 {}",
                WebExtractConfig::MAX_PARTS,
                self.web_extract.max_parts
            )));
        }
        if !(1..=WebExtractConfig::MAX_PAGES_PER_SYNC)
            .contains(&self.web_extract.max_pages_per_sync)
        {
            return Err(KbError::InvalidInput(format!(
                "web_extract.max_pages_per_sync 必须在 1..={} 之间,当前为 {}",
                WebExtractConfig::MAX_PAGES_PER_SYNC,
                self.web_extract.max_pages_per_sync
            )));
        }
        if !(1..=MetaConfig::MAX_READ_POOL).contains(&self.meta.read_pool) {
            return Err(KbError::InvalidInput(format!(
                "meta.read_pool 必须在 1..={} 之间,当前为 {}",
                MetaConfig::MAX_READ_POOL,
                self.meta.read_pool
            )));
        }
        if !matches!(self.extract.ocr_backend.as_str(), "rapidocr" | "tesseract") {
            return Err(KbError::InvalidInput(format!(
                "extract.ocr_backend 只能是 rapidocr 或 tesseract,收到 {}",
                self.extract.ocr_backend
            )));
        }
        if !matches!(self.extract.ocr_model_size.as_str(), "small" | "medium") {
            return Err(KbError::InvalidInput(format!(
                "extract.ocr_model_size 只能是 small 或 medium,收到 {}",
                self.extract.ocr_model_size
            )));
        }
        if self.extract.ocr_command.trim().is_empty() {
            return Err(KbError::InvalidInput(
                "extract.ocr_command 不能为空(默认 tesseract)".to_owned(),
            ));
        }
        if self.extract.transcribe_command.trim().is_empty() {
            return Err(KbError::InvalidInput(
                "extract.transcribe_command 不能为空(默认 whisper-cli)".to_owned(),
            ));
        }
        if !(10..=86_400).contains(&self.extract.max_media_seconds) {
            return Err(KbError::InvalidInput(format!(
                "extract.max_media_seconds 必须在 10..=86400 之间,当前为 {}",
                self.extract.max_media_seconds
            )));
        }
        // B4:OCR 资源参数。`slots = 0` 是“按核数自动”,不算越界;
        // budget / max_pages 没有 0 的语义,填 0 直接拒(不是“不限”)。
        if !(0..=OcrConfig::MAX_SLOTS).contains(&self.extract.ocr.slots) {
            return Err(KbError::InvalidInput(format!(
                "extract.ocr.slots 必须在 0..={} 之间(0 = 按核数自动),当前为 {}",
                OcrConfig::MAX_SLOTS,
                self.extract.ocr.slots
            )));
        }
        if !OcrConfig::BUDGET_RANGE.contains(&self.extract.ocr.budget_secs) {
            return Err(KbError::InvalidInput(format!(
                "extract.ocr.budget_secs 必须在 {}..={} 之间,当前为 {}",
                OcrConfig::BUDGET_RANGE.start(),
                OcrConfig::BUDGET_RANGE.end(),
                self.extract.ocr.budget_secs
            )));
        }
        if !(1..=OcrConfig::MAX_PAGES).contains(&self.extract.ocr.max_pages) {
            return Err(KbError::InvalidInput(format!(
                "extract.ocr.max_pages 必须在 1..={} 之间,当前为 {}",
                OcrConfig::MAX_PAGES,
                self.extract.ocr.max_pages
            )));
        }
        if !(1..=UploadConfig::MAX_CHUNK_MB).contains(&self.upload.chunk_mb) {
            return Err(KbError::InvalidInput(format!(
                "upload.chunk_mb 必须在 1..={} 之间,当前为 {}",
                UploadConfig::MAX_CHUNK_MB,
                self.upload.chunk_mb
            )));
        }
        if self.office.keep_versions > OfficeConfig::MAX_KEEP_VERSIONS {
            return Err(KbError::InvalidInput(format!(
                "office.keep_versions 必须在 0..={} 之间,当前为 {}",
                OfficeConfig::MAX_KEEP_VERSIONS,
                self.office.keep_versions
            )));
        }
        if !(1..=ConvertConfig::MAX_TIMEOUT_SECS).contains(&self.convert.timeout_secs) {
            return Err(KbError::InvalidInput(format!(
                "convert.timeout_secs 必须在 1..={} 之间,当前为 {}",
                ConvertConfig::MAX_TIMEOUT_SECS,
                self.convert.timeout_secs
            )));
        }
        if !(1..=ConvertConfig::MAX_CONCURRENT).contains(&self.convert.max_concurrent) {
            return Err(KbError::InvalidInput(format!(
                "convert.max_concurrent 必须在 1..={} 之间,当前为 {}",
                ConvertConfig::MAX_CONCURRENT,
                self.convert.max_concurrent
            )));
        }
        if !(1..=IndexConfig::MAX_PARALLEL_FILES).contains(&self.index.parallel_files) {
            return Err(KbError::InvalidInput(format!(
                "index.parallel_files 必须在 1..={} 之间,当前为 {}",
                IndexConfig::MAX_PARALLEL_FILES,
                self.index.parallel_files
            )));
        }
        // 分片并发上限 = 每个知识库后台的循环数,再大也只是排队等名额
        if self.index.parallel_slices > IndexConfig::MAX_PARALLEL_SLICES {
            return Err(KbError::InvalidInput(format!(
                "index.parallel_slices 必须在 0..={} 之间(0 = 自动),当前为 {}",
                IndexConfig::MAX_PARALLEL_SLICES,
                self.index.parallel_slices
            )));
        }
        // 扩展目录:空串会解析成 KB_HOME 本身(把整个数据目录当成扩展目录),`..` 能逃出相对基准
        if let Some(dir) = &self.editor.extensions_dir {
            let trimmed = dir.trim();
            if trimmed.is_empty() {
                return Err(KbError::InvalidInput(
                    "editor.extensions_dir 不能是空串(不写这个键就用默认目录)".to_owned(),
                ));
            }
            if trimmed.split('/').any(|segment| segment == "..") {
                return Err(KbError::InvalidInput(format!(
                    "editor.extensions_dir 不能用 `..` 段,请写绝对路径:{dir}"
                )));
            }
        }
        // 时区是 IANA 名称,不能只填 `+08:00`:夏令时地区一年里偏移会变
        crate::timezone::parse(&self.site.timezone)?;
        if self.upload.max_file_mb == 0 {
            return Err(KbError::InvalidInput(
                "upload.max_file_mb 必须大于 0".to_owned(),
            ));
        }
        if !(1..=UploadConfig::MAX_UNPACK_DEPTH).contains(&self.upload.unpack_max_depth) {
            return Err(KbError::InvalidInput(format!(
                "upload.unpack_max_depth 必须在 1..={} 之间,当前为 {}",
                UploadConfig::MAX_UNPACK_DEPTH,
                self.upload.unpack_max_depth
            )));
        }
        if self.upload.unpack_max_ratio < 2 {
            return Err(KbError::InvalidInput(
                "upload.unpack_max_ratio 至少为 2(解压总量 ≤ 压缩包的 N 倍)".to_owned(),
            ));
        }
        // :会话记录允许的目录(相对路径与空串没有意义,`~` 在读取时展开)
        for root in &self.evolution.session_roots {
            if root.trim().is_empty() {
                return Err(KbError::InvalidInput(
                    "evolution.session_roots 里不能有空目录".to_owned(),
                ));
            }
            let home_relative = root == "~" || root.starts_with("~/");
            if !home_relative && !std::path::Path::new(root).is_absolute() {
                return Err(KbError::InvalidInput(format!(
                    "evolution.session_roots 必须是绝对路径或 ~ / ~/ 开头,当前为 {root}"
                )));
            }
        }
        // :主题归纳的参数(聚类阈值 / 主题条数 / 一次最多几个主题)
        if !(0.0..=1.0).contains(&self.evolution.consolidate_similarity) {
            return Err(KbError::InvalidInput(format!(
                "evolution.consolidate_similarity 必须在 0..=1 之间,当前为 {}",
                self.evolution.consolidate_similarity
            )));
        }
        if self.evolution.consolidate_min_members < 2 {
            return Err(KbError::InvalidInput(format!(
                "evolution.consolidate_min_members 至少为 2(单条不成主题),当前为 {}",
                self.evolution.consolidate_min_members
            )));
        }
        if !(1..=50).contains(&self.evolution.consolidate_max_clusters) {
            return Err(KbError::InvalidInput(format!(
                "evolution.consolidate_max_clusters 必须在 1..=50 之间,当前为 {}",
                self.evolution.consolidate_max_clusters
            )));
        }
        // 备份:间隔与保留策略的取值范围(0 在保留策略里表示“不按这一维清理”)
        if !(BackupConfig::MIN_INTERVAL_HOURS..=BackupConfig::MAX_INTERVAL_HOURS)
            .contains(&self.backup.interval_hours)
        {
            return Err(KbError::InvalidInput(format!(
                "backup.interval_hours 必须在 {}..={} 之间,当前为 {}",
                BackupConfig::MIN_INTERVAL_HOURS,
                BackupConfig::MAX_INTERVAL_HOURS,
                self.backup.interval_hours
            )));
        }
        if self.backup.keep_count > BackupConfig::MAX_KEEP_COUNT {
            return Err(KbError::InvalidInput(format!(
                "backup.keep_count 不能超过 {},当前为 {}",
                BackupConfig::MAX_KEEP_COUNT,
                self.backup.keep_count
            )));
        }
        if self.backup.keep_days > BackupConfig::MAX_KEEP_DAYS {
            return Err(KbError::InvalidInput(format!(
                "backup.keep_days 不能超过 {},当前为 {}",
                BackupConfig::MAX_KEEP_DAYS,
                self.backup.keep_days
            )));
        }
        // 异地目录:不能是空串(那会解析成 KB_HOME 本身),也不能用 `..` 逃出相对基准
        if self.backup.mirror_dirs.len() > BackupConfig::MAX_MIRROR_DIRS {
            return Err(KbError::InvalidInput(format!(
                "backup.mirror_dirs 最多 {} 个,当前为 {}",
                BackupConfig::MAX_MIRROR_DIRS,
                self.backup.mirror_dirs.len()
            )));
        }
        for dir in &self.backup.mirror_dirs {
            let trimmed = dir.trim();
            if trimmed.is_empty() {
                return Err(KbError::InvalidInput(
                    "backup.mirror_dirs 里不能有空目录(留空数组表示不复制到异地)".to_owned(),
                ));
            }
            if trimmed.split('/').any(|segment| segment == "..") {
                return Err(KbError::InvalidInput(format!(
                    "backup.mirror_dirs 不能用 `..` 段,请写绝对路径:{dir}"
                )));
            }
        }
        Ok(())
    }
}

/// 把 `server.listen` 解析成 [`std::net::SocketAddr`]。
pub fn parse_listen(listen: &str) -> Result<std::net::SocketAddr> {
    listen.parse().map_err(|_| {
        KbError::InvalidInput(format!(
            "server.listen 不是合法的 \"IP:端口\" 形式: {listen}"
        ))
    })
}

impl Config {
    /// 与另一份配置的差异。
    pub fn diff(&self, next: &Config) -> ConfigDiff {
        if self == next {
            return ConfigDiff::default();
        }
        let left = match serde_json::to_value(self) {
            Ok(value) => value,
            Err(_) => {
                // 序列化不了(不该发生):退化成“整份配置都变了”,宁可让调用方多重启一次
                return ConfigDiff {
                    changes: vec![ConfigChange {
                        key: "config".to_owned(),
                        scope: ChangeScope::Restart,
                    }],
                };
            }
        };
        let right = match serde_json::to_value(next) {
            Ok(value) => value,
            Err(_) => {
                return ConfigDiff {
                    changes: vec![ConfigChange {
                        key: "config".to_owned(),
                        scope: ChangeScope::Restart,
                    }],
                };
            }
        };
        let mut keys = Vec::new();
        collect_changed_keys("", &left, &right, &mut keys);
        keys.sort();
        keys.dedup();
        ConfigDiff {
            changes: keys
                .into_iter()
                .map(|key| ConfigChange {
                    scope: classify_change(&key),
                    key,
                })
                .collect(),
        }
    }
}
