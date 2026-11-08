//! 统一错误类型（设计规范）。

/// 统一的错误类型。
///
/// 与 HTTP 状态码的对应关系（设计规范）:`NotFound` 404、`InvalidInput` 400、`Conflict` 409、
/// `Unauthorized` 401、`Forbidden` 403、`Unavailable` 503、`Upstream` 502、`Internal` 500。
/// MCP 侧统一返回 `isError = true` 的文本结果,参数错误返回 `-32602`。
#[derive(thiserror::Error, Debug)]
pub enum KbError {
    /// 请求的对象不存在。
    #[error("not found: {0}")]
    NotFound(String),
    /// 参数不合法(包括配置校验失败)。
    #[error("invalid input: {0}")]
    InvalidInput(String),
    /// 乐观锁版本冲突。
    #[error("version conflict: expected {expected}, got {actual}")]
    Conflict {
        /// 调用方期望的版本。
        expected: i64,
        /// 存储中的实际版本。
        actual: i64,
    },
    /// 资源已存在 / 仍被占用(用户名已被占用、角色还有人在用……)。HTTP 409。
    #[error("already exists: {0}")]
    Exists(String),
    /// 未通过鉴权。
    #[error("unauthorized")]
    Unauthorized,
    /// 已鉴权但无权限。
    #[error("forbidden: {0}")]
    Forbidden(String),
    /// 依赖暂时不可用,例如 embedder 正在加载、sidecar 已停止。
    #[error("unavailable: {0}")]
    Unavailable(String),
    /// 上游(LLM / HTTP 后端)出错。
    #[error("upstream: {0}")]
    Upstream(String),
    /// 内部错误。
    #[error("internal: {0}")]
    Internal(String),
}

impl KbError {
    /// 稳定的机器可读错误码,用于 REST 响应体与 MCP 文本（设计规范）。
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "not_found",
            Self::InvalidInput(_) => "invalid_input",
            Self::Conflict { .. } => "conflict",
            Self::Exists(_) => "exists",
            Self::Unauthorized => "unauthorized",
            Self::Forbidden(_) => "forbidden",
            Self::Unavailable(_) => "unavailable",
            Self::Upstream(_) => "upstream",
            Self::Internal(_) => "internal",
        }
    }
}

/// 项目统一的结果别名。
pub type Result<T> = std::result::Result<T, KbError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_and_code_match_each_variant() {
        let cases = [
            (KbError::NotFound("x".into()), "not_found", "not found: x"),
            (KbError::Exists("x".into()), "exists", "already exists: x"),
            (
                KbError::InvalidInput("y".into()),
                "invalid_input",
                "invalid input: y",
            ),
            (
                KbError::Conflict {
                    expected: 1,
                    actual: 2,
                },
                "conflict",
                "version conflict: expected 1, got 2",
            ),
            (KbError::Unauthorized, "unauthorized", "unauthorized"),
            (KbError::Forbidden("z".into()), "forbidden", "forbidden: z"),
            (
                KbError::Unavailable("u".into()),
                "unavailable",
                "unavailable: u",
            ),
            (KbError::Upstream("o".into()), "upstream", "upstream: o"),
            (KbError::Internal("i".into()), "internal", "internal: i"),
        ];
        for (err, code, text) in cases {
            assert_eq!(err.code(), code);
            assert_eq!(err.to_string(), text);
        }
    }

    #[test]
    fn result_alias_carries_kb_error() {
        fn fail() -> Result<()> {
            Err(KbError::Internal("boom".into()))
        }
        assert!(matches!(fail(), Err(KbError::Internal(msg)) if msg == "boom"));
    }

    #[test]
    fn errors_are_std_error() {
        fn takes_std_error(_: &dyn std::error::Error) {}
        takes_std_error(&KbError::Unauthorized);
    }
}
