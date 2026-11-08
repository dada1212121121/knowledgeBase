//! ACP 代理的运行时:会话表、事件转发、进程池与闲置回收、沙箱包裹、上下文种子。

//! 拆成两半(2026-11-08,超长文件棘轮):
//! - `service`:ACP 的能力方法(两段 `impl ServiceBackend`);
//! - `forwarding`:消息转发链与上下文种子。
//!
//! `impl` 允许跨文件,所以拆的时候不重排方法、只按原文件段落搬。

mod forwarding;
mod service;

#[cfg(test)]
mod mention_tests {
    use crate::capability_backend::acp::forwarding::mentioned_session_ids;

    #[test]
    fn mentioned_sessions_come_from_kb_links() {
        let ids = mentioned_session_ids(
            "用户引用了这些资料:\n- [session] 旧会话 (kb://session/abc-1) — 用 agent_history 读它\n\n还有 kb://session/abc-2\n",
        );
        assert_eq!(ids, vec!["abc-1".to_owned(), "abc-2".to_owned()]);
    }
}
