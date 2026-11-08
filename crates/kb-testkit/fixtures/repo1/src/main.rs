//! 示例 Rust 模块。

use std::collections::HashMap;

/// 一个结构体。
pub struct Config {
    pub name: String,
}

impl Config {
    /// 构造。
    pub fn new(name: &str) -> Self {
        Self { name: name.to_owned() }
    }
}

/// 入口函数。
pub fn run(config: &Config) -> usize {
    let mut map: HashMap<String, usize> = HashMap::new();
    map.insert(config.name.clone(), 1);
    map.len()
}
