---
name: knowledgebase
description: 检索团队自托管知识库里的代码、文档与经验。先搜索定位，再按 source 与行号读取原文，引用时带上来源。
---

# KnowledgeBase

这是团队自托管的知识库。它收录了项目源码、设计文档、决策记录、操作手册和沉淀下来的经验条目。
你的任务不是“把知识库讲一遍”，而是**在需要事实时先查它，再基于查到的原文回答**。

## 什么时候用

- 用户问这个团队/项目的实现细节、约定、历史决策，而你手上没有可靠上下文时。
- 需要确认某个配置项、接口、命令、文件路径到底怎么写时。
- 写代码或文档前，想找已有实现、模板、规范或踩坑记录时。
- 用户明确说“查一下知识库”“搜一下之前的结论”时。

不需要用的场景：通用编程知识、用户当前对话里已经给全的信息、纯创意写作。

## 连接方式

### 本机（stdio）

MCP 客户端配置 `command = "kb"`、`args = ["mcp"]`。`kb mcp` 会连接本机守护进程；
守护进程没跑时会自动拉起。

### 远程（Streamable HTTP）

- 地址：`$KB_BASE/mcp`（把 `$KB_BASE` 换成你的知识库站点地址）
- 认证头：`Authorization: Bearer $KB_TOKEN`
- `$KB_TOKEN` 必须是 **MCP 类型**的访问令牌，在网页的「AI 接入指南」里创建。
 这份 Skill 本身**不含任何密钥**；不要把令牌写回这里，也不要在回答里打印令牌。
- 网页生成的个人接入指南会带这个账号的 key、可用工具和导入规范；公开 Skill 只讲怎么用，
 两者冲突时以个人指南里的账号权限为准。

## 工具清单

本机 stdio 有 16 个工具，网络 `/mcp` 看不到 `agent_history`（其余 15 个相同）：

| 工具 | 用途 |
|---|---|
| `search_knowledge` | 混合检索（全文 + 语义），最常用 |
| `search_code` | 只在代码块里检索 |
| `get_item` | 按 id 取一条结果的完整内容 |
| `doc_read` | 按行读文件或笔记正文 |
| `list_collections` | 列出集合 |
| `list_projects` | 列出已登记项目 |
| `list_files` | 找文件或模板的准确路径 |
| `job_list` | 查看后台任务 |
| `list_ingest` | 查看导入记录与失败原因 |
| `save_insight` | 保存一条经验（写） |
| `kb_feedback` | 对检索结果标记有用/无用（写） |
| `reindex_project` | 重新索引项目（写） |
| `doc_edit` | 按原文替换修改文档（写） |
| `check_links` | 批量检查引用目标是否存在 |
| `doc_links` | 查文档或笔记的出链、入链 |
| `agent_history` | 查编码代理历史会话（仅本机） |

写工具需要对应权限；没有权限时返回 403，不要把它当成令牌失效。

## 三条使用范式

1. **先搜后读。** 先用 `search_knowledge` 拿到候选（默认看前 5–8 条），再用 `get_item` 或
 `doc_read` 读真正相关的那一两条。不要只凭搜索摘要回答，也不要把整篇文档一次性倒进上下文。
2. **引用带来源。** 回答里写清 `source`（文件路径）和 `start_line`–`end_line`；笔记类结果写笔记标题或 id。
 没有来源的结论要说明是推断，不要伪装成知识库事实。
3. **分次读、按需扩。** 大文件先读命中行附近（`doc_read` 的 `offset` / `limit`），不够再扩大范围；
 搜索词太泛时加 `kind:`、`lang:`、`path:`、`tag:` 前缀缩小范围。

读返回的形状：`get_item` 的正文在 `data.item`，里面有 `source` / `start_line` / `end_line` / `text`；
`doc_read` 的参数是 `{collection, path, offset, limit}`，正文在 `data.text`，下次从 `data.next_offset` 续读。

## 常见错误

| 现象 | 处理 |
|---|---|
| 401 / 未授权 | 令牌缺失、过期或不是 MCP 类型；让用户重新生成，不要重试空请求 |
| 403 / 功能点未开通 | 账号权限问题，不是令牌问题；告知用户缺哪个能力 |
| 搜索结果为空 | 先换同义词、缩写或英文名；再放宽 `scope` / `path_prefix`；仍为空就如实说没查到 |
| 结果很多但都不相关 | 加 `path:` / `kind:` 限定，或改用 `search_code` |
| 读到的内容和搜索摘要不一致 | 以 `doc_read` / `get_item` 的原文为准，摘要只用来定位 |
| 写入被拒绝 | 确认令牌有写权限、目标 collection 存在；不要绕过权限直接改库 |

## curl 示例（REST 调用同一能力）

```bash
export KB_BASE="https://your-kb-host"
export KB_TOKEN="<在 AI 接入指南里创建的 MCP 令牌>"

curl -sS -X POST "$KB_BASE/api/v1/capabilities/search_knowledge" \
 -H "Authorization: Bearer $KB_TOKEN" \
 -H "Content-Type: application/json" \
 -d '{"query":"双哈希增量索引","k":5}'
```

返回 `{"ok":true,"data":{"hits":[...]}}`；每条 hit 里有 `source`、`start_line`、`end_line`、`id`。

## 不要做

- 不要把令牌、Cookie、内网地址写进回答或提交到仓库。
- 不要为了“看起来完整”而编造文件路径、行号或结论。
- 不要未经用户确认就批量导入文件、重建索引或修改大量文档。
- 不要一次把几十条结果全部贴给用户；先收敛到最相关的几条，再给来源。
