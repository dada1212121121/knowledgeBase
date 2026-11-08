//! SQLite 读写的小工具:错误映射、JSON 列、布尔与枚举转换。

use kb_core::KbError;
use kb_core::model::{
    CollectionKind, ContextMode, DraftState, EdgeRel, InsightKind, ItemStatus, JobState,
};
use rusqlite::ErrorCode;

/// 把 rusqlite 的错误映射成 `KbError`;约束冲突归为参数错误。
pub(crate) fn map_sqlite_error(err: rusqlite::Error) -> KbError {
    if let rusqlite::Error::SqliteFailure(code, message) = &err
        && code.code == ErrorCode::ConstraintViolation
    {
        return KbError::InvalidInput(format!(
            "约束冲突: {}",
            message.clone().unwrap_or_else(|| err.to_string())
        ));
    }
    KbError::Internal(format!("sqlite: {err}"))
}

/// TEXT 列(JSON 数组)→ `Vec<String>`。
pub(crate) fn json_to_vec(value: &str) -> Result<Vec<String>, KbError> {
    serde_json::from_str(value)
        .map_err(|err| KbError::Internal(format!("解析 JSON 列失败: {err};原值: {value}")))
}

/// `Vec<String>` → TEXT 列(JSON 数组)。
pub(crate) fn vec_to_json(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_owned())
}

/// INTEGER 列 → bool。
pub(crate) fn int_to_bool(value: i64) -> bool {
    value != 0
}

/// bool → INTEGER 列。
pub(crate) fn bool_to_int(value: bool) -> i64 {
    i64::from(value)
}

macro_rules! text_enum {
    ($fn_name:ident, $ty:ty, [$($variant:path => $text:literal),+ $(,)?]) => {
        /// 把数据库里的字符串还原成枚举。
        pub(crate) fn $fn_name(value: &str) -> Result<$ty, KbError> {
            match value {
                $($text => Ok($variant),)+
                other => Err(KbError::Internal(format!(
                    concat!("数据库里出现未知的 ", stringify!($ty), " 取值: {}"),
                    other
                ))),
            }
        }
    };
}

text_enum!(parse_collection_kind, CollectionKind, [
    CollectionKind::Global => "global",
    CollectionKind::Project => "project",
    CollectionKind::External => "external",
]);

text_enum!(parse_context_mode, ContextMode, [
    ContextMode::Header => "header",
    ContextMode::Llm => "llm",
]);

text_enum!(parse_item_status, ItemStatus, [
    ItemStatus::Active => "active",
    ItemStatus::Superseded => "superseded",
    ItemStatus::Deprecated => "deprecated",
]);

text_enum!(parse_insight_kind, InsightKind, [
    InsightKind::Decision => "decision",
    InsightKind::Pitfall => "pitfall",
    InsightKind::Howto => "howto",
    InsightKind::Convention => "convention",
    InsightKind::Note => "note",
]);

text_enum!(parse_job_state, JobState, [
    JobState::Queued => "queued",
    JobState::Running => "running",
    JobState::Paused => "paused",
    JobState::Done => "done",
    JobState::Failed => "failed",
    JobState::Canceled => "canceled",
]);

text_enum!(parse_draft_state, DraftState, [
    DraftState::Pending => "pending",
    DraftState::Approved => "approved",
    DraftState::Revised => "revised",
    DraftState::Rejected => "rejected",
    DraftState::Duplicate => "duplicate",
]);

text_enum!(parse_edge_rel, EdgeRel, [
    EdgeRel::AboutFile => "about_file",
    EdgeRel::References => "references",
    EdgeRel::FromCommit => "from_commit",
    EdgeRel::Supersedes => "supersedes",
    EdgeRel::DerivedFrom => "derived_from",
    EdgeRel::DuplicateOf => "duplicate_of",
]);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_columns_roundtrip() {
        let values = vec!["a".to_owned(), "决策".to_owned()];
        let text = vec_to_json(&values);
        assert_eq!(text, r#"["a","决策"]"#);
        assert_eq!(json_to_vec(&text).expect("解析"), values);
        assert!(json_to_vec("not json").is_err());
    }

    #[test]
    fn bool_columns_roundtrip() {
        assert_eq!(bool_to_int(true), 1);
        assert_eq!(bool_to_int(false), 0);
        assert!(int_to_bool(1));
        assert!(!int_to_bool(0));
        assert!(int_to_bool(42));
    }

    #[test]
    fn text_enums_roundtrip() {
        assert_eq!(
            parse_item_status("superseded").expect("状态"),
            ItemStatus::Superseded
        );
        assert_eq!(
            parse_job_state("canceled").expect("任务状态"),
            JobState::Canceled
        );
        assert_eq!(
            parse_insight_kind("howto").expect("种类"),
            InsightKind::Howto
        );
        assert_eq!(
            parse_edge_rel("about_file").expect("关系"),
            EdgeRel::AboutFile
        );
        assert_eq!(
            parse_collection_kind("global").expect("collection"),
            CollectionKind::Global
        );
        assert_eq!(parse_context_mode("llm").expect("上下文"), ContextMode::Llm);
        assert_eq!(
            parse_draft_state("revised").expect("草稿"),
            DraftState::Revised
        );
        assert!(parse_item_status("bogus").is_err());
        assert!(parse_job_state("").is_err());
    }
}
