//! 认领任务必须是原子的(`JobRepo::claim_next`)。
//!
//! 后台现在会同时开好几条循环去抢任务(见 `jobs/worker.rs` 的 `run`)。分两步
//! (`next_runnable` 再 `update`)的话,两条循环会读到同一条 `queued`,各自把它跑一遍 ——
//! 一个文件被索引两次、另一条任务永远没人做。
//! 认领还负责把任务转成 `running`:交回去的必须是「已认领」的形状,否则调用方会把
//! `queued` 写回去,任务又变成可抢的(实测就是这样重复跑了一遍)。

use std::sync::Arc;

use kb_core::model::{Job, JobState};
use kb_core::ports::repo::JobRepo;
use kb_meta::SqliteMetaStore;

fn job(id: &str, created_at: i64) -> Job {
    Job {
        id: id.to_owned(),
        kind: "index".to_owned(),
        collection: Some("proj_demo".to_owned()),
        priority: 20,
        state: JobState::Queued,
        payload_json: "{}".to_owned(),
        checkpoint_json: None,
        detail: None,
        progress_done: 0,
        progress_total: None,
        rate: None,
        error: None,
        created_at,
        started_at: None,
        finished_at: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn claim_is_atomic_across_concurrent_slices() {
    const JOBS: usize = 24;
    let dir = tempfile::tempdir().expect("临时目录");
    let store = Arc::new(SqliteMetaStore::open(dir.path().join("meta.db")).expect("打开数据库"));
    for index in 0..JOBS {
        JobRepo::enqueue(
            store.as_ref(),
            job(&format!("job-{index:03}"), 1_700_000_000_000 + index as i64),
        )
        .await
        .expect("入队");
    }

    // 8 条循环同时抢,谁都不能把同一条任务领两次
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let store = store.clone();
        tasks.push(tokio::spawn(async move {
            let mut mine = Vec::new();
            while let Some(job) = store.claim_next().await.expect("认领") {
                mine.push(job);
            }
            mine
        }));
    }
    let mut claimed = Vec::new();
    for task in tasks {
        claimed.extend(task.await.expect("任务没崩"));
    }

    let mut ids = claimed.iter().map(|job| job.id.clone()).collect::<Vec<_>>();
    ids.sort();
    let expected = (0..JOBS)
        .map(|index| format!("job-{index:03}"))
        .collect::<Vec<_>>();
    assert_eq!(ids, expected, "每个任务恰好被领一次,不能重也不能漏");
    for job in &claimed {
        // 交回去的就是认领后的形状:state 已转 running,started_at 已落库
        assert_eq!(job.state, JobState::Running, "认领后应直接是 running");
        assert!(job.started_at.is_some(), "认领要顺手记开始时间");
        let stored = JobRepo::get(store.as_ref(), &job.id)
            .await
            .expect("查询")
            .expect("存在");
        assert_eq!(stored.state, JobState::Running, "库里也必须是 running");
        assert!(stored.started_at.is_some());
    }
    assert!(
        store.claim_next().await.expect("认领").is_none(),
        "都领完了就该是空的"
    );
}

#[tokio::test]
async fn claim_skips_jobs_that_already_started() {
    let dir = tempfile::tempdir().expect("临时目录");
    let store = SqliteMetaStore::open(dir.path().join("meta.db")).expect("打开数据库");
    JobRepo::enqueue(&store, job("job-001", 1_700_000_000_000))
        .await
        .expect("入队");

    let first = store.claim_next().await.expect("认领").expect("有任务");
    assert_eq!(first.id, "job-001");
    // 已经在跑的任务不会再被领走(否则同一批次会被两条循环同时处理)
    assert!(store.claim_next().await.expect("认领").is_none());
}
