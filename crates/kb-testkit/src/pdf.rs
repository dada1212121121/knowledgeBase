//! 测试用的最小 PDF:单页、Helvetica、只有文字层。
//!
//! 中文 PDF 的文字层需要嵌字体,所以这里只覆盖“逐页取文字 + 按页锚点”这条链路
//! (中文扫描版走 OCR，见下文)。

/// 生成一份单页 PDF,正文是 `text`。
///
/// 手写 xref,不引任何 PDF 生成库;内容只用 ASCII(Helvetica 的标准编码)。
pub fn minimal(text: &str) -> Vec<u8> {
    let content = format!("BT /F1 12 Tf 20 100 Td ({text}) Tj ET");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R \
         /Resources << /Font << /F1 5 0 R >> >> >>"
            .to_owned(),
        format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len() + 1
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
    ];
    let mut out = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", index + 1));
    }
    let xref_at = out.len();
    out.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
    out.push_str("0000000000 65535 f \n");
    for offset in &offsets {
        out.push_str(&format!("{offset:010} 00000 n \n"));
    }
    out.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
        objects.len() + 1
    ));
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_pdf_has_the_expected_marks() {
        let bytes = minimal("hello world");
        assert!(bytes.starts_with(b"%PDF-1.4"));
        assert!(bytes.ends_with(b"%%EOF\n"));
        let text = String::from_utf8(bytes).expect("ASCII");
        assert!(text.contains("(hello world) Tj"));
        assert!(text.contains("/Count 1"));
    }
}
