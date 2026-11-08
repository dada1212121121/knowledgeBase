//! 文本文件的编码识别与无损往返(CSV / TSV 编辑用,也给其它文本编辑复用)。
//!
//! 和 `csv::decode_text`(检索用,解不开就退回有损的 UTF-8)不同,这里**严格**:编辑要写回原文件,
//! 解码时悄悄替换了坏字节,写回去就是损坏用户的文件。所以:
//! - 解不开(不是合法的 UTF-8,也不是合法的 GB18030)直接报错;
//! - 编码回去时有字符这个编码装不下(GBK 文件里写了 emoji),报错而不是替换成 `&#128512;` 之类;
//! - 解码再编码必须逐字节还原([`Decoded::round_trips`]),否则不允许编辑——GB18030 里有几处一对多的映射,
//!   解出来再编回去可能不是原来的字节。

use kb_core::{KbError, Result};

/// 支持的编码。UTF-16 只认带 BOM 的(没有 BOM 的 UTF-16 和二进制文件分不开)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    /// UTF-8,没有 BOM。
    Utf8,
    /// UTF-8,带 BOM(Excel 另存为「CSV UTF-8」就是这样)。
    Utf8Bom,
    /// UTF-16 小端,带 BOM(Excel 另存为「Unicode 文本」)。
    Utf16Le,
    /// UTF-16 大端,带 BOM。
    Utf16Be,
    /// GB18030(GBK 是它的子集;中文 Windows 上 Excel 另存为 CSV 的默认编码)。
    Gb18030,
}

impl Encoding {
    /// 给人看的名字。
    pub fn label(self) -> &'static str {
        match self {
            Self::Utf8 => "UTF-8",
            Self::Utf8Bom => "UTF-8(带 BOM)",
            Self::Utf16Le => "UTF-16LE",
            Self::Utf16Be => "UTF-16BE",
            Self::Gb18030 => "GB18030",
        }
    }

    /// 稳定的英文标识(接口里用)。
    pub fn id(self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::Utf8Bom => "utf-8-bom",
            Self::Utf16Le => "utf-16le",
            Self::Utf16Be => "utf-16be",
            Self::Gb18030 => "gb18030",
        }
    }
}

/// 解码结果。
#[derive(Clone, Debug)]
pub struct Decoded {
    /// 去掉 BOM 之后的文字。
    pub text: String,
    /// 原来的编码。
    pub encoding: Encoding,
}

impl Decoded {
    /// 严格解码:BOM 说了算;没有 BOM 先当 UTF-8,再按 GB18030;都不行报错。
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
            let text = std::str::from_utf8(rest)
                .map_err(|_| unreadable("文件带 UTF-8 BOM,但后面不是合法的 UTF-8"))?;
            return Ok(Self {
                text: text.to_owned(),
                encoding: Encoding::Utf8Bom,
            });
        }
        for (bom, encoding, decoder) in [
            ([0xFF, 0xFE], Encoding::Utf16Le, encoding_rs::UTF_16LE),
            ([0xFE, 0xFF], Encoding::Utf16Be, encoding_rs::UTF_16BE),
        ] {
            if let Some(rest) = bytes.strip_prefix(&bom) {
                let text = decoder
                    .decode_without_bom_handling_and_without_replacement(rest)
                    .ok_or_else(|| unreadable("文件带 UTF-16 BOM,但内容不是合法的 UTF-16"))?;
                return Ok(Self {
                    text: text.into_owned(),
                    encoding,
                });
            }
        }
        if let Ok(text) = std::str::from_utf8(bytes) {
            return Ok(Self {
                text: text.to_owned(),
                encoding: Encoding::Utf8,
            });
        }
        let text = encoding_rs::GB18030
            .decode_without_bom_handling_and_without_replacement(bytes)
            .ok_or_else(|| unreadable("既不是合法的 UTF-8,也不是合法的 GB18030"))?;
        Ok(Self {
            text: text.into_owned(),
            encoding: Encoding::Gb18030,
        })
    }

    /// 按原来的编码编回去,是不是和 `original` 逐字节相同。不相同就不能编辑。
    pub fn round_trips(&self, original: &[u8]) -> bool {
        encode(&self.text, self.encoding).is_ok_and(|bytes| bytes == original)
    }
}

fn unreadable(detail: &str) -> KbError {
    KbError::InvalidInput(format!(
        "无法安全地读取这个文件的文字:{detail}。为避免写回时损坏内容,不允许在线编辑;请先用 Excel 或文本编辑器另存为 UTF-8"
    ))
}

/// 按指定编码编码;这个编码装不下的字符报错(不替换)。
pub fn encode(text: &str, encoding: Encoding) -> Result<Vec<u8>> {
    match encoding {
        Encoding::Utf8 => Ok(text.as_bytes().to_vec()),
        Encoding::Utf8Bom => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        Encoding::Utf16Le | Encoding::Utf16Be => {
            let little = encoding == Encoding::Utf16Le;
            let mut out: Vec<u8> = if little {
                vec![0xFF, 0xFE]
            } else {
                vec![0xFE, 0xFF]
            };
            for unit in text.encode_utf16() {
                let pair = if little {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                };
                out.extend_from_slice(&pair);
            }
            Ok(out)
        }
        Encoding::Gb18030 => {
            let (bytes, _, had_unmappable) = encoding_rs::GB18030.encode(text);
            // GB18030 覆盖全部 Unicode 码位,正常不会走到这里;万一(库的行为变了)装不下,
            // 宁可拒绝也不要让它把字符悄悄换成 `&#12345;` 写进用户的文件
            if had_unmappable {
                return Err(KbError::InvalidInput(
                    "文字里有 GB18030 编码装不下的字符,写回会变成乱码;请先把这个文件另存为 UTF-8"
                        .to_owned(),
                ));
            }
            Ok(bytes.into_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_supported_encoding_round_trips_byte_for_byte() {
        let text = "名称,数量\r\n苹果,3\r\n";
        for encoding in [
            Encoding::Utf8,
            Encoding::Utf8Bom,
            Encoding::Utf16Le,
            Encoding::Utf16Be,
            Encoding::Gb18030,
        ] {
            let bytes = encode(text, encoding).expect("编码");
            let decoded = Decoded::decode(&bytes).expect("解码");
            assert_eq!(decoded.encoding, encoding, "{encoding:?}");
            assert_eq!(decoded.text, text, "{encoding:?}");
            assert!(decoded.round_trips(&bytes), "{encoding:?}");
        }
    }

    #[test]
    fn ascii_only_files_are_plain_utf8_not_gbk() {
        let decoded = Decoded::decode(b"a,b\n1,2\n").expect("解码");
        assert_eq!(decoded.encoding, Encoding::Utf8);
    }

    #[test]
    fn bytes_that_are_valid_in_no_encoding_are_refused_not_patched_up() {
        // 0xFF 0xFF 既不是合法 UTF-8,也不是合法 GB18030(0xFF 不是 GB18030 的首字节)
        let err = Decoded::decode(&[b'a', b',', 0xFF, 0xFF]).expect_err("不能解");
        assert!(err.to_string().contains("另存为 UTF-8"), "{err}");
        // 带 UTF-8 BOM 但后面是坏字节
        let err = Decoded::decode(&[0xEF, 0xBB, 0xBF, 0xFF, 0xFF]).expect_err("不能解");
        assert!(err.to_string().contains("BOM"), "{err}");
        // 奇数个字节的 UTF-16
        let err = Decoded::decode(&[0xFF, 0xFE, 0x61]).expect_err("不能解");
        assert!(err.to_string().contains("UTF-16"), "{err}");
    }

    #[test]
    fn gb18030_holds_characters_outside_gbk_too() {
        // emoji 在 GBK 里没有,GB18030 用四字节表示;能编出来也能原样解回来
        let text = "表情😀,生僻字𠮷";
        let bytes = encode(text, Encoding::Gb18030).expect("编码");
        let decoded = Decoded::decode(&bytes).expect("解码");
        assert_eq!(decoded.encoding, Encoding::Gb18030);
        assert_eq!(decoded.text, text);
        assert!(decoded.round_trips(&bytes));
    }

    #[test]
    fn utf16_surrogate_pairs_survive() {
        let text = "a😀b";
        for encoding in [Encoding::Utf16Le, Encoding::Utf16Be] {
            let bytes = encode(text, encoding).expect("编码");
            assert_eq!(Decoded::decode(&bytes).expect("解码").text, text);
        }
    }

    #[test]
    fn a_decode_that_does_not_encode_back_to_the_same_bytes_is_not_editable() {
        // 构造一个假的「解码结果」:文字对得上,但原始字节不是它编出来的那样
        let decoded = Decoded {
            text: "a".to_owned(),
            encoding: Encoding::Utf8,
        };
        assert!(decoded.round_trips(b"a"));
        assert!(!decoded.round_trips(b"b"));
    }
}
