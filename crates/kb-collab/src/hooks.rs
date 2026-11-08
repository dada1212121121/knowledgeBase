//! 房间需要外面(守护进程)做的事。

use async_trait::async_trait;
use kb_core::Result;

use crate::types::{DocRef, Participant};

/// 文档此刻在正文库里的内容。
#[derive(Clone, Debug)]
pub struct Body {
    /// Markdown / 纯文本。
    pub text: String,
}

/// 一次落地:把协作中的内容写回正文。
#[derive(Clone, Debug)]
pub struct Landing {
    /// 要写回的内容。
    pub text: String,
    /// 是否同时生成一个保存点(版本历史里的一条)。
    pub savepoint: bool,
    /// 自上个保存点以来参与过编辑的人。生成版本时一并记录。
    pub participants: Vec<Participant>,
}

/// 外部实现。
#[async_trait]
pub trait CollabHooks: Send + Sync {
    /// 文档还在不在。握手时用它在升级连接之前就拒绝不存在的文档(返回 404,而不是升级后再断开)。
    async fn exists(&self, _doc: &DocRef) -> bool {
        true
    }
    /// 读文档当前的正文。文档不存在返回错误(房间不会为不存在的文档而开)。
    async fn load_body(&self, doc: &DocRef) -> Result<Body>;
    /// 把协作内容写回正文。正文没有变化时应当什么也不写(「没改动不写回」)。
    /// 返回写回的内容的哈希,房间据此判断以后正文有没有被别的途径改过。
    async fn land(&self, doc: &DocRef, landing: Landing) -> Result<String>;
    /// 只生成保存点(正文已经是最新的):所有人空闲、最后一人离开时用。
    async fn savepoint(&self, doc: &DocRef, participants: Vec<Participant>) -> Result<()>;
    /// 内容哈希。必须和 [`CollabHooks::land`] 返回的是同一种算法。
    fn hash(&self, text: &str) -> String;
}

/// 一个连接对一篇文档的权限。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// 没有权限(被移除、链接失效):连接会被断开。
    Denied,
    /// 只读:能实时看到别人的修改,自己的修改被丢弃。
    Read,
    /// 可编辑。
    Write,
}

/// 权限核对。连接建立时由网络层先核对一次;房间会定期(和被通知时)重新核对,
/// 授权被降级 / 收回后连接马上变只读或被断开。
#[async_trait]
pub trait CollabAuth: Send + Sync {
    /// `ctx` 是握手时网络层给的不透明字符串(比如经哪个分享链接进来的),原样传回。
    async fn access(&self, doc: &DocRef, who: &Participant, ctx: &str) -> Access;
}
