//! 改 Excel(xlsx)里几个单元格的值,其余一切原样保留。
//!
//! 做法:找到工作表对应的 XML,只改被点名的那几个 `<c>`(单元格),整张表的其余字节逐段原样拷贝;
//! 压缩包里只有这张表(和 workbook.xml,见下)被重写,图片、图表、样式、其它工作表都不碰(见 [`crate::zip::rewrite`])。
//!
//! 规则:
//! - **公式单元格不改**:那个格子的值是算出来的,改成固定值等于删掉公式;直接拒绝并说明是哪几格;
//! - 改了值,依赖它的公式要重算:在 workbook.xml 里打开 `fullCalcOnLoad`,Excel / WPS 打开时会全部重算。
//!   本系统的查看器读的是文件里缓存的计算结果,在重算之前那些公式格显示的还是旧值(界面会说明);
//! - 数字写成数字(保持能参与计算),其余写成文本;`007` 这种带前导零的、超过 15 位的按文本存,免得丢精度;
//! - 原来的格式(数字格式、字体、颜色,即 `s` 属性)保留;清空就是只留格式不留值。
//! - 不支持插入 / 删除行列、改合并单元格、改公式本身。

use std::collections::BTreeMap;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

use crate::zip::{ZipLimits, read_all, rewrite};

/// 一次最多改多少格(防手滑一次提交几十万格)。
pub const MAX_EDITS: usize = 2000;
/// Excel 单元格最多 32767 个字符。
pub const MAX_CELL_CHARS: usize = 32_767;
/// Excel 的上限:XFD 列、1048576 行。
const MAX_COLUMN: u32 = 16_384;
const MAX_ROW: u32 = 1_048_576;

/// 改一格。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CellEdit {
    /// 工作表名(和 Excel 底部页签上的一样)。
    pub sheet: String,
    /// 单元格地址,如 `B12`。
    pub cell: String,
    /// 新的值(空串 = 清空)。
    pub value: String,
}

/// 改值失败的原因(都是给人看的话)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditError(pub String);

impl std::fmt::Display for EditError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn fail<T>(message: impl Into<String>) -> Result<T, EditError> {
    Err(EditError(message.into()))
}

/// `AB12` → (列 1 起, 行 1 起);不是合法地址返回 `None`。
pub fn parse_cell(reference: &str) -> Option<(u32, u32)> {
    let reference = reference.trim();
    let letters = reference
        .bytes()
        .take_while(u8::is_ascii_alphabetic)
        .count();
    let (col_part, row_part) = reference.split_at(letters);
    if letters == 0
        || letters > 3
        || row_part.is_empty()
        || !row_part.bytes().all(|b| b.is_ascii_digit())
        || row_part.starts_with('0')
    {
        return None;
    }
    let column = col_part.bytes().fold(0u32, |acc, byte| {
        acc * 26 + u32::from(byte.to_ascii_uppercase() - b'A' + 1)
    });
    let row: u32 = row_part.parse().ok()?;
    (column <= MAX_COLUMN && row <= MAX_ROW).then_some((column, row))
}

fn column_name(mut column: u32) -> String {
    let mut name = String::new();
    while column > 0 {
        let remainder = ((column - 1) % 26) as u8;
        name.insert(0, (b'A' + remainder) as char);
        column = (column - 1) / 26;
    }
    name
}

fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

/// 值能不能按数字存:能参与计算的十进制数;带前导零 / 超过 15 位有效数字 / 带正号的按文本(Excel 会丢精度或改样子)。
fn as_number(value: &str) -> Option<&str> {
    let text = value.trim();
    if text != value || text.is_empty() || text.starts_with('+') {
        return None;
    }
    let digits = text.trim_start_matches('-');
    let integer = digits.split(['.', 'e', 'E']).next().unwrap_or("");
    if integer.len() > 1 && integer.starts_with('0') {
        return None;
    }
    if digits.bytes().filter(u8::is_ascii_digit).count() > 15 {
        return None;
    }
    let parsed: f64 = text.parse().ok()?;
    parsed.is_finite().then_some(text)
}
fn attr(start: &BytesStart<'_>, name: &[u8]) -> Option<String> {
    start
        .try_get_attribute(name)
        .ok()
        .flatten()
        .and_then(|value| {
            value
                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .ok()
        })
        .map(|value| value.into_owned())
}

/// 工作表名 → 它在压缩包里的 XML 路径(workbook.xml 的 `r:id` → workbook.xml.rels 的 Target)。
fn sheet_paths(workbook: &str, rels: &str) -> BTreeMap<String, String> {
    let mut ids: Vec<(String, String)> = Vec::new();
    let mut reader = Reader::from_str(workbook);
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag) | Event::Empty(tag)) if tag.name().as_ref() == b"sheet" => {
                if let (Some(name), Some(id)) = (attr(&tag, b"name"), attr(&tag, b"r:id")) {
                    ids.push((name, id));
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    let mut targets: BTreeMap<String, String> = BTreeMap::new();
    let mut reader = Reader::from_str(rels);
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag) | Event::Empty(tag)) if tag.name().as_ref() == b"Relationship" => {
                if let (Some(id), Some(target)) = (attr(&tag, b"Id"), attr(&tag, b"Target")) {
                    let path = match target.strip_prefix('/') {
                        Some(absolute) => absolute.to_owned(),
                        None => format!("xl/{target}"),
                    };
                    targets.insert(id, path);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    ids.into_iter()
        .filter_map(|(name, id)| targets.get(&id).map(|path| (name, path.clone())))
        .collect()
}

/// sheetData 里的一行。
struct Row {
    number: u32,
    /// `<row ...>` 开始标签的字节范围(自闭合的 `<row/>` 也在这里)。
    start: (usize, usize),
    /// `</row>` 的字节范围;自闭合的行没有。
    end: Option<(usize, usize)>,
    cells: Vec<Cell>,
}

/// 一行里的一格。
struct Cell {
    column: u32,
    span: (usize, usize),
    style: Option<String>,
    formula: bool,
}

struct Sheet {
    /// `<sheetData>` 开始标签的字节范围。
    data_start: (usize, usize),
    /// `</sheetData>` 的字节范围;自闭合 `<sheetData/>` 时是 `None`。
    data_end: Option<(usize, usize)>,
    rows: Vec<Row>,
}

/// 把工作表 XML 解析成"行 / 格 + 各自的字节位置",后面按位置拼出新的 XML(没动的部分逐字节保留)。
fn parse_sheet(xml: &str) -> Result<Sheet, EditError> {
    let mut reader = Reader::from_str(xml);
    let mut data_start: Option<(usize, usize)> = None;
    let mut data_end: Option<(usize, usize)> = None;
    let mut rows: Vec<Row> = Vec::new();
    let mut current: Option<Row> = None;
    let mut cell: Option<(usize, u32, Option<String>, bool)> = None;
    let mut next_row = 1u32;
    let mut next_col = 1u32;
    loop {
        let before = reader.buffer_position() as usize;
        let event = reader
            .read_event()
            .map_err(|err| EditError(format!("工作表格式不对,读不懂:{err}")))?;
        let after = reader.buffer_position() as usize;
        match event {
            Event::Start(tag) | Event::Empty(tag) if tag.name().as_ref() == b"sheetData" => {
                data_start = Some((before, after));
                if xml[before..after].trim_end().ends_with("/>") {
                    data_end = None;
                    break;
                }
            }
            Event::End(tag) if tag.name().as_ref() == b"sheetData" => {
                data_end = Some((before, after));
                break;
            }
            Event::Start(tag) | Event::Empty(tag)
                if data_start.is_some() && tag.name().as_ref() == b"row" =>
            {
                let number = attr(&tag, b"r")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(next_row);
                next_row = number + 1;
                next_col = 1;
                let closed = xml[before..after].trim_end().ends_with("/>");
                let row = Row {
                    number,
                    start: (before, after),
                    end: None,
                    cells: Vec::new(),
                };
                if closed {
                    rows.push(row);
                } else {
                    current = Some(row);
                }
            }
            Event::End(tag) if tag.name().as_ref() == b"row" => {
                if let Some(mut row) = current.take() {
                    row.end = Some((before, after));
                    rows.push(row);
                }
            }
            Event::Start(tag) | Event::Empty(tag)
                if current.is_some() && tag.name().as_ref() == b"c" =>
            {
                let column = attr(&tag, b"r")
                    .and_then(|value| parse_cell(&value))
                    .map_or(next_col, |(col, _)| col);
                next_col = column + 1;
                let style = attr(&tag, b"s");
                if xml[before..after].trim_end().ends_with("/>") {
                    current.as_mut().unwrap().cells.push(Cell {
                        column,
                        span: (before, after),
                        style,
                        formula: false,
                    });
                } else {
                    cell = Some((before, column, style, false));
                }
            }
            Event::Start(tag) | Event::Empty(tag) if tag.name().as_ref() == b"f" => {
                if let Some(open) = cell.as_mut() {
                    open.3 = true;
                }
            }
            Event::End(tag) if tag.name().as_ref() == b"c" => {
                if let (Some((start, column, style, formula)), Some(row)) =
                    (cell.take(), current.as_mut())
                {
                    row.cells.push(Cell {
                        column,
                        span: (start, after),
                        style,
                        formula,
                    });
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let data_start =
        data_start.ok_or_else(|| EditError("工作表里没有数据区(sheetData)".to_owned()))?;
    Ok(Sheet {
        data_start,
        data_end,
        rows,
    })
}

/// 新的一格。`style` 沿用原来的格式;值为空时只留格式(没有格式就不输出这一格)。
fn new_cell(column: u32, row: u32, style: Option<&str>, value: &str) -> String {
    let reference = format!("{}{row}", column_name(column));
    let style = style
        .map(|s| format!(r#" s="{}""#, xml_escape(s)))
        .unwrap_or_default();
    if value.is_empty() {
        return if style.is_empty() {
            String::new()
        } else {
            format!(r#"<c r="{reference}"{style}/>"#)
        };
    }
    match as_number(value) {
        Some(number) => format!(r#"<c r="{reference}"{style}><v>{number}</v></c>"#),
        None => format!(
            r#"<c r="{reference}"{style} t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#,
            xml_escape(value)
        ),
    }
}
/// 把一张表的改动写进它的 XML。`edits`:行号 → (列号 → 新值)。
fn apply_to_sheet(
    xml: &str,
    edits: &BTreeMap<u32, BTreeMap<u32, String>>,
) -> Result<String, EditError> {
    let sheet = parse_sheet(xml)?;
    // 先查公式格:一格都不动,整批拒绝,并列出是哪几格
    let mut formulas: Vec<String> = Vec::new();
    for row in &sheet.rows {
        if let Some(cols) = edits.get(&row.number) {
            for cell in &row.cells {
                if cell.formula && cols.contains_key(&cell.column) {
                    formulas.push(format!("{}{}", column_name(cell.column), row.number));
                }
            }
        }
    }
    if !formulas.is_empty() {
        return fail(format!(
            "{} 是公式算出来的,不能直接改值(改了就等于删掉公式);要改请在 Excel 里改公式",
            formulas.join("、")
        ));
    }

    let new_row = |number: u32, cols: &BTreeMap<u32, String>| -> String {
        let cells: String = cols
            .iter()
            .map(|(col, value)| new_cell(*col, number, None, value))
            .collect();
        if cells.is_empty() {
            String::new()
        } else {
            format!(r#"<row r="{number}">{cells}</row>"#)
        }
    };

    let mut out = String::with_capacity(xml.len() + 256);
    let mut cursor = 0usize;
    let mut pending = edits.iter().peekable();
    // sheetData 开始标签之前原样
    let (open_start, open_end) = sheet.data_start;
    if sheet.data_end.is_none() {
        // 自闭合的 <sheetData/>:展开成一对标签再放新行
        out.push_str(&xml[..open_start]);
        out.push_str("<sheetData>");
        for (number, cols) in pending.by_ref() {
            out.push_str(&new_row(*number, cols));
        }
        out.push_str("</sheetData>");
        out.push_str(&xml[open_end..]);
        return Ok(out);
    }
    for row in &sheet.rows {
        // 新的行插在第一条比它大的已有行前面
        while let Some((number, cols)) = pending.peek() {
            if **number >= row.number {
                break;
            }
            out.push_str(&xml[cursor..row.start.0]);
            cursor = row.start.0;
            out.push_str(&new_row(**number, cols));
            pending.next();
        }
        let Some(cols) = edits.get(&row.number) else {
            continue;
        };
        if pending
            .peek()
            .is_some_and(|(number, _)| **number == row.number)
        {
            pending.next();
        }
        out.push_str(&xml[cursor..row.start.0]);
        let tag = &xml[row.start.0..row.start.1];
        let mut todo: Vec<(u32, &String)> = cols.iter().map(|(col, value)| (*col, value)).collect();
        todo.reverse(); // 从小到大弹出
        match row.end {
            None => {
                // 自闭合的 <row .../>:改成开始标签 + 新格 + </row>
                out.push_str(tag.trim_end().trim_end_matches("/>").trim_end());
                out.push('>');
                while let Some((col, value)) = todo.pop() {
                    out.push_str(&new_cell(col, row.number, None, value));
                }
                out.push_str("</row>");
                cursor = row.start.1;
            }
            Some((end_start, end_end)) => {
                out.push_str(tag);
                let mut inner = row.start.1;
                for cell in &row.cells {
                    // 比这一格列号小的新格先放
                    while todo.last().is_some_and(|(col, _)| *col < cell.column) {
                        let (col, value) = todo.pop().unwrap();
                        out.push_str(&xml[inner..cell.span.0]);
                        inner = cell.span.0;
                        out.push_str(&new_cell(col, row.number, None, value));
                    }
                    out.push_str(&xml[inner..cell.span.0]);
                    if todo.last().is_some_and(|(col, _)| *col == cell.column) {
                        let (col, value) = todo.pop().unwrap();
                        out.push_str(&new_cell(col, row.number, cell.style.as_deref(), value));
                    } else {
                        out.push_str(&xml[cell.span.0..cell.span.1]);
                    }
                    inner = cell.span.1;
                }
                out.push_str(&xml[inner..end_start]);
                while let Some((col, value)) = todo.pop() {
                    out.push_str(&new_cell(col, row.number, None, value));
                }
                out.push_str(&xml[end_start..end_end]);
                cursor = end_end;
            }
        }
    }
    // 比所有已有行都靠后的新行:放在 </sheetData> 前
    let (close_start, _) = sheet.data_end.expect("上面已处理自闭合");
    out.push_str(&xml[cursor..close_start]);
    for (number, cols) in pending {
        out.push_str(&new_row(*number, cols));
    }
    out.push_str(&xml[close_start..]);
    Ok(out)
}

/// 打开"打开文件时全部重算"(`<calcPr fullCalcOnLoad="1"/>`):改了值,依赖它的公式要在 Excel / WPS 里刷新。
fn with_full_calc_on_load(workbook: &str) -> String {
    if let Some(at) = workbook.find("<calcPr") {
        let end = workbook[at..]
            .find('>')
            .map_or(workbook.len(), |offset| at + offset);
        let tag = &workbook[at..end];
        if tag.contains("fullCalcOnLoad=") {
            let fixed = tag
                .replace(r#"fullCalcOnLoad="0""#, r#"fullCalcOnLoad="1""#)
                .replace("fullCalcOnLoad='0'", "fullCalcOnLoad='1'");
            return format!("{}{fixed}{}", &workbook[..at], &workbook[end..]);
        }
        return format!(
            "{} fullCalcOnLoad=\"1\"{}",
            &workbook[..at + "<calcPr".len()],
            &workbook[at + "<calcPr".len()..]
        );
    }
    match workbook.rfind("</workbook>") {
        Some(at) => format!(
            r#"{}<calcPr fullCalcOnLoad="1"/>{}"#,
            &workbook[..at],
            &workbook[at..]
        ),
        None => workbook.to_owned(),
    }
}

/// 改一份 xlsx 里若干单元格的值,返回新文件的字节。见模块说明。
pub fn edit_xlsx(bytes: &[u8], edits: &[CellEdit]) -> Result<Vec<u8>, EditError> {
    if edits.is_empty() {
        return fail("没有要改的单元格");
    }
    if edits.len() > MAX_EDITS {
        return fail(format!("一次最多改 {MAX_EDITS} 格"));
    }
    let entries = read_all(bytes, ZipLimits::default())
        .map_err(|err| EditError(format!("这不是能打开的 xlsx 文件:{err}")))?;
    let text_of = |name: &str| {
        entries
            .iter()
            .find(|entry| entry.name == name)
            .map(|entry| entry.text())
    };
    let workbook = text_of("xl/workbook.xml")
        .ok_or_else(|| EditError("xlsx 里缺少 xl/workbook.xml".to_owned()))?;
    let rels = text_of("xl/_rels/workbook.xml.rels").unwrap_or_default();
    let sheets = sheet_paths(&workbook, &rels);

    // 按工作表分组;同一格改了两次以最后一次为准
    let mut grouped: BTreeMap<String, BTreeMap<u32, BTreeMap<u32, String>>> = BTreeMap::new();
    for edit in edits {
        let (col, row) = parse_cell(&edit.cell)
            .ok_or_else(|| EditError(format!("{} 不是单元格地址", edit.cell)))?;
        if edit.value.chars().count() > MAX_CELL_CHARS {
            return fail(format!(
                "{}!{} 的内容超过 Excel 的上限 {MAX_CELL_CHARS} 个字",
                edit.sheet, edit.cell
            ));
        }
        if edit
            .value
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
        {
            return fail(format!(
                "{}!{} 里有不能写进表格的字符",
                edit.sheet, edit.cell
            ));
        }
        let path = sheets
            .get(&edit.sheet)
            .ok_or_else(|| EditError(format!("没有叫「{}」的工作表", edit.sheet)))?;
        grouped
            .entry(path.clone())
            .or_default()
            .entry(row)
            .or_default()
            .insert(col, edit.value.clone());
    }

    let mut replaced: Vec<(String, Vec<u8>)> = Vec::new();
    for (path, rows) in &grouped {
        let xml = text_of(path).ok_or_else(|| EditError(format!("xlsx 里缺少工作表 {path}")))?;
        let sheet_name = sheets
            .iter()
            .find(|(_, p)| *p == path)
            .map(|(name, _)| name.as_str())
            .unwrap_or(path);
        let edited = apply_to_sheet(&xml, rows)
            .map_err(|err| EditError(format!("工作表「{sheet_name}」:{err}")))?;
        replaced.push((path.clone(), edited.into_bytes()));
    }
    replaced.push((
        "xl/workbook.xml".to_owned(),
        with_full_calc_on_load(&workbook).into_bytes(),
    ));
    let refs: Vec<(&str, &[u8])> = replaced
        .iter()
        .map(|(name, data)| (name.as_str(), data.as_slice()))
        .collect();
    rewrite(bytes, &refs).map_err(|err| EditError(format!("写回 xlsx 失败:{err}")))
}

/// 每张工作表里哪些格子是公式(界面上把它们标成只读,不用等保存时才被拒)。
pub fn formula_cells(bytes: &[u8]) -> Result<BTreeMap<String, Vec<String>>, EditError> {
    let entries = read_all(bytes, ZipLimits::default())
        .map_err(|err| EditError(format!("这不是能打开的 xlsx 文件:{err}")))?;
    let text_of = |name: &str| {
        entries
            .iter()
            .find(|entry| entry.name == name)
            .map(|entry| entry.text())
    };
    let workbook = text_of("xl/workbook.xml").unwrap_or_default();
    let rels = text_of("xl/_rels/workbook.xml.rels").unwrap_or_default();
    let mut out = BTreeMap::new();
    for (name, path) in sheet_paths(&workbook, &rels) {
        let Some(xml) = text_of(&path) else { continue };
        let sheet = parse_sheet(&xml)?;
        let cells: Vec<String> = sheet
            .rows
            .iter()
            .flat_map(|row| {
                row.cells
                    .iter()
                    .filter(|cell| cell.formula)
                    .map(move |cell| format!("{}{}", column_name(cell.column), row.number))
            })
            .collect();
        out.insert(name, cells);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zip::build_stored_zip;

    const WORKBOOK: &str = r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="x" xmlns:r="r"><sheets><sheet name="预算" sheetId="1" r:id="rId1"/><sheet name="汇总" sheetId="2" r:id="rId2"/></sheets></workbook>"#;
    const RELS: &str = r#"<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t" Target="/xl/worksheets/sheet2.xml"/></Relationships>"#;
    // 第 1 行表头(共享字符串);第 2 行 A2 数字带格式、C2 是公式;第 4 行只有 B4;第 3 行不存在
    const SHEET1: &str = r#"<worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
  <row r="2"><c r="A2" s="3"><v>100</v></c><c r="C2"><f>A2*2</f><v>200</v></c></row>
  <row r="4"><c r="B4" t="inlineStr"><is><t>旧</t></is></c></row>
</sheetData></worksheet>"#;
    const SHEET2: &str = r#"<worksheet><sheetData/></worksheet>"#;
    const SHARED: &str = r#"<sst><si><t>项目</t></si><si><t>金额</t></si></sst>"#;
    const IMAGE: &[u8] = b"\x89PNG\x00\x01image-bytes";

    fn book() -> Vec<u8> {
        build_stored_zip(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("xl/workbook.xml", WORKBOOK.as_bytes()),
            ("xl/_rels/workbook.xml.rels", RELS.as_bytes()),
            ("xl/sharedStrings.xml", SHARED.as_bytes()),
            ("xl/worksheets/sheet1.xml", SHEET1.as_bytes()),
            ("xl/worksheets/sheet2.xml", SHEET2.as_bytes()),
            ("xl/media/image1.png", IMAGE),
        ])
    }

    fn edit(sheet: &str, cell: &str, value: &str) -> CellEdit {
        CellEdit {
            sheet: sheet.to_owned(),
            cell: cell.to_owned(),
            value: value.to_owned(),
        }
    }

    fn entry(bytes: &[u8], name: &str) -> Vec<u8> {
        read_all(bytes, ZipLimits::default())
            .unwrap()
            .into_iter()
            .find(|entry| entry.name == name)
            .unwrap()
            .data
    }

    fn sheet1(bytes: &[u8]) -> String {
        String::from_utf8(entry(bytes, "xl/worksheets/sheet1.xml")).unwrap()
    }

    #[test]
    fn cell_references_are_parsed_and_bounded() {
        assert_eq!(parse_cell("A1"), Some((1, 1)));
        assert_eq!(parse_cell("ab12"), Some((28, 12)));
        assert_eq!(parse_cell("XFD1048576"), Some((16_384, 1_048_576)));
        for bad in [
            "", "A", "12", "A0", "A01", "XFE1", "A1048577", "A1B", "AAAA1", "A 1",
        ] {
            assert_eq!(parse_cell(bad), None, "{bad}");
        }
    }

    #[test]
    fn numbers_stay_numbers_and_everything_else_is_text() {
        for number in ["0", "42", "-3.5", "1e3", "0.25"] {
            assert!(as_number(number).is_some(), "{number}");
        }
        // 前导零(编号)、正号、两头空格、超过 15 位(身份证 / 卡号)、非数字:都按文本存
        for text in [
            "007",
            "+5",
            " 5",
            "123456789012345678",
            "1,000",
            "abc",
            "NaN",
            "inf",
        ] {
            assert!(as_number(text).is_none(), "{text}");
        }
    }

    #[test]
    fn editing_existing_cells_keeps_style_and_everything_else() {
        let edited = edit_xlsx(
            &book(),
            &[
                edit("预算", "A2", "150"),
                edit("预算", "B4", "新的 <说明> & 备注"),
            ],
        )
        .expect("改值");
        let xml = sheet1(&edited);
        assert!(
            xml.contains(r#"<c r="A2" s="3"><v>150</v></c>"#),
            "数字保持数字、格式 s=3 保留:{xml}"
        );
        assert!(
            xml.contains("新的 &lt;说明&gt; &amp; 备注"),
            "文本要转义:{xml}"
        );
        assert!(
            xml.contains(r#"<c r="C2"><f>A2*2</f><v>200</v></c>"#),
            "公式格原样不动:{xml}"
        );
        assert!(
            xml.contains(r#"<c r="A1" t="s"><v>0</v></c>"#),
            "没改的格字节不变"
        );
        // 图片、共享字符串、另一张表都不变
        assert_eq!(entry(&edited, "xl/media/image1.png"), IMAGE);
        assert_eq!(entry(&edited, "xl/sharedStrings.xml"), SHARED.as_bytes());
        assert_eq!(
            entry(&edited, "xl/worksheets/sheet2.xml"),
            SHEET2.as_bytes()
        );
        // 依赖它的公式要在打开时重算
        assert!(
            String::from_utf8(entry(&edited, "xl/workbook.xml"))
                .unwrap()
                .contains(r#"fullCalcOnLoad="1""#)
        );
    }

    #[test]
    fn new_cells_and_rows_are_inserted_in_order() {
        let edited = edit_xlsx(
            &book(),
            &[
                edit("预算", "B2", "中间插一格"),
                edit("预算", "D2", "行尾加一格"),
                edit("预算", "A3", "全新的第 3 行"),
                edit("预算", "A9", "末尾的新行"),
            ],
        )
        .expect("改值");
        let xml = sheet1(&edited);
        let at = |needle: &str| {
            xml.find(needle)
                .unwrap_or_else(|| panic!("缺 {needle}:{xml}"))
        };
        assert!(
            at(r#"r="A2""#) < at(r#"r="B2""#)
                && at(r#"r="B2""#) < at(r#"r="C2""#)
                && at(r#"r="C2""#) < at(r#"r="D2""#),
            "同一行按列排:{xml}"
        );
        assert!(
            at(r#"<row r="2">"#) < at(r#"<row r="3">"#)
                && at(r#"<row r="3">"#) < at(r#"<row r="4">"#),
            "新行插在第 2、4 行之间:{xml}"
        );
        assert!(
            at(r#"<row r="4">"#) < at(r#"<row r="9">"#)
                && at(r#"<row r="9">"#) < at("</sheetData>")
        );
    }

    #[test]
    fn an_empty_sheet_gets_its_first_rows() {
        let edited = edit_xlsx(&book(), &[edit("汇总", "B2", "第一格")]).expect("改值");
        let xml = String::from_utf8(entry(&edited, "xl/worksheets/sheet2.xml")).unwrap();
        assert!(xml.contains(r#"<sheetData><row r="2"><c r="B2" t="inlineStr"><is><t xml:space="preserve">第一格</t></is></c></row></sheetData>"#), "{xml}");
    }

    #[test]
    fn clearing_keeps_the_format_but_drops_the_value() {
        let edited = edit_xlsx(&book(), &[edit("预算", "A2", "")]).expect("清空");
        assert!(sheet1(&edited).contains(r#"<c r="A2" s="3"/>"#));
    }

    #[test]
    fn formula_cells_unknown_sheets_and_bad_input_are_refused() {
        let err = edit_xlsx(
            &book(),
            &[edit("预算", "A2", "1"), edit("预算", "C2", "999")],
        )
        .expect_err("公式格");
        assert!(err.0.contains("C2") && err.0.contains("公式"), "{err}");
        assert!(
            edit_xlsx(&book(), &[edit("不存在", "A1", "1")])
                .unwrap_err()
                .0
                .contains("没有叫")
        );
        assert!(edit_xlsx(&book(), &[edit("预算", "A0", "1")]).is_err());
        assert!(edit_xlsx(&book(), &[]).is_err());
        assert!(edit_xlsx(&book(), &[edit("预算", "A1", "\u{7}")]).is_err());
        assert!(
            edit_xlsx(
                b"not a zip at all, definitely not",
                &[edit("预算", "A1", "1")]
            )
            .is_err()
        );
    }

    #[test]
    fn the_edited_file_reads_back_through_the_extractor() {
        let edited = edit_xlsx(
            &book(),
            &[edit("预算", "A2", "150"), edit("预算", "A3", "新增的一行")],
        )
        .expect("改值");
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let source = kb_core::model::SourceRef {
            scheme: "file".to_owned(),
            location: "预算.xlsx".to_owned(),
            project_root: None,
        };
        let doc = rt
            .block_on(kb_core::ports::Extractor::extract(
                &crate::XlsxExtractor,
                &source,
                &edited,
            ))
            .expect("抽取");
        let text = doc.text();
        assert!(
            text.contains("150") && text.contains("新增的一行"),
            "{text}"
        );
    }

    #[test]
    fn formula_cells_are_listed_per_sheet() {
        let listed = formula_cells(&book()).expect("列公式");
        assert_eq!(listed.get("预算"), Some(&vec!["C2".to_owned()]));
        assert_eq!(listed.get("汇总"), Some(&Vec::new()));
    }

    #[test]
    fn full_calc_flag_is_added_or_switched_on() {
        assert!(
            with_full_calc_on_load("<workbook><calcPr calcId=\"1\"/></workbook>")
                .contains(r#"<calcPr fullCalcOnLoad="1" calcId="1"/>"#)
        );
        assert!(
            with_full_calc_on_load(r#"<workbook><calcPr fullCalcOnLoad="0"/></workbook>"#)
                .contains(r#"fullCalcOnLoad="1""#)
        );
        assert_eq!(
            with_full_calc_on_load("<workbook></workbook>"),
            r#"<workbook><calcPr fullCalcOnLoad="1"/></workbook>"#
        );
    }
}
