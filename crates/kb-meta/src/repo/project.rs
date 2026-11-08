//! `projects` 表。

use async_trait::async_trait;
use kb_core::model::Project;
use kb_core::ports::repo::ProjectRepo;
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::{bool_to_int, int_to_bool, json_to_vec, map_sqlite_error, vec_to_json};

const SELECT_COLUMNS: &str = "id, name, slug, root_path, include_json, exclude_json, is_git, \
     last_commit, last_indexed_at, allow_cloud_llm, extract_enabled, hooks_installed, created_at";

struct RawProject {
    id: String,
    name: String,
    slug: String,
    root_path: String,
    include_json: String,
    exclude_json: String,
    is_git: i64,
    last_commit: Option<String>,
    last_indexed_at: Option<i64>,
    allow_cloud_llm: i64,
    extract_enabled: i64,
    hooks_installed: i64,
    created_at: i64,
}

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawProject> {
    Ok(RawProject {
        id: row.get(0)?,
        name: row.get(1)?,
        slug: row.get(2)?,
        root_path: row.get(3)?,
        include_json: row.get(4)?,
        exclude_json: row.get(5)?,
        is_git: row.get(6)?,
        last_commit: row.get(7)?,
        last_indexed_at: row.get(8)?,
        allow_cloud_llm: row.get(9)?,
        extract_enabled: row.get(10)?,
        hooks_installed: row.get(11)?,
        created_at: row.get(12)?,
    })
}

impl RawProject {
    fn into_project(self) -> Result<Project> {
        Ok(Project {
            id: self.id,
            name: self.name,
            slug: self.slug,
            root_path: self.root_path,
            include: json_to_vec(&self.include_json)?,
            exclude: json_to_vec(&self.exclude_json)?,
            is_git: int_to_bool(self.is_git),
            last_commit: self.last_commit,
            last_indexed_at: self.last_indexed_at,
            allow_cloud_llm: int_to_bool(self.allow_cloud_llm),
            extract_enabled: int_to_bool(self.extract_enabled),
            hooks_installed: int_to_bool(self.hooks_installed),
            created_at: self.created_at,
        })
    }
}

#[async_trait]
impl ProjectRepo for SqliteMetaStore {
    async fn create(&self, project: Project) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO projects (id, name, slug, root_path, include_json, exclude_json, is_git, \
                 last_commit, last_indexed_at, allow_cloud_llm, extract_enabled, hooks_installed, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    project.id,
                    project.name,
                    project.slug,
                    project.root_path,
                    vec_to_json(&project.include),
                    vec_to_json(&project.exclude),
                    bool_to_int(project.is_git),
                    project.last_commit,
                    project.last_indexed_at,
                    bool_to_int(project.allow_cloud_llm),
                    bool_to_int(project.extract_enabled),
                    bool_to_int(project.hooks_installed),
                    project.created_at,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn get(&self, id: &str) -> Result<Option<Project>> {
        let id = id.to_owned();
        self.read(move |conn| {
            let raw = conn
                .query_row(
                    &format!("SELECT {SELECT_COLUMNS} FROM projects WHERE id = ?1"),
                    params![id],
                    raw_from_row,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            raw.map(RawProject::into_project).transpose()
        })
        .await
    }

    async fn get_by_name(&self, name: &str) -> Result<Option<Project>> {
        let name = name.to_owned();
        self.read(move |conn| {
            let raw = conn
                .query_row(
                    &format!("SELECT {SELECT_COLUMNS} FROM projects WHERE name = ?1"),
                    params![name],
                    raw_from_row,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            raw.map(RawProject::into_project).transpose()
        })
        .await
    }

    async fn list(&self) -> Result<Vec<Project>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM projects ORDER BY created_at, name"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map([], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(RawProject::into_project).collect()
        })
        .await
    }

    async fn update(&self, project: Project) -> Result<()> {
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE projects SET name = ?2, slug = ?3, root_path = ?4, include_json = ?5, \
                     exclude_json = ?6, is_git = ?7, last_commit = ?8, last_indexed_at = ?9, \
                     allow_cloud_llm = ?10, extract_enabled = ?11, hooks_installed = ?12 WHERE id = ?1",
                    params![
                        project.id,
                        project.name,
                        project.slug,
                        project.root_path,
                        vec_to_json(&project.include),
                        vec_to_json(&project.exclude),
                        bool_to_int(project.is_git),
                        project.last_commit,
                        project.last_indexed_at,
                        bool_to_int(project.allow_cloud_llm),
                        bool_to_int(project.extract_enabled),
                        bool_to_int(project.hooks_installed),
                    ],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("project {}", project.id)));
            }
            Ok(())
        })
        .await
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            let changed = conn
                .execute("DELETE FROM projects WHERE id = ?1", params![id])
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("project {id}")));
            }
            Ok(())
        })
        .await
    }

    async fn match_cwd(&self, path: &str) -> Result<Option<Project>> {
        let path = path.to_owned();
        self.read(move |conn| {
            // 最长前缀匹配:用 substr 比较,避免把路径拼进 LIKE 模式
            let raw = conn
                .query_row(
                    &format!(
                        "SELECT {SELECT_COLUMNS} FROM projects \
                         WHERE ?1 = root_path OR substr(?1, 1, length(root_path) + 1) = root_path || '/' \
                         ORDER BY length(root_path) DESC LIMIT 1"
                    ),
                    params![path],
                    raw_from_row,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            raw.map(RawProject::into_project).transpose()
        })
        .await
    }
}
