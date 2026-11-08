//! 端口层:服务只依赖这里的 trait,具体实现放在适配器 crate(设计规范)。
//!
//! trait 签名以设计规范为准,后续实现只按它来,不得自行修改。

pub mod repo;
pub mod system;

pub use system::{
    AccessLinkRepo, AccountRepo, AdminKeyRepo, IdentityStore, NotifyRepo, RoleRepo, SignupRepo,
};

use async_trait::async_trait;

use crate::error::Result;
use crate::model::{
    ChatRequest, ChatResponse, Chunk, EmbedderState, MetaPatch, RecordRow, SourceDoc, StoreHit,
    StoreQuery,
};

/// 嵌入后端。
///
/// 实现约束:fastembed 的 `embed(&mut self, ..)` 是同步阻塞调用,**必须**放在专用工作线程里,
/// 通过 channel 收发(设计规范坑 7)。
#[async_trait]
pub trait Embedder: Send + Sync {
    /// 例如 `fastembed:bge-m3-int8`,写入 `collections.embedder_id`。
    fn id(&self) -> &str;
    /// 向量维度。
    fn dim(&self) -> usize;
    /// 兼容组,例如 `bge-m3`;同组切换可以免迁移。
    fn compat_group(&self) -> &str;
    /// 批量嵌入文档(低优先级通道)。
    async fn embed_documents(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>>;
    /// 嵌入查询(高优先级通道)。
    async fn embed_query(&self, text: String) -> Result<Vec<f32>>;
    /// 当前状态。
    fn state(&self) -> EmbedderState;
}

/// 文档抽取器:把一种格式抽成统一中间文档 [`crate::model::Doc`]。
///
/// 实现放在 `kb-extract`(重依赖都在那里),`kb-core` 只定接口。
#[async_trait]
pub trait Extractor: Send + Sync {
    /// 例如 `text/markdown` / `pdf`。
    fn id(&self) -> &str;
    /// 能不能处理这份输入:魔数优先、扩展名兜底。
    fn detect(&self, head: &[u8], ext: &str) -> crate::model::Confidence;
    /// 抽取成中间文档。
    async fn extract(
        &self,
        source: &crate::model::SourceRef,
        bytes: &[u8],
    ) -> Result<crate::model::Doc>;
}

/// 中间文档分块器:标题层级、表格按行(表头随块)、幻灯片按页、媒体按时间窗。
pub trait DocChunker: Send + Sync {
    /// 把中间文档切成检索块(每块带 anchor)。
    fn chunk_doc(&self, doc: &crate::model::Doc) -> Vec<crate::model::Chunk>;
}

/// 重排器。
#[async_trait]
pub trait Reranker: Send + Sync {
    /// 返回与 `docs` 顺序对应的分数。
    async fn rerank(&self, query: &str, docs: &[String]) -> Result<Vec<f32>>;
    /// 是否可用(不可用时检索直接跳过重排)。
    fn available(&self) -> bool;
}

/// 向量 + 全文存储。
///
/// 传给 `only_if` / `delete` 的条件**只能**来自 [`crate::filter::Filter::to_sql`],或由校验过的 id 列表生成。
#[async_trait]
pub trait VectorStore: Send + Sync {
    /// 确保物理表存在(维度不符时报错)。
    async fn ensure_table(&self, table: &str, dim: usize) -> Result<()>;
    /// 按 id upsert。
    async fn upsert(&self, table: &str, rows: Vec<RecordRow>) -> Result<()>;
    /// 只更新元数据列,不重新嵌入。
    async fn update_meta(&self, table: &str, id: &str, patch: MetaPatch) -> Result<()>;
    /// 批量更新元数据,尽量一次提交(默认实现退化成逐行,行为等价但会写碎)。
    ///
    /// 为什么要有这一条:编辑文件后行号整体位移,一个文件的几十个块都要改元数据;
    /// 逐行提交就是几十个版本、几十个 1 行碎片(线上 32 k 行的表因此散成 588 个碎片)。
    async fn update_meta_batch(
        &self,
        table: &str,
        updates: Vec<(String, MetaPatch)>,
    ) -> Result<()> {
        for (id, patch) in updates {
            self.update_meta(table, &id, patch).await?;
        }
        Ok(())
    }
    /// 按 id 删除(每次最多 500 个)。
    async fn delete_ids(&self, table: &str, ids: &[String]) -> Result<()>;
    /// 按 id 取记录(默认不带向量)。
    async fn get(&self, table: &str, ids: &[String]) -> Result<Vec<RecordRow>>;
    /// 纯向量 / 纯全文 / 混合检索。
    async fn search(&self, table: &str, req: &StoreQuery) -> Result<Vec<StoreHit>>;
    /// 只检索尚未嵌入的块(文本阶段写进 LanceDB、向量还空着的行)。
    ///
    /// 默认实现返回空:内存 / 测试替身没有文本优先索引,向量与文本永远同时写。
    async fn search_pending(&self, table: &str, req: &StoreQuery) -> Result<Vec<StoreHit>> {
        let _ = (table, req);
        Ok(Vec::new())
    }
    /// 按队列给的 id 精确取等待补向量的块(含正文,不含向量)。
    ///
    /// 不能改成「先取一页 pending 再过滤」:LanceDB 里还可能有别的孤儿 pending 行,
    /// 排在队列后面的 id 会被挤出这一页,永远补不上。默认实现返回空,理由同
    /// [`VectorStore::search_pending`]。
    async fn get_pending(
        &self,
        table: &str,
        ids: &[String],
    ) -> Result<Vec<crate::model::RecordRow>> {
        let _ = (table, ids);
        Ok(Vec::new())
    }
    /// 按列排序分页列出记录(`list_items`;不算分)。
    async fn list(&self, table: &str, query: &crate::model::ListQuery) -> Result<Vec<RecordRow>>;
    /// 取满足过滤条件的全部块的“瘦行”(没有正文和向量),给文件级列表归并用。
    ///
    /// 默认实现翻页走 [`VectorStore::list`](按 `source` 排序,翻页时同一文件的块顺序不保证,
    /// 归并不依赖顺序);存储可以覆盖成只读需要的几列,避免把十几万块的正文读出来再丢掉。
    async fn list_slices(
        &self,
        table: &str,
        filter: Option<&str>,
    ) -> Result<Vec<crate::model::FileSlice>> {
        const PAGE: usize = 2000;
        let mut out = Vec::new();
        let mut offset = 0usize;
        loop {
            let query = crate::model::ListQuery::new(PAGE, offset)
                .with_filter(filter.map(str::to_owned))
                .with_order(Some("source"), true)?;
            let rows = self.list(table, &query).await?;
            let got = rows.len();
            out.extend(rows.iter().map(crate::model::FileSlice::from));
            if got < PAGE {
                return Ok(out);
            }
            offset += got;
        }
    }
    /// 取满足过滤条件的全部块的指纹(id、来源、两个内容哈希、更新时间),不读正文和向量。
    ///
    /// 给「SQLite `chunks` 表 ⇄ 向量库」的一致性校验用:要发现「元数据有、向量库没有」和
    /// 「哈希对不上」,只能把两边的 id 与哈希逐块比。
    ///
    /// 默认实现直接报错:内存 / 测试替身没有哈希列的概念,也不应该为此改动现有的每一个替身;
    /// 校验方遇到这个错误会跳过过期块检测,只做缺失与孤儿检查。
    async fn list_fingerprints(
        &self,
        table: &str,
        filter: Option<&str>,
    ) -> Result<Vec<crate::model::ChunkFingerprint>> {
        let _ = (table, filter);
        Err(crate::error::KbError::Internal(
            "该存储不支持指纹列表".to_owned(),
        ))
    }
    /// 满足过滤条件的全部文件(同一 `source` 的块归并成一条),按 `source` 升序。
    ///
    /// 默认实现每次都扫一遍;存储可以覆盖成带缓存的版本(写入后缓存自动失效)。
    async fn list_files(
        &self,
        table: &str,
        filter: Option<&str>,
    ) -> Result<std::sync::Arc<Vec<crate::model::FileEntry>>> {
        let slices = self.list_slices(table, filter).await?;
        Ok(std::sync::Arc::new(crate::model::group_by_file(slices)))
    }
    /// 计数。
    async fn count(&self, table: &str, filter: Option<&str>) -> Result<u64>;
    /// 整理表。
    async fn optimize(&self, table: &str) -> Result<()>;
    /// 建全文检索索引(jieba 分词,建在 `lex` 列)。
    async fn ensure_fts_index(&self, table: &str) -> Result<()>;
    /// 必要时建向量索引(行数达到阈值后)。
    async fn ensure_vector_index(&self, table: &str) -> Result<()>;
    /// 删除物理表。
    async fn drop_table(&self, table: &str) -> Result<()>;
    /// 只读的物理状况:碎片数、版本数、索引覆盖(诊断用,不建表、不加锁)。
    ///
    /// 默认返回空:内存 / 测试实现没有这些概念,能力层会把「没有数据」如实显示成空列表。
    async fn table_stats(&self) -> Result<Vec<crate::model::TableStats>> {
        Ok(Vec::new())
    }
}

/// 分块器。
///
/// 原 `KeywordIndex` trait 已并入 [`VectorStore::search`](mode = `Fts`),MVP 不单独实现。
pub trait Chunker: Send + Sync {
    /// 是否支持该语言。
    fn supports(&self, lang: &str) -> bool;
    /// 把文档切成块。
    fn chunk(&self, doc: &SourceDoc) -> Vec<Chunk>;
}

/// 文件扫描(端口):实现放在 `kb-index`(`FsScanner`)。
///
/// 抽成端口是为了让 `kb-service` 只依赖 `kb-core`(设计规范，见下文)。
///
/// 注:这里曾经还有一个 `Loader` 端口(`scheme` + `load(&SourceRef)`),零实现、零调用已删:
/// 文件由 `Scanner` 扫描、内容由 `kb-extract` 的 `Extractor` 抽取,没有任何一条路径需要它。
/// 真要支持 http/pdf 之类的新来源,在 `Scanner` / `Extractor` 上扩,不要再复活这个空壳。
pub trait Scanner: Send + Sync {
    /// 遍历一个项目目录。
    fn scan(&self, request: &crate::model::ScanRequest) -> Result<crate::model::ScanOutcome>;
}

/// 云端对话模型(AI)。
#[async_trait]
pub trait ChatModel: Send + Sync {
    /// 模型标识。
    fn id(&self) -> &str;
    /// 一次对话(支持 tools 与 json_object 输出)。
    async fn chat(&self, req: ChatRequest) -> Result<ChatResponse>;

    /// 流式对话:默认实现是“整段返回后一次回调”,支持 SSE 的客户端会覆盖它。
    ///
    /// 回调里的 `bool` 表示是否已经是最后一段(便于 UI 收尾)。
    async fn chat_stream(
        &self,
        req: ChatRequest,
        on_delta: &mut (dyn for<'a> FnMut(&'a str, bool) + Send),
    ) -> Result<ChatResponse> {
        let response = self.chat(req).await?;
        if let Some(content) = response.message.content.clone()
            && !content.is_empty()
        {
            on_delta(&content, true);
        }
        Ok(response)
    }
}

/// 按用户记账的 LLM 用量账本(多用户设计说明)。
///
/// 外发闸门 [`ChatModel`] 之前先问「这个人今天还有额度吗」,调完记一笔。账本放在全站的 `system.db`,
/// 而不是各个知识库自己的 `meta.db`:管理员要看「谁用得最多」,不能为了排行去打开上千个知识库。
/// 记账的人是**付费的人**——自己触发的 AI 调用记自己;后台任务(提炼、审核)记知识库的主人。
#[async_trait]
pub trait UserLlmLedger: Send + Sync {
    /// 这个用户每天最多可用的 token(输入 + 输出);0 表示不限。
    /// 每次调用时现取:管理员改了额度,下一次调用就按新的来。
    async fn daily_limit(&self, user_id: &str) -> Result<u64>;
    /// 这个用户在 `day`(`YYYY-MM-DD`,UTC)已经用了多少 token。
    async fn used_on(&self, user_id: &str, day: &str) -> Result<u64>;
    /// 记一次调用的用量。
    async fn record(
        &self,
        user_id: &str,
        day: &str,
        purpose: &str,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<()>;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[test]
    fn port_traits_are_object_safe() {
        // 服务层只拿 `Arc<dyn ...>`,这里在编译期钉住对象安全性
        let _: Option<Arc<dyn Embedder>> = None;
        let _: Option<Arc<dyn Reranker>> = None;
        let _: Option<Arc<dyn VectorStore>> = None;
        let _: Option<Arc<dyn Chunker>> = None;
        let _: Option<Arc<dyn ChatModel>> = None;
        let _: Option<Arc<dyn Scanner>> = None;
        let _: Option<Arc<dyn repo::MetaStore>> = None;
    }
}
