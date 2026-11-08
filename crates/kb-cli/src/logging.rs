//! 日志初始化:同时输出到 stderr 和按天滚动的文件。
//!
//! 文件路径为 `<KB_HOME>/logs/kb.log.YYYY-MM-DD`（设计规范）。
//! **stdout 一律留给业务输出**:`kb mcp` 的 stdout 只能是 MCP 协议数据(设计规范坑 6)。
//!
//! 起另挂一层 [`WebLogLayer`]:`warn` 及以上的日志同时推给 `/api/v1/ws` 的
//! `log` 事件,让 Web 端能看到守护进程出的问题。事件中心由守护进程启动时
//! [`attach_event_hub`] 注入,注入之前这一层什么也不做。

use std::sync::{Arc, OnceLock};

use kb_core::paths::KbPaths;
use kb_core::{KbError, Result};
use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt;
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::registry::Registry;
use tracing_subscriber::reload;
use tracing_subscriber::util::SubscriberInitExt;

/// 进程内的事件中心(守护进程启动时注入;其它命令保持为空)。
static EVENT_HUB: OnceLock<Arc<kb_web::EventHub>> = OnceLock::new();

/// 把日志桥接到 `/api/v1/ws`;重复调用返回第一次注入的那个。
pub fn attach_event_hub(hub: Arc<kb_web::EventHub>) -> Arc<kb_web::EventHub> {
    EVENT_HUB.get_or_init(|| hub).clone()
}

/// 日志过滤器的热更新句柄。
static LEVEL_RELOAD: OnceLock<reload::Handle<EnvFilter, Registry>> = OnceLock::new();

/// 构造与环境变量一致的过滤器。
///
/// 第三方库(LanceDB / DataFusion 等)的 INFO 日志对 CLI 用户是噪声,默认压到 warn;
/// `kb` 自己的 target 保持配置的级别。设置了 `RUST_LOG` 时以它为准。
fn build_filter(level: &str) -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new(format!(
            "{level},lance=warn,lancedb=warn,lance_core=warn,lance_index=warn,\
             lance_table=warn,datafusion=warn,object_store=warn,fastembed=warn"
        ))
    })
}

/// 热更新日志级别。未初始化日志时静默成功(测试 / 库用法)。
pub fn set_level(level: &str) -> Result<()> {
    let level = if level.trim().is_empty() {
        "info"
    } else {
        level
    };
    let Some(handle) = LEVEL_RELOAD.get() else {
        return Ok(());
    };
    // 设置了 RUST_LOG 时以环境变量为准:热更新不覆盖它
    if std::env::var("RUST_LOG").is_ok() {
        return Ok(());
    }
    handle
        .reload(build_filter(level))
        .map_err(|err| KbError::Internal(format!("热更新日志级别失败: {err}")))
}

/// 持有非阻塞写线程的 guard,进程退出前不能丢弃。
pub struct Logging {
    _guard: Option<WorkerGuard>,
}

/// 把 `warn` / `error` 日志推给 Web 端的事件层。
struct WebLogLayer;

impl<S: Subscriber> Layer<S> for WebLogLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        // Level 的顺序是 TRACE < DEBUG < INFO < WARN < ERROR
        if *metadata.level() > Level::WARN {
            return;
        }
        let Some(hub) = EVENT_HUB.get() else {
            return;
        };
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let mut data = Map::new();
        data.insert(
            "level".to_owned(),
            Value::String(metadata.level().as_str().to_ascii_lowercase()),
        );
        data.insert(
            "target".to_owned(),
            Value::String(metadata.target().to_owned()),
        );
        data.insert(
            "message".to_owned(),
            Value::String(visitor.message.unwrap_or_default()),
        );
        if !visitor.fields.is_empty() {
            data.insert("fields".to_owned(), Value::Object(visitor.fields));
        }
        hub.publish("log", Value::Object(data));
    }
}

/// 收集事件的 `message` 与其余字段。
#[derive(Default)]
struct FieldVisitor {
    message: Option<String>,
    fields: Map<String, Value>,
}

impl Visit for FieldVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_owned());
        } else {
            self.fields
                .insert(field.name().to_owned(), Value::String(value.to_owned()));
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let text = format!("{value:?}");
        if field.name() == "message" {
            self.message = Some(text);
        } else {
            self.fields
                .insert(field.name().to_owned(), Value::String(text));
        }
    }
}

/// 初始化全局 tracing 订阅者。
///
/// 级别取自 `[log] level`;设置了 `RUST_LOG` 时以 `RUST_LOG` 为准(便于临时排查)。
/// `file = false` 时只输出到 stderr(纯打印类命令用,避免创建数据目录)。
pub fn init_with(paths: &KbPaths, level: &str, file: bool) -> Result<Logging> {
    let mut guard = None;
    let mut file_layer = None;
    if file {
        std::fs::create_dir_all(paths.logs_dir()).map_err(|err| {
            KbError::Internal(format!(
                "创建日志目录 {} 失败: {err}",
                paths.logs_dir().display()
            ))
        })?;
        let file_appender = tracing_appender::rolling::daily(paths.logs_dir(), "kb.log");
        let (file_writer, worker_guard) = tracing_appender::non_blocking(file_appender);
        guard = Some(worker_guard);
        file_layer = Some(
            fmt::layer()
                .with_writer(file_writer)
                .with_ansi(false)
                .with_target(true),
        );
    }

    let level = if level.trim().is_empty() {
        "info"
    } else {
        level
    };
    // :过滤器挂在 reload 层上,`[log] level` 改了可以就地替换
    let (filter, handle) = reload::Layer::new(build_filter(level));

    let stderr_layer = fmt::layer()
        .with_writer(std::io::stderr)
        .with_ansi(true)
        .with_target(false);

    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(stderr_layer)
        // warn 及以上同时推给 Web 端(`/api/v1/ws` 的 `log` 事件)
        .with(WebLogLayer)
        .try_init()
        .map_err(|err| KbError::Internal(format!("初始化日志失败: {err}")))?;
    // 只记第一次成功的句柄(测试里可能重复初始化)
    let _ = LEVEL_RELOAD.set(handle);

    Ok(Logging { _guard: guard })
}
