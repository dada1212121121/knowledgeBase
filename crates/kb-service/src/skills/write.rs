//! 在设置页新增 / 修改 / 删除 skill:服务端根据结构化字段自己生成 `manifest.toml`。
//!
//! 不收原始 TOML、不支持脚本类:界面传来的只是表单字段,这里逐项校验、再序列化,
//! 所以写进磁盘的一定是合法清单,也不可能夹带别的段。
//!
//! 写入流程是"先写临时目录、用和启动时同一套加载逻辑校验、通过了才放到正式位置":
//! 新建是把临时目录整个改名,修改只替换 `manifest.toml`(同目录内改名是原子的)。
//! 校验失败或写到一半出错,正式目录里不会留下半个 skill。

use std::path::{Path, PathBuf};

use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};

use super::{
    InsightTemplateManifest, LoaderRuleManifest, Manifest, PromptManifest, PromptStage, SkillKind,
    SkillRegistry,
};

/// 设置页表单对应的 skill 内容。三种类型共用一个结构,按 `kind` 取各自的字段。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SkillDraft {
    /// 显示名。
    pub name: String,
    /// `loader-rule` / `prompt` / `insight-template`。
    pub kind: String,
    /// 一句话说明。
    #[serde(default)]
    pub description: String,
    /// 是否启用。
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// loader-rule:匹配的相对路径(如 `**/*.proto`)。
    #[serde(default)]
    pub glob: String,
    /// loader-rule:按什么语言分块(`text` = 按行窗口)。
    #[serde(default)]
    pub lang: String,
    /// loader-rule:附加标签。
    #[serde(default)]
    pub tags: Vec<String>,
    /// prompt:`extract` / `review`。
    #[serde(default)]
    pub stage: String,
    /// prompt:提示词正文。
    #[serde(default)]
    pub template: String,
    /// insight-template:必填字段(`title` / `body` / `tags`)。
    #[serde(default)]
    pub required: Vec<String>,
    /// insight-template:正文最多多少字。
    #[serde(default)]
    pub max_body_chars: Option<usize>,
    /// insight-template:标题最多多少字。
    #[serde(default)]
    pub max_title_chars: Option<usize>,
}

fn default_true() -> bool {
    true
}

const MAX_NAME_CHARS: usize = 60;
const MAX_DESCRIPTION_CHARS: usize = 300;
const MAX_GLOB_CHARS: usize = 200;
const MAX_LANG_CHARS: usize = 30;
const MAX_TAGS: usize = 10;
const MAX_TAG_CHARS: usize = 30;
const MAX_TEMPLATE_CHARS: usize = 20_000;
const MAX_LIMIT_CHARS: usize = 1_000_000;
const MAX_ID_CHARS: usize = 64;
fn invalid(message: impl Into<String>) -> KbError {
    KbError::InvalidInput(message.into())
}

/// 单行文字:去掉首尾空白后不能是空的(`required`)、不能超长、不能有控制字符。
pub(super) fn line(value: &str, label: &str, max: usize, required: bool) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return if required {
            Err(invalid(format!("{label}不能是空的")))
        } else {
            Ok(String::new())
        };
    }
    if value.chars().count() > max {
        return Err(invalid(format!("{label}不能超过 {max} 个字")));
    }
    if value.chars().any(char::is_control) {
        return Err(invalid(format!("{label}里有不能用的字符")));
    }
    Ok(value.to_owned())
}

/// 目录名(编辑 / 删除时用它指明是哪个 skill)。来自调用方,所以要挡掉路径穿越。
pub(super) fn check_id(id: &str) -> Result<()> {
    let bad = id.is_empty()
        || id.chars().count() > MAX_ID_CHARS
        || id.starts_with('.')
        || id.contains(['/', '\\'])
        || id.chars().any(char::is_control);
    if bad {
        Err(invalid("skill 编号不合法"))
    } else {
        Ok(())
    }
}

/// 附加标签:去空白、去重(保持顺序),不能含逗号(清单展示时用逗号连接)。
fn clean_tags(tags: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag = line(tag, "标签", MAX_TAG_CHARS, false)?;
        if tag.is_empty() || out.contains(&tag) {
            continue;
        }
        if tag.contains(',') {
            return Err(invalid("标签里不能有逗号"));
        }
        out.push(tag);
    }
    if out.len() > MAX_TAGS {
        return Err(invalid(format!("标签最多 {MAX_TAGS} 个")));
    }
    Ok(out)
}

fn loader_rule_of(draft: &SkillDraft) -> Result<LoaderRuleManifest> {
    let glob = line(&draft.glob, "匹配路径", MAX_GLOB_CHARS, true)?;
    // 先在这里编译一遍,glob 写错了当场说清楚(后面加载校验也会查,但那条报错带内部路径)
    globset::Glob::new(&glob).map_err(|err| invalid(format!("匹配路径写得不对:{err}")))?;
    let lang = line(&draft.lang, "分块方式", MAX_LANG_CHARS, true)?;
    if !lang
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '+' | '#'))
    {
        return Err(invalid("分块方式只能用英文字母、数字和 - _ + #"));
    }
    Ok(LoaderRuleManifest {
        glob,
        lang,
        tags: clean_tags(&draft.tags)?,
    })
}

fn prompt_of(draft: &SkillDraft) -> Result<PromptManifest> {
    let stage = match draft.stage.trim() {
        "extract" => PromptStage::Extract,
        "review" => PromptStage::Review,
        "web_extract" | "web-extract" => PromptStage::WebExtract,
        _ => {
            return Err(invalid("提示词要选覆盖哪个阶段(提炼、审核或网页规范化)"));
        }
    };
    let template = draft.template.trim();
    if template.is_empty() {
        return Err(invalid("提示词不能是空的"));
    }
    if template.chars().count() > MAX_TEMPLATE_CHARS {
        return Err(invalid(format!("提示词不能超过 {MAX_TEMPLATE_CHARS} 个字")));
    }
    // 提示词是多行的,换行和制表符是正常内容;其它控制字符不要
    if template
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err(invalid("提示词里有不能用的字符"));
    }
    Ok(PromptManifest {
        stage,
        template: Some(template.to_owned()),
        file: None,
    })
}

fn template_of(draft: &SkillDraft) -> Result<InsightTemplateManifest> {
    let mut required: Vec<String> = Vec::new();
    for field in &draft.required {
        let field = field.trim();
        if !matches!(field, "title" | "body" | "tags") {
            return Err(invalid("必填项只能选标题、正文、标签"));
        }
        if !required.iter().any(|existing| existing == field) {
            required.push(field.to_owned());
        }
    }
    for (limit, label) in [
        (draft.max_body_chars, "正文字数上限"),
        (draft.max_title_chars, "标题字数上限"),
    ] {
        if let Some(limit) = limit
            && !(1..=MAX_LIMIT_CHARS).contains(&limit)
        {
            return Err(invalid(format!("{label}要在 1 到 {MAX_LIMIT_CHARS} 之间")));
        }
    }
    if required.is_empty() && draft.max_body_chars.is_none() && draft.max_title_chars.is_none() {
        return Err(invalid("笔记模板至少要有一条要求(必填项或字数上限)"));
    }
    Ok(InsightTemplateManifest {
        required,
        max_body_chars: draft.max_body_chars,
        max_title_chars: draft.max_title_chars,
    })
}

/// 表单 → 清单。`exec` 不能从界面创建;未知类型直接拒绝。
fn to_manifest(draft: &SkillDraft) -> Result<Manifest> {
    let name = line(&draft.name, "名称", MAX_NAME_CHARS, true)?;
    let description = line(&draft.description, "说明", MAX_DESCRIPTION_CHARS, false)?;
    let kind = match draft.kind.trim() {
        "loader-rule" => SkillKind::LoaderRule,
        "prompt" => SkillKind::Prompt,
        "insight-template" => SkillKind::InsightTemplate,
        "exec" => return Err(invalid("脚本类 skill 不能在界面里创建")),
        "plugin" => {
            return Err(invalid(
                "插件请直接编辑 manifest.toml(需要 exec / index 等段落)",
            ));
        }
        _ => return Err(invalid("skill 类型只能是加载规则、提示词或笔记模板")),
    };
    let mut manifest = Manifest {
        name: Some(name),
        kind,
        enabled: Some(draft.enabled),
        description: (!description.is_empty()).then_some(description),
        loader_rule: None,
        prompt: None,
        insight_template: None,
        version: None,
        api_version: None,
        index: None,
        exec: None,
        source: None,
    };
    match kind {
        SkillKind::LoaderRule => manifest.loader_rule = Some(loader_rule_of(draft)?),
        SkillKind::Prompt => manifest.prompt = Some(prompt_of(draft)?),
        SkillKind::InsightTemplate => manifest.insight_template = Some(template_of(draft)?),
        SkillKind::Exec | SkillKind::Plugin => unreachable!("上面已拒绝"),
    }
    Ok(manifest)
}
/// 读一个 skill 目录里的清单,还原成可编辑的表单内容。脚本类和读不出来的返回 `None`。
pub(super) fn draft_of(dir: &Path) -> Option<SkillDraft> {
    let text = std::fs::read_to_string(dir.join("manifest.toml")).ok()?;
    let manifest: Manifest = toml::from_str(&text).ok()?;
    let dir_name = dir.file_name()?.to_string_lossy().into_owned();
    let mut draft = SkillDraft {
        name: manifest.name.clone().unwrap_or(dir_name),
        description: manifest.description.clone().unwrap_or_default(),
        enabled: manifest.enabled.unwrap_or(true),
        kind: manifest.kind.as_str().to_owned(),
        ..SkillDraft::default()
    };
    match manifest.kind {
        SkillKind::LoaderRule => {
            let rule = manifest.loader_rule?;
            draft.glob = rule.glob;
            draft.lang = rule.lang;
            draft.tags = rule.tags;
        }
        SkillKind::Prompt => {
            let prompt = manifest.prompt?;
            draft.stage = prompt.stage.as_str().to_owned();
            draft.template = match (prompt.template, prompt.file) {
                (Some(template), _) => template,
                // 手写的清单可以引用同目录下的提示词文件;只读目录内的相对路径,别的一律当读不出
                (None, Some(file)) if is_inside(&file) => {
                    std::fs::read_to_string(dir.join(file)).ok()?
                }
                _ => return None,
            };
        }
        SkillKind::InsightTemplate => {
            let template = manifest.insight_template?;
            draft.required = template.required;
            draft.max_body_chars = template.max_body_chars;
            draft.max_title_chars = template.max_title_chars;
        }
        SkillKind::Exec | SkillKind::Plugin => return None,
    }
    Some(draft)
}

/// 清单里引用的文件路径必须是 skill 目录内的相对路径。
fn is_inside(file: &str) -> bool {
    let path = Path::new(file);
    !file.is_empty()
        && path.is_relative()
        && path
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
}

/// 由显示名生成目录名:小写字母数字和 `-`,重名加序号。中文名没有可用字符时用 `skill`。
pub(super) fn unique_slug(root: &Path, name: &str) -> String {
    let mut slug = String::new();
    for ch in name.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let base: String = if slug.is_empty() {
        "skill".to_owned()
    } else {
        slug.chars().take(40).collect()
    };
    let base = base.trim_end_matches('-').to_owned();
    let mut candidate = base.clone();
    let mut n = 2u32;
    while root.join(&candidate).exists() {
        candidate = format!("{base}-{n}");
        n += 1;
    }
    candidate
}

pub(super) fn write_manifest(path: &Path, manifest: &Manifest) -> Result<()> {
    let text = toml::to_string_pretty(manifest)
        .map_err(|err| KbError::Internal(format!("生成 manifest 失败: {err}")))?;
    std::fs::write(path, text)
        .map_err(|err| KbError::Internal(format!("写 {} 失败: {err}", path.display())))
}

/// 临时目录(点开头,扫描时会被跳过)。
pub(super) fn scratch_dir(root: &Path) -> PathBuf {
    root.join(format!(".saving-{}", uuid::Uuid::now_v7().simple()))
}
/// 目录存在、是真目录(不是软链)、里面有 manifest.toml:才算一个可以改 / 删的 skill。
pub(super) fn skill_dir(root: &Path, id: &str) -> Result<PathBuf> {
    check_id(id)?;
    let path = root.join(id);
    let real_dir = std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir());
    if !real_dir || !path.join("manifest.toml").is_file() {
        return Err(KbError::NotFound(format!("skill {id}")));
    }
    Ok(path)
}

impl SkillRegistry {
    /// 新建(`id = None`)或修改(`id = Some(目录名)`)一个 skill,返回它的目录名。
    ///
    /// 先在临时目录里写出清单,用启动时同一套加载逻辑校验一遍(启用与否都校验),
    /// 通过了才放到正式位置;任何一步失败都不会在 skills 目录里留下东西。
    pub fn save(root: &Path, id: Option<&str>, draft: &SkillDraft) -> Result<String> {
        let mut manifest = to_manifest(draft)?;
        let existing = id.map(|id| skill_dir(root, id)).transpose()?;
        std::fs::create_dir_all(root)
            .map_err(|err| KbError::Internal(format!("创建 skills 目录失败: {err}")))?;
        let scratch = scratch_dir(root);
        std::fs::create_dir(&scratch)
            .map_err(|err| KbError::Internal(format!("创建临时目录失败: {err}")))?;
        let result = Self::stage_and_commit(root, &scratch, &mut manifest, existing.as_deref());
        // 改名成功后临时目录已经不在了;失败时清掉。两种情况都忽略"不存在"
        let _ = std::fs::remove_dir_all(&scratch);
        result
    }

    fn stage_and_commit(
        root: &Path,
        scratch: &Path,
        manifest: &mut Manifest,
        existing: Option<&Path>,
    ) -> Result<String> {
        // 校验时一律按"启用"加载:停用的 skill load_one 会直接跳过,写坏了也发现不了
        let real_enabled = manifest.enabled;
        manifest.enabled = Some(true);
        let manifest_path = scratch.join("manifest.toml");
        write_manifest(&manifest_path, manifest)?;
        SkillRegistry::default()
            .load_one(scratch, false)
            .map_err(|err| invalid(format!("这个 skill 加载不了:{err}")))?;
        manifest.enabled = real_enabled;
        write_manifest(&manifest_path, manifest)?;

        match existing {
            Some(dir) => {
                std::fs::rename(&manifest_path, dir.join("manifest.toml"))
                    .map_err(|err| KbError::Internal(format!("保存失败: {err}")))?;
                Ok(dir_id(dir))
            }
            None => {
                let name = manifest.name.clone().unwrap_or_default();
                let slug = unique_slug(root, &name);
                std::fs::rename(scratch, root.join(&slug))
                    .map_err(|err| KbError::Internal(format!("保存失败: {err}")))?;
                Ok(slug)
            }
        }
    }

    /// 删除一个 skill(整个目录)。只删 skills 目录下直接的、带 manifest.toml 的真目录。
    pub fn delete(root: &Path, id: &str) -> Result<()> {
        let dir = skill_dir(root, id)?;
        std::fs::remove_dir_all(&dir).map_err(|err| KbError::Internal(format!("删除失败: {err}")))
    }

    /// 取一个 skill 可编辑的完整内容(设置页点"编辑"时用)。
    pub fn draft(&self, id: &str) -> Result<SkillDraft> {
        let info = self
            .skills
            .iter()
            .find(|info| info.id == id)
            .ok_or_else(|| KbError::NotFound(format!("skill {id}")))?;
        info.draft.clone().ok_or_else(|| {
            invalid("这个 skill 不能在界面里编辑(脚本类,或清单里引用了目录外的文件)")
        })
    }
}

fn dir_id(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::super::is_scratch;
    use super::*;

    fn manifest(glob: &str, enabled: bool) -> Manifest {
        Manifest {
            name: Some("规则".to_owned()),
            kind: SkillKind::LoaderRule,
            enabled: Some(enabled),
            description: None,
            loader_rule: Some(LoaderRuleManifest {
                glob: glob.to_owned(),
                lang: "text".to_owned(),
                tags: Vec::new(),
            }),
            prompt: None,
            insight_template: None,
            version: None,
            api_version: None,
            index: None,
            exec: None,
            source: None,
        }
    }

    /// 前面的字段检查已经拦掉了绝大多数写坏的内容;这一步是最后一道:用启动时同一套加载逻辑再试一遍。
    /// 停用的 skill 加载时会被直接跳过,所以校验时必须按"启用"加载,否则写坏的停用 skill 会被放过。
    #[test]
    fn the_final_load_check_also_covers_disabled_skills() {
        let root = tempfile::tempdir().expect("目录");
        let scratch = scratch_dir(root.path());
        std::fs::create_dir(&scratch).expect("建");
        let mut broken = manifest("[", false);
        let err = SkillRegistry::stage_and_commit(root.path(), &scratch, &mut broken, None)
            .expect_err("写坏的停用 skill 也要被拒绝");
        assert!(matches!(err, KbError::InvalidInput(_)), "{err}");
        assert!(
            std::fs::read_dir(root.path())
                .expect("读")
                .flatten()
                .all(|entry| is_scratch(&entry.path())),
            "正式目录里什么都没留下"
        );
    }

    #[test]
    fn a_valid_disabled_skill_is_committed_with_its_real_enabled_flag() {
        let root = tempfile::tempdir().expect("目录");
        let scratch = scratch_dir(root.path());
        std::fs::create_dir(&scratch).expect("建");
        let mut fine = manifest("**/*.proto", false);
        let id =
            SkillRegistry::stage_and_commit(root.path(), &scratch, &mut fine, None).expect("提交");
        let text =
            std::fs::read_to_string(root.path().join(&id).join("manifest.toml")).expect("读");
        assert!(
            text.contains("enabled = false"),
            "校验时临时改成启用,落盘的必须是真实状态:{text}"
        );
    }
}
