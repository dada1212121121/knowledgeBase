//! 多用户测试夹具(设计规范 .4)。
//!
//! 先把**磁盘布局**当成契约固定下来(多用户设计说明), 的 `SpaceRegistry`、
//! 越权矩阵测试都建立在它上面:
//!
//! ```text
//! <home>/system.db 账号、角色、授权、分享链接(起由 SystemStore 创建)
//! <home>/spaces/<space_id>/meta.db    每个用户一份,和今天的 meta.db 同构
//! <home>/spaces/<space_id>/lance/     每个用户自己的向量库
//! ```
//!
//! 现在的 [`TestWorld`] 只负责「给每个用户一个互相独立的存储」,`system.db` 路径先占位。
//! 把布局搬进 `kb-core` 的 `KbPaths` 之后,本模块改成调用真实实现,测试用例不用改:
//! 用例里只出现 `world.space("alice")` 这样的写法。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use kb_core::model::{
    Collection, CollectionKind, ContextMode, Insight, InsightKind, ItemStatus, Page,
};
use kb_core::paths::KbPaths;
use kb_core::ports::repo::{CollectionRepo, InsightRepo, MetaStore};
use kb_core::ports::{Embedder, VectorStore};
use kb_embed::FakeEmbedder;
use kb_meta::SqliteMetaStore;
use kb_store_lance::LanceStore;
use tempfile::TempDir;

/// 固定的测试时间戳,保证用例确定性。
const NOW: i64 = 1_700_000_000_000;

/// 一个测试用户。id 稳定可预测(`usr_<name>` / `sp_<name>`),失败信息一眼能看出是谁。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TestUser {
    /// 用户名(也是 [`TestWorld::space`] 的查找键)。
    pub name: String,
    /// 用户 id。
    pub id: String,
    /// 该用户的个人知识库 id。
    pub space_id: String,
}

impl TestUser {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_owned(),
            id: format!("usr_{name}"),
            space_id: format!("sp_{name}"),
        }
    }
}

/// 一个用户的知识库存储:自己的 SQLite、自己的 LanceDB、自己的假嵌入器。
pub struct SpaceEnv {
    /// 这个知识库的主人。
    pub user: TestUser,
    root: PathBuf,
    /// 元数据存储(`<root>/meta.db`)。
    pub meta: Arc<dyn MetaStore>,
    /// 向量存储(`<root>/lance`)。
    pub store: Arc<dyn VectorStore>,
    /// 假嵌入器的端口视图。
    pub embedder: Arc<dyn Embedder>,
    /// 同一个假嵌入器的具体类型,便于断言嵌入次数。
    pub fake: Arc<FakeEmbedder>,
}

impl SpaceEnv {
    async fn open(user: TestUser, root: PathBuf, dim: usize) -> Self {
        std::fs::create_dir_all(&root).expect("创建知识库目录");
        let meta: Arc<dyn MetaStore> =
            Arc::new(SqliteMetaStore::open(root.join("meta.db")).expect("打开 meta.db"));
        let store: Arc<dyn VectorStore> = Arc::new(
            LanceStore::connect(root.join("lance").to_string_lossy().to_string())
                .await
                .expect("连接 LanceDB"),
        );
        let fake = Arc::new(FakeEmbedder::new(dim));
        let embedder: Arc<dyn Embedder> = fake.clone();
        Self {
            user,
            root,
            meta,
            store,
            embedder,
            fake,
        }
    }

    /// 知识库根目录(`<home>/spaces/<space_id>`)。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 以这个知识库为 `KB_HOME` 的路径集合:现有只认 `KbPaths` 的服务可以直接指向它。
    pub fn paths(&self) -> KbPaths {
        KbPaths::from_home(&self.root)
    }

    /// 确保集合存在后写入一条笔记,返回笔记 id。
    pub async fn seed_note(&self, collection: &str, title: &str) -> String {
        if CollectionRepo::get(&*self.meta, collection)
            .await
            .expect("查询集合")
            .is_none()
        {
            let created = Collection {
                name: collection.to_owned(),
                kind: if collection == "_global" {
                    CollectionKind::Global
                } else {
                    CollectionKind::Project
                },
                project_id: None,
                embedder_id: self.embedder.id().to_owned(),
                dim: self.embedder.dim(),
                active_table: format!("{collection}__fake__v1"),
                table_version: 1,
                migrating_to: None,
                migration_started_at: None,
                retired_tables: Vec::new(),
                context_mode: ContextMode::Header,
                created_at: NOW,
            };
            CollectionRepo::create(&*self.meta, created)
                .await
                .expect("建集合");
        }
        let id = format!("ins_{}_{}", self.user.name, title);
        let insight = Insight {
            id: id.clone(),
            collection: collection.to_owned(),
            title: title.to_owned(),
            body_md: format!("{} 的笔记:{title}", self.user.name),
            kind: InsightKind::Note,
            tags: Vec::new(),
            related_paths: Vec::new(),
            status: ItemStatus::Active,
            version: 1,
            valid_from: NOW,
            valid_until: None,
            superseded_by: None,
            created_by: self.user.id.clone(),
            batch_id: None,
            created_at: NOW,
            updated_at: NOW,
        };
        InsightRepo::create(&*self.meta, insight)
            .await
            .expect("写笔记");
        id
    }

    /// 集合里全部笔记的标题。
    pub async fn titles(&self, collection: &str) -> Vec<String> {
        let page = Page {
            limit: 1000,
            offset: 0,
        };
        let mut titles: Vec<String> = InsightRepo::list(&*self.meta, collection, None, page)
            .await
            .expect("列笔记")
            .into_iter()
            .map(|insight| insight.title)
            .collect();
        titles.sort();
        titles
    }

    /// 笔记 id 是否存在于本知识库。
    pub async fn has_note(&self, id: &str) -> bool {
        InsightRepo::get(&*self.meta, id)
            .await
            .expect("查笔记")
            .is_some()
    }
}

/// 多用户测试世界:一个临时 `KB_HOME`,每个用户一个互相独立的知识库。
pub struct TestWorld {
    home: TempDir,
    spaces: Vec<SpaceEnv>,
}

impl TestWorld {
    /// 按用户名建出全部用户及其知识库(8 维假向量)。
    pub async fn new(names: &[&str]) -> Self {
        let home = tempfile::tempdir().expect("创建临时目录");
        let mut spaces = Vec::with_capacity(names.len());
        for name in names {
            assert!(
                spaces
                    .iter()
                    .all(|space: &SpaceEnv| space.user.name != *name),
                "测试用户重名:{name}"
            );
            let user = TestUser::new(name);
            let root = home.path().join("spaces").join(&user.space_id);
            spaces.push(SpaceEnv::open(user, root, 8).await);
        }
        Self { home, spaces }
    }

    /// 临时 `KB_HOME`。
    pub fn home(&self) -> &Path {
        self.home.path()
    }

    /// `system.db` 的位置(起由 `SystemStore` 创建;现在只是约定路径)。
    pub fn system_db_path(&self) -> PathBuf {
        self.home.path().join("system.db")
    }

    /// 按用户名取知识库;名字不存在直接 panic,避免用例里的拼写错误被当成「没有数据」。
    pub fn space(&self, name: &str) -> &SpaceEnv {
        self.spaces
            .iter()
            .find(|space| space.user.name == name)
            .unwrap_or_else(|| panic!("没有这个测试用户:{name}"))
    }

    /// 全部知识库。
    pub fn spaces(&self) -> &[SpaceEnv] {
        &self.spaces
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn every_user_gets_a_separate_space_directory() {
        let world = TestWorld::new(&["alice", "bob"]).await;
        let alice = world.space("alice");
        let bob = world.space("bob");
        assert_eq!(alice.user.space_id, "sp_alice");
        assert!(alice.root().ends_with("spaces/sp_alice"));
        assert!(bob.root().ends_with("spaces/sp_bob"));
        assert_ne!(alice.root(), bob.root());
        for space in world.spaces() {
            assert!(
                space.root().join("meta.db").exists(),
                "每个知识库有自己的 meta.db"
            );
            assert!(
                space.root().join("lance").exists(),
                "每个知识库有自己的 lance 目录"
            );
        }
        // 全局库还没有:system.db 只是约定路径
        assert_eq!(world.system_db_path(), world.home().join("system.db"));
    }

    #[tokio::test]
    async fn notes_written_by_one_user_are_invisible_to_another() {
        let world = TestWorld::new(&["alice", "bob"]).await;
        let alice = world.space("alice");
        let bob = world.space("bob");
        let secret = alice.seed_note("_global", "Alice 的私密笔记").await;
        let other = bob.seed_note("_global", "Bob 的笔记").await;

        // 同名集合 `_global`,内容互不可见
        assert_eq!(alice.titles("_global").await, vec!["Alice 的私密笔记"]);
        assert_eq!(bob.titles("_global").await, vec!["Bob 的笔记"]);
        // 拿对方的 id 直接查也查不到:这是越权矩阵(.3)在存储层的基线
        assert!(alice.has_note(&secret).await);
        assert!(!bob.has_note(&secret).await);
        assert!(bob.has_note(&other).await);
        assert!(!alice.has_note(&other).await);
    }

    #[tokio::test]
    async fn space_paths_point_at_the_space_not_the_shared_home() {
        let world = TestWorld::new(&["alice"]).await;
        let space = world.space("alice");
        assert_eq!(space.paths().home(), space.root());
        assert_ne!(space.paths().home(), world.home());
    }

    #[tokio::test]
    #[should_panic(expected = "没有这个测试用户:carol")]
    async fn unknown_user_is_a_loud_error() {
        let world = TestWorld::new(&["alice"]).await;
        let _ = world.space("carol");
    }
}
