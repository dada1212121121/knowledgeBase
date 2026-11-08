//! 任务队列「等久了提级」(防饥饿)。
//!
//! 取任务按「有效优先级 = 优先级 + 等待加成」排,同分先到先得。
//! 「现在」用 `next_runnable_at(now)` 注入,测试里不 sleep、不依赖真实时钟。
//! 下面用到的优先级数值与 `kb-service` 的 `jobs::queue::priority` 表一致:
//! 编辑 100、保存经验 90、增量索引 80、审核提炼 60、全量索引 20、迁移 10、维护 5。

use kb_core::model::{Job, JobState};
use kb_core::ports::repo::JobRepo;
use kb_core::timezone::now_millis;
use kb_meta::SqliteMetaStore;

const EDIT_ITEM: i32 = 100;
const SAVE_INSIGHT: i32 = 90;
const INCREMENTAL: i32 = 80;
const REVIEW_EXTRACT: i32 = 60;
const FULL_INDEX: i32 = 20;
const MIGRATE: i32 = 10;
const MAINTENANCE: i32 = 5;

const MINUTE: i64 = 60_000;
/// 测试用的「起点」。数值本身无意义,只要所有任务共用同一个时间轴。
const T0: i64 = 1_700_000_000_000;

fn open_store() -> (tempfile::TempDir, SqliteMetaStore) {
    let dir = tempfile::tempdir().expect("临时目录");
    let store = SqliteMetaStore::open(dir.path().join("meta.db")).expect("打开数据库");
    (dir, store)
}

fn job(id: &str, priority: i32, state: JobState, created_at: i64) -> Job {
    Job {
        id: id.to_owned(),
        kind: "index".to_owned(),
        collection: Some("proj_demo".to_owned()),
        priority,
        state,
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

async fn enqueue(store: &SqliteMetaStore, id: &str, priority: i32, created_at: i64) {
    JobRepo::enqueue(store, job(id, priority, JobState::Queued, created_at))
        .await
        .expect("入队");
}

async fn pick(store: &SqliteMetaStore, now: i64) -> String {
    store
        .next_runnable_at(now)
        .await
        .expect("取任务")
        .expect("队列里有任务")
        .id
}

/// 新来的低优先级任务不能插到刚入队的高优先级前面:提级只奖励「等」。
#[tokio::test]
async fn a_fresh_low_priority_job_does_not_beat_a_fresh_high_priority_one() {
    let (_dir, store) = open_store();
    // 全量索引先入队,但只等了 2 分钟:20 + 12 = 32,远不到 80
    enqueue(&store, "full", FULL_INDEX, T0).await;
    enqueue(&store, "incremental", INCREMENTAL, T0 + 2 * MINUTE).await;
    assert_eq!(pick(&store, T0 + 2 * MINUTE).await, "incremental");
}

/// 现场的饥饿:全量索引等够久以后,要先于「后入队」的增量。回退提级实现时这条必须变红。
#[tokio::test]
async fn a_low_priority_job_that_waited_long_enough_runs_before_a_later_high_priority_one() {
    let (_dir, store) = open_store();
    // 增量在全量等满 10 分钟那一刻才入队:全量 20 + 60 = 80,与增量同分,更早入队的先走。
    // 故意让增量先写库,排除「同分时靠插入顺序碰巧对」
    enqueue(&store, "incremental", INCREMENTAL, T0 + 10 * MINUTE).await;
    enqueue(&store, "full", FULL_INDEX, T0).await;
    assert_eq!(pick(&store, T0 + 10 * MINUTE).await, "full");
}

/// 提级按整分钟算:差一毫秒满 10 分钟时还是 74 分,增量先走;满了才追平。
#[tokio::test]
async fn aging_counts_whole_minutes_only() {
    let (_dir, store) = open_store();
    enqueue(&store, "full", FULL_INDEX, T0).await;
    let almost = T0 + 10 * MINUTE - 1;
    enqueue(&store, "incremental", INCREMENTAL, almost).await;
    assert_eq!(pick(&store, almost).await, "incremental");
    // 同一批任务,时间走到整 10 分钟:全量追平增量,并因更早入队先走
    assert_eq!(pick(&store, T0 + 10 * MINUTE).await, "full");
}

/// 等待加成有封顶:等一天和等 10 分钟一样,只追平增量(80),不会无限升高。
#[tokio::test]
async fn the_boost_is_capped_so_a_full_index_only_ties_with_incremental_jobs() {
    let (_dir, store) = open_store();
    let day = 24 * 60 * MINUTE;
    enqueue(&store, "full", FULL_INDEX, T0).await;
    enqueue(&store, "later-incremental", INCREMENTAL, T0 + day).await;
    // 全量等了一天仍是 80 分,与刚入队的增量同分,靠更早入队先走
    assert_eq!(pick(&store, T0 + day).await, "full");
    // 但它越不过比增量更高的保存经验
    enqueue(&store, "save", SAVE_INSIGHT, T0 + day).await;
    assert_eq!(pick(&store, T0 + day).await, "save");
}

/// 迁移(10)等多久都只提到 70:越不过 80 的增量,更越不过 90 / 100。
#[tokio::test]
async fn a_migration_never_overtakes_incremental_save_or_edit_jobs() {
    for (name, priority) in [
        ("incremental", INCREMENTAL),
        ("save", SAVE_INSIGHT),
        ("edit", EDIT_ITEM),
    ] {
        let (_dir, store) = open_store();
        let forever = 365 * 24 * 60 * MINUTE;
        enqueue(&store, "migrate", MIGRATE, T0).await;
        enqueue(&store, name, priority, T0 + forever).await;
        assert_eq!(
            pick(&store, T0 + forever).await,
            name,
            "等了一年的迁移不该越过刚入队的 {name}({priority})"
        );
    }
}

/// 提级对迁移不是摆设:等够久后它能越过 60 的审核提炼(10 + 60 = 70),
/// 否则「后台迁移被饿死」的问题还在。
#[tokio::test]
async fn a_migration_that_waited_long_enough_does_overtake_lower_jobs() {
    let (_dir, store) = open_store();
    enqueue(&store, "migrate", MIGRATE, T0).await;
    enqueue(&store, "review", REVIEW_EXTRACT, T0 + 10 * MINUTE).await;
    assert_eq!(pick(&store, T0 + 10 * MINUTE).await, "migrate");
    // 没等够时不行:5 分钟只有 10 + 30 = 40
    let (_dir2, store2) = open_store();
    enqueue(&store2, "migrate", MIGRATE, T0).await;
    enqueue(&store2, "review", REVIEW_EXTRACT, T0 + 5 * MINUTE).await;
    assert_eq!(pick(&store2, T0 + 5 * MINUTE).await, "review");
}

/// 等久了的增量(80)和审核提炼(60)也不能越过保存经验(90)与编辑单条(100):
/// 这两类是用户当场在等的操作,永远优先。
#[tokio::test]
async fn aged_jobs_never_overtake_save_insight_or_edit_item() {
    for (aged_name, aged_priority) in [("incremental", INCREMENTAL), ("review", REVIEW_EXTRACT)] {
        for (name, priority) in [("save", SAVE_INSIGHT), ("edit", EDIT_ITEM)] {
            let (_dir, store) = open_store();
            let long = 6 * 60 * MINUTE;
            enqueue(&store, aged_name, aged_priority, T0).await;
            enqueue(&store, name, priority, T0 + long).await;
            assert_eq!(
                pick(&store, T0 + long).await,
                name,
                "等了 6 小时的 {aged_name}({aged_priority})不该越过刚入队的 {name}({priority})"
            );
        }
    }
}

/// 保存经验(90)与编辑单条(100)之间不被提级抹平:90 等再久也排在新来的 100 后面。
#[tokio::test]
async fn top_priorities_keep_their_strict_order() {
    let (_dir, store) = open_store();
    let long = 6 * 60 * MINUTE;
    enqueue(&store, "save", SAVE_INSIGHT, T0).await;
    enqueue(&store, "edit", EDIT_ITEM, T0 + long).await;
    assert_eq!(pick(&store, T0 + long).await, "edit");
}

/// 有效优先级相同时先到先得:不管入库顺序,`created_at` 早的先走。
#[tokio::test]
async fn equal_effective_priority_falls_back_to_created_at() {
    let (_dir, store) = open_store();
    // 故意让后到的先写库,排除「靠插入顺序碰巧对」
    enqueue(&store, "later", INCREMENTAL, T0 + 5).await;
    enqueue(&store, "earlier", INCREMENTAL, T0 + 1).await;
    enqueue(&store, "latest", INCREMENTAL, T0 + 9).await;
    assert_eq!(pick(&store, T0 + 10).await, "earlier");
}

/// 时钟回拨 / 跨机器写入造成 `created_at` 比「现在」还晚时,等待时间按 0 算,不能算成负数把任务压到最后。
#[tokio::test]
async fn a_created_at_in_the_future_counts_as_no_waiting() {
    let (_dir, store) = open_store();
    // 全量索引的创建时间比「现在」晚 10 分钟:若算成负数是 20 - 60 = -40,会排到维护(5)后面
    enqueue(&store, "full", FULL_INDEX, T0 + 10 * MINUTE).await;
    enqueue(&store, "maintenance", MAINTENANCE, T0).await;
    assert_eq!(pick(&store, T0).await, "full");
}

/// 只有排队中的任务参与:运行中、暂停的不会被取到,不管它们多老、多高。
#[tokio::test]
async fn only_queued_jobs_are_candidates() {
    let (_dir, store) = open_store();
    JobRepo::enqueue(&store, job("running", EDIT_ITEM, JobState::Running, T0))
        .await
        .expect("入队");
    JobRepo::enqueue(&store, job("paused", EDIT_ITEM, JobState::Paused, T0))
        .await
        .expect("入队");
    enqueue(&store, "queued", MAINTENANCE, T0 + 20 * MINUTE).await;
    assert_eq!(pick(&store, T0 + 20 * MINUTE).await, "queued");
}

/// 提级只影响「取哪个」,给界面看的列表仍按原来的优先级降序、创建时间升序。
#[tokio::test]
async fn listing_order_is_not_affected_by_aging() {
    let (_dir, store) = open_store();
    enqueue(&store, "full", FULL_INDEX, T0).await;
    enqueue(&store, "incremental", INCREMENTAL, T0 + 10 * MINUTE).await;
    // 取任务时全量已追平增量并先走……
    assert_eq!(pick(&store, T0 + 10 * MINUTE).await, "full");
    // ……而列表按原始优先级展示,增量仍在前
    let listed: Vec<String> = JobRepo::list(&store, Some(JobState::Queued))
        .await
        .expect("列表")
        .into_iter()
        .map(|job| job.id)
        .collect();
    assert_eq!(listed, ["incremental", "full"]);
}

/// 不带时间参数的 trait 方法(生产里 worker 走的就是它)用真实时钟:
/// 全量索引 30 分钟前入队,新入队的增量排在它后面。不 sleep,靠造 `created_at`。
#[tokio::test]
async fn the_trait_method_uses_the_real_clock() {
    let (_dir, store) = open_store();
    let now = now_millis();
    enqueue(&store, "full", FULL_INDEX, now - 30 * MINUTE).await;
    enqueue(&store, "incremental", INCREMENTAL, now).await;
    let first = JobRepo::next_runnable(&store)
        .await
        .expect("取任务")
        .expect("有任务");
    assert_eq!(first.id, "full");
}

/// 已经跑过(有检查点)的任务不再积累等待加成:它每片让出后重新排队,`created_at` 却是很久以前,
/// 不能因此一直和新来的增量同分且更早。
#[tokio::test]
async fn a_job_that_already_made_progress_gets_no_aging_boost() {
    let (_dir, store) = open_store();
    let mut started = job("full", FULL_INDEX, JobState::Queued, T0);
    started.checkpoint_json = Some("{\"next\":3}".to_owned());
    JobRepo::enqueue(&store, started).await.expect("入队");
    // 增量刚入队(没等过,有效优先级 80)
    enqueue(&store, "incremental", INCREMENTAL, T0 + 30 * MINUTE).await;
    // 30 分钟后:没有检查点的话全量已经提到 80 且更早入队;有检查点就还是 20
    assert_eq!(pick(&store, T0 + 30 * MINUTE).await, "incremental");
}

/// 对照:同样等了 30 分钟、还没跑过任何一片(没有检查点)的全量索引照常提级并先走。
#[tokio::test]
async fn a_job_that_has_not_started_still_gets_the_aging_boost() {
    let (_dir, store) = open_store();
    enqueue(&store, "full", FULL_INDEX, T0).await;
    // 增量刚入队(没等过,有效优先级 80);全量等了 30 分钟:20 + 60 = 80,同分,更早入队的先走
    enqueue(&store, "incremental", INCREMENTAL, T0 + 30 * MINUTE).await;
    assert_eq!(pick(&store, T0 + 30 * MINUTE).await, "full");
}
