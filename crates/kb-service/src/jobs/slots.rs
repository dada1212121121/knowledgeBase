//! 跨知识库的分片名额(多用户设计说明「公平调度」)。
//!
//! 每个知识库有自己的后台 worker,同一时刻只做它自己的一个任务;任务本身是一片一片(分片)执行、
//! 每片之间可以让出的。所以公平只需要在**分片**这一层做:每片开始前先领一个全站名额,
//! 做完还回去。名额不够时按**先到先得**排队——一个知识库刚做完一片、马上又要下一片,
//! 就得排到队尾,别的知识库的分片先上。结果就是各个知识库轮流用名额,
//! 一个人导入一万个文件拖慢的只是他自己,别人的新笔记不用等几小时。
//!
//! 两条通道(哪条由各自的 `JobHandler::lane` 声明,判定规则见 [`lane_of`]):
//! - **批量**:导入、解析、全量索引、迁移等。总数受 [`SliceGate::new`] 的容量函数限制,每次领名额时现读,
//!   所以管理员改了 `index.parallel_slices` 不用重启;
//! - **交互**:编辑、保存笔记、hook 增量。走自己的通道,不占批量名额,
//!   也就永远不会排在别人的批量导入后面。

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use crate::jobs::queue::priority;

/// 优先级达到这个值的任务走交互通道(编辑、保存笔记、hook 增量)。
pub const INTERACTIVE_PRIORITY: i32 = priority::HOOK_INCREMENTAL;
/// 交互通道同时放行几片。交互任务很短,2 个够用,又不会让它们自己把 CPU 占满。
pub const INTERACTIVE_SLOTS: usize = 2;

/// 容量函数:每次领名额时调用,返回当前允许的批量并发数。
pub type Capacity = Arc<dyn Fn() -> usize + Send + Sync>;

/// 通道。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    /// 批量:导入、解析、全量索引、迁移,受 `index.parallel_slices` 限制。
    Bulk,
    /// 交互:编辑、保存笔记、hook 增量,固定 [`INTERACTIVE_SLOTS`] 个位置。
    Interactive,
}

/// 按优先级判通道:到了 [`INTERACTIVE_PRIORITY`] 就算交互活。
///
/// **这只是默认规则**,真正的判定交给 `JobHandler::lane` —— 按**活的性质**判,不是只看优先级
/// 数字:上传解析(`ingest`)的优先级也很高(几百份积压要排到旧批次前面,见
/// [`priority::INGEST_UPLOAD`]),但它本来就是批量活,放进只有 2 个位置的交互通道就出事了 ——
/// 实测一次导入几百个单文件批次时,两个位置被占满,`index.parallel_slices` 配多大都只有 2 个
/// 文件在跑。高优先级已经让它排到队首了。B8 之前这里还得认 `job_kind == ingest` 这个特例,
/// 现在解析那类任务的处理器根本不调用它。
pub fn lane_of(job_priority: i32) -> Lane {
    if job_priority < INTERACTIVE_PRIORITY {
        Lane::Bulk
    } else {
        Lane::Interactive
    }
}

#[derive(Default)]
struct LaneState {
    running: usize,
    waiters: VecDeque<oneshot::Sender<()>>,
}

struct State {
    bulk: LaneState,
    interactive: LaneState,
}

impl State {
    fn lane(&mut self, lane: Lane) -> &mut LaneState {
        match lane {
            Lane::Bulk => &mut self.bulk,
            Lane::Interactive => &mut self.interactive,
        }
    }
}

/// 排队中的等待者。如果在拿到名额之前 future 被丢弃,要把已经交接给它的名额还回去。
struct Waiting {
    gate: Arc<SliceGate>,
    lane: Lane,
    receiver: Option<oneshot::Receiver<()>>,
}

impl Drop for Waiting {
    fn drop(&mut self) {
        if let Some(mut receiver) = self.receiver.take() {
            // 先关掉:此后没人能再往里发。关掉之前已经发进来的(名额已记在我名下)还能收到
            receiver.close();
            if receiver.try_recv().is_ok() {
                self.gate.release(self.lane);
            }
        }
    }
}

/// 名额闸。
pub struct SliceGate {
    capacity: Capacity,
    state: Mutex<State>,
}

/// 领到的名额;丢弃时自动归还并叫醒队首。
pub struct SlicePermit {
    gate: Arc<SliceGate>,
    lane: Lane,
}

impl SlicePermit {
    /// 这个名额属于哪条通道。
    pub fn lane(&self) -> Lane {
        self.lane
    }
}

impl SliceGate {
    /// 构造。`capacity` 给出批量通道当前的容量(至少按 1 算,不会因为配成 0 而全站停摆)。
    pub fn new(capacity: Capacity) -> Arc<Self> {
        Arc::new(Self {
            capacity,
            state: Mutex::new(State {
                bulk: LaneState::default(),
                interactive: LaneState::default(),
            }),
        })
    }

    /// 固定容量(测试、嵌入式 CLI)。
    pub fn fixed(slots: usize) -> Arc<Self> {
        Self::new(Arc::new(move || slots))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn cap(&self, lane: Lane) -> usize {
        match lane {
            Lane::Interactive => INTERACTIVE_SLOTS,
            Lane::Bulk => (self.capacity)().max(1),
        }
    }

    /// 领一个名额(通道用 `JobHandler::lane` 或 [`lane_of`] 算,别自己按优先级判)。
    ///
    /// 排队时名额是**直接交接**的:前一个人还名额时,名额不经过「空闲」状态,
    /// 直接交给队首,所以后来者不可能插队。排队期间 future 被丢弃(任务被取消)不会漏掉名额,见 [`Waiting`]。
    pub async fn acquire(self: &Arc<Self>, lane: Lane) -> SlicePermit {
        let receiver = {
            let cap = self.cap(lane);
            let mut state = self.lock();
            let lane_state = state.lane(lane);
            // 有空位且前面没人排队才直接拿
            if lane_state.running < cap && lane_state.waiters.is_empty() {
                lane_state.running += 1;
                return SlicePermit {
                    gate: self.clone(),
                    lane,
                };
            }
            let (sender, receiver) = oneshot::channel();
            lane_state.waiters.push_back(sender);
            receiver
        };
        let mut waiting = Waiting {
            gate: self.clone(),
            lane,
            receiver: Some(receiver),
        };
        // 收到信号就说明名额已经记在我名下(running 没变,是交接过来的)
        let receiver = waiting.receiver.as_mut().expect("刚放进去");
        let _ = receiver.await;
        waiting.receiver = None;
        SlicePermit {
            gate: self.clone(),
            lane,
        }
    }

    fn release(&self, lane: Lane) {
        let cap = self.cap(lane);
        let mut state = self.lock();
        let lane = state.lane(lane);
        // 有人排队且没超容量:名额原地交给队首(running 不变)
        loop {
            if lane.running > cap {
                // 容量被调小了:不交接,让 running 自然降下去
                lane.running -= 1;
                return;
            }
            match lane.waiters.pop_front() {
                Some(waiter) => {
                    if waiter.send(()).is_ok() {
                        break;
                    }
                    // 对方已经放弃排队(future 被丢弃),换下一个
                }
                None => {
                    lane.running = lane.running.saturating_sub(1);
                    return;
                }
            }
        }
        // 容量被调大了:空出的位置也立刻交给后面的人
        while lane.running < cap {
            match lane.waiters.pop_front() {
                Some(waiter) => {
                    if waiter.send(()).is_ok() {
                        lane.running += 1;
                    }
                }
                None => break,
            }
        }
    }

    /// 现在批量通道里正在跑几片、排着几个(给状态页和测试看)。
    pub fn bulk_load(&self) -> (usize, usize) {
        let state = self.lock();
        (state.bulk.running, state.bulk.waiters.len())
    }
}

impl Drop for SlicePermit {
    fn drop(&mut self) {
        self.gate.release(self.lane);
    }
}

#[cfg(test)]
mod tests;
