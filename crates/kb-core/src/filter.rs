//! 结构化过滤条件与 SQL 生成（设计规范）。
//!
//! **禁止**在任何地方手写 SQL 片段:传给 LanceDB 的 `only_if` / `delete` 条件只能来自
//! [`Filter::to_sql`],或者由已经校验过的 id 列表生成(已校验)。
//!
//! 转义规则:
//! - 字符串字面量里的 `'` 替换为 `''`;
//! - `LIKE` 模式里的 `%`、`_`、`\` 各加一个 `\` 前缀,并声明 `ESCAPE '\'`;
//! - 各条件用 `AND` 连接;没有任何条件时返回 `None`(调用方不应传空条件)。

use crate::error::{KbError, Result};
use crate::model::{ItemStatus, Millis, RecordKind};

/// 结构化过滤条件。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Filter {
    /// 记录种类;空 = 不限。
    pub kinds: Vec<RecordKind>,
    /// 状态;空 = 仅 `Active`,包含全部三种 = 不限。
    pub statuses: Vec<ItemStatus>,
    /// 语言白名单 `[a-z0-9_+-]{1,32}`。
    pub lang: Option<String>,
    /// 路径前缀,生成 `source LIKE '<转义>%' ESCAPE '\'`。
    pub path_prefix: Option<String>,
    /// 标签白名单 `[\p{L}\p{N}_.-]{1,64}`,生成 `tags LIKE '%,a,%'`。
    pub tag: Option<String>,
    /// 关键词(`list_items` 的 `q`):对 `title` / `symbol` / `source` 做不区分大小写的包含匹配。
    pub contains: Option<String>,
    /// 只保留这个时间之后更新的记录。
    pub updated_since: Option<Millis>,
    /// 只保留这些 id(白名单 `[0-9a-f-]{1,64}`)。
    pub ids: Vec<String>,
}

impl Filter {
    /// 生成 LanceDB 过滤表达式。
    ///
    /// 返回 `Ok(None)` 表示没有任何条件;参数不合法返回 [`KbError::InvalidInput`]。
    pub fn to_sql(&self) -> Result<Option<String>> {
        let mut clauses: Vec<String> = Vec::new();

        if !self.kinds.is_empty() {
            let values: Vec<String> = self
                .kinds
                .iter()
                .map(|kind| sql_string(kind.as_str()))
                .collect();
            clauses.push(format!("kind IN ({})", values.join(", ")));
        }

        clauses.extend(status_clause(&self.statuses));

        if let Some(lang) = &self.lang {
            validate_lang(lang)?;
            clauses.push(format!("lang = {}", sql_string(lang)));
        }

        if let Some(prefix) = &self.path_prefix {
            if prefix.contains('\0') {
                return Err(KbError::InvalidInput(
                    "path_prefix 不能包含 NUL 字符".to_owned(),
                ));
            }
            clauses.push(format!(
                "source LIKE {} ESCAPE '\\'",
                like_pattern(prefix, LikeShape::Prefix)
            ));
        }

        if let Some(tag) = &self.tag {
            validate_tag_value(tag)?;
            clauses.push(format!(
                "tags LIKE {} ESCAPE '\\'",
                like_pattern(tag, LikeShape::Tag)
            ));
        }

        if let Some(needle) = &self.contains {
            validate_contains(needle)?;
            // 两边都转小写:LanceDB 的 LIKE 区分大小写,用户输入 "Auth" 也要命中 "auth"
            let pattern = like_pattern(&needle.to_lowercase(), LikeShape::Contains);
            clauses.push(format!(
                "(lower(title) LIKE {pattern} ESCAPE '\\' \
                 OR lower(symbol) LIKE {pattern} ESCAPE '\\' \
                 OR lower(source) LIKE {pattern} ESCAPE '\\')"
            ));
        }

        if let Some(since) = self.updated_since {
            clauses.push(format!("updated_at >= {since}"));
        }

        if !self.ids.is_empty() {
            let mut values = Vec::with_capacity(self.ids.len());
            for id in &self.ids {
                validate_id(id)?;
                values.push(sql_string(id));
            }
            clauses.push(format!("id IN ({})", values.join(", ")));
        }

        Ok(if clauses.is_empty() {
            None
        } else {
            Some(clauses.join(" AND "))
        })
    }
}

/// 状态条件:空 = 仅 `active`;三种全含 = 不限。
fn status_clause(statuses: &[ItemStatus]) -> Option<String> {
    if statuses.is_empty() {
        return Some(format!(
            "status = {}",
            sql_string(ItemStatus::Active.as_str())
        ));
    }
    let mut unique: Vec<ItemStatus> = Vec::new();
    for status in statuses {
        if !unique.contains(status) {
            unique.push(*status);
        }
    }
    if unique.len() == ItemStatus::ALL.len() {
        // 包含全部三种状态 = 不限
        return None;
    }
    let values: Vec<String> = unique
        .iter()
        .map(|status| sql_string(status.as_str()))
        .collect();
    Some(format!("status IN ({})", values.join(", ")))
}

#[derive(Clone, Copy)]
enum LikeShape {
    /// 前缀匹配:`'<pattern>%'`
    Prefix,
    /// 标签匹配:`'%,<pattern>,%'`(tags 列存成 `,a,b,`)
    Tag,
    /// 包含匹配:`'%<pattern>%'`
    Contains,
}

fn like_pattern(value: &str, shape: LikeShape) -> String {
    let mut escaped = String::with_capacity(value.len() + 4);
    for ch in value.chars() {
        match ch {
            '%' | '_' | '\\' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            '\'' => escaped.push_str("''"),
            _ => escaped.push(ch),
        }
    }
    match shape {
        LikeShape::Prefix => format!("'{escaped}%'"),
        LikeShape::Tag => format!("'%,{escaped},%'"),
        LikeShape::Contains => format!("'%{escaped}%'"),
    }
}

/// 把值包成 SQL 字符串字面量,单引号转义为两个单引号。
fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn validate_lang(lang: &str) -> Result<()> {
    let valid = !lang.is_empty()
        && lang.len() <= 32
        && lang.chars().all(|ch| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | '+' | '-')
        });
    if valid {
        Ok(())
    } else {
        Err(KbError::InvalidInput(format!(
            "非法 lang {lang:?}:只允许 [a-z0-9_+-],长度 1..=32"
        )))
    }
}

/// 校验一个标签值:写入(upsert / 改标签)与过滤共用同一套规则。
///
/// 标签在 LanceDB 里编码成 `,a,b,`,所以**不允许**出现逗号,否则解码会串。
pub fn validate_tag_value(tag: &str) -> Result<()> {
    let valid = !tag.is_empty()
        && tag.chars().count() <= 64
        && tag
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '.' | '-'));
    if valid {
        Ok(())
    } else {
        Err(KbError::InvalidInput(format!(
            "非法 tag {tag:?}:只允许字母、数字与 _ . -,长度 1..=64(不能含逗号)"
        )))
    }
}

fn validate_contains(needle: &str) -> Result<()> {
    if needle.trim().is_empty() {
        return Err(KbError::InvalidInput("q 不能是空白字符串".to_owned()));
    }
    if needle.contains('\0') {
        return Err(KbError::InvalidInput("q 不能包含 NUL 字符".to_owned()));
    }
    if needle.chars().count() > 200 {
        return Err(KbError::InvalidInput(format!(
            "q 最长 200 个字符,收到 {} 个",
            needle.chars().count()
        )));
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<()> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|ch| ch.is_ascii_digit() || matches!(ch, 'a'..='f') || ch == '-');
    if valid {
        Ok(())
    } else {
        Err(KbError::InvalidInput(format!(
            "非法 id {id:?}:只允许 [0-9a-f-],长度 1..=64"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter() -> Filter {
        Filter::default()
    }

    #[test]
    fn filter_without_any_condition_returns_none() {
        // “不限状态”(显式包含全部三种)+ 没有其它条件 = 没有条件
        let f = Filter {
            statuses: ItemStatus::ALL.to_vec(),
            ..Filter::default()
        };
        assert_eq!(f.to_sql().expect("ok"), None);
    }

    #[test]
    fn default_filter_only_searches_active() {
        // statuses 为空 = 只取 active(设计规范的字段注释)
        let sql = filter().to_sql().expect("ok").expect("some");
        assert_eq!(sql, "status = 'active'");
    }

    #[test]
    fn all_three_statuses_mean_unlimited() {
        let mut f = filter();
        f.statuses = ItemStatus::ALL.to_vec();
        assert_eq!(f.to_sql().expect("ok"), None);
        // 重复值不应被误判成"全部"
        let mut f = filter();
        f.statuses = vec![ItemStatus::Active, ItemStatus::Active];
        assert_eq!(
            f.to_sql().expect("ok").expect("some"),
            "status IN ('active')"
        );
    }

    #[test]
    fn kinds_and_single_status_combine_with_and() {
        let mut f = filter();
        f.kinds = vec![RecordKind::Code, RecordKind::Doc];
        f.statuses = vec![ItemStatus::Active, ItemStatus::Deprecated];
        assert_eq!(
            f.to_sql().expect("ok").expect("some"),
            "kind IN ('code', 'doc') AND status IN ('active', 'deprecated')"
        );
    }

    #[test]
    fn path_with_single_quote_is_escaped() {
        let mut f = filter();
        f.path_prefix = Some("it's/a.rs".to_owned());
        assert_eq!(
            f.to_sql().expect("ok").expect("some"),
            "status = 'active' AND source LIKE 'it''s/a.rs%' ESCAPE '\\'"
        );
    }

    #[test]
    fn path_with_like_wildcards_is_escaped() {
        let mut f = filter();
        f.path_prefix = Some("src/100%_done\\x".to_owned());
        assert_eq!(
            f.to_sql().expect("ok").expect("some"),
            "status = 'active' AND source LIKE 'src/100\\%\\_done\\\\x%' ESCAPE '\\'"
        );
    }

    #[test]
    fn path_with_nul_is_rejected() {
        let mut f = filter();
        f.path_prefix = Some("a\0b".to_owned());
        assert!(matches!(f.to_sql(), Err(KbError::InvalidInput(_))));
    }

    #[test]
    fn invalid_lang_is_rejected() {
        let mut f = filter();
        f.lang = Some("rust' OR 1=1".to_owned());
        assert!(matches!(f.to_sql(), Err(KbError::InvalidInput(_))));
        // 合法值
        f.lang = Some("rust".to_owned());
        assert!(
            f.to_sql()
                .expect("ok")
                .expect("some")
                .contains("lang = 'rust'")
        );
        // 大小写与长度(注意 c++ 是合法的语言名,+ 在白名单里)
        for bad in ["Rust", "", "a b", &"a".repeat(33)] {
            f.lang = Some(bad.to_owned());
            assert!(f.to_sql().is_err(), "{bad:?} 应该被拒绝");
        }
    }

    #[test]
    fn tag_is_wrapped_for_contains_match() {
        let mut f = filter();
        f.tag = Some("决策".to_owned());
        assert_eq!(
            f.to_sql().expect("ok").expect("some"),
            "status = 'active' AND tags LIKE '%,决策,%' ESCAPE '\\'"
        );
        f.tag = Some("bad tag".to_owned());
        assert!(f.to_sql().is_err());
    }

    #[test]
    fn ids_are_validated_and_quoted() {
        let mut f = filter();
        f.ids = vec![
            "3f9c0a1e7b2d4c58a6e1f0b9d2c7a413".to_owned(),
            "abc-123".to_owned(),
        ];
        assert_eq!(
            f.to_sql().expect("ok").expect("some"),
            "status = 'active' AND id IN ('3f9c0a1e7b2d4c58a6e1f0b9d2c7a413', 'abc-123')"
        );
        for bad in ["", "XYZ", "a'b", &"a".repeat(65)] {
            f.ids = vec![bad.to_owned()];
            assert!(f.to_sql().is_err(), "{bad:?} 应该被拒绝");
        }
    }

    #[test]
    fn updated_since_is_a_numeric_comparison() {
        let mut f = filter();
        f.updated_since = Some(1_700_000_000_000);
        assert_eq!(
            f.to_sql().expect("ok").expect("some"),
            "status = 'active' AND updated_at >= 1700000000000"
        );
    }

    #[test]
    fn every_condition_is_and_joined() {
        let f = Filter {
            kinds: vec![RecordKind::Insight],
            statuses: vec![ItemStatus::Active],
            lang: Some("markdown".to_owned()),
            path_prefix: Some("docs/".to_owned()),
            tag: Some("a.b".to_owned()),
            contains: Some("Auth".to_owned()),
            updated_since: Some(5),
            ids: vec!["abc".to_owned()],
        };
        let sql = f.to_sql().expect("ok").expect("some");
        assert_eq!(
            sql,
            "kind IN ('insight') AND status IN ('active') AND lang = 'markdown' \
             AND source LIKE 'docs/%' ESCAPE '\\' AND tags LIKE '%,a.b,%' ESCAPE '\\' \
             AND (lower(title) LIKE '%auth%' ESCAPE '\\' OR lower(symbol) LIKE '%auth%' ESCAPE '\\' \
             OR lower(source) LIKE '%auth%' ESCAPE '\\') \
             AND updated_at >= 5 AND id IN ('abc')"
        );
        assert_eq!(sql.matches(" AND ").count(), 7);
    }

    #[test]
    fn contains_escapes_like_wildcards_and_quotes() {
        let f = Filter {
            contains: Some("it's 100%_x\\y".to_owned()),
            ..Filter::default()
        };
        let sql = f.to_sql().expect("ok").expect("some");
        assert!(
            sql.contains("lower(title) LIKE '%it''s 100\\%\\_x\\\\y%' ESCAPE '\\'"),
            "通配符与单引号都要转义:{sql}"
        );
    }

    #[test]
    fn contains_rejects_blank_and_overlong_input() {
        for needle in ["", "   ", &"x".repeat(201)] {
            let f = Filter {
                contains: Some(needle.to_owned()),
                ..Filter::default()
            };
            assert!(
                matches!(f.to_sql(), Err(KbError::InvalidInput(_))),
                "{needle:?} 应被拒绝"
            );
        }
        let f = Filter {
            contains: Some("a\0b".to_owned()),
            ..Filter::default()
        };
        assert!(matches!(f.to_sql(), Err(KbError::InvalidInput(_))));
    }
}
