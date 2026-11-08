//! 能力注册表（设计规范）。
//!
//! 一个能力 = 名字 + 描述 + 权限 + 可见面 + 是否有副作用 + 参数 schema + 处理函数。
//! MCP / Web / AI 管家三个外壳都从这张表取自己的能力子集,不各自维护清单。

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use kb_core::Result;
use serde_json::Value;

use crate::access::{self, Access};
use crate::invoke::CallCtx;

/// 能力处理函数的返回 future。
pub type BoxFuture = Pin<Box<dyn Future<Output = Result<Value>> + Send>>;

/// 能力处理函数。
pub type Handler = Arc<dyn Fn(CallCtx, Value) -> BoxFuture + Send + Sync>;

/// 权限等级(设计规范:R 只读 / W 写 / G 治理 / A 管理)。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Permission {
    /// 只读。
    Read,
    /// 写(会改数据,但不改配置 / 模型)。
    Write,
    /// 治理(删项目、迁移模型等)。
    Govern,
    /// 管理(改配置、令牌)。
    Admin,
}

impl Permission {
    /// 单字母代号(与能力清单一致)。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "R",
            Self::Write => "W",
            Self::Govern => "G",
            Self::Admin => "A",
        }
    }

    /// 是否有副作用(需要开 batch 的能力)。
    pub fn is_mutating(self) -> bool {
        self != Self::Read
    }
}

/// 可见面(设计规范:M = MCP,W = Web,A = AI 管家)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    /// MCP(`kb mcp`)。
    Mcp,
    /// Web 管理端。
    Web,
    /// AI 管家。
    Agent,
}

impl Surface {
    /// 代号。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mcp => "M",
            Self::Web => "W",
            Self::Agent => "A",
        }
    }
}

/// 一个能力。
#[derive(Clone)]
pub struct Capability {
    /// 名字,必须匹配 `^[a-zA-Z][a-zA-Z0-9_]*$`。
    pub name: &'static str,
    /// 描述(不超过 1000 字符)。
    pub description: &'static str,
    /// 权限。
    pub permission: Permission,
    /// 可见面。
    pub surfaces: &'static [Surface],
    /// 是否有副作用(设计规范:W/G 级调用创建 batch)。
    pub side_effect: bool,
    /// 参数 JSON Schema。
    pub input_schema: Value,
    /// 处理函数。
    pub handler: Handler,
}

impl std::fmt::Debug for Capability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Capability")
            .field("name", &self.name)
            .field("permission", &self.permission)
            .field("surfaces", &self.surfaces)
            .field("side_effect", &self.side_effect)
            .finish_non_exhaustive()
    }
}

impl Capability {
    /// 是否在某个可见面出现。
    pub fn visible_on(&self, surface: Surface) -> bool {
        self.surfaces.contains(&surface)
    }

    /// 给 MCP / Web 的列表用的摘要(不含 handler)。
    pub fn describe(&self) -> Value {
        serde_json::json!({
            "name": self.name,
            "description": self.description,
            "permission": self.permission.as_str(),
            "surfaces": self.surfaces.iter().map(|surface| surface.as_str()).collect::<Vec<_>>(),
            "side_effect": self.side_effect,
            "input_schema": self.input_schema,
        })
    }
}

/// 能力注册表。
#[derive(Default)]
pub struct Registry {
    capabilities: BTreeMap<&'static str, Capability>,
    /// 每个能力的访问分类(范围 + 功能点),注册时从 `access::ACCESS_TABLE` 取。
    access: BTreeMap<&'static str, Access>,
}

impl Registry {
    /// 空表。
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一个能力;重名直接 panic(注册表是编译期常量表,重名属于编码错误)。
    pub fn register(&mut self, capability: Capability) {
        assert!(
            is_valid_name(capability.name),
            "能力名不合法:{}",
            capability.name
        );
        assert!(
            capability.description.chars().count() <= 1000,
            "能力 {} 的描述超过 1000 字符",
            capability.name
        );
        // 没有登记访问分类的能力不允许存在:否则它在多用户下既没有范围也没有功能点把关
        let access = access::lookup(capability.name).unwrap_or_else(|| {
            panic!(
                "能力 {} 没有登记访问分类:请先在 kb-capability/src/access.rs 的 ACCESS_TABLE 里加一行",
                capability.name
            )
        });
        self.access.insert(capability.name, access);
        let previous = self
            .capabilities
            .insert(capability.name, capability.clone());
        assert!(previous.is_none(), "能力 {} 重复注册", capability.name);
    }

    /// 按名字取。
    pub fn get(&self, name: &str) -> Option<&Capability> {
        self.capabilities.get(name)
    }

    /// 某个能力的访问分类。
    pub fn access(&self, name: &str) -> Option<Access> {
        self.access.get(name).copied()
    }

    /// 全部能力(按名字排序,输出稳定)。
    pub fn all(&self) -> Vec<&Capability> {
        self.capabilities.values().collect()
    }

    /// 某个可见面的能力列表。
    pub fn for_surface(&self, surface: Surface) -> Vec<&Capability> {
        self.capabilities
            .values()
            .filter(|capability| capability.visible_on(surface))
            .collect()
    }

    /// 某个可见面的能力摘要(给 `GET /api/v1/capabilities?surface=mcp`)。
    pub fn describe_surface(&self, surface: Surface) -> Vec<Value> {
        self.for_surface(surface)
            .into_iter()
            .map(|capability| {
                let mut described = capability.describe();
                if let (Some(object), Some(access)) =
                    (described.as_object_mut(), self.access(capability.name))
                {
                    object.insert("scope".to_owned(), Value::from(access.scope.as_str()));
                    object.insert("feature".to_owned(), Value::from(access.feature));
                }
                described
            })
            .collect()
    }

    /// 能力数量。
    pub fn len(&self) -> usize {
        self.capabilities.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.capabilities.is_empty()
    }
}

/// 能力名规则:字母开头,只含字母数字下划线。
pub fn is_valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noop() -> Handler {
        Arc::new(|_ctx, _args| Box::pin(async { Ok(serde_json::json!({})) }))
    }

    fn capability(
        name: &'static str,
        permission: Permission,
        surfaces: &'static [Surface],
    ) -> Capability {
        Capability {
            name,
            description: "测试能力",
            permission,
            surfaces,
            side_effect: permission.is_mutating(),
            input_schema: serde_json::json!({"type": "object"}),
            handler: noop(),
        }
    }

    #[test]
    fn names_follow_the_pattern() {
        assert!(is_valid_name("search_knowledge"));
        assert!(is_valid_name("a1"));
        assert!(!is_valid_name("1abc"));
        assert!(!is_valid_name("search-knowledge"));
        assert!(!is_valid_name(""));
    }

    #[test]
    fn registry_filters_by_surface() {
        let mut registry = Registry::new();
        registry.register(capability(
            "search_knowledge",
            Permission::Read,
            &[Surface::Mcp, Surface::Web, Surface::Agent],
        ));
        registry.register(capability(
            "save_insight",
            Permission::Write,
            &[Surface::Web],
        ));
        assert_eq!(registry.for_surface(Surface::Mcp).len(), 1);
        assert_eq!(registry.for_surface(Surface::Web).len(), 2);
        assert_eq!(registry.for_surface(Surface::Agent).len(), 1);
        assert_eq!(registry.len(), 2);
    }

    #[test]
    fn describe_carries_the_schema_and_flags() {
        let mut registry = Registry::new();
        registry.register(capability(
            "save_insight",
            Permission::Write,
            &[Surface::Mcp],
        ));
        let described = registry.describe_surface(Surface::Mcp);
        assert_eq!(described[0]["name"], "save_insight");
        assert_eq!(described[0]["permission"], "W");
        assert_eq!(described[0]["side_effect"], true);
        assert_eq!(described[0]["input_schema"]["type"], "object");
    }

    #[test]
    fn read_permissions_have_no_side_effect() {
        assert!(!Permission::Read.is_mutating());
        assert!(Permission::Write.is_mutating());
        assert!(Permission::Govern.is_mutating());
        assert!(Permission::Admin.is_mutating());
        assert!(Permission::Admin > Permission::Govern);
    }
}
