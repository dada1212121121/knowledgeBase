//! 核显 sidecar 管理。
//!
//! 守护进程按 `[accel]` 配置拉起两个 `llama-server` 子进程(嵌入 + 重排),
//! 健康检查 `/health`;崩溃后指数退避重启;守护进程退出时一并终止。

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use kb_core::{KbError, Result};

/// sidecar 的角色。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SidecarRole {
    /// 嵌入(`--embedding`)。
    Embedding,
    /// 重排(`--reranking`)。
    Rerank,
}

impl SidecarRole {
    /// 默认端口（设计规范）。
    pub fn default_port(self) -> u16 {
        match self {
            Self::Embedding => 18081,
            Self::Rerank => 18082,
        }
    }

    /// 配置里写的那一路的名字。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Embedding => "embed",
            Self::Rerank => "rerank",
        }
    }

    fn flag(self) -> &'static str {
        match self {
            Self::Embedding => "--embedding",
            Self::Rerank => "--reranking",
        }
    }
}

/// 一个 sidecar 的配置。
#[derive(Clone, Debug)]
pub struct SidecarSpec {
    /// 角色。
    pub role: SidecarRole,
    /// `llama-server` 可执行文件。
    pub binary: PathBuf,
    /// GGUF 模型路径。
    pub model: PathBuf,
    /// 监听端口。
    pub port: u16,
    /// 卸载到 GPU 的层数(`-ngl`);默认 99 = 全放显卡,`0` = 纯 CPU。
    pub ngl: i32,
}

impl SidecarSpec {
    /// 组装命令行(设计规范的参数)。
    pub fn args(&self) -> Vec<String> {
        let mut args = vec![
            "-m".to_owned(),
            self.model.to_string_lossy().into_owned(),
            self.role.flag().to_owned(),
            "--pooling".to_owned(),
            "cls".to_owned(),
            "-ngl".to_owned(),
            self.ngl.to_string(),
            "-c".to_owned(),
            "16384".to_owned(),
            "-b".to_owned(),
            "8192".to_owned(),
            "-ub".to_owned(),
            "8192".to_owned(),
            "--host".to_owned(),
            "127.0.0.1".to_owned(),
            "--port".to_owned(),
            self.port.to_string(),
        ];
        if self.role == SidecarRole::Rerank {
            // 重排不需要 pooling 参数
            args.retain(|arg| arg != "--pooling" && arg != "cls");
        }
        args
    }

    /// `http://127.0.0.1:<port>`。
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

/// 一个运行中的 sidecar。
pub struct Sidecar {
    spec: SidecarSpec,
    child: Option<Child>,
    /// 已经重启过几次(用于指数退避)。
    restarts: u32,
    last_start: Option<std::time::Instant>,
}

impl Sidecar {
    /// 构造(不启动)。
    pub fn new(spec: SidecarSpec) -> Self {
        Self {
            spec,
            child: None,
            restarts: 0,
            last_start: None,
        }
    }

    /// 配置。
    pub fn spec(&self) -> &SidecarSpec {
        &self.spec
    }

    /// 启动子进程。
    pub fn start(&mut self) -> Result<()> {
        if self.child.is_some() {
            return Ok(());
        }
        if !self.spec.binary.exists() {
            return Err(KbError::Unavailable(format!(
                "sidecar 可执行文件不存在:{}(先运行 `kb accel install`)",
                self.spec.binary.display()
            )));
        }
        if !self.spec.model.exists() {
            return Err(KbError::Unavailable(format!(
                "GGUF 模型不存在:{}",
                self.spec.model.display()
            )));
        }
        let child = Command::new(&self.spec.binary)
            .args(self.spec.args())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| KbError::Unavailable(format!("启动 sidecar 失败: {err}")))?;
        self.child = Some(child);
        self.last_start = Some(std::time::Instant::now());
        Ok(())
    }

    /// 进程是否还活着。
    pub fn alive(&mut self) -> bool {
        let Some(child) = self.child.as_mut() else {
            return false;
        };
        matches!(child.try_wait(), Ok(None))
    }

    /// 进程退出后按指数退避重启;返回是否真的重启了。
    pub fn restart_if_dead(&mut self) -> Result<bool> {
        if self.alive() {
            return Ok(false);
        }
        self.child = None;
        // 退避:1s、2s、4s、8s,最多 30s
        let delay = Duration::from_secs((1u64 << self.restarts.min(5)).min(30));
        if let Some(started) = self.last_start
            && started.elapsed() < delay
        {
            std::thread::sleep(delay - started.elapsed());
        }
        self.restarts = self.restarts.saturating_add(1);
        self.start()?;
        Ok(true)
    }

    /// 终止子进程。
    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 同时管理嵌入与重排两个 sidecar。
pub struct SidecarPair {
    /// 嵌入。
    pub embedding: Option<Sidecar>,
    /// 重排。
    pub rerank: Option<Sidecar>,
}

impl SidecarPair {
    /// 按需启动:哪一路缺可执行文件 / 缺模型就跳过哪一路,另一路照起。
    ///
    /// 以前是任意一路失败就整组 `Err`:只想开重排(不放嵌入 GGUF,嵌入走进程内 fastembed)时,
    /// 一个都起不来,而文件头写的「按需启动」根本兑现不了。现在缺哪一路说哪一路。
    pub fn start(specs: Vec<SidecarSpec>) -> Result<Self> {
        let mut embedding = None;
        let mut rerank = None;
        for spec in specs {
            let role = spec.role;
            let mut sidecar = Sidecar::new(spec);
            if let Err(err) = sidecar.start() {
                // 缺文件不算错误:配了但没有模型是「没装」,不是「坏了」
                tracing::warn!(error = %err, role = role.as_str(), "跳过这一路 sidecar,其余照常");
                continue;
            }
            match role {
                SidecarRole::Embedding => embedding = Some(sidecar),
                SidecarRole::Rerank => rerank = Some(sidecar),
            }
        }
        Ok(Self { embedding, rerank })
    }

    /// 有没有任一路真的起来了(全都被跳过时守护进程不必报告「已启动」)。
    pub fn any_started(&self) -> bool {
        self.embedding.is_some() || self.rerank.is_some()
    }

    /// 检查并重启退出的 sidecar。
    pub fn supervise(&mut self) {
        for sidecar in [self.embedding.as_mut(), self.rerank.as_mut()]
            .into_iter()
            .flatten()
        {
            if let Err(err) = sidecar.restart_if_dead() {
                tracing::warn!(error = %err, "sidecar 重启失败");
            }
        }
    }

    /// 全部停止。
    pub fn stop(&mut self) {
        if let Some(sidecar) = self.embedding.as_mut() {
            sidecar.stop();
        }
        if let Some(sidecar) = self.rerank.as_mut() {
            sidecar.stop();
        }
    }
}

impl Drop for SidecarPair {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedding_args_match_the_documented_command() {
        let spec = SidecarSpec {
            role: SidecarRole::Embedding,
            binary: PathBuf::from("/bin/true"),
            model: PathBuf::from("/tmp/e.gguf"),
            port: 18081,
            ngl: 99,
        };
        let args = spec.args();
        assert_eq!(args[0], "-m");
        assert!(args.contains(&"--embedding".to_owned()));
        assert!(args.contains(&"--pooling".to_owned()));
        assert!(args.contains(&"16384".to_owned()));
        assert_eq!(args.last().unwrap(), "18081");
        assert_eq!(spec.base_url(), "http://127.0.0.1:18081");
    }

    #[test]
    fn rerank_args_drop_the_pooling_flag() {
        let spec = SidecarSpec {
            role: SidecarRole::Rerank,
            binary: PathBuf::from("/bin/true"),
            model: PathBuf::from("/tmp/r.gguf"),
            port: 18082,
            ngl: 99,
        };
        let args = spec.args();
        assert!(args.contains(&"--reranking".to_owned()));
        assert!(!args.contains(&"--pooling".to_owned()));
    }

    /// 只开重排:嵌入那一路缺模型时跳过它,重排照起(以前整组 `Err`,一个都起不来)。
    #[test]
    fn a_missing_model_only_skips_that_role() {
        let dir = std::env::temp_dir().join(format!("kb-sidecar-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("临时目录");
        let present = dir.join("present.gguf");
        std::fs::write(&present, b"gguf").expect("写模型占位");
        let pair = SidecarPair::start(vec![
            SidecarSpec {
                role: SidecarRole::Embedding,
                binary: PathBuf::from("/bin/true"),
                model: dir.join("missing.gguf"),
                port: 18081,
                ngl: 99,
            },
            SidecarSpec {
                role: SidecarRole::Rerank,
                binary: PathBuf::from("/bin/true"),
                model: present.clone(),
                port: 18082,
                ngl: 0,
            },
        ])
        .expect("缺一路不算失败");
        assert!(pair.embedding.is_none(), "缺模型的那一路要跳过");
        assert!(pair.rerank.is_some(), "另一路照常启动");
        assert!(pair.any_started());
        drop(pair);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `-ngl` 跟着配置走:核显没有加速比时填 0 就是纯 CPU。
    #[test]
    fn ngl_follows_the_configured_value() {
        let spec = SidecarSpec {
            role: SidecarRole::Rerank,
            binary: PathBuf::from("/bin/true"),
            model: PathBuf::from("/tmp/r.gguf"),
            port: 18082,
            ngl: 0,
        };
        let args = spec.args();
        let at = args.iter().position(|arg| arg == "-ngl").expect("-ngl");
        assert_eq!(args[at + 1], "0");
    }

    #[test]
    fn missing_binary_is_reported_not_panicked() {
        let spec = SidecarSpec {
            role: SidecarRole::Embedding,
            binary: PathBuf::from("/nonexistent/llama-server"),
            model: PathBuf::from("/nonexistent/model.gguf"),
            port: 18081,
            ngl: 99,
        };
        let mut sidecar = Sidecar::new(spec);
        let err = sidecar.start().expect_err("应报错");
        assert!(matches!(err, KbError::Unavailable(_)), "{err:?}");
    }
}
