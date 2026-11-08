//! 纯文本分块(txt / toml / yaml / json / sql / sh 等):行窗口。

use kb_core::model::{Chunk, SourceDoc};
use kb_core::ports::Chunker;

use crate::chunk::ChunkOptions;
use crate::chunk::window::window_chunks;

/// 纯文本分块器。
pub struct PlainChunker {
    options: ChunkOptions,
}

impl PlainChunker {
    /// 构造。
    pub fn new(options: ChunkOptions) -> Self {
        Self { options }
    }

    /// 当前参数。
    pub fn options(&self) -> ChunkOptions {
        self.options
    }
}

impl Chunker for PlainChunker {
    fn supports(&self, lang: &str) -> bool {
        lang == "text"
    }

    fn chunk(&self, doc: &SourceDoc) -> Vec<Chunk> {
        window_chunks(doc, &self.options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_uses_line_windows() {
        let text = (1..=80)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let doc = SourceDoc {
            source: "notes.txt".to_owned(),
            lang: "text".to_owned(),
            text,
            file_hash: "h".to_owned(),
            size: 0,
            mtime: 0,
            project_name: "demo".to_owned(),
        };
        let chunker = PlainChunker::new(ChunkOptions::default());
        assert!(chunker.supports("text"));
        assert!(!chunker.supports("rust"));
        let chunks = chunker.chunk(&doc);
        assert!(chunks.len() >= 2, "80 行应按窗口切成多块");
        assert_eq!(chunks[0].key, "#1");
        assert_eq!(chunks[0].start_line, 1);
        assert!(chunks[0].header.starts_with("demo › notes.txt"));
    }
}
