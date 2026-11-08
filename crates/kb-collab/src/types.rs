//! 房间、参与者、限额等基础类型。

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Yjs 文档里放正文的根节点名。客户端(`y-codemirror.next` / `@milkdown/plugin-collab`)必须用同样的名字。
pub const TEXT_ROOT: &str = "text";
/// 笔记(所见即所得)的 ProseMirror 节点树根名;这是 `y-prosemirror` / Milkdown 的默认值。
pub const RICH_ROOT: &str = "prosemirror";

/// 文档的 Yjs 结构。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocKind {
    /// `Y.Text`:代码、纯文本、Markdown 源码。服务端自己就能取出字符串。
    Text,
    /// `Y.XmlFragment`:笔记。服务端不认识节点结构,Markdown 由客户端序列化后提交。
    Rich,
}

/// Markdown 文件的扩展名(小写):和前端 `web-ui/src/collab/resourceKey.ts` 的 `MARKDOWN_EXTENSIONS` 一致。
pub const MARKDOWN_EXTENSIONS: [&str; 4] = ["md", "markdown", "mdown", "mdx"];

impl DocKind {
    /// 一个文件的房间结构:Markdown 文件和笔记一样是富文本(页面用所见即所得编辑它,两边必须是同一种结构),
    /// 其它文件是纯文本。
    pub fn for_file(path: &str) -> DocKind {
        let name = path.rsplit('/').next().unwrap_or(path);
        let markdown = name
            .rsplit_once('.')
            .map(|(_, extension)| extension.to_ascii_lowercase())
            .is_some_and(|extension| MARKDOWN_EXTENSIONS.contains(&extension.as_str()));
        if markdown {
            DocKind::Rich
        } else {
            DocKind::Text
        }
    }

    /// 库里存的名字。
    pub fn as_str(self) -> &'static str {
        match self {
            DocKind::Text => "text",
            DocKind::Rich => "prosemirror",
        }
    }

    /// 从库里读出来。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "text" => Some(DocKind::Text),
            "prosemirror" => Some(DocKind::Rich),
            _ => None,
        }
    }
}

/// 一篇文档:键(`ResourceKey` 的规范字符串)+ 结构。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct DocRef {
    /// 文档键。同一个键永远是同一种结构。
    pub key: String,
    /// 结构。
    pub kind: DocKind,
}

/// 一个连接背后的人。身份由守护进程在握手时确定,客户端自己报的名字一概不信。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Participant {
    /// 用户 id(`usr_…`)或游客标识(`guest:昵称#编号`)。
    pub id: String,
    /// 显示名。
    pub name: String,
}

impl Participant {
    /// 这个人的光标颜色:由 id 决定,同一个人在不同文档、不同设备上颜色一致。
    pub fn color(&self) -> &'static str {
        const PALETTE: [&str; 12] = [
            "#e03131", "#c2255c", "#9c36b5", "#6741d9", "#3b5bdb", "#1971c2", "#0c8599", "#099268",
            "#2f9e44", "#e67700", "#d9480f", "#5c940d",
        ];
        // FNV-1a:不依赖标准库哈希的随机种子,重启前后颜色不变
        let mut hash: u32 = 0x811c_9dc5;
        for byte in self.id.bytes() {
            hash ^= u32::from(byte);
            hash = hash.wrapping_mul(0x0100_0193);
        }
        PALETTE[(hash as usize) % PALETTE.len()]
    }
}

/// 给连接发出去的东西。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    /// 一条二进制消息(y-sync / awareness / 自定义控制消息)。
    Binary(Vec<u8>),
    /// 服务端要断开这条连接。`code` 用 WebSocket 的关闭码语义。
    Close {
        /// 关闭码。
        code: u16,
        /// 给人看的原因。
        reason: String,
    },
}

/// 限额与时间参数。默认值是生产用的;测试里按需缩短。
#[derive(Clone, Debug)]
pub struct Limits {
    /// 每个房间最多同时多少条连接。
    pub max_conns_per_room: usize,
    /// 全站最多同时开多少个房间。
    pub max_rooms: usize,
    /// 一个人(用户或游客)最多同时待在多少篇不同的文档里。
    ///
    /// 全站房间数是共享的:没有这条,几个注册账号每人开满自己的笔记就能占满全站,
    /// 别人打开协作文档都得到「太多」。同一篇文档开多个标签页只算一篇。
    pub max_rooms_per_user: usize,
    /// 单条入站消息最大字节数(含落地提交的 Markdown)。
    pub max_message_bytes: usize,
    /// 单个文档 Yjs 状态的上限;超过后房间只读,避免一篇文档把内存吃光。
    pub max_doc_bytes: usize,
    /// 在线状态(光标、名字)JSON 的上限。
    pub max_awareness_bytes: usize,
    /// 每条连接每秒最多处理多少条消息(令牌桶的速率);超过的连接被断开。
    pub messages_per_second: u32,
    /// 令牌桶的容量。
    pub message_burst: u32,
    /// 给每条连接的发送队列长度;满了说明对端太慢,断开让它重连补齐。
    pub send_queue: usize,
    /// 更新批量写盘的间隔。
    pub flush_interval: Duration,
    /// 最后一个人离开后房间保留多久。
    pub idle_close: Duration,
    /// 内容停止变化多久后落地(设计规范第 2 步)。
    pub land_debounce: Duration,
    /// 所有人都空闲多久后生成保存点(版本)。
    pub savepoint_idle: Duration,
    /// 累积多少条更新后把它们并进快照。
    pub compact_after_updates: usize,
    /// 等初始化者多久;超时换人。
    pub init_timeout: Duration,
    /// 房间定时器的节拍。
    pub tick: Duration,
    /// 多久重新核对一次每个连接的权限(授权被收回时的兜底;主动变更会立即核对)。
    pub recheck_interval: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_conns_per_room: 30,
            max_rooms: 200,
            max_rooms_per_user: 6,
            max_message_bytes: 4 * 1024 * 1024,
            max_doc_bytes: 16 * 1024 * 1024,
            max_awareness_bytes: 2 * 1024,
            messages_per_second: 100,
            message_burst: 400,
            send_queue: 512,
            flush_interval: Duration::from_millis(500),
            idle_close: Duration::from_secs(60),
            land_debounce: Duration::from_secs(3),
            savepoint_idle: Duration::from_secs(120),
            compact_after_updates: 100,
            init_timeout: Duration::from_secs(15),
            tick: Duration::from_millis(250),
            recheck_interval: Duration::from_secs(10),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_files_get_a_rich_room_and_everything_else_a_text_room() {
        for path in [
            "a.md",
            "文档/说明.MD",
            "x/y.markdown",
            "z.mdown",
            "page.mdx",
            ".md",
        ] {
            assert_eq!(DocKind::for_file(path), DocKind::Rich, "{path}");
        }
        for path in [
            "a.txt",
            "src/main.rs",
            "README",
            "md",
            "a.md.bak",
            "notes.md/readme.txt",
        ] {
            assert_eq!(DocKind::for_file(path), DocKind::Text, "{path}");
        }
    }
}
