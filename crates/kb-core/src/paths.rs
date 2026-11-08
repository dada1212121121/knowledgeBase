//! 数据目录布局与路径解析(设计规范)。
//!
//! 根目录由环境变量 `KB_HOME` 决定(默认 `~/.kb`)。配置里所有路径项为空时一律从
//! `KB_HOME` 派生,只有显式填写才覆盖——这样测试设了 `KB_HOME=<临时目录>` 之后,
//! 不会有任何默认路径指向真实的 `~/.kb`。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::config::Config;
use crate::error::{KbError, Result};

/// 指定数据根目录的环境变量名。
pub const KB_HOME_ENV: &str = "KB_HOME";

/// 未设置 `KB_HOME` 时使用的目录名(位于用户主目录下)。
pub const HOME_DIR_NAME: &str = ".kb";

/// `KB_HOME` 下的全部路径。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KbPaths {
    home: PathBuf,
    config_file: PathBuf,
    secrets_file: PathBuf,
    meta_db: PathBuf,
    system_db: PathBuf,
    spaces_dir: PathBuf,
    lance_dir: PathBuf,
    lang_dir: PathBuf,
    models_dir: PathBuf,
    bin_dir: PathBuf,
    run_dir: PathBuf,
    socket: PathBuf,
    pid_file: PathBuf,
    lock_file: PathBuf,
    logs_dir: PathBuf,
    skills_dir: PathBuf,
    /// 后端声明目录:`<KB_HOME>/backends/<id>/manifest.toml`
    backends_dir: PathBuf,
    eval_dir: PathBuf,
    sources_dir: PathBuf,
    uploads_dir: PathBuf,
    trash_dir: PathBuf,
    workspace_dir: PathBuf,
    backups_dir: PathBuf,
    avatars_dir: PathBuf,
    exports_dir: PathBuf,
}

impl KbPaths {
    /// 按环境变量 `KB_HOME` 解析(未设置时用 `~/.kb`)。
    pub fn from_env() -> Result<Self> {
        Self::from_env_value(std::env::var_os(KB_HOME_ENV))
    }

    /// 用给定的 `KB_HOME` 值解析。
    ///
    /// `from_env` 也走这里,所以测试可以注入环境变量的取值而不必修改进程环境。
    /// `None` 或空字符串表示“未设置”,退回 `~/.kb`。
    pub fn from_env_value(value: Option<OsString>) -> Result<Self> {
        let home = match value {
            Some(raw) if !raw.is_empty() => expand_tilde_os(&raw)?,
            _ => default_home()?,
        };
        Ok(Self::from_home(home))
    }

    /// 用显式的根目录构造全部默认路径。
    pub fn from_home(home: impl Into<PathBuf>) -> Self {
        let home = home.into();
        let run_dir = home.join("run");
        let lang_dir = home.join("lang");
        Self {
            config_file: home.join("config.toml"),
            secrets_file: home.join("secrets.toml"),
            meta_db: home.join("meta.db"),
            system_db: home.join("system.db"),
            spaces_dir: home.join("spaces"),
            lance_dir: home.join("lance"),
            models_dir: home.join("models"),
            bin_dir: home.join("bin"),
            socket: run_dir.join("kb.sock"),
            pid_file: run_dir.join("daemon.pid"),
            lock_file: run_dir.join("daemon.lock"),
            logs_dir: home.join("logs"),
            skills_dir: home.join("skills"),
            backends_dir: home.join("backends"),
            eval_dir: home.join("eval"),
            sources_dir: home.join("sources"),
            uploads_dir: home.join("uploads"),
            trash_dir: home.join("trash"),
            workspace_dir: home.join("agent-workspace"),
            backups_dir: home.join("backups"),
            avatars_dir: home.join("avatars"),
            exports_dir: home.join("exports"),
            run_dir,
            lang_dir,
            home,
        }
    }

    /// 把「每个知识库自己的那部分」指向 `space_dir`,其余(配置、模型、词典、运行时、日志、备份……)仍在根目录。
    ///
    /// 多用户下每个知识库一份 `meta.db` / `lance/` / `sources/` / `uploads/`(多用户设计说明);
    /// 现有只认 `KbPaths` 的服务拿到这样的路径就等于「只看见这个知识库」。
    pub fn with_space(&self, space_dir: impl Into<PathBuf>) -> Self {
        let dir: PathBuf = space_dir.into();
        let mut paths = self.clone();
        paths.meta_db = dir.join("meta.db");
        paths.lance_dir = dir.join("lance");
        paths.sources_dir = dir.join("sources");
        paths.uploads_dir = dir.join("uploads");
        paths.trash_dir = dir.join("trash");
        // 评测的黄金集和历次结果也是每个人自己的:放在共用目录里,别人跑的评测、
        // 写的查询集全站可见,`eval_run` 的 `set` 也就能读到别人的文件
        paths.eval_dir = dir.join("eval");
        // 代理工作目录也是每个知识库自己的:一个用户的代理看不到另一个用户的文件
        paths.workspace_dir = dir.join("agent-workspace");
        paths
    }

    /// 某个知识库的目录:主知识库是 `KB_HOME` 本身,其余是 `<KB_HOME>/spaces/<space_id>`。
    ///
    /// id 只允许 `sp_` 开头的 `[a-z0-9_]`,拒绝 `..`、斜杠等,不让它逃出 `spaces/`。
    pub fn space_dir(&self, space_id: &str) -> Result<PathBuf> {
        if space_id == crate::account::PRIMARY_SPACE_ID {
            return Ok(self.home.clone());
        }
        let valid = space_id.starts_with("sp_")
            && space_id.len() > 3
            && space_id.len() <= 64
            && space_id
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_');
        if !valid {
            return Err(KbError::InvalidInput(format!("非法的知识库 id:{space_id}")));
        }
        Ok(self.spaces_dir.join(space_id))
    }

    /// 某个知识库的路径集合。主知识库就是当前路径本身(不做任何覆盖)。
    pub fn for_space(&self, space_id: &str) -> Result<Self> {
        if space_id == crate::account::PRIMARY_SPACE_ID {
            return Ok(self.clone());
        }
        Ok(self.with_space(self.space_dir(space_id)?))
    }

    /// 还是单用户时代的布局:根目录有 `meta.db`,没有 `system.db`。需要先跑 `kb migrate-multiuser`。
    pub fn is_legacy_layout(&self) -> bool {
        self.meta_db.exists() && !self.system_db.exists()
    }

    /// 应用配置里的路径覆盖(`paths.models_dir`、`server.socket`)。
    ///
    /// 空字符串表示“用默认值”,不做覆盖;显式填写的值支持 `~` 展开。
    pub fn with_config(mut self, config: &Config) -> Result<Self> {
        if !config.paths.models_dir.is_empty() {
            self.models_dir = expand_tilde(&config.paths.models_dir)?;
        }
        if !config.server.socket.is_empty() {
            self.socket = expand_tilde(&config.server.socket)?;
        }
        Ok(self)
    }

    /// 创建运行需要的目录(`lang` 下还有 jieba 词典目录)。
    ///
    /// 已存在时不做任何改动。`kb doctor` 与守护进程启动时调用。
    pub fn ensure_private_dirs(&self) -> Result<()> {
        self.ensure_dirs()?;
        use std::os::unix::fs::PermissionsExt;
        for dir in [self.home(), self.run_dir()] {
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        Ok(())
    }

    pub fn ensure_dirs(&self) -> Result<()> {
        let dirs = [
            &self.home,
            &self.run_dir,
            &self.logs_dir,
            &self.lang_dir.join("jieba").join("default"),
            &self.models_dir,
            &self.bin_dir,
            &self.skills_dir,
            &self.backends_dir,
            &self.eval_dir,
            &self.sources_dir,
            &self.uploads_dir,
            &self.trash_dir,
            &self.backups_dir,
            &self.avatars_dir,
            &self.exports_dir,
        ];
        for dir in dirs {
            std::fs::create_dir_all(dir).map_err(|err| {
                KbError::Internal(format!("创建目录 {} 失败: {err}", dir.display()))
            })?;
        }
        Ok(())
    }

    /// `<KB_HOME>/system.db`:账号、角色、会话、令牌、系统审计。
    pub fn system_db(&self) -> &Path {
        &self.system_db
    }
    /// `<KB_HOME>/spaces/`:每个用户一个知识库目录。
    pub fn spaces_dir(&self) -> &Path {
        &self.spaces_dir
    }
    /// 数据根目录(`KB_HOME`)。
    pub fn home(&self) -> &Path {
        &self.home
    }
    /// `<KB_HOME>/config.toml`
    pub fn config_file(&self) -> &Path {
        &self.config_file
    }
    /// `<KB_HOME>/secrets.toml`(权限 0600)
    pub fn secrets_file(&self) -> &Path {
        &self.secrets_file
    }
    /// `<KB_HOME>/meta.db`
    pub fn meta_db(&self) -> &Path {
        &self.meta_db
    }
    /// `<KB_HOME>/lance`
    pub fn lance_dir(&self) -> &Path {
        &self.lance_dir
    }
    /// `<KB_HOME>/lang`
    pub fn lang_dir(&self) -> &Path {
        &self.lang_dir
    }
    /// `<KB_HOME>/models`,或配置里的 `paths.models_dir`。
    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }
    /// `<KB_HOME>/bin`
    pub fn bin_dir(&self) -> &Path {
        &self.bin_dir
    }
    /// `<KB_HOME>/run`
    pub fn run_dir(&self) -> &Path {
        &self.run_dir
    }
    /// `<KB_HOME>/run/kb.sock`,或配置里的 `server.socket`。
    pub fn socket(&self) -> &Path {
        &self.socket
    }
    /// ACP 伴生进程用的套接字,和 `kb.sock` 同目录,固定叫 `agent.sock`。
    pub fn agent_socket(&self) -> PathBuf {
        self.socket
            .parent()
            .unwrap_or(self.run_dir.as_path())
            .join("agent.sock")
    }
    /// `<KB_HOME>/run/daemon.pid`
    pub fn pid_file(&self) -> &Path {
        &self.pid_file
    }
    /// `<KB_HOME>/run/daemon.lock`
    /// `/mcp` 的 Bearer token 文件(权限 0600,计划变更 )。
    pub fn mcp_token_file(&self) -> std::path::PathBuf {
        self.run_dir.join("mcp-token")
    }

    pub fn lock_file(&self) -> &Path {
        &self.lock_file
    }
    /// `<KB_HOME>/logs`
    pub fn logs_dir(&self) -> &Path {
        &self.logs_dir
    }
    /// `<KB_HOME>/skills`
    pub fn skills_dir(&self) -> &Path {
        &self.skills_dir
    }
    /// `<KB_HOME>/backends`:后端声明(每个后端一个子目录 + `manifest.toml`)。
    pub fn backends_dir(&self) -> &Path {
        &self.backends_dir
    }
    /// `<KB_HOME>/eval`
    pub fn eval_dir(&self) -> &Path {
        &self.eval_dir
    }
    /// `<KB_HOME>/sources`:数据源与上传文件的落盘根目录。
    pub fn sources_dir(&self) -> &Path {
        &self.sources_dir
    }
    /// 某个数据源的根目录(`<KB_HOME>/sources/<id>`)。
    pub fn source_dir(&self, id: &str) -> PathBuf {
        self.sources_dir.join(id)
    }
    /// `<KB_HOME>/uploads`:未完成的分片与合并临时文件。
    pub fn uploads_dir(&self) -> &Path {
        &self.uploads_dir
    }
    /// `<KB_HOME>/trash`:删除的上传 / 压缩包副本在这里放 30 天。
    pub fn trash_dir(&self) -> &Path {
        &self.trash_dir
    }

    /// 外部编码代理(ACP)的工作目录:主知识库是 `<KB_HOME>/agent-workspace`,
    /// 其余是各自知识库目录下的 `agent-workspace`。
    pub fn agent_workspace(&self) -> &Path {
        &self.workspace_dir
    }
    /// `<KB_HOME>/backups`:手动备份归档的落盘目录(设置页「备份」分区)。
    pub fn backups_dir(&self) -> &Path {
        &self.backups_dir
    }
    /// `<KB_HOME>/avatars`:用户头像。头像别人也要看(好友列表、协作光标),所以是全站共有的,
    /// 不跟着某个知识库走:`with_space` 不会改它。
    pub fn avatars_dir(&self) -> &Path {
        &self.avatars_dir
    }
    /// `<KB_HOME>/exports`:个人数据导出生成的压缩包(24 小时后自动删除)。
    /// 全站共有、文件名里带用户 id;不跟着某个知识库走,`with_space` 不会改它。
    pub fn exports_dir(&self) -> &Path {
        &self.exports_dir
    }
    /// 某个上传的临时目录(`<KB_HOME>/uploads/<id>`)。
    pub fn upload_dir(&self, id: &str) -> PathBuf {
        self.uploads_dir.join(id)
    }
    /// `<KB_HOME>/lang/jieba/default`(jieba 词典目录)
    pub fn jieba_dir(&self) -> PathBuf {
        self.lang_dir.join("jieba").join("default")
    }
}

/// 用户主目录(读 `HOME`;测试用 `KB_HOME` 时不会走到这里)。
pub fn home_dir() -> Result<PathBuf> {
    match std::env::var_os("HOME") {
        Some(home) if !home.is_empty() => Ok(PathBuf::from(home)),
        _ => Err(KbError::Internal(
            "无法确定用户主目录:环境变量 HOME 未设置".to_owned(),
        )),
    }
}

/// 未设置 `KB_HOME` 时的默认根目录:`~/.kb`。
pub fn default_home() -> Result<PathBuf> {
    Ok(home_dir()?.join(HOME_DIR_NAME))
}

/// 展开路径开头的 `~`(只处理 `~` 与 `~/...`;`~user` 形式不支持,原样返回)。
pub fn expand_tilde(path: &str) -> Result<PathBuf> {
    Ok(expand_tilde_with(path, &home_dir()?))
}

/// [`expand_tilde`] 的可注入版本:用给定的主目录展开,便于测试。
pub fn expand_tilde_with(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

fn expand_tilde_os(raw: &OsString) -> Result<PathBuf> {
    let text = raw
        .to_str()
        .ok_or_else(|| KbError::InvalidInput("KB_HOME 不是合法的 UTF-8 路径".to_owned()))?;
    expand_tilde(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_home_derives_every_path_under_home() {
        let paths = KbPaths::from_home("/tmp/kb-home-test");
        let home = paths.home();
        assert_eq!(home, Path::new("/tmp/kb-home-test"));
        for path in [
            paths.config_file(),
            paths.secrets_file(),
            paths.meta_db(),
            paths.lance_dir(),
            paths.lang_dir(),
            paths.models_dir(),
            paths.bin_dir(),
            paths.run_dir(),
            paths.socket(),
            paths.pid_file(),
            paths.lock_file(),
            paths.logs_dir(),
            paths.skills_dir(),
            paths.eval_dir(),
            paths.sources_dir(),
            paths.uploads_dir(),
            paths.backups_dir(),
            paths.avatars_dir(),
            paths.exports_dir(),
            &paths.source_dir("src1"),
            &paths.upload_dir("up1"),
            &paths.jieba_dir(),
        ] {
            assert!(
                path.starts_with(home),
                "{} 不在 KB_HOME 之下",
                path.display()
            );
        }
        assert_eq!(paths.socket(), Path::new("/tmp/kb-home-test/run/kb.sock"));
        assert_eq!(paths.meta_db(), Path::new("/tmp/kb-home-test/meta.db"));
        assert_eq!(
            paths.source_dir("abc"),
            Path::new("/tmp/kb-home-test/sources/abc")
        );
        assert_eq!(
            paths.upload_dir("abc"),
            Path::new("/tmp/kb-home-test/uploads/abc")
        );
        assert_eq!(
            paths.jieba_dir(),
            Path::new("/tmp/kb-home-test/lang/jieba/default")
        );
    }

    #[test]
    fn kb_home_env_overrides_all_default_paths() {
        let paths = KbPaths::from_env_value(Some(OsString::from("/tmp/kb-home-env")))
            .expect("resolve KB_HOME");
        assert_eq!(paths.home(), Path::new("/tmp/kb-home-env"));
        // 验收要求:socket / models_dir / lang 等默认路径全部落在 KB_HOME 之下
        for path in [
            paths.socket(),
            paths.models_dir(),
            paths.lang_dir(),
            paths.meta_db(),
            paths.lance_dir(),
            paths.logs_dir(),
            paths.config_file(),
            paths.secrets_file(),
            paths.run_dir(),
            paths.lock_file(),
        ] {
            assert!(
                path.starts_with("/tmp/kb-home-env"),
                "{} 越界",
                path.display()
            );
        }
    }

    #[test]
    fn empty_kb_home_falls_back_to_default_home() {
        let unset = KbPaths::from_env_value(None).expect("unset KB_HOME");
        let empty = KbPaths::from_env_value(Some(OsString::new())).expect("empty KB_HOME");
        assert_eq!(unset, empty);
        assert!(unset.home().ends_with(HOME_DIR_NAME));
    }

    #[test]
    fn tilde_is_expanded() {
        let home = Path::new("/home/tester");
        assert_eq!(expand_tilde_with("~", home), PathBuf::from("/home/tester"));
        assert_eq!(
            expand_tilde_with("~/models", home),
            PathBuf::from("/home/tester/models")
        );
        assert_eq!(
            expand_tilde_with("/abs/models", home),
            PathBuf::from("/abs/models")
        );
        assert_eq!(
            expand_tilde_with("relative/dir", home),
            PathBuf::from("relative/dir")
        );
        // `~user` 形式不支持,原样返回
        assert_eq!(
            expand_tilde_with("~other/x", home),
            PathBuf::from("~other/x")
        );
    }

    #[test]
    fn tilde_expansion_uses_real_home() {
        let expanded = expand_tilde("~/kb-models").expect("expand ~");
        assert_eq!(expanded, home_dir().expect("HOME").join("kb-models"));
    }

    #[test]
    fn kb_home_with_tilde_is_expanded() {
        let paths =
            KbPaths::from_env_value(Some(OsString::from("~/kb-alt"))).expect("resolve ~/kb-alt");
        assert_eq!(paths.home(), home_dir().expect("HOME").join("kb-alt"));
    }

    #[test]
    fn config_overrides_models_dir_and_socket() {
        let mut config = Config::default();
        let base = KbPaths::from_home("/tmp/kb-home-cfg");
        // 空值 = 保持默认
        let same = base
            .clone()
            .with_config(&config)
            .expect("empty overrides are no-ops");
        assert_eq!(same, base);

        config.paths.models_dir = "/opt/kb-models".to_owned();
        config.server.socket = "~/kb-alt.sock".to_owned();
        let paths = base.with_config(&config).expect("apply overrides");
        assert_eq!(paths.models_dir(), Path::new("/opt/kb-models"));
        assert_eq!(
            paths.socket(),
            home_dir().expect("HOME").join("kb-alt.sock")
        );
        // 未覆盖的项仍然跟着 KB_HOME
        assert_eq!(paths.lang_dir(), Path::new("/tmp/kb-home-cfg/lang"));
    }

    #[test]
    fn ensure_dirs_creates_layout() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = KbPaths::from_home(dir.path().join("kb"));
        paths.ensure_dirs().expect("create dirs");
        assert!(paths.jieba_dir().is_dir());
        assert!(paths.run_dir().is_dir());
        assert!(paths.logs_dir().is_dir());
        assert!(paths.models_dir().is_dir());
        assert!(paths.sources_dir().is_dir(), "sources 目录应被创建");
        assert!(paths.uploads_dir().is_dir(), "uploads 目录应被创建");
        assert!(paths.backups_dir().is_dir(), "backups 目录应被创建");
        assert!(paths.avatars_dir().is_dir(), "avatars 目录应被创建");
        assert!(paths.exports_dir().is_dir(), "exports 目录应被创建");
        // 幂等
        paths.ensure_dirs().expect("second call is a no-op");
    }

    #[test]
    fn space_paths_only_move_the_per_space_parts() {
        let root = KbPaths::from_home("/data/kb");
        let space = root.for_space("sp_alice").unwrap();
        assert_eq!(
            space.meta_db(),
            Path::new("/data/kb/spaces/sp_alice/meta.db")
        );
        assert_eq!(
            space.lance_dir(),
            Path::new("/data/kb/spaces/sp_alice/lance")
        );
        assert_eq!(
            space.sources_dir(),
            Path::new("/data/kb/spaces/sp_alice/sources")
        );
        assert_eq!(
            space.uploads_dir(),
            Path::new("/data/kb/spaces/sp_alice/uploads")
        );
        // 评测的黄金集和历次结果是每个人自己的(放在共用目录里别人的评测全站可见)
        assert_eq!(space.eval_dir(), Path::new("/data/kb/spaces/sp_alice/eval"));
        assert_eq!(root.eval_dir(), Path::new("/data/kb/eval"));
        // 全局部分不动
        assert_eq!(space.home(), root.home());
        assert_eq!(space.config_file(), root.config_file());
        assert_eq!(space.models_dir(), root.models_dir());
        assert_eq!(space.socket(), root.socket());
        // 头像是全站共有的:alice 的知识库路径不能把头像目录带到她自己的目录里
        assert_eq!(space.avatars_dir(), root.avatars_dir());
        assert_eq!(root.avatars_dir(), Path::new("/data/kb/avatars"));
        assert_eq!(space.exports_dir(), root.exports_dir());
        assert_eq!(root.exports_dir(), Path::new("/data/kb/exports"));
        assert_eq!(root.system_db(), Path::new("/data/kb/system.db"));
    }

    #[test]
    fn the_primary_space_is_the_home_root() {
        let root = KbPaths::from_home("/data/kb");
        let primary = root.for_space(crate::account::PRIMARY_SPACE_ID).unwrap();
        assert_eq!(primary, root, "主知识库不做任何路径覆盖,数据不用搬家");
        assert_eq!(root.space_dir("sp_primary").unwrap(), Path::new("/data/kb"));
        assert_eq!(primary.meta_db(), Path::new("/data/kb/meta.db"));
        assert_ne!(
            root.for_space("sp_other").unwrap().meta_db(),
            primary.meta_db(),
            "别的用户不能解析到主知识库"
        );
    }

    #[test]
    fn space_ids_cannot_escape_the_spaces_dir() {
        let root = KbPaths::from_home("/data/kb");
        for bad in [
            "",
            "sp_",
            "alice",
            "sp_../etc",
            "sp_a/b",
            "sp_A",
            "../sp_x",
            "sp_a b",
        ] {
            assert!(root.space_dir(bad).is_err(), "应拒绝:{bad:?}");
        }
        assert!(root.space_dir("sp_0194a1b2c3d4").is_ok());
    }

    #[test]
    fn legacy_layout_means_meta_db_without_system_db() {
        let dir = tempfile::tempdir().unwrap();
        let paths = KbPaths::from_home(dir.path());
        assert!(!paths.is_legacy_layout(), "空目录不是旧布局");
        std::fs::write(paths.meta_db(), b"").unwrap();
        assert!(paths.is_legacy_layout());
        std::fs::write(paths.system_db(), b"").unwrap();
        assert!(!paths.is_legacy_layout(), "两个都有就是已迁移");
    }
}
