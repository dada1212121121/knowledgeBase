use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use super::*;

const BULK: Lane = Lane::Bulk;
const NOTE: Lane = Lane::Interactive;

#[tokio::test]
async fn never_more_than_the_capacity_run_at_once() {
    let gate = SliceGate::fixed(2);
    let running = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let mut tasks = Vec::new();
    for _ in 0..12 {
        let (gate, running, peak) = (gate.clone(), running.clone(), peak.clone());
        tasks.push(tokio::spawn(async move {
            let _permit = gate.acquire(BULK).await;
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(15)).await;
            running.fetch_sub(1, Ordering::SeqCst);
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    assert_eq!(peak.load(Ordering::SeqCst), 2);
    assert_eq!(gate.bulk_load(), (0, 0), "全部还回来了");
}

#[tokio::test]
async fn waiters_are_served_in_arrival_order_so_a_busy_space_cannot_cut_in_line() {
    let gate = SliceGate::fixed(1);
    let order = Arc::new(Mutex::new(Vec::new()));
    let first = gate.acquire(BULK).await; // 占住唯一的名额
    let mut tasks = Vec::new();
    for name in ["a", "b", "c"] {
        let (task_gate, task_order) = (gate.clone(), order.clone());
        tasks.push(tokio::spawn(async move {
            let permit = task_gate.acquire(BULK).await;
            task_order.lock().unwrap().push(name);
            drop(permit);
        }));
        // 保证按 a b c 的顺序进队
        while gate.bulk_load().1 < tasks.len() {
            tokio::task::yield_now().await;
        }
    }
    // 持有者放开名额后,又立刻想再要一个(一个批量导入的知识库做完一片马上做下一片):要排到队尾
    drop(first);
    let again = tokio::spawn({
        let (gate, order) = (gate.clone(), order.clone());
        async move {
            let _permit = gate.acquire(BULK).await;
            order.lock().unwrap().push("again");
        }
    });
    for task in tasks {
        task.await.unwrap();
    }
    again.await.unwrap();
    assert_eq!(*order.lock().unwrap(), ["a", "b", "c", "again"]);
}

#[tokio::test]
async fn notes_use_their_own_lane_and_never_wait_behind_bulk_work() {
    let gate = SliceGate::fixed(1);
    let _bulk = gate.acquire(BULK).await;
    let queued = tokio::spawn({
        let gate = gate.clone();
        async move {
            let _permit = gate.acquire(BULK).await;
        }
    });
    while gate.bulk_load().1 < 1 {
        tokio::task::yield_now().await;
    }
    // 批量通道被占满、还有人在排队:保存笔记的分片照样立刻拿到
    let permit = tokio::time::timeout(Duration::from_millis(200), gate.acquire(NOTE))
        .await
        .expect("交互通道不该被批量任务堵住");
    drop(permit);
    queued.abort();
}

/// 通道按「活的性质」分,不是只看优先级数字:上传解析优先级 90,但它是批量活。
///
/// 以前这里还得认 `kind` 字符串(B8 之前 `lane_of` 有 `job_kind == ingest` 的特例):
/// 一次导入几百个单文件批次时,这些 90 的任务全挤在 2 个交互名额上,
/// `index.parallel_slices` 配多大都只有 2 个文件在跑。现在「是不是交互活」由处理器声明,
/// `lane_of` 只做纯优先级判定。
#[test]
fn upload_parsing_is_bulk_work_although_its_priority_is_high() {
    // 高优先级不等于交互活:解析那类任务的处理器不声明 `lane`(默认就是批量)

    // 编辑、保存笔记、hook 增量走交互通道
    for job_priority in [
        priority::EDIT_ITEM,
        priority::SAVE_INSIGHT,
        priority::HOOK_INCREMENTAL,
    ] {
        assert_eq!(lane_of(job_priority), Lane::Interactive);
    }
    // 全量索引、迁移、维护是批量活
    for job_priority in [
        priority::REVIEW_EXTRACT,
        priority::FULL_INDEX,
        priority::MIGRATE,
        priority::MAINTENANCE,
    ] {
        assert_eq!(lane_of(job_priority), Lane::Bulk);
    }
    // 边界:恰好等于阈值算交互,低一级算批量
    assert_eq!(
        lane_of(INTERACTIVE_PRIORITY),
        Lane::Interactive,
        "恰好等于阈值的走交互通道"
    );
    assert_eq!(
        lane_of(INTERACTIVE_PRIORITY - 1),
        Lane::Bulk,
        "低于阈值的走批量通道"
    );
}

#[tokio::test]
async fn the_capacity_is_read_live_so_a_config_change_applies_without_a_restart() {
    let capacity = Arc::new(AtomicUsize::new(1));
    let gate = SliceGate::new({
        let capacity = capacity.clone();
        Arc::new(move || capacity.load(Ordering::SeqCst))
    });
    let held = gate.acquire(BULK).await;
    let waiting: Vec<_> = (0..3)
        .map(|_| {
            let gate = gate.clone();
            tokio::spawn(async move { gate.acquire(BULK).await })
        })
        .collect();
    while gate.bulk_load().1 < 3 {
        tokio::task::yield_now().await;
    }
    // 管理员把容量调到 4:下一次还名额(这里是放掉 held)时,空出来的位置一起交给排队的人
    capacity.store(4, Ordering::SeqCst);
    drop(held);
    let mut permits = Vec::new();
    for task in waiting {
        permits.push(
            tokio::time::timeout(Duration::from_millis(500), task)
                .await
                .expect("调大后排队的都该拿到")
                .unwrap(),
        );
    }
    assert_eq!(gate.bulk_load(), (3, 0));
    // 调到 0 也不会让全站停摆:至少还有 1 个
    capacity.store(0, Ordering::SeqCst);
    drop(permits);
    let _ok = tokio::time::timeout(Duration::from_millis(200), gate.acquire(BULK))
        .await
        .expect("容量配成 0 按 1 算");
}

#[tokio::test]
async fn a_cancelled_waiter_gives_its_slot_back_even_if_it_was_just_handed_one() {
    let gate = SliceGate::fixed(1);
    let held = gate.acquire(BULK).await;
    let waiter = tokio::spawn({
        let gate = gate.clone();
        async move {
            let _permit = gate.acquire(BULK).await;
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
    while gate.bulk_load().1 < 1 {
        tokio::task::yield_now().await;
    }
    // 先放手(名额交接给排队的人),紧接着取消那个任务:名额不能就此丢失
    drop(held);
    waiter.abort();
    let _ = waiter.await;
    let _again = tokio::time::timeout(Duration::from_millis(500), gate.acquire(BULK))
        .await
        .expect("被取消的等待者必须把名额还回来");
}

#[tokio::test]
async fn a_waiter_that_gave_up_before_its_turn_is_skipped() {
    let gate = SliceGate::fixed(1);
    let held = gate.acquire(BULK).await;
    let quitter = tokio::spawn({
        let gate = gate.clone();
        async move {
            let _permit = gate.acquire(BULK).await;
        }
    });
    while gate.bulk_load().1 < 1 {
        tokio::task::yield_now().await;
    }
    let patient = tokio::spawn({
        let gate = gate.clone();
        async move {
            let _permit = gate.acquire(BULK).await;
        }
    });
    while gate.bulk_load().1 < 2 {
        tokio::task::yield_now().await;
    }
    quitter.abort();
    let _ = quitter.await;
    drop(held);
    tokio::time::timeout(Duration::from_millis(500), patient)
        .await
        .expect("排在前面的人放弃了,后面的人不能卡住")
        .unwrap();
}
