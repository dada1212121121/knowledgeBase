//! 跨 crate 的数据类型（设计规范）。
//!
//! 前半部分是检索链路上的核心类型(`RecordRow`、`StoreQuery`、`Chunk` …),
//! 后半部分是设计规范各张表的实体结构体:字段与列同名,时间统一是 [`Millis`],
//! JSON 列在 Rust 里用结构体或 `Vec<String>`(字段名省略 `_json` 后缀,注释里注明对应列)。

mod agent;
mod chat;
mod chunk;
mod collection;
mod file;
mod ingest;
mod insight;
mod item;
mod job;
mod link;
mod llm;
mod scan;
mod search;
mod source;
mod store;
mod token;
pub use agent::*;
pub use chat::*;
pub use chunk::*;
pub use collection::*;
pub use file::*;
pub use ingest::*;
pub use insight::*;
pub use item::*;
pub use job::*;
pub use link::*;
pub use llm::*;
pub use scan::*;
pub use search::*;
pub use source::*;
pub use store::*;
pub use token::*;

pub mod identity;

#[cfg(test)]
mod extract_meta_tests {
    use super::*;

    fn block(anchor: Anchor, block: Block) -> AnchoredBlock {
        AnchoredBlock { anchor, block }
    }

    fn doc(blocks: Vec<AnchoredBlock>) -> Doc {
        Doc {
            meta: DocMeta {
                source: "a.pdf".to_owned(),
                title: None,
                lang: "zh".to_owned(),
                mime: None,
                file_hash: "h".to_owned(),
                size: 1,
                mtime: 1,
                project_name: "demo".to_owned(),
            },
            blocks,
        }
    }

    #[test]
    fn pages_sheets_slides_and_duration_are_counted() {
        let text = |value: &str| Block::Paragraph {
            text: value.to_owned(),
        };
        let pdf = doc(vec![
            block(Anchor::Page { page: 1 }, text("第一页")),
            block(Anchor::Page { page: 3 }, text("第三页")),
        ]);
        let meta = ExtractMeta::from_doc(&pdf);
        assert_eq!(meta.pages, Some(3), "页数取最大页码");
        assert!(!meta.needs_ocr);

        let sheet = doc(vec![
            block(
                Anchor::Cell {
                    sheet: "Sheet1".to_owned(),
                    cell: "A1".to_owned(),
                },
                text("a"),
            ),
            block(
                Anchor::Cell {
                    sheet: "Sheet2".to_owned(),
                    cell: "B2".to_owned(),
                },
                text("b"),
            ),
            block(
                Anchor::Cell {
                    sheet: "Sheet1".to_owned(),
                    cell: "C3".to_owned(),
                },
                text("c"),
            ),
        ]);
        assert_eq!(ExtractMeta::from_doc(&sheet).sheets, Some(2), "工作表去重");

        let slides = doc(vec![block(Anchor::Slide { slide: 4 }, text("页"))]);
        assert_eq!(ExtractMeta::from_doc(&slides).slides, Some(4));
    }

    #[test]
    fn placeholder_captions_do_not_count_as_text() {
        // 与真实抽取器同形:未 OCR 的图片给一句带 needs_ocr 的**图注**;未转写的媒体给提示段落
        let image = doc(vec![block(
            Anchor::Page { page: 1 },
            Block::Image {
                caption: Some(
                    "图片未做 OCR(needs_ocr;开启 [extract] ocr_enabled 可识别文字)".to_owned(),
                ),
                ocr_text: None,
                resource: None,
            },
        )]);
        assert!(ExtractMeta::from_doc(&image).needs_ocr, "占位图注不算正文");

        // 与媒体抽取器同形:Media{None} + 一段带时间锚点的提示段落
        let media = doc(vec![
            block(
                Anchor::Time {
                    start_ms: 0,
                    end_ms: 60_000,
                },
                Block::Media { transcript: None },
            ),
            block(
                Anchor::Time {
                    start_ms: 0,
                    end_ms: 60_000,
                },
                Block::Paragraph {
                    text: "音视频未做转写(开启 [extract] transcribe_enabled 可转写)".to_owned(),
                },
            ),
        ]);
        let meta = ExtractMeta::from_doc(&media);
        assert!(meta.needs_ocr, "未转写的媒体要标出来(提示段落不算正文)");

        // 真转写了就不标
        let transcribed = doc(vec![
            block(
                Anchor::Time {
                    start_ms: 0,
                    end_ms: 60_000,
                },
                Block::Media {
                    transcript: Some("转写内容".to_owned()),
                },
            ),
            block(
                Anchor::Time {
                    start_ms: 0,
                    end_ms: 60_000,
                },
                Block::Paragraph {
                    text: "音视频未做转写(开启 [extract] transcribe_enabled 可转写)".to_owned(),
                },
            ),
        ]);
        assert!(!ExtractMeta::from_doc(&transcribed).needs_ocr);
    }

    #[test]
    fn media_without_text_marks_needs_ocr() {
        let image = doc(vec![block(
            Anchor::Page { page: 1 },
            Block::Image {
                caption: None,
                ocr_text: None,
                resource: None,
            },
        )]);
        let meta = ExtractMeta::from_doc(&image);
        assert!(meta.needs_ocr, "没有文字层的图片要标出来");
        let with_text = doc(vec![block(
            Anchor::Page { page: 1 },
            Block::Paragraph {
                text: "有文字".to_owned(),
            },
        )]);
        assert!(!ExtractMeta::from_doc(&with_text).needs_ocr);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quote(text: &str) -> Anchor {
        Anchor::Quote {
            text: text.to_owned(),
            prefix: "前".to_owned(),
            suffix: "后".to_owned(),
        }
    }

    #[test]
    fn quote_anchor_roundtrips_and_older_payloads_without_context_still_parse() {
        let json = serde_json::to_string(&quote("要评论的一句话")).expect("serialize");
        assert_eq!(
            json,
            r#"{"kind":"quote","text":"要评论的一句话","prefix":"前","suffix":"后"}"#
        );
        assert_eq!(
            serde_json::from_str::<Anchor>(&json).expect("parse"),
            quote("要评论的一句话")
        );
        // 前后文可以不带(只给摘录)
        let bare: Anchor = serde_json::from_str(r#"{"kind":"quote","text":"x"}"#).expect("parse");
        assert_eq!(
            bare,
            Anchor::Quote {
                text: "x".to_owned(),
                prefix: String::new(),
                suffix: String::new()
            }
        );
    }

    /// 抽取器写的“第 N 页没有文字层(needs_ocr)”只是预览提示,不能当正文入索引;
    /// 真做过 OCR 的图片块照旧算正文。
    #[test]
    fn needs_ocr_hint_is_not_content_but_ocr_text_is() {
        let hint = Block::Image {
            caption: Some("第 3 页没有文字层(needs_ocr)".to_owned()),
            ocr_text: None,
            resource: None,
        };
        assert!(hint.is_ocr_hint());
        // 提示图注仍然有字 —— 所以光靠 `is_empty` 拦不住它
        assert!(!hint.text().trim().is_empty());
        let recognised = Block::Image {
            caption: Some("第 3 页没有文字层(needs_ocr)".to_owned()),
            ocr_text: Some("识别出来的正文".to_owned()),
            resource: None,
        };
        assert!(!recognised.is_ocr_hint());
        let plain = Block::Image {
            caption: Some("附图:项目位置示意图".to_owned()),
            ocr_text: None,
            resource: None,
        };
        assert!(!plain.is_ocr_hint());
    }

    #[test]
    fn quote_label_is_the_start_of_the_quote_on_one_line() {
        assert_eq!(quote("短句").label(), "“短句”");
        assert_eq!(quote("第一行\n  第二行").label(), "“第一行 第二行”");
        let long = quote(&"字".repeat(40));
        assert_eq!(long.label(), format!("“{}…”", "字".repeat(24)));
    }

    #[test]
    fn untrusted_quote_anchors_are_bounded() {
        assert!(quote("正常").validate().is_ok());
        assert!(Anchor::Page { page: 1 }.validate().is_ok());
        assert!(quote("   ").validate().is_err(), "空白摘录没有意义");
        assert!(quote(&"字".repeat(MAX_QUOTE_CHARS)).validate().is_ok());
        assert!(quote(&"字".repeat(MAX_QUOTE_CHARS + 1)).validate().is_err());
        let wide_context = Anchor::Quote {
            text: "x".to_owned(),
            prefix: "字".repeat(MAX_QUOTE_CONTEXT_CHARS + 1),
            suffix: String::new(),
        };
        assert!(wide_context.validate().is_err());
    }

    #[test]
    fn record_kind_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&RecordKind::Insight).expect("serialize"),
            "\"insight\""
        );
        assert_eq!(RecordKind::Code.as_str(), "code");
        assert_eq!(RecordKind::Summary.as_str(), "summary");
    }

    #[test]
    fn item_status_roundtrips_and_lists_all() {
        let json = serde_json::to_string(&ItemStatus::Superseded).expect("serialize");
        assert_eq!(json, "\"superseded\"");
        let parsed: ItemStatus = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, ItemStatus::Superseded);
        assert_eq!(ItemStatus::ALL.len(), 3);
        assert_eq!(ItemStatus::Active.as_str(), "active");
    }

    #[test]
    fn record_row_roundtrips_through_json() {
        let row = RecordRow {
            id: "3f9c".to_owned(),
            collection: "proj_x".to_owned(),
            kind: RecordKind::Code,
            lang: Some("rust".to_owned()),
            source: "src/lib.rs".to_owned(),
            start_line: Some(1),
            end_line: Some(10),
            symbol: Some("fn main".to_owned()),
            title: None,
            text: "fn main() {}".to_owned(),
            header: "x › src/lib.rs › fn main".to_owned(),
            lex: "fn main".to_owned(),
            tags: vec!["a".to_owned()],
            status: ItemStatus::Active,
            content_hash: "0000000000000001".to_owned(),
            meta_hash: "0000000000000002".to_owned(),
            embed_input_hash: "0000000000000003".to_owned(),
            updated_at: 1_700_000_000_000,
            anchor: Some(Anchor::Page { page: 3 }),
            vector: Some(vec![0.1, 0.2]),
        };
        let json = serde_json::to_string(&row).expect("serialize");
        let parsed: RecordRow = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, row);
    }

    #[test]
    fn page_has_sensible_default() {
        assert_eq!(Page::default(), Page::new(Page::DEFAULT_LIMIT, 0));
    }

    #[test]
    fn job_state_and_edge_rel_strings() {
        assert_eq!(JobState::Queued.as_str(), "queued");
        assert_eq!(JobState::Canceled.as_str(), "canceled");
        assert_eq!(EdgeRel::AboutFile.as_str(), "about_file");
        assert_eq!(EdgeRel::DuplicateOf.as_str(), "duplicate_of");
        assert_eq!(InsightKind::Howto.as_str(), "howto");
    }

    #[test]
    fn source_and_ingest_enums_roundtrip() {
        // :数据库 / API 里的字符串必须能双向转换
        for kind in SourceKind::ALL {
            assert_eq!(SourceKind::parse(kind.as_str()), Some(kind));
        }
        for status in [
            SourceStatus::Idle,
            SourceStatus::Syncing,
            SourceStatus::Error,
        ] {
            assert_eq!(SourceStatus::parse(status.as_str()), Some(status));
        }
        for state in [
            UploadState::Pending,
            UploadState::Completed,
            UploadState::Aborted,
        ] {
            assert_eq!(UploadState::parse(state.as_str()), Some(state));
        }
        for state in [
            IngestState::Queued,
            IngestState::Extracting,
            IngestState::Chunking,
            IngestState::Embedding,
            IngestState::Done,
            IngestState::Failed,
            IngestState::Quarantined,
        ] {
            assert_eq!(IngestState::parse(state.as_str()), Some(state));
        }
        for strategy in [
            DedupStrategy::Skip,
            DedupStrategy::Overwrite,
            DedupStrategy::KeepBoth,
        ] {
            assert_eq!(DedupStrategy::parse(strategy.as_str()), Some(strategy));
        }
        // 未知取值要能被调用方识别(返回 None),而不是悄悄当成默认值
        assert_eq!(SourceKind::parse("ftp"), None);
        assert_eq!(IngestState::parse("parsing"), None);
        assert_eq!(DedupStrategy::default(), DedupStrategy::Skip);
        assert!(IngestState::Quarantined.is_terminal());
        assert!(!IngestState::Embedding.is_terminal());
    }
}

#[cfg(test)]
mod file_group_tests {
    use super::*;

    fn slice(id: &str, source: &str, start: Option<i32>, tags: &[&str], updated: i64) -> FileSlice {
        FileSlice {
            id: id.to_owned(),
            collection: "c".to_owned(),
            kind: RecordKind::Doc,
            lang: None,
            source: source.to_owned(),
            start_line: start,
            end_line: start,
            symbol: None,
            title: Some(format!("{source} › {id}")),
            tags: tags.iter().map(|t| (*t).to_owned()).collect(),
            status: ItemStatus::Active,
            updated_at: updated,
        }
    }

    #[test]
    fn chunks_of_one_file_become_one_entry_with_the_first_chunk_as_representative() {
        let files = group_by_file(vec![
            slice("c3", "a.md", Some(30), &["x"], 300),
            slice("c1", "a.md", Some(1), &["y", "x"], 100),
            slice("c2", "a.md", Some(10), &[], 200),
            slice("d1", "b.md", Some(1), &[], 50),
        ]);
        assert_eq!(files.len(), 2);
        let a = &files[0];
        assert_eq!(a.first.source, "a.md");
        assert_eq!(a.first.id, "c1", "代表块是起始行最小的那块");
        assert_eq!(a.chunks, 3);
        assert_eq!(
            a.tags,
            vec!["x".to_owned(), "y".to_owned()],
            "标签取并集、去重、排序"
        );
        assert_eq!(a.updated_at, 300, "更新时间取各块的最大值");
        assert_eq!(
            (files[1].first.source.as_str(), files[1].chunks),
            ("b.md", 1)
        );
    }

    #[test]
    fn the_result_does_not_depend_on_input_order() {
        let mut input = vec![
            slice("c2", "a.md", Some(10), &["t"], 2),
            slice("c1", "a.md", Some(1), &[], 1),
            slice("z", "z.md", None, &[], 9),
            slice("m", "m.md", Some(5), &[], 5),
        ];
        let forward = group_by_file(input.clone());
        input.reverse();
        assert_eq!(group_by_file(input), forward);
        let sources: Vec<&str> = forward.iter().map(|f| f.first.source.as_str()).collect();
        assert_eq!(sources, ["a.md", "m.md", "z.md"], "按 source 升序");
    }

    #[test]
    fn chunks_without_a_start_line_sort_first_and_ties_break_by_id() {
        let files = group_by_file(vec![
            slice("b", "a.md", Some(1), &[], 1),
            slice("a", "a.md", Some(1), &[], 1),
            slice("n", "a.md", None, &[], 1),
        ]);
        assert_eq!(files[0].first.id, "n");
        let tie = group_by_file(vec![
            slice("b", "a.md", Some(1), &[], 1),
            slice("a", "a.md", Some(1), &[], 1),
        ]);
        assert_eq!(tie[0].first.id, "a");
    }

    #[test]
    fn an_empty_input_gives_no_files() {
        assert!(group_by_file(Vec::new()).is_empty());
    }
}
