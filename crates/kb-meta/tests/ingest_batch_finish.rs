//! 批次收尾的条件更新:取消 / 暂停优先于「跑完了」。
//!
//! 起因是 `e2e_web` 的取消用例:点取消的同时任务正好写完最后一个文件,旧的
//! `set_ingest_batch_state(Done)` 无条件写,把 `canceled` 盖回 `done` ——
//! 用户以为取消了,界面显示成功(而且是在后台并行跑多个任务之后才稳定复现)。

use kb_core::model::IngestBatchState;
use kb_core::ports::repo::IngestProgressRepo;
use kb_meta::SqliteMetaStore;

fn open_store() -> (tempfile::TempDir, SqliteMetaStore) {
    let dir = tempfile::tempdir().expect("临时目录");
    let store = SqliteMetaStore::open(dir.path().join("meta.db")).expect("打开数据库");
    (dir, store)
}

async fn state_of(store: &SqliteMetaStore, batch: &str) -> IngestBatchState {
    IngestProgressRepo::ingest_batch(store, batch)
        .await
        .expect("查批次")
        .expect("批次应存在")
        .state
}

#[tokio::test]
async fn finishing_a_running_batch_marks_it_done() {
    let (_dir, store) = open_store();
    IngestProgressRepo::ensure_ingest_batch(&store, "b1", "_global", 1)
        .await
        .expect("建批次");
    let landed = IngestProgressRepo::finish_ingest_batch_if_running(&store, "b1", 2)
        .await
        .expect("收尾");
    assert!(landed, "运行中的批次应当收尾成功");
    assert_eq!(state_of(&store, "b1").await, IngestBatchState::Done);
}

#[tokio::test]
async fn finishing_a_canceled_batch_does_not_resurrect_it() {
    let (_dir, store) = open_store();
    IngestProgressRepo::ensure_ingest_batch(&store, "b2", "_global", 1)
        .await
        .expect("建批次");
    // 用户点取消(与任务收尾并发)
    IngestProgressRepo::set_ingest_batch_state(&store, "b2", IngestBatchState::Canceled, 2)
        .await
        .expect("取消");
    let landed = IngestProgressRepo::finish_ingest_batch_if_running(&store, "b2", 3)
        .await
        .expect("收尾");
    assert!(!landed, "取消过的批次不该被收尾改成完成");
    assert_eq!(state_of(&store, "b2").await, IngestBatchState::Canceled);
}

#[tokio::test]
async fn finishing_a_paused_batch_does_not_resurrect_it() {
    let (_dir, store) = open_store();
    IngestProgressRepo::ensure_ingest_batch(&store, "b3", "_global", 1)
        .await
        .expect("建批次");
    IngestProgressRepo::set_ingest_batch_state(&store, "b3", IngestBatchState::Paused, 2)
        .await
        .expect("暂停");
    let landed = IngestProgressRepo::finish_ingest_batch_if_running(&store, "b3", 3)
        .await
        .expect("收尾");
    assert!(!landed, "暂停中的批次要等继续,不能被收尾改成完成");
    assert_eq!(state_of(&store, "b3").await, IngestBatchState::Paused);
}

#[tokio::test]
async fn finishing_twice_only_lands_once() {
    let (_dir, store) = open_store();
    IngestProgressRepo::ensure_ingest_batch(&store, "b4", "_global", 1)
        .await
        .expect("建批次");
    assert!(
        IngestProgressRepo::finish_ingest_batch_if_running(&store, "b4", 2)
            .await
            .expect("第一次收尾")
    );
    assert!(
        !IngestProgressRepo::finish_ingest_batch_if_running(&store, "b4", 3)
            .await
            .expect("第二次收尾"),
        "已经收尾过的批次不该再报一次成功(否则会重复补齐边 / 重建索引)"
    );
    assert_eq!(state_of(&store, "b4").await, IngestBatchState::Done);
}
