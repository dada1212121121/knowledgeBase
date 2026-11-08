use super::*;

const SID: &str = "sp_0123456789abcdef";

fn all_roles() -> [Role; 5] {
    [
        Role::Viewer,
        Role::Commenter,
        Role::Editor,
        Role::Manager,
        Role::Owner,
    ]
}

#[test]
fn the_role_action_table_matches_the_plan_exactly() {
    use Action::*;
    // 行 = 动作,列 = [查看, 评论, 编辑, 管理, 所有者](设计规范的表)
    let table: &[(Action, [bool; 5])] = &[
        (View, [true, true, true, true, true]),
        (Download, [true, true, true, true, true]),
        (Comment, [false, true, true, true, true]),
        (Edit, [false, false, true, true, true]),
        (Create, [false, false, true, true, true]),
        (History, [false, false, true, true, true]),
        (Restore, [false, false, false, true, true]),
        (ManageGrants, [false, false, false, true, true]),
        (ManageLinks, [false, false, false, true, true]),
        (Delete, [false, false, false, true, true]),
        (TransferOwner, [false, false, false, false, true]),
    ];
    for (action, expected) in table {
        for (role, want) in all_roles().into_iter().zip(expected) {
            assert_eq!(
                role.allows(*action),
                *want,
                "{} 做 {action:?} 应为 {want}",
                role.label()
            );
        }
    }
}

#[test]
fn roles_are_ordered_and_owner_cannot_be_granted() {
    assert!(Role::Viewer < Role::Commenter && Role::Commenter < Role::Editor);
    assert!(Role::Editor < Role::Manager && Role::Manager < Role::Owner);
    for role in all_roles() {
        assert_eq!(Role::parse(role.as_str()).unwrap(), role);
    }
    assert!(Role::parse("admin").is_err());
    assert!(Role::parse("Viewer").is_err(), "大小写敏感,不留第二种写法");
    assert_eq!(Role::parse_grantable("manager").unwrap(), Role::Manager);
    assert!(
        Role::parse_grantable("owner").is_err(),
        "所有权只能转移,不能授予"
    );
}

fn samples() -> Vec<ResourceKey> {
    vec![
        ResourceKey::space(SID).unwrap(),
        ResourceKey::collection(SID, "_global").unwrap(),
        ResourceKey::collection(SID, "knowledgeBase/insights").unwrap(),
        ResourceKey::collection(SID, "项目 一号").unwrap(),
        ResourceKey::dir(SID, "proj_demo", "docs").unwrap(),
        ResourceKey::dir(SID, "proj_demo", "docs/设计/v 2").unwrap(),
        ResourceKey::insight(SID, "_global", "01a1836b-4f11-748e-9e55-00a194bfd395").unwrap(),
        ResourceKey::file(SID, "proj_demo", "README.md").unwrap(),
        ResourceKey::file(SID, "proj_demo", "docs/a b/100%.md").unwrap(),
        ResourceKey::file(SID, "x/y", "🙂/文件.pdf").unwrap(),
    ]
}

#[test]
fn every_kind_round_trips_through_its_string_form() {
    for key in samples() {
        let text = key.to_string();
        assert!(text.is_ascii(), "键是纯 ASCII:{text}");
        assert!(!text.contains(' '), "{text}");
        assert_eq!(ResourceKey::parse(&text).unwrap(), key, "{text}");
    }
}

#[test]
fn a_collection_name_with_slashes_cannot_pose_as_a_folder_or_another_collection() {
    let slashy = ResourceKey::collection(SID, "a/b").unwrap();
    assert_eq!(slashy.to_string(), format!("col:{SID}/a%2Fb"));
    let folder = ResourceKey::dir(SID, "a", "b").unwrap();
    assert_ne!(slashy.to_string(), folder.to_string());
    assert_ne!(slashy, folder);
    assert!(!folder.is_within(&slashy) && !slashy.is_within(&folder));
    // 集合 "a" 里的文件夹 "b" 的授权,不会落到集合 "a/b" 上
    let plain = ResourceKey::collection(SID, "a").unwrap();
    assert!(folder.is_within(&plain));
    assert!(!slashy.is_within(&plain));
}

#[test]
fn lineage_walks_from_the_resource_up_to_the_space() {
    let file = ResourceKey::file(SID, "proj", "docs/设计/a.md").unwrap();
    let chain: Vec<String> = file.lineage().iter().map(ToString::to_string).collect();
    assert_eq!(
        chain,
        [
            format!("doc:{SID}/proj/f/docs/%E8%AE%BE%E8%AE%A1/a.md"),
            format!("dir:{SID}/proj/docs/%E8%AE%BE%E8%AE%A1"),
            format!("dir:{SID}/proj/docs"),
            format!("col:{SID}/proj"),
            format!("space:{SID}"),
        ]
    );
    let top_file = ResourceKey::file(SID, "proj", "a.md").unwrap();
    assert_eq!(top_file.lineage().len(), 3, "文件 → 集合 → 知识库");
    let note = ResourceKey::insight(SID, "_global", "id1").unwrap();
    assert_eq!(
        note.lineage().len(),
        3,
        "笔记没有文件夹:笔记 → 集合 → 知识库"
    );
    assert_eq!(ResourceKey::space(SID).unwrap().lineage().len(), 1);
    assert_eq!(ResourceKey::space(SID).unwrap().parent(), None);
    assert_eq!(
        ResourceKey::dir(SID, "proj", "docs")
            .unwrap()
            .parent()
            .unwrap(),
        ResourceKey::collection(SID, "proj").unwrap()
    );
    for key in samples() {
        let lineage = key.lineage();
        assert_eq!(lineage.first(), Some(&key));
        assert!(matches!(lineage.last(), Some(ResourceKey::Space { .. })));
        assert!(
            lineage.iter().all(|k| k.space_id() == SID),
            "继承链不会跨知识库"
        );
    }
}

#[test]
fn sibling_prefixes_are_not_ancestors() {
    // "docs" 和 "docs2" 是两个文件夹,按字符串前缀判断会误把 docs2 当成 docs 的子级
    let docs = ResourceKey::dir(SID, "p", "docs").unwrap();
    let docs2_file = ResourceKey::file(SID, "p", "docs2/a.md").unwrap();
    let docs_file = ResourceKey::file(SID, "p", "docs/a.md").unwrap();
    assert!(docs_file.is_within(&docs));
    assert!(!docs2_file.is_within(&docs));
    // 不同知识库、不同集合同名的文件夹互不相干
    let other_space = ResourceKey::dir("sp_other", "p", "docs").unwrap();
    assert!(!docs_file.is_within(&other_space));
    let other_col = ResourceKey::dir(SID, "q", "docs").unwrap();
    assert!(!docs_file.is_within(&other_col));
}

#[test]
fn malformed_and_hostile_keys_are_rejected() {
    let bad = [
        "",
        "space",
        "space:",
        "space:nope",
        "space:sp_",
        "unknown:sp_1/a",
        &format!("col:{SID}"),
        &format!("col:{SID}/"),
        &format!("col:{SID}/a/b"),
        &format!("dir:{SID}/a"),
        &format!("dir:{SID}/a/"),
        &format!("dir:{SID}/a//b"),
        &format!("dir:{SID}/a/../b"),
        &format!("dir:{SID}/a/%2E%2E"),
        &format!("dir:{SID}/a/."),
        &format!("doc:{SID}/a/x/b"),
        &format!("doc:{SID}/a/i"),
        &format!("doc:{SID}/a/i/"),
        &format!("doc:{SID}/a/i/b/c"),
        &format!("doc:{SID}/a/f"),
        &format!("doc:{SID}/a/f/../../etc"),
        &format!("col:{SID}/a b"),
        &format!("col:{SID}/%2f"),
        &format!("col:{SID}/%ZZ"),
        &format!("col:{SID}/%2"),
        &format!("col:{SID}/%00"),
        &format!("col:{SID}/%FF"),
        &format!("col:{SID}/é"),
        &format!("col:{SID}/a\nb"),
        &format!("col:{SID}/a%252Fb%"),
        "space:sp_1/../sp_2",
        "space:sp_1 ",
    ];
    for text in bad {
        assert!(ResourceKey::parse(text).is_err(), "应拒绝:{text:?}");
    }
    let long = format!("col:{SID}/{}", "a".repeat(MAX_KEY_LEN));
    assert!(ResourceKey::parse(&long).is_err());
}

#[test]
fn constructors_reject_what_the_parser_rejects() {
    assert!(ResourceKey::space("nope").is_err());
    assert!(ResourceKey::space("sp_a/b").is_err());
    assert!(ResourceKey::collection(SID, "").is_err());
    assert!(ResourceKey::collection(SID, "..").is_err());
    assert!(ResourceKey::collection(SID, "a\u{0}b").is_err());
    for path in [
        "", "/a", "a/", "a//b", "a/./b", "a/../b", "..", "a\\b", "a/\u{7}b",
    ] {
        assert!(ResourceKey::dir(SID, "p", path).is_err(), "{path:?}");
        assert!(ResourceKey::file(SID, "p", path).is_err(), "{path:?}");
    }
    let deep = vec!["d"; MAX_DEPTH + 1].join("/");
    assert!(ResourceKey::dir(SID, "p", &deep).is_err());
    assert!(ResourceKey::dir(SID, "p", &vec!["d"; MAX_DEPTH].join("/")).is_ok());
    assert!(ResourceKey::insight(SID, "p", "").is_err());
}

/// 确定性的伪随机,免得为模糊测试引入依赖。
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

#[test]
fn random_input_never_parses_into_a_key_that_prints_differently() {
    let alphabet: Vec<char> = "abcAB09_-.~/%:%2F2E5C 中é\n\\".chars().collect();
    let mut rng = Lcg(42);
    let mut accepted = 0;
    for _ in 0..20_000 {
        let len = (rng.next() % 40) as usize;
        let body: String = (0..len)
            .map(|_| alphabet[(rng.next() as usize) % alphabet.len()])
            .collect();
        for prefix in ["space:", "col:", "dir:", "doc:", ""] {
            let text = format!("{prefix}{SID}/{body}");
            if let Ok(key) = ResourceKey::parse(&text) {
                accepted += 1;
                assert_eq!(key.to_string(), text, "规范往返");
                assert_eq!(key.space_id(), SID);
            }
        }
    }
    assert!(
        accepted > 0,
        "模糊输入里应该有一些合法键,否则这个测试什么也没测"
    );
}

#[test]
fn random_valid_resources_survive_a_string_round_trip() {
    let pieces = [
        "a", "中文", "x y", "100%", "a/b", "#1", "é", "🙂", "~", "-", ".hidden", "a.b",
    ];
    let mut rng = Lcg(7);
    for _ in 0..5_000 {
        let pick = |rng: &mut Lcg| pieces[(rng.next() as usize) % pieces.len()];
        let name = pick(&mut rng);
        let depth = 1 + (rng.next() % 4) as usize;
        let segments: Vec<&str> = (0..depth)
            .map(|_| pick(&mut rng))
            .filter(|segment| !segment.contains('/'))
            .collect();
        if segments.is_empty() {
            continue;
        }
        let path = segments.join("/");
        for key in [
            ResourceKey::collection(SID, name).unwrap(),
            ResourceKey::dir(SID, name, &path).unwrap(),
            ResourceKey::file(SID, name, &path).unwrap(),
            ResourceKey::insight(SID, name, pick(&mut rng)).unwrap(),
        ] {
            assert_eq!(ResourceKey::parse(&key.to_string()).unwrap(), key);
        }
    }
}

// ---------------------------------------------------------------- 有效角色

use std::collections::{HashMap, HashSet};

fn grants_of(items: &[(&ResourceKey, Role)]) -> HashMap<String, Role> {
    items
        .iter()
        .map(|(key, role)| (key.to_string(), *role))
        .collect()
}

fn breaks_of(items: &[&ResourceKey]) -> HashSet<String> {
    items.iter().map(|key| key.to_string()).collect()
}

struct Tree {
    space: ResourceKey,
    col: ResourceKey,
    dir: ResourceKey,
    sub: ResourceKey,
    file: ResourceKey,
}

fn tree() -> Tree {
    Tree {
        space: ResourceKey::space(SID).unwrap(),
        col: ResourceKey::collection(SID, "proj").unwrap(),
        dir: ResourceKey::dir(SID, "proj", "docs").unwrap(),
        sub: ResourceKey::dir(SID, "proj", "docs/inner").unwrap(),
        file: ResourceKey::file(SID, "proj", "docs/inner/a.md").unwrap(),
    }
}

#[test]
fn no_grant_anywhere_means_no_access() {
    let t = tree();
    assert_eq!(
        effective_role(&t.file.lineage(), &HashMap::new(), &HashSet::new()),
        None
    );
}

#[test]
fn a_grant_on_a_folder_covers_everything_under_it_but_nothing_beside_it() {
    let t = tree();
    let grants = grants_of(&[(&t.dir, Role::Editor)]);
    let got = effective_role(&t.file.lineage(), &grants, &HashSet::new()).unwrap();
    assert_eq!(
        (got.role, got.inherited, got.source),
        (Role::Editor, true, t.dir.to_string())
    );
    // 同一集合里的另一个文件夹、集合本身、知识库本身都不受影响
    let beside = ResourceKey::file(SID, "proj", "other/b.md").unwrap();
    assert_eq!(
        effective_role(&beside.lineage(), &grants, &HashSet::new()),
        None
    );
    assert_eq!(
        effective_role(&t.col.lineage(), &grants, &HashSet::new()),
        None
    );
    assert_eq!(
        effective_role(&t.space.lineage(), &grants, &HashSet::new()),
        None
    );
    // 授权给文件夹的人,对文件夹自己也有这个角色(不是继承)
    let own = effective_role(&t.dir.lineage(), &grants, &HashSet::new()).unwrap();
    assert!(!own.inherited);
}

#[test]
fn sharing_only_a_file_does_not_expose_its_siblings_or_its_folder() {
    let t = tree();
    let grants = grants_of(&[(&t.file, Role::Viewer)]);
    assert!(effective_role(&t.file.lineage(), &grants, &HashSet::new()).is_some());
    let sibling = ResourceKey::file(SID, "proj", "docs/inner/b.md").unwrap();
    assert_eq!(
        effective_role(&sibling.lineage(), &grants, &HashSet::new()),
        None,
        "只分享文件:以后新增的同级文件不会自动可见"
    );
    assert_eq!(
        effective_role(&t.sub.lineage(), &grants, &HashSet::new()),
        None
    );
}

#[test]
fn the_highest_role_along_the_chain_wins_and_children_can_only_add() {
    let t = tree();
    let grants = grants_of(&[(&t.col, Role::Editor), (&t.file, Role::Viewer)]);
    let got = effective_role(&t.file.lineage(), &grants, &HashSet::new()).unwrap();
    assert_eq!(
        got.role,
        Role::Editor,
        "子级授予更低的角色,不能把父级给的降下来"
    );
    assert_eq!(got.source, t.col.to_string());
    let grants = grants_of(&[(&t.col, Role::Viewer), (&t.file, Role::Manager)]);
    let got = effective_role(&t.file.lineage(), &grants, &HashSet::new()).unwrap();
    assert_eq!(
        (got.role, got.inherited),
        (Role::Manager, false),
        "子级可以加权限"
    );
}

#[test]
fn stopping_inheritance_keeps_the_nodes_own_grants_but_ignores_everything_above() {
    let t = tree();
    let grants = grants_of(&[
        (&t.space, Role::Manager),
        (&t.col, Role::Editor),
        (&t.sub, Role::Viewer),
    ]);
    // 在 docs/inner 上停止继承:只认 sub 自己的授权(可查看),上面的编辑 / 管理都不再生效
    let got = effective_role(&t.file.lineage(), &grants, &breaks_of(&[&t.sub])).unwrap();
    assert_eq!((got.role, got.source), (Role::Viewer, t.sub.to_string()));
    // 断点上面一层(docs)的文件不受影响
    let above = ResourceKey::file(SID, "proj", "docs/a.md").unwrap();
    assert_eq!(
        effective_role(&above.lineage(), &grants, &breaks_of(&[&t.sub]))
            .unwrap()
            .role,
        Role::Manager
    );
    // 断点那一层自己没有授权:那个人在这里就没有权限
    let only_above = grants_of(&[(&t.col, Role::Editor)]);
    assert_eq!(
        effective_role(&t.file.lineage(), &only_above, &breaks_of(&[&t.sub])),
        None
    );
    // 文件自己停止继承:只认文件自己的授权
    let file_grant = grants_of(&[(&t.col, Role::Manager), (&t.file, Role::Commenter)]);
    assert_eq!(
        effective_role(&t.file.lineage(), &file_grant, &breaks_of(&[&t.file]))
            .unwrap()
            .role,
        Role::Commenter
    );
    // 多个断点:最靠近资源的那个先截断
    let got = effective_role(&t.file.lineage(), &grants, &breaks_of(&[&t.sub, &t.col])).unwrap();
    assert_eq!(got.role, Role::Viewer);
}

#[test]
fn grants_on_other_spaces_or_collections_never_apply() {
    let t = tree();
    let other_space = ResourceKey::dir("sp_other", "proj", "docs").unwrap();
    let other_col = ResourceKey::dir(SID, "elsewhere", "docs").unwrap();
    let grants = grants_of(&[(&other_space, Role::Manager), (&other_col, Role::Manager)]);
    assert_eq!(
        effective_role(&t.file.lineage(), &grants, &HashSet::new()),
        None
    );
}

// ---------------------------------------------------------------- 结构化的资源指向

fn target(kind: &str) -> ShareTarget {
    ShareTarget {
        kind: kind.to_owned(),
        space_id: None,
        collection: None,
        path: None,
        id: None,
    }
}

#[test]
fn a_target_becomes_a_key_in_the_callers_own_space_unless_it_names_another() {
    let own = Some(SID);
    let mut file = target("file");
    file.collection = Some("proj".into());
    file.path = Some("docs/a.md".into());
    assert_eq!(
        file.to_key(own).unwrap(),
        ResourceKey::file(SID, "proj", "docs/a.md").unwrap()
    );
    // 明确写了别的知识库就用它(分享面板打开的是别人分享给我的东西时)
    file.space_id = Some("sp_other".into());
    assert_eq!(file.to_key(own).unwrap().space_id(), "sp_other");
    // 没写知识库、调用者也没有 → 错误,而不是悄悄落到某个默认库
    file.space_id = None;
    assert!(file.to_key(None).is_err());
}

#[test]
fn every_kind_survives_target_to_key_and_back() {
    for key in samples() {
        let back = key.to_target().to_key(None).unwrap();
        assert_eq!(back, key);
    }
}

#[test]
fn targets_with_missing_or_hostile_fields_are_rejected() {
    assert!(target("bogus").to_key(Some(SID)).is_err());
    assert!(target("collection").to_key(Some(SID)).is_err(), "缺集合名");
    let mut dir = target("dir");
    dir.collection = Some("p".into());
    assert!(dir.to_key(Some(SID)).is_err(), "缺路径");
    dir.path = Some("a/../../etc".into());
    assert!(dir.to_key(Some(SID)).is_err(), "路径穿越");
    let mut note = target("insight");
    note.collection = Some("p".into());
    assert!(note.to_key(Some(SID)).is_err(), "缺笔记 id");
    let mut space = target("space");
    space.space_id = Some("sp_a/../sp_b".into());
    assert!(space.to_key(Some(SID)).is_err(), "知识库 id 里藏路径");
    // JSON 里多余 / 缺失的字段:缺失的按 None,类型不对直接反序列化失败
    let parsed: ShareTarget = serde_json::from_str(r#"{"kind":"space"}"#).unwrap();
    assert!(parsed.to_key(Some(SID)).is_ok());
    assert!(serde_json::from_str::<ShareTarget>(r#"{"kind":5}"#).is_err());
}
