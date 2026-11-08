//! 后端注册表:内置条目 + `<KB_HOME>/backends/*/manifest.toml` 合成一份稳定清单。
//!
//! 五条不变量(照抄前端编辑器扩展注册表的验收口径,测试逐条钉住):
//! 1. **幂等**:同 id 只留一份;manifest 盖内置时是「替换」不是「再多一份」。
//! 2. **内置不可删**:目录不存在、某份 manifest 坏掉,都只丢那一份,内置一条不少。
//! 3. **覆盖要能看见**:被 manifest 盖掉的内置条目标成 `Manifest(..)` 来源,`kb doctor backends` 会打出路径。
//! 4. **坏的不静默**:解析失败、id 与目录名不一致、版本不对,一律进 `warnings`,不是悄悄跳过。
//! 5. **顺序稳定**:内置在前(按种类、再按 id),manifest 在后(按 id);同样的输入永远同样的输出。

use std::path::{Path, PathBuf};

use super::manifest::{
    API_VERSION, BackendEntry, BackendKind, BackendManifest, BackendSource, dir_name_of,
    parse_manifest,
};

/// 一份注册表。
#[derive(Clone, Debug, Default)]
pub struct BackendRegistry {
    entries: Vec<BackendEntry>,
    warnings: Vec<String>,
}

impl BackendRegistry {
    /// 只有内置条目(不读盘;`kb-core` 的纯逻辑路径与测试用)。
    pub fn builtin_only() -> Self {
        Self {
            entries: builtin_manifests()
                .into_iter()
                .map(BackendEntry::builtin)
                .collect(),
            warnings: Vec::new(),
        }
    }

    /// 读 `<home>/backends/`,与内置条目合并。
    ///
    /// 目录不存在是**正常情况**(从没装过第三方后端),不是错误,也不打 warning。
    pub fn load(home: &Path) -> Self {
        Self::load_dir(&home.join("backends"))
    }

    /// 读指定目录(测试与「别处知识库」用)。
    pub fn load_dir(dir: &Path) -> Self {
        let mut registry = Self::builtin_only();
        if !dir.is_dir() {
            return registry;
        }
        let read = match std::fs::read_dir(dir) {
            Ok(read) => read,
            Err(err) => {
                registry.warnings.push(format!(
                    "读不了后端目录 {}:{err};只有内置后端可用",
                    dir.display()
                ));
                return registry;
            }
        };
        // 先收集成 (id, 路径) 再排序:目录迭代顺序是文件系统给的,不排序会让 `kb doctor` 每次输出不一样
        let mut found: Vec<(String, PathBuf)> = Vec::new();
        for entry in read {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    registry
                        .warnings
                        .push(format!("跳过读不出来的目录项:{err}"));
                    continue;
                }
            };
            let path = entry.path();
            if !path.is_dir() {
                // `backends/README.md` 这类文件不算后端
                continue;
            }
            match dir_name_of(&path) {
                Some(name) => found.push((name, path)),
                None => registry
                    .warnings
                    .push(format!("跳过目录 {}:名字不是合法 UTF-8", path.display())),
            }
        }
        found.sort_by(|left, right| left.0.cmp(&right.0));

        for (name, path) in found {
            let file = path.join("manifest.toml");
            let text = match std::fs::read_to_string(&file) {
                Ok(text) => text,
                Err(err) => {
                    registry
                        .warnings
                        .push(format!("{} 读不出来:{err};这个后端被跳过", file.display()));
                    continue;
                }
            };
            let manifest = match parse_manifest(&text, &name) {
                Ok(manifest) => manifest,
                Err(reason) => {
                    registry
                        .warnings
                        .push(format!("{}:{reason};这个后端被跳过", file.display()));
                    continue;
                }
            };
            registry.install(BackendEntry {
                manifest,
                source: BackendSource::Manifest(file),
            });
        }
        registry
    }

    /// 装入一条(同 id 替换,位置留在原处或追加到末尾)。
    ///
    /// 替换时**不换位置**:内置条目即使被 manifest 盖掉,它在清单里的位置也不变,
    /// 这样界面上「文档 OCR」那一组不会因为装了个 manifest 就跳到最后。
    pub fn install(&mut self, entry: BackendEntry) {
        if let Some(slot) = self
            .entries
            .iter_mut()
            .find(|existing| existing.id() == entry.id())
        {
            *slot = entry;
            return;
        }
        self.entries.push(entry);
    }

    /// 全部条目。
    pub fn list(&self) -> &[BackendEntry] {
        &self.entries
    }

    /// 按 id 找一条。
    pub fn get(&self, id: &str) -> Option<&BackendEntry> {
        self.entries.iter().find(|entry| entry.id() == id)
    }

    /// 按种类过滤(界面上四分区就是这么来的)。
    pub fn by_kind(&self, kind: BackendKind) -> Vec<&BackendEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.kind() == kind)
            .collect()
    }

    /// 加载时攒下的问题(每条一句话,带文件路径)。
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// 条数。
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 空不空(只有内置条目时也不空)。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 有几条来自 manifest。
    pub fn manifest_count(&self) -> usize {
        self.entries
            .iter()
            .filter(|entry| entry.source.is_manifest())
            .count()
    }
}

/// 内置后端清单。
///
/// 这些是「程序自带、编译进来」的实现。id 与配置里的取值对齐(`extract.ocr_backend` 收
/// `rapidocr` / `tesseract`,`extract.transcribe_command` 默认 `whisper-cli`,`embed.backend`
/// 收 `fastembed` / `http`),这样清单上的 id 能直接对到用户配置文件里的那一行。
fn builtin_manifests() -> Vec<BackendManifest> {
    vec![
 BackendManifest {
 id: "rapidocr".to_owned(),
 name: "RapidOCR(PP-OCRv6)".to_owned(),
 kind: BackendKind::Ocr,
 api_version: API_VERSION,
 install: None,
 uninstall: None,
 probe: Some(vec!["rapidocr".to_owned(), "--version".to_owned()]),
 // 安装不是一条固定命令:走 [extract] 的 ocr_install_command(设置页「一键安装」也是它)
 detail: Some(
 "ONNX 推理,CPU 友好;模型放 <KB_HOME>/models/ocr/ppocrv6,装法看 extract.ocr_install_command"
 .to_owned(),
 ),
 settings: vec![
 "extract.ocr_backend".to_owned(),
 "extract.ocr_model_size".to_owned(),
 "extract.ocr_model_dir".to_owned(),
 ],
 },
 BackendManifest {
 id: "tesseract".to_owned(),
 name: "Tesseract".to_owned(),
 kind: BackendKind::Ocr,
 api_version: API_VERSION,
 install: None,
 uninstall: None,
 probe: Some(vec!["tesseract".to_owned(), "--version".to_owned()]),
 detail: Some("系统包管理器装;语言包好坏决定识别质量".to_owned()),
 settings: vec![
 "extract.ocr_backend".to_owned(),
 "extract.ocr_language".to_owned(),
 ],
 },
 BackendManifest {
 id: "whisper-cli".to_owned(),
 name: "whisper.cpp".to_owned(),
 kind: BackendKind::Transcribe,
 api_version: API_VERSION,
 install: None,
 uninstall: None,
 probe: Some(vec!["whisper-cli".to_owned(), "--help".to_owned()]),
 detail: Some("也可以指向自己的薄封装脚本(脚本名就是这里声明的命令)".to_owned()),
 settings: vec![
 "extract.transcribe_command".to_owned(),
 "extract.transcribe_model".to_owned(),
 "extract.transcribe_enabled".to_owned(),
 ],
 },
 BackendManifest {
 id: "fastembed".to_owned(),
 name: "fastembed(本地)".to_owned(),
 kind: BackendKind::Embed,
 api_version: API_VERSION,
 install: None,
 uninstall: None,
 probe: None,
 detail: Some("进程内 ONNX;模型目录不存在时启动会去拉".to_owned()),
 settings: vec![
 "embed.backend".to_owned(),
 "embed.model".to_owned(),
 "embed.max_tokens".to_owned(),
 ],
 },
 BackendManifest {
 id: "http".to_owned(),
 name: "OpenAI 兼容服务(embed)".to_owned(),
 kind: BackendKind::Embed,
 api_version: API_VERSION,
 install: None,
 uninstall: None,
 probe: None,
 detail: Some("把 embed.backend 改成 http 即启用;地址与密钥在 [embed.http]".to_owned()),
 settings: vec![
 "embed.backend".to_owned(),
 "embed.http.url".to_owned(),
 "embed.http.model".to_owned(),
 ],
 },
 BackendManifest {
 id: "rerank".to_owned(),
 name: "重排(sidecar / 远端)".to_owned(),
 kind: BackendKind::Rerank,
 api_version: API_VERSION,
 install: None,
 uninstall: None,
 probe: None,
 detail: Some("`rerank.mode = auto` 时 sidecar 可用才开;关掉只是退回融合结果".to_owned()),
 settings: vec![
 "rerank.mode".to_owned(),
 "rerank.url".to_owned(),
 "rerank.top_n".to_owned(),
 ],
 },
 ]
}
