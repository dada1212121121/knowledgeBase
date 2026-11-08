//! 头像处理与存储(多用户设计说明)。
//!
//! 用户上传的图片是**不可信输入**,这里把它变成一张统一规格的小图再落盘:
//! - 按**内容**识别格式,不看 `Content-Type` 和扩展名;只收 PNG / JPEG / WebP / GIF。
//!   SVG 能带脚本,永远不收;其它格式(TIFF、AVIF、EXR……)解码器更复杂,攻击面更大,也不收。
//! - 解码**前**先读文件头里的宽高,太大直接拒绝,并给解码器设内存上限,防「图片炸弹」
//!   (几十 KB 的文件解出几百兆像素)。
//! - 按 EXIF 方向转正(手机竖拍的照片),再居中裁成正方形,缩到 [`AVATAR_SIZE`]。
//! - **重新编码成 PNG**:原图里的 EXIF(含 GPS 位置)、ICC、注释、藏在文件尾部的数据一律不会保留。
//! - GIF 只取第一帧。
//!
//! 磁盘上的文件名是 `<用户id>-<8 位随机>.png`,每次上传都换一个:地址里带着它,浏览器缓存自然失效,
//! 新旧文件的替换也不会出现「读到一半」。读取时文件名只从数据库里取,从不拼接请求里的任何字符串。

use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use kb_core::{KbError, Result};
use rand::Rng;

/// 头像边长(像素)。256 在 4K 屏上放大到 128 的显示尺寸仍然清晰,PNG 一般 20–120 KB。
pub const AVATAR_SIZE: u32 = 256;
/// 上传体积上限。手机原图常有 3–8 MB,留足余量;更大的多半不是头像。
pub const MAX_UPLOAD_BYTES: usize = 8 * 1024 * 1024;
/// 允许的原图边长上限(像素)。超过的在解码前就拒绝。
const MAX_SIDE: u32 = 8192;
/// 解码时最多分配的内存。8192×8192×4 = 256 MB 太大,128 MB 够 4000×4000 的照片。
const MAX_DECODE_ALLOC: u64 = 128 * 1024 * 1024;

/// 把上传的字节变成 256×256 的 PNG。纯函数:不碰磁盘,耗时在 CPU 上,调用方放进 `spawn_blocking`。
pub fn normalize(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.is_empty() {
        return Err(KbError::InvalidInput("没有收到图片".to_owned()));
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(KbError::InvalidInput(format!(
            "图片不能超过 {} MB",
            MAX_UPLOAD_BYTES / 1024 / 1024
        )));
    }
    let format = image::guess_format(bytes).map_err(|_| unsupported())?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif
    ) {
        return Err(unsupported());
    }

    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|err| decode_error(&err))?;
    // 宽高来自文件头:解码之前就能拒绝,不用先把像素解出来
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 {
        return Err(corrupt());
    }
    if width > MAX_SIDE || height > MAX_SIDE {
        return Err(KbError::InvalidInput(format!(
            "图片尺寸太大({width}×{height}),边长不能超过 {MAX_SIDE} 像素"
        )));
    }
    let orientation = decoder.orientation().ok();
    let mut picture = DynamicImage::from_decoder(decoder).map_err(|err| decode_error(&err))?;
    if let Some(orientation) = orientation {
        picture.apply_orientation(orientation);
    }

    // 居中裁成正方形再缩放:`resize_to_fill` 保持比例、多出的部分裁掉
    let square = picture.resize_to_fill(AVATAR_SIZE, AVATAR_SIZE, FilterType::Lanczos3);
    let mut out = Cursor::new(Vec::new());
    // 先转成带透明度的 8 位 RGBA:丢掉 16 位 / 灰度 / 调色板等各种来源格式的差异,输出规格固定
    DynamicImage::ImageRgba8(square.to_rgba8())
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|err| KbError::Internal(format!("头像编码失败:{err}")))?;
    Ok(out.into_inner())
}

fn unsupported() -> KbError {
    KbError::InvalidInput("只支持 PNG、JPEG、WebP、GIF 图片".to_owned())
}

fn corrupt() -> KbError {
    KbError::InvalidInput("图片已损坏或无法识别".to_owned())
}

fn decode_error(err: &image::ImageError) -> KbError {
    match err {
        // 触到我们设的尺寸 / 内存上限
        image::ImageError::Limits(_) => {
            KbError::InvalidInput("图片太大,无法处理,请换一张小一点的".to_owned())
        }
        image::ImageError::Unsupported(_) => unsupported(),
        _ => corrupt(),
    }
}

/// 头像文件名:`<用户id>-<8 位小写十六进制>.png`。
pub fn new_file_name(user_id: &str) -> String {
    let token: u32 = rand::rng().random();
    format!("{user_id}-{token:08x}.png")
}

/// 文件名是否是我们自己生成的样子。读文件前再校验一次:
/// 即使数据库被写进了奇怪的值,也不会因此读到头像目录之外的文件。
pub fn is_valid_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".png") else {
        return false;
    };
    let Some((user, token)) = stem.rsplit_once('-') else {
        return false;
    };
    let id_ok = user.starts_with("usr_")
        && user.len() <= 64
        && user
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    let token_ok = token.len() == 8
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    id_ok && token_ok
}

/// 头像文件的完整路径;文件名不合规返回 `None`。
pub fn file_path(dir: &Path, name: &str) -> Option<PathBuf> {
    is_valid_file_name(name).then(|| dir.join(name))
}

/// 原子写:先写同目录下的临时文件再 rename,读取方不会看到写了一半的文件。
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let path = file_path(dir, name)
        .ok_or_else(|| KbError::Internal(format!("非法的头像文件名:{name}")))?;
    std::fs::create_dir_all(dir)
        .map_err(|err| KbError::Internal(format!("创建头像目录失败:{err}")))?;
    let temp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&temp, bytes).map_err(|err| KbError::Internal(format!("写头像失败:{err}")))?;
    std::fs::rename(&temp, &path).map_err(|err| {
        let _ = std::fs::remove_file(&temp);
        KbError::Internal(format!("保存头像失败:{err}"))
    })
}

/// 删除一个头像文件;不存在不算错(重复删除、手工清理过都应该安静通过)。
pub fn remove(dir: &Path, name: &str) {
    if let Some(path) = file_path(dir, name)
        && let Err(err) = std::fs::remove_file(&path)
        && err.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(error = %err, file = name, "删除旧头像失败");
    }
}

#[cfg(test)]
mod tests;
