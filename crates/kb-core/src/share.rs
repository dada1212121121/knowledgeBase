//! 文档权限的基础类型(多用户设计说明):资源键、角色、动作。
//!
//! 全是纯函数,不碰数据库。权限引擎(查授权、算有效角色)在 `kb-meta` 和 `kb-cli`,
//! 但它们**只认这里的类型**:任何字符串在变成资源键之前都要过 [`ResourceKey::parse`] 或各构造函数的校验,
//! 所以「合集名里带斜杠」「路径里有 `..`」「百分号编码绕过」这类问题只需要在这一个地方堵。
//!
//! ## 资源键
//!
//! ```text
//! space:<sid>                                  整个知识库
//! col:<sid>/<集合>                             一个集合
//! dir:<sid>/<集合>/<段>/<段>…                   集合里的文件夹(路径前缀)
//! doc:<sid>/<集合>/i/<insight id>              一条笔记
//! doc:<sid>/<集合>/f/<段>/<段>/<文件名>          一个文件
//! ```
//!
//! 每一段(集合名、路径段)用 `%XX` 编码:除了 `A-Z a-z 0-9 . _ ~ -` 的字节全部编码,所以键里的 `/`
//! 永远是分隔符,集合名里的斜杠(`knowledgeBase/insights`)变成 `%2F`,不会和目录层级混淆。

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{KbError, Result};

pub mod link;

/// 键的总长度上限。
pub const MAX_KEY_LEN: usize = 1024;
/// 路径最多多少层。
pub const MAX_DEPTH: usize = 64;

/// 文档角色(也是授权里能给的角色,所有者除外)。顺序即高低:后面的包含前面的全部能力。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// 可查看。
    Viewer,
    /// 可评论。
    Commenter,
    /// 可编辑。
    Editor,
    /// 可管理。
    Manager,
    /// 所有者(只会由「是知识库的主人」推出来,不存进授权表)。
    Owner,
}

impl Role {
    /// 库里和接口里的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Commenter => "commenter",
            Self::Editor => "editor",
            Self::Manager => "manager",
            Self::Owner => "owner",
        }
    }

    /// 解析。
    pub fn parse(text: &str) -> Result<Self> {
        Ok(match text {
            "viewer" => Self::Viewer,
            "commenter" => Self::Commenter,
            "editor" => Self::Editor,
            "manager" => Self::Manager,
            "owner" => Self::Owner,
            other => return Err(KbError::InvalidInput(format!("未知的角色 {other:?}"))),
        })
    }

    /// 解析一个**可授予**的角色(不含所有者:所有权只能转移,不能当协作者授予)。
    pub fn parse_grantable(text: &str) -> Result<Self> {
        match Self::parse(text)? {
            Self::Owner => Err(KbError::InvalidInput(
                "不能把「所有者」作为协作者角色授予,要转移所有权请用转移功能".to_owned(),
            )),
            role => Ok(role),
        }
    }

    /// 中文名。
    pub fn label(self) -> &'static str {
        match self {
            Self::Viewer => "可查看",
            Self::Commenter => "可评论",
            Self::Editor => "可编辑",
            Self::Manager => "可管理",
            Self::Owner => "所有者",
        }
    }

    /// 这个角色能不能做某个动作(设计规范的表)。
    pub fn allows(self, action: Action) -> bool {
        self >= action.min_role()
    }
}

/// 对文档能做的动作。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Action {
    /// 阅读、在授权范围内检索。
    View,
    /// 下载原件、复制、打印。
    Download,
    /// 批注 / 评论。
    Comment,
    /// 编辑正文、上传附件、改标题标签。
    Edit,
    /// 在文件夹 / 集合里新建文档。
    Create,
    /// 查看版本历史。
    History,
    /// 恢复历史版本。
    Restore,
    /// 添加 / 移除协作者。
    ManageGrants,
    /// 修改链接权限。
    ManageLinks,
    /// 删除、移动。
    Delete,
    /// 转移所有权、删除知识库。
    TransferOwner,
}

impl Action {
    /// 做这个动作至少要什么角色。
    pub fn min_role(self) -> Role {
        match self {
            Self::View | Self::Download => Role::Viewer,
            Self::Comment => Role::Commenter,
            Self::Edit | Self::Create | Self::History => Role::Editor,
            Self::Restore | Self::ManageGrants | Self::ManageLinks | Self::Delete => Role::Manager,
            Self::TransferOwner => Role::Owner,
        }
    }
}

/// 文档的引用方式:笔记按 id,文件按集合内的相对路径。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum DocRef {
    /// 一条笔记(insight)的 id。
    Insight(String),
    /// 一个文件在集合内的相对路径(`/` 分隔)。
    File(String),
}

/// 一个资源。构造时校验,之后可以放心拼进键、拿去查库。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum ResourceKey {
    /// 整个知识库。
    Space {
        /// 知识库 id。
        sid: String,
    },
    /// 一个集合。
    Collection {
        /// 知识库 id。
        sid: String,
        /// 集合名。
        name: String,
    },
    /// 集合里的文件夹。
    Dir {
        /// 知识库 id。
        sid: String,
        /// 集合名。
        name: String,
        /// 文件夹路径(`a/b`,不带首尾斜杠)。
        path: String,
    },
    /// 一篇文档。
    Doc {
        /// 知识库 id。
        sid: String,
        /// 集合名。
        name: String,
        /// 文档。
        doc: DocRef,
    },
}

fn bad(what: &str) -> KbError {
    KbError::InvalidInput(format!("资源键不合法:{what}"))
}

/// 知识库 id:`sp_` 开头,后面是字母数字下划线。
fn check_sid(sid: &str) -> Result<()> {
    let ok = sid.len() > 3
        && sid.len() <= 64
        && sid.starts_with("sp_")
        && sid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    if ok { Ok(()) } else { Err(bad("知识库 id")) }
}

/// 集合名 / 路径段 / insight id:不为空,不含控制字符,不是 `.` 或 `..`,不超长。
fn check_segment(text: &str, what: &str) -> Result<()> {
    if text.is_empty() || text.len() > 255 {
        return Err(bad(what));
    }
    if text == "." || text == ".." || text.chars().any(char::is_control) {
        return Err(bad(what));
    }
    Ok(())
}

/// 把相对路径拆成合法的段。拒绝空段、`.`、`..`、反斜杠、绝对路径。
fn split_path(path: &str) -> Result<Vec<&str>> {
    if path.is_empty() || path.starts_with('/') || path.ends_with('/') || path.contains('\\') {
        return Err(bad("路径"));
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() > MAX_DEPTH {
        return Err(bad("路径太深"));
    }
    for part in &parts {
        check_segment(part, "路径段")?;
    }
    Ok(parts)
}

fn encode(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn decode(segment: &str) -> Result<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = segment.get(i + 1..i + 3).ok_or_else(|| bad("编码不完整"))?;
            // 只收大写十六进制:每个字符串只有唯一的写法,键才能直接按字节比较
            if !hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
            {
                return Err(bad("编码不规范"));
            }
            out.push(u8::from_str_radix(hex, 16).map_err(|_| bad("编码"))?);
            i += 3;
        } else if bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'.' | b'_' | b'~' | b'-')
        {
            out.push(bytes[i]);
            i += 1;
        } else {
            return Err(bad("含未编码的字符"));
        }
    }
    String::from_utf8(out).map_err(|_| bad("不是 UTF-8"))
}

impl ResourceKey {
    /// 整个知识库。
    pub fn space(sid: &str) -> Result<Self> {
        check_sid(sid)?;
        Ok(Self::Space {
            sid: sid.to_owned(),
        })
    }

    /// 一个集合。
    pub fn collection(sid: &str, name: &str) -> Result<Self> {
        check_sid(sid)?;
        check_segment(name, "集合名")?;
        Ok(Self::Collection {
            sid: sid.to_owned(),
            name: name.to_owned(),
        })
    }

    /// 集合里的文件夹。
    pub fn dir(sid: &str, name: &str, path: &str) -> Result<Self> {
        check_sid(sid)?;
        check_segment(name, "集合名")?;
        split_path(path)?;
        Ok(Self::Dir {
            sid: sid.to_owned(),
            name: name.to_owned(),
            path: path.to_owned(),
        })
    }

    /// 一条笔记。
    pub fn insight(sid: &str, name: &str, id: &str) -> Result<Self> {
        check_sid(sid)?;
        check_segment(name, "集合名")?;
        check_segment(id, "笔记 id")?;
        Ok(Self::Doc {
            sid: sid.to_owned(),
            name: name.to_owned(),
            doc: DocRef::Insight(id.to_owned()),
        })
    }

    /// 一个文件。
    pub fn file(sid: &str, name: &str, path: &str) -> Result<Self> {
        check_sid(sid)?;
        check_segment(name, "集合名")?;
        split_path(path)?;
        Ok(Self::Doc {
            sid: sid.to_owned(),
            name: name.to_owned(),
            doc: DocRef::File(path.to_owned()),
        })
    }

    /// 所在的知识库。
    pub fn space_id(&self) -> &str {
        match self {
            Self::Space { sid }
            | Self::Collection { sid, .. }
            | Self::Dir { sid, .. }
            | Self::Doc { sid, .. } => sid,
        }
    }

    /// 所在的集合名(整个知识库没有)。
    pub fn collection_name(&self) -> Option<&str> {
        match self {
            Self::Space { .. } => None,
            Self::Collection { name, .. } | Self::Dir { name, .. } | Self::Doc { name, .. } => {
                Some(name)
            }
        }
    }

    /// 从自己到知识库的继承链:先自己,然后一层层往上,最后是 `space:`。
    /// 权限引擎沿着它找授权;「停止继承」就是在某一层把后面的截掉。
    pub fn lineage(&self) -> Vec<ResourceKey> {
        let mut chain = vec![self.clone()];
        match self {
            Self::Space { .. } => {}
            Self::Collection { sid, .. } => chain.push(Self::Space { sid: sid.clone() }),
            Self::Dir { sid, name, path } => {
                let parts: Vec<&str> = path.split('/').collect();
                for depth in (1..parts.len()).rev() {
                    chain.push(Self::Dir {
                        sid: sid.clone(),
                        name: name.clone(),
                        path: parts[..depth].join("/"),
                    });
                }
                chain.push(Self::Collection {
                    sid: sid.clone(),
                    name: name.clone(),
                });
                chain.push(Self::Space { sid: sid.clone() });
            }
            Self::Doc { sid, name, doc } => {
                if let DocRef::File(path) = doc {
                    let parts: Vec<&str> = path.split('/').collect();
                    for depth in (1..parts.len()).rev() {
                        chain.push(Self::Dir {
                            sid: sid.clone(),
                            name: name.clone(),
                            path: parts[..depth].join("/"),
                        });
                    }
                }
                chain.push(Self::Collection {
                    sid: sid.clone(),
                    name: name.clone(),
                });
                chain.push(Self::Space { sid: sid.clone() });
            }
        }
        chain
    }

    /// 自己的上一层(`space:` 没有)。
    pub fn parent(&self) -> Option<ResourceKey> {
        self.lineage().into_iter().nth(1)
    }

    /// 自己是不是 `ancestor` 或在它底下(含相等)。
    pub fn is_within(&self, ancestor: &ResourceKey) -> bool {
        self.lineage().contains(ancestor)
    }

    /// 解析键字符串。**唯一**把外部字符串变成资源键的入口(另有各构造函数用于已经拆好的字段)。
    pub fn parse(text: &str) -> Result<Self> {
        if text.len() > MAX_KEY_LEN {
            return Err(bad("太长"));
        }
        let (kind, rest) = text.split_once(':').ok_or_else(|| bad("缺少类型前缀"))?;
        let parts: Vec<&str> = rest.split('/').collect();
        let key = match (kind, parts.as_slice()) {
            ("space", [sid]) => Self::space(sid)?,
            ("col", [sid, name]) => Self::collection(sid, &decode(name)?)?,
            ("dir", [sid, name, path @ ..]) if !path.is_empty() => {
                let decoded: Result<Vec<String>> = path.iter().map(|part| decode(part)).collect();
                Self::dir(sid, &decode(name)?, &decoded?.join("/"))?
            }
            ("doc", [sid, name, "i", id]) => Self::insight(sid, &decode(name)?, &decode(id)?)?,
            ("doc", [sid, name, "f", path @ ..]) if !path.is_empty() => {
                let decoded: Result<Vec<String>> = path.iter().map(|part| decode(part)).collect();
                Self::file(sid, &decode(name)?, &decoded?.join("/"))?
            }
            _ => return Err(bad("格式")),
        };
        // 规范化往返:同一个资源只有一种写法,否则「同一份文档两个键」会让授权漏查
        if key.to_string() != text {
            return Err(bad("不是规范写法"));
        }
        Ok(key)
    }
}

impl fmt::Display for ResourceKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let path = |path: &str| path.split('/').map(encode).collect::<Vec<_>>().join("/");
        match self {
            Self::Space { sid } => write!(f, "space:{sid}"),
            Self::Collection { sid, name } => write!(f, "col:{sid}/{}", encode(name)),
            Self::Dir { sid, name, path: p } => write!(f, "dir:{sid}/{}/{}", encode(name), path(p)),
            Self::Doc {
                sid,
                name,
                doc: DocRef::Insight(id),
            } => {
                write!(f, "doc:{sid}/{}/i/{}", encode(name), encode(id))
            }
            Self::Doc {
                sid,
                name,
                doc: DocRef::File(p),
            } => {
                write!(f, "doc:{sid}/{}/f/{}", encode(name), path(p))
            }
        }
    }
}

/// 接口里「指哪个资源」的结构化写法。客户端不用自己拼百分号编码的键:
/// 填类型和几个字段就行,服务端过 [`ResourceKey`] 的构造函数统一校验。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ShareTarget {
    /// `space` / `collection` / `dir` / `file` / `insight`。
    pub kind: String,
    /// 知识库 id;不写 = 调用者自己的知识库。
    #[serde(default)]
    pub space_id: Option<String>,
    /// 集合名(`collection` / `dir` / `file` / `insight` 需要)。
    #[serde(default)]
    pub collection: Option<String>,
    /// 路径(`dir` / `file` 需要,`a/b` 形式)。
    #[serde(default)]
    pub path: Option<String>,
    /// 笔记 id(`insight` 需要)。
    #[serde(default)]
    pub id: Option<String>,
}

impl ShareTarget {
    /// 变成资源键。`own_space` 是调用者自己的知识库 id(`space_id` 没写时用它)。
    pub fn to_key(&self, own_space: Option<&str>) -> Result<ResourceKey> {
        let sid = self
            .space_id
            .as_deref()
            .or(own_space)
            .ok_or_else(|| KbError::InvalidInput("没有指定知识库".to_owned()))?;
        let need = |value: &Option<String>, what: &str| -> Result<String> {
            value
                .clone()
                .ok_or_else(|| KbError::InvalidInput(format!("缺少{what}")))
        };
        match self.kind.as_str() {
            "space" => ResourceKey::space(sid),
            "collection" => ResourceKey::collection(sid, &need(&self.collection, "集合名")?),
            "dir" => ResourceKey::dir(
                sid,
                &need(&self.collection, "集合名")?,
                &need(&self.path, "路径")?,
            ),
            "file" => ResourceKey::file(
                sid,
                &need(&self.collection, "集合名")?,
                &need(&self.path, "路径")?,
            ),
            "insight" => ResourceKey::insight(
                sid,
                &need(&self.collection, "集合名")?,
                &need(&self.id, "笔记 id")?,
            ),
            other => Err(KbError::InvalidInput(format!("未知的资源类型 {other:?}"))),
        }
    }
}

impl ResourceKey {
    /// 反过来:资源键 → 结构化写法(返回给客户端,让它不必解析键字符串)。
    pub fn to_target(&self) -> ShareTarget {
        let blank = |kind: &str, sid: &str| ShareTarget {
            kind: kind.to_owned(),
            space_id: Some(sid.to_owned()),
            collection: None,
            path: None,
            id: None,
        };
        match self {
            Self::Space { sid } => blank("space", sid),
            Self::Collection { sid, name } => ShareTarget {
                collection: Some(name.clone()),
                ..blank("collection", sid)
            },
            Self::Dir { sid, name, path } => ShareTarget {
                collection: Some(name.clone()),
                path: Some(path.clone()),
                ..blank("dir", sid)
            },
            Self::Doc {
                sid,
                name,
                doc: DocRef::File(path),
            } => ShareTarget {
                collection: Some(name.clone()),
                path: Some(path.clone()),
                ..blank("file", sid)
            },
            Self::Doc {
                sid,
                name,
                doc: DocRef::Insight(id),
            } => ShareTarget {
                collection: Some(name.clone()),
                id: Some(id.clone()),
                ..blank("insight", sid)
            },
        }
    }
}

/// 一条授权。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Grant {
    /// 主键。
    pub id: String,
    /// 资源所在的知识库。
    pub space_id: String,
    /// 资源键(字符串形式,见 [`ResourceKey`])。
    pub resource_key: String,
    /// 被授权的人。
    pub grantee_id: String,
    /// 角色(不会是所有者)。
    pub role: Role,
    /// 来源:`direct` / `link:<id>` / `request:<id>`。
    pub via: String,
    /// 谁授的权。
    pub created_by: String,
    /// 授权时间。
    pub created_at: crate::model::Millis,
    /// 过期时间。
    pub expires_at: Option<crate::model::Millis>,
}

/// 访问申请的状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestState {
    /// 等待处理。
    Pending,
    /// 已通过(授权已经写入)。
    Approved,
    /// 已拒绝。
    Rejected,
}

impl RequestState {
    /// 库里的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }

    /// 解析。
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "pending" => Self::Pending,
            "approved" => Self::Approved,
            "rejected" => Self::Rejected,
            _ => return None,
        })
    }
}

/// 一条访问申请:没有权限的人向所有者 / 可管理的人要权限。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AccessRequest {
    /// 主键。
    pub id: String,
    /// 资源所在知识库。
    pub space_id: String,
    /// 资源键。
    pub resource_key: String,
    /// 申请人。
    pub requester_id: String,
    /// 申请的角色(查看 / 评论 / 编辑)。
    pub role: Role,
    /// 附言。
    pub message: Option<String>,
    /// 状态。
    pub state: RequestState,
    /// 谁处理的。
    pub decided_by: Option<String>,
    /// 申请时间。
    pub created_at: crate::model::Millis,
    /// 处理时间。
    pub decided_at: Option<crate::model::Millis>,
}

/// 算出来的有效角色,以及它从哪一层来的。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Effective {
    /// 有效角色(最高的那个)。
    pub role: Role,
    /// 这个角色来自哪个资源的授权。
    pub source: String,
    /// 是继承来的吗(来源不是资源自己)。
    pub inherited: bool,
}

/// 有效角色的计算（设计规范）,纯函数。
///
/// - `lineage`:资源自己到知识库的继承链(见 [`ResourceKey::lineage`]),自己在前;
/// - `grants`:这个人在链上各资源键的授权(已经去掉过期的);
/// - `breaks`:「不继承上级协作者」的资源键。
///
/// 沿链从自己往上走,每一层取这个人在那一层的授权,**取最高**;走到一个设了「停止继承」的层,
/// 那一层自己的授权仍然算,再往上就不看了。没有任何授权返回 `None`(默认拒绝)。
/// 所有者身份不在这里判断:它来自「是不是知识库的主人」,与授权表无关。
pub fn effective_role(
    lineage: &[ResourceKey],
    grants: &std::collections::HashMap<String, Role>,
    breaks: &std::collections::HashSet<String>,
) -> Option<Effective> {
    let mut best: Option<Effective> = None;
    for (depth, node) in lineage.iter().enumerate() {
        let key = node.to_string();
        if let Some(role) = grants.get(&key)
            && best.as_ref().is_none_or(|current| *role > current.role)
        {
            best = Some(Effective {
                role: *role,
                source: key.clone(),
                inherited: depth > 0,
            });
        }
        if breaks.contains(&key) {
            break;
        }
    }
    best
}

#[cfg(test)]
mod tests;
