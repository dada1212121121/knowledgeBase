//! 邮件(.eml)抽取:正文 + 附件。
//!
//! 自己写一个够用的 MIME 解析(不做 DKIM / 编码检测等):头部字段、`multipart/*` 边界、
//! `base64` / `quoted-printable` 解码、`Content-Disposition: attachment; filename=…`。
//!
//! 附件不在这里递归抽取(抽取器没有文件系统与索引上下文),而是由解析任务把附件落盘、
//! 生成各自的 `ingest_files` 行,再按自身类型走同一条抽取链路 —— 于是一封带 2 个附件的邮件
//! 会产生 3 个条目,并用 `derived_from` 边把它们关联到邮件本身。

/// 解析出来的邮件。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EmlMessage {
    /// `Subject`。
    pub subject: Option<String>,
    /// `From`。
    pub from: Option<String>,
    /// `Date`(原样)。
    pub date: Option<String>,
    /// 纯文本正文(优先 `text/plain`,没有就用 HTML 抽)。
    pub body_text: String,
    /// HTML 正文(原样,给 HTML 抽取器用)。
    pub body_html: Option<String>,
    /// 附件。
    pub attachments: Vec<EmlAttachment>,
}

/// 一个附件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmlAttachment {
    /// 文件名(没有时按序号生成)。
    pub filename: String,
    /// MIME 类型。
    pub content_type: String,
    /// 内容。
    pub data: Vec<u8>,
}

/// 解析一封邮件。
pub fn parse_eml(raw: &[u8]) -> EmlMessage {
    let text = String::from_utf8_lossy(raw).into_owned();
    let (headers, body) = split_headers(&text);
    let mut message = EmlMessage {
        subject: decode_header(headers.get("subject").map(String::as_str)),
        from: decode_header(headers.get("from").map(String::as_str)),
        date: headers.get("date").cloned(),
        ..EmlMessage::default()
    };
    let content_type = headers
        .get("content-type")
        .cloned()
        .unwrap_or_else(|| "text/plain".to_owned());
    let transfer = headers
        .get("content-transfer-encoding")
        .cloned()
        .unwrap_or_default();
    collect_part(&content_type, &transfer, body, &mut message, 0);
    if message.body_text.trim().is_empty()
        && let Some(html) = &message.body_html
    {
        message.body_text = crate::html::extract_html(html)
            .blocks
            .iter()
            .map(|block| block.text())
            .collect::<Vec<_>>()
            .join("\n");
    }
    message
}

/// 头部 → 正文。
fn split_headers(text: &str) -> (std::collections::HashMap<String, String>, &str) {
    let mut headers: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut offset = 0usize;
    let mut last_key: Option<String> = None;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            offset += line.len();
            break;
        }
        // 折行:以空白开头的是上一行的延续
        if trimmed.starts_with([' ', '\t'])
            && let Some(key) = &last_key
        {
            if let Some(value) = headers.get_mut(key) {
                value.push(' ');
                value.push_str(trimmed.trim());
            }
            offset += line.len();
            continue;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            let key = key.trim().to_ascii_lowercase();
            headers.insert(key.clone(), value.trim().to_owned());
            last_key = Some(key);
        }
        offset += line.len();
    }
    (headers, &text[offset..])
}

/// 递归收集一个 MIME 部分。
fn collect_part(
    content_type: &str,
    transfer: &str,
    body: &str,
    message: &mut EmlMessage,
    depth: usize,
) {
    if depth > 8 {
        return;
    }
    let (mime, params) = parse_content_type(content_type);
    if mime.starts_with("multipart/") {
        let Some(boundary) = params.get("boundary") else {
            return;
        };
        for part in split_multipart(body, boundary) {
            let (headers, part_body) = split_headers(part);
            let part_type = headers
                .get("content-type")
                .cloned()
                .unwrap_or_else(|| "text/plain".to_owned());
            let part_transfer = headers
                .get("content-transfer-encoding")
                .cloned()
                .unwrap_or_default();
            let disposition = headers
                .get("content-disposition")
                .cloned()
                .unwrap_or_default();
            let is_attachment = disposition.to_ascii_lowercase().contains("attachment");
            let filename = filename_of(&disposition)
                .or_else(|| params.get("name").cloned())
                .or_else(|| filename_of(&part_type));

            if is_attachment || (filename.is_some() && !part_type.starts_with("multipart/")) {
                let data = decode_body(part_body, &part_transfer);
                message.attachments.push(EmlAttachment {
                    filename: filename
                        .unwrap_or_else(|| format!("attachment-{}", message.attachments.len() + 1)),
                    content_type: parse_content_type(&part_type).0,
                    data,
                });
                continue;
            }
            collect_part(&part_type, &part_transfer, part_body, message, depth + 1);
        }
        return;
    }

    let data = decode_body(body, transfer);
    let text = String::from_utf8_lossy(&data).into_owned();
    if mime == "text/html" {
        message.body_html.get_or_insert(text);
    } else if mime == "text/plain" && message.body_text.is_empty() {
        message.body_text = text;
    }
}

/// `type/subtype; key=value` → (type/subtype, 参数表)。
fn parse_content_type(raw: &str) -> (String, std::collections::HashMap<String, String>) {
    let mut params = std::collections::HashMap::new();
    let mut parts = raw.split(';');
    let mime = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
    for part in parts {
        if let Some((key, value)) = part.split_once('=') {
            params.insert(
                key.trim().to_ascii_lowercase(),
                value.trim().trim_matches('"').to_owned(),
            );
        }
    }
    (mime, params)
}

/// 从 `Content-Disposition` / `Content-Type` 里取文件名。
fn filename_of(raw: &str) -> Option<String> {
    let lower = raw.to_ascii_lowercase();
    let index = lower.find("filename=")?;
    let rest = &raw[index + "filename=".len()..];
    let value = rest.trim_start_matches('"');
    let name: String = value
        .chars()
        .take_while(|ch| *ch != '"' && *ch != ';')
        .collect();
    let name = name.trim().to_owned();
    if name.is_empty() {
        None
    } else {
        Some(sanitize_filename(&name))
    }
}

/// 附件名只保留最后一段,挡掉路径穿越。
fn sanitize_filename(name: &str) -> String {
    name.rsplit(['/', '\\'])
        .next()
        .unwrap_or(name)
        .replace("..", "_")
        .trim()
        .to_owned()
}

/// 按边界切分 multipart。
fn split_multipart<'a>(body: &'a str, boundary: &str) -> Vec<&'a str> {
    let marker = format!("--{boundary}");
    let mut parts = Vec::new();
    let mut rest = body;
    // 跳过前言
    if let Some(index) = rest.find(&marker) {
        rest = &rest[index + marker.len()..];
    }
    loop {
        if rest.starts_with("--") {
            break;
        }
        rest = rest.trim_start_matches(['\r', '\n']);
        let Some(index) = rest.find(&marker) else {
            parts.push(rest);
            break;
        };
        parts.push(&rest[..index]);
        rest = &rest[index + marker.len()..];
    }
    parts
        .into_iter()
        .map(|part| part.trim_end_matches(['\r', '\n']))
        .filter(|part| !part.trim().is_empty())
        .collect()
}

/// 按传输编码解码正文。
fn decode_body(body: &str, transfer: &str) -> Vec<u8> {
    match transfer.trim().to_ascii_lowercase().as_str() {
        "base64" => {
            let cleaned: String = body.chars().filter(|ch| !ch.is_whitespace()).collect();
            base64_decode(&cleaned)
        }
        "quoted-printable" => quoted_printable_decode(body),
        _ => body.as_bytes().to_vec(),
    }
}

/// 标准 base64 解码(容忍缺失填充)。
fn base64_decode(input: &str) -> Vec<u8> {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in input.bytes() {
        if byte == b'=' {
            break;
        }
        let Some(value) = TABLE.iter().position(|item| *item == byte) else {
            continue;
        };
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

/// quoted-printable 解码。
fn quoted_printable_decode(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'=' => {
                // 软换行
                if bytes.get(index + 1) == Some(&b'\r') || bytes.get(index + 1) == Some(&b'\n') {
                    index += 1;
                    while matches!(bytes.get(index), Some(b'\r') | Some(b'\n')) {
                        index += 1;
                    }
                    continue;
                }
                if let (Some(high), Some(low)) = (bytes.get(index + 1), bytes.get(index + 2))
                    && let (Some(high), Some(low)) = (hex_value(*high), hex_value(*low))
                {
                    out.push(high * 16 + low);
                    index += 3;
                    continue;
                }
                out.push(b'=');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    out
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// 头部里的 `=?utf-8?B?…?=` / `=?utf-8?Q?…?=` 编码。
fn decode_header(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let mut out = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find("=?") {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find("?=") else {
            out.push_str(&rest[start..]);
            return Some(out);
        };
        let encoded = &rest[start + 2..start + end];
        let mut fields = encoded.splitn(3, '?');
        let charset = fields.next().unwrap_or_default();
        let mode = fields.next().unwrap_or_default();
        let payload = fields.next().unwrap_or_default();
        let bytes = match mode.to_ascii_uppercase().as_str() {
            "B" => base64_decode(payload),
            "Q" => quoted_printable_decode(&payload.replace('_', " ")),
            _ => payload.as_bytes().to_vec(),
        };
        out.push_str(&String::from_utf8_lossy(&bytes));
        let _ = charset;
        rest = &rest[start + end + 2..];
    }
    out.push_str(rest);
    Some(out.trim().to_owned())
}

/// 邮件抽取器:正文成块;附件由解析任务落盘后各自入队(见模块注释)。
pub struct EmlExtractor;

#[async_trait::async_trait]
impl kb_core::ports::Extractor for EmlExtractor {
    fn id(&self) -> &str {
        "message/rfc822"
    }

    fn detect(&self, head: &[u8], ext: &str) -> kb_core::model::Confidence {
        let head_text = String::from_utf8_lossy(&head[..head.len().min(2048)]).to_ascii_lowercase();
        // 有 RFC822 头(From: / Subject: / MIME-Version:)就认为是邮件
        if head_text.contains("\nfrom:")
            || head_text.starts_with("from:")
            || head_text.contains("\nmime-version:")
        {
            return kb_core::model::Confidence::Certain;
        }
        if ext.eq_ignore_ascii_case("eml") {
            kb_core::model::Confidence::Probable
        } else {
            kb_core::model::Confidence::Unlikely
        }
    }

    async fn extract(
        &self,
        source: &kb_core::model::SourceRef,
        bytes: &[u8],
    ) -> kb_core::Result<kb_core::model::Doc> {
        use kb_core::model::{Anchor, AnchoredBlock, Block, DocMeta};
        let message = parse_eml(bytes);
        let mut blocks = Vec::new();
        let mut ordinal = 0u32;
        if let Some(subject) = &message.subject {
            ordinal += 1;
            blocks.push(AnchoredBlock {
                anchor: Anchor::Line {
                    start: ordinal,
                    end: ordinal,
                },
                block: Block::Heading {
                    level: 1,
                    text: subject.clone(),
                },
            });
        }
        for paragraph in message.body_text.split("\n\n") {
            let body = paragraph.trim();
            if body.is_empty() {
                continue;
            }
            ordinal += 1;
            blocks.push(AnchoredBlock {
                anchor: Anchor::Line {
                    start: ordinal,
                    end: ordinal,
                },
                block: Block::Paragraph {
                    text: body.to_owned(),
                },
            });
        }
        Ok(kb_core::model::Doc {
            meta: DocMeta {
                source: source.location.clone(),
                title: message.subject.clone(),
                lang: "zh".to_owned(),
                mime: Some("message/rfc822".to_owned()),
                file_hash: kb_core::hash::content_hash(&String::from_utf8_lossy(bytes)),
                size: bytes.len() as u64,
                mtime: 0,
                project_name: source
                    .project_root
                    .as_ref()
                    .and_then(|root| root.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            },
            blocks,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eml_with_attachments() -> String {
        let attachment_one = "5L2g5aW977yM6ZmE5Lu25LiA";
        let attachment_two = "QXR0YWNobWVudCB0d28=";
        format!(
            "From: =?utf-8?B?5byg5LiJ?= <zhang@example.com>\r\n\
             Subject: =?utf-8?B?5ZGo5oql?=\r\n\
             Date: Mon, 20 Oct 2025 10:00:00 +0800\r\n\
             Content-Type: multipart/mixed; boundary=\"MIXED\"\r\n\
             \r\n\
             --MIXED\r\n\
             Content-Type: multipart/alternative; boundary=\"ALT\"\r\n\
             \r\n\
             --ALT\r\n\
             Content-Type: text/plain; charset=utf-8\r\n\
             \r\n\
             正文第一段。\r\n\
             --ALT\r\n\
             Content-Type: text/html; charset=utf-8\r\n\
             \r\n\
             <p>正文第一段。</p>\r\n\
             --ALT--\r\n\
             --MIXED\r\n\
             Content-Type: text/plain; name=\"notes.txt\"\r\n\
             Content-Disposition: attachment; filename=\"notes.txt\"\r\n\
             Content-Transfer-Encoding: base64\r\n\
             \r\n\
             {attachment_one}\r\n\
             --MIXED\r\n\
             Content-Type: text/markdown; name=\"readme.md\"\r\n\
             Content-Disposition: attachment; filename=\"readme.md\"\r\n\
             Content-Transfer-Encoding: base64\r\n\
             \r\n\
             {attachment_two}\r\n\
             --MIXED--\r\n"
        )
    }

    #[test]
    fn parses_body_and_attachments() {
        let message = parse_eml(eml_with_attachments().as_bytes());
        assert_eq!(message.subject.as_deref(), Some("周报"));
        assert_eq!(message.from.as_deref(), Some("张三 <zhang@example.com>"));
        assert!(message.body_text.contains("正文第一段"), "{message:?}");
        assert_eq!(message.attachments.len(), 2, "{message:?}");
        assert_eq!(message.attachments[0].filename, "notes.txt");
        assert_eq!(
            String::from_utf8_lossy(&message.attachments[0].data),
            "你好,附件一".replace(',', "，")
        );
        assert_eq!(message.attachments[1].filename, "readme.md");
        assert_eq!(
            String::from_utf8_lossy(&message.attachments[1].data),
            "Attachment two"
        );
    }

    #[test]
    fn quoted_printable_and_soft_breaks() {
        let body = "第一行=\r\n第二行=20with space";
        let decoded = String::from_utf8_lossy(&quoted_printable_decode(body)).into_owned();
        assert_eq!(decoded, "第一行第二行 with space");
    }

    #[test]
    fn attachment_names_cannot_escape() {
        let raw = "Content-Type: multipart/mixed; boundary=\"B\"\r\n\r\n\
                   --B\r\n\
                   Content-Type: application/octet-stream\r\n\
                   Content-Disposition: attachment; filename=\"../../etc/passwd\"\r\n\
                   \r\n\
                   data\r\n\
                   --B--\r\n";
        let message = parse_eml(raw.as_bytes());
        assert_eq!(message.attachments[0].filename, "passwd");
    }
}
