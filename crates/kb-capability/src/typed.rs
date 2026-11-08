//! 用 schemars 生成参数 schema、用 serde 解析参数的辅助函数。

use std::future::Future;

use kb_core::{KbError, Result};
use schemars::JsonSchema;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::invoke::CallCtx;
use crate::registry::Handler;

/// 生成一个类型的 JSON Schema。
pub fn schema<T: JsonSchema>() -> Value {
    let schema = schemars::schema_for!(T);
    let mut value =
        serde_json::to_value(schema).unwrap_or_else(|_| serde_json::json!({"type": "object"}));
    // 无参数的能力也要有 `properties`(MCP 客户端的 tool 定义要求对象形状统一)
    if value.get("type").and_then(Value::as_str) == Some("object")
        && value.get("properties").is_none()
        && let Some(object) = value.as_object_mut()
    {
        object.insert("properties".to_owned(), serde_json::json!({}));
    }
    value
}

/// 把 `f(ctx, Args) -> Result<Out>` 包成能力处理函数。
///
/// 参数解析失败返回 `InvalidInput`(对应设计规范的 400 / MCP 的 `-32602`),
/// 结果序列化失败返回 `Internal`。
pub fn typed<Args, Out, F, Fut>(f: F) -> Handler
where
    Args: DeserializeOwned + JsonSchema + Send + 'static,
    Out: Serialize + Send + 'static,
    F: Fn(CallCtx, Args) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Out>> + Send + 'static,
{
    let f = std::sync::Arc::new(f);
    std::sync::Arc::new(move |ctx: CallCtx, value: Value| {
        let f = f.clone();
        let future = async move {
            let args: Args = serde_json::from_value(value)
                .map_err(|err| KbError::InvalidInput(format!("参数不合法: {err}")))?;
            let output = f(ctx, args).await?;
            serde_json::to_value(output)
                .map_err(|err| KbError::Internal(format!("序列化结果失败: {err}")))
        };
        Box::pin(future) as crate::registry::BoxFuture
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::invoke::CallCtx;
    use crate::registry::{Permission, Surface};
    use serde::Deserialize;

    #[derive(Debug, Deserialize, JsonSchema)]
    struct EchoArgs {
        /// 要回显的文本。
        text: String,
        /// 重复次数。
        #[serde(default = "default_times")]
        times: usize,
    }

    fn default_times() -> usize {
        1
    }

    #[derive(Debug, Serialize)]
    struct EchoOut {
        echoed: String,
    }

    fn ctx() -> CallCtx {
        CallCtx::new("user", Surface::Mcp)
    }

    #[test]
    fn schema_marks_required_fields() {
        let schema = schema::<EchoArgs>();
        assert_eq!(schema["type"], "object");
        let required = schema["required"].as_array().expect("应有 required");
        assert!(required.iter().any(|value| value == "text"));
        assert!(
            !required.iter().any(|value| value == "times"),
            "有默认值的字段不应是必填:{required:?}"
        );
    }

    #[tokio::test]
    async fn typed_parses_and_serializes() {
        let handler = typed(|_ctx: CallCtx, args: EchoArgs| async move {
            Ok(EchoOut {
                echoed: args.text.repeat(args.times),
            })
        });
        let out = handler(ctx(), serde_json::json!({"text": "ab", "times": 2}))
            .await
            .expect("调用");
        assert_eq!(out["echoed"], "abab");

        // 缺省值生效
        let out = handler(ctx(), serde_json::json!({"text": "x"}))
            .await
            .expect("调用");
        assert_eq!(out["echoed"], "x");
    }

    #[tokio::test]
    async fn bad_arguments_are_invalid_input() {
        let handler =
            typed(|_ctx: CallCtx, args: EchoArgs| async move { Ok(EchoOut { echoed: args.text }) });
        let error = handler(ctx(), serde_json::json!({"times": 3}))
            .await
            .expect_err("缺必填字段应报错");
        assert!(matches!(error, KbError::InvalidInput(_)), "{error:?}");

        let error = handler(ctx(), serde_json::json!("不是对象"))
            .await
            .expect_err("类型不对应报错");
        assert!(matches!(error, KbError::InvalidInput(_)));
    }

    #[test]
    fn permission_helpers() {
        assert_eq!(Permission::Read.as_str(), "R");
        assert_eq!(Surface::Mcp.as_str(), "M");
    }
}
