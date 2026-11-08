//! 图片与音视频抽取器:OCR / 转写可用就用,不可用就降级成占位块。
//!
//! 降级语义(卡片的验收项):
//! - 图片没有 OCR 文本时输出 `Block::Image { caption: "…needs_ocr", ocr_text: None }`,
//!   文件照样入库(不会被隔离);
//! - 音视频没有转写时输出 `Block::Media { transcript: None }` + 提示块,同样入库。

use std::path::Path;

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{Anchor, AnchoredBlock, Block, Confidence, Doc, DocMeta, SourceRef};
use kb_core::ports::Extractor;

use crate::ocr::{OcrOutcome, TranscribeOutcome, ocr_image, transcribe_media};

/// 图片(png / jpg / gif / webp / bmp / tiff)。
pub struct ImageExtractor;

#[async_trait]
impl Extractor for ImageExtractor {
    fn id(&self) -> &str {
        "image/*"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        if head.starts_with(&[0x89, b'P', b'N', b'G'])
            || head.starts_with(&[0xff, 0xd8, 0xff])
            || head.starts_with(b"GIF8")
            || (head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP")
            || head.starts_with(b"BM")
        {
            return Confidence::Certain;
        }
        match ext.trim_start_matches('.').to_ascii_lowercase().as_str() {
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" => {
                Confidence::Probable
            }
            _ => Confidence::Unlikely,
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let path = path_of(source);
        // OCR 需要文件路径(外部命令);没有路径时直接降级
        let outcome = match &path {
            Some(path) => tokio::task::spawn_blocking({
                let path = path.clone();
                move || ocr_image(&path)
            })
            .await
            .unwrap_or_else(|_| OcrOutcome::Unavailable("OCR 线程异常".to_owned())),
            // 没开 OCR 时先说“没开”,避免把“没有路径”当成失败
            None if !crate::ocr::config().ocr_enabled => OcrOutcome::Disabled,
            None => OcrOutcome::Unavailable("没有本地路径,无法 OCR".to_owned()),
        };
        let (ocr_text, caption) = match outcome {
            OcrOutcome::Text(text) => (Some(text), None),
            OcrOutcome::Empty => (None, Some("图片里没有识别出文字(needs_ocr)".to_owned())),
            OcrOutcome::Disabled => (
                None,
                Some("图片未做 OCR(needs_ocr;开启 [extract] ocr_enabled 可识别文字)".to_owned()),
            ),
            OcrOutcome::Unavailable(reason) => {
                (None, Some(format!("图片 OCR 不可用(needs_ocr):{reason}")))
            }
        };
        Ok(doc_of(
            source,
            bytes,
            "image",
            vec![AnchoredBlock {
                anchor: Anchor::Page { page: 1 },
                block: Block::Image {
                    caption,
                    ocr_text,
                    resource: None,
                },
            }],
        ))
    }
}

/// 音频与视频(mp3 / wav / flac / m4a / mp4 / mov / mkv …)。
pub struct MediaExtractor;

#[async_trait]
impl Extractor for MediaExtractor {
    fn id(&self) -> &str {
        "audio|video/*"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        if head.starts_with(b"ID3")
            || (head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WAVE")
            || head.starts_with(b"OggS")
            || head.starts_with(b"fLaC")
            || (head.len() >= 12 && &head[4..8] == b"ftyp")
        {
            return Confidence::Certain;
        }
        match ext.trim_start_matches('.').to_ascii_lowercase().as_str() {
            "mp3" | "wav" | "flac" | "m4a" | "aac" | "ogg" | "mp4" | "mov" | "mkv" | "webm"
            | "avi" => Confidence::Probable,
            _ => Confidence::Unlikely,
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let path = path_of(source);
        let outcome = match &path {
            Some(path) => tokio::task::spawn_blocking({
                let path = path.clone();
                move || transcribe_media(&path)
            })
            .await
            .unwrap_or_else(|_| TranscribeOutcome::Unavailable("转写线程异常".to_owned())),
            None if !crate::ocr::config().transcribe_enabled => TranscribeOutcome::Disabled,
            None => TranscribeOutcome::Unavailable("没有本地路径,无法转写".to_owned()),
        };
        let (transcript, hint) = match outcome {
            TranscribeOutcome::Text(text) => (Some(text), None),
            TranscribeOutcome::Empty => {
                (None, Some("没有转写出文字(可能是纯音乐或静音)".to_owned()))
            }
            TranscribeOutcome::Disabled => (
                None,
                Some("音视频未做转写(开启 [extract] transcribe_enabled 可转写)".to_owned()),
            ),
            TranscribeOutcome::Unavailable(reason) => (None, Some(format!("转写不可用:{reason}"))),
        };
        let mut blocks = vec![AnchoredBlock {
            anchor: Anchor::Time {
                start_ms: 0,
                end_ms: 60_000,
            },
            block: Block::Media {
                transcript: transcript.clone(),
            },
        }];
        if let Some(hint) = hint {
            blocks.push(AnchoredBlock {
                anchor: Anchor::Time {
                    start_ms: 0,
                    end_ms: 0,
                },
                block: Block::Paragraph { text: hint },
            });
        }
        Ok(doc_of(source, bytes, "media", blocks))
    }
}

/// 从 `SourceRef` 里取本地路径(`file://` 或绝对路径)。
fn path_of(source: &SourceRef) -> Option<std::path::PathBuf> {
    let location = source
        .location
        .strip_prefix("file://")
        .unwrap_or(&source.location);
    let path = Path::new(location);
    path.is_file().then(|| path.to_path_buf())
}

fn doc_of(source: &SourceRef, bytes: &[u8], kind: &str, blocks: Vec<AnchoredBlock>) -> Doc {
    Doc {
        meta: DocMeta {
            source: source.location.clone(),
            title: None,
            lang: "zh".to_owned(),
            mime: Some(format!("{kind}/binary")),
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
        // 图片 / 音视频的占位块即使没有文字也要保留(下游据此知道“这里需要 OCR / 转写”)
        blocks: blocks
            .into_iter()
            .filter(|block| {
                !block.block.is_empty()
                    || matches!(block.block, Block::Image { .. } | Block::Media { .. })
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::config::ExtractConfig;

    fn source(location: &str) -> SourceRef {
        SourceRef {
            scheme: "file".to_owned(),
            location: location.to_owned(),
            project_root: None,
        }
    }

    #[tokio::test]
    async fn image_without_ocr_becomes_a_placeholder() {
        // 默认配置:OCR 关闭 → 占位块 + needs_ocr 提示,仍然产出 Doc
        let doc = ImageExtractor
            .extract(&source("photo.png"), &[0x89, b'P', b'N', b'G', 0, 0])
            .await
            .expect("抽取");
        assert_eq!(doc.blocks.len(), 1);
        match &doc.blocks[0].block {
            Block::Image {
                caption, ocr_text, ..
            } => {
                assert!(ocr_text.is_none());
                let caption = caption.as_deref().unwrap_or_default();
                assert!(caption.contains("needs_ocr"), "{caption}");
            }
            other => panic!("应是图片块:{other:?}"),
        }
    }

    #[tokio::test]
    async fn media_without_transcription_becomes_a_placeholder() {
        let doc = MediaExtractor
            .extract(&source("talk.mp3"), b"ID3\x03\x00")
            .await
            .expect("抽取");
        assert!(doc.blocks.len() >= 2, "应有一块转写占位 + 一块提示");
        assert!(matches!(doc.blocks[0].block, Block::Media { .. }));
        let text = doc.text();
        assert!(text.contains("未做转写"), "{text}");
    }

    #[test]
    fn detection_uses_magic_first() {
        assert_eq!(
            ImageExtractor.detect(&[0x89, b'P', b'N', b'G'], "bin"),
            Confidence::Certain
        );
        assert_eq!(ImageExtractor.detect(b"xx", "png"), Confidence::Probable);
        assert_eq!(
            MediaExtractor.detect(b"ID3\x03", "bin"),
            Confidence::Certain
        );
        assert_eq!(MediaExtractor.detect(b"xx", "mp4"), Confidence::Probable);
        assert_eq!(MediaExtractor.detect(b"xx", "txt"), Confidence::Unlikely);
    }

    #[test]
    fn default_config_keeps_both_disabled() {
        let config = ExtractConfig::default();
        assert!(!config.ocr_enabled && !config.transcribe_enabled);
    }
}
