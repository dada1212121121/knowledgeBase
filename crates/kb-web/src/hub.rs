//! 服务端事件推送(`/api/v1/ws`）。
//!
//! 事件种类（设计规范）:
//! - `job.progress`:任务进度 / 速率 / 剩余时间;
//! - `job.done`:任务结束(完成 / 失败 / 让出);
//! - `item.changed`:条目被编辑 / 新建 / 删除 / 撤销;
//! - `log`:`warn` 及以上级别的日志(`kb-cli` 的日志层把 tracing 事件转进来);
//! - `agent.delta`:AI 管家的流式输出(AI 接入,这里先留出种类名)。
//!
//! 这里只做进程内广播:没有订阅者时发送方也不会失败(守护进程可能没有页面打开)。

use serde_json::{Value, json};
use tokio::sync::broadcast;

/// 广播缓冲:一个卡住的浏览器最多落后这么多条事件,超出后丢弃旧事件。
pub const CHANNEL_CAPACITY: usize = 256;

/// 一条要推给浏览器的事件。
#[derive(Clone, Debug, PartialEq)]
pub struct ServerEvent {
    /// 事件种类(见模块注释)。
    pub kind: String,
    /// 事件内容。
    pub data: Value,
    /// 属于哪个知识库。`None` = 系统事件(日志、配置、备份……),只推给有系统功能的管理员。
    pub space: Option<String>,
    /// 只发给某一个人(通知、好友申请……)。设了它就**只有这个人**的连接能看到,
    /// 连管理员也看不到;`space` 此时不起作用。
    pub user: Option<String>,
}

/// 一个订阅者能看到哪些事件(按身份算出,连接建立时定下)。
#[derive(Clone, Debug)]
pub struct Viewer {
    /// 自己的知识库 id。
    pub space_id: Option<String>,
    /// 能不能看系统事件。
    pub system: bool,
    /// 我是谁。本机超级用户不是某个具体的人,为 `None`,看不到任何「发给某个人」的事件。
    pub user_id: Option<String>,
}

impl Viewer {
    /// 这条事件该不该推给他。**默认拒绝**:没有标签的事件只给管理员,别人的知识库的事件谁也看不到。
    pub fn can_see(&self, event: &ServerEvent) -> bool {
        // 发给某个人的事件:只有他本人看得到,管理员也不行
        if let Some(target) = &event.user {
            return self.user_id.as_deref() == Some(target.as_str());
        }
        match &event.space {
            Some(space) => self.space_id.as_deref() == Some(space.as_str()),
            None => self.system,
        }
    }
}

impl ServerEvent {
    /// 线格式:`{"type": "<种类>", "data": {...}}`。
    pub fn to_json(&self) -> Value {
        // 线格式不带 space:标签只用来过滤,不泄露给客户端
        json!({ "type": self.kind, "data": self.data })
    }
}

/// 事件中心。
#[derive(Clone)]
pub struct EventHub {
    tx: broadcast::Sender<ServerEvent>,
}

impl EventHub {
    /// 新建一个事件中心。
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(CHANNEL_CAPACITY);
        Self { tx }
    }

    /// 订阅(每个 WS 连接一个)。
    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.tx.subscribe()
    }

    /// 当前订阅者数量(测试与日志用)。
    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }

    /// 发一条事件,返回订阅者数量。
    ///
    /// 没有订阅者时 `broadcast::Sender::send` 会返回 `Err`,那不是错误:守护进程
    /// 常常没有页面打开,事件直接丢掉即可。
    ///
    /// 事件属于哪个知识库,取自当前的任务局部路由(能力调用、每个知识库自己的后台任务都会设置它);
    /// 不在任何知识库里发出的事件没有标签,只推给管理员(fail closed)。
    pub fn publish(&self, kind: impl Into<String>, data: Value) -> usize {
        let space = match kb_capability::current_call_scope() {
            Some(kb_capability::CallScope::Space { space_id, .. }) => Some(space_id),
            _ => None,
        };
        let event = ServerEvent {
            kind: kind.into(),
            data,
            space,
            user: None,
        };
        self.tx.send(event).unwrap_or_default()
    }

    /// 发一条只给某个人的事件(通知、好友申请)。不看任务局部路由:这类事件跨知识库,
    /// 谁触发的都是发给对方本人。
    pub fn publish_to_user(&self, user_id: &str, kind: impl Into<String>, data: Value) -> usize {
        let event = ServerEvent {
            kind: kind.into(),
            data,
            space: None,
            user: Some(user_id.to_owned()),
        };
        self.tx.send(event).unwrap_or_default()
    }
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for EventHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventHub")
            .field("subscribers", &self.subscriber_count())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewer(user: Option<&str>, system: bool) -> Viewer {
        Viewer {
            space_id: Some("sp_any".to_owned()),
            system,
            user_id: user.map(str::to_owned),
        }
    }

    #[tokio::test]
    async fn user_events_reach_only_that_user_not_even_admins() {
        let hub = EventHub::new();
        let mut rx = hub.subscribe();
        hub.publish_to_user("usr_alice", "notify", json!({ "n": 1 }));
        let event = rx.recv().await.expect("事件");
        assert!(viewer(Some("usr_alice"), false).can_see(&event));
        assert!(
            !viewer(Some("usr_bob"), false).can_see(&event),
            "别人看不到"
        );
        assert!(
            !viewer(Some("usr_admin"), true).can_see(&event),
            "管理员也看不到"
        );
        assert!(
            !viewer(None, true).can_see(&event),
            "本机超级用户不是某个人"
        );
        assert_eq!(event.to_json()["type"], "notify");
        assert!(
            event.to_json().get("user").is_none() && event.to_json()["data"].get("user").is_none(),
            "目标不泄露到线格式"
        );
    }

    #[tokio::test]
    async fn publish_reaches_subscribers() {
        let hub = EventHub::new();
        let mut rx = hub.subscribe();
        assert_eq!(hub.subscriber_count(), 1);
        let receivers = hub.publish("job.progress", json!({ "job_id": "j1", "done": 3 }));
        assert_eq!(receivers, 1);
        let event = rx.recv().await.expect("应收到事件");
        assert_eq!(event.kind, "job.progress");
        assert_eq!(event.to_json()["type"], "job.progress");
        assert_eq!(event.to_json()["data"]["done"], 3);
    }

    #[tokio::test]
    async fn publish_without_subscribers_is_not_an_error() {
        let hub = EventHub::new();
        assert_eq!(hub.publish("item.changed", json!({ "id": "x" })), 0);
    }

    #[tokio::test]
    async fn every_subscriber_gets_the_event() {
        let hub = EventHub::new();
        let mut first = hub.subscribe();
        let mut second = hub.subscribe();
        hub.publish("log", json!({ "level": "warn" }));
        assert_eq!(first.recv().await.expect("第一个").kind, "log");
        assert_eq!(second.recv().await.expect("第二个").kind, "log");
    }
}
