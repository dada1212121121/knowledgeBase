//! 示例 Rust 模块,用于分块测试。

use std::collections::HashMap;
use std::fmt;

/// 服务配置。
pub struct Config {
    /// 服务名。
    pub name: String,
    /// 监听端口。
    pub port: u16,
    /// 重试次数。
    pub retries: u32,
}

impl Config {
    /// 构造配置。
    pub fn new(name: &str, port: u16) -> Self {
        Self {
            name: name.to_owned(),
            port,
            retries: 3,
        }
    }

    /// 默认配置。
    pub fn default_for(name: &str) -> Self {
        Self::new(name, 7878)
    }

    /// 描述。
    pub fn describe(&self) -> String {
        format!("{}:{}", self.name, self.port)
    }
}

impl fmt::Display for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.describe())
    }
}

/// 服务状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// 未启动。
    Idle,
    /// 运行中。
    Running,
    /// 已停止。
    Stopped,
}

/// 可以启动的东西。
pub trait Startable {
    /// 启动。
    fn start(&mut self) -> Status;

    /// 停止。
    fn stop(&mut self) -> Status;

    /// 是否运行中。
    fn is_running(&self) -> bool {
        false
    }
}

/// 一个简单的服务。
pub struct Service {
    config: Config,
    status: Status,
    counters: HashMap<String, u64>,
}

impl Service {
    /// 新建服务。
    pub fn new(config: Config) -> Self {
        Self {
            config,
            status: Status::Idle,
            counters: HashMap::new(),
        }
    }

    /// 记录一次调用。
    pub fn record(&mut self, key: &str) {
        *self.counters.entry(key.to_owned()).or_insert(0) += 1;
    }

    /// 取计数。
    pub fn count(&self, key: &str) -> u64 {
        self.counters.get(key).copied().unwrap_or(0)
    }
}

impl Startable for Service {
    fn start(&mut self) -> Status {
        self.status = Status::Running;
        self.status
    }

    fn stop(&mut self) -> Status {
        self.status = Status::Stopped;
        self.status
    }

    fn is_running(&self) -> bool {
        self.status == Status::Running
    }
}

/// 计算斐波那契数列。
pub fn fibonacci(n: u32) -> u64 {
    let mut a = 0u64;
    let mut b = 1u64;
    for _ in 0..n {
        let next = a + b;
        a = b;
        b = next;
    }
    a
}

/// 解析端口。
pub fn parse_port(value: &str) -> Option<u16> {
    value.trim().parse().ok()
}

/// 声明一个简单的宏。
#[macro_export]
macro_rules! assert_ok {
    ($expr:expr) => {
        assert!($expr.is_ok(), "expected ok: {:?}", $expr);
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_describe() {
        let config = Config::new("demo", 8080);
        assert_eq!(config.describe(), "demo:8080");
    }

    #[test]
    fn service_lifecycle() {
        let mut service = Service::new(Config::default_for("svc"));
        assert!(!service.is_running());
        service.start();
        assert!(service.is_running());
        service.record("hit");
        assert_eq!(service.count("hit"), 1);
        service.stop();
        assert!(!service.is_running());
    }

    #[test]
    fn fibonacci_works() {
        assert_eq!(fibonacci(10), 55);
        assert_eq!(parse_port(" 7878 "), Some(7878));
    }
}
