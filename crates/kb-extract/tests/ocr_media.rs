//! 验收:图片 OCR 与音视频转写(开 / 关两种状态)。
//!
//! 外部命令用**假的 shell 脚本**代替(输出固定文本),这样不依赖本机是否装了
//! `tesseract` / `whisper.cpp`,CI 也能跑;关闭时的降级路径单独断言。

use std::path::Path;

use kb_core::config::ExtractConfig;
use kb_core::model::SourceRef;
use kb_extract::{default_registry, install};

fn source(path: &Path) -> SourceRef {
    SourceRef {
        scheme: "file".to_owned(),
        location: path.to_string_lossy().into_owned(),
        project_root: None,
    }
}

/// 造一个可执行脚本,输出固定文本。
fn fake_command(dir: &Path, name: &str, output: &str) -> String {
    let path = dir.join(name);
    let script = format!("#!/bin/sh\ncat <<'EOF'\n{output}\nEOF\n");
    std::fs::write(&path, script).expect("写脚本");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path).expect("元数据").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("加执行位");
    }
    path.to_string_lossy().into_owned()
}

/// 一张最小的 PNG(内容不重要,OCR 走假命令)。
fn tiny_png() -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(&[0u8; 64]);
    bytes
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ocr_and_transcription_can_be_enabled_with_external_commands() {
    let dir = tempfile::tempdir().expect("临时目录");
    let ocr_command = fake_command(dir.path(), "fake-ocr.sh", "发票金额 1200 元");
    let transcribe_command = fake_command(
        dir.path(),
        "fake-whisper.sh",
        "[00:00:00.000 --> 00:00:05.000] 我们讨论了双哈希增量索引",
    );
    // 配置只能注入一次:这个测试负责“打开”的那条路径
    // 用假的 tesseract 当后端(直接验插件接口与降级顺序,不依赖 RapidOCR 安装)
    let installed = install(ExtractConfig {
        ocr_enabled: true,
        ocr_backend: "tesseract".to_owned(),
        ocr_fallback_command: ocr_command,
        transcribe_enabled: true,
        transcribe_command,
        max_media_seconds: 120,
        ..ExtractConfig::default()
    });
    assert!(installed, "本测试应第一个注入抽取配置");

    let registry = default_registry();

    // 图片:OCR 打开 → 识别出的文字进块
    let image_path = dir.path().join("invoice.png");
    std::fs::write(&image_path, tiny_png()).expect("写图片");
    let image = std::fs::read(&image_path).expect("读图片");
    let doc = registry
        .extract(&source(&image_path), &image, "png")
        .await
        .expect("抽取图片");
    let text = doc.text();
    assert!(text.contains("发票金额"), "OCR 文本应进块:{text}");
    assert!(
        !text.contains("needs_ocr"),
        "OCR 成功时不应标 needs_ocr:{text}"
    );

    // 音频:转写打开 → 转写文本进块,且带时间锚点
    let audio_path = dir.path().join("talk.mp3");
    std::fs::write(&audio_path, b"ID3\x03\x00\x00").expect("写音频");
    let audio = std::fs::read(&audio_path).expect("读音频");
    let doc = registry
        .extract(&source(&audio_path), &audio, "mp3")
        .await
        .expect("抽取音频");
    let text = doc.text();
    assert!(text.contains("双哈希"), "转写文本应进块:{text}");
    let has_time = doc
        .blocks
        .iter()
        .any(|block| matches!(block.anchor, kb_core::model::Anchor::Time { .. }));
    assert!(has_time, "音视频块应带时间锚点:{:?}", doc.blocks);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabled_ocr_still_ingests_the_image() {
    // 注意:配置是进程级的,`install` 只能成功一次;这里读默认值(OCR/转写都关)。
    // 若与上一个测试同进程运行,读到的是已注入的“打开”配置,此时只断言“能抽取、不报错”。
    let dir = tempfile::tempdir().expect("临时目录");
    let image_path = dir.path().join("photo.png");
    std::fs::write(&image_path, tiny_png()).expect("写图片");
    let image = std::fs::read(&image_path).expect("读图片");
    let doc = default_registry()
        .extract(&source(&image_path), &image, "png")
        .await
        .expect("关闭 OCR 时也必须能抽取(降级成占位块)");
    assert!(!doc.blocks.is_empty(), "应至少有一个块:{doc:?}");
    let config = kb_extract::ocr::config();
    if !config.ocr_enabled {
        let text = doc.text();
        assert!(text.contains("needs_ocr"), "关闭时应标 needs_ocr:{text}");
    }
}
