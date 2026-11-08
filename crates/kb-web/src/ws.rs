//! WebSocket:`/api/v1/ws`(设计规范的进度推送)。
//!
//! 连接建立后先发一条 `hello`,之后:
//! - 转发 [`crate::hub::EventHub`] 里的 `job.progress` / `job.done` / `item.changed` / `log`
//!   (以及 AI 的 `agent.delta`);
//! - 每 15 秒发一条 `ping`(带 uptime),客户端可以发文本 `ping` 换 `pong`。

use std::sync::Arc;

use axum::Json;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::api::AppState;
use crate::auth::Identity;
use crate::hub::Viewer;

/// 心跳间隔。
const PING_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// 升级并推送事件。
pub async fn handler(
    State(state): State<Arc<AppState>>,
    Extension(identity): Extension<Identity>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    // 和协作、分享的 WebSocket 一样检查来源:别的站点的页面不能借浏览器里的会话订阅这个人的全部事件。
    // (会话 cookie 是 SameSite=Strict,跨站握手本来带不上它;这里是同站下其它子域 / 应用的兜底)
    if !crate::collab_ws::origin_ok(&headers, &state.account.config.get().site.public_url) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "ok": false,
                "error": { "code": "bad_origin", "message": "不允许的来源" },
            })),
        )
            .into_response();
    }
    // 订阅者能看到什么,在握手时按身份定下:自己知识库的事件 + (管理员)系统事件
    let viewer = identity.viewer();
    upgrade.on_upgrade(move |socket| run(socket, state, viewer))
}

async fn run(mut socket: WebSocket, state: Arc<AppState>, viewer: Viewer) {
    let hello = json!({
        "type": "hello",
        "version": state.version,
        "capabilities": state.invoker.registry().len(),
    });
    if socket
        .send(Message::Text(hello.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    // 订阅要在 hello 之后:客户端先拿到握手信息,再收增量事件
    let mut events = state.hub.subscribe();
    let mut ticker = tokio::time::interval(PING_INTERVAL);
    // 第一次 tick 会立刻触发,跳过它,免得 hello 后面紧跟一条 ping
    ticker.tick().await;
    loop {
        tokio::select! {
            event = events.recv() => {
                match event {
                    Ok(event) => {
                        if !viewer.can_see(&event) {
                            continue;
                        }
                        let text = event.to_json().to_string();
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            return;
                        }
                    }
                    // 客户端跟不上(落后太多)时跳过丢失的事件,连接继续
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                        tracing::warn!(missed, "WS 客户端落后,已丢弃部分事件");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
            _ = ticker.tick() => {
                let ping = json!({"type": "ping", "uptime_s": state.started.elapsed().as_secs()});
                if socket.send(Message::Text(ping.to_string().into())).await.is_err() {
                    return;
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Close(_))) | None => return,
                    Some(Ok(Message::Text(text))) if text == "ping" => {
                        let pong = json!({"type": "pong"});
                        if socket.send(Message::Text(pong.to_string().into())).await.is_err() {
                            return;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => return,
                }
            }
        }
    }
}
