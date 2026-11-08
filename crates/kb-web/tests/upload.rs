//! 上传接口:路由、请求体、分片大小上限与未启用时的 404。

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use kb_core::Result;
use kb_web::api::AppState;
use kb_web::auth::Caller;
use kb_web::source::SocketKind;
use kb_web::{CreateUploadRequest, PrecheckRequest, UploadApi};
use serde_json::{Value, json};
use tower::ServiceExt;

/// 记录调用并回固定 JSON 的假上传后端。
#[derive(Default)]
struct StubUploads {
    calls: Mutex<Vec<String>>,
    /// 最后一次分片的字节数(验证请求体确实传到了后端)。
    last_part_len: Mutex<usize>,
}

impl StubUploads {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("锁").clone()
    }
}

#[async_trait]
impl UploadApi for StubUploads {
    async fn create_upload(&self, caller: &Caller, request: CreateUploadRequest) -> Result<Value> {
        let actor = &caller.actor;
        self.calls
            .lock()
            .expect("锁")
            .push(format!("create:{}:{actor}", request.name));
        Ok(json!({
            "upload_id": "u1",
            "batch_id": request.batch.unwrap_or_else(|| "b1".to_owned()),
            "chunk_size": 1024,
            "parts_total": 1,
            "received": [],
        }))
    }

    async fn upload_status(&self, _caller: &Caller, upload_id: &str) -> Result<Value> {
        self.calls
            .lock()
            .expect("锁")
            .push(format!("status:{upload_id}"));
        Ok(json!({ "upload_id": upload_id, "received": [0] }))
    }

    async fn put_part(
        &self,
        _caller: &Caller,
        upload_id: &str,
        part_no: u32,
        bytes: Vec<u8>,
        sha256: Option<String>,
    ) -> Result<Value> {
        *self.last_part_len.lock().expect("锁") = bytes.len();
        self.calls.lock().expect("锁").push(format!(
            "part:{upload_id}:{part_no}:{}:{sha256:?}",
            bytes.len()
        ));
        Ok(json!({ "part_no": part_no, "size": bytes.len() }))
    }

    async fn complete_upload(&self, caller: &Caller, upload_id: &str) -> Result<Value> {
        let actor = &caller.actor;
        self.calls
            .lock()
            .expect("锁")
            .push(format!("complete:{upload_id}:{actor}"));
        Ok(json!({ "upload_id": upload_id, "files": [] }))
    }

    async fn abort_upload(&self, _caller: &Caller, upload_id: &str) -> Result<Value> {
        self.calls
            .lock()
            .expect("锁")
            .push(format!("abort:{upload_id}"));
        Ok(json!({ "upload_id": upload_id }))
    }

    async fn precheck(&self, _caller: &Caller, request: PrecheckRequest) -> Result<Value> {
        self.calls.lock().expect("锁").push(format!(
            "precheck:{}:{}",
            request.collection,
            request.files.len()
        ));
        Ok(json!({ "results": [] }))
    }

    async fn lock_file(&self, caller: &Caller, request: kb_web::FileLockRequest) -> Result<Value> {
        self.calls.lock().expect("锁").push(format!(
            "lock:{}:{}:{}:{}:{}",
            request.collection, request.path, request.session, request.take_over, caller.actor
        ));
        Ok(json!({ "held": true, "ttl_secs": 45 }))
    }

    async fn unlock_file(
        &self,
        caller: &Caller,
        request: kb_web::FileUnlockRequest,
    ) -> Result<Value> {
        self.calls.lock().expect("锁").push(format!(
            "unlock:{}:{}:{}:{}",
            request.collection, request.path, request.session, caller.actor
        ));
        Ok(json!({ "released": true }))
    }

    async fn roundtrip_check(
        &self,
        caller: &Caller,
        request: kb_web::RoundtripCheckRequest,
        bytes: Vec<u8>,
    ) -> Result<Value> {
        self.calls.lock().expect("锁").push(format!(
            "roundtrip:{}:{}:{}:{}",
            request.collection,
            request.path,
            bytes.len(),
            caller.actor
        ));
        Ok(json!({ "lossless": true }))
    }

    async fn replace_file(
        &self,
        caller: &Caller,
        request: kb_web::ReplaceFileRequest,
        bytes: Vec<u8>,
    ) -> Result<Value> {
        self.calls.lock().expect("锁").push(format!(
            "replace:{}:{}:{}:{:?}:{}:{:?}",
            request.collection,
            request.path,
            bytes.len(),
            request.expected_sha256,
            caller.actor,
            request.session
        ));
        Ok(json!({ "version": 2 }))
    }
}

/// 审计的假实现(本测试不关心)。
struct NullAudit;

#[async_trait]
impl kb_core::ports::repo::AuditRepo for NullAudit {
    async fn record(&self, _entry: kb_core::model::AuditEntry) -> Result<i64> {
        Ok(1)
    }
    async fn begin_batch(&self, _actor: &str, _description: &str) -> Result<String> {
        Ok("b1".to_owned())
    }
    async fn ensure_batch(&self, _id: &str, _actor: &str, _description: &str) -> Result<()> {
        Ok(())
    }
    async fn record_change(&self, _batch_id: &str, _change: kb_core::model::Change) -> Result<()> {
        Ok(())
    }
    async fn batch(&self, _id: &str) -> Result<Option<kb_core::model::Batch>> {
        Ok(None)
    }
    async fn list(
        &self,
        _filter: Option<kb_core::model::AuditFilter>,
        _page: kb_core::model::Page,
    ) -> Result<Vec<kb_core::model::AuditEntry>> {
        Ok(Vec::new())
    }
    async fn count(&self, _filter: Option<kb_core::model::AuditFilter>) -> Result<u64> {
        Ok(0)
    }
    async fn changes(&self, _batch_id: &str) -> Result<Vec<kb_core::model::Change>> {
        Ok(Vec::new())
    }
    async fn list_batches(
        &self,
        _page: kb_core::model::Page,
    ) -> Result<Vec<kb_core::model::Batch>> {
        Ok(Vec::new())
    }
    async fn count_batches(&self) -> Result<u64> {
        Ok(0)
    }
    async fn mark_reverted(&self, _batch_id: &str, _at: i64) -> Result<()> {
        Ok(())
    }
}

fn state(uploads: Option<Arc<StubUploads>>) -> Arc<AppState> {
    let dir = tempfile::tempdir().expect("临时 KB_HOME");
    let meta: Arc<dyn kb_core::ports::repo::MetaStore> =
        Arc::new(kb_meta::SqliteMetaStore::open(dir.path().join("meta.db")).expect("打开 meta.db"));
    std::mem::forget(dir);
    let registry = Arc::new(kb_capability::Registry::new());
    Arc::new(AppState {
        invoker: Arc::new(kb_capability::Invoker::new(registry, Arc::new(NullAudit))),
        started: std::time::Instant::now(),
        version: "test",
        mcp: None,
        events: None,
        meta,
        system: Arc::new(
            kb_meta::SystemStore::open(
                tempfile::tempdir()
                    .expect("账号库目录")
                    .keep()
                    .join("system.db"),
            )
            .expect("打开账号库"),
        ),
        principals: kb_web::auth::PrincipalCache::default(),
        account: kb_web::signup::AccountDeps::unconfigured(),
        ai_enabled: Arc::new(kb_core::features::AiState::on),
        login_limiter: kb_web::auth::ratelimit::LoginLimiter::new(),
        hub: Arc::new(kb_web::EventHub::new()),
        uploads: uploads.map(|uploads| uploads as Arc<dyn UploadApi>),
        agent_grants: Arc::new(kb_web::AgentGrants::new()),
        collab: None,
        office: None,
    })
}

async fn send(uploads: Option<Arc<StubUploads>>, request: Request<Body>) -> (StatusCode, Value) {
    let app = kb_web::build(state(uploads), SocketKind::Unix);
    let response = app.oneshot(request).await.expect("请求");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .expect("读响应");
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

#[tokio::test]
async fn upload_endpoints_round_trip() {
    let uploads = Arc::new(StubUploads::default());

    // 1) 新建
    let (status, body) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("POST")
            .uri("/api/v1/uploads")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "name": "a.md",
                    "size": 10,
                    "collection": "_global",
                    "rel_path": "docs/a.md",
                    "batch": "b-42",
                })
                .to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["upload_id"], "u1");
    assert_eq!(body["data"]["batch_id"], "b-42");

    // 2) 写分片:请求体是原始字节,单片 sha256 走请求头
    let (status, body) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("PUT")
            .uri("/api/v1/uploads/u1/parts/0")
            .header("x-kb-part-sha256", "abc123")
            .body(Body::from(vec![7u8; 1024]))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["size"], 1024);
    assert_eq!(*uploads.last_part_len.lock().expect("锁"), 1024);

    // 3) 续传信息
    let (status, body) = send(
        Some(uploads.clone()),
        Request::builder()
            .uri("/api/v1/uploads/u1")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["received"][0], 0);

    // 4) 完成
    let (status, body) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("POST")
            .uri("/api/v1/uploads/u1/complete")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // 5) 预检
    let (status, _body) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("POST")
            .uri("/api/v1/uploads/precheck")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "collection": "_global",
                    "files": [{"rel_path": "docs/a.md", "size": 10, "sha256": "abc"}],
                })
                .to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 6) 取消
    let (status, _body) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("DELETE")
            .uri("/api/v1/uploads/u1")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    assert_eq!(
        uploads.calls(),
        vec![
            "create:a.md:local".to_owned(),
            "part:u1:0:1024:Some(\"abc123\")".to_owned(),
            "status:u1".to_owned(),
            "complete:u1:local".to_owned(),
            "precheck:_global:1".to_owned(),
            "abort:u1".to_owned(),
        ]
    );
}

#[tokio::test]
async fn part_body_is_larger_than_the_default_limit() {
    // 默认的 2 MB 请求体上限会把 8 MB 分片挡在 413,这里必须放开
    let uploads = Arc::new(StubUploads::default());
    let part = vec![1u8; 8 * 1024 * 1024];
    let (status, body) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("PUT")
            .uri("/api/v1/uploads/u1/parts/3")
            .body(Body::from(part))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(*uploads.last_part_len.lock().expect("锁"), 8 * 1024 * 1024);
}

#[tokio::test]
async fn endpoints_return_404_when_uploads_are_not_wired() {
    let create_body = json!({
        "name": "a.md",
        "size": 10,
        "collection": "_global",
    })
    .to_string();
    let precheck_body = json!({
        "collection": "_global",
        "files": [{"rel_path": "a.md", "size": 1, "sha256": "x"}],
    })
    .to_string();
    for (method, uri, body) in [
        ("POST", "/api/v1/uploads", create_body.clone()),
        ("GET", "/api/v1/uploads/u1", String::new()),
        ("PUT", "/api/v1/uploads/u1/parts/0", String::new()),
        ("POST", "/api/v1/uploads/u1/complete", String::new()),
        ("DELETE", "/api/v1/uploads/u1", String::new()),
        ("POST", "/api/v1/uploads/precheck", precheck_body.clone()),
    ] {
        let (status, response) = send(
            None,
            Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri} → {response}");
    }
}

#[tokio::test]
async fn replacing_a_file_forwards_the_raw_body_and_the_target() {
    // 上传新版本替换原件:请求体就是新文件(8 MB 也要收得下),集合 / 路径 / 乐观锁的 sha 走查询参数
    let uploads = Arc::new(StubUploads::default());
    let file = vec![7u8; 8 * 1024 * 1024];
    let (status, body) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("PUT")
            .uri("/api/v1/files/replace?collection=_global&path=%E6%89%8B%E5%86%8C%2Fa.docx&expected_sha256=abc&session=tab-1")
            .body(Body::from(file))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        uploads.calls(),
        vec![format!(
            "replace:_global:手册/a.docx:{}:Some(\"abc\"):local:Some(\"tab-1\")",
            8 * 1024 * 1024
        )]
    );

    // 没有 path 参数:400,不调用后端
    let (status, _) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("PUT")
            .uri("/api/v1/files/replace?collection=_global")
            .body(Body::from("x"))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(uploads.calls().len(), 1);

    // GET 不是这个接口
    let (status, _) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("GET")
            .uri("/api/v1/files/replace?collection=_global&path=a.docx")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn the_roundtrip_check_forwards_the_resaved_bytes_and_is_post_only() {
    let uploads = Arc::new(StubUploads::default());
    let (status, body) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("POST")
            .uri("/api/v1/files/roundtrip-check?collection=_global&path=a.xlsx")
            .body(Body::from(vec![1u8; 1234]))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        uploads.calls(),
        vec!["roundtrip:_global:a.xlsx:1234:local".to_owned()]
    );

    // 缺 path:400;GET 不行
    let (status, _) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("POST")
            .uri("/api/v1/files/roundtrip-check?collection=_global")
            .body(Body::from("x"))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("GET")
            .uri("/api/v1/files/roundtrip-check?collection=_global&path=a.xlsx")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(uploads.calls().len(), 1);
}

#[tokio::test]
async fn the_edit_lock_routes_forward_session_and_target_and_check_the_method() {
    let uploads = Arc::new(StubUploads::default());
    // 申请 / 心跳:JSON 请求体
    let (status, body) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("POST")
            .uri("/api/v1/files/lock")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"collection":"_global","path":"手册/a.xlsx","session":"tab-1"}"#,
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["held"], true);
    // 接手
    let (status, _) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("POST")
            .uri("/api/v1/files/lock")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"collection":"_global","path":"a.xlsx","session":"tab-2","take_over":true}"#,
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // 交还:查询参数
    let (status, _) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("DELETE")
            .uri("/api/v1/files/lock?collection=_global&path=a.xlsx&session=tab-2")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        uploads.calls(),
        vec![
            "lock:_global:手册/a.xlsx:tab-1:false:local".to_owned(),
            "lock:_global:a.xlsx:tab-2:true:local".to_owned(),
            "unlock:_global:a.xlsx:tab-2:local".to_owned(),
        ]
    );

    // 缺会话编号:400,不调用后端;GET 不是这个接口
    let (status, _) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("POST")
            .uri("/api/v1/files/lock")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"collection":"_global","path":"a.xlsx"}"#))
            .unwrap(),
    )
    .await;
    assert!(status.is_client_error(), "缺 session 要被拒绝:{status}");
    let (status, _) = send(
        Some(uploads.clone()),
        Request::builder()
            .method("GET")
            .uri("/api/v1/files/lock?collection=_global&path=a.xlsx&session=x")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(uploads.calls().len(), 3);
}
