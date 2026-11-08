//! `kb accel install|status|bench`。
//!
//! 说明:`install` 需要访问 GitHub 下载 llama.cpp 的 Vulkan 包,本机(无网络/无核显)
//! 无法验证;`status` / `bench` 只依赖本机已安装的文件与运行中的 sidecar。

use std::process::ExitCode;
use std::time::Instant;

use kb_core::KbError;
use kb_core::config::Config;
use kb_core::paths::KbPaths;

use crate::error::CliError;

/// accel 子命令。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccelAction {
    /// 安装 llama.cpp Vulkan 包。
    Install,
    /// 查看安装与运行状态。
    Status,
    /// 复现 FEASIBILITY 设计规范的测量。
    Bench,
}

/// 执行。
pub async fn run(
    paths: &KbPaths,
    config: &Config,
    action: AccelAction,
) -> std::result::Result<ExitCode, CliError> {
    let accel = &config.accel;
    // `accel.embed_gguf` 已经是相对 models_dir 的路径(默认 `gguf/xxx.gguf`),不要再拼一层
    let bin = expand_home(&accel.llama_dir).join("llama-server");
    let embed_model = paths.models_dir().join(&accel.embed_gguf);
    let rerank_model = paths.models_dir().join(&accel.rerank_gguf);

    match action {
        AccelAction::Status => {
            println!("enabled:      {}", accel.enabled);
            println!(
                "llama-server: {}({})",
                bin.display(),
                if bin.exists() { "已安装" } else { "缺失" }
            );
            println!(
                "embed gguf:   {}({})",
                embed_model.display(),
                if embed_model.exists() {
                    "存在"
                } else {
                    "缺失"
                }
            );
            println!(
                "rerank gguf:  {}({})",
                rerank_model.display(),
                if rerank_model.exists() {
                    "存在"
                } else {
                    "缺失"
                }
            );
            let mut healthy = std::collections::BTreeMap::new();
            for (name, port) in [
                ("embedding", accel.embed_port),
                ("rerank", accel.rerank_port),
            ] {
                let url = format!("http://127.0.0.1:{port}");
                let probe = kb_embed::HttpEmbedder::new(url.clone(), "probe", 1);
                let health = probe.healthy().await;
                healthy.insert(name, health);
                println!(
                    "{name:<11}  : {url}/health → {}",
                    if health { "ok" } else { "不可达" }
                );
            }
            // 一句人话结论:这三件事(配了、模型在、服务通)缺一件,重排就不会真的发生,
            // 而评测页的模式列看不出来(它只说「按配置」)
            println!();
            println!(
                "重排器:{}",
                verdict(
                    accel.enabled && accel.role_enabled("rerank"),
                    rerank_model.exists(),
                    healthy.get("rerank").copied().unwrap_or(false),
                    &rerank_model,
                )
            );
            println!(
                "嵌入器(GGUF):{}",
                verdict(
                    accel.enabled && accel.role_enabled("embed"),
                    embed_model.exists(),
                    healthy.get("embedding").copied().unwrap_or(false),
                    &embed_model,
                )
            );
            Ok(ExitCode::SUCCESS)
        }
        AccelAction::Install => {
            // 下载与校验逻辑需要外网;本机无法验证,这里只做前置检查并给出明确指引
            if bin.exists() {
                println!("llama-server 已存在:{}(无需下载)", bin.display());
                return Ok(ExitCode::SUCCESS);
            }
            Err(KbError::Unavailable(format!(
                "未安装 llama.cpp Vulkan 包:请按 验证样例 的说明把 llama-server 放到 {};\
                 本机(无外网/无核显)不自动下载",
                bin.display()
            ))
            .into())
        }
        AccelAction::Bench => bench(config, &embed_model, &rerank_model).await,
    }
}

/// 「配了 / 模型在 / 服务通」三件事合成一句话。
///
/// 缺哪件就说哪件,并给出下一步:只写「缺失」的话,用户不知道是该装模型、改配置还是起守护进程。
fn verdict(configured: bool, model_ok: bool, healthy: bool, model: &std::path::Path) -> String {
    if !configured {
        return if model_ok {
            "未启用(配置里没开,或这一路被 `[accel] roles` 排除;模型已就位,检索不受影响)".to_owned()
        } else {
            format!(
                "未启用(配置里没开,或这一路被 `[accel] roles` 排除;模型也没放:{})",
                model.display()
            )
        };
    }
    if !model_ok {
        return format!(
            "未安装(模型缺失:{};按 验证样例 的说明把 GGUF 放进模型目录)",
            model.display()
        );
    }
    if !healthy {
        return "模型已就位但服务没起来(启动 `kb daemon`,或手动跑 llama-server 后重试)".to_owned();
    }
    format!("已就绪({})", model.display())
}

/// 复现 FEASIBILITY 设计规范:embedding ≥ 3 块/秒;20 条 × 400 字重排 ≤ 3 秒。
///
/// 两段各自独立:只装了重排模型、只起了重排 sidecar 时也能单独量重排
/// (以前是任一段缺料就整体报错,于是「只评估重排」根本跑不了)。
async fn bench(
    config: &Config,
    embed_model: &std::path::Path,
    rerank_model: &std::path::Path,
) -> std::result::Result<ExitCode, CliError> {
    if !embed_model.exists() && !rerank_model.exists() {
        return Err(KbError::Unavailable(format!(
            "两个 GGUF 模型都不在({} / {}),先按设计规范放到模型目录下",
            embed_model.display(),
            rerank_model.display()
        ))
        .into());
    }
    let embedder = kb_embed::HttpEmbedder::new(
        format!("http://127.0.0.1:{}", config.accel.embed_port),
        config.embed.model.clone(),
        1024,
    );
    let reranker = kb_embed::HttpReranker::new(
        format!("http://127.0.0.1:{}", config.accel.rerank_port),
        config.accel.rerank_gguf.clone(),
    );
    // 嵌入段:模型在 + sidecar 通才量,否则说清楚缺哪件后跳过
    let mut measured = Vec::new();
    if !embed_model.exists() {
        println!("embedding: 跳过(模型缺失 {})", embed_model.display());
    } else if !embedder.healthy().await {
        println!("embedding: 跳过(嵌入 sidecar 不可达,先启动 `kb daemon`)");
    } else {
        // 嵌入吞吐:16 块 × 约 400 字
        let texts: Vec<String> = (0..16)
            .map(|index| {
                format!(
                    "第 {index} 块:{}\n",
                    "fn bench() -> u32 { 42 }\n".repeat(20)
                )
            })
            .collect();
        let started = Instant::now();
        use kb_core::ports::Embedder;
        let vectors = embedder.embed_documents(texts.clone()).await?;
        let embed_elapsed = started.elapsed();
        let per_second = texts.len() as f64 / embed_elapsed.as_secs_f64();
        println!(
            "embedding: {} 块 / {:.3} s = {per_second:.2} 块/秒(要求 ≥ 3)",
            vectors.len(),
            embed_elapsed.as_secs_f64()
        );
        measured.push(("embedding", per_second >= 3.0));
    }

    // 重排段:20 条 × 400 字
    if !rerank_model.exists() {
        println!("rerank:    跳过(模型缺失 {})", rerank_model.display());
    } else if !reranker.refresh_health().await {
        println!("rerank:    跳过(重排 sidecar 不可达)");
    } else {
        let docs: Vec<String> = (0..20)
            .map(|index| format!("文档 {index}:{}", "知识库检索与重排的示例文本。".repeat(40)))
            .collect();
        let started = Instant::now();
        use kb_core::ports::Reranker;
        let scores = reranker.rerank("如何做增量索引", &docs).await?;
        let rerank_elapsed = started.elapsed();
        println!(
            "rerank:    {} 条 / {:.3} s(要求 ≤ 3 s),最高分 {:.3}",
            scores.len(),
            rerank_elapsed.as_secs_f64(),
            scores.iter().cloned().fold(f32::MIN, f32::max)
        );
        measured.push(("rerank", rerank_elapsed.as_secs_f64() <= 3.0));
    }

    // 一段都没量到:不是达标也不是未达标,得当成错误说出来
    if measured.is_empty() {
        return Err(KbError::Unavailable("两个 sidecar 都没起来,没有可测的一段".to_owned()).into());
    }
    let failed: Vec<&str> = measured
        .iter()
        .filter(|(_, ok)| !ok)
        .map(|(name, _)| *name)
        .collect();
    if failed.is_empty() {
        println!("结论:达到 FEASIBILITY 设计规范的指标");
        return Ok(ExitCode::SUCCESS);
    }
    println!(
        "结论:未达到 FEASIBILITY 设计规范的指标({})",
        failed.join(" / ")
    );
    Ok(ExitCode::from(1))
}

/// 展开 `~`。
/// 展开 `~` 与 `$HOME`。
///
/// 只展开开头:`~`、`~/x`、`$HOME`、`$HOME/x`;其余保持原样。
pub(crate) fn expand_home(value: &str) -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return std::path::PathBuf::from(value);
    }
    for prefix in ["$HOME", "${HOME}"] {
        if let Some(rest) = value.strip_prefix(prefix) {
            let rest = rest.strip_prefix('/').unwrap_or(rest);
            return std::path::Path::new(&home).join(rest);
        }
    }
    if value == "~" {
        return std::path::PathBuf::from(&home);
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return std::path::Path::new(&home).join(rest);
    }
    std::path::PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_prefixes_are_expanded() {
        let home = std::env::var("HOME").expect("HOME");
        assert_eq!(
            expand_home("~/.kb/bin"),
            std::path::Path::new(&home).join(".kb/bin")
        );
        assert_eq!(expand_home("~"), std::path::Path::new(&home));
        assert_eq!(
            expand_home("$HOME/.kb/bin"),
            std::path::Path::new(&home).join(".kb/bin")
        );
        assert_eq!(
            expand_home("${HOME}/bin"),
            std::path::Path::new(&home).join("bin")
        );
        assert_eq!(
            expand_home("/opt/llama"),
            std::path::Path::new("/opt/llama")
        );
    }
}
