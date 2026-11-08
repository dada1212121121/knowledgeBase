//! CSV 抽取器(表格类里最轻的一种)。
//!
//! 输出一个 [`Block::Table`]:第一行当表头,其余按行;anchor 用
//! `Anchor::Cell { sheet, cell }`,`sheet` 取文件名,`cell` 是 `R<行号>`。
//! `DocChunker` 会把表格按行切块(表头随每一行),检索命中能定位到行。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{Anchor, AnchoredBlock, Block, Confidence, Doc, DocMeta, SourceRef};
use kb_core::ports::Extractor;

/// CSV / TSV 抽取器。
pub struct CsvExtractor {
    /// 分隔符(`,` 或 `\t`)。
    delimiter: char,
    /// 抽取器 id。
    id: &'static str,
}

impl CsvExtractor {
    /// 逗号分隔(扩展名 `.csv`)。
    pub fn comma() -> Self {
        Self {
            delimiter: ',',
            id: "text/csv",
        }
    }

    /// 制表符分隔(扩展名 `.tsv` / `.tab`)。
    pub fn tab() -> Self {
        Self {
            delimiter: '\t',
            id: "text/tab-separated-values",
        }
    }
}

#[async_trait]
impl Extractor for CsvExtractor {
    fn id(&self) -> &str {
        self.id
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        // 带 BOM 的 UTF-16 每个字符都夹着 NUL 字节,但它是正经的文本表格;只有没有 BOM 的含 NUL 内容才不是 CSV
        let utf16_bom = head.starts_with(&[0xFF, 0xFE]) || head.starts_with(&[0xFE, 0xFF]);
        if head.contains(&0u8) && !utf16_bom {
            return Confidence::Unlikely;
        }
        let ext = ext.trim_start_matches('.').to_ascii_lowercase();
        let expected: &[&str] = if self.delimiter == ',' {
            &["csv"]
        } else {
            &["tsv", "tab"]
        };
        if expected.contains(&ext.as_str()) {
            Confidence::Probable
        } else {
            Confidence::Unlikely
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let text = decode_text(bytes);
        let rows = parse_rows(&text, self.delimiter);
        let sheet = source
            .location
            .rsplit('/')
            .next()
            .unwrap_or(&source.location)
            .trim_end_matches(".csv")
            .trim_end_matches(".tsv")
            .trim_end_matches(".tab")
            .to_owned();
        let (header, body) = match rows.split_first() {
            Some((header, rest)) => (header.clone(), rest.to_vec()),
            None => (Vec::new(), Vec::new()),
        };
        let mut blocks = Vec::new();
        if !header.is_empty() {
            blocks.push(AnchoredBlock {
                anchor: Anchor::Cell {
                    sheet: sheet.clone(),
                    cell: "R1".to_owned(),
                },
                block: Block::Table {
                    header: header.clone(),
                    rows: body.clone(),
                },
            });
        }
        Ok(Doc {
            meta: DocMeta {
                source: source.location.clone(),
                title: Some(sheet),
                lang: "zh".to_owned(),
                mime: None,
                file_hash: kb_core::hash::content_hash(&text),
                size: text.len() as u64,
                mtime: 0,
                project_name: source
                    .project_root
                    .as_ref()
                    .and_then(|root| root.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            },
            blocks: blocks
                .into_iter()
                .filter(|block| !block.block.is_empty())
                .collect(),
        })
    }
}

/// 把 CSV / TSV 的原始字节解码成文本。
///
/// 顺序:带 BOM 的按 BOM 说的来(UTF-8 / UTF-16LE / UTF-16BE,BOM 本身去掉);
/// 没有 BOM 的先当 UTF-8;不是合法 UTF-8 的按 GB18030 试(GBK 是它的子集,
/// 中文 Windows 上 Excel「另存为 CSV」的默认编码);仍然解不开才退回有损的 UTF-8。
///
/// 以前一律 `String::from_utf8_lossy`:GBK 的 CSV 整张表变成乱码,搜不到;带 BOM 的 UTF-8
/// 把 BOM 混进第一个表头。没有覆盖 Big5 / Shift-JIS 这类其它编码:它们的字节落在 GB18030
/// 的合法范围内时会被当成 GB18030 解出乱码,和之前的结果一样不可用,不比以前更糟。
pub fn decode_text(bytes: &[u8]) -> String {
    if let Some((encoding, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = encoding.decode_without_bom_handling(&bytes[bom_len..]);
        return text.into_owned();
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    if let Some(text) =
        encoding_rs::GB18030.decode_without_bom_handling_and_without_replacement(bytes)
    {
        return text.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// 解析 CSV:支持双引号包裹、字段内的分隔符与换行、`""` 转义。
pub fn parse_rows(text: &str, delimiter: char) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if quoted => {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            }
            '"' if field.is_empty() && !quoted => quoted = true,
            c if c == delimiter && !quoted => {
                row.push(std::mem::take(&mut field));
            }
            '\r' if !quoted => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            '\n' if !quoted => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            other => field.push(other),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    // 去掉完全空白的行(表尾的换行)
    rows.retain(|row| row.iter().any(|field| !field.trim().is_empty()));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(location: &str) -> SourceRef {
        SourceRef {
            scheme: "file".to_owned(),
            location: location.to_owned(),
            project_root: None,
        }
    }

    #[test]
    fn parses_quotes_and_embedded_delimiters() {
        let rows = parse_rows("a,b\n\"x,1\",\"he said \"\"hi\"\"\"\n", ',');
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1], vec!["x,1".to_owned(), "he said \"hi\"".to_owned()]);
    }

    #[test]
    fn parses_multiline_fields() {
        let rows = parse_rows("a,b\n\"line1\nline2\",2\n", ',');
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1][0], "line1\nline2");
    }

    #[test]
    fn handles_crlf_and_trailing_newline() {
        let rows = parse_rows("a,b\r\n1,2\r\n", ',');
        assert_eq!(rows, vec![vec!["a", "b"], vec!["1", "2"]]);
    }

    #[tokio::test]
    async fn extract_builds_a_table_block_with_row_anchors() {
        let doc = CsvExtractor::comma()
            .extract(
                &source("data/报表.csv"),
                "名称,数量\n甲,1\n乙,2\n".as_bytes(),
            )
            .await
            .expect("抽取");
        assert_eq!(doc.blocks.len(), 1);
        match &doc.blocks[0].block {
            Block::Table { header, rows } => {
                assert_eq!(header, &vec!["名称".to_owned(), "数量".to_owned()]);
                assert_eq!(rows.len(), 2);
            }
            other => panic!("应是表格:{other:?}"),
        }
        assert_eq!(
            doc.blocks[0].anchor,
            Anchor::Cell {
                sheet: "报表".to_owned(),
                cell: "R1".to_owned()
            }
        );
    }

    #[test]
    fn detection_uses_extension() {
        assert_eq!(
            CsvExtractor::comma().detect(b"a,b", "csv"),
            Confidence::Probable
        );
        assert_eq!(
            CsvExtractor::tab().detect(b"a\tb", "tsv"),
            Confidence::Probable
        );
        assert_eq!(
            CsvExtractor::comma().detect(&[0u8, 1], "csv"),
            Confidence::Unlikely,
            "有 NUL 就不是 CSV"
        );
    }

    /// 取出抽取结果里的表格(表头, 数据行)。
    fn table_of(doc: &Doc) -> (Vec<String>, Vec<Vec<String>>) {
        match &doc.blocks[0].block {
            Block::Table { header, rows } => (header.clone(), rows.clone()),
            other => panic!("应是表格:{other:?}"),
        }
    }

    /// 中文 Windows 上 Excel「另存为 CSV」的默认编码是 GBK;以前按 UTF-8 有损转换,整张表变成乱码,搜不到。
    #[tokio::test]
    async fn gbk_encoded_csv_is_decoded_not_garbled() {
        let (bytes, _, _) = encoding_rs::GBK.encode("名称,数量\n甲,1\n乙,2\n");
        let doc = CsvExtractor::comma()
            .extract(&source("a.csv"), &bytes)
            .await
            .expect("抽取");
        let (header, rows) = table_of(&doc);
        assert_eq!(header, vec!["名称".to_owned(), "数量".to_owned()]);
        assert_eq!(rows[1][0], "乙");
    }

    /// 带 BOM 的 UTF-8(Excel「CSV UTF-8」):BOM 不能混进第一个表头。
    #[tokio::test]
    async fn utf8_bom_is_stripped_from_the_first_header() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("名称,数量\n甲,1\n".as_bytes());
        let doc = CsvExtractor::comma()
            .extract(&source("a.csv"), &bytes)
            .await
            .expect("抽取");
        let (header, _) = table_of(&doc);
        assert_eq!(header[0], "名称", "BOM 不应留在表头里:{:?}", header[0]);
    }

    /// 带 BOM 的 UTF-16(Excel「Unicode 文本」,通常是制表符分隔)。
    #[tokio::test]
    async fn utf16_with_bom_is_decoded() {
        for little_endian in [true, false] {
            let text = "名称\t数量\n甲\t1\n";
            let mut bytes: Vec<u8> = if little_endian {
                vec![0xFF, 0xFE]
            } else {
                vec![0xFE, 0xFF]
            };
            for unit in text.encode_utf16() {
                let pair = if little_endian {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                };
                bytes.extend_from_slice(&pair);
            }
            let doc = CsvExtractor::tab()
                .extract(&source("a.tsv"), &bytes)
                .await
                .expect("抽取");
            let (header, rows) = table_of(&doc);
            assert_eq!(header, vec!["名称".to_owned(), "数量".to_owned()]);
            assert_eq!(rows[0], vec!["甲".to_owned(), "1".to_owned()]);
        }
    }

    /// 合法的 UTF-8 原样通过,不被误判成 GBK。
    #[tokio::test]
    async fn plain_utf8_is_left_alone() {
        let doc = CsvExtractor::comma()
            .extract(&source("a.csv"), "名称,数量\n甲,1\n".as_bytes())
            .await
            .expect("抽取");
        let (header, _) = table_of(&doc);
        assert_eq!(header, vec!["名称".to_owned(), "数量".to_owned()]);
    }

    /// 既不是 UTF-8 也不是合法的 GB18030:退回有损转换,不 panic,能认出的 ASCII 部分保留。
    #[tokio::test]
    async fn undecodable_bytes_fall_back_without_panicking() {
        let bytes = b"a,b\n\x81\x20,1\n";
        let doc = CsvExtractor::comma()
            .extract(&source("a.csv"), bytes)
            .await
            .expect("抽取");
        let (header, rows) = table_of(&doc);
        assert_eq!(header, vec!["a".to_owned(), "b".to_owned()]);
        assert_eq!(rows[0][1], "1");
    }

    /// UTF-16 的文本里每个字符都带 NUL 字节,但带 BOM 时它是正经的表格,不能被「含 NUL 就不是 CSV」挡掉
    /// (上传流程在抽取器之前也会按 NUL 把它判成二进制,得靠这里认出来才会交给抽取器)。
    #[test]
    fn utf16_with_bom_is_detected_despite_nul_bytes() {
        assert_eq!(
            CsvExtractor::tab().detect(&[0xFF, 0xFE, b'a', 0x00, b'\t', 0x00], "tsv"),
            Confidence::Probable
        );
        assert_eq!(
            CsvExtractor::comma().detect(&[0xFE, 0xFF, 0x00, b'a', 0x00, b','], "csv"),
            Confidence::Probable
        );
        // 没有 BOM 的含 NUL 内容仍然不是 CSV
        assert_eq!(
            CsvExtractor::comma().detect(&[b'a', 0x00, b','], "csv"),
            Confidence::Unlikely
        );
    }

    /// 端到端:UTF-16 的 CSV 经注册表能挑到 CSV 抽取器(上传流程在抽取器之前按 NUL 把它判成二进制,
    /// 之后正是靠注册表的挑选把它捡回来)。
    #[test]
    fn registry_picks_the_csv_extractor_for_a_utf16_head() {
        let head = [0xFFu8, 0xFE, b'a', 0x00, b',', 0x00, b'b', 0x00];
        let registry = crate::default_registry();
        let (extractor, _) = registry.pick(&head, "csv").expect("应能挑到抽取器");
        assert_eq!(extractor.id(), "text/csv");
    }
}
