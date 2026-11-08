# 自进化本地知识库 — 架构设计文档 (ARCHITECTURE.md)

> 状态: **草案 v0.1，待评估**
> 目标读者: 架构评审人 / 多重评估
> 本文档只定义架构，不含最终实现代码。评审通过后再进入实现阶段。

---

## 0. 章节总览(评审导航)

一句话定位: **一个本机、自进化、插拔式的 AI 开发知识库**——Rust 守护进程 + LanceDB/FastEmbed/Tantivy 混合检索,经 MCP 对接各 AI 工具,带可鉴权的 Vue3 Web 管理端与会话式 AI 管家。

| 章 | 标题 | 一句话摘要 |
|---|---|---|
| 1 | 设计目标与约束 | 功能目标 + 三条硬约束(好维护 / 插拔式 / Web 管理界面)+ 本机隐私约束 |
| 2 | 架构总览 | 四层架构: 接入层 → 服务层 → trait 端口 ← 适配器,依赖倒置是可维护的根基 |
| 3 | 插拔式组件设计 | 7+ 个 trait(Embedder/VectorStore/KeywordIndex/Chunker/Loader/Reranker/EvolutionTrigger)+ 注册表 |
| 4 | 核心数据流 | 索引(双哈希判定)/ 检索(hybrid)/ 自进化 三条流程 |
| 5 | 接口设计 | MCP 工具(给 AI 工具)+ REST/WS(给 Web)——后统一为 设计说明 能力层派生 |
| 6 | 隔离与存储模型 | `~/.kb/` 下 LanceDB+Tantivy;`_global` 通用库 + 每项目独立 collection |
| 7 | Web 管理界面设计 | Vue3 SPA,7 个页面: Dashboard/Collections/结构化编辑/Playground/Config/日志/登录 |
| 8 | 技术选型与理由 | 选型总表(默认 + 可替换 + 理由),含 BGE-M3 / axum / session 鉴权 |
| 9 | 目录结构 | `crates/{kb-core,kb-ipc,kb-adapters,kb-daemon,kb-web,kb-mcp,kb-cli}`;core 不依赖适配器 |
| 10 | 风险与评估点 | 7 项风险,多数已随决策收敛 |
| 11 | 待你决策的清单 | 全部已打勾收敛(模型/进程/鉴权/重嵌入/网络/前端) |
| 12 | 进程模型 | 独立守护进程 kb-daemon + 瘦 MCP 客户端,经本地 IPC 连接 |
| 13 | 图示 | 组件依赖 / 索引时序 / 检索时序 |
| 14 | 演进优化 | 借鉴 Notion/Zep 等: 双哈希增量 / 双路径 / 时间有效性 / 统一 Record / 轻关系 / 巩固 / hit@k |
| 15 | Web 鉴权 | 对齐 codeg: Session Cookie + Bearer,默认仅 127.0.0.1 |
| 16 | 结构化查看与编辑 | 树/表多维度浏览 + 在线编辑正文/元数据 + insight 演进链可视化 |
| 17 | 跨模型自动重嵌入迁移 | 换模型→影子重建→原子切换,迁移期旧索引可查 |
| 18 | 项目式自动进化 | 每项目独立进化回路 + 生命周期 + Dashboard 项目视角 |
| 19 | 借鉴 codeg 的插拔式增强 | skills 运行时目录插拔 / 单核心多形态 / 配置热重载(刻意不照搬 ACP 重协议) |
| 20 | 开发过程中的自动进化 | 双层: L1 代码索引全自动 + L2 经验沉淀(半自动 + 全自动经 AI 审核闸门入库) |
| 21 | 自动进化导读线 | 把 设计说明 串成一条"触发→提炼→审核→入库→演进→观测"主线 |
| 22 | 智能化检索能力 | 8 项带 benchmark 的能力: Contextual Retrieval / 重排 / 查询改写 / Agentic / Self-RAG / RAPTOR / 窗口 / 反馈学习 |
| 23 | 统一能力层 + Web AI 管家 | 项目能力封装为统一 Tool 层;Web 内嵌会话式 AI 管家,可读写治理(带确认闸门+回滚) |

**评审建议的阅读顺序**:
- 想快速把握骨架 → 读设计说明(分层 + 插拔 + 代码组织)。
- 关心"自动进化" → 从 自动进化导读线进,按需跳读设计说明。
- 关心"智能化" → 设计说明(检索智能)+ 设计说明(AI 管家)。
- 关心落地可行性与取舍 → 设计说明的选型表 + 设计说明的风险 + 各章"不采纳"小节(设计说明)。

---

## 1. 设计目标与约束

### 1.1 功能目标
1. **多项目知识管理**: 索引本机多个项目的源代码、文档/设计决策、通用开发规范、外部参考资料。
2. **隔离 + 共享模型**: 每个项目一个隔离 collection，另有一个 `_global` 通用库跨项目共享。
3. **自进化**:
   - 代码变更后自动增量重索引 (git hook / 定时)。
   - AI 开发过程中可主动沉淀决策、经验、踩坑 (`save_insight`)。
4. **通用接入**: 通过 **MCP 协议** 对接 Kiro CLI / Claude Code / Cursor / Copilot 等任意 AI 工具。
5. **Web 管理界面**: 可视化管理 collection、查看/编辑知识、手动触发索引、调参、观测状态。

### 1.2 非功能目标 (本设计的三条硬约束)
| 约束 | 设计手段 |
|---|---|
| **好维护** | 严格分层 + 关注点分离 + 配置驱动 + 统一错误处理 + 结构化日志 + 契约测试 |
| **插拔式** | 核心能力全部抽象为 trait，运行时经注册表 + 配置选择实现，新增实现零侵入 |
| **Web 管理界面** | 后端暴露 REST/WS，前端独立 SPA，复用与 MCP 相同的核心服务层 |

### 1.3 运行约束
- 全本地运行，默认不联网 (embedding 用本地 ONNX)。
- 单机常驻服务，低内存占用 (选型倾向 Rust)。
- 隐私: 源代码不出本机。

---

## 2. 架构总览

### 2.1 分层架构 (自上而下)

```
┌─────────────────────────────────────────────────────────────┐
│  接入层 (Interface Layer) — 多前端，共享同一核心              │
│  ┌───────────────┐  ┌───────────────┐  ┌──────────────────┐ │
│  │  MCP Server   │  │  REST + WS API │  │  CLI (管理命令)   │ │
│  │ (stdio/AI工具) │  │  (Web UI 用)   │  │ (index/reindex)  │ │
│  └───────┬───────┘  └───────┬───────┘  └────────┬─────────┘ │
└──────────┼──────────────────┼───────────────────┼───────────┘
           │                  │                   │
           ▼                  ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│  应用服务层 (Application / Service Layer)                     │
│  用例编排: SearchService / IndexService / CollectionService   │
│  / InsightService / EvolutionService                          │
│  —— 不含具体技术实现，只依赖下面的 trait 抽象                  │
└──────────┬──────────────────────────────────────────────────┘
           │  (依赖倒置: 只认 trait)
           ▼
┌─────────────────────────────────────────────────────────────┐
│  能力抽象层 (Ports / Traits) —— 插拔式的核心                   │
│  Embedder │ VectorStore │ KeywordIndex │ Chunker │ Loader │   │
│  Reranker │ EvolutionTrigger                                  │
└──────────┬──────────────────────────────────────────────────┘
           │  (运行时由注册表 + 配置绑定具体实现)
           ▼
┌─────────────────────────────────────────────────────────────┐
│  适配器层 (Adapters) —— 可替换实现                            │
│  FastEmbed │ LanceDB │ Tantivy(BM25) │ TreeSitterChunker │    │
│  Markdown/PDF/Web Loader │ GitHookTrigger / CronTrigger       │
└─────────────────────────────────────────────────────────────┘
```

**关键原则 — 依赖倒置**: 服务层只依赖「能力抽象层」的 trait，绝不直接 `use` 适配器。替换一个组件(例如把 LanceDB 换成 Qdrant)只需新增一个适配器并在配置里改一个名字，服务层与接入层零改动。

### 2.2 为什么这样分层能"好维护"
- **接入层薄**: MCP / REST / CLI 都只做协议转换，调用同一套 Service。新增一种接入方式不碰业务逻辑。
- **Web UI 与 MCP 共享核心**: 二者都调用同一 Service 层，不存在两套逻辑漂移。
- **单向依赖**: 接入层 → 服务层 → trait ← 适配器。编译期即可阻止层间越界。

---

## 3. 插拔式组件设计 (Ports & Adapters)

每个核心能力定义为一个 trait(端口)，每个具体技术是一个 adapter。下面用 Rust 伪代码表达契约(最终实现可能微调)。

### 3.1 Embedder — 向量化(可切换模型)
```rust
#[async_trait]
pub trait Embedder: Send + Sync {
    fn id(&self) -> &str;             // 如 "fastembed:paraphrase-ml-minilm"
    fn dimension(&self) -> usize;     // 384 / 768 / 1024
    async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
    async fn embed_query(&self, text: &str) -> Result<Vec<f32>>;
}
```
- 默认适配器: **FastEmbed**，模型由配置选择:
  - **`bge-m3` (1024d, 多语言含中英 + 代码/长文本友好, 默认)** ← 最适合"中文文档为主 + 英文代码"的混合场景;支持最长 8192,中文检索质量开源第一梯队
  - `paraphrase-ml-minilm` (384d, 多语言, 轻量备选, 最长 512)
  - `jina-v2-code` (768d, 代码专用)
  - `bge-small-en` (384d, 纯英文最快)
- 模型 **按需联网下载**(首次使用某模型时拉取 ONNX 到本地缓存),属插拔式——换模型只改配置。
- 未来可加 `OllamaEmbedder`、`OpenAIEmbedder` 适配器，实现同一 trait 即可。
- **维度约束与自动重嵌入**: 向量维度写入 collection 元数据;切换模型(尤其维度变化,如 384↔1024)时,系统**自动触发该 collection 的后台重嵌入迁移**(见设计说明),迁移期间旧索引继续可查,完成后原子切换。

### 3.2 VectorStore — 向量存储
```rust
#[async_trait]
pub trait VectorStore: Send + Sync {
    async fn ensure_collection(&self, name: &str, dim: usize, meta: CollectionMeta) -> Result<()>;
    async fn upsert(&self, coll: &str, records: Vec<Record>) -> Result<()>;
    async fn delete_by_source(&self, coll: &str, source: &str) -> Result<()>;
    async fn vector_search(&self, coll: &str, q: &[f32], k: usize, filter: Option<Filter>) -> Result<Vec<Hit>>;
    async fn list_collections(&self) -> Result<Vec<CollectionMeta>>;
}
```
- 默认适配器: **LanceDB** (嵌入式, 零运维, Rust 原生)。
- 可替换: Qdrant / pgvector 适配器。

### 3.3 KeywordIndex — 关键词/BM25 检索
```rust
#[async_trait]
pub trait KeywordIndex: Send + Sync {
    async fn index(&self, coll: &str, records: &[Record]) -> Result<()>;
    async fn search(&self, coll: &str, query: &str, k: usize) -> Result<Vec<Hit>>;
}
```
- 默认适配器: **Tantivy** (Rust 版 Lucene, BM25)。
- 与向量结果在服务层做 **hybrid 融合** (RRF, 见设计说明)。

### 3.4 Chunker — 分块策略
```rust
pub trait Chunker: Send + Sync {
    fn supports(&self, lang: Language) -> bool;
    fn chunk(&self, content: &str, lang: Language) -> Vec<Chunk>;
}
```
- `TreeSitterChunker`: 按函数/类/方法 AST 边界切分代码(多语言)。
- `MarkdownChunker`: 按标题层级切分文档。
- `FixedWindowChunker`: 兜底，按 token 窗口+overlap。
- Chunker 用注册表按语言/文件类型自动路由。

### 3.5 Loader — 内容来源
```rust
#[async_trait]
pub trait Loader: Send + Sync {
    fn scheme(&self) -> &str;  // "file" / "pdf" / "web"
    async fn load(&self, source: &Source) -> Result<Vec<RawDoc>>;
}
```
- `FileLoader` (代码+文本)、`PdfLoader`、`WebLoader` (抓取外部资料)。

### 3.6 Reranker — 可选重排
```rust
#[async_trait]
pub trait Reranker: Send + Sync {
    async fn rerank(&self, query: &str, hits: Vec<Hit>) -> Result<Vec<Hit>>;
}
```
- 默认 `NoopReranker`；可插入 cross-encoder 重排提升精度。

### 3.7 EvolutionTrigger — 自进化触发器
```rust
#[async_trait]
pub trait EvolutionTrigger: Send + Sync {
    async fn start(&self, tx: IndexCommandSender) -> Result<()>;
}
```
- `GitHookTrigger` (post-commit 增量)、`CronTrigger` (定时全量校验)、`ManualTrigger` (Web/CLI 手动)、`FsWatchTrigger` (文件监听, 可选)。

### 3.8 注册表 (让"插拔"落地)
```rust
// 启动时按 config.yaml 把名字绑定到具体适配器
registry.register_embedder("fastembed", |cfg| Box::new(FastEmbedder::new(cfg)?));
registry.register_store("lancedb", |cfg| Box::new(LanceStore::new(cfg)?));
// ...
let embedder = registry.build_embedder(&config.embedder)?; // 配置里写 name 即可切换
```
新增实现 = 写一个 adapter + 注册一行，**不改任何上层代码**。

---

## 4. 核心数据流

### 4.1 索引流程
```
Source → Loader → RawDoc → Chunker → Chunk[]
   → 双哈希判定(content_hash / meta_hash, 见设计说明)
       ├─ content 变  → Embedder.embed_documents → VectorStore.upsert + KeywordIndex.index
       ├─ 仅 meta 变  → 只更新元数据(跳过 embedding, 廉价路径)
       └─ 均未变       → 跳过
```
调度分两条路径(见设计说明): 批量(全量/手动) 与 在线队列(git hook / 编辑 / save_insight)。

### 4.2 检索流程 (hybrid)
```
query
 ├─ Embedder.embed_query → VectorStore.vector_search → 语义命中
 └─ KeywordIndex.search → BM25 命中
        → RRF 融合 (Reciprocal Rank Fusion)
        → (可选) Reranker.rerank
        → TopK 返回 (带 source/行号/collection 出处)
```

### 4.3 自进化流程
```
git commit ─(post-commit hook)→ 发 reindex 命令 → IndexService 增量索引
cron 定时 ───────────────────→ 全量校验/补偿
AI 调 save_insight ──────────→ InsightService 写入 insights collection
```

---

## 5. 接口设计

### 5.1 MCP 工具 (给 AI 工具用)
| 工具 | 说明 |
|---|---|
| `search_knowledge` | 跨/指定 collection 的 hybrid 语义检索(文档+经验) |
| `search_code` | 针对代码 collection 的检索，返回函数/类片段+出处 |
| `save_insight` | 沉淀一条决策/经验到 `_global` 或指定项目 |
| `reindex_project` | 触发某项目增量/全量重索引 |
| `list_collections` | 列出所有 collection 及其模型/维度/条数 |

### 5.2 REST + WS API (给 Web UI 用)
```
GET    /api/collections                 列表+统计
POST   /api/collections                 新建(选 embedder/维度)
DELETE /api/collections/{name}          删除
GET    /api/collections/{name}/items    浏览知识条目(分页)
POST   /api/search                      调试检索(看命中与打分)
POST   /api/index/reindex               手动触发索引
GET    /api/config  /  PUT /api/config  查看/修改配置
WS     /api/events                      索引进度/日志实时推送
GET    /api/health                      健康与指标
```
REST 层与 MCP 层调用**同一 Service**，不重复实现业务逻辑。

---

## 6. 隔离与存储模型

```
~/.kb/                              (数据根目录, 可配置)
├── config.yaml                     全局配置(选哪些 adapter/模型/调度)
├── lancedb/                        向量库 (每 collection 一张表)
│   ├── _global                     通用库: 规范/最佳实践/外部资料/经验
│   ├── proj__<projectA>            项目A (代码+文档)
│   └── proj__<projectB>
├── tantivy/                        BM25 索引 (与 collection 对应)
│   ├── _global/ ...
└── meta.db (或 json)               collection 元数据: embedder_id, dim, 文件指纹, 更新时间
```
- 检索可指定范围: 单项目 / `_global` / 项目+global 合并。
- 每个 collection 记录其 `embedder_id + dimension`；配置切换模型且维度变化时，Web UI/CLI 提示"需重建该 collection"，避免维度冲突。

---

## 7. Web 管理界面设计

### 7.1 技术选型(已定)
- 后端: **独立守护进程**内用 `axum` 暴露 REST + WS(见设计说明的进程模型)。
- 前端: **Vue3 + Vite + 组件库** 的独立 SPA(**已定**)。构建产物(静态文件)由守护进程静态托管,零额外部署,访问 `http://127.0.0.1:<port>`。
- 源码位于 `web-ui/`,CI 构建后产物内嵌进二进制(`rust-embed`)或由守护进程读取磁盘目录。

### 7.2 页面
1. **Dashboard**: collection 数、文档数、最近索引时间、内存/磁盘占用、索引队列状态、各项目进化活跃度。
2. **Collections**: 增删改查，查看每个库的模型/维度/条数，一键重索引;可按"项目 / 通用 / 外部资料"分组。
3. **结构化浏览与编辑** (重点, 详见设计说明): 以树形/表格/卡片结构化呈现知识条目;支持筛选(按 kind/项目/时间/状态)、全文+语义搜索定位、**在线编辑条目正文与元数据**、新增/删除/标记过期、编辑后即时重嵌入。insight 决策可视化其版本演进链。
4. **Search Playground**: 输入 query，可视化看向量/BM25/融合后的命中与打分，便于调参。
5. **Config**: 在线编辑 embedder/chunker/retriever/调度/项目路径,并热生效(或提示重启)。
6. **Logs/Events**: WS 实时索引进度与日志。
7. **登录页 `/login`**: 见设计说明里的鉴权。

---

## 8. 技术选型与理由(汇总，供评估)

| 关注点 | 默认选型 | 理由 | 可替换为 |
|---|---|---|---|
| 语言 | Rust | 常驻低内存、单二进制、LanceDB 原生 | — |
| 向量库 | LanceDB | 嵌入式零运维、索引构建快 | Qdrant / pgvector |
| Embedding | FastEmbed(**BGE-M3** 默认, 多语言含中英) | 本地 ONNX、免费、按需下载、可切换模型 | MiniLM / Jina-code / Ollama / OpenAI |
| 关键词 | Tantivy | Rust 版 Lucene，成熟 BM25 | — |
| 分块 | tree-sitter | 按 AST 边界，代码检索质量关键 | LLM 分块 |
| 融合 | RRF | 实现简单、无需调权重、效果稳 | 加权融合 |
| 接入 | MCP(rmcp) | AI 工具事实标准 | — |
| Web 后端 | axum | 与主体同栈、单进程 | actix-web |
| Web 前端 | Vue3 SPA | 交互强、生态好 | React / SSR 模板 |
| Web 鉴权 | Session Cookie(HttpOnly) + Bearer Token | 参考 codeg 的 session 方式;默认仅 127.0.0.1 | — |

---

## 9. 目录结构(代码组织，体现可维护性)

```
knowledgeBase/
├── Cargo.toml
├── ARCHITECTURE.md                 (本文档)
├── config.example.yaml
├── crates/
│   ├── kb-core/                    领域模型 + 全部 trait(端口) + Service
│   │   ├── model/                  Chunk/Record/Hit/CollectionMeta...
│   │   ├── ports/                  Embedder/VectorStore/... traits
│   │   └── service/                SearchService/IndexService/...
│   ├── kb-ipc/                     daemon↔mcp 的本地 IPC 契约(JSON-RPC over UDS)
│   ├── kb-adapters/                所有可插拔实现
│   │   ├── embed_fastembed/
│   │   ├── store_lancedb/
│   │   ├── keyword_tantivy/
│   │   ├── chunk_treesitter/
│   │   ├── loader_*/
│   │   └── trigger_*/
│   ├── kb-daemon/                  常驻守护进程: 组装 adapters + 跑 Web + IPC 服务端
│   ├── kb-web/                     REST/WS 路由 + 内嵌 Vue3 构建产物
│   ├── kb-mcp/                     瘦 MCP 客户端: stdio ↔ daemon IPC
│   └── kb-cli/                     管理命令(kb serve / reindex / ...)
├── web-ui/                         前端 Vue3 + Vite SPA 源码
└── scripts/                        git hook 模板 / 安装脚本 / 服务单元
```
- `kb-core` **不依赖任何适配器 crate**(依赖倒置的编译期保证)。
- 每个适配器独立 crate，可单独测试、单独替换。

---

## 10. 风险与评估点

1. ~~**Web 前端栈**~~ → **已定: Vue3 SPA**。
2. ~~**进程模型**~~ → **已定: 独立守护进程 + 瘦 MCP 客户端**(详见设计说明)。
3. ~~**模型切换的维度冲突**~~ → **已定: 自动后台重嵌入迁移**(见设计说明),迁移期间旧索引可查,完成原子切换。
4. **增量索引的准确性**: 依赖文件指纹(hash)+git diff；重命名/移动文件用 content_hash 复用向量(见设计说明)。
5. ~~**首次模型下载**~~ → **已定: 允许联网按需下载**;离线场景可预置模型目录(插拔式,不影响架构)。
6. **并发与锁**: LanceDB/Tantivy 写入与查询并发策略，索引期间是否允许检索。守护进程模型下由单一索引队列串行写入,天然缓解。
7. ~~**安全/鉴权**~~ → **已定: 需要鉴权**,默认仅监听 `127.0.0.1`,Session Cookie + Bearer(见设计说明)。

---

## 11. 待你决策的清单
- [x] ~~Web 前端~~ → **Vue3 SPA**
- [x] ~~进程模型~~ → **独立守护进程 + 瘦 MCP 客户端**
- [x] ~~默认 embedding 模型~~ → **BGE-M3(1024d, 多语言含中英, 默认)**,MiniLM/Jina-code/bge-small-en 可切换
- [x] ~~跨模型自动重嵌入迁移~~ → **支持**(见设计说明)
- [x] ~~网络约束~~ → **允许联网**,模型按需下载、插拔式
- [x] ~~Web 登录鉴权~~ → **需要**,Session Cookie + Bearer,对齐 codeg(见设计说明)

> 决策已全部收敛,可进入实现阶段。

---

## 12. 进程模型(已定: 守护进程 + 瘦 MCP 客户端)

### 12.1 拓扑
```
         ┌──────────────────────────────────────────────┐
         │         kb-daemon (常驻后台守护进程)           │
         │   单一事实来源: 持有 LanceDB / Tantivy /       │
         │   Embedder / 索引队列 / 调度器                  │
         │                                                │
         │   ┌────────────┐   ┌───────────────────────┐  │
         │   │  Web 服务   │   │  本地 IPC 服务          │  │
         │   │ axum        │   │ (Unix socket / 本地    │  │
         │   │ REST+WS     │   │  TCP + JSON-RPC)       │  │
         │   └─────┬──────┘   └───────────┬───────────┘  │
         └─────────┼──────────────────────┼──────────────┘
                   │                       │
        ┌──────────▼─────────┐   ┌─────────▼──────────────┐
        │  浏览器 Vue3 SPA    │   │  kb-mcp (瘦客户端)       │
        │  (管理界面)         │   │  每个 AI 工具各起一个,   │
        └────────────────────┘   │  stdio ↔ daemon IPC     │
                                  └────────────┬────────────┘
                                               │ stdio (MCP)
                          ┌────────────────────┼────────────────────┐
                          ▼                    ▼                    ▼
                     Kiro CLI            Claude Code             Cursor
```

### 12.2 职责划分
- **kb-daemon**: 唯一持有数据与模型的进程。负责索引、存储、检索、调度、Web。常驻,生命周期独立于任何 AI 工具。
- **kb-mcp**: 极薄的 MCP 适配器。AI 工具启动它、它连到 daemon 的本地 IPC、把 MCP 工具调用转发给 daemon、返回结果。被 AI 工具频繁启停也不影响 daemon 的索引与数据。
- **kb-cli**: 既能作为 daemon 入口(`kb serve`),也能发管理命令(`kb reindex` 等,底层走同一 IPC)。

### 12.3 收益
- AI 工具频繁重启 MCP 进程 **不会**中断后台索引或重载模型(模型只在 daemon 加载一次,省内存省时间)。
- 多个 AI 工具并发接入,共享同一份索引与同一个已加载的 Embedder。
- Web UI 与 MCP 操作的是同一活数据,实时一致。

### 12.4 代价与应对
- 多一层 IPC → 用本地 Unix socket + JSON-RPC,延迟可忽略;契约由 kb-core 的 Service 签名统一,不产生第二套逻辑。
- 需要 daemon 生命周期管理 → 提供 `kb serve` 前台模式 + 可选 systemd/launchd 用户服务单元。

---

## 13. 图示

### 13.1 组件依赖(编译期单向,保证可维护)
```
 kb-mcp ─┐
 kb-web ─┼─► kb-core (model + ports/traits + service)
 kb-cli ─┘          ▲
                    │ impl traits
            kb-adapters (fastembed/lancedb/tantivy/treesitter/loader/trigger)

 规则: kb-core 不依赖 kb-adapters,也不依赖任何接入层。
       接入层与适配器层互不相认,只通过 kb-core 的 trait 相遇。
```

### 13.2 索引数据流(时序)
```
Trigger        IndexService     Loader    Chunker   Embedder   VectorStore  KeywordIndex
  │ reindex(path)  │               │         │          │           │            │
  ├───────────────►│               │         │          │           │            │
  │                │ load(source)  │         │          │           │            │
  │                ├──────────────►│         │          │           │            │
  │                │◄──RawDoc[]────┤         │          │           │            │
  │                │ chunk(doc)              │          │           │            │
  │                ├────────────────────────►│          │           │            │
  │                │◄────────Chunk[]─────────┤          │           │            │
  │                │ (按 hash 过滤未变更块)                                        │
  │                │ embed_documents(chunks)            │           │            │
  │                ├───────────────────────────────────►│           │            │
  │                │◄──────────vectors──────────────────┤           │            │
  │                │ upsert(coll, records)                          │            │
  │                ├───────────────────────────────────────────────►│            │
  │                │ index(coll, records)                                        │
  │                ├────────────────────────────────────────────────────────────►│
  │                │ emit progress ──► WS ──► Web UI                              │
```

### 13.3 检索数据流(时序,hybrid)
```
Caller(MCP/Web)   SearchService   Embedder   VectorStore   KeywordIndex   Reranker
   │ search(q, scope) │              │            │              │            │
   ├─────────────────►│              │            │              │            │
   │                  │ embed_query(q)            │              │            │
   │                  ├─────────────►│            │              │            │
   │                  │◄───qvec──────┤            │              │            │
   │                  │ vector_search(qvec,scope) │              │            │
   │                  ├──────────────────────────►│              │            │
   │                  │◄──── semantic hits ───────┤              │            │
   │                  │ search(q, scope)                         │            │
   │                  ├─────────────────────────────────────────►│            │
   │                  │◄──────────── bm25 hits ──────────────────┤            │
   │                  │ RRF 融合(semantic, bm25)                               │
   │                  │ rerank(q, fused)                                      │
   │                  ├──────────────────────────────────────────────────────►│
   │                  │◄──────────────── ranked ──────────────────────────────┤
   │◄── TopK(带出处)──┤                                                        │
```

---

## 14. 演进优化(借鉴 Notion / Mem0 / Zep / Letta 等成熟方案)

> 本章来自对同类成熟方案的调研,目的是在不改变 设计说明 骨架(分层/trait 插拔/daemon+MCP/Vue3)的前提下,增强**数据模型**与**索引/进化管道**。来源与对应优化见每条标注。

### 14.1 双哈希增量索引 (来源: Notion "Page State")
问题: 原 设计说明 仅靠单一文件 hash,文件任何改动都会整文件重嵌入,浪费算力。
优化: 每个 chunk 保存两个哈希:
- `content_hash` (xxHash/sha256, 针对切块后的文本)
- `meta_hash` (针对元数据: 路径/权限/作者/行号/语言等)

重索引决策表:
| content_hash | meta_hash | 动作 |
|---|---|---|
| 变 | 任意 | 重嵌入 + 重写向量 + 更新元数据 (昂贵路径) |
| 不变 | 变 | **只更新元数据,跳过 embedding** (廉价路径) |
| 不变 | 不变 | 跳过 |

收益: 仅挪动文件、改权限、换行号这类高频但语义不变的改动不再触发昂贵的 embedding。这是省算力的关键。

### 14.2 双路径索引管道 (来源: Notion offline/online dual-path)
- **离线/批量路径**: 首次全量索引、手动 `reindex` 走批处理,吞吐优先。
- **在线/增量路径**: git hook / 文件变更 / `save_insight` 发单条命令进 **daemon 内部索引队列**,低延迟入库(目标 sub-minute)。
- 两条路径最终都落到同一 `IndexService`,只是调度策略不同。daemon 常驻天然承载这个队列。

```
reindex(全量) ──► [批处理器] ─┐
git hook/edit ─► [索引队列] ──┼─► IndexService ─► (双哈希判定) ─► Store/Keyword
save_insight ──► [索引队列] ──┘
```

### 14.3 insights 的时间有效性与版本 (来源: Zep temporal validity)
问题: 决策/经验会过时;直接覆盖或删除会丢失演进史,且 AI 可能读到过期决策。
优化: insight/decision 类 Record 增加字段:
```rust
struct TemporalMeta {
    valid_from: DateTime,
    valid_until: Option<DateTime>,     // None = 当前有效
    status: Status,                    // Active | Superseded | Deprecated
    superseded_by: Option<RecordId>,   // 指向取代它的新决策
    version: u32,
}
```
- 新决策推翻旧决策: 旧的标 `Superseded` 并指向新的,**不删除**。
- 检索默认只返回 `Active`;Web UI 可查看完整演进历史。
- 让"自进化"真正可信: 知识库会"新陈代谢"而非无限堆积矛盾信息。

### 14.4 统一 Record 数据模型 (来源: Notion "everything is a block")
所有内容(代码块 / 文档段 / insight / 外部资料)统一为同构 `Record`,用 `kind` 区分,共用存储/检索/融合逻辑,消除特例代码:
```rust
struct Record {
    id: RecordId,
    collection: String,
    kind: RecordKind,          // Code | Doc | Insight | External
    text: String,              // 用于 embedding 与 BM25 的正文
    vector: Vec<f32>,
    content_hash: u64,
    meta_hash: u64,
    source: SourceRef,         // 文件路径+行号 / URL / commit
    relations: Vec<Relation>,  // 见 14.5
    temporal: Option<TemporalMeta>, // 见 14.3 (主要用于 Insight)
    extra: Map<String, Value>, // kind 特有字段
}
```

### 14.5 轻量关系层(务实版"图") (来源: Mem0/Zep 向量 vs 图权衡)
调研结论: 纯向量在多跳关系/时序上弱,但完整图数据库太重、召回差、违背"好维护"。折中方案:
- 不引入图数据库,只在 `Record.relations` 存轻量边: `Code→Symbol`、`Insight→关联文件/commit`、`Doc→引用的代码`。
- 检索时支持可选的 **一跳扩展**: 命中一个函数时带出其关联决策/文档。
- 以后若确有多跳需求,可新增一个 `GraphStore` trait 适配器,不影响现有设计。

### 14.6 异步"巩固"任务 (来源: Letta 分层记忆 / Anthropic "Dreaming")
daemon 空闲时运行后台巩固任务,作为 `EvolutionTrigger` 的一个实现:
- 近似去重: 合并高度相似的 insights。
- 聚类归纳: 把零散经验聚成主题。
- 过期检测: 标记可能失效的决策(配合 14.3)。
完全契合插拔式设计——不需要可直接关闭。

### 14.7 检索质量可观测: 黄金查询集 + hit@k (来源: 多方案一致建议 benchmark hit@k)
- 维护一组固定的 `query → 期望命中` 黄金集(存 `_global` 或配置)。
- 换模型、调分块/融合参数后,自动跑 `hit@k / MRR` 回归,结果展示在 Web UI 的 Playground。
- 让"调优"有客观依据,而非凭感觉。

### 14.8 明确不采纳(避免过度设计)
| 成熟方案做法 | 为何不采纳 |
|---|---|
| Kafka 事件流 | 本机单用户,内部队列足矣 |
| Spark/Airflow 批处理集群 | 规模完全不匹配 |
| 向量库分片 / 多 generation 路由 | LanceDB 嵌入式单机无需分片 |
| 完整知识图谱数据库 | 太重、召回差、违背"好维护";用 14.5 轻量关系替代 |
| 托管云向量库(turbopuffer 等) | 隐私要求代码不出本机 |

> 原则: 借鉴其**数据模型与管道思想**,不照搬其**分布式规模化设施**。

### 14.9 对既有章节的影响
- 设计说明: 新增字段不改变 trait 签名;巩固任务复用 `EvolutionTrigger`;轻量关系为未来 `GraphStore` 预留。
- 设计说明: 索引流程插入"双哈希判定";新增双路径调度。
- 设计说明: Record 增加 temporal/relations 字段,存储层随之扩列。
- 设计说明的风险 设计说明(增量准确性)由 14.1 双哈希 + 重命名用 content_hash 复用向量 缓解。

---

## 15. Web 鉴权(已定,参考 codeg 的 session 方式)

> 依据: 参考公开仓库 codeg 的 Web 实现,其登录使用基于 **session cookie**(观察到 `sessionid`/`session_id`)并以 `authorization: bearer` 作为补充。本设计与之对齐。

### 15.1 模型
- **单用户本地服务**。首次启动 `kb-daemon` 时:若未设置凭据,则在 `~/.kb/auth.json`(文件权限 `600`)生成初始密码/令牌并在日志/CLI 提示;或首次访问 Web 时引导设置密码(bcrypt/argon2 存储哈希)。
- **登录流程**: 浏览器访问 → `/login` 提交密码 → 服务端校验 → 下发 **HttpOnly + Secure(本地可放宽) + SameSite=Strict** 的会话 cookie `kb_session`;服务端维护 session 存储(内存/落盘),带过期时间与滑动续期。
- **访问控制**: axum 中间件校验所有 `/api/*` 与页面;未认证的页面请求 302 到 `/login`,API 请求返回 `401`。
- **脚本/CLI 访问**: 支持 `Authorization: Bearer <token>`(长期令牌,可在设置页生成/吊销),对应 codeg 公开文档中的 `bearer`。
- **绑定地址**: 默认仅监听 `127.0.0.1:<port>`。如需远程访问,须在 config 显式开启并**强制**鉴权(拒绝无鉴权的非回环监听)。
- **IPC 通道**(daemon↔kb-mcp, Unix socket): 不走 Web 密码,靠 socket 文件权限 + 启动握手令牌;MCP 客户端不触碰 Web 凭据。

### 15.2 相关 trait(保持插拔)
```rust
#[async_trait]
pub trait AuthProvider: Send + Sync {
    async fn verify_password(&self, pw: &str) -> Result<bool>;
    async fn issue_session(&self) -> Result<SessionToken>;
    async fn validate_session(&self, token: &str) -> Result<bool>;
    async fn issue_bearer(&self, label: &str) -> Result<BearerToken>;
    async fn revoke(&self, token_id: &str) -> Result<()>;
}
```
默认 `LocalAuthProvider`;未来可替换为 OIDC/反向代理信任头等,不影响上层。

---

## 16. 结构化查看与编辑(Web 管理界面重点能力)

> 对应你的补充诉求: "能结构化查看知识库内容情况,甚至要能良好编辑"。

### 16.1 结构化查看
- **多维度组织**: 按 `collection(项目/_global/外部)` → `kind(Code/Doc/Insight/External)` → 条目 的树形导航;另提供表格视图(可排序列: 来源、更新时间、状态、命中频次)。
- **概览统计**: 每个 collection/kind 的条目数、向量维度、模型、最近更新、过期(superseded)数量。
- **溯源**: 每条目可展开看来源(文件路径+行号 / URL / commit)、content_hash、关联关系（设计说明）。
- **insight 演进链**: 对决策类条目,可视化 `version` 与 `superseded_by` 形成的时间线。
- **定位**: 结构化筛选 + 顶部语义/关键词搜索,快速跳到目标条目。

### 16.2 良好编辑
- **在线编辑正文**: 对 Doc/Insight 类条目直接编辑 Markdown 正文,保存后**即时重嵌入该条目**(走 设计说明 双哈希路径)。
- **编辑元数据**: 标签、所属项目、kind、关系、有效期/状态(标记过期或恢复)。
- **新增/删除**: 手动新增一条 insight;删除或归档条目。
- **代码类条目**: 默认只读(源自真实文件,编辑应改源文件后重索引),但允许附加"注解/经验"作为关联 Insight,不污染代码块本身。
- **安全**: 所有编辑经 设计说明里的鉴权;写操作进 设计说明的索引队列串行执行,避免与后台索引冲突;提供乐观锁(基于 content_hash)防并发覆盖。

### 16.3 对应 API(补充接口设计)
```
GET    /api/collections/{c}/items?kind=&project=&status=&q=&page=   结构化浏览
GET    /api/items/{id}                                              条目详情+溯源+关系
POST   /api/items                                                   新增(主要 Insight)
PUT    /api/items/{id}                                              编辑正文/元数据 → 触发重嵌入
DELETE /api/items/{id}                                              删除/归档
POST   /api/items/{id}/supersede                                    用新条目取代(写演进链)
```

---

## 17. 跨模型自动重嵌入迁移(已定: 支持)

当 collection 的 `embedder_id` 或维度发生变化(例如从 BGE-M3 1024d 换到 MiniLM 384d):
1. **检测**: daemon 对比 config 目标模型与 collection 元数据,发现不一致即排一个迁移任务。
2. **影子重建**: 新建一张 `<coll>__migrating` 表(新维度),用新模型对该 collection 全部 Record 的原文重嵌入并写入;原表在此期间**继续服务检索**。
3. **原子切换**: 迁移完成且校验条数一致后,原子地把别名指向新表,删除旧表。
4. **进度**: 经 WS 推送到 Web UI;失败可重试,不破坏旧数据。
5. **成本提示**: UI 事先显示预计条目数与耗时,大库给出确认。
- 对应 trait: 作为 `IndexService` 的一个迁移用例 + 一个 `MigrationTrigger`(EvolutionTrigger 家族),插拔可关。

---

## 18. 项目式自动进化(强化)

> 对应你的补充诉求: "支持项目式开发过程自动进化"。进化按**项目维度**独立运作。

### 18.1 每个项目独立的进化回路
- 每个项目 collection 绑定自己的:监听路径、忽略规则(.gitignore)、git 仓库、调度策略、关联的 `_global` 规范集。
- **代码进化**: 项目内 `git post-commit` hook 只触发**本项目**的增量重索引(双哈希);定时任务对本项目做全量校验补偿。
- **过程进化**: 开发过程中 AI/人经 `save_insight` 把该项目的决策、踩坑、方案沉淀进**本项目** collection(或在跨项目通用时写 `_global`)。insight 带 设计说明 时间有效性,随开发推进新陈代谢。
- **巩固**: 设计说明的空闲巩固任务按项目分别运行,聚类归纳本项目经验、标记过期决策。

### 18.2 项目生命周期
```
注册项目(path, repo) → 首次全量索引(批路径) → 安装 git hook
   → 开发中: commit→增量索引 / save_insight→沉淀经验 (在线路径)
   → 空闲: 巩固+过期检测
   → 模型升级: 自动重嵌入迁移（设计说明）
   → 下线: 归档或删除该 collection
```

### 18.3 Dashboard 的项目视角
- 每个项目显示: 代码条目数、文档数、insight 数、最近 commit 索引时间、进化活跃度(近 N 天新增/更新)、过期决策数。
- 让"项目知识随开发自动成长"这件事**可观测**。

---

## 19. 借鉴 codeg 的插拔式增强

> 来源: 实地考察 [keh4l/codeg](https://github.com/keh4l/codeg)(Tauri + Rust 多 agent 工作区)。其插拔式核心是 **ACP(Agent Client Protocol) 统一 agent 边界** + **按能力领域分模块** + **skills 目录机制** + **单核心多形态(桌面/自托管/Docker)** + **配置热重载**。
>
> 对照结论: 本架构在进程内插拔(7 trait + 依赖倒置)上已与 codeg 同级且更严谨。**不照搬** ACP 那种跨进程重协议(我们的适配器都是 Rust 进程内,trait 更简单、零序列化开销;对外协议边界已由 MCP 承担)。**吸收**以下三点。

### 19.1 Skills 式运行时目录插拔(轻量扩展,无需改代码)
除编译期 trait 适配器外,增加一层**运行时可发现的扩展**,借鉴 codeg 的 `.agents/skills`:
- 约定目录 `~/.kb/skills/`,每个子目录是一个 skill: 一份 `manifest.toml`(声明类型/触发条件/参数)+ 可选脚本或提示模板。
- 支持的 skill 类型:
  - **Loader skill**: 教系统解析一种新来源/格式(如某私有文档格式、某 API 文档站)。
  - **Enricher skill**: 索引前对内容做预处理(清洗、摘要、打标签)。
  - **Insight 规范 skill**: 定义某项目沉淀经验的模板与校验规则。
- daemon 启动及运行时扫描该目录,热加载;Web UI 可列出/启停 skills。
- 与 trait 的分工: **trait = 开发者加新"引擎"(重,编译期);skill = 用户加新"规则/来源"(轻,运行时,无需编译)**。

### 19.2 单核心多形态部署(核心不变,外壳可换)
明确 `kb-daemon` 为唯一核心,部署形态是可换外壳(借鉴 codeg 桌面/自托管/Docker 三形态):
- **CLI/后台服务**(默认): `kb serve`,本机常驻。
- **Docker**: 封装 daemon + 预置模型目录,一条命令起。
- **(可选未来)桌面壳**: Tauri/Electron 包住 Web UI,核心仍是同一 daemon。
- 关键: 形态切换不改 kb-core / kb-adapters,只换进程入口与打包。

### 19.3 配置热重载(提升为一等能力)
借鉴 codeg 的 config-hot-reload,把 设计说明 Config 的"热生效"落为明确机制:
- 监听 `~/.kb/config.yaml` 变更;可热切换的项(检索参数、调度、融合权重、skills 开关)即时生效。
- 需重建的项(embedder 维度变化)不静默执行,而是触发 设计说明的受控迁移并在 UI 提示。
- 热重载经同一 `Service` 入口,保证与 Web/CLI 改配置行为一致。

### 19.4 对既有章节的影响
- 设计说明: 新增 `SkillRegistry`(与 trait 注册表并列,但面向运行时目录发现),不改动既有 trait。
- 设计说明: 部署形态作为非功能维度补充,默认选型不变。
- 设计说明: 配置热重载与受控迁移衔接,无冲突。

---

## 20. 开发过程中的自动进化(双层 + AI 审核闸门)

> 对应诉求: "支持开发过程中自动进化",且"两者都要——全自动提炼,但只让 AI 审核后入库"。
> 设计原则: **全自动负责"捕捉",AI 审核负责"质量闸门"**。自动提炼绝不直接写进可检索库,必须经审核转正,避免污染知识库。

### 20.1 两层进化并存
| 层 | 触发 | 自动程度 | 入库路径 |
|---|---|---|---|
| **L1 代码/文档索引** | git hook / 文件变更 / 定时 | 全自动(可靠) | 直接入库(双哈希,设计说明) |
| **L2 经验/决策沉淀** | 见下 | **半自动 + 全自动并存** | 半自动直接入;全自动经审核闸门 |

L2 又分两条并行通道,**可各自开关**:
- **L2a 半自动(默认开)**: 开发中 AI/人判断有价值,主动调 `save_insight` → 直接入库(status=Active)。质量最可控。
- **L2b 全自动(可选开)**: 事件触发自动提炼候选经验 → 进**草稿队列** → **AI 审核**转正才入库。

### 20.2 L2b 全自动提炼管道(草稿 → AI 审核 → 入库)
```
事件源(commit/会话结束/错误修复/调试闭环)
   │  (EvolutionTrigger 捕获)
   ▼
EvolutionExtractor.extract(context) ──LLM──► 候选经验[] (status=Draft)
   │
   ▼  写入草稿队列(drafts, 不可被正常检索)
   ▼
ReviewGate.review(draft) ──AI 审核员(可配独立模型)──►
   ├─ 通过 → 规范化/去重(对照已有的设计说明的关系 & 设计说明的巩固) → status=Active → 入库
   ├─ 修订 → 改写后入库并记录修订
   └─ 拒绝 → 丢弃或留档(不进可检索库)
   │
   ▼  (可选)人工在 Web UI 二次复审草稿队列
```

### 20.3 新增可插拔组件(符合插拔式设计)
```rust
/// 从开发上下文提炼候选经验(实现可换: 基于 diff / 基于会话 / 基于错误日志)
#[async_trait]
pub trait EvolutionExtractor: Send + Sync {
    fn id(&self) -> &str;
    async fn extract(&self, ctx: &DevContext) -> Result<Vec<DraftInsight>>;
}

/// AI 审核闸门(实现可换: 规则校验 / LLM 评分 / 双模型交叉)
#[async_trait]
pub trait ReviewGate: Send + Sync {
    async fn review(&self, draft: DraftInsight) -> Result<ReviewOutcome>;
    // ReviewOutcome = Approve(Record) | Revise(Record, reason) | Reject(reason)
}
```
- `DevContext`: 一次提炼的输入(git diff / commit message / 变更文件 / 关联会话摘要 / 失败→修复记录等)。
- `EvolutionExtractor` 与 `ReviewGate` 都是新 trait,注册表 + 配置选择实现;默认各一个,可关可换。
- 审核员模型**独立于主 embedding 模型**配置(可用更强的对话模型做评审)。

### 20.4 草稿状态机(扩展状态机的 Status)
```
Draft ──review approve──► Active
Draft ──review revise───► Active(revised)
Draft ──review reject───► Rejected(留档, 不检索)
Active ──被新决策取代──► Superseded （设计说明）
```
- `drafts` 独立存储,默认**不参与** `search_knowledge`;仅审核/复审流程可见。
- Web UI "结构化浏览"（设计说明）新增 **Review 收件箱**: 列出待审草稿,显示来源上下文、AI 审核意见与打分,人工可一键采纳/改写/驳回。

### 20.5 质量与安全防线(防止自动进化污染库)
1. **闸门强制**: L2b 任何草稿**不经审核不得进可检索库**(架构硬约束)。
2. **去重**: 入库前对照已有经验做近似去重(复用 设计说明的巩固能力)。
3. **可溯源**: 每条自动经验记录来源事件、提炼器 id、审核员 id 与打分,Web 可追。
4. **可回滚**: 自动入库的经验带标记,支持按批次撤回。
5. **节流**: 提炼与审核走 设计说明 在线队列,限频,避免高频 commit 打爆 LLM 调用。
6. **成本可控**: L2b 默认关闭;开启时可配触发条件(如仅 feat/fix 类 commit、仅会话含"决策/踩坑"信号时)。

### 20.6 项目维度(衔接项目维度)
- L2b 按项目独立配置与运行: 每个项目可单独决定是否开启全自动提炼、用哪个提炼器/审核员、经验默认落本项目还是 `_global`。
- Dashboard 项目视图新增: 待审草稿数、自动经验采纳率、最近自动沉淀条目。

### 20.7 对既有章节的影响
- 设计说明: 新增 `EvolutionExtractor` / `ReviewGate` 两个 trait 与对应注册;`EvolutionTrigger` 复用为事件源。
- 设计说明: 新增草稿/审核相关 API 与 Web "Review 收件箱"。
- 设计说明: Status 扩展 Draft/Rejected。
- 设计说明: L2b 纳入项目式进化回路,默认关闭、按项目开启。

---

## 21. 自动进化导读线(一条主线串起全文)

> 本章不引入新设计,只把分散在 设计说明的"自动进化"串成一条可顺读的主线,供评审。括号标注去对应章节深读。

### 21.1 一句话概括
知识库有**两条进化轨道**: 轨道一让**代码与文档**随开发全自动保持最新;轨道二让**决策与经验**随开发不断沉淀、审核、新陈代谢——二者都按**项目维度**独立运作,并在 Web 上**可观测、可编辑、可回滚**。

### 21.2 进化闭环全景图
```
                         ┌───────────────── 开发活动 ─────────────────┐
                         │  编辑文件 · git commit · 调试修复 · AI 会话  │
                         └───────┬───────────────────────┬────────────┘
                                 │                       │
                    ┌────────────▼───────┐   ┌───────────▼─────────────────┐
                    │ 轨道一: 代码/文档   │   │ 轨道二: 决策/经验沉淀         │
                    │ (全自动, 可靠)      │   │ (半自动 + 全自动+AI审核)      │
                    └────────┬───────────┘   └──────┬──────────────┬───────┘
                             │                      │ L2a 半自动    │ L2b 全自动
          ┌──────────────────▼───────┐              │ save_insight  │ Extractor 提炼
          │ Trigger: git hook/定时/   │              │ (直接入库)     │   ↓ Draft
          │ 文件变更 (设计说明)        │              │               │ ReviewGate
          └──────────────────┬───────┘              │               │ AI 审核闸门
          ┌──────────────────▼───────┐ │ │ （设计说明）
          │ 双路径调度 （设计说明）: │ │ │ ↓ 通过
          │ 批量全量 / 在线队列        │              │               │
          └──────────────────┬───────┘              │               │
          ┌──────────────────▼───────┐              │               │
          │ 双哈希判定 （设计说明）: │ │ │
          │ 内容变→重嵌入 / 仅元变→   │              │               │
          │ 只更元数据 / 未变→跳过     │              │               │
          └──────────────────┬───────┘              │               │
                             ▼                      ▼               ▼
                    ┌─────────────────────────────────────────────────────┐
                    │ 统一 Record 入库 （设计说明）: VectorStore + KeywordIndex │
                    │ 经验带时间有效性/版本 （设计说明）: Active/Superseded... │
                    └───────────────────────┬─────────────────────────────┘
                                            │
            ┌───────────────────────────────┼───────────────────────────────┐
            ▼                               ▼                                ▼
   空闲巩固 （设计说明）: 跨模型自动重嵌入 （设计说明）: Web 可观测/编辑 (设计说明):
   去重·聚类·过期检测              换模型→影子重建→原子切换          Dashboard·结构化浏览·Review 收件箱
```

### 21.3 顺读路径(按"发生顺序"读)
1. **什么时候触发** → 设计说明 自进化流程 + 设计说明 项目独立回路(每个项目有自己的 hook/调度)。
2. **怎么调度** → 设计说明 双路径: 首次/手动走批量,开发中的变更走在线队列。
3. **怎么省算力地更新** → 设计说明 双哈希: 只对真正变的内容重嵌入。
4. **经验怎么进来** → 设计说明 两通道:
   - 设计说明 L2a 半自动: `save_insight` 直接入(设计说明 工具, 设计说明 项目维度)。
   - 设计说明中的 L2b 全自动: 设计说明里的管道 Extractor→Draft→ReviewGate(AI 审核)→入库;硬约束见设计说明。
5. **进来后长什么样** → 设计说明 统一 Record + 设计说明 时间有效性(决策会 Superseded, 不删除)。
6. **怎么保持健康** → 设计说明 空闲巩固(去重/聚类/标记过期)。
7. **换模型怎么办** → 设计说明 自动重嵌入迁移(不中断检索)。
8. **人怎么看/改/收回** → 设计说明 结构化浏览与编辑 + 设计说明 Review 收件箱 + 设计说明 可回滚。
9. **按项目怎么收口** → 设计说明 项目生命周期 + 设计说明 Dashboard 项目视角。

### 21.4 一张"谁触发谁"的责任表
| 阶段 | 组件(trait) | 章节 |
|---|---|---|
| 捕获事件 | `EvolutionTrigger` | 设计说明 |
| 加载内容 | `Loader` | 设计说明 |
| 分块 | `Chunker` | 设计说明 |
| 判定增量 | IndexService(双哈希) | 设计说明 |
| 向量化 | `Embedder` | 设计说明 |
| 存储/检索 | `VectorStore` + `KeywordIndex` | 设计说明 |
| 自动提炼经验 | `EvolutionExtractor` | 设计说明 |
| AI 审核闸门 | `ReviewGate` | 设计说明 |
| 巩固/过期 | 巩固任务(EvolutionTrigger 家族) | 设计说明 |
| 重嵌入迁移 | IndexService + MigrationTrigger | 设计说明 |

### 21.5 评审聚焦建议
- **可靠性边界**: 轨道一(代码/文档)是确定性的,放心;轨道二 L2b 是 LLM 驱动的,重点看 设计说明的六道防线是否满足你对"不污染库"的要求。
- **成本**: L2b 默认关闭,按项目/按 commit 类型开启(设计说明),评估是否符合预期。
- **可控性**: 所有自动产物都可在 Web 复审、编辑、回滚(设计说明),确认人工兜底够不够。

---

## 22. 智能化检索能力(借鉴 Anthropic / Sourcegraph Cody / 前沿 RAG)

> 来源: Anthropic Contextual Retrieval、Sourcegraph Cody(Agentic Context Fetching / symf)、2025-2026 高级 RAG 研究(带 benchmark)。
> 原则: 以**证据驱动**选型,高性价比默认启用,进阶能力可选开关;每项都落到既有/新增 trait,保持插拔。

### 22.1 能力清单与优先级
| # | 能力 | 实测收益(来源) | 默认 | 对应组件 |
|---|---|---|---|---|
| 1 | **Contextual Retrieval**(上下文增强分块) | 检索失败 **-67%**(Anthropic, 配合重排) | **开** | Chunker/Enricher |
| 2 | **Cross-encoder 重排** | 准确率 **+33%**(8 基准均值) | **开** | `Reranker`（设计说明） |
| 3 | **查询智能化**(HyDE / Self-query / 多查询) | 覆盖措辞差异与复杂查询 | **开**(轻量项) | 新 `QueryTransformer` |
| 4 | **Agentic 深度检索**(多轮自主取数) | 复杂问题质量提升(Cody) | 可选 | MCP 工具 + SearchService |
| 5 | **Self-RAG 自评 + 引用校验** | 降幻觉、过滤低相关 | 可选 | SearchService |
| 6 | **RAPTOR 层级摘要** | 长文档/全局查询更全面 | 可选 | 新 `Summarizer` + 索引 |
| 7 | **sentence-window 自适应粒度** | 命中小块、返回全上下文 | **开** | Retriever 后处理 |
| 8 | **使用反馈学习**(越用越准) | 轻量在线排序校准 | 可选 | 新 `FeedbackStore` |

> 不采纳: 完整 GraphRAG(延迟 **2.3x**、单机收益不匹配),以 设计说明 轻量关系替代。

### 22.2 第一梯队(默认启用,证据最硬)

**#1 Contextual Retrieval — 最推荐**
- 每个 chunk 入库前,用 LLM 生成一句"它在所属文件/项目中的作用"的上下文前缀,与原文**一起**嵌入与建 BM25。
- 代码尤其受益: 一个函数脱离文件会丢失语义(调用方、所属模块、意图),前缀补回它。
- 实现为一种 **Enricher skill**（设计说明）或 Chunker 后处理;前缀生成结果随 content_hash 缓存（设计说明）,不重复花 LLM。

**#2 Cross-encoder 重排 — 开箱即用**
- 把 设计说明 `Reranker` 默认实现从 `Noop` 换成 `CrossEncoderReranker`(FastEmbed 支持本地 rerank 模型)。
- 流程: hybrid 召回 TopN(如 50)→ cross-encoder 精排 → 取 TopK(如 8)。本地模型,低成本。

**#3 查询智能化 `QueryTransformer`(新 trait)**
```rust
#[async_trait]
pub trait QueryTransformer: Send + Sync {
    async fn transform(&self, q: &str, ctx: &QueryCtx) -> Result<TransformedQuery>;
    // 产出: 改写后的多条子查询 + 抽取出的元数据过滤条件
}
```
- **HyDE**: LLM 生成假设答案,用其向量检索(解决问/答措辞不一致)。
- **Self-query**: 从自然语言解析过滤(如"上月 auth 决策"→ `kind=insight ∧ topic=auth ∧ time>…`)。
- **多查询扩展**: 一问改写为多个变体并检索,结果用 RRF 合并(复用 设计说明 融合)。
- 轻量项(改写/抽取)默认开;需 LLM 的 HyDE 可按需开。

### 22.3 第二梯队(进阶,可选开关)

**#4 Agentic 深度检索(呼应 Cody Agentic Context Fetching)**
- MCP 增加 `deep_search` 模式: SearchService 先检索 → 自评是否充分 → 不足则自动追加检索 / 沿 设计说明的关系做一跳扩展 / 换查询再检索 → 汇总。
- 多轮更贵,默认关闭;适合"解释整个模块""跨文件追因"这类复杂问题。

**#5 Self-RAG 自评 + 引用校验**
- 对检索结果打相关性分,低于阈值丢弃或触发重查。
- 返回强制带**出处引用**(文件+行号 / URL / commit),便于核实、降幻觉。

**#6 RAPTOR 层级摘要**
- 对大项目/长文档: 自底向上聚类 + 逐层 LLM 摘要,形成多粒度节点。
- 检索按需命中: 要细节命中叶子 chunk,要全局命中高层摘要。
- 作为一种索引增强(新 `Summarizer` trait + 额外摘要 Record),默认关,适合"外部资料/长文档"。

### 22.4 第三梯队(锦上添花)

**#7 sentence-window 自适应粒度(默认开)**
- 向量命中以小片段为单位(精准),但返回给 AI 时自动附带上下文窗口(前后几行 / 完整函数 / 所在小节),兼顾精准与完整。纯后处理,低成本。

**#8 使用反馈学习(默认关)**
- 记录检索结果是否被 AI 实际采用,或你在 Web 标注"有用/无用"。
- `FeedbackStore` 累积信号,对排序做轻量校准(如调整某来源/某 kind 的权重)。
- 让知识库**越用越准**——是检索层面的另一种"自进化"。

### 22.5 检索链整合(更新检索链)
```
query
 → QueryTransformer (#3: HyDE/self-query/多查询)
 → hybrid 召回: 向量(含 #1 上下文增强嵌入) + BM25 → RRF
 → Reranker (#2: cross-encoder 精排)
 → Self-RAG 相关性过滤 (#5, 可选)
 → sentence-window 扩上下文 (#7)
 → [Agentic: 不足则回到召回再来一轮 (#4, 可选)]
 → TopK(带引用出处) → 反馈回流 (#8, 可选)
```

### 22.6 对既有章节的影响
- 设计说明: 新增 `QueryTransformer` / `Summarizer` / `FeedbackStore` trait;`Reranker` 默认实现升级;Contextual 作为 Enricher skill。
- 设计说明: 检索链按设计说明的扩展。
- 设计说明: Playground 显示各阶段(改写/召回/重排/自评)贡献;支持结果"有用/无用"标注(#8)。
- 设计说明: Contextual Retrieval 与 Summarizer 可作为可插拔 skill。
- 成本: 默认开的项均为本地模型或轻量 LLM 调用;重 LLM 的项(HyDE/Agentic/RAPTOR/Self-RAG)默认关,按需启用。

---

## 23. 统一能力层 + Web AI 管家(对话式优化知识库)

> 对应诉求: "把整个项目封装成能力,Web 管理端加 AI 对话,让 AI 调这些能力来优化知识库"。
> 核心: 一套**统一能力层(Capability/Tool 层)**对内对外复用;Web 端内嵌一个**会话式 AI 管家**,经可配置外部 LLM 做 tool-calling,**能读能写能治理**,写操作带确认闸门与回滚。

### 23.1 统一能力层(Capability Registry)
把整个项目的能力封装成一组标准化 **Tool**(统一的 name / JSON schema / 权限标签 / 审计),作为**唯一事实来源**:
```rust
pub struct Capability {
    name: String,                 // "search_knowledge" / "merge_insights" / "reindex_project"...
    input_schema: JsonSchema,
    permission: Permission,       // Read | Write | Govern | Admin
    side_effect: bool,            // 是否改动数据/配置(决定是否走确认闸门)
    handler: Arc<dyn CapabilityHandler>,
}

#[async_trait]
pub trait CapabilityHandler: Send + Sync {
    async fn invoke(&self, args: Value, ctx: &CallCtx) -> Result<Value>;
}
```
- **三个消费面共享同一注册表**:
  - **MCP 层**（设计说明）: 只暴露 `Read` + 受限 `Write`(search/save_insight/reindex 等),给外部 AI 工具。
  - **REST 层**（设计说明）: Web UI 直接按钮调用。
  - **Web AI 管家**（设计说明）: 可调 `Read/Write/Govern`,`Admin` 需显式开启。
- 新增一个能力 = 注册一个 `Capability`,三个面自动可用(按权限过滤)。这就是"项目能力封装"的落点。

### 23.2 Web AI 管家(会话式 Agent)
- Web 管理端新增 **"AI 管家"对话页**: 自然语言对话 → 管家用外部 LLM 的 tool-calling 规划并调用能力层 → 执行并回话。
- **模型来源**(已定): 可配置外部 LLM API(OpenAI / Claude / 阿里百炼等),API Key 存系统钥匙串或数据目录受保护文件(参照 codeg 做法),插拔可换。
- **能做什么(读/写/治理一体)**:
  - 读: "proj-A 里关于鉴权的决策有哪些?""哪些 insight 最近没被用过?"
  - 写: "把这三条重复的经验合并""给所有数据库相关条目打上 db 标签""把这条过期决策标记 superseded"
  - 治理: "扫一遍 _global 去重""对 proj-B 跑一次巩固""重嵌入 proj-A 到新模型"(触发 设计说明)
  - 分析建议: "评估当前知识库质量,给出优化清单"(基于统计 + 设计说明 反馈信号)

### 23.3 写操作的安全闸门(全能但可控)
借鉴本工具自身"低风险直接做 / 高风险先确认"的分级:
```
管家决定调用某能力
   ├─ permission=Read 或 无 side_effect  → 直接执行
   └─ Write/Govern/Admin 或 side_effect  → 生成"变更预案"(diff 预览)
            → Web 卡片请用户确认 ──同意──► 执行(进 设计说明 队列串行)
                                 └─拒绝──► 放弃
```
- **预案(dry-run)**: 写操作先产出"将影响 N 条、具体 diff",用户确认后才落。
- **可回滚**: 每次管家发起的变更打成一个**批次**,Web 可一键撤回(复用 设计说明 回滚)。
- **审计**: 每次能力调用记录(谁/何时/入参/结果/批次),Web "审计日志"可查。
- **鉴权**: 管家页与写能力受 设计说明里的鉴权保护;`Admin` 类(删 collection、改监听地址)默认需二次确认。

### 23.4 治理能力清单(让"对话优化知识库"闭环)
把已有机制封装为管家可调的 `Govern` 能力:
| 能力 | 作用 | 底层 |
|---|---|---|
| `dedup_insights` | 近似去重合并 | 设计说明的巩固 |
| `consolidate_project` | 聚类归纳某项目经验 | 设计说明 |
| `mark_stale` / `supersede` | 标记过期 / 决策演进 | 设计说明 |
| `retag` / `edit_item` | 批量改标签 / 改正文(触发重嵌入) | 设计说明 |
| `review_drafts` | 批量复审自动提炼草稿 | 设计说明 |
| `reindex` / `migrate_model` | 重索引 / 跨模型重嵌入 | 设计说明 |
| `tune_retrieval` | 按反馈调排序/融合参数 | 设计说明 |
| `quality_report` | 产出质量评估与优化建议 | 统计 + 设计说明 |

### 23.5 架构位置(保持分层不乱)
```
          Web "AI 管家"对话页 (Vue3)
                   │ REST/WS
                   ▼
   ┌──────────────────────────────────────┐
   │ AgentOrchestrator (管家编排)           │
   │  外部 LLM(可配) + tool-calling 循环    │
   │ + 确认闸门 + 批次/审计 （设计说明） │
   └───────────────┬──────────────────────┘
                   ▼  只调能力层,不碰适配器
   ┌──────────────────────────────────────┐
   │ Capability Registry (统一能力层)       │
   │  = 封装的项目能力, 带权限/schema/审计   │
   └───────────────┬──────────────────────┘
                   ▼
            kb-core Service (设计说明 应用服务层)
                   ▼
            trait 端口 ← 适配器 （设计说明）
```
- 管家是**接入层**的一部分,**只调能力层/Service**,不越层碰适配器——与 设计说明 分层一致。
- MCP 层与管家是**平级**的两个消费面,共享能力层,互不耦合。

### 23.6 对既有章节的影响
- 设计说明: 接入层新增 "Web AI 管家";新增 "Capability Registry" 居于接入层与服务层之间。
- 设计说明: MCP/REST 工具改为**从统一能力层派生**(按权限过滤),不再各写一套。
- 设计说明: 新增 `CapabilityHandler`、`AgentOrchestrator`(编排)、`ChatModel`(外部 LLM 适配,插拔)等 trait。
- 设计说明: 管家写能力纳入鉴权;新增审计日志。
- 设计说明: Web 新增 "AI 管家" 页与 "审计/批次回滚" 视图。
- 设计说明: 治理与反馈能力作为管家可调工具暴露,形成"对话即可优化知识库"的闭环。

---

> 决策已全部收敛。评审通过后，我将据此进入实现阶段(任务 #1~#8)。
