//! CSV / TSV 的原样编辑:改几个格子、加删几行,**其余一个字节都不动**。
//!
//! 为什么不是「解析成表格 → 改 → 整份重新写出」:那样引号写法、行尾、字段两边的空格、重复的空行、
//! 编码(GBK / UTF-16 / 带 BOM 的 UTF-8)、分隔符全都会被改成程序的习惯,用户用 Excel 再打开时的样子
//! 和原来不一样,版本对比里整份文件都是改动。这里记下每个字段在文本里的位置,只把改动的那一小段
//! 替换成新内容,再用原来的编码编回去。
//!
//! 保证(单测逐条覆盖):
//! - 什么都不改直接保存,逐字节相同;
//! - 改一个格子,只有这个格子的字节变;原来带引号的格子仍带引号,原来没引号的只在必须时才加;
//! - 编码、BOM、分隔符、行尾(CRLF / LF / CR)、末尾有没有换行,都保持原样;
//! - 解不开、解开再编回去不是原来的字节、文件太大:拒绝编辑并说清楚,不冒险。
//!
//! 行号按「非空白行」数(和检索、表格预览看到的行一致);全空白的行原样留着,不占行号。

use std::collections::BTreeMap;

use kb_core::{KbError, Result};

use crate::text_codec::{Decoded, Encoding, encode};

/// 能在线编辑的文件大小上限(整份读进内存、整份编码回去)。
pub const MAX_EDIT_BYTES: usize = 32 * 1024 * 1024;
/// 一次提交最多多少个操作(防手滑一次提交几十万格)。
pub const MAX_OPS: usize = 5000;
/// 一个格子最多多少字符(Excel 的上限是 32767)。
pub const MAX_CELL_CHARS: usize = 32_767;
/// 一行最多多少列(Excel 的上限是 16384 列)。
pub const MAX_COLUMNS: usize = 16_384;

/// 行尾写法。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Newline {
    /// `\n`
    Lf,
    /// `\r\n`(Windows / Excel)
    CrLf,
    /// `\r`(老 Mac)
    Cr,
}

impl Newline {
    fn as_str(self) -> &'static str {
        match self {
            Self::Lf => "\n",
            Self::CrLf => "\r\n",
            Self::Cr => "\r",
        }
    }

    /// 稳定的英文标识。
    pub fn id(self) -> &'static str {
        match self {
            Self::Lf => "lf",
            Self::CrLf => "crlf",
            Self::Cr => "cr",
        }
    }
}

/// 文件的写法(接口里原样报给前端显示)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CsvFormat {
    /// 编码。
    pub encoding: Encoding,
    /// 分隔符。
    pub delimiter: char,
    /// 行尾。
    pub newline: Newline,
    /// 文件最后有没有换行。
    pub trailing_newline: bool,
}

/// 一个操作。行号、列号都从 0 开始,指的是**修改之前**的表。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CsvOp {
    /// 改一个格子;行或列超出现有范围时补空格子(列),行必须已经存在。
    SetCell {
        /// 行(非空白行的序号)。
        row: usize,
        /// 列。
        col: usize,
        /// 新内容。
        value: String,
    },
    /// 在第 `at` 行之前插入一行;`at` 等于行数就是加在最后。
    InsertRow {
        /// 位置。
        at: usize,
        /// 各列的内容。
        values: Vec<String>,
    },
    /// 删除一行。
    DeleteRow {
        /// 行。
        row: usize,
    },
}

#[derive(Debug)]
struct Field {
    /// 在文本里的范围(含引号)。
    start: usize,
    end: usize,
    quoted: bool,
    value: String,
}

#[derive(Debug)]
struct Record {
    start: usize,
    /// 最后一个字段结束的位置(不含行尾)。
    end: usize,
    /// 行尾之后的位置;最后一行没有换行时等于 `end`。
    term_end: usize,
    fields: Vec<Field>,
}

impl Record {
    fn is_blank(&self) -> bool {
        self.fields
            .iter()
            .all(|field| field.value.trim().is_empty())
    }
}

/// 打开的 CSV 文件。
#[derive(Debug)]
pub struct CsvDoc {
    original: Vec<u8>,
    text: String,
    format: CsvFormat,
    records: Vec<Record>,
    /// 非空白行在 `records` 里的下标。
    rows: Vec<usize>,
}

impl CsvDoc {
    /// 打开。`extension` 是扩展名(`tsv` 用制表符,其余在逗号 / 分号 / 制表符 / 竖线里按内容判断)。
    pub fn open(bytes: &[u8], extension: &str) -> Result<Self> {
        if bytes.len() > MAX_EDIT_BYTES {
            return Err(KbError::InvalidInput(format!(
                "文件有 {} MB,超过在线编辑的上限 {} MB;请下载后用 Excel 编辑",
                bytes.len() / (1024 * 1024),
                MAX_EDIT_BYTES / (1024 * 1024)
            )));
        }
        let decoded = Decoded::decode(bytes)?;
        if !decoded.round_trips(bytes) {
            return Err(KbError::InvalidInput(
                "这个文件的编码无法逐字节还原(解码再编码后字节不同),在线编辑可能改动没碰过的内容;请先另存为 UTF-8".to_owned(),
            ));
        }
        let Decoded { text, encoding } = decoded;
        let delimiter = if extension.eq_ignore_ascii_case("tsv") {
            '\t'
        } else {
            detect_delimiter(&text)
        };
        let records = parse_records(&text, delimiter);
        let rows = records
            .iter()
            .enumerate()
            .filter(|(_, record)| !record.is_blank())
            .map(|(index, _)| index)
            .collect();
        let newline = records
            .iter()
            .find(|record| record.term_end > record.end)
            .map_or(Newline::Lf, |record| {
                match &text[record.end..record.term_end] {
                    "\r\n" => Newline::CrLf,
                    "\r" => Newline::Cr,
                    _ => Newline::Lf,
                }
            });
        let trailing_newline = records
            .last()
            .is_some_and(|record| record.term_end > record.end);
        Ok(Self {
            original: bytes.to_vec(),
            text,
            format: CsvFormat {
                encoding,
                delimiter,
                newline,
                trailing_newline,
            },
            records,
            rows,
        })
    }

    /// 文件的写法。
    pub fn format(&self) -> CsvFormat {
        self.format
    }

    /// 行数(不含全空白的行)。
    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    /// 取一段行的内容。
    pub fn rows(&self, offset: usize, limit: usize) -> Vec<Vec<String>> {
        self.rows
            .iter()
            .skip(offset)
            .take(limit)
            .map(|&index| {
                self.records[index]
                    .fields
                    .iter()
                    .map(|field| field.value.clone())
                    .collect()
            })
            .collect()
    }

    /// 最宽的一行有几列。
    pub fn column_count(&self) -> usize {
        self.rows
            .iter()
            .map(|&index| self.records[index].fields.len())
            .max()
            .unwrap_or(0)
    }

    /// 应用一批操作,返回新文件的字节。什么都没变时返回的就是原来的字节。
    pub fn apply(&self, ops: &[CsvOp]) -> Result<Vec<u8>> {
        if ops.len() > MAX_OPS {
            return Err(KbError::InvalidInput(format!(
                "一次最多提交 {MAX_OPS} 个操作,这次有 {} 个",
                ops.len()
            )));
        }
        let delimiter = self.format.delimiter;
        let newline = self.format.newline.as_str();
        let row_record = |row: usize| -> Result<&Record> {
            self.rows
                .get(row)
                .map(|&index| &self.records[index])
                .ok_or_else(|| {
                    KbError::InvalidInput(format!(
                        "第 {} 行不存在(现在有 {} 行)",
                        row + 1,
                        self.rows.len()
                    ))
                })
        };

        // 先把操作按种类整理:格子改动同一格后写的算数,删除去重
        let mut cells: BTreeMap<(usize, usize), &str> = BTreeMap::new();
        let mut deleted: BTreeMap<usize, ()> = BTreeMap::new();
        let mut inserts: Vec<(usize, &[String])> = Vec::new();
        for op in ops {
            match op {
                CsvOp::SetCell { row, col, value } => {
                    row_record(*row)?;
                    check_value(value)?;
                    if *col >= MAX_COLUMNS {
                        return Err(KbError::InvalidInput(format!(
                            "第 {} 列超过上限 {MAX_COLUMNS} 列",
                            col + 1
                        )));
                    }
                    cells.insert((*row, *col), value);
                }
                CsvOp::DeleteRow { row } => {
                    row_record(*row)?;
                    deleted.insert(*row, ());
                }
                CsvOp::InsertRow { at, values } => {
                    if *at > self.rows.len() {
                        return Err(KbError::InvalidInput(format!(
                            "不能插到第 {} 行之前(现在只有 {} 行)",
                            at + 1,
                            self.rows.len()
                        )));
                    }
                    if values.len() > MAX_COLUMNS {
                        return Err(KbError::InvalidInput(format!("一行最多 {MAX_COLUMNS} 列")));
                    }
                    for value in values {
                        check_value(value)?;
                    }
                    inserts.push((*at, values));
                }
            }
        }
        if let Some((row, _)) = cells.keys().find(|(row, _)| deleted.contains_key(row)) {
            return Err(KbError::InvalidInput(format!(
                "第 {} 行同时被修改和删除",
                row + 1
            )));
        }

        // (起点, 终点, 替换成什么, 顺序号)——位置都是文本里的字节偏移
        let mut splices: Vec<(usize, usize, String, usize)> = Vec::new();
        let mut order = 0usize;
        let mut push = |start: usize, end: usize, with: String| {
            splices.push((start, end, with, order));
            order += 1;
        };

        // 1. 格子:已有的列只替换那个字段的范围;超出的列在行尾补上
        let mut by_row: BTreeMap<usize, BTreeMap<usize, &str>> = BTreeMap::new();
        for ((row, col), value) in &cells {
            by_row.entry(*row).or_default().insert(*col, value);
        }
        for (row, edits) in &by_row {
            let record = row_record(*row)?;
            for (&col, &value) in edits.range(..record.fields.len()) {
                let field = &record.fields[col];
                let replacement = serialize(value, delimiter, field.quoted);
                if self.text[field.start..field.end] != replacement {
                    push(field.start, field.end, replacement);
                }
            }
            if let Some((&last_col, _)) = edits.iter().next_back()
                && last_col >= record.fields.len()
            {
                let mut appended = String::new();
                for col in record.fields.len()..=last_col {
                    appended.push(delimiter);
                    if let Some(value) = edits.get(&col) {
                        appended.push_str(&serialize(value, delimiter, false));
                    }
                }
                push(record.end, record.end, appended);
            }
        }

        // 2. 删行:最后一行没有换行时,连它前面那个换行一起删,文件末尾仍然「没有换行」
        for &row in deleted.keys() {
            let record = row_record(row)?;
            let index = self.rows[row];
            if record.term_end == record.end && index > 0 {
                let previous = &self.records[index - 1];
                push(previous.end, record.end, String::new());
            } else {
                push(record.start, record.term_end, String::new());
            }
        }

        // 3. 插行
        for (at, values) in &inserts {
            let line = values
                .iter()
                .map(|value| serialize(value, delimiter, false))
                .collect::<Vec<_>>()
                .join(&delimiter.to_string());
            if *at < self.rows.len() {
                let record = &self.records[self.rows[*at]];
                push(record.start, record.start, format!("{line}{newline}"));
            } else if let Some(&last) = self.rows.last() {
                let record = &self.records[last];
                if record.term_end > record.end {
                    push(record.term_end, record.term_end, format!("{line}{newline}"));
                } else {
                    push(record.end, record.end, format!("{newline}{line}"));
                }
            } else {
                push(self.text.len(), self.text.len(), format!("{line}{newline}"));
            }
        }

        if splices.is_empty() {
            return Ok(self.original.clone());
        }
        let mut text = self.spliced(splices)?;
        // 原来最后一行后面没有换行、这次又把它删了:删掉它之前那行(也被删时)留下的换行不该变成新的结尾换行
        let dropped_unterminated_last = self.rows.last().is_some_and(|&index| {
            let record = &self.records[index];
            record.term_end == record.end && deleted.contains_key(&(self.rows.len() - 1))
        });
        if dropped_unterminated_last && text.ends_with(newline) {
            text.truncate(text.len() - newline.len());
        }
        if text == self.text {
            return Ok(self.original.clone());
        }
        encode(&text, self.format.encoding)
    }

    /// 按位置从后往前套用替换;重叠的纯删除合并,其它重叠说明操作互相冲突。
    fn spliced(&self, mut splices: Vec<(usize, usize, String, usize)>) -> Result<String> {
        splices.sort_by_key(|(start, end, _, order)| (*start, *end, *order));
        let mut merged: Vec<(usize, usize, String)> = Vec::with_capacity(splices.len());
        for (start, end, with, _) in splices {
            if let Some(last) = merged.last_mut()
                && start < last.1
            {
                let both_deletions = last.2.is_empty() && with.is_empty();
                if !both_deletions {
                    return Err(KbError::InvalidInput(
                        "这批操作互相冲突(同一处既要修改又要删除或插入),请分开提交".to_owned(),
                    ));
                }
                last.1 = last.1.max(end);
                continue;
            }
            merged.push((start, end, with));
        }
        let mut out = String::with_capacity(self.text.len());
        let mut cursor = 0;
        for (start, end, with) in merged {
            out.push_str(&self.text[cursor..start]);
            out.push_str(&with);
            cursor = end;
        }
        out.push_str(&self.text[cursor..]);
        Ok(out)
    }
}

fn check_value(value: &str) -> Result<()> {
    if value.chars().count() > MAX_CELL_CHARS {
        return Err(KbError::InvalidInput(format!(
            "一个格子最多 {MAX_CELL_CHARS} 个字符"
        )));
    }
    if value.contains('\0') {
        return Err(KbError::InvalidInput(
            "格子里不能有 NUL 字符(会让文件被当成二进制)".to_owned(),
        ));
    }
    Ok(())
}

/// 把一个值写成 CSV 里的一个字段:含分隔符、引号、换行的必须加引号;原来就带引号的保持带引号。
fn serialize(value: &str, delimiter: char, was_quoted: bool) -> String {
    let needs_quotes = value.contains(delimiter)
        || value.contains('"')
        || value.contains('\n')
        || value.contains('\r');
    if needs_quotes || was_quoted {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

/// 解析成带位置的记录。规则和 `csv::parse_rows` 一致(引号只在字段开头才算、`""` 转义、
/// 引号字段里可以有分隔符和换行),只是多记了每个字段在文本里的范围。
fn parse_records(text: &str, delimiter: char) -> Vec<Record> {
    let bytes = text.as_bytes();
    let delimiter = delimiter as u8;
    let len = bytes.len();
    let mut records = Vec::new();
    let mut i = 0;
    while i < len {
        let record_start = i;
        let mut fields = Vec::new();
        loop {
            let field_start = i;
            let mut value = String::new();
            let mut quoted = false;
            if i < len && bytes[i] == b'"' {
                quoted = true;
                i += 1;
                while i < len {
                    if bytes[i] == b'"' {
                        if i + 1 < len && bytes[i + 1] == b'"' {
                            value.push('"');
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        let ch = text[i..].chars().next().unwrap_or('\u{fffd}');
                        value.push(ch);
                        i += ch.len_utf8();
                    }
                }
            }
            // 引号收尾之后(或者根本没有引号):到分隔符 / 换行为止都算这个字段
            while i < len && bytes[i] != delimiter && bytes[i] != b'\n' && bytes[i] != b'\r' {
                let ch = text[i..].chars().next().unwrap_or('\u{fffd}');
                value.push(ch);
                i += ch.len_utf8();
            }
            fields.push(Field {
                start: field_start,
                end: i,
                quoted,
                value,
            });
            if i < len && bytes[i] == delimiter {
                i += 1;
                continue;
            }
            break;
        }
        let end = i;
        let term_end = if i < len && bytes[i] == b'\r' {
            if i + 1 < len && bytes[i + 1] == b'\n' {
                i + 2
            } else {
                i + 1
            }
        } else if i < len && bytes[i] == b'\n' {
            i + 1
        } else {
            i
        };
        records.push(Record {
            start: record_start,
            end,
            term_end,
            fields,
        });
        i = term_end;
    }
    records
}

/// 在逗号、分号、制表符、竖线里挑分隔符:对前 20 条记录,看哪个分出来的列数最整齐、最多。
/// 一个都不像(都只有一列)就用逗号。
fn detect_delimiter(text: &str) -> char {
    let mut best = (',', 0.0f64);
    for candidate in [',', ';', '\t', '|'] {
        let records: Vec<Record> = parse_records(text, candidate)
            .into_iter()
            .filter(|record| !record.is_blank())
            .take(20)
            .collect();
        if records.is_empty() {
            continue;
        }
        let mut widths: BTreeMap<usize, usize> = BTreeMap::new();
        for record in &records {
            *widths.entry(record.fields.len()).or_default() += 1;
        }
        let (&modal_width, &modal_count) = widths
            .iter()
            .max_by_key(|(width, count)| (**count, **width))
            .unwrap_or((&1, &0));
        if modal_width < 2 {
            continue;
        }
        // 整齐程度 × 列数:同样整齐时列数多的更像
        let score = (modal_count as f64 / records.len() as f64) * (modal_width as f64 - 1.0);
        if score > best.1 {
            best = (candidate, score);
        }
    }
    best.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(bytes: &[u8]) -> CsvDoc {
        CsvDoc::open(bytes, "csv").expect("打开")
    }

    fn set(row: usize, col: usize, value: &str) -> CsvOp {
        CsvOp::SetCell {
            row,
            col,
            value: value.to_owned(),
        }
    }

    fn applied(bytes: &[u8], ops: &[CsvOp]) -> Vec<u8> {
        open(bytes).apply(ops).expect("应用")
    }

    #[test]
    fn saving_without_changes_is_byte_identical_for_every_encoding_and_odd_layout() {
        let layouts: [&[u8]; 6] = [
            b"a,b\r\n1,2\r\n",
            b"a,b\n1,2",
            b"a;b\r\n\"x;y\";2\r\n\r\n\r\n",
            b"\"q\"\"uote\", spaced ,\n,,\n",
            b"name\tqty\n\xe8\x8b\xb9\xe6\x9e\x9c\t3\n",
            b"",
        ];
        for original in layouts {
            assert_eq!(applied(original, &[]), original, "{original:?}");
        }
        for encoding in [
            Encoding::Utf8Bom,
            Encoding::Utf16Le,
            Encoding::Utf16Be,
            Encoding::Gb18030,
        ] {
            let bytes = encode("名称,数量\r\n苹果,3\r\n", encoding).expect("编码");
            assert_eq!(applied(&bytes, &[]), bytes, "{encoding:?}");
            // 设成同样的值也不算改动
            assert_eq!(applied(&bytes, &[set(1, 0, "苹果")]), bytes, "{encoding:?}");
        }
    }

    #[test]
    fn changing_one_cell_changes_only_that_cell() {
        let original = b"id,name,note\r\n1,apple,\"red, sweet\"\r\n2,pear,green\r\n";
        let out = applied(original, &[set(1, 1, "APPLE")]);
        assert_eq!(
            out,
            b"id,name,note\r\n1,APPLE,\"red, sweet\"\r\n2,pear,green\r\n"
        );
        // 带引号的格子改了仍带引号,哪怕新内容不需要
        let out = applied(original, &[set(1, 2, "plain")]);
        assert_eq!(
            out,
            b"id,name,note\r\n1,apple,\"plain\"\r\n2,pear,green\r\n"
        );
        // 没引号的格子新内容含逗号 / 引号 / 换行才加引号
        let out = applied(original, &[set(2, 2, "a,b"), set(2, 1, "say \"hi\"")]);
        assert_eq!(
            out,
            b"id,name,note\r\n1,apple,\"red, sweet\"\r\n2,\"say \"\"hi\"\"\",\"a,b\"\r\n"
        );
        let out = applied(original, &[set(2, 2, "two\nlines")]);
        assert!(out.ends_with(b"2,pear,\"two\nlines\"\r\n"), "{out:?}");
    }

    #[test]
    fn encoding_bom_delimiter_and_line_endings_are_kept() {
        // GBK(GB18030)+ 分号 + CRLF,没有结尾换行
        let gbk = encode("名称;数量\r\n苹果;3", Encoding::Gb18030).expect("编码");
        let out = applied(&gbk, &[set(1, 1, "30")]);
        assert_eq!(
            out,
            encode("名称;数量\r\n苹果;30", Encoding::Gb18030).expect("编码")
        );
        assert_eq!(
            Decoded::decode(&out).expect("解码").encoding,
            Encoding::Gb18030
        );

        // UTF-8 BOM + 制表符
        let bom = b"\xef\xbb\xbfa\tb\n1\t2\n";
        let doc = CsvDoc::open(bom, "tsv").expect("打开");
        assert_eq!(doc.format().encoding, Encoding::Utf8Bom);
        assert_eq!(doc.format().delimiter, '\t');
        assert_eq!(
            doc.apply(&[set(1, 0, "x\ty")]).expect("应用"),
            b"\xef\xbb\xbfa\tb\n\"x\ty\"\t2\n"
        );

        // UTF-16LE
        let utf16 = encode("a,b\r\n1,2\r\n", Encoding::Utf16Le).expect("编码");
        assert_eq!(
            applied(&utf16, &[set(1, 1, "二")]),
            encode("a,b\r\n1,二\r\n", Encoding::Utf16Le).expect("编码")
        );

        // 行尾:CR 文件里新插入的行也用 CR
        let cr = b"a,b\r1,2\r";
        let out = applied(
            cr,
            &[CsvOp::InsertRow {
                at: 2,
                values: vec!["3".to_owned(), "4".to_owned()],
            }],
        );
        assert_eq!(out, b"a,b\r1,2\r3,4\r");
    }

    #[test]
    fn the_delimiter_is_detected_from_the_content_and_tsv_is_by_extension() {
        assert_eq!(open(b"a;b;c\n1;2;3\n").format().delimiter, ';');
        assert_eq!(open(b"a|b|c\n1|2|3\n").format().delimiter, '|');
        assert_eq!(open(b"a\tb\n1\t2\n").format().delimiter, '\t');
        assert_eq!(open(b"a,b,c\n1,2,3\n").format().delimiter, ',');
        // 只有一列、没有分隔符:逗号
        assert_eq!(open(b"just\nwords\n").format().delimiter, ',');
        // 逗号在引号里不算:这是分号分隔的文件
        assert_eq!(open(b"\"a,1\";b\n\"c,2\";d\n").format().delimiter, ';');
        // 扩展名是 tsv 就是制表符,不去猜
        let doc = CsvDoc::open(b"a,b\n1,2\n", "TSV").expect("打开");
        assert_eq!(doc.format().delimiter, '\t');
    }

    #[test]
    fn rows_ignore_blank_lines_but_the_bytes_of_blank_lines_are_kept() {
        let original = b"a,b\n\n1,2\n   ,  \n3,4\n";
        let doc = open(original);
        assert_eq!(doc.row_count(), 3);
        assert_eq!(
            doc.rows(0, 10),
            vec![
                vec!["a".to_owned(), "b".to_owned()],
                vec!["1".to_owned(), "2".to_owned()],
                vec!["3".to_owned(), "4".to_owned()],
            ]
        );
        assert_eq!(doc.rows(1, 1), vec![vec!["1".to_owned(), "2".to_owned()]]);
        let out = doc.apply(&[set(2, 0, "X")]).expect("应用");
        assert_eq!(out, b"a,b\n\n1,2\n   ,  \nX,4\n");
    }

    #[test]
    fn cells_past_the_end_of_a_row_pad_with_empty_columns() {
        let out = applied(b"a,b\n1,2\n", &[set(1, 4, "far")]);
        assert_eq!(out, b"a,b\n1,2,,,far\n");
        let out = applied(b"a,b\n1,2", &[set(0, 2, "c")]);
        assert_eq!(out, b"a,b,c\n1,2");
        // 同一行补两处
        let out = applied(b"a\n1\n", &[set(1, 1, "x"), set(1, 3, "y")]);
        assert_eq!(out, b"a\n1,x,,y\n");
    }

    #[test]
    fn rows_can_be_inserted_and_deleted_keeping_the_file_ending_style() {
        let ins = |at: usize, values: &[&str]| CsvOp::InsertRow {
            at,
            values: values.iter().map(|v| (*v).to_owned()).collect(),
        };
        let del = |row: usize| CsvOp::DeleteRow { row };
        // 中间插入、开头插入
        assert_eq!(
            applied(b"a,b\r\n1,2\r\n", &[ins(1, &["x", "y,z"])]),
            b"a,b\r\nx,\"y,z\"\r\n1,2\r\n"
        );
        assert_eq!(
            applied(b"a,b\n1,2\n", &[ins(0, &["h", "i"])]),
            b"h,i\na,b\n1,2\n"
        );
        // 末尾追加:原来有结尾换行就带结尾换行,没有就不带
        assert_eq!(
            applied(b"a,b\n1,2\n", &[ins(2, &["3", "4"])]),
            b"a,b\n1,2\n3,4\n"
        );
        assert_eq!(
            applied(b"a,b\n1,2", &[ins(2, &["3", "4"])]),
            b"a,b\n1,2\n3,4"
        );
        // 空文件里加第一行
        assert_eq!(applied(b"", &[ins(0, &["a", "b"])]), b"a,b\n");
        // 删除:中间的、最后一行(有换行 / 没换行)、连续两行
        assert_eq!(applied(b"a\nb\nc\n", &[del(1)]), b"a\nc\n");
        assert_eq!(applied(b"a\nb\nc\n", &[del(2)]), b"a\nb\n");
        assert_eq!(applied(b"a\nb\nc", &[del(2)]), b"a\nb");
        assert_eq!(applied(b"a\nb\nc", &[del(1), del(2)]), b"a");
        assert_eq!(applied(b"a\nb\nc\n", &[del(0), del(1), del(2)]), b"");
        // 同一批里:改一行、删一行、插一行,行号都指修改之前
        assert_eq!(
            applied(b"h\n1\n2\n3\n", &[set(1, 0, "ONE"), del(2), ins(4, &["4"])]),
            b"h\nONE\n3\n4\n"
        );
        // 插入的行和被删的行的行号都是修改之前的
        assert_eq!(
            applied(b"a\nb\nc\n", &[del(1), ins(1, &["new"])]),
            b"a\nnew\nc\n"
        );
    }

    #[test]
    fn nothing_outside_the_edited_cell_changes_even_with_odd_quoting() {
        // 引号收尾后还有字符、字段两边的空格、空字段、重复的引号:都原样留着
        let original = b"\"a\"x, b ,\"\"\"q\"\"\",,tail\n";
        let out = applied(original, &[set(0, 3, "mid")]);
        assert_eq!(out, b"\"a\"x, b ,\"\"\"q\"\"\",mid,tail\n");
        let doc = open(original);
        assert_eq!(doc.rows(0, 1)[0], vec!["ax", " b ", "\"q\"", "", "tail"]);
    }

    #[test]
    fn bad_requests_are_rejected_with_a_clear_reason() {
        let doc = open(b"a,b\n1,2\n");
        for (ops, expect) in [
            (vec![set(5, 0, "x")], "第 6 行不存在"),
            (vec![CsvOp::DeleteRow { row: 9 }], "第 10 行不存在"),
            (
                vec![CsvOp::InsertRow {
                    at: 9,
                    values: Vec::new(),
                }],
                "不能插到第 10 行之前",
            ),
            (
                vec![set(0, 0, "x"), CsvOp::DeleteRow { row: 0 }],
                "同时被修改和删除",
            ),
            (vec![set(0, 0, "a\0b")], "NUL"),
            (vec![set(0, MAX_COLUMNS, "x")], "超过上限"),
        ] {
            let err = doc.apply(&ops).expect_err("应拒绝");
            assert!(err.to_string().contains(expect), "{ops:?} → {err}");
        }
        let many: Vec<CsvOp> = (0..=MAX_OPS).map(|_| set(0, 0, "x")).collect();
        assert!(doc.apply(&many).is_err());
        let huge = "x".repeat(MAX_CELL_CHARS + 1);
        assert!(doc.apply(&[set(0, 0, &huge)]).is_err());
    }

    #[test]
    fn adjacent_deletions_are_merged() {
        let doc = open(b"a\nb\nc\n");
        let out = doc
            .apply(&[CsvOp::DeleteRow { row: 0 }, CsvOp::DeleteRow { row: 1 }])
            .expect("连续删除");
        assert_eq!(out, b"c\n");
    }

    #[test]
    fn files_that_cannot_be_edited_safely_are_refused() {
        let err = CsvDoc::open(&[b'a', b',', 0xFF, 0xFF], "csv").expect_err("坏字节");
        assert!(err.to_string().contains("另存为 UTF-8"), "{err}");
        let big = vec![b'a'; MAX_EDIT_BYTES + 1];
        let err = CsvDoc::open(&big, "csv").expect_err("太大");
        assert!(err.to_string().contains("上限"), "{err}");
    }

    #[test]
    fn gbk_files_accept_rare_characters_and_stay_gbk() {
        // GB18030 覆盖全部 Unicode:GBK 里没有的生僻字和 emoji 写进去,文件仍是 GB18030,能原样解回来
        // 里面要有 GBK 字符:纯 ASCII 的文件按字节分不出是 GBK 还是 UTF-8,会被当成 UTF-8
        let gbk = encode("名称,b\n1,2\n", Encoding::Gb18030).expect("编码");
        let out = applied(&gbk, &[set(1, 1, "𠮷😀")]);
        let decoded = Decoded::decode(&out).expect("解码");
        assert_eq!(decoded.encoding, Encoding::Gb18030);
        assert_eq!(decoded.text, "名称,b\n1,𠮷😀\n");
    }
}
