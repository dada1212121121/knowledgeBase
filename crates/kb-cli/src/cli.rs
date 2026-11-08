//! 命令行定义(clap)。

use std::path::PathBuf;

use clap::{Parser, Subcommand};

/// `kb` 的顶层参数。
#[derive(Debug, Parser)]
#[command(
    name = "kb",
    version,
    about = "本机 AI 开发知识库:索引、检索与经验沉淀",
    arg_required_else_help = true
)]
pub struct Cli {
    /// 强制嵌入式模式(不连守护进程)。
    #[arg(long, global = true)]
    pub local: bool,
    /// 强制走守护进程(没运行就报错)。
    #[arg(long, global = true)]
    pub remote: bool,
    /// 要执行的子命令。
    #[command(subcommand)]
    pub command: Command,
}

/// 子命令。
#[derive(Debug, Subcommand)]
pub enum Command {
    /// 检查运行环境:g++ / libstdc++、目录可写、磁盘、内存、核显、模型缓存、socket、代理
    Doctor {
        /// 输出 JSON(表的碎片 / 版本 / 索引覆盖也在这里)
        #[arg(long)]
        json: bool,
        /// 只看某一块:目前支持 `backends`(OCR / 转写 / 嵌入 / 重排的后端清单)
        #[arg(value_name = "WHAT")]
        what: Option<String>,
    },
    /// 项目管理
    Project {
        /// 子命令
        #[command(subcommand)]
        action: ProjectAction,
    },
    /// 索引项目或导入文档
    Index(IndexArgs),
    /// 查看任务队列
    Jobs(JobsArgs),
    /// 检索知识与代码
    Search(SearchArgs),
    /// 用黄金查询集评测检索质量
    Eval(EvalArgs),
    /// 按 [retention] 的期限清历史表(默认只预览)
    Retention(RetentionArgs),
    /// 启动守护进程(单实例,TCP + UDS)
    Daemon(DaemonArgs),
    /// 以 MCP stdio 服务运行(给 AI 客户端用);`kb mcp token` 管理 /mcp 的 token
    Mcp(McpArgs),
    /// 把 kb mcp 接进客户端配置
    Integrate(IntegrateArgs),
    /// 打印公开 Agent Skill(免登录、不含密钥);加 `--out` 写到文件
    Skill(SkillArgs),
    /// 换嵌入模型(重建新表后切换)
    Migrate {
        /// collection 名
        collection: String,
        /// 目标 embedder id
        #[arg(long)]
        to: String,
        /// 只估算,不执行
        #[arg(long)]
        dry_run: bool,
    },
    /// 核显 sidecar:install / status / bench
    Accel {
        /// install / status / bench
        #[arg(value_parser = ["install", "status", "bench"])]
        action: String,
    },
    /// 管理 Web 登录密码与 API 令牌
    Auth {
        /// 子命令
        #[command(subcommand)]
        action: AuthAction,
    },
    /// 账号管理(本机管理员):list / create / passwd / disable / enable / role
    User {
        /// 子命令
        #[command(subcommand)]
        action: UserAction,
    },
    /// 用 systemd 托管守护进程:install / uninstall / status
    Service {
        /// install / uninstall / status
        #[arg(value_parser = ["install", "uninstall", "status"])]
        action: String,
        /// 强制系统级(默认:root 装系统级,普通用户装用户级)
        #[arg(long)]
        system: bool,
        /// 只打印(不落盘、不删文件、不调 systemctl);对 install / uninstall / status 都生效
        #[arg(long)]
        print: bool,
        /// 覆盖 unit 目录(测试用)
        #[arg(long)]
        unit_dir: Option<PathBuf>,
    },
    /// 安装 / 卸载链式 git hook
    Hooks {
        /// install / uninstall / status
        #[arg(value_parser = ["install", "uninstall", "status"])]
        action: String,
        /// 项目名或 slug
        project: String,
    },
    /// 会话结束 hook:读标准输入的 hook JSON,投递 `session_end` 事件
    Hook {
        /// claude-stop(Claude Code)/ kiro-stop(Kiro)
        #[arg(value_parser = ["claude-stop", "kiro-stop"])]
        action: String,
    },
    /// 备份:create / list / delete / verify / prune(保留策略)
    Backup {
        /// 子命令
        #[command(subcommand)]
        action: BackupAction,
    },
    /// 旧格式 Office 入库转换用的 LibreOffice:install / status
    Convert {
        /// 子命令
        #[command(subcommand)]
        action: ConvertAction,
    },
}

/// `kb convert` 的子命令。
#[derive(Debug, Subcommand)]
pub enum ConvertAction {
    /// 把锁定版本的 LibreOffice 装进 `<KB_HOME>/bin/`(已装好就只核对一遍)
    Install {
        /// 用本地的官方整包离线安装(同样核对 SHA-256)
        #[arg(long)]
        from: Option<std::path::PathBuf>,
        /// 输出 JSON
        #[arg(long)]
        json: bool,
    },
    /// 查看安装状态与 `[convert]` 配置
    Status {
        /// 输出 JSON
        #[arg(long)]
        json: bool,
    },
}

/// `kb backup` 的子命令。
#[derive(Debug, Subcommand)]
pub enum BackupAction {
    /// 立即新建一份备份
    Create {
        /// 把原件(sources)也打进归档
        #[arg(long)]
        include_sources: bool,
        /// 输出 JSON
        #[arg(long)]
        json: bool,
    },
    /// 列出已有备份
    List {
        /// 输出 JSON
        #[arg(long)]
        json: bool,
    },
    /// 删除一份备份
    Delete {
        /// 归档文件名(`kb backup list` 里那一列)
        name: String,
    },
    /// 校验一份备份归档(恢复前先跑:gzip / tar 结构、manifest 与 meta.db)
    Verify {
        /// 归档文件名(`kb backup list` 里那一列),或归档的路径(异地副本也能直接校验)
        name: String,
        /// 输出 JSON
        #[arg(long)]
        json: bool,
    },
    /// 按 `[backup]` 的保留策略清理旧备份
    Prune {
        /// 覆盖保留份数(默认取 `[backup] keep_count`;0 = 不按份数清理)
        #[arg(long)]
        keep: Option<u64>,
        /// 覆盖保留天数(默认取 `[backup] keep_days`;0 = 不按天数清理)
        #[arg(long)]
        days: Option<u64>,
        /// 只列出会被删掉的归档,不真删
        #[arg(long)]
        dry_run: bool,
        /// 输出 JSON
        #[arg(long)]
        json: bool,
    },
}

/// `kb user` 的子命令。密码一律从标准输入读取。
#[derive(Debug, Subcommand)]
pub enum UserAction {
    /// 列出用户
    List {
        /// 输出 JSON
        #[arg(long)]
        json: bool,
    },
    /// 新建用户(密码从标准输入读取)
    Create {
        /// 登录名(3–20 位小写字母、数字、下划线)
        username: String,
        /// 邮箱
        #[arg(long)]
        email: Option<String>,
        /// 角色:admin / user / 角色 id
        #[arg(long, default_value = "user")]
        role: String,
        /// 显示名
        #[arg(long)]
        name: Option<String>,
    },
    /// 重设密码(从标准输入读取),并让该用户的其它会话失效
    Passwd {
        /// 登录名或邮箱
        user: String,
    },
    /// 停用(立即踢下线)
    Disable {
        /// 登录名或邮箱
        user: String,
    },
    /// 启用
    Enable {
        /// 登录名或邮箱
        user: String,
    },
    /// 改角色
    Role {
        /// 登录名或邮箱
        user: String,
        /// 角色:admin / user / 角色 id
        role: String,
    },
    /// 列出角色和各自的功能
    Roles,
}

/// `kb auth` 的子命令。
#[derive(Debug, Subcommand)]
pub enum AuthAction {
    /// 设置 Web 登录密码(从标准输入读取)
    SetPassword,
    /// API 令牌管理
    Token {
        /// 子命令
        #[command(subcommand)]
        action: AuthTokenAction,
    },
}

/// `kb auth token` 的子命令。
#[derive(Debug, Subcommand)]
pub enum AuthTokenAction {
    /// 新建令牌(明文只显示一次)
    Create {
        /// 令牌名(唯一)
        name: String,
        /// `mcp`(只能用 MCP 可见面)或 `api`(REST)
        #[arg(long, default_value = "mcp")]
        scope: String,
    },
    /// 列出令牌
    List,
    /// 撤销令牌
    Revoke {
        /// 令牌 id
        id: String,
    },
}

/// `kb project` 的子命令。
#[derive(Debug, Subcommand)]
pub enum ProjectAction {
    /// 注册项目(自动创建 collection)
    Add {
        /// 项目根目录
        path: PathBuf,
        /// 项目名(默认取目录名)
        #[arg(long)]
        name: Option<String>,
    },
    /// 列出项目
    List,
    /// 查看项目详情
    Show {
        /// 项目名或 slug
        name: String,
    },
    /// 移除项目(连同 collection 与物理表)
    Remove {
        /// 项目名或 slug
        name: String,
    },
}

/// `kb index` 的参数。
#[derive(Debug, clap::Args)]
pub struct IndexArgs {
    /// 项目名;用 `--global` 时可以省略
    pub project: Option<String>,
    /// 强制全量索引(等价于从头重建;`--rebuild` 是别名)
    #[arg(long, alias = "rebuild")]
    pub full: bool,
    /// 只处理这些路径(增量);逗号分隔
    #[arg(long, value_delimiter = ',')]
    pub paths: Vec<String>,
    /// 把文件或目录导入 `_global`
    #[arg(long)]
    pub global: Option<PathBuf>,
    /// 导入 `_global` 时附加的标签;逗号分隔
    #[arg(long, value_delimiter = ',')]
    pub tag: Vec<String>,
    /// 只写正文与全文索引,把向量留给后台队列
    #[arg(long, conflicts_with = "embed_pending")]
    pub text_only: bool,
    /// 只排空待补向量队列,不重新扫描文件
    #[arg(long, conflicts_with = "text_only")]
    pub embed_pending: bool,
}

/// `kb search` 的参数。
#[derive(Debug, clap::Args)]
pub struct SearchArgs {
    /// 查询串;支持 `kind:` / `lang:` / `path:` / `tag:` / `status:` / `since:` 前缀
    pub query: String,
    /// 只搜这个项目(默认按当前目录匹配)
    #[arg(long)]
    pub project: Option<String>,
    /// 额外的 kind 过滤(code / doc / insight …),可重复
    #[arg(long, value_delimiter = ',')]
    pub kind: Vec<String>,
    /// 返回条数
    #[arg(long)]
    pub k: Option<usize>,
    /// 输出各阶段排名
    #[arg(long)]
    pub explain: bool,
    /// 输出 JSON(设计规范的响应形状)
    #[arg(long)]
    pub json: bool,
}

/// `kb mcp` 的参数。
#[derive(Debug, clap::Args)]
pub struct McpArgs {
    /// 管理 `/mcp` 的 Bearer token(不给子命令就启动 stdio 桥接)
    #[command(subcommand)]
    pub action: Option<McpAction>,
    /// 只暴露这些工具组(`knowledge` / `jobs` / `insight` / `docs`,逗号分隔;默认全部)
    #[arg(long)]
    pub features: Option<String>,
}

/// `kb mcp` 的子命令。
#[derive(Debug, clap::Subcommand)]
pub enum McpAction {
    /// 显示 / 生成 / 轮换 /mcp 的 token
    Token {
        /// 重新生成(轮换)
        #[arg(long)]
        rotate: bool,
    },
}

/// `kb integrate` 的参数。
#[derive(Debug, clap::Args)]
pub struct IntegrateArgs {
    /// 客户端:kiro / claude / codex
    pub client: String,
    /// 写入配置文件(默认只打印)
    #[arg(long)]
    pub apply: bool,
    /// 只打印(默认行为,显式写出便于脚本)
    #[arg(long)]
    pub print: bool,
}

/// `kb skill` 的参数。
#[derive(Debug, clap::Args)]
pub struct SkillArgs {
    /// 写到这个路径;不给就打印到标准输出
    #[arg(long)]
    pub out: Option<PathBuf>,
}

/// `kb daemon` 的参数。
#[derive(Debug, clap::Args)]
pub struct DaemonArgs {
    /// 转到后台运行
    #[arg(long)]
    pub detach: bool,
}

/// `kb eval` 的参数。
#[derive(Debug, clap::Args)]
pub struct EvalArgs {
    /// 黄金集路径(默认 eval/golden.example.toml)
    #[arg(long)]
    pub set: Option<PathBuf>,
    /// 评测的 k(默认 5)
    #[arg(long)]
    pub k: Option<usize>,
    /// 输出 JSON
    #[arg(long)]
    pub json: bool,
    /// 允许在降级(只做全文检索)状态下评测
    #[arg(long)]
    pub allow_degraded: bool,
    /// 按文件格式拆分命中率(按期望源的扩展名统计)
    #[arg(long)]
    pub by_format: bool,
    /// 从黄金集里随机抽 N 条(默认全部);配 --seed 可复现同一批
    #[arg(long, value_name = "N")]
    pub sample: Option<usize>,
    /// 随机种子(默认现取一个时间戳,会打印在结果里)
    #[arg(long)]
    pub seed: Option<u64>,
    /// 有无效用例(collection / 期望文件不存在)时仍然算分、不以退出码 6 报错
    #[arg(long)]
    pub allow_invalid: bool,
    /// 重排:on / off / auto(默认按配置)。A/B 对比时两次必须显式给同一个值
    #[arg(long, value_enum, default_value_t = RerankFlag::Auto)]
    pub rerank: RerankFlag,
}

/// `kb eval --rerank` 的取值。
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum RerankFlag {
    /// 强制重排(没装重排器时如实报出来,不静默跳过)
    On,
    /// 关掉重排,只看融合结果
    Off,
    /// 按 `[rerank] mode` 走(默认)
    Auto,
}

impl RerankFlag {
    /// 换成 `SearchRequest.rerank`:`auto` 是 `None`(按配置)。
    pub fn to_request(self) -> Option<bool> {
        match self {
            Self::On => Some(true),
            Self::Off => Some(false),
            Self::Auto => None,
        }
    }

    /// 给人看/进 JSON 的名字。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::On => "on",
            Self::Off => "off",
            Self::Auto => "auto",
        }
    }
}

/// `kb jobs` 的子命令。
#[derive(Debug, Subcommand)]
pub enum JobsAction {
    /// 清理失败的历史任务(默认只预览条数,加 `--yes` 才真删;只动 failed 状态)
    Prune {
        /// 只清理结束时间早于这么多小时之前的失败任务,最近的留着方便排查
        #[arg(long, default_value_t = 24)]
        older_than_hours: u32,
        /// 确认删除;不加则只预览
        #[arg(long)]
        yes: bool,
        /// 输出 JSON
        #[arg(long)]
        json: bool,
    },
}

/// `kb retention` 的参数。
#[derive(Debug, clap::Args)]
pub struct RetentionArgs {
    /// 确认删除;不加则只预览会删多少行
    #[arg(long)]
    pub yes: bool,
    /// 输出 JSON
    #[arg(long)]
    pub json: bool,
}

/// `kb jobs` 的参数。
#[derive(Debug, clap::Args)]
#[command(args_conflicts_with_subcommands = true)]
pub struct JobsArgs {
    #[command(subcommand)]
    pub action: Option<JobsAction>,
    /// 只看某个状态:queued / running / paused / done / failed / canceled
    #[arg(long)]
    pub state: Option<String>,
    /// 输出 JSON
    #[arg(long)]
    pub json: bool,
}
