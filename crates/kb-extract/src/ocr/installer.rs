//! OCR 运行时 / 模型的安装状态(换后端时新增)。
//!
//! 设置中心点“下载”时,后台跑 `[extract] ocr_install_command`(例如
//! `rapidocr --install --model-dir models/ocr/ppocrv6`),把输出按行收进来给 UI 看进度。
//! 这里只维护**进程内**状态:同一时刻只允许一个安装任务,失败可以重试。

use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use kb_core::config::ExtractConfig;
use serde::Serialize;

/// 安装状态。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallState {
    /// 没跑过。
    #[default]
    Idle,
    /// 正在跑。
    Running,
    /// 成功。
    Done,
    /// 失败(可以重试)。
    Failed,
}

/// 给 UI 的快照。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct InstallSnapshot {
    /// 状态。
    pub state: InstallState,
    /// 已经跑了多少行输出(进度感)。
    pub lines: usize,
    /// 最近几行输出。
    pub tail: Vec<String>,
    /// 失败原因。
    pub error: Option<String>,
    /// 用的命令。
    pub command: String,
}

struct Inner {
    state: InstallState,
    tail: Vec<String>,
    error: Option<String>,
    command: String,
}

fn slot() -> &'static Mutex<Inner> {
    static SLOT: OnceLock<Mutex<Inner>> = OnceLock::new();
    SLOT.get_or_init(|| {
        Mutex::new(Inner {
            state: InstallState::Idle,
            tail: Vec::new(),
            error: None,
            command: String::new(),
        })
    })
}

/// 当前快照。
pub fn snapshot() -> InstallSnapshot {
    let Ok(inner) = slot().lock() else {
        return InstallSnapshot::default();
    };
    InstallSnapshot {
        state: inner.state,
        lines: inner.tail.len(),
        tail: inner.tail.clone(),
        error: inner.error.clone(),
        command: inner.command.clone(),
    }
}

/// 开始安装(后台线程;同一时刻只跑一个)。
pub fn start_install(config: &ExtractConfig) -> Result<(), String> {
    {
        let mut inner = slot().lock().map_err(|_| "安装状态锁中毒".to_owned())?;
        if inner.state == InstallState::Running {
            return Err("已经有一个安装任务在跑".to_owned());
        }
        inner.state = InstallState::Running;
        inner.tail.clear();
        inner.error = None;
        inner.command = config.ocr_install_command.clone();
    }
    let command = config.ocr_install_command.clone();
    std::thread::spawn(move || {
        let result = run_install(&command);
        if let Ok(mut inner) = slot().lock() {
            match result {
                Ok(()) => inner.state = InstallState::Done,
                Err(err) => {
                    inner.state = InstallState::Failed;
                    inner.error = Some(err);
                }
            }
        }
    });
    Ok(())
}

/// 跑安装命令,把输出逐行收进状态。
fn run_install(command_line: &str) -> Result<(), String> {
    // 允许 `cmd --a --b` 这种带参数的写法(简单按空白切,不支持引号:够用且不引 shell)
    let mut parts = command_line.split_whitespace();
    let Some(program) = parts.next() else {
        return Err("安装命令为空".to_owned());
    };
    let args: Vec<&str> = parts.collect();
    let output = Command::new(program)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("运行 {program} 失败: {err}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if let Ok(mut inner) = slot().lock() {
        for line in text.lines() {
            inner.tail.push(line.to_owned());
        }
        // 只保留最近 200 行
        let excess = inner.tail.len().saturating_sub(200);
        if excess > 0 {
            inner.tail.drain(0..excess);
        }
    }
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "安装命令退出码 {:?}:{}",
            output.status.code(),
            text.lines().last().unwrap_or_default()
        ))
    }
}

/// 重置状态(测试与“重试”按钮用)。
pub fn reset() {
    if let Ok(mut inner) = slot().lock() {
        inner.state = InstallState::Idle;
        inner.tail.clear();
        inner.error = None;
        inner.command.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 安装状态是进程级的,所以三个场景放在同一个测试里顺序跑。
    #[test]
    fn install_states_cover_success_failure_and_retry() {
        // 1) 成功:输出被逐行收进来
        reset();
        let config = ExtractConfig {
            ocr_install_command: "echo installing".to_owned(),
            ..ExtractConfig::default()
        };
        start_install(&config).expect("开始安装");
        let done = wait_until_settled();
        assert_eq!(done.state, InstallState::Done, "{done:?}");
        assert!(
            done.tail.iter().any(|line| line.contains("installing")),
            "{done:?}"
        );

        // 2) 失败:记下原因,状态是 Failed
        reset();
        let config = ExtractConfig {
            ocr_install_command: "definitely-not-a-command --install".to_owned(),
            ..ExtractConfig::default()
        };
        start_install(&config).expect("开始安装");
        let failed = wait_until_settled();
        assert_eq!(failed.state, InstallState::Failed, "{failed:?}");
        assert!(failed.error.is_some(), "{failed:?}");

        // 3) 重试:换一个能跑的命令就恢复
        reset();
        let config = ExtractConfig {
            ocr_install_command: "echo retry".to_owned(),
            ..ExtractConfig::default()
        };
        start_install(&config).expect("重试");
        assert_eq!(wait_until_settled().state, InstallState::Done);
    }

    /// 等后台线程跑完(最多 2 秒)。
    fn wait_until_settled() -> InstallSnapshot {
        for _ in 0..40 {
            let snapshot = snapshot();
            if snapshot.state != InstallState::Running {
                return snapshot;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        snapshot()
    }
}
