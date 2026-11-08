//! 增量判定(设计规范的 diff 规则)。
//!
//! - `embed_input_hash` 变化或是新块 → 需要重新嵌入;
//! - 只有 `meta_hash` 变化 → 只更新元数据(不重新嵌入);
//! - 都没变 → 跳过;
//! - 旧记录里有、新结果里没有 → 删除。

use std::collections::{HashMap, HashSet};

use kb_core::model::{ChunkMeta, RecordRow};

/// 单个块的处理方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChunkAction {
    /// 需要重新嵌入。
    Embed,
    /// 只更新元数据。
    UpdateMeta,
    /// 完全没变。
    Skip,
}

/// 一次 diff 的结果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiffPlan {
    /// 与新块一一对应的处理方式。
    pub actions: Vec<ChunkAction>,
    /// 需要从存储里删掉的旧块 id。
    pub delete_ids: Vec<String>,
}

impl DiffPlan {
    /// 需要嵌入的块数。
    pub fn embed_count(&self) -> usize {
        self.actions
            .iter()
            .filter(|action| **action == ChunkAction::Embed)
            .count()
    }

    /// 只更新元数据的块数。
    pub fn update_count(&self) -> usize {
        self.actions
            .iter()
            .filter(|action| **action == ChunkAction::UpdateMeta)
            .count()
    }
}

/// 对比存储里的旧块与新块。
///
/// 旧块、新块都用哈希表按 id 查:新块数被封顶(3000),旧块数不封顶,
/// 以前对每个新块线性扫一遍旧块、对每个旧块再扫一遍已匹配列表,是 O(新块 × 旧块)。
/// 输出与线性版本完全一致(`actions` 与 `rows` 一一对应,`delete_ids` 按 `existing` 的原顺序)。
pub fn diff(existing: &[ChunkMeta], rows: &[RecordRow]) -> DiffPlan {
    diff_with_pending(existing, rows, &HashSet::new())
}

/// 同 [`diff`],但把「元数据里还是 pending 的块」也判成需要嵌入。
///
/// 为什么需要:文本阶段只写正文、不写向量,`chunks` 表仍会记下三哈希。下一次索引看到
/// 哈希没变就会判成 `Skip`,但这个块的向量其实还没补,会永远停在 pending。
/// 调用方把队列里这个文件的 pending id 传进来,强制走 `Embed`,补完向量后队列出队。
pub fn diff_with_pending(
    existing: &[ChunkMeta],
    rows: &[RecordRow],
    pending: &HashSet<String>,
) -> DiffPlan {
    let mut plan = DiffPlan {
        actions: Vec::with_capacity(rows.len()),
        delete_ids: Vec::new(),
    };
    // 旧块里 id 重复时,线性版本的 `find` 取第一个,所以只在 id 第一次出现时登记,保持这个语义
    let mut previous_by_id: HashMap<&str, &ChunkMeta> = HashMap::with_capacity(existing.len());
    for meta in existing {
        previous_by_id.entry(meta.id.as_str()).or_insert(meta);
    }
    let mut matched: HashSet<&str> = HashSet::with_capacity(rows.len());
    for row in rows {
        match previous_by_id.get(row.id.as_str()) {
            Some(previous) => {
                matched.insert(previous.id.as_str());
                // 队列里的块即使哈希没变也要重嵌:上一轮可能只写了正文。
                if pending.contains(previous.id.as_str())
                    || previous.embed_input_hash != row.embed_input_hash
                {
                    plan.actions.push(ChunkAction::Embed);
                } else if previous.meta_hash != row.meta_hash {
                    plan.actions.push(ChunkAction::UpdateMeta);
                } else {
                    plan.actions.push(ChunkAction::Skip);
                }
            }
            None => plan.actions.push(ChunkAction::Embed),
        }
    }
    // 按 `existing` 的原顺序遍历:id 重复且都没匹配上的旧块,每一条都要进删除列表
    for meta in existing {
        if !matched.contains(meta.id.as_str()) {
            plan.delete_ids.push(meta.id.clone());
        }
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::{ItemStatus, RecordKind};

    fn meta(id: &str, content: &str, embed: &str) -> ChunkMeta {
        ChunkMeta {
            id: id.to_owned(),
            collection: "proj_demo".to_owned(),
            path: "src/a.rs".to_owned(),
            ordinal: 0,
            content_hash: content.to_owned(),
            meta_hash: content.to_owned(),
            embed_input_hash: embed.to_owned(),
            updated_at: 0,
        }
    }

    fn row(id: &str, content: &str, embed: &str) -> RecordRow {
        RecordRow {
            id: id.to_owned(),
            collection: "proj_demo".to_owned(),
            kind: RecordKind::Code,
            lang: Some("rust".to_owned()),
            source: "src/a.rs".to_owned(),
            start_line: Some(1),
            end_line: Some(2),
            symbol: None,
            title: None,
            text: "text".to_owned(),
            header: "h".to_owned(),
            lex: "l".to_owned(),
            tags: Vec::new(),
            status: ItemStatus::Active,
            content_hash: content.to_owned(),
            meta_hash: content.to_owned(),
            embed_input_hash: embed.to_owned(),
            updated_at: 0,
            anchor: None,
            vector: None,
        }
    }

    #[test]
    fn pending_chunks_are_embedded_even_when_hashes_match() {
        // 文本阶段已经把哈希写进 chunks 表,但向量还没补:不能再判 Skip
        let mut pending = HashSet::new();
        pending.insert("a".to_owned());
        let plan = diff_with_pending(&[meta("a", "c1", "e1")], &[row("a", "c1", "e1")], &pending);
        assert_eq!(plan.actions, vec![ChunkAction::Embed]);
    }

    #[test]
    fn new_chunks_are_embedded() {
        let plan = diff(&[], &[row("a", "c1", "e1")]);
        assert_eq!(plan.actions, vec![ChunkAction::Embed]);
        assert_eq!(plan.embed_count(), 1);
    }

    #[test]
    fn unchanged_chunks_are_skipped() {
        let plan = diff(&[meta("a", "c1", "e1")], &[row("a", "c1", "e1")]);
        assert_eq!(plan.actions, vec![ChunkAction::Skip]);
        assert!(plan.delete_ids.is_empty());
    }

    #[test]
    fn meta_only_change_updates_without_embedding() {
        let plan = diff(&[meta("a", "c1", "e1")], &[row("a", "c2", "e1")]);
        assert_eq!(plan.actions, vec![ChunkAction::UpdateMeta]);
        assert_eq!(plan.embed_count(), 0);
        assert_eq!(plan.update_count(), 1);
    }

    #[test]
    fn embed_input_change_triggers_embedding() {
        let plan = diff(&[meta("a", "c1", "e1")], &[row("a", "c1", "e2")]);
        assert_eq!(plan.actions, vec![ChunkAction::Embed]);
    }

    #[test]
    fn missing_chunks_are_deleted() {
        let plan = diff(
            &[meta("a", "c1", "e1"), meta("b", "c2", "e2")],
            &[row("a", "c1", "e1")],
        );
        assert_eq!(plan.actions, vec![ChunkAction::Skip]);
        assert_eq!(plan.delete_ids, vec!["b".to_owned()]);
    }

    /// 改造前的实现(线性查找),原样保留,只用来对拍:哈希表版本的输出必须与它逐项相等。
    fn diff_before_refactor(existing: &[ChunkMeta], rows: &[RecordRow]) -> DiffPlan {
        let mut plan = DiffPlan {
            actions: Vec::with_capacity(rows.len()),
            delete_ids: Vec::new(),
        };
        let mut matched: Vec<&str> = Vec::with_capacity(rows.len());
        for row in rows {
            let previous = existing.iter().find(|meta| meta.id == row.id);
            match previous {
                Some(previous) => {
                    matched.push(previous.id.as_str());
                    if previous.embed_input_hash != row.embed_input_hash {
                        plan.actions.push(ChunkAction::Embed);
                    } else if previous.meta_hash != row.meta_hash {
                        plan.actions.push(ChunkAction::UpdateMeta);
                    } else {
                        plan.actions.push(ChunkAction::Skip);
                    }
                }
                None => plan.actions.push(ChunkAction::Embed),
            }
        }
        for meta in existing {
            if !matched.contains(&meta.id.as_str()) {
                plan.delete_ids.push(meta.id.clone());
            }
        }
        plan
    }

    /// 确定性伪随机数(xorshift64),对拍要可复现,也不引入依赖。
    struct XorShift(u64);

    impl XorShift {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }

        /// `0..bound` 里的一个数;`bound` 必须大于 0。
        fn below(&mut self, bound: usize) -> usize {
            (self.next() % bound as u64) as usize
        }
    }

    /// 生成一组 `(existing, rows)`。`mode` 决定形状,覆盖空集合、全命中、全不命中、完全相同和随机混合;
    /// id 池很小时旧块、新块里都会有大量重复 id。
    fn random_case(rng: &mut XorShift, mode: usize) -> (Vec<ChunkMeta>, Vec<RecordRow>) {
        // 哈希取值很少,三种处理方式(嵌入 / 只更新元数据 / 跳过)都会频繁出现
        let hash = |rng: &mut XorShift, prefix: &str| format!("{prefix}{}", rng.below(3));
        let pool = 1 + rng.below(16);
        let existing_len = rng.below(25);
        let existing: Vec<ChunkMeta> = (0..existing_len)
            .map(|_| {
                let id = format!("id{}", rng.below(pool));
                let content = hash(rng, "c");
                let embed = hash(rng, "e");
                meta(&id, &content, &embed)
            })
            .collect();
        let rows_len = rng.below(25);
        let rows: Vec<RecordRow> = match mode {
            // 随机混合:新块 id 与旧块共用同一个小池子,有命中也有没命中,新块里也会重复
            0 | 1 => (0..rows_len)
                .map(|_| {
                    let id = format!("id{}", rng.below(pool + 4));
                    let content = hash(rng, "c");
                    let embed = hash(rng, "e");
                    row(&id, &content, &embed)
                })
                .collect(),
            // 全命中:新块的 id 都取自旧块(旧块为空时退化成空集合)
            2 => (0..rows_len)
                .map(|_| {
                    let id = match existing.len() {
                        0 => "none".to_owned(),
                        len => existing[rng.below(len)].id.clone(),
                    };
                    let content = hash(rng, "c");
                    let embed = hash(rng, "e");
                    row(&id, &content, &embed)
                })
                .collect(),
            // 全不命中:新块 id 与旧块的 id 前缀不同
            3 => (0..rows_len)
                .map(|index| {
                    let content = hash(rng, "c");
                    let embed = hash(rng, "e");
                    row(
                        &format!("new{}", index % (1 + rng.below(8))),
                        &content,
                        &embed,
                    )
                })
                .collect(),
            // 新块与旧块一一相同(重复 id 的旧块只对应第一个的哈希,所以会出现 Skip 以外的结果)
            4 => existing
                .iter()
                .map(|old| row(&old.id, &old.meta_hash, &old.embed_input_hash))
                .collect(),
            // 新块为空:旧块全部进删除列表(重复 id 也各占一条)
            _ => Vec::new(),
        };
        (existing, rows)
    }

    fn assert_same_plan(case: usize, existing: &[ChunkMeta], rows: &[RecordRow]) {
        let expected = diff_before_refactor(existing, rows);
        let actual = diff(existing, rows);
        assert_eq!(
            actual,
            expected,
            "第 {case} 组对拍不一致\nexisting ids = {:?}\nrows ids = {:?}",
            existing
                .iter()
                .map(|meta| meta.id.as_str())
                .collect::<Vec<_>>(),
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        );
    }

    /// 哈希表版本与改造前的线性版本逐组对拍:几千组随机输入,`DiffPlan` 的内容与顺序必须完全一致。
    #[test]
    fn hashed_diff_matches_the_linear_implementation() {
        let mut rng = XorShift(0x9E37_79B9_7F4A_7C15);
        let mut seen_embed = false;
        let mut seen_update = false;
        let mut seen_skip = false;
        let mut seen_duplicate_delete = false;
        for case in 0..6000 {
            let mode = case % 6;
            let (existing, rows) = random_case(&mut rng, mode);
            assert_same_plan(case, &existing, &rows);
            let plan = diff(&existing, &rows);
            seen_embed |= plan.embed_count() > 0;
            seen_update |= plan.update_count() > 0;
            seen_skip |= plan.actions.contains(&ChunkAction::Skip);
            let mut unique = plan.delete_ids.clone();
            unique.sort();
            unique.dedup();
            seen_duplicate_delete |= unique.len() < plan.delete_ids.len();
        }
        // 防止生成器退化:几类结果都真的出现过,否则对拍什么也没证明
        assert!(
            seen_embed && seen_update && seen_skip,
            "三种处理方式都应出现"
        );
        assert!(seen_duplicate_delete, "应出现旧块 id 重复且都被删除的情况");
    }

    /// 明确的边界:旧块 id 重复时 `find` 取第一个;删除列表按旧块原顺序、重复 id 各占一条。
    #[test]
    fn duplicate_existing_ids_keep_the_first_match_semantics() {
        // 第一个 "a" 与新块完全相同,第二个 "a" 不同:取第一个 → Skip(取第二个会得到 Embed)
        let existing = [
            meta("a", "c1", "e1"),
            meta("a", "c9", "e9"),
            meta("b", "c2", "e2"),
        ];
        let rows = [row("a", "c1", "e1")];
        let plan = diff(&existing, &rows);
        assert_eq!(plan.actions, vec![ChunkAction::Skip]);
        // 两个 "a" 都算匹配上了,只删 "b"
        assert_eq!(plan.delete_ids, vec!["b".to_owned()]);
        assert_eq!(plan, diff_before_refactor(&existing, &rows));

        // 新块里没有 "a":两个重复的 "a" 各删一次,顺序与旧块一致
        let rows = [row("b", "c2", "e2")];
        let plan = diff(&existing, &rows);
        assert_eq!(plan.delete_ids, vec!["a".to_owned(), "a".to_owned()]);
        assert_eq!(plan, diff_before_refactor(&existing, &rows));
    }

    /// 规模接近线上的几组(新块 3000、旧块上万):同样要与线性版本一致。
    #[test]
    fn hashed_diff_matches_on_large_inputs() {
        let mut rng = XorShift(0xD1B5_4A32_D192_ED03);
        for case in 0..3 {
            let existing: Vec<ChunkMeta> = (0..6000)
                .map(|index| {
                    // 少量重复 id
                    let id = format!("id{}", index - index / 50);
                    meta(
                        &id,
                        &format!("c{}", rng.below(3)),
                        &format!("e{}", rng.below(3)),
                    )
                })
                .collect();
            let rows: Vec<RecordRow> = (0..3000)
                .map(|_| {
                    let id = format!("id{}", rng.below(7000));
                    row(
                        &id,
                        &format!("c{}", rng.below(3)),
                        &format!("e{}", rng.below(3)),
                    )
                })
                .collect();
            assert_same_plan(case, &existing, &rows);
        }
    }
}
