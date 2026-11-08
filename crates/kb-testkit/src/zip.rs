//! 测试用的极简 zip 写入器(解包测试)。
//!
//! 只写 `kb-service/src/upload/unpack.rs` 的读取器需要的字段:中央目录 + 本地头。
//! **CRC32 一律写 0**:读取器不校验它(校验值安全与路径安全无关),换成系统 `unzip`
//! 打开这些测试包会报 CRC 错,这是预期的。
//!
//! 故意支持“任意压缩算法编号”([`Entry::with_method`]),用来测“不支持的算法要报错”。

use std::io::Write;
use std::path::Path;

/// 一个待写入的条目。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// zip 压缩算法编号(0 = stored,8 = deflate)。
    pub method: u16,
    /// 原始内容(未压缩)。
    pub data: Vec<u8>,
}

impl Entry {
    /// 不压缩。
    pub fn stored(data: &[u8]) -> Self {
        Self {
            method: 0,
            data: data.to_vec(),
        }
    }

    /// deflate 压缩。
    pub fn deflate(data: &[u8]) -> Self {
        Self {
            method: 8,
            data: data.to_vec(),
        }
    }

    /// 指定压缩算法编号(用于构造不支持的算法)。
    pub fn with_method(method: u16, data: &[u8]) -> Self {
        Self {
            method,
            data: data.to_vec(),
        }
    }

    fn payload(&self) -> Vec<u8> {
        match self.method {
            8 => {
                let mut encoder =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(&self.data).expect("压缩");
                encoder.finish().expect("压缩")
            }
            _ => self.data.clone(),
        }
    }
}

/// 把条目写成 zip 文件。
pub fn write_zip(path: &Path, entries: &[(&str, Entry)]) {
    let mut out: Vec<u8> = Vec::new();
    let mut directory: Vec<(String, u16, u64, u64, u64)> = Vec::new();
    for (name, entry) in entries {
        let payload = entry.payload();
        let offset = out.len() as u64;
        write_local_header(
            &mut out,
            name,
            entry.method,
            payload.len() as u32,
            entry.data.len() as u32,
        );
        out.extend_from_slice(&payload);
        directory.push((
            (*name).to_owned(),
            entry.method,
            payload.len() as u64,
            entry.data.len() as u64,
            offset,
        ));
    }
    let cd_offset = out.len() as u64;
    for (name, method, compressed, uncompressed, offset) in &directory {
        write_central_header(
            &mut out,
            name,
            *method,
            *compressed as u32,
            *uncompressed as u32,
            *offset as u32,
        );
    }
    let cd_size = out.len() as u64 - cd_offset;
    write_eocd(
        &mut out,
        directory.len() as u16,
        cd_size as u32,
        cd_offset as u32,
    );
    std::fs::write(path, out).expect("写 zip 文件");
}

fn write_local_header(
    out: &mut Vec<u8>,
    name: &str,
    method: u16,
    compressed: u32,
    uncompressed: u32,
) {
    out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
    out.extend_from_slice(&20u16.to_le_bytes()); // version needed
    out.extend_from_slice(&0u16.to_le_bytes()); // flags
    out.extend_from_slice(&method.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // mod time
    out.extend_from_slice(&0u16.to_le_bytes()); // mod date
    out.extend_from_slice(&0u32.to_le_bytes()); // crc32(不校验)
    out.extend_from_slice(&compressed.to_le_bytes());
    out.extend_from_slice(&uncompressed.to_le_bytes());
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // extra len
    out.extend_from_slice(name.as_bytes());
}

fn write_central_header(
    out: &mut Vec<u8>,
    name: &str,
    method: u16,
    compressed: u32,
    uncompressed: u32,
    local_offset: u32,
) {
    out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
    out.extend_from_slice(&20u16.to_le_bytes()); // version made by
    out.extend_from_slice(&20u16.to_le_bytes()); // version needed
    out.extend_from_slice(&0u16.to_le_bytes()); // flags
    out.extend_from_slice(&method.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // mod time
    out.extend_from_slice(&0u16.to_le_bytes()); // mod date
    out.extend_from_slice(&0u32.to_le_bytes()); // crc32
    out.extend_from_slice(&compressed.to_le_bytes());
    out.extend_from_slice(&uncompressed.to_le_bytes());
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // extra len
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len
    out.extend_from_slice(&0u16.to_le_bytes()); // disk number
    out.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
    out.extend_from_slice(&0u32.to_le_bytes()); // external attrs
    out.extend_from_slice(&local_offset.to_le_bytes());
    out.extend_from_slice(name.as_bytes());
}

fn write_eocd(out: &mut Vec<u8>, entries: u16, cd_size: u32, cd_offset: u32) {
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // this disk
    out.extend_from_slice(&0u16.to_le_bytes()); // cd disk
    out.extend_from_slice(&entries.to_le_bytes());
    out.extend_from_slice(&entries.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn written_zip_has_expected_layout() {
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join("t.zip");
        write_zip(
            &path,
            &[
                ("a.txt", Entry::stored(b"hello")),
                ("b.txt", Entry::deflate(&b"world".repeat(100))),
            ],
        );
        let bytes = std::fs::read(&path).expect("读");
        // 本地头、中央目录、结尾记录三种签名都在
        assert!(bytes.starts_with(&0x0403_4b50u32.to_le_bytes()));
        let central = bytes
            .windows(4)
            .filter(|window| *window == 0x0201_4b50u32.to_le_bytes())
            .count();
        assert_eq!(central, 2, "两条中央目录记录");
        let eocd = bytes
            .windows(4)
            .position(|window| window == 0x0605_4b50u32.to_le_bytes())
            .expect("有中央目录结尾记录");
        // EOCD 里声明的条目数
        let entries = u16::from_le_bytes([bytes[eocd + 10], bytes[eocd + 11]]);
        assert_eq!(entries, 2);
    }
}
