//! 项目注册与管理。
//!
//! 项目名转 slug:小写,非 `[a-z0-9]` 字符替换为 `_`;每个项目对应一个 `proj_<slug>` collection。

use std::path::Path;
use std::sync::Arc;

use kb_core::ids::project_slug;
use kb_core::model::{Millis, Project};
use kb_core::ports::repo::{CollectionRepo, MetaStore, ProjectRepo};
use kb_core::ports::{Embedder, VectorStore};
use kb_core::{KbError, Result};

use crate::collections::{CollectionInfo, CollectionService};

/// 项目摘要(列表 / 详情用)。
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ProjectInfo {
    /// 项目本体。
    pub project: Project,
    /// 对应的 collection。
    pub collection: String,
    /// 已索引的块数。
    pub rows: u64,
    /// 可浏览的条目数(文件 + 笔记)。
    pub items: u64,
}

/// 修改项目时要改的字段(「编辑项目」)。
#[derive(Clone, Debug, Default)]
pub struct ProjectPatch {
    /// 只索引这些 glob(空 = 全部)。
    pub include: Option<Vec<String>>,
    /// 排除的 glob。
    pub exclude: Option<Vec<String>>,
    /// 是否允许把内容发给云端 LLM。
    pub allow_cloud_llm: Option<bool>,
    /// 是否开启自动提炼。
    pub extract_enabled: Option<bool>,
}

/// 项目服务。
pub struct ProjectService {
    meta: Arc<dyn MetaStore>,
    collections: CollectionService,
}

impl ProjectService {
    /// 用注入的端口构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn Embedder>,
    ) -> Self {
        let collections = CollectionService::new(meta.clone(), store, embedder);
        Self { meta, collections }
    }

    /// 注册一个项目(同时创建 collection)。
    pub async fn add(&self, path: impl AsRef<Path>, name: Option<&str>) -> Result<Project> {
        let path = path.as_ref();
        let canonical = std::fs::canonicalize(path).map_err(|err| {
            KbError::InvalidInput(format!("项目目录 {} 不可用: {err}", path.display()))
        })?;
        if !canonical.is_dir() {
            return Err(KbError::InvalidInput(format!(
                "{} 不是目录",
                canonical.display()
            )));
        }
        let root_path = canonical.to_string_lossy().into_owned();
        let name = match name {
            Some(name) => name.to_owned(),
            None => canonical
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .ok_or_else(|| KbError::InvalidInput("无法从路径推导项目名".to_owned()))?,
        };
        if let Some(existing) = ProjectRepo::get_by_name(self.meta.as_ref(), &name).await? {
            if existing.root_path == root_path {
                // 幂等注册:collection 被单独删掉过(Web 端的「删除集合」)时要补建,
                // 否则项目会卡在“有项目、没集合、索引永远失败”的状态。
                let collection_name = format!("proj_{}", existing.slug);
                if CollectionRepo::get(self.meta.as_ref(), &collection_name)
                    .await?
                    .is_none()
                {
                    self.collections
                        .create_for_project(&existing.id, &existing.name)
                        .await?;
                    tracing::info!(
                        project = %existing.name,
                        collection = %collection_name,
                        "项目已存在但 collection 缺失,已补建"
                    );
                }
                return Ok(existing);
            }
            return Err(KbError::InvalidInput(format!(
                "项目名 {name} 已被 {} 占用",
                existing.root_path
            )));
        }
        let slug = project_slug(&name);
        if slug.is_empty() {
            return Err(KbError::InvalidInput(format!(
                "项目名 {name} 无法转换成 slug"
            )));
        }
        // 登记时就用与 `list` / `show` 相同的口径(`Repository::discover`,会向上找父目录):
        // 只看 `<根>/.git` 的话,仓库子目录里的项目先记成 false,要等第一次 `list` 才被改回 true,
        // 这段时间里界面上「提交后自动索引」开关是灰的。discover 要走文件系统,放进阻塞线程池。
        let probe_root = root_path.clone();
        let is_git = match tokio::task::spawn_blocking(move || probe_is_git(&probe_root)).await {
            Ok(actual) => actual,
            Err(err) => {
                // 与 `with_live_git` 一样不因探测失败拖垮登记:先记 false,下一次 `list` / `show` 会按现状重算
                tracing::warn!(project = %name, error = %err, "判断项目是否 git 仓库失败,先记为非 git");
                false
            }
        };
        let project = Project {
            id: uuid::Uuid::now_v7().to_string(),
            name,
            slug,
            root_path,
            include: Vec::new(),
            exclude: Vec::new(),
            is_git,
            last_commit: None,
            last_indexed_at: None,
            allow_cloud_llm: false,
            extract_enabled: false,
            hooks_installed: false,
            created_at: now_millis(),
        };
        ProjectRepo::create(self.meta.as_ref(), project.clone()).await?;
        if let Err(err) = self
            .collections
            .create_for_project(&project.id, &project.name)
            .await
        {
            // 回滚项目行,避免留下没有 collection 的项目
            if let Err(rollback) = ProjectRepo::delete(self.meta.as_ref(), &project.id).await {
                tracing::warn!(error = %rollback, "回滚项目行失败");
            }
            return Err(err);
        }
        Ok(project)
    }

    /// 按磁盘现状重算 `is_git`,与库里不同时顺手写回。
    ///
    /// `projects.is_git` 只在 `add` 时写一次,项目登记之后才 `git init`(或删掉 `.git`)的目录会一直显示旧值,
    /// 界面据此决定「提交后自动索引」开关能不能点,所以读的时候要按现状重算。
    /// 写回失败只记 warn:读接口不能因为一次写库失败而整个报错,下次读还会重算。
    async fn with_live_git(&self, mut project: Project) -> Project {
        let root = project.root_path.clone();
        // discover 要走文件系统(还会向上找父目录),放进阻塞线程池,不占异步执行线程
        let actual = match tokio::task::spawn_blocking(move || probe_is_git(&root)).await {
            Ok(actual) => actual,
            Err(err) => {
                tracing::warn!(project = %project.name, error = %err, "判断项目是否 git 仓库失败,沿用库里的值");
                return project;
            }
        };
        if actual == project.is_git {
            return project;
        }
        project.is_git = actual;
        // 写回前重新读一行再只改 is_git:`ProjectRepo::update` 是整行覆盖,
        // 直接拿列表时读到的快照写回,会把这段时间里索引任务刚更新的 last_commit / last_indexed_at 冲回旧值
        match ProjectRepo::get(self.meta.as_ref(), &project.id).await {
            Ok(Some(mut fresh)) if fresh.is_git != actual => {
                fresh.is_git = actual;
                if let Err(err) = ProjectRepo::update(self.meta.as_ref(), fresh).await {
                    tracing::warn!(project = %project.name, error = %err, "写回 is_git 失败");
                }
            }
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(project = %project.name, error = %err, "写回 is_git 前重新读取项目失败");
            }
        }
        project
    }

    /// 列出全部项目。
    pub async fn list(&self) -> Result<Vec<ProjectInfo>> {
        let projects = ProjectRepo::list(self.meta.as_ref()).await?;
        let collections = self.collections.list().await?;
        let mut infos = Vec::with_capacity(projects.len());
        for project in projects {
            let project = self.with_live_git(project).await;
            let collection = format!("proj_{}", project.slug);
            let found = collections.iter().find(|info| info.name == collection);
            let (rows, items) = found.map_or((0, 0), |info| (info.rows, info.items));
            infos.push(ProjectInfo {
                project,
                collection,
                rows,
                items,
            });
        }
        Ok(infos)
    }

    /// 按名字或 slug 找项目。
    pub async fn resolve(&self, name: &str) -> Result<Project> {
        if let Some(project) = ProjectRepo::get_by_name(self.meta.as_ref(), name).await? {
            return Ok(project);
        }
        let projects = ProjectRepo::list(self.meta.as_ref()).await?;
        let slug = project_slug(name);
        projects
            .into_iter()
            .find(|project| project.slug == slug)
            .ok_or_else(|| KbError::NotFound(format!("project {name}")))
    }

    /// 项目详情。
    pub async fn show(&self, name: &str) -> Result<ProjectInfo> {
        let project = self.resolve(name).await?;
        let project = self.with_live_git(project).await;
        let collection = format!("proj_{}", project.slug);
        let found = self
            .collections
            .list()
            .await?
            .into_iter()
            .find(|info| info.name == collection);
        let (rows, items) = found.map_or((0, 0), |info| (info.rows, info.items));
        Ok(ProjectInfo {
            project,
            collection,
            rows,
            items,
        })
    }

    /// 修改项目的扫描 / 提炼配置。
    ///
    /// 只改给出的字段;include / exclude 会在下一次索引时生效(不会自动重扫,由调用方决定是否
    /// 投递 `reindex_project`)。名字与根目录不可改:改根目录等价于换一个项目。
    pub async fn update(&self, name: &str, patch: ProjectPatch) -> Result<Project> {
        let mut project = self.resolve(name).await?;
        if let Some(include) = patch.include {
            project.include = include
                .into_iter()
                .map(|item| item.trim().to_owned())
                .filter(|item| !item.is_empty())
                .collect();
        }
        if let Some(exclude) = patch.exclude {
            project.exclude = exclude
                .into_iter()
                .map(|item| item.trim().to_owned())
                .filter(|item| !item.is_empty())
                .collect();
        }
        if let Some(value) = patch.allow_cloud_llm {
            project.allow_cloud_llm = value;
        }
        if let Some(value) = patch.extract_enabled {
            project.extract_enabled = value;
        }
        ProjectRepo::update(self.meta.as_ref(), project.clone()).await?;
        Ok(project)
    }

    /// 移除项目(级联删除 collection 与物理表)。
    ///
    /// collection 已经被单独删掉(Web 端的「删除集合」)时也要能把项目行删掉,
    /// 否则这个项目既不能索引也不能移除。
    pub async fn remove(&self, name: &str) -> Result<()> {
        let project = self.resolve(name).await?;
        let collection_name = format!("proj_{}", project.slug);
        match self.collections.delete(&collection_name).await {
            Ok(()) => {}
            Err(KbError::NotFound(_)) => {
                tracing::warn!(
                    project = %project.name,
                    collection = %collection_name,
                    "项目对应的 collection 已不存在,继续删除项目行"
                );
                // 没有 collection 行时,派生数据也可能是历史遗留,顺手清一次
                CollectionRepo::purge_data(self.meta.as_ref(), &collection_name).await?;
            }
            Err(err) => return Err(err),
        }
        ProjectRepo::delete(self.meta.as_ref(), &project.id).await
    }

    /// 列出 collection(给 `kb collection list` 之类用)。
    pub async fn collections(&self) -> Result<Vec<CollectionInfo>> {
        self.collections.list().await
    }
}

/// 目录现在是不是 git 仓库。
///
/// 与 `HookManager::open` 同一口径(`Repository::discover`,会向上找父目录):
/// 界面上「能不能装提交钩子」和点下去之后后端的判断必须一致,否则会出现开关可点却报「不是 git 仓库」。
fn probe_is_git(root: &str) -> bool {
    git2::Repository::discover(root).is_ok()
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
