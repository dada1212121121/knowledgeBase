//! 真实 stdio 往返:拉起一个假 ACP 代理,验证 initialize / 新会话 / prompt / 增量 / 权限策略。

use std::collections::BTreeMap;

use kb_acp::{AcpClient, AcpEvent, AgentSpec, PermissionPolicy, text_of};

fn fake_agent() -> Option<AgentSpec> {
    let available = std::process::Command::new("python3")
        .arg("--version")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);
    if !available {
        return None;
    }
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fake_agent.py");
    let mut spec = AgentSpec::new("fake", "假代理", "python3");
    spec.args = vec!["-u".to_owned(), script.to_owned()];
    spec.env = BTreeMap::new();
    Some(spec)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn initializes_creates_a_session_and_streams_updates() {
    let Some(spec) = fake_agent() else {
        eprintln!("没有 python3,跳过");
        return;
    };
    let scope = std::env::temp_dir();
    let mut client = AcpClient::spawn(spec, PermissionPolicy::ReadOnly, Some(scope.clone()))
        .await
        .expect("拉起假代理");
    assert_eq!(client.info.name, "fake-acp");
    assert_eq!(client.info.version, "0.1.0");

    let session = client
        .new_session(
            std::env::temp_dir(),
            vec![kb_acp::McpServerSpec {
                name: "knowledgeBase".to_owned(),
                command: std::path::PathBuf::from("/bin/true"),
                args: vec!["mcp".to_owned()],
                env: vec![("KB_HOME".to_owned(), "/tmp".to_owned())],
            }],
        )
        .await
        .expect("新会话");
    assert_eq!(session, "s1");
    assert!(client.info.load_session, "假代理声明支持 session/load");
    client
        .load_session("s1", std::env::temp_dir(), Vec::new())
        .await
        .expect("续上会话");

    // 一边发 prompt,一边读增量(真实场景里由 WS 推送任务做)
    let mut events = client.take_events();
    let mut text = String::new();
    let mut denied = false;
    let mut auto_denied = false;
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut prompt = Box::pin(client.prompt(&session, "你好"));
        let outcome = loop {
            tokio::select! {
                event = events.recv() => {
                    let Some(event) = event else { break prompt.await.expect("prompt") };
                    match event {
                        AcpEvent::Update { update, .. } => {
                            if let Some(("text", chunk)) = text_of(&update) {
                                text.push_str(&chunk);
                            }
                        }
                        AcpEvent::PermissionRequest { request_id, .. } => {
                            // 界面在这里点「拒绝」
                            client.resolve_permission(&request_id, false).await;
                        }
                        AcpEvent::TurnFinished { .. } => {}
                        AcpEvent::Permission { allowed, reason, .. } => {
                            if !allowed && reason.is_some() {
                                auto_denied = true;
                            }
                            denied = !allowed;
                        }
                    }
                }
                result = &mut prompt => break result.expect("prompt"),
            }
        };
        // 响应先到、最后几条通知还在通道里:再收一小会儿
        while let Ok(Some(event)) =
            tokio::time::timeout(std::time::Duration::from_millis(300), events.recv()).await
        {
            match event {
                AcpEvent::Update { update, .. } => {
                    if let Some(("text", chunk)) = text_of(&update) {
                        text.push_str(&chunk);
                    }
                }
                AcpEvent::Permission {
                    allowed, reason, ..
                } => {
                    if !allowed && reason.is_some() {
                        auto_denied = true;
                    }
                    denied = !allowed;
                }
                AcpEvent::PermissionRequest { request_id, .. } => {
                    client.resolve_permission(&request_id, false).await;
                }
                AcpEvent::TurnFinished { .. } => {}
            }
        }
        outcome
    })
    .await
    .expect("10 秒内完成");

    assert_eq!(outcome.stop_reason, "end_turn");
    assert!(
        text.contains("权限结果1:cancelled"),
        "越界请求应被直接拒绝:{text}"
    );
    assert!(text.contains("权限结果2:deny"), "界面应能拒绝:{text}");
    assert!(auto_denied, "应有一条带原因的自动拒绝");
    assert!(text.contains("你好,我是假代理。"), "{text}");
    assert!(text.contains("MCP:1"), "MCP server 应传给代理:{text}");
    assert!(denied, "编辑类工具默认应被拒绝");
    client.shutdown().await;
}
