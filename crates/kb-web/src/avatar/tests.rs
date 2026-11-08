use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};

use super::*;

/// 造一张 `w×h` 的纯色图并编码成指定格式。
fn picture(w: u32, h: u32, color: [u8; 4], format: ImageFormat) -> Vec<u8> {
    let image = RgbaImage::from_pixel(w, h, Rgba(color));
    let mut out = Cursor::new(Vec::new());
    let dynamic = if format == ImageFormat::Jpeg {
        DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(image).to_rgb8())
    } else {
        DynamicImage::ImageRgba8(image)
    };
    dynamic.write_to(&mut out, format).expect("编码测试图片");
    out.into_inner()
}

/// PNG 用的 CRC-32(IEEE)。
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn decode(png: &[u8]) -> RgbaImage {
    image::load_from_memory_with_format(png, ImageFormat::Png)
        .expect("输出必须是合法 PNG")
        .to_rgba8()
}

fn message(err: KbError) -> String {
    match err {
        KbError::InvalidInput(text) => text,
        other => panic!("应是 InvalidInput,实际 {other:?}"),
    }
}

#[test]
fn every_accepted_format_becomes_a_256_square_png() {
    for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::Gif] {
        let out = normalize(&picture(300, 300, [200, 40, 40, 255], format))
            .unwrap_or_else(|e| panic!("{format:?}: {e}"));
        assert_eq!(&out[..8], b"\x89PNG\r\n\x1a\n", "{format:?} 输出应是 PNG");
        let image = decode(&out);
        assert_eq!(
            (image.width(), image.height()),
            (AVATAR_SIZE, AVATAR_SIZE),
            "{format:?}"
        );
        let center = image.get_pixel(128, 128).0;
        assert!(
            center[0] > 150 && center[1] < 90,
            "{format:?} 颜色应保留:{center:?}"
        );
    }
}

#[test]
fn non_square_pictures_are_center_cropped_not_stretched() {
    // 左半红、右半蓝的 400×200:居中裁成 200×200 后,红蓝各占一半(而不是被压扁成 256×256 的拉伸图)
    let mut wide = RgbaImage::new(400, 200);
    for (x, _, pixel) in wide.enumerate_pixels_mut() {
        *pixel = if x < 200 {
            Rgba([255, 0, 0, 255])
        } else {
            Rgba([0, 0, 255, 255])
        };
    }
    let mut encoded = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(wide)
        .write_to(&mut encoded, ImageFormat::Png)
        .unwrap();
    let image = decode(&normalize(&encoded.into_inner()).unwrap());
    assert!(image.get_pixel(20, 128).0[0] > 200, "左侧应是红色");
    assert!(image.get_pixel(235, 128).0[2] > 200, "右侧应是蓝色");
    // 用 4:1 的长条图再验证一次:裁切是居中的
    let mut strip = RgbaImage::new(800, 200);
    for (x, _, pixel) in strip.enumerate_pixels_mut() {
        *pixel = if (300..500).contains(&x) {
            Rgba([0, 255, 0, 255])
        } else {
            Rgba([0, 0, 0, 255])
        };
    }
    let mut encoded = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(strip)
        .write_to(&mut encoded, ImageFormat::Png)
        .unwrap();
    let image = decode(&normalize(&encoded.into_inner()).unwrap());
    assert!(
        image.get_pixel(128, 128).0[1] > 200 && image.get_pixel(5, 128).0[1] > 200,
        "中间 200 像素整块都在画面里"
    );
}

#[test]
fn small_pictures_are_scaled_up_to_the_standard_size() {
    let out = normalize(&picture(16, 16, [10, 200, 10, 255], ImageFormat::Png)).unwrap();
    let image = decode(&out);
    assert_eq!((image.width(), image.height()), (AVATAR_SIZE, AVATAR_SIZE));
}

#[test]
fn transparency_is_kept() {
    let out = normalize(&picture(64, 64, [255, 0, 0, 0], ImageFormat::Png)).unwrap();
    assert_eq!(
        decode(&out).get_pixel(10, 10).0[3],
        0,
        "全透明的头像应保持透明"
    );
}

#[test]
fn things_that_are_not_images_are_refused_by_content_not_by_name() {
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>"##;
    let html = b"<!doctype html><html><script>alert(1)</script></html>";
    let php = b"<?php system($_GET['c']); ?>";
    let text = "just some text".as_bytes();
    let pdf = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n";
    let zip = b"PK\x03\x04\x14\x00\x00\x00\x08\x00";
    let elf = b"\x7fELF\x02\x01\x01\x00";
    for (name, bytes) in [
        ("svg", &svg[..]),
        ("html", &html[..]),
        ("php", &php[..]),
        ("text", text),
        ("pdf", &pdf[..]),
        ("zip", &zip[..]),
        ("elf", &elf[..]),
    ] {
        let text = message(normalize(bytes).expect_err(name));
        assert!(text.contains("只支持"), "{name}:{text}");
    }
    assert!(message(normalize(&[]).unwrap_err()).contains("没有收到"));
}

#[test]
fn formats_with_bigger_attack_surface_are_refused_even_though_they_are_images() {
    // BMP / TIFF / ICO 等:`image` 能认出来,但头像不需要它们
    // 手写一个最小的 8×8、24 位 BMP(BMP 编码器没开,也不需要开)
    let bmp = {
        let pixels = 8 * 8 * 3;
        let mut out = b"BM".to_vec();
        out.extend_from_slice(&(54 + pixels as u32).to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&54u32.to_le_bytes());
        out.extend_from_slice(&40u32.to_le_bytes());
        out.extend_from_slice(&8i32.to_le_bytes());
        out.extend_from_slice(&8i32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&24u16.to_le_bytes());
        out.extend_from_slice(&[0; 24]);
        out.extend_from_slice(&vec![0x80; pixels]);
        out
    };
    assert_eq!(
        image::guess_format(&bmp).unwrap(),
        ImageFormat::Bmp,
        "测试输入确实是 BMP"
    );
    assert!(message(normalize(&bmp).unwrap_err()).contains("只支持"));
    assert!(
        message(normalize(b"II*\x00\x08\x00\x00\x00").unwrap_err()).contains("只支持"),
        "TIFF"
    );
}

#[test]
fn a_tiny_file_that_claims_a_gigantic_size_is_refused_before_decoding() {
    // 图片炸弹:合法的 PNG 头,宽高写成 30000×30000(解出来要 3.6 GB),整个文件只有几十字节
    let mut bomb = picture(1, 1, [0, 0, 0, 255], ImageFormat::Png);
    // IHDR 数据在偏移 16..29(宽 4 + 高 4 + 5 个字节),CRC 在 29..33,覆盖 "IHDR" + 数据(12..29)。
    // 改了宽高必须重算 CRC,否则解码器先报「已损坏」,测不到真正想测的尺寸限制
    bomb[16..20].copy_from_slice(&30_000u32.to_be_bytes());
    bomb[20..24].copy_from_slice(&30_000u32.to_be_bytes());
    let crc = crc32(&bomb[12..29]);
    bomb[29..33].copy_from_slice(&crc.to_be_bytes());
    // 自检:这个头现在对解码器来说完全合法,只是尺寸夸张
    let (w, h) = image::ImageReader::with_format(Cursor::new(&bomb), ImageFormat::Png)
        .into_decoder()
        .map(|d| d.dimensions())
        .expect("头应当合法");
    assert_eq!((w, h), (30_000, 30_000));
    assert!(bomb.len() < 200);
    let started = std::time::Instant::now();
    let error = normalize(&bomb).unwrap_err();
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "必须在解码前就拒绝,不能先分配内存"
    );
    let text = message(error);
    assert!(text.contains("太大"), "{text}");
}

#[test]
fn the_dimension_limit_is_per_side_and_a_normal_large_photo_still_works() {
    // 4000×3000(1200 万像素的手机照片)是正常头像来源,必须能处理
    let photo = picture(4000, 3000, [30, 90, 160, 255], ImageFormat::Jpeg);
    assert!(photo.len() < MAX_UPLOAD_BYTES);
    let out = normalize(&photo).expect("普通大照片应能处理");
    assert_eq!(decode(&out).width(), AVATAR_SIZE);
}

#[test]
fn oversized_uploads_are_refused_by_byte_count() {
    let big = vec![0u8; MAX_UPLOAD_BYTES + 1];
    assert!(message(normalize(&big).unwrap_err()).contains("不能超过"));
}

#[test]
fn truncated_or_corrupt_pictures_give_a_clear_error() {
    let good = picture(100, 100, [5, 5, 5, 255], ImageFormat::Png);
    let truncated = &good[..good.len() / 2];
    let text = message(normalize(truncated).unwrap_err());
    assert!(text.contains("损坏") || text.contains("无法"), "{text}");
    // 魔数对、后面全是垃圾
    let mut junk = b"\x89PNG\r\n\x1a\n".to_vec();
    junk.extend_from_slice(&[0xAB; 64]);
    assert!(normalize(&junk).is_err());
    let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0];
    jpeg.extend_from_slice(&[0x00; 32]);
    assert!(normalize(&jpeg).is_err());
}

/// 在 JPEG 的 SOI 之后插入一个 APP1(Exif)段,带方向标记和 GPS 样的文字。
fn with_exif(jpeg: &[u8], orientation: u16) -> Vec<u8> {
    // TIFF 头(小端)+ 一个 IFD 条目:Orientation(0x0112)
    let mut tiff = vec![b'I', b'I', 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00];
    tiff.extend_from_slice(&1u16.to_le_bytes());
    tiff.extend_from_slice(&0x0112u16.to_le_bytes());
    tiff.extend_from_slice(&3u16.to_le_bytes()); // SHORT
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&orientation.to_le_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0u32.to_le_bytes());
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(&tiff);
    payload.extend_from_slice(b"GPS:31.2304N,121.4737E"); // 位置信息之类的隐私内容
    let len = (payload.len() + 2) as u16;
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&jpeg[2..]);
    out
}

#[test]
fn exif_orientation_is_applied_and_no_metadata_survives() {
    // 一张 200×100 的图:左半红右半蓝。EXIF 说「需要顺时针转 90°」(Orientation=6)
    let mut wide = RgbaImage::new(200, 100);
    for (x, _, pixel) in wide.enumerate_pixels_mut() {
        *pixel = if x < 100 {
            Rgba([255, 0, 0, 255])
        } else {
            Rgba([0, 0, 255, 255])
        };
    }
    let mut jpeg = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(wide).to_rgb8())
        .write_to(&mut jpeg, ImageFormat::Jpeg)
        .unwrap();
    let tagged = with_exif(&jpeg.into_inner(), 6);
    assert!(
        tagged.windows(3).any(|w| w == b"GPS"),
        "测试输入应带有位置信息"
    );

    let out = normalize(&tagged).unwrap();
    let image = decode(&out);
    // 顺时针转 90° 后,原来的左半(红)到了上方,右半(蓝)到了下方
    assert!(
        image.get_pixel(128, 20).0[0] > 180,
        "上方应是红:{:?}",
        image.get_pixel(128, 20)
    );
    assert!(
        image.get_pixel(128, 235).0[2] > 180,
        "下方应是蓝:{:?}",
        image.get_pixel(128, 235)
    );
    // 输出里不能有任何 EXIF / GPS / 原文件里的文字
    for needle in [
        &b"GPS"[..],
        b"Exif",
        b"31.2304",
        b"eXIf",
        b"tEXt",
        b"iTXt",
        b"zTXt",
        b"iCCP",
    ] {
        assert!(
            !out.windows(needle.len()).any(|w| w == needle),
            "输出里不该有 {:?}",
            String::from_utf8_lossy(needle)
        );
    }
}

#[test]
fn data_hidden_after_the_picture_is_dropped() {
    // 「图片 + 脚本」拼接文件(polyglot):合法 PNG 后面接一段 HTML。重新编码后后半段不会保留
    let mut polyglot = picture(64, 64, [9, 9, 9, 255], ImageFormat::Png);
    polyglot.extend_from_slice(b"<script>alert('pwned')</script>SECRET-TRAILER");
    let out = normalize(&polyglot).unwrap();
    assert!(
        !out.windows(6).any(|w| w == b"<scrip"),
        "尾部的脚本不能留下"
    );
    assert!(!out.windows(14).any(|w| w == b"SECRET-TRAILER"));
}

#[test]
fn animated_gifs_use_the_first_frame_only() {
    use image::codecs::gif::{GifEncoder, Repeat};
    use image::{Delay, Frame};
    let mut gif = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut gif);
        encoder.set_repeat(Repeat::Infinite).unwrap();
        let red = Frame::from_parts(
            RgbaImage::from_pixel(32, 32, Rgba([255, 0, 0, 255])),
            0,
            0,
            Delay::from_numer_denom_ms(100, 1),
        );
        let blue = Frame::from_parts(
            RgbaImage::from_pixel(32, 32, Rgba([0, 0, 255, 255])),
            0,
            0,
            Delay::from_numer_denom_ms(100, 1),
        );
        encoder.encode_frame(red).unwrap();
        encoder.encode_frame(blue).unwrap();
    }
    let image = decode(&normalize(&gif).unwrap());
    let center = image.get_pixel(128, 128).0;
    assert!(
        center[0] > 200 && center[2] < 60,
        "应取第一帧(红):{center:?}"
    );
}

#[test]
fn the_output_is_deterministic_in_size_and_much_smaller_than_a_big_photo() {
    let photo = picture(3000, 3000, [120, 120, 120, 255], ImageFormat::Png);
    let out = normalize(&photo).unwrap();
    assert!(
        out.len() < 100 * 1024,
        "纯色大图缩成头像应很小:{} 字节",
        out.len()
    );
}

#[test]
fn file_names_are_generated_and_validated_strictly() {
    let name = new_file_name("usr_018f3c2a-7b1e-7000-8000-0123456789ab");
    assert!(is_valid_file_name(&name), "{name}");
    assert_ne!(
        name,
        new_file_name("usr_018f3c2a-7b1e-7000-8000-0123456789ab"),
        "每次上传换一个名字"
    );
    for bad in [
        "",
        "../../etc/passwd",
        "../usr_a-12345678.png",
        "usr_a/b-12345678.png",
        "usr_a-12345678.png/..",
        "usr_a-1234567.png",
        "usr_a-123456789.png",
        "usr_a-1234567G.png",
        "usr_a-ABCDEF12.png",
        "usr_a-12345678.svg",
        "usr_a-12345678.png.php",
        "usr_a-12345678",
        "other-12345678.png",
        "usr_a\0-12345678.png",
        "usr_ä-12345678.png",
    ] {
        assert!(!is_valid_file_name(bad), "{bad:?} 不该通过");
        assert!(file_path(Path::new("/data/avatars"), bad).is_none());
    }
    assert_eq!(
        file_path(Path::new("/data/avatars"), "usr_a-0123abcd.png"),
        Some(PathBuf::from("/data/avatars/usr_a-0123abcd.png"))
    );
}

#[test]
fn writing_is_atomic_and_removal_is_forgiving() {
    let dir = tempfile::tempdir().unwrap();
    let name = "usr_a-0123abcd.png";
    write_atomic(dir.path(), name, b"png-bytes").unwrap();
    assert_eq!(std::fs::read(dir.path().join(name)).unwrap(), b"png-bytes");
    // 没有留下临时文件
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(leftovers, [std::ffi::OsString::from(name)]);
    // 非法文件名拒绝写
    assert!(write_atomic(dir.path(), "../evil.png", b"x").is_err());
    assert!(!dir.path().parent().unwrap().join("evil.png").exists());
    // 删除:存在的删掉,不存在 / 非法的安静通过
    remove(dir.path(), name);
    assert!(!dir.path().join(name).exists());
    remove(dir.path(), name);
    remove(dir.path(), "../../x");
}
