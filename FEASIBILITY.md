# 技术可行性分析报告 (FEASIBILITY.md)

> 对象: `ARCHITECTURE.md`(§0–§23)
> 日期: 2026-10-19
> 方法: 源码级核实 crate API + 本机编译验证 + 本机实测(embedding / 重排 / 全文检索 / 核显)
> 说明: 本报告是架构评审阶段的历史记录,结论与数字反映当时的依赖版本与本机环境;后续实现若有差异,以代码和 `ARCHITECTURE.md` 为准。

---

## 0. 结论摘要

**总体结论: 可行。** 架构的主体(Rust 守护进程 + LanceDB + FastEmbed + tree-sitter + MCP + axum/Vue3)所需依赖已在本机**一起编译通过并实际跑通**。但有 **19 处需要修正**,其中 6 处会改变实现方式:

| # | 修正 | 原因(实测/核实结果) |
|---|---|---|
| C1 | **去掉独立 Tantivy,改用 LanceDB 内置全文检索 + jieba 中文分词** | LanceDB 0.40 自带 BM25 倒排索引,jieba 分词实测中文全部命中;还原生支持"向量+全文"混合查询并自动 RRF 融合。少一套存储、少一致性问题 |
| C2 | **去掉自定义 JSON-RPC 进程间协议(kb-ipc)** | 守护进程用同一套 HTTP 路由同时监听 `127.0.0.1` 端口和本地 Unix socket;MCP 桥接、CLI 都走 Unix socket 上的 REST。少一个协议、少一个 crate |
| C3 | **§17 换模型迁移不能靠表改名** | 实测 LanceDB 开源版 `rename_table` 直接报 "not supported in LanceDB OSS"。改为 SQLite 里维护"逻辑名→物理表"别名映射 |
| C4 | **重排默认不能全开** | CPU 上重排 50 条候选要 13 秒(jina)到 42 秒(bge),无法交互。只有核显可用时才默认开启(20 条×400 字,约 2.2 秒) |
| C5 | **"守护进程只占几十 MB 内存"不成立** | BGE-M3 常驻实测峰值 5.3–8.3GB。需要按需加载 + 空闲卸载 + 小批量 |
| C6 | **"代码不出本机"与云端 LLM 功能冲突** | §20 自动提炼、§22 上下文增强、§23 AI 管家都会把代码发给 DeepSeek。必须按项目显式授权 + 脱敏 |

其余 13 处见 §4 修正清单。

**最大的工程风险是首次全量索引的耗时**,不是技术能不能做。实测 BGE-M3 在 CPU 上约 1.8 块/秒;本机最大的项目 `sampleproj` 过滤后约 6.9 万个块,CPU 要约 10 小时,核显约 5 小时。所以设计上必须做到可中断续跑、按优先级索引、严格过滤。

---

## 1. 调研方法与环境

### 1.1 本机环境(已核实)
| 项 | 结果 |
|---|---|
| CPU | i5-13500H,16 线程,支持 AVX2(不支持 AVX-512) |
| 内存 / 磁盘 | 62GB(可用约 50GB) / 剩余 176GB;`/tmp` 是占用内存的 tmpfs(32GB) |
| GPU | 无 NVIDIA 独显;**Intel Iris Xe 核显**,i915 驱动,已装 `mesa-vulkan-drivers` 25.0.7,`vulkaninfo` 能识别,llama.cpp 报告 32GB 共享显存 |
| 工具链 | Rust 1.99.1、protoc 3.21.12、cc 14.2、pkg-config、libssl-dev;**没装 g++**(链接需要 `libstdc++.so`) |
| Node | v22.23.2 / npm 10.9.8 |
| inotify | `max_user_watches=524288`,够用 |

### 1.2 网络(已实测,影响开发和运行配置)
| 目标 | 走代理 `127.0.0.1:17890` | 直连 |
|---|---|---|
| huggingface.co API | 可用(每次 TLS 握手约 5.5 秒) | **不通** |
| HF 文件 CDN `*.hf.co` | 1–2 MB/s | **21.6 MB/s 单连接,8 并发 60.8 MB/s** |
| hf-mirror.com | 可用 | 可用,但 **fastembed 走它下载会报 "Content-Range missing" 失败** |
| crates.io / static.crates.io | 慢(约 6 秒/请求) | **快** |
| npm / npmmirror / rsproxy | 慢 / npmmirror 不通 | **快** |
| github.com / api.github.com | 可用 | 不通 |
| release-assets.githubusercontent.com | 0.7 MB/s | 4.9 MB/s |
| api.deepseek.com | 可用 | 可用 |

**结论:** 模型下载的可用组合是 **不设 `HF_ENDPOINT` + `NO_PROXY=.hf.co`**(API 走代理,大文件直连 CDN)。依赖下载建议 crates.io / npm 直连。

### 1.3 验证产物(可复用)
| 路径 | 内容 |
|---|---|
| `/tmp/kb-spike/src/main.rs` | LanceDB 五种分词器对比、混合查询、merge_insert、update、optimize、rename_table、tantivy-jieba、tree-sitter;全部依赖一起编译 |
| `/tmp/kb-rmcp/src/main.rs` | rmcp 3.5.1 stdio 服务端,initialize / tools/list / tools/call 端到端跑通 |
| `/tmp/kb-bench/src/main.rs` | fastembed 各模型吞吐 / 延迟 / 内存 / 质量抽查 |
| `/tmp/llama/bench.py` | llama.cpp HTTP embedding / rerank 基准 |
| `~/.cache/kb-models/` | 已下载模型 9.7GB(BGE-M3 fp32/int8、MiniLM、jina/bge 重排、GGUF) |

> 以下是验证阶段使用的临时工程(未随仓库发布);可复现的检查已并入各 crate 的测试。

---

## 2. 实测数据汇总

### 2.1 Embedding(语料: 250 个 Rust 代码块 + 98 个中文架构文档块,平均 921 字符;16 线程)
| 后端 / 模型 | 加载 | 吞吐 | 查询 p50 | 峰值内存 | 质量 |
|---|---|---|---|---|---|
| fastembed **BGE-M3 int8**(`Bgem3Embedding` + `BGEM3Q`,570MB) | 43s | **1.8 块/s** | 15ms | 8.3GB(batch 32) | 优 |
| fastembed BGE-M3 fp32(`EmbeddingModel::BGEM3`,2.27GB) | 57s | 1.3 块/s | 36ms | 5.3GB | 优(与 int8 前 3 名一致) |
| fastembed 多语言 MiniLM-L12 | 42s | 11.9 块/s | 4.5ms | 3.1GB | **明显差**(中文问题常排到无关章节) |
| **llama.cpp Vulkan 核显 BGE-M3 Q8_0** | — | **3.7 块/s** | 66ms | 进程约 0.3GB + 共享显存 | 优(相似度与 fp32 相差不到 0.002) |
| llama.cpp Vulkan BGE-M3 FP16 | — | 1.9 块/s | 99ms | — | 优 |
| llama.cpp CPU BGE-M3 Q8_0 | — | 0.8 块/s | 38ms | — | 优 |

补充: BGE-M3 fp32 下,约 800 字符的输入为 1.5 条/秒,约 3200 字符为 1.1 条/秒,也就是**长输入的每字符成本反而更低**。原因是同一批次按最长文本补齐(padding)。按长度排序后再分批可以减少浪费,预计有明显收益(未实测)。

### 2.2 重排(1 个查询 × N 个候选)
| 后端 / 模型 | 50 条全文 | 20 条 × 400 字 | 10 条 × 400 字 | 20 条 × 800 字 |
|---|---|---|---|---|
| fastembed CPU jina-reranker-v2-multilingual | 13.0s | — | — | — |
| fastembed CPU bge-reranker-v2-m3 | 42.2s | — | — | — |
| **llama.cpp Vulkan 核显 bge-reranker-v2-m3 Q8_0** | 16.2s | **2.2s** | **1.2s** | 3.3s |

### 2.3 LanceDB 0.40 内置全文检索的分词器对比(5 条中英文/代码混合文档)
| 分词器 | 中文词(增量索引/套接字/知识共享) | `content`→`content_hash` | `embed`→`embedQuery` | 误命中 |
|---|---|---|---|---|
| simple(默认) | ✗ 全不命中 | ✓ | ✗ | 无 |
| icu(内置) | ✓ | ✗ | ✗ | 无 |
| **jieba/default**(需词典文件) | ✓ | ✓ | ✗ | 无 |
| ngram(2–3) | ✓ | ✓ | ✓ | **有**(content_hash 同时命中无关文档) |
| code | ✗ | ✓ | ✗ | 无 |

另外实测: 建好索引后**新追加或更新的行能立即被全文检索命中**(未索引部分走扫描),`optimize()` 之后会并入索引(未索引行数 2→0)。混合查询(全文 + 向量)可用,返回 `_relevance_score` 列。`merge_insert`(upsert)、`update().only_if()`、`delete` 都可用。

**结论:** 用 jieba。驼峰式标识符(`embedQuery`)要额外拆分(见 C1 的 `lex` 列)。

### 2.4 编译
| 项 | 结果 |
|---|---|
| 依赖数 | 891 个 crate,其中 92 个有多版本(jieba-rs 0.10/0.11、reqwest 0.12/0.13);**arrow、tantivy 没有重复** |
| 冷编译 release | 约 25–35 分钟(lancedb 带进完整的 datafusion / arrow / lance) |
| 增量编译 release | 只改业务代码约 10 秒;加一个依赖约 5 分钟 |
| target 目录 / 二进制 | 8.8GB / 336MB(strip 后 242MB) |
| 链接 | 必须有 `libstdc++.so`:需执行 `apt-get install g++` |
| 运行时下载 | fastembed(ort)首次构建时会下载 onnxruntime 二进制,经代理成功 |
| rusqlite 0.40.2(bundled) | 能和 lancedb 一起编译 |

---

## 3. 逐章可行性

图例: ✅ 可行 / 🟡 有条件可行(需按建议实现) / 🔧 需修正设计

### §0 总览、§21 导读线 — ✅
纯导航章节。修正项落地后需同步更新文字。

### §1 设计目标与约束 — 🔧
- 功能目标(多项目、隔离 + 共享、自进化、MCP、Web)都可实现。
- **§1.3 "低内存"需修正(C5):** 守护进程空载约几十 MB 成立;一旦加载 BGE-M3 就是 2–8GB。改为"模型按需加载,空闲 N 分钟后卸载;批大小 8;单块上限 512 token"。
- **§1.3 "代码不出本机"需修正(C6):** 只有本地功能(索引、检索、本地重排)满足。云端 LLM 功能要按项目开关,默认关闭。

### §2 分层架构 — ✅
依赖倒置可以用 crate 边界强制。建议进一步拆 crate,把重依赖隔离开:`kb-core` 不依赖 lancedb / fastembed,单元测试几秒就能编完(C16)。

### §3 插拔式组件 — 🟡
| trait | 默认实现 | 可行性 | 要点 |
|---|---|---|---|
| Embedder | fastembed BGE-M3 int8;可选 HTTP(llama.cpp / Ollama / 云端,OpenAI 兼容 `/v1/embeddings`) | ✅ | fastembed 的 `embed(&mut self)` 是同步阻塞调用,**必须放在专用工作线程里**,通过 channel 收发(actor 模式),不能在 tokio 线程里直接调 |
| VectorStore | LanceDB 0.40 | ✅ | 依赖 arrow **58**(不是 60);别名映射见 C3;向量索引在数据量超过阈值后再建(C18) |
| KeywordIndex | **LanceDB 全文检索(jieba)** | 🔧 C1 | trait 保留;Tantivy 改为可选、MVP 不实现 |
| Chunker | 自研 tree-sitter AST 分块 + Markdown 标题分块 + 定长窗口兜底 | ✅ | grammar 版本已核对能一起编译(rust 0.24 / python 0.25 / js 0.25 / ts 0.23 / go 0.25 / java 0.23 / c 0.24 / cpp 0.23);实际解析只测了 Rust |
| Loader | 文件(ignore 0.4,遵守 .gitignore)、Markdown(pulldown-cmark 0.13)、网页(reqwest + scraper / html2text)、PDF(pdf-extract 0.12) | 🟡 | PDF 提取质量因文件而异,放到后期 |
| Reranker | 默认 Noop;核显可用时用 llama.cpp `/v1/rerank` | 🔧 C4 | CPU 重排太慢 |
| EvolutionTrigger | git hooks / notify 8.2 文件监听 / 定时任务 / 手动 | ✅ | notify 9 还是 rc,锁 8.2 |
| 注册表 | 按配置名构造实现 | ✅ | 用 `HashMap<&str, Factory>`,不需要动态加载库 |

### §4 核心数据流 — ✅
- 双哈希用 xxh3(xxhash-rust),已编译。
- 混合检索直接用 LanceDB 原生查询:单个 collection 内由 LanceDB 做 RRF;跨 collection(项目 + `_global`)由服务层再做一次 RRF。
- 新写入的数据立即可被检索(已实测),在线增量链路成立。

### §5 接口设计 — 🟡
- **MCP:** rmcp 3.5.1 的 stdio 服务端已端到端验证。3.x 的 API 与网上旧教程不同:`ContentBlock::text`(不是 `Content::text`)、`ServerConfig`(`ServerInfo` 已弃用)、`handler::server::router::tool::ToolRouter`、`handler::server::wrapper::Parameters`,并且必须声明 tools capability。
- 各客户端接入方式(已核实):
  - Kiro CLI: `~/.kiro/settings/mcp.json` 或 agent JSON 的 `mcpServers`,支持 stdio(`command`)与 HTTP(`url` + `headers`)。
  - Claude Code: `claude mcp add`,支持 stdio 与 `--transport http`。
  - Codex: `~/.codex/config.toml` 的 `[mcp_servers.x]`,支持 stdio 与 streamable HTTP(`url` + `bearer_token_env_var`)。
  - Cursor / Gemini CLI: **本次未调研**。
- REST/WS: axum 0.8 的 ws feature 已编译;axum 能直接监听 `tokio::net::UnixListener`(源码已核实)。

### §6 隔离与存储 — 🟡
- LanceDB 每个 collection 一张表,可行。
- `meta.db` 用 **SQLite(rusqlite bundled,已编译)** 存关系型元数据:collection、别名、文件指纹、任务、草稿、审计、会话、令牌、反馈、关系边。向量和正文只放 LanceDB。
- 配置从 YAML 改为 **TOML**(C8):serde_yaml 已停止维护,toml 0.9 已验证。

### §7 Web 管理界面 — ✅
- 前端版本(npm 已查):vue 3.5.44、vite 8.3.4、vue-router 5.4.0、pinia 4.1.0、naive-ui 2.45.3、md-editor-v3 7.1.0、echarts 6.1.0。
- TypeScript 建议**锁 5.9.3**:最新 7.0.2 是原生重写版,vue-tsc 3.3.13 只声明 `>=5.0.0`,对 7.x 的兼容性未验证。
- 构建产物用 rust-embed 8 打进二进制,SPA 路由由 axum 回退到 `index.html`。

### §8 技术选型表 — 🔧
按 C1 / C4 / C8 / C11 更新。

### §9 目录结构 — 🔧 C16
改为单一二进制 `kb`(子命令 `daemon` / `mcp` / `reindex` / …),代码按 crate 拆分。原来的 kb-ipc 删除(C2)。

### §10 风险 / §11 决策清单 — ✅
已收敛;新风险见本文 §5。

### §12 进程模型 — 🔧 C2
- 守护进程常驻的思路成立。实现改为:**一个 axum Router,同时 serve 两个监听**:
  - TCP `127.0.0.1:7878`:Web UI、REST、WS,以及可选的 `/mcp`(streamable HTTP),需要 session / Bearer 鉴权;
  - Unix socket `~/.kb/run/kb.sock`(权限 0600):给 CLI、`kb mcp` 桥接和 hook 用,文件权限就是鉴权。
- `kb mcp` 桥接 = rmcp stdio 服务端,启动时从守护进程拉取能力列表(JSON Schema),工具调用转发到 `POST /api/v1/capabilities/{name}`。写法是手写 `ServerHandler` 的 `get_info` / `list_tools` / `call_tool`(不用宏):用 `Tool::new_with_raw` 构造工具,`call_tool` 返回 `CallToolResult::success(..).into()`(3.5.1 的返回类型是 `CallToolResponse`),`get_info` 用 `ServerCapabilities::builder().enable_tools()` 声明 tools capability。**已编译并端到端验证**(见 `crates/kb-acp/tests/stdio.rs`;未知工具返回 -32602)。注意:用宏写法时 initialize 返回的 `capabilities` 是空的 `{}`,所以必须显式声明 tools capability。
- 守护进程没在运行时,`kb mcp` 自动在后台拉起它(带文件锁防止重复启动)。
- 生命周期:`kb service install` 生成 systemd unit。

### §13 图示 — ✅
按 C1 / C2 更新(去掉 Tantivy 和 IPC 方框)。

### §14 演进优化 — 🟡
| 小节 | 结论 |
|---|---|
| 14.1 双哈希 | ✅ xxh3;另需第三个哈希 `embed_input_hash`,覆盖"结构化上下文头"变化(C9) |
| 14.2 双路径 | ✅ 一个优先级任务队列(在线 > 批量),单写者串行写 LanceDB;批量任务可续跑(按文件记录检查点) |
| 14.3 时间有效性 | ✅ 记录在 SQLite;LanceDB 冗余存 `status` 列用于过滤 |
| 14.4 统一 Record | ✅ 见 `ARCHITECTURE.md` §14.4 的 Arrow schema |
| 14.5 轻量关系 | ✅ SQLite `edges` 表;一跳扩展 = 查询命中后补查边 |
| 14.6 巩固 | 🟡 去重不需要 LLM(向量相似度 > 0.92 判为疑似重复,进待审);聚类 / 归纳需要 LLM,受 C6 约束 |
| 14.7 黄金集 | ✅ `kb eval` 命令计算 hit@k / MRR |
| 14.8 不采纳 | ✅ 维持 |

### §15 Web 鉴权 — 🟡 C11
- argon2 0.6 已编译。建议**自己实现最小会话**(SQLite 存会话表 + HttpOnly / SameSite=Strict cookie + Origin 校验 + 写操作要求带 `X-KB-CSRF` 请求头),不用 tower-sessions,依赖更少,重启后会话不丢。
- Bearer 令牌只存 sha256 哈希。登录做限速。
- 与 codeg 对齐:codeg 服务器版把密钥放在数据目录的 `tokens.json`(其 README 写明),本方案同理用 `~/.kb/secrets.toml`(0600)。
- keyring crate 依赖 D-Bus Secret Service,无桌面环境的服务器上通常没有,**不用**(C15)。

### §16 结构化查看与编辑 — ✅
- 单条编辑后重嵌入约 0.5–1 秒(CPU),可以同步等结果。
- 乐观锁用 `version` 字段。
- Markdown 编辑器用 md-editor-v3。

### §17 跨模型自动重嵌入 — 🔧 C3
- 物理表命名 `{collection}__{embedder_slug}__v{n}`,SQLite 的 `collections.active_table` 指向当前表。迁移在新表里完成、校验条数一致后,在一个 SQLite 事务里切换指针,旧表延迟删除。
- **耗时必须告知用户:** 1 万个块约 93 分钟(CPU)/ 45 分钟(核显)。迁移要能续跑,UI 显示预计剩余时间。
- 同一模型换后端(fastembed int8 ↔ llama.cpp Q8_0):向量差异很小(相似度差约 0.001),允许配置 `compat_group` 免迁移。**建议用黄金集确认后再启用。**

### §18 项目式自动进化 — 🟡
- git hook **不要用全局 `core.hooksPath`**(会覆盖 husky 等仓库自带的 hook)。改为在每个仓库安装链式 hook:原有 hook 改名为 `*.kb-orig`,新 hook 先调用它,再异步通知守护进程(C13)。
- hook 只做"投递事件",用 `curl --unix-socket` 发出后立即返回,目标不超过 100ms,守护进程没运行时静默忽略。
- 用到的事件:post-commit、post-merge、post-checkout、post-rewrite;文件监听补未提交的改动(去抖 2 秒)。
- 规模(C12):`sampleproj` 约 69k 块,`local-trees` 约 10k,`devkit` 约 6.6k,`SampleApp` 约 1.3k(按 git 跟踪文件、排除 >200KB 文件和压缩产物估算)。

### §19 借鉴 codeg — 🟡
- 19.1 skills:默认只支持**声明式**(提示词模板、include/exclude 规则、loader 参数);能执行脚本的 skill 必须显式开启,以子进程运行并设超时(C14),放在最后阶段。
- 19.2 多形态:Docker 镜像要使用核显,需挂载 `/dev/dri`;放在最后阶段。
- 19.3 热重载:notify 监听 `config.toml`;能热更新的项立即生效,涉及模型的项走 §17 迁移。

### §20 开发过程自动进化 — 🟡
- **事件源(已核实):**
  - git:用 git2 0.21 读取 diff。
  - Claude Code:`Stop` / `SessionEnd` 等 hook,输入 JSON 经 stdin 传入,含会话记录路径(具体字段以官方文档为准)。
  - Kiro CLI:agent hooks 的 `stop` 等事件,会话存在 `~/.kiro/sessions/cli/<id>.jsonl`。
  - Codex:会话目录与格式**未核实**。
- **LLM:**
  - DeepSeek:OpenAI 兼容地址 `https://api.deepseek.com`(另有 `/anthropic` 兼容地址);当前模型名 `deepseek-flash`(V4.1-Flash)与 `deepseek-v4-pro`,支持 thinking。
  - genai 0.7 支持 OpenAI / Anthropic / Ollama / 自定义 endpoint,并有 tool use 示例,但它会引入第二份 reqwest(0.13;lancedb/hf-hub 用的是 0.12)。DeepSeek 本身兼容 OpenAI 接口,所以**改为自写 OpenAI 兼容客户端**(reqwest 0.12,约数百行,实现见 `kb-llm` crate)。**本次没有 API key,未做真实调用。**
- 提炼与审核用不同模型(flash 提炼、pro 审核),符合"审核独立"的设计。
- 受 C6 约束:默认关闭,按项目开启,发送前脱敏(密钥正则、`.env*` / `*.pem` 等路径黑名单、diff 截断)。
- token 估算公式:
  - 单次提炼 ≈ min(diff, 8k) + 1k 提示词 → 约 0.5k 输出;
  - 单次审核 ≈ 1.5k 输入 → 约 0.3k 输出。
  - 价格以 https://api-docs.deepseek.com/quick_start/pricing 为准。

### §22 智能化检索 — 🔧
| # | 能力 | 结论 |
|---|---|---|
| 1 | Contextual Retrieval | 🔧 C9:默认用**结构化上下文头**(文件路径 › 模块 › impl › 函数名 / 文档标题路径),零成本、可确定;LLM 生成上下文改为按 collection 开启。估算:每块输入 ≈ 文档 token(若命中前缀缓存则便宜) + 块 token + 约 100 → 约 60 token 输出;6.9 万块的项目约 2–3 亿输入 token,不适合默认开 |
| 2 | Cross-encoder 重排 | 🔧 C4:CPU 默认关;核显可用时默认开(Top20 × 400 字,3 秒预算,超时就退回 RRF 结果) |
| 3 | 查询改写 | 🟡 规则式 self-query(解析 `kind:` / `project:` / 时间)默认开;HyDE / 多查询需 LLM,会增加 1–3 秒,默认关 |
| 4 | Agentic 深度检索 | ✅ 单独的 `deep_search` 能力,走 LLM tool calling |
| 5 | Self-RAG | 🟡 需 LLM,默认关 |
| 6 | RAPTOR | 🟡 成本高,放最后阶段 |
| 7 | sentence-window | ✅ 存 `start_line` / `end_line`,返回时从源文件或相邻块补上下文 |
| 8 | 反馈学习 | 🔧 C10:MCP 无法得知 AI 是否"采用"了结果,改为显式 `kb_feedback` 工具 + Web 标注 |

### §23 统一能力层 + AI 管家 — ✅
- 能力注册表就是 MCP、REST、AI 管家三处共用的工具定义,用 schemars 1.x 生成 JSON Schema(rmcp 3.5.1 已用 schemars 1)。
- AI 管家通过自写的 OpenAI 兼容客户端做 tool calling;写操作先 dry-run 出变更预览,用户确认后执行,并记录批次与审计。
- LLM API key 存放见 C15。

---

## 4. 架构修正清单

| ID | 修正 | 影响章节 |
|---|---|---|
| C1 | BM25 改为 LanceDB 内置全文检索 + jieba;索引建在 `lex` 列(正文 + 拆分后的标识符,如 `embedQuery` → `embed query`);jieba 词典随程序打包,启动时写到 `~/.kb/lang/jieba/default/dict.txt`,并在 `main()` 开头设置 `LANCE_LANGUAGE_MODEL_HOME`(lance 在构建分词器时才读取该变量;测试进程通过 `.cargo/config.toml` 的 `[env]` 提供) | §3.3 §4 §8 §13 |
| C2 | 删除 kb-ipc;同一个 Router 同时监听 TCP 和 Unix socket;`kb mcp` 做 stdio → REST(Unix socket)的桥接;可选原生 `/mcp` streamable HTTP | §5 §9 §12 §13 |
| C3 | 迁移用 SQLite 别名指针,物理表名带版本号 | §6 §17 |
| C4 | 重排随硬件决定,核显 sidecar 可用时才默认开,带 Top-N / 截断 / 时间预算 / 降级 | §3.6 §22 |
| C5 | 模型按需加载、空闲卸载;批大小 8;按长度排序分批;单块上限 512 token | §1.3 §3.1 |
| C6 | 云端 LLM 按项目授权(`allow_cloud_llm`,默认 false);发送前脱敏;记录发送审计 | §1.3 §20 §22 §23 |
| C7 | 新增可选的 llama.cpp Vulkan sidecar(由守护进程拉起的子进程,OpenAI 兼容 HTTP),用于 embedding / 重排加速 | §3.1 §3.6 §19.2 |
| C8 | 配置文件改为 `~/.kb/config.toml` | §6 §19.3 |
| C9 | Contextual Retrieval 默认用结构化上下文头;LLM 上下文按 collection 开启;新增 `embed_input_hash` | §14.1 §22 |
| C10 | 反馈改为显式工具 + Web 标注 | §22 |
| C11 | 自实现最小会话 + CSRF 防护,不用 tower-sessions | §15 |
| C12 | 首次索引:优先级(文档 > 最近修改的代码 > 其余)、检查点续跑、预计剩余时间、过滤(>200KB、压缩产物、lock 文件、生成代码、二进制) | §14.2 §18 |
| C13 | 每个仓库装链式 hook,不碰全局 hooksPath;hook 非阻塞 | §18 |
| C14 | skills 默认声明式,脚本型需显式开启 | §19.1 |
| C15 | 密钥放 `~/.kb/secrets.toml`(0600),不用 keyring | §15 §23 |
| C16 | 单一二进制 + 细分 crate,重依赖隔离 | §9 |
| C17 | 修改环境变量只能在 main 开头、运行时创建前进行(edition 2024 下 `set_var` 是 unsafe) | 实现约束 |
| C18 | 向量索引:行数小于 5 万用暴力扫描;超过后在空闲时建 IVF_HNSW_SQ;定期 `optimize()` | §3.2 §14.6 |
| C19 | LLM 客户端自写(OpenAI 兼容,reqwest 0.12),不引入 genai,避免第二份 HTTP 栈 | §20 §23 |

---

## 5. 风险登记

| ID | 风险 | 可能性 | 影响 | 缓解 | 阶段 |
|---|---|---|---|---|---|
| R1 | 大项目首次索引需数小时 | 高 | 中 | C12;核显 sidecar;续跑;先索引文档 | P2 |
| R2 | 冷编译 25–35 分钟、target 约 9GB,开发迭代慢 | 高 | 中 | crate 拆分;`kb-core` 不依赖重库;开发时用 dev profile 并对依赖开 opt-level 1;**target 不要放在 tmpfs 的 /tmp** | P0 |
| R3 | 常驻内存 5–8GB | 中 | 中 | C5;可切换核显后端(内存占在共享显存中) | P1 |
| R4 | `kb mcp` 动态转发 | **已消除** | — | 写法已验证(`crates/kb-acp/tests/stdio.rs`) | — |
| R5 | LanceDB 在 10 万行以上时的性能、索引构建时间 | 中 | 中 | C18;P3 写基准 | P3 |
| R6 | 云端 LLM 泄露代码或密钥 | 中 | 高 | C6;脱敏单元测试;默认关闭 | 后续 |
| R7 | 自动提炼产生低质量知识 | 中 | 中 | §20 审核闸门;默认关闭;批次可回滚 | 后续 |
| R8 | fastembed / ort 是 rc 版本(ort 2.0.0-rc.15),升级时可能有破坏性变化 | 中 | 低 | 精确锁定 `=` 版本;Embedder trait 隔离 | 全程 |
| R9 | 代理链路慢,导致模型 / 依赖下载失败 | 中 | 低 | §1.2 的 NO_PROXY 组合;模型目录可预置;离线模式 | P1 |
| R10 | 核显驱动 / llama.cpp 版本升级后行为变化 | 低 | 低 | sidecar 可选,随时退回 CPU;锁定 b11748 | P5 |

---

## 6. 未验证事项(实现时需先验证)

1. ~~`kb mcp` 动态工具转发~~ → 已验证。
2. rmcp streamable HTTP server 挂载到 axum Router(feature 存在,未测)。
3. genai 0.7 对 DeepSeek 的真实 tool calling(无 API key)。
4. DeepSeek 上下文缓存的计费细节(定价页未逐项核对)。
5. Codex CLI 会话记录的位置与格式;Cursor / Gemini CLI 的 MCP 配置。
6. Claude Code hook 输入 JSON 的完整字段(文档目录已确认,字段内容抓取被截断)。
7. 除 Rust 以外 grammar 的实际解析效果(都已编译,未跑)。
8. LanceDB 大规模数据下的向量索引性能。
9. 核显上本地对话模型(用于替代云端 LLM)的速度。
10. 按长度排序分批对吞吐的实际收益。
11. `lancedb` 不开 `remote` feature、`fastembed` 关闭 `image-models` 的裁剪编译(spike 用的是带 remote 的配置,裁剪后理论上是子集)。

---

## 7. 参考
- LanceDB 0.40 源码:`lancedb/src/{query.rs,table.rs,connection.rs,rerankers/rrf.rs}`、`lance-index-13.0.0/src/scalar/inverted/tokenizer.rs`
- fastembed 7.1.2 源码:`src/{common.rs,bgem3_embedding,reranking,models}`
- rmcp 3.5.1:https://github.com/modelcontextprotocol/rust-sdk
- Kiro CLI 文档:Agent Configuration / Hooks / Config Hot-Reload / `kiro-cli acp`(会话存储路径)
- Claude Code hooks:https://docs.claude.com/en/docs/claude-code/hooks
- Codex MCP 配置:https://developers.openai.com/codex(第三方指南交叉印证 `bearer_token_env_var`)
- DeepSeek:https://api-docs.deepseek.com/quick_start/pricing
- llama.cpp b11748:https://github.com/ggml-org/llama.cpp/releases/tag/b11748;GGUF:`gpustack/bge-m3-GGUF`、`gpustack/bge-reranker-v2-m3-GGUF`
- Anthropic Contextual Retrieval:https://www.anthropic.com/news/contextual-retrieval
