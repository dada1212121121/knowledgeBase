//! 插件宿主:外部进程 + JSON-RPC/stdio。
//!
//! 不把插件编进宿主进程:插件崩了、卡了、吐了脏数据,最多让当前文件回退到内置实现,
//! 不能把守护进程一起带走。协议是逐行 JSON-RPC,stdout 只允许协议数据,日志走 stderr。
//!
//! 这一层只负责“把请求送过去、把结果拿回来、把进程管住”:
//! - 进程懒启动,同一插件在多文件之间复用;
//! - 每次调用有超时,输出有大小上限(防止一个坏插件把内存吃光);
//! - 超时 / 通信失败 / 非零退出后杀掉进程并复位,下一次调用重新拉起;
//! - `env_clear` 后只注入运行必需的最小环境,不把宿主的 API key、数据库凭据带进插件;
//! - 默认用 bwrap 把文件系统与网络关起来(见 `sandbox.rs`),只有管理员显式允许才裸跑。

use std::path::{Path, PathBuf};
use std::time::Duration;

use kb_core::{KbError, Result};
use serde::Deserialize;
use serde_json::{Value, json};
use std::process::Stdio;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::task::JoinHandle;
use tokio::time::timeout;

use super::sandbox::{self, SandboxMode};

/// 单次发给插件的请求上限。extract 会把原文件 base64 后发过去,10MB 的文件约 13.3MB;
/// 这个上限和响应上限分开,避免“文件稍大就根本送不进插件”。
const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;

/// 插件宿主:一个插件目录对应一个实例,进程按需启动。
pub(crate) struct PluginHost {
    name: String,
    version: String,
    command: String,
    args: Vec<String>,
    cwd: PathBuf,
    hooks: Vec<String>,
    timeout: Duration,
    max_output_bytes: usize,
    sandbox: SandboxMode,
    process: crate::supervise::Slot<PluginProcess>,
}

impl std::fmt::Debug for PluginHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginHost")
            .field("name", &self.name)
            .field("version", &self.version)
            .field("command", &self.command)
            .field("hooks", &self.hooks)
            .field("sandbox", &self.sandbox)
            .finish_non_exhaustive()
    }
}

impl PluginHost {
    /// 构造一个懒启动的宿主。`command` / `args` 来自清单,调用前已经过校验。
    // 8 个参数都是清单里的独立项,拆成配置结构只会多一层无意义包装。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        name: String,
        version: String,
        command: String,
        args: Vec<String>,
        cwd: PathBuf,
        hooks: Vec<String>,
        timeout: Duration,
        max_output_bytes: usize,
        sandbox: SandboxMode,
    ) -> Self {
        Self {
            name,
            version,
            command,
            args,
            cwd,
            hooks,
            timeout,
            max_output_bytes,
            sandbox,
            process: crate::supervise::Slot::new(),
        }
    }

    /// 调一个钩子。`initialize` 由宿主在首次调用时自动完成。
    pub(crate) async fn call(&self, method: &str, params: Value) -> Result<Value> {
        // 锁住整个进程:同一插件的多个文件不并发写同一条 stdin/stdout。
        // 索引是顺序处理的,这里的锁不会成为瓶颈;以后要并行,应按进程池而不是拆锁。
        let mut guard = self.process.lock().await;
        if guard.is_none() {
            // 先取代号再拉起:拉起失败也不回收,免得「失败那次」和「重试那次」同号。
            let generation = self.process.next_generation();
            let process = self.spawn().await?;
            *guard = Some(crate::supervise::Entry {
                generation,
                value: process,
            });
        }
        let result = {
            let process = guard
                .as_mut()
                .map(|entry| &mut entry.value)
                .ok_or_else(|| KbError::Internal("插件进程状态异常".to_owned()))?;
            process.request(method, params).await
        };
        if result.is_err()
            && let Some(mut entry) = guard.take()
        {
            // 超时/坏 JSON 后进程状态不可信,下一次重新拉起,避免半截响应串到下一个请求。
            entry.value.kill();
        }
        result
    }

    async fn spawn(&self) -> Result<PluginProcess> {
        let command = self.resolve_command();
        // 环境变量只保留解释器能启动、插件能定位自己的那几项。
        // 这里同时给 bwrap 和裸跑用,两条路径的环境上限完全一致。
        let env = vec![
            (
                "PATH".to_owned(),
                std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_owned()),
            ),
            ("HOME".to_owned(), self.cwd.to_string_lossy().into_owned()),
            ("TMPDIR".to_owned(), "/tmp".to_owned()),
            ("KB_PLUGIN_API".to_owned(), "1".to_owned()),
            ("KB_PLUGIN_NAME".to_owned(), self.name.clone()),
            (
                "KB_PLUGIN_DIR".to_owned(),
                self.cwd.to_string_lossy().into_owned(),
            ),
        ];
        let mut cmd = match self.sandbox {
            SandboxMode::Bwrap { network } => {
                let launch = sandbox::bwrap_launch(&command, &self.args, &self.cwd, &env, network)?;
                let mut cmd = Command::new(launch.program);
                cmd.args(launch.args);
                // bwrap 自己也不继承宿主环境;插件环境由 --setenv 注入。
                cmd.env_clear();
                cmd
            }
            SandboxMode::Direct => {
                let mut cmd = Command::new(&command);
                cmd.args(&self.args).env_clear();
                for (key, value) in &env {
                    cmd.env(key, value);
                }
                cmd
            }
        };
        cmd.current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|err| {
            KbError::Unavailable(format!(
                "启动插件 {} 失败({}): {err}",
                self.name,
                command.display()
            ))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| KbError::Internal(format!("插件 {} 没有 stdin", self.name)))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| KbError::Internal(format!("插件 {} 没有 stdout", self.name)))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| KbError::Internal(format!("插件 {} 没有 stderr", self.name)))?;
        let stderr_task = spawn_stderr_reader(self.name.clone(), stderr);
        Ok(PluginProcess {
            name: self.name.clone(),
            version: self.version.clone(),
            hooks: self.hooks.clone(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 0,
            initialized: false,
            timeout: self.timeout,
            max_output_bytes: self.max_output_bytes,
            stderr_task,
        })
    }

    /// 相对路径(带 `/`)按插件目录解析;裸命令(如 `python3`)继续走 PATH。
    fn resolve_command(&self) -> PathBuf {
        let path = Path::new(&self.command);
        if path.is_relative() && self.command.contains(['/', '\\']) {
            self.cwd.join(path)
        } else {
            path.to_path_buf()
        }
    }
}

/// 一个已启动的插件进程。
struct PluginProcess {
    name: String,
    version: String,
    hooks: Vec<String>,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    initialized: bool,
    timeout: Duration,
    max_output_bytes: usize,
    stderr_task: JoinHandle<()>,
}

impl PluginProcess {
    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        if !self.initialized {
            self.initialize().await?;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.send(id, method, params).await
    }

    async fn initialize(&mut self) -> Result<()> {
        let id = self.next_id;
        self.next_id += 1;
        let result = self
            .send(
                id,
                "initialize",
                json!({
                "api_version": 1,
                "hooks": self.hooks,
                "plugin": {"name": self.name, "version": self.version},
                "host": {"name": "kb", "version": env!("CARGO_PKG_VERSION")},
                }),
            )
            .await?;
        let api_version = result
            .get("api_version")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        if api_version != 1 {
            return Err(KbError::InvalidInput(format!(
                "插件 {} 不支持的 api_version {api_version}(宿主只支持 1)",
                self.name
            )));
        }
        self.initialized = true;
        Ok(())
    }

    /// 发一条 JSON-RPC 请求并读回对应 id 的响应。
    async fn send(&mut self, id: u64, method: &str, params: Value) -> Result<Value> {
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let mut line = serde_json::to_vec(&request)
            .map_err(|err| KbError::Internal(format!("序列化插件请求失败: {err}")))?;
        line.push(b'\n');
        if line.len() > MAX_REQUEST_BYTES {
            return Err(KbError::InvalidInput(format!(
                "发给插件 {} 的请求超过 {} 字节上限",
                self.name, MAX_REQUEST_BYTES
            )));
        }
        let max_output = self.max_output_bytes;
        let timeout_after = self.timeout;
        let name = self.name.clone();
        let stdin = &mut self.stdin;
        let stdout = &mut self.stdout;
        let response = timeout(timeout_after, async {
            stdin.write_all(&line).await?;
            stdin.flush().await?;
            read_line_limited(stdout, max_output).await
        })
        .await
        .map_err(|_| {
            KbError::Unavailable(format!(
                "插件 {} 调用 {method} 超时({}ms)",
                name,
                timeout_after.as_millis()
            ))
        })?
        .map_err(|err| KbError::Internal(format!("插件 {} 通信失败: {err}", name)))?;
        let response: HostResponse = serde_json::from_slice(&response).map_err(|err| {
            KbError::Internal(format!("插件 {} 返回的不是合法 JSON-RPC: {err}", name))
        })?;
        if response.id != Some(id) {
            return Err(KbError::Internal(format!(
                "插件 {} 响应 id 不匹配(期望 {id},收到 {:?})",
                name, response.id
            )));
        }
        if let Some(error) = response.error {
            let code = error.code.unwrap_or_else(|| "plugin_error".to_owned());
            return Err(KbError::Internal(format!(
                "插件 {} 返回错误 {code}: {}",
                name, error.message
            )));
        }
        Ok(response.result.unwrap_or(Value::Null))
    }

    fn kill(&mut self) {
        let _ = self.child.start_kill();
        self.stderr_task.abort();
    }
}

impl Drop for PluginProcess {
    fn drop(&mut self) {
        // 宿主重载 / 关闭时不能留下孤儿进程。
        let _ = self.child.start_kill();
        self.stderr_task.abort();
    }
}

#[derive(Debug, Deserialize)]
struct HostResponse {
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<HostError>,
}

#[derive(Debug, Deserialize)]
struct HostError {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: String,
}

/// 按行读,但单行长度有上限:坏插件不能靠一条超长响应把宿主内存撑爆。
async fn read_line_limited<R>(reader: &mut R, limit: usize) -> std::io::Result<Vec<u8>>
where
    R: AsyncBufRead + Unpin,
{
    let mut out = Vec::new();
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            if out.is_empty() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "插件已退出",
                ));
            }
            return Ok(out);
        }
        if let Some(pos) = chunk.iter().position(|byte| *byte == b'\n') {
            if out.len() + pos > limit {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "插件响应超过大小上限",
                ));
            }
            out.extend_from_slice(&chunk[..=pos]);
            let consumed = pos + 1;
            reader.consume(consumed);
            return Ok(out);
        }
        if out.len() + chunk.len() > limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "插件响应超过大小上限",
            ));
        }
        let consumed = chunk.len();
        out.extend_from_slice(chunk);
        reader.consume(consumed);
    }
}

/// 把 stderr 读走并记日志。不读的话管道写满后插件会卡死。
fn spawn_stderr_reader(name: String, stderr: tokio::process::ChildStderr) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        loop {
            match read_line_limited(&mut reader, 8 * 1024).await {
                Ok(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let text = text.trim();
                    if !text.is_empty() {
                        // 截断到 512 字符:插件可能把整个堆栈打出来,日志里只留线索。
                        let text: String = text.chars().take(512).collect();
                        tracing::warn!(plugin = %name, stderr = %text, "插件 stderr");
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(err) => {
                    tracing::debug!(plugin = %name, error = %err, "读取插件 stderr 结束");
                    break;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("plugin.sh");
        std::fs::write(&path, body).expect("写测试插件");
        path
    }

    fn host(dir: &Path, script: &Path, timeout_ms: u64) -> PluginHost {
        PluginHost::new(
            "demo".to_owned(),
            "0.1.0".to_owned(),
            "sh".to_owned(),
            vec![script.to_string_lossy().into_owned()],
            dir.to_path_buf(),
            vec!["chunk".to_owned()],
            Duration::from_millis(timeout_ms),
            64 * 1024,
            SandboxMode::Direct,
        )
    }

    const ECHO: &str = r#"#!/bin/sh
while IFS= read -r line; do
 id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
 case "$line" in
 *'"method":"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"api_version":1}}\n' "$id" ;;
 *'"method":"chunk"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"text":"ok"}}\n' "$id" ;;
 *) printf '{"jsonrpc":"2.0","id":%s,"error":{"code":"unknown","message":"unknown"}}\n' "$id" ;;
 esac
done
"#;

    #[tokio::test]
    async fn initializes_once_and_reuses_the_process() {
        let dir = tempfile::tempdir().expect("临时目录");
        let script = script(dir.path(), ECHO);
        let host = host(dir.path(), &script, 2_000);
        let first = host
            .call("chunk", json!({"n": 1}))
            .await
            .expect("第一次调用");
        assert_eq!(first["text"], "ok");
        let second = host
            .call("chunk", json!({"n": 2}))
            .await
            .expect("第二次调用");
        assert_eq!(second["text"], "ok");
    }

    #[tokio::test]
    async fn timeout_kills_the_process_and_the_next_call_restarts_it() {
        let dir = tempfile::tempdir().expect("临时目录");
        // 第一次 sleep 到超时;进程被杀后第二次重新拉起,这条脚本仍然会 sleep,
        // 所以这里只断言第一次返回超时错误,不依赖第二次的时序。
        let script = script(dir.path(), "#!/bin/sh\nsleep 30\n");
        let host = host(dir.path(), &script, 100);
        let err = host.call("chunk", json!({})).await.expect_err("应超时");
        assert!(err.to_string().contains("超时"), "{err}");
    }

    #[tokio::test]
    async fn bad_json_is_reported_not_panicked() {
        let dir = tempfile::tempdir().expect("临时目录");
        let script = script(
            dir.path(),
            r#"#!/bin/sh
while IFS= read -r line; do
 printf 'not json\n'
done
"#,
        );
        let host = host(dir.path(), &script, 2_000);
        let err = host.call("chunk", json!({})).await.expect_err("应报错");
        assert!(err.to_string().contains("合法 JSON-RPC"), "{err}");
    }
}
