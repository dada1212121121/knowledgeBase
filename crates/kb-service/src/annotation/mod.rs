//! 批注与“转 Markdown 副本”。
//! 拆成两半(2026-11-08,超长文件棘轮):
//! - `service`:标注的增删查与 Markdown 副本导出(带索引回写);
//! - `markdown`:正文渲染、图片导出、路径推导这些纯函数。
//!
//! 两个子模块各自 `use super::*` 之外还照抄了原来的整段 use——拆文件时不做
//! 逐符号裁剪,留给后面真的动到这些代码时再顺手删。
//!
//! - **批注**:锚定到页 / 单元格 / 幻灯片 / 时间点,存 `annotations` 表,同时写成一条可检索记录
//!   (`source = "<文件>#annotation:<id>"`,anchor 落库),这样检索能命中批注并跳回原位置;
//! - **转 Markdown 副本**:把中间文档渲染成 `.md`(标题层级、表格、代码块、图片导出到副本旁的
//!   `<副本名>.assets/`),副本作为独立条目入库,并用 `derived_from` 边指向原件;原件只读不变。

mod markdown;
mod service;

pub use markdown::{derived_path, render_markdown};
pub use service::{
    AddAnnotationRequest, AnnotationService, MarkdownCopyResult, MarkdownCopyService,
};

#[cfg(test)]
mod tests {
    use super::markdown::*;
    use super::*;

    use kb_core::model::{Anchor, Block, Doc};
    use kb_core::model::{AnchoredBlock, DocMeta};

    fn doc(blocks: Vec<AnchoredBlock>) -> Doc {
        Doc {
            meta: DocMeta {
                source: "report.docx".to_owned(),
                title: Some("季度报告".to_owned()),
                lang: "zh".to_owned(),
                mime: None,
                file_hash: "h".to_owned(),
                size: 0,
                mtime: 0,
                project_name: "demo".to_owned(),
            },
            blocks,
        }
    }

    #[test]
    fn renders_headings_tables_and_code() {
        let rendered = render_markdown(
            &doc(vec![
                AnchoredBlock {
                    anchor: Anchor::Line { start: 1, end: 1 },
                    block: Block::Heading {
                        level: 1,
                        text: "季度报告".to_owned(),
                    },
                },
                AnchoredBlock {
                    anchor: Anchor::Line { start: 2, end: 2 },
                    block: Block::Paragraph {
                        text: "正文一段。".to_owned(),
                    },
                },
                AnchoredBlock {
                    anchor: Anchor::Cell {
                        sheet: "Sheet1".to_owned(),
                        cell: "R1".to_owned(),
                    },
                    block: Block::Table {
                        header: vec!["项目".to_owned(), "金额".to_owned()],
                        rows: vec![vec!["研发".to_owned(), "42".to_owned()]],
                    },
                },
                AnchoredBlock {
                    anchor: Anchor::Line { start: 5, end: 5 },
                    block: Block::Code {
                        lang: "rust".to_owned(),
                        text: "fn main() {}".to_owned(),
                    },
                },
            ]),
            None,
        )
        .expect("渲染");
        let md = rendered.markdown;
        assert!(md.starts_with("# 季度报告"), "{md}");
        assert!(
            md.contains("## 季度报告") || md.contains("# 季度报告"),
            "{md}"
        );
        assert!(md.contains("| 项目 | 金额 |"), "{md}");
        assert!(md.contains("| --- | --- |"), "{md}");
        assert!(md.contains("| 研发 | 42 |"), "{md}");
        assert!(md.contains("```rust\nfn main() {}\n```"), "{md}");
        assert!(md.contains("正文一段。"), "{md}");
    }

    #[test]
    fn copy_path_keeps_the_directory() {
        assert_eq!(derived_path("a/b/report.docx"), "a/b/report.md");
        assert_eq!(derived_path("README"), "README.md");
    }

    #[test]
    fn images_are_counted_and_noted() {
        let rendered = render_markdown(
            &doc(vec![AnchoredBlock {
                anchor: Anchor::Page { page: 1 },
                block: Block::Image {
                    caption: Some("架构图".to_owned()),
                    ocr_text: Some("识别出的文字".to_owned()),
                    resource: None,
                },
            }]),
            None,
        )
        .expect("渲染");
        assert_eq!(rendered.images, 1);
        assert_eq!(rendered.exported, 0, "没有原图就不算导出");
        assert!(rendered.markdown.contains("图片:架构图"));
        assert!(rendered.markdown.contains("OCR:识别出的文字"));
    }

    fn picture(resource: &str, caption: Option<&str>) -> AnchoredBlock {
        AnchoredBlock {
            anchor: Anchor::Line { start: 1, end: 1 },
            block: Block::Image {
                caption: caption.map(str::to_owned),
                ocr_text: None,
                resource: Some(resource.to_owned()),
            },
        }
    }

    #[test]
    fn pictures_are_written_beside_the_copy_and_linked_relatively() {
        let container = kb_extract::zip::build_stored_zip(&[
            ("word/media/image1.png", b"PNG-ONE"),
            ("word/media/shot 2.JPG", b"JPG-TWO"),
            ("customXml/image1.png", b"PNG-OTHER"),
            ("word/media/evil.svg", b"<svg onload=alert(1)/>"),
        ]);
        let dir = tempfile::tempdir().expect("临时目录");
        let assets = dir.path().join("手册 v2.assets");
        let rendered = render_markdown(
            &doc(vec![
                picture("word/media/image1.png", Some("登录[页]\n面")),
                // 同一张图被引用两次:只写一份
                picture("word/media/image1.png", None),
                picture("word/media/shot 2.JPG", None),
                // 不同目录里的同名文件:加序号,不覆盖
                picture("customXml/image1.png", None),
                // 容器里没有的 / 扩展名不在白名单的:退回占位说明,不报错
                picture("word/media/missing.png", None),
                picture("word/media/evil.svg", None),
                // 路径穿越的写法只取最后一段,落在导出目录里
                picture("../../etc/passwd.png", None),
            ]),
            Some(&ImageExport {
                container: &container,
                dir: &assets,
                link_dir: "手册 v2.assets",
            }),
        )
        .expect("渲染");
        let md = rendered.markdown;
        assert_eq!(rendered.images, 7);
        assert_eq!(rendered.exported, 4, "{md}");
        // 目录名里的空格要转义,中文原样;图注里的方括号被换掉
        assert!(
            md.contains("![登录 页 面](手册%20v2.assets/image1.png)"),
            "{md}"
        );
        assert!(md.contains("(手册%20v2.assets/shot_2.jpg)"), "{md}");
        assert!(md.contains("(手册%20v2.assets/image1-2.png)"), "{md}");
        assert!(md.contains("> 图片:图片\n\n> 图片:图片"), "{md}");
        let mut names: Vec<String> = std::fs::read_dir(&assets)
            .expect("导出目录")
            .map(|entry| {
                entry
                    .expect("条目")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        assert_eq!(names, vec!["image1-2.png", "image1.png", "shot_2.jpg"]);
        assert_eq!(
            std::fs::read(assets.join("image1.png")).expect("读"),
            b"PNG-ONE"
        );
        assert_eq!(
            std::fs::read(assets.join("image1-2.png")).expect("读"),
            b"PNG-OTHER"
        );
        // 导出目录以外什么都没写
        assert_eq!(std::fs::read_dir(dir.path()).expect("目录").count(), 1);
    }

    #[test]
    fn link_segments_escape_only_what_breaks_markdown() {
        assert_eq!(link_segment("手册 v2.assets"), "手册%20v2.assets");
        assert_eq!(
            link_segment("a(1)[b]#c?d.png"),
            "a%281%29%5Bb%5D%23c%3Fd.png"
        );
        assert_eq!(link_segment("100%.png"), "100%25.png");
        assert_eq!(link_segment("plain-name_1.png"), "plain-name_1.png");
    }
}
