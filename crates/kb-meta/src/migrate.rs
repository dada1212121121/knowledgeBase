//! 迁移:按 `PRAGMA user_version` 顺序执行 `migrations/NNNN_*.sql`。
//!
//! 每个脚本在一个事务里执行,执行成功后把 `user_version` 更新到该脚本的版本号,
//! 因此重复执行是幂等的（设计规范）。

use kb_core::{KbError, Result};
use rusqlite::Connection;

use crate::sql::map_sqlite_error;

/// 内置迁移脚本:(版本号, SQL)。新增迁移时在末尾追加。
pub const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../migrations/0001_init.sql")),
    // :数据源与上传(sources / uploads / upload_parts / ingest_files)
    (2, include_str!("../migrations/0002_sources_uploads.sql")),
    // :流水线进度(ingest_stage_events / ingest_batches;ingest_files 加 skipped)
    (3, include_str!("../migrations/0003_ingest_progress.sql")),
    // :文本类在线编辑的版本历史(item_versions)
    (4, include_str!("../migrations/0004_item_versions.sql")),
    // :批注(anchored annotations)
    (5, include_str!("../migrations/0005_annotations.sql")),
    // :自动提炼的指纹去重与排除表(drafts 加列 + evolution_exclusions)
    (6, include_str!("../migrations/0006_evolution.sql")),
    // 解析队列的「内容」列(ingest_files 加 extract_meta)
    (7, include_str!("../migrations/0007_ingest_meta.sql")),
    // 收尾:草稿记住关联文件(drafts 加 related_paths_json)
    (8, include_str!("../migrations/0008_draft_paths.sql")),
    // 收尾:把旧实现留下的“approved 但没有 insight_id”的草稿放回收件箱
    (9, include_str!("../migrations/0009_draft_pending_fix.sql")),
    // 审核收件箱的抢占标记(并发通过时只让一个请求转正)
    (10, include_str!("../migrations/0010_draft_claim.sql")),
    // 会话事件按 kind 查的索引
    (11, include_str!("../migrations/0011_events_by_kind.sql")),
    // :派生来源(ingest_files 加 derived_from,重启后仍能补派生边)
    (12, include_str!("../migrations/0012_ingest_derived.sql")),
    // 管家会话元数据:标题 / 所属项目 / 置顶
    (13, include_str!("../migrations/0013_agent_sessions.sql")),
    // 管家:ACP 后端 + 上下文压缩摘要
    (
        14,
        include_str!("../migrations/0014_agent_acp_and_summary.sql"),
    ),
    // ACP 会话是否真的跑在沙箱里
    (15, include_str!("../migrations/0015_agent_sandboxed.sql")),
    // :多人在线编辑的协作状态(快照 + 增量更新)
    (16, include_str!("../migrations/0016_collab.sql")),
    (
        17,
        include_str!("../migrations/0017_annotation_threads.sql"),
    ),
    // 慢查询索引:任务按创建时间、insights 按 collection / 创建时间
    (18, include_str!("../migrations/0018_query_indexes.sql")),
    // AI 对文档的修改建议
    (19, include_str!("../migrations/0019_edit_proposals.sql")),
    // 审计补「耗时」与「降级原因」:线上才能回答「哪条查询慢 / 降级率多少」
    (20, include_str!("../migrations/0020_audit_duration.sql")),
    // :文件删除 / 移动流水、回收站、同步排除标记
    (21, include_str!("../migrations/0021_file_ops.sql")),
    // 跨知识库移动:流水记录目标 collection
    (
        22,
        include_str!("../migrations/0022_file_op_target_collection.sql"),
    ),
    // :文档链接图谱(反向链接、删除 / 移动影响提示、分享附带引用文件)
    (23, include_str!("../migrations/0023_doc_links.sql")),
    // :网页来源的 AI 规范化开关、提取要求与最近一次的整理情况
    // (分支上编号 0019,合进 master 时 0019~0023 已被占用,顺延为 0024)
    (24, include_str!("../migrations/0024_source_ai_extract.sql")),
    // 任务详情「改动的文件」:逐文件的写入块数 / 失败原因(不塞进检查点)
    (25, include_str!("../migrations/0025_job_files.sql")),
    // 文本优先索引:待补向量的块队列
    (26, include_str!("../migrations/0026_pending_embeds.sql")),
];

/// 当前 schema 版本。
pub fn current_version(conn: &Connection) -> Result<i64> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(map_sqlite_error)
}

/// 执行所有未应用的迁移,返回最终版本。连续调用是幂等的。
pub fn run(conn: &mut Connection) -> Result<i64> {
    let mut version = current_version(conn)?;
    for (target, sql) in MIGRATIONS {
        if *target <= version {
            continue;
        }
        let tx = conn.transaction().map_err(map_sqlite_error)?;
        tx.execute_batch(sql).map_err(map_sqlite_error)?;
        tx.pragma_update(None, "user_version", *target)
            .map_err(map_sqlite_error)?;
        tx.commit().map_err(map_sqlite_error)?;
        version = *target;
    }
    if version == 0 {
        return Err(KbError::Internal(
            "没有可用的迁移脚本:数据库版本仍为 0".to_owned(),
        ));
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_ordered_and_start_at_one() {
        assert_eq!(MIGRATIONS.first().map(|(v, _)| *v), Some(1));
        let mut previous = 0;
        for (version, sql) in MIGRATIONS {
            assert!(*version > previous, "迁移版本必须递增");
            assert!(!sql.trim().is_empty(), "迁移脚本不能为空");
            previous = *version;
        }
    }

    #[test]
    fn run_is_idempotent() {
        let mut conn = Connection::open_in_memory().expect("内存库");
        assert_eq!(current_version(&conn).expect("版本"), 0);
        let first = run(&mut conn).expect("首次迁移");
        assert_eq!(first, MIGRATIONS.last().expect("有迁移").0);
        let second = run(&mut conn).expect("重复迁移");
        assert_eq!(second, first);
        // 表确实存在
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'",
                [],
                |row| row.get(0),
            )
            .expect("统计表");
        assert!(
            count >= 24,
            "迁移应建出全部表(0001 的 18 张 + 0002 的 4 张 + 0003 的 2 张),实际 {count}"
        );
    }

    #[test]
    fn existing_sources_get_ai_extract_off() {
        // :升级前就有的数据源不能因为加了列就开始调用模型、花 AI 额度
        let mut conn = Connection::open_in_memory().expect("内存库");
        for (target, sql) in MIGRATIONS.iter().filter(|(version, _)| *version <= 18) {
            conn.execute_batch(sql).expect("旧迁移");
            conn.pragma_update(None, "user_version", *target)
                .expect("版本");
        }
        conn.execute(
            "INSERT INTO collections (name, kind, embedder_id, dim, active_table, created_at) \
             VALUES ('_global', 'global', 'fake', 8, '_global__v1', 1)",
            [],
        )
        .expect("建 collection");
        conn.execute(
            "INSERT INTO sources (id, kind, name, uri, collection, created_at) \
             VALUES ('s1', 'web', '旧站点', 'https://a.example', '_global', 1)",
            [],
        )
        .expect("旧数据源");
        assert_eq!(
            run(&mut conn).expect("升级"),
            MIGRATIONS.last().expect("有迁移").0
        );
        let (ai_extract, prompt, status): (i64, String, Option<String>) = conn
            .query_row(
                "SELECT ai_extract, extract_prompt, ai_status_json FROM sources WHERE id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("读新列");
        assert_eq!(ai_extract, 0);
        assert_eq!(prompt, "");
        assert_eq!(status, None);
    }
}
