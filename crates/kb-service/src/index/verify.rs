//! 向量库 ⇄ 元数据一致性:只读校验([`IndexService::verify_chunks`])与失效([`IndexService::invalidate_files`])。
//!
//! 为什么需要:SQLite 的 `chunks` 表与向量库是两份各自提交的数据,写入顺序是「向量库删旧块 → 嵌入 →
//! upsert → 元数据补丁 → 最后才写 `chunks` 与 `files`」。进程在中间被停(重启、取消、嵌入失败)就会留下
//! 半截状态,而增量索引只看 `files` 行里的文件哈希:哈希没变且 `chunks` 有记录就直接 skip,
//! 「元数据有、向量库没有」的块永远补不上(线上 `sampleproj` 的 `AGENTS.md` 就这样整个搜不到)。
//! `reconcile_orphans` 只处理反方向(向量库比元数据多),这里补上检测和让增量任务重建的入口。

use std::collections::{BTreeMap, BTreeSet, HashMap};

use kb_core::model::{ChunkMeta, Collection, ItemStatus, RecordKind};
use kb_core::ports::repo::{ChunkRepo, FileRepo};
use kb_core::{Filter, KbError, Result};

use super::IndexService;

/// 元数据一侧翻页取块的页大小(与孤儿对账一致)。
const META_PAGE: u32 = 5000;

/// 一个文件上的差异块数。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FileDivergence {
    /// 元数据里有、向量库里没有的块数。
    pub missing: usize,
    /// 两边都有,但内容哈希(`content_hash` 或 `embed_input_hash`)对不上的块数。
    pub stale: usize,
}

impl FileDivergence {
    /// 这个文件上有差异的块数。
    pub fn blocks(&self) -> usize {
        self.missing + self.stale
    }
}

/// 一次一致性校验的结果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConsistencyReport {
    /// 向量库里 `code` / `doc` 两种行的总数。
    pub store_rows: usize,
    /// 元数据 `chunks` 表里该 collection 的块数。
    pub meta_rows: usize,
    /// 元数据有、向量库没有的块数(整个文件搜不到的主因)。
    pub missing_in_store: usize,
    /// 哈希不一致的块数(向量库里是旧内容,或元数据里是旧内容)。
    pub stale_in_store: usize,
    /// 向量库有、元数据没有的块数。**只报告,不处理**:孤儿由 `reconcile_orphans` 负责。
    pub orphans_in_store: usize,
    /// 有差异(缺失或过期)的文件,按相对路径归并。
    pub files: BTreeMap<String, FileDivergence>,
    /// 存储不支持块指纹,过期块没有检查(缺失与孤儿仍然是准的)。
    pub stale_unchecked: bool,
}

impl ConsistencyReport {
    /// 缺失与过期的块数合计(自动修复的护栏用它和阈值比)。
    pub fn diverging_chunks(&self) -> usize {
        self.missing_in_store + self.stale_in_store
    }

    /// 元数据与向量库是否完全对得上(孤儿也算不一致)。
    pub fn is_clean(&self) -> bool {
        self.files.is_empty() && self.orphans_in_store == 0
    }
}

/// 向量库一侧一个块的哈希;存储不支持指纹时为 `None`。
struct StoreHashes {
    content: String,
    embed_input: String,
}

/// 只看 `code` / `doc` 两种行(洞察、批注、摘要不经过 `chunks` 表),不限状态。
///
/// 条件由结构化的 [`Filter`] 生成,不手写 SQL;结果是 `kind IN ('code', 'doc')`,
/// 与孤儿对账用的条件等价。
fn chunk_rows_filter() -> Result<Option<String>> {
    Filter {
        kinds: vec![RecordKind::Code, RecordKind::Doc],
        statuses: ItemStatus::ALL.to_vec(),
        ..Filter::default()
    }
    .to_sql()
}

impl IndexService {
    /// 校验一个 collection 的元数据与向量库是否一致(只读,不改任何东西)。
    ///
    /// 对账方式:向量库一侧取全部 `code` / `doc` 块的 id 与哈希,元数据一侧按 id 翻页,逐块比:
    /// - 元数据有、向量库没有 → `missing`;
    /// - 两边都有但 `content_hash` / `embed_input_hash` 不同 → `stale`;
    /// - 向量库剩下的 → `orphans`(只报告)。
    ///
    /// 要拿**独占**写闸门才开始:有索引分片在写时,「向量库已写、元数据还没写」是正常的中间状态,
    /// 会被误判成差异。拿不到(有分片在写)返回 `Ok(None)`,调用方下一轮再试。
    /// 存储不支持块指纹(`list_fingerprints` 返回错误)时跳过过期块检测,不算失败。
    pub async fn verify_chunks(
        &self,
        collection: &Collection,
    ) -> Result<Option<ConsistencyReport>> {
        let Some(_exclusive) = self.gate.try_exclusive() else {
            return Ok(None);
        };
        // 先锁后读:持锁期间迁移也进不来,active 表不会变
        let current = self.fresh_collection(&collection.name).await?;
        let table = current.active_table.as_str();
        let filter = chunk_rows_filter()?;
        let mut report = ConsistencyReport::default();

        // 向量库一侧:id → 哈希
        let mut in_store: HashMap<String, Option<StoreHashes>> = HashMap::new();
        match self.store.list_fingerprints(table, filter.as_deref()).await {
            Ok(fingerprints) => {
                report.store_rows = fingerprints.len();
                in_store.reserve(fingerprints.len());
                for fingerprint in fingerprints {
                    in_store.insert(
                        fingerprint.id,
                        Some(StoreHashes {
                            content: fingerprint.content_hash,
                            embed_input: fingerprint.embed_input_hash,
                        }),
                    );
                }
            }
            Err(err) => {
                // 默认实现(测试替身等)会报「不支持」:退回只取 id 的瘦列表,缺失与孤儿照样能查
                tracing::debug!(
                    collection = %current.name,
                    error = %err,
                    "向量库不提供块指纹,跳过过期块检测"
                );
                report.stale_unchecked = true;
                let slices = self.store.list_slices(table, filter.as_deref()).await?;
                report.store_rows = slices.len();
                in_store.reserve(slices.len());
                for slice in slices {
                    in_store.insert(slice.id, None);
                }
            }
        }

        // 元数据一侧:翻页比对,比到的就从 `in_store` 里拿掉,最后剩下的就是孤儿
        let mut after: Option<String> = None;
        loop {
            let page = ChunkRepo::ids_after(
                self.meta.as_ref(),
                &current.name,
                after.as_deref(),
                META_PAGE,
            )
            .await?;
            let Some(last) = page.last() else { break };
            after = Some(last.id.clone());
            for chunk in page {
                report.meta_rows += 1;
                match in_store.remove(&chunk.id) {
                    None => {
                        report.missing_in_store += 1;
                        report.files.entry(chunk.path).or_default().missing += 1;
                    }
                    Some(Some(hashes)) if differs(&hashes, &chunk) => {
                        report.stale_in_store += 1;
                        report.files.entry(chunk.path).or_default().stale += 1;
                    }
                    Some(_) => {}
                }
            }
        }
        report.orphans_in_store = in_store.len();
        Ok(Some(report))
    }

    /// 让一批文件下一次增量索引时**从零重建**:清向量库里的旧块、元数据里的块和 `files` 行。
    ///
    /// `files` 行没了、`chunks` 也空了,增量索引就不会走「文件哈希没变,跳过」的快路径,
    /// 而是把它当新文件重新分块、嵌入、写入。调用方在这之后自己排增量任务。
    ///
    /// - 向量库一侧要删的 id = 「向量库里 `source` 等于该路径的 `code` / `doc` 行」∪「元数据里该路径的块」。
    ///   只按 id 删,路径不会拼进任何 SQL;`paths` 以外的文件(包括前缀相同的 `a.rs.bak`)不会被碰;
    /// - 先清向量库、再清元数据、最后删 `files` 行(与 `remove_source` 的次序相同):中途失败留下的
    ///   半截状态,下一次校验或对账会再发现;
    /// - 要独占闸门;拿不到(有索引分片在写)返回 [`KbError::Unavailable`],什么都没动。
    ///
    /// 返回处理的文件数(重复路径只算一次)。
    pub async fn invalidate_files(
        &self,
        collection: &Collection,
        paths: &[String],
    ) -> Result<usize> {
        let wanted: BTreeSet<&str> = paths.iter().map(String::as_str).collect();
        if wanted.is_empty() {
            return Ok(0);
        }
        let Some(_exclusive) = self.gate.try_exclusive() else {
            return Err(KbError::Unavailable(
                "有索引分片在写入,拿不到独占写闸门,稍后重试".to_owned(),
            ));
        };
        let current = self.fresh_collection(&collection.name).await?;
        let table = current.active_table.as_str();

        // 一次扫描取出向量库里属于这些路径的块 id,比逐个路径各扫一遍省得多
        let mut store_ids: HashMap<String, Vec<String>> = HashMap::new();
        let filter = chunk_rows_filter()?;
        for slice in self.store.list_slices(table, filter.as_deref()).await? {
            if wanted.contains(slice.source.as_str()) {
                store_ids.entry(slice.source).or_default().push(slice.id);
            }
        }

        let mut done = 0usize;
        for path in wanted {
            let mut ids: BTreeSet<String> = store_ids
                .remove(path)
                .unwrap_or_default()
                .into_iter()
                .collect();
            for chunk in ChunkRepo::by_path(self.meta.as_ref(), &current.name, path).await? {
                ids.insert(chunk.id);
            }
            if !ids.is_empty() {
                let ids: Vec<String> = ids.into_iter().collect();
                self.store.delete_ids(table, &ids).await?;
            }
            ChunkRepo::replace_for_path(self.meta.as_ref(), &current.name, path, Vec::new())
                .await?;
            FileRepo::delete(self.meta.as_ref(), &current.name, path).await?;
            done += 1;
        }
        tracing::info!(
            collection = %current.name,
            files = done,
            "已清掉文件的向量库块与元数据,等待增量任务重建"
        );
        Ok(done)
    }
}

/// 两边的内容哈希是否对不上。
fn differs(store: &StoreHashes, meta: &ChunkMeta) -> bool {
    store.content != meta.content_hash || store.embed_input != meta.embed_input_hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_filter_matches_the_orphan_reconcile_condition() {
        // 与 `reconcile_orphans` 里手写的条件逐字相同,两处看的是同一批行
        assert_eq!(
            chunk_rows_filter().unwrap().as_deref(),
            Some("kind IN ('code', 'doc')")
        );
    }

    #[test]
    fn report_helpers() {
        let mut report = ConsistencyReport::default();
        assert!(report.is_clean());
        assert_eq!(report.diverging_chunks(), 0);
        report.missing_in_store = 2;
        report.stale_in_store = 1;
        assert_eq!(report.diverging_chunks(), 3);
        let divergence = FileDivergence {
            missing: 2,
            stale: 1,
        };
        assert_eq!(divergence.blocks(), 3);
        report.files.insert("a.rs".to_owned(), divergence);
        assert!(!report.is_clean());
    }
}
