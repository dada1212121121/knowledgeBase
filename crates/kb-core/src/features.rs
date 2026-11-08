//! 功能点目录(多用户设计说明)。
//!
//! 一个**功能点**是「角色能不能用」的最小单位。每个能力(capability)在注册表里绑定一个功能点;
//! 角色勾选功能点,用户可以在角色之外单独允许 / 禁止。这里只放静态目录,不依赖数据库,
//! 前后端、CLI、测试都从同一张表取名字,避免各写一份。
//!
//! 约定:
//! - [`BASE`] 不是功能点,而是「所有启用的账号都有」的基础能力(看自己的知识库、个人设置……)。
//! - `ai: true` 的功能点受 AI 总开关管(第 6.6 节):总开关关闭时一律视为没有。
//! - `dangerous: true` 的功能点只应授予管理员或标为「危险」的角色。

use std::collections::BTreeSet;

/// 基础能力:不设功能点,所有启用的账号都有。
pub const BASE: &str = "base";

/// 一个功能点的静态描述。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeatureDef {
    /// 稳定 id,形如 `docs.notes`。存库、传前端都用它。
    pub id: &'static str,
    /// 分组(界面按它分段)。
    pub group: &'static str,
    /// 中文名。
    pub label: &'static str,
    /// 一句话说明。
    pub hint: &'static str,
    /// 普通用户默认是否开启。
    pub default_user: bool,
    /// 是否危险(系统级,只应授予管理员或「危险」角色)。
    pub dangerous: bool,
    /// 是否属于 AI 功能(受 AI 总开关管)。
    pub ai: bool,
}

const fn def(
    id: &'static str,
    group: &'static str,
    label: &'static str,
    hint: &'static str,
    default_user: bool,
) -> FeatureDef {
    FeatureDef {
        id,
        group,
        label,
        hint,
        default_user,
        dangerous: false,
        ai: false,
    }
}

const fn ai(mut item: FeatureDef) -> FeatureDef {
    item.ai = true;
    item
}

const fn danger(mut item: FeatureDef) -> FeatureDef {
    item.dangerous = true;
    item
}

/// 全部功能点,界面按这个顺序展示。
pub const FEATURES: &[FeatureDef] = &[
    // ---- 文档 ----
    def(
        "docs.notes",
        "文档",
        "新建、编辑和删除笔记",
        "含标签、状态、批量打标签",
        true,
    ),
    def(
        "docs.upload",
        "文档",
        "上传文件与附件",
        "上传、导入、解析队列管理",
        true,
    ),
    def(
        "docs.edit_text",
        "文档",
        "在线编辑文本文件",
        "含版本历史与恢复",
        true,
    ),
    def(
        "docs.annotate",
        "文档",
        "批注与转 Markdown",
        "给文档加批注、把文件转成 Markdown 副本",
        true,
    ),
    // ---- 检索 ----
    def("search.basic", "检索", "检索", "混合检索与反馈", true),
    ai(def(
        "search.deep",
        "检索",
        "深度检索",
        "调用大模型改写查询并总结",
        true,
    )),
    def(
        "search.tune",
        "检索",
        "检索调优与评测",
        "权重建议、黄金集评测",
        true,
    ),
    // ---- AI ----
    ai(def(
        "ai.extract",
        "AI",
        "自动提炼与审核",
        "从会话和提交里提炼候选经验,进审核收件箱",
        true,
    )),
    ai(def(
        "ai.organize",
        "AI",
        "整理",
        "去重建议、主题归纳、质量报告",
        true,
    )),
    ai(def("ai.assistant", "AI", "AI 助手", "对话式管家", false)),
    ai(def(
        "ai.acp",
        "AI",
        "编码代理(ACP)",
        "在服务器沙箱里运行外部编码代理。会用到服务器上这些代理已登录的账号(只读挂入沙箱),只给信得过的人",
        false,
    )),
    // ---- 来源 ----
    def(
        "sources.web",
        "来源",
        "网页来源",
        "抓取网址并定期刷新",
        true,
    ),
    danger(def(
        "sources.local",
        "来源",
        "服务器目录与 Git 来源",
        "绑定服务器上的目录、安装 git hook",
        false,
    )),
    // ---- 协作 ----
    def(
        "collab.friends",
        "协作",
        "好友",
        "搜索、申请、管理好友",
        true,
    ),
    def(
        "collab.share",
        "协作",
        "分享给其他用户",
        "把目录或文件授权给指定用户",
        true,
    ),
    def(
        "collab.link_users",
        "协作",
        "创建登录用户可访问的链接",
        "",
        true,
    ),
    def(
        "collab.link_guest",
        "协作",
        "创建游客链接",
        "不登录也能打开",
        true,
    ),
    def("collab.edit", "协作", "多人在线编辑", "", true),
    // ---- 开放接口 ----
    def(
        "api.tokens",
        "开放接口",
        "API 令牌与 MCP",
        "创建个人访问令牌,接入 AI 工具",
        true,
    ),
    // ---- 系统 ----
    danger(def(
        "sys.inspect",
        "系统",
        "查看他人知识库(只读)",
        "在用户管理里只读查看其他用户的文档、任务与导入记录;打开与浏览会记入系统审计",
        false,
    )),
    danger(def(
        "sys.users",
        "系统",
        "用户、角色与邀请码",
        "只应授予管理员",
        false,
    )),
    danger(def(
        "sys.settings",
        "系统",
        "系统参数、模型与组件",
        "配置、邮件、模型、OCR、ACP 安装",
        false,
    )),
    danger(def(
        "sys.ops",
        "系统",
        "备份、状态与全站审计",
        "备份、系统状态、分享治理",
        false,
    )),
];

/// 按 id 查功能点。
pub fn find(id: &str) -> Option<&'static FeatureDef> {
    FEATURES.iter().find(|item| item.id == id)
}

/// 是不是已知功能点(含 [`BASE`])。
pub fn is_known(id: &str) -> bool {
    id == BASE || find(id).is_some()
}

/// 是不是 AI 功能点。
pub fn is_ai(id: &str) -> bool {
    find(id).is_some_and(|item| item.ai)
}

/// 普通用户默认开启的功能点。
pub fn default_user_features() -> Vec<&'static str> {
    FEATURES
        .iter()
        .filter(|item| item.default_user)
        .map(|item| item.id)
        .collect()
}

/// 系统层面的 AI 开关状态(`[ai]` 配置算出来的)。
///
/// `master` 是总开关;`off` 是被单独关掉的 AI 功能点。总开关关了,所有 AI 功能点都不可用,
/// 谁也不例外(管理员也一样)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiState {
    /// 总开关。
    pub master: bool,
    /// 被单独关闭的 AI 功能点 id。
    pub off: BTreeSet<String>,
}

impl AiState {
    /// 全部开着。
    pub fn on() -> Self {
        Self {
            master: true,
            off: BTreeSet::new(),
        }
    }

    /// 总开关关闭。
    pub fn disabled() -> Self {
        Self {
            master: false,
            off: BTreeSet::new(),
        }
    }

    /// 某个功能点在系统层面可不可用。非 AI 功能点永远可用。
    pub fn allows(&self, feature: &str) -> bool {
        !is_ai(feature) || (self.master && !self.off.contains(feature))
    }
}

impl Default for AiState {
    fn default() -> Self {
        Self::on()
    }
}

impl From<bool> for AiState {
    fn from(master: bool) -> Self {
        if master { Self::on() } else { Self::disabled() }
    }
}

/// 一个用户**最终生效**的功能集合。
///
/// 由角色勾选 + 用户例外(允许 / 禁止)+ AI 总开关算出;调用时只做集合查询。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FeatureSet {
    all: bool,
    allowed: BTreeSet<String>,
    denied: BTreeSet<String>,
    ai: AiState,
}

impl FeatureSet {
    /// 拥有全部功能(管理员角色),但仍受 AI 总开关约束。
    pub fn all(ai: impl Into<AiState>) -> Self {
        Self {
            all: true,
            allowed: BTreeSet::new(),
            denied: BTreeSet::new(),
            ai: ai.into(),
        }
    }

    /// 拥有全部功能,但用户例外里被**禁止**的除外(比如临时收走某个管理员的 ACP)。
    pub fn all_except(deny: impl IntoIterator<Item = String>, ai: impl Into<AiState>) -> Self {
        Self {
            all: true,
            allowed: BTreeSet::new(),
            denied: deny.into_iter().collect(),
            ai: ai.into(),
        }
    }

    /// 由角色勾选、用户例外算出。`deny` 优先于 `allow`。
    pub fn resolve(
        role_features: impl IntoIterator<Item = String>,
        allow: impl IntoIterator<Item = String>,
        deny: impl IntoIterator<Item = String>,
        ai: impl Into<AiState>,
    ) -> Self {
        let mut allowed: BTreeSet<String> = role_features.into_iter().collect();
        allowed.extend(allow);
        Self {
            all: false,
            allowed,
            denied: deny.into_iter().collect(),
            ai: ai.into(),
        }
    }

    /// 本机超级用户(`kb.sock`):全部功能,不受 AI 总开关影响(它是运维通道)。
    pub fn local() -> Self {
        Self::all(true)
    }

    /// 有没有这个功能点。基础能力([`BASE`])永远有。
    pub fn allows(&self, feature: &str) -> bool {
        if feature == BASE {
            return true;
        }
        if !self.ai.allows(feature) {
            return false;
        }
        if self.denied.contains(feature) {
            return false;
        }
        self.all || self.allowed.contains(feature)
    }

    /// 最终生效的功能点 id 列表(给前端的 `me` 接口;顺序同 [`FEATURES`])。
    pub fn effective(&self) -> Vec<&'static str> {
        FEATURES
            .iter()
            .filter(|item| self.allows(item.id))
            .map(|item| item.id)
            .collect()
    }

    /// AI 总开关是否开着。
    pub fn ai_enabled(&self) -> bool {
        self.ai.master
    }

    /// 这个功能点是不是被系统的 AI 开关挡掉的(调用被拒时用来区分「没开通」和「AI 已关闭」)。
    pub fn blocked_by_ai_switch(&self, feature: &str) -> bool {
        !self.ai.allows(feature)
    }

    /// 是不是「全部功能」的角色(管理员)。
    pub fn is_all(&self) -> bool {
        self.all
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_well_formed() {
        let mut seen = BTreeSet::new();
        for item in FEATURES {
            assert!(seen.insert(item.id), "功能点 id 重复:{}", item.id);
            assert!(
                item.id.contains('.')
                    && item
                        .id
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c == '.' || c == '_'),
                "id 形如 group.name:{}",
                item.id
            );
            assert!(!item.label.is_empty() && !item.group.is_empty());
            assert!(item.id != BASE, "base 不是功能点");
        }
    }

    #[test]
    fn dangerous_features_are_off_for_normal_users() {
        for item in FEATURES.iter().filter(|item| item.dangerous) {
            assert!(!item.default_user, "危险功能不能默认给普通用户:{}", item.id);
        }
        assert!(find("sys.users").is_some_and(|item| item.dangerous));
    }

    #[test]
    fn normal_user_defaults_match_the_plan() {
        let defaults = default_user_features();
        for expected in [
            "docs.notes",
            "docs.upload",
            "search.basic",
            "search.deep",
            "collab.share",
            "collab.link_guest",
            "api.tokens",
        ] {
            assert!(defaults.contains(&expected), "普通用户默认应有 {expected}");
        }
        for not_expected in [
            "ai.assistant",
            "ai.acp",
            "sources.local",
            "sys.inspect",
            "sys.users",
            "sys.settings",
            "sys.ops",
        ] {
            assert!(
                !defaults.contains(&not_expected),
                "普通用户默认不应有 {not_expected}"
            );
        }
    }

    #[test]
    fn base_is_always_allowed() {
        let nobody = FeatureSet::resolve([], [], [], true);
        assert!(nobody.allows(BASE));
        assert!(!nobody.allows("docs.notes"));
    }

    #[test]
    fn role_user_override_and_deny_precedence() {
        let set = FeatureSet::resolve(
            ["docs.notes".to_owned(), "docs.upload".to_owned()],
            ["ai.acp".to_owned()],
            ["docs.upload".to_owned()],
            true,
        );
        assert!(set.allows("docs.notes"));
        assert!(set.allows("ai.acp"), "例外允许生效");
        assert!(!set.allows("docs.upload"), "禁止优先于角色勾选");
        assert!(!set.allows("search.basic"), "没勾选就没有");
    }

    #[test]
    fn admin_has_everything_but_still_obeys_the_ai_switch() {
        let on = FeatureSet::all(true);
        assert!(on.allows("sys.users") && on.allows("ai.acp"));
        let off = FeatureSet::all(false);
        assert!(off.allows("sys.users"));
        assert!(
            !off.allows("ai.acp"),
            "AI 总开关关闭后管理员也看不到 AI 功能"
        );
        assert!(!off.allows("search.deep"));
        assert!(off.allows("search.basic"));
    }

    #[test]
    fn ai_switch_hides_ai_features_for_everyone() {
        let set = FeatureSet::resolve(
            default_user_features().into_iter().map(str::to_owned),
            [],
            [],
            false,
        );
        for item in FEATURES.iter().filter(|item| item.ai) {
            assert!(!set.allows(item.id), "{} 应被 AI 总开关隐藏", item.id);
        }
        assert!(set.allows("docs.notes"));
        assert!(!set.effective().iter().any(|id| is_ai(id)));
    }

    #[test]
    fn admin_deny_override_still_applies() {
        let set = FeatureSet::all_except(["ai.acp".to_owned()], true);
        assert!(set.allows("sys.users") && set.allows("ai.assistant"));
        assert!(!set.allows("ai.acp"), "管理员也可以被单独禁止某项");
        assert!(set.is_all());
    }

    #[test]
    fn single_ai_features_can_be_switched_off_while_the_master_is_on() {
        let state = AiState {
            master: true,
            off: ["ai.acp".to_owned(), "search.deep".to_owned()]
                .into_iter()
                .collect(),
        };
        let set = FeatureSet::resolve(
            default_user_features().into_iter().map(str::to_owned),
            [],
            [],
            state.clone(),
        );
        assert!(!set.allows("search.deep"), "单独关掉的 AI 功能点不可用");
        assert!(set.allows("ai.extract") && set.allows("docs.notes"));
        assert!(set.blocked_by_ai_switch("search.deep") && !set.blocked_by_ai_switch("docs.notes"));
        let admin = FeatureSet::all(state);
        assert!(
            !admin.allows("ai.acp") && admin.allows("ai.assistant") && admin.allows("sys.users")
        );
    }

    #[test]
    fn local_superuser_has_all_features() {
        let local = FeatureSet::local();
        assert!(FEATURES.iter().all(|item| local.allows(item.id)));
    }
}
