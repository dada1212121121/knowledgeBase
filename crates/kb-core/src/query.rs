//! 规则式 self-query 解析（设计规范）。
//!
//! 查询串里的 `kind:` / `lang:` / `path:` / `project:` / `tag:` / `status:` / `since:`
//! 前缀被解析成过滤条件,其余部分作为查询词。这里只做**语法**解析:
//! 值是否合法(例如 `lang` 的字符白名单)由 `kb-core::filter` 的 `Filter::to_sql` 校验。
//!
//! 解析是宽容的:未知前缀、无法识别的取值都原样留在查询词里,不会让检索失败。

/// `since:` 支持的时间范围。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Since {
    /// `since:30m`
    Minutes(u64),
    /// `since:12h`
    Hours(u64),
    /// `since:7d`
    Days(u64),
}

impl Since {
    /// 换算成毫秒(用于 `now - millis` 求 `updated_since`)。
    pub fn millis(&self) -> i64 {
        let (value, unit) = match self {
            Self::Minutes(value) => (*value, 60_000u64),
            Self::Hours(value) => (*value, 3_600_000u64),
            Self::Days(value) => (*value, 86_400_000u64),
        };
        i64::try_from(value.saturating_mul(unit)).unwrap_or(i64::MAX)
    }
}

/// 解析后的查询。
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ParsedQuery {
    /// 去掉前缀后剩下的查询词(保持原顺序,用单个空格连接)。
    pub text: String,
    /// `kind:` 过滤,可重复。
    pub kinds: Vec<String>,
    /// `lang:` 过滤。
    pub lang: Option<String>,
    /// `path:` 过滤(路径前缀)。
    pub path_prefix: Option<String>,
    /// `project:` 过滤。
    pub project: Option<String>,
    /// `tag:` 过滤。
    pub tag: Option<String>,
    /// `status:` 过滤:`all` / `active` / `superseded` / `deprecated`。
    pub status: Option<String>,
    /// `since:` 过滤。
    pub since: Option<Since>,
}

/// `kind:` 允许的取值(与设计规范的 `kind` 列一致)。
pub const RECORD_KINDS: [&str; 5] = ["code", "doc", "insight", "external", "summary"];

/// `status:` 允许的取值。
pub const ITEM_STATUSES: [&str; 4] = ["all", "active", "superseded", "deprecated"];

impl ParsedQuery {
    /// 解析查询串。
    pub fn parse(query: &str) -> Self {
        let mut parsed = Self::default();
        let mut words: Vec<&str> = Vec::new();
        for token in query.split_whitespace() {
            if !Self::apply_filter(&mut parsed, token) {
                words.push(token);
            }
        }
        parsed.text = words.join(" ");
        parsed
    }

    /// 尝试把一个 token 当成过滤条件;成功返回 `true`。
    fn apply_filter(&mut self, token: &str) -> bool {
        let Some((prefix, value)) = token.split_once(':') else {
            return false;
        };
        if value.is_empty() {
            return false;
        }
        match prefix {
            "kind" => {
                let kind = value.to_ascii_lowercase();
                if !RECORD_KINDS.contains(&kind.as_str()) {
                    return false;
                }
                if !self.kinds.contains(&kind) {
                    self.kinds.push(kind);
                }
                true
            }
            "status" => {
                let status = value.to_ascii_lowercase();
                if !ITEM_STATUSES.contains(&status.as_str()) {
                    return false;
                }
                self.status = Some(status);
                true
            }
            "lang" => {
                self.lang = Some(value.to_owned());
                true
            }
            "path" => {
                self.path_prefix = Some(value.to_owned());
                true
            }
            "project" => {
                self.project = Some(value.to_owned());
                true
            }
            "tag" => {
                self.tag = Some(value.to_owned());
                true
            }
            "since" => match parse_since(value) {
                Some(since) => {
                    self.since = Some(since);
                    true
                }
                None => false,
            },
            _ => false,
        }
    }

    /// 是否没有任何过滤条件。
    pub fn has_filters(&self) -> bool {
        !self.kinds.is_empty()
            || self.lang.is_some()
            || self.path_prefix.is_some()
            || self.project.is_some()
            || self.tag.is_some()
            || self.status.is_some()
            || self.since.is_some()
    }
}

/// 解析 `7d` / `12h` / `30m` 形式的时间范围。
pub fn parse_since(value: &str) -> Option<Since> {
    let (number, unit) = value.split_at(value.len().checked_sub(1)?);
    let amount: u64 = number.parse().ok()?;
    match unit {
        "m" => Some(Since::Minutes(amount)),
        "h" => Some(Since::Hours(amount)),
        "d" => Some(Since::Days(amount)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_prefixes_and_keeps_query_words() {
        let parsed = ParsedQuery::parse("kind:code lang:rust 增量索引 怎么实现");
        assert_eq!(parsed.text, "增量索引 怎么实现");
        assert_eq!(parsed.kinds, ["code"]);
        assert_eq!(parsed.lang.as_deref(), Some("rust"));
        assert!(parsed.has_filters());
    }

    #[test]
    fn parses_every_supported_prefix() {
        let parsed =
            ParsedQuery::parse("path:src/api project:SampleApp tag:决策 status:all since:7d");
        assert_eq!(parsed.text, "");
        assert_eq!(parsed.path_prefix.as_deref(), Some("src/api"));
        assert_eq!(parsed.project.as_deref(), Some("SampleApp"));
        assert_eq!(parsed.tag.as_deref(), Some("决策"));
        assert_eq!(parsed.status.as_deref(), Some("all"));
        assert_eq!(parsed.since, Some(Since::Days(7)));
    }

    #[test]
    fn unknown_or_invalid_prefixes_stay_in_text() {
        let parsed = ParsedQuery::parse("foo:bar 查询 status:whatever kind:bogus since:5y");
        assert_eq!(
            parsed.text,
            "foo:bar 查询 status:whatever kind:bogus since:5y"
        );
        assert!(!parsed.has_filters());
    }

    #[test]
    fn multiple_kinds_accumulate_without_duplicates() {
        let parsed = ParsedQuery::parse("kind:code kind:doc kind:code");
        assert_eq!(parsed.kinds, ["code", "doc"]);
    }

    #[test]
    fn since_units_and_millis() {
        assert_eq!(
            ParsedQuery::parse("since:30m").since,
            Some(Since::Minutes(30))
        );
        assert_eq!(
            ParsedQuery::parse("since:12h").since,
            Some(Since::Hours(12))
        );
        assert_eq!(ParsedQuery::parse("since:2d").since, Some(Since::Days(2)));
        assert_eq!(Since::Minutes(1).millis(), 60_000);
        assert_eq!(Since::Hours(1).millis(), 3_600_000);
        assert_eq!(Since::Days(1).millis(), 86_400_000);
        assert_eq!(parse_since("d"), None);
        assert_eq!(parse_since(""), None);
        assert_eq!(parse_since("7"), None);
    }

    #[test]
    fn empty_query_has_no_filters() {
        let parsed = ParsedQuery::parse("   ");
        assert_eq!(parsed, ParsedQuery::default());
        assert!(!parsed.has_filters());
    }

    #[test]
    fn kind_values_are_case_insensitive() {
        let parsed = ParsedQuery::parse("kind:Code status:ALL");
        assert_eq!(parsed.kinds, ["code"]);
        assert_eq!(parsed.status.as_deref(), Some("all"));
        assert_eq!(parsed.text, "");
    }
}
