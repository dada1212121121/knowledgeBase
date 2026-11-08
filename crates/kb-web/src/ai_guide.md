# {{SITE}} · AI 接入指南

> 这份文档是为 **{{WHO}}** 生成的,生成时间 {{GENERATED}}。
> 文档里带着这个账号的 admin key:谁拿着它,就能以这个账号的身份调用下面列出的全部接口。
> 如果 admin key 被轮换,文档里的 key 就失效了,需要重新下载。
> 导入规范版本:2026-11(第 5 节的 5.0 小节)。要往知识库里放东西的人和 AI,**必须先读它**。

**如果你是 AI,请把整份文档读完,然后按「第 0 节」做。**

## 0. 你要完成的事(按顺序)

1. 用本文的 admin key 验证身份(第 2 节)。
2. 用 admin key 创建一个 **MCP 访问令牌**(第 3 节),把知识库配进你自己的 MCP 客户端(第 4 节)。
3. 把「第 7 节」的提示词放进你的系统提示词,或者项目里的 `AGENTS.md` / `CLAUDE.md`,以后按它使用知识库。
4. 运行「第 9 节」的自测脚本,确认能检索、能写入、能读回。脚本结束时会自己清理测试数据;
   中途失败也要照第 9 节的方法手工清理。
5. 用户让你把某个项目、目录或一批文件放进知识库时,**先读第 5 节的 5.0 小节「导入规范」**:先盘点,
   把准备导入什么、排除什么告诉用户,超过门槛要等用户确认,再动手。自测脚本不导入文件,不受这条影响。
   导入后按 **5.2** 让内容保持最新(服务器上的目录一律登记为项目,不管是不是 git),并告诉用户它怎么更新、多快。
6. 把结果告诉用户:接入成功没有,哪一步失败了、报错是什么。

## 1. 连接信息

| 项 | 值 |
|---|---|
| 站点地址 | `{{BASE}}` |
| 账号 | `{{USERNAME}}`{{DISPLAY_SUFFIX}} |
| admin key | `{{KEY}}` |
| MCP 地址(第 4 节用) | `{{BASE}}/mcp` |
| 接口根路径 | `{{BASE}}/api/v1` |

调用约定:

- 每个请求带 `Authorization: Bearer <admin key>`。用 admin key 不需要 CSRF 头,也不需要 cookie。
- **admin key 不能直接接 MCP**。先用它创建一个 `scope=mcp` 的访问令牌(第 3 节),MCP 客户端用那个令牌。
- 请求和响应都是 JSON。成功:`{"ok": true, "data": {...}, "meta": {...}}`;
  失败:`{"ok": false, "error": {"code": "...", "message": "..."}}`,同时 HTTP 状态码对应错误类型
  (400 参数不对 · 401 没登录或 key 无效 · 403 没有权限 · 404 不存在 · 409 冲突或已存在)。
- 接口有「功能点」限制:账号没开通某个功能时返回 403 `你的账号没有开通这个功能`,这不是 key 的问题。
- 管理员只读查看别人的知识库时,才带 `X-KB-Admin-View: usr_…`。这个头只认浏览器会话或**本人的 admin key**,
  只能调只读接口,并且和分享用的 `X-KB-Space` 互斥;访问令牌(含 `scope=api`)与 MCP 带它一律 403。
  不要用它绕过账号自己的权限。

## 2. 验证身份

```bash
curl -s {{BASE}}/api/v1/auth/me -H "Authorization: Bearer {{KEY}}"
```

应返回 `data.user.username` 为 `{{USERNAME}}`。返回 401 说明 key 已失效(被轮换或账号被停用),请让用户重新下载这份文档。

## 3. 创建 / 查看 / 撤销访问令牌(「MCP key」)

访问令牌是给程序和 AI 客户端用的凭据,和 admin key 分开,可以随时撤销。

```bash
# 创建。scope: mcp = 给 AI 工具用(最多写入级权限);api = 给脚本用(走完整 Web 接口)
curl -s -X POST {{BASE}}/api/v1/auth/tokens \
  -H "Authorization: Bearer {{KEY}}" -H "Content-Type: application/json" \
  -d '{"name": "my-ai-client", "scope": "mcp"}'
# 返回 data.token 就是令牌明文(kb_ 开头),**只会出现这一次**;data.id 是撤销时用的 id

curl -s {{BASE}}/api/v1/auth/tokens -H "Authorization: Bearer {{KEY}}"            # 列出
curl -s -X DELETE {{BASE}}/api/v1/auth/tokens/<id> -H "Authorization: Bearer {{KEY}}"  # 撤销
```

- 令牌名在同一个账号下不能重复(重名返回 409)。撤销后的令牌仍会出现在列表里(`revoked_at` 有值),这是历史记录,不是还在生效。
- `include_shared: true`(只对 `scope=mcp` 有效):让 MCP 检索也搜别人共享给你的内容,默认不搜。
- 不要用能力 `create_token` / `revoke_token`:那是旧的全站令牌,新的认证不认它们。

## 4. 把知识库接进 MCP 客户端

MCP 地址 `{{BASE}}/mcp`,传输方式 Streamable HTTP,认证头 `Authorization: Bearer <第 3 节创建的令牌>`。

Claude Code:

```bash
claude mcp add --transport http knowledgebase {{BASE}}/mcp \
  --header "Authorization: Bearer <第 3 节的令牌>"
```

其他支持 HTTP 传输的 MCP 客户端(Cursor、Cline、各类 SDK……)用同样的 URL 和请求头,通用 JSON 写法:

```json
{
  "mcpServers": {
    "knowledgebase": {
      "type": "http",
      "url": "{{BASE}}/mcp",
      "headers": { "Authorization": "Bearer <第 3 节的令牌>" }
    }
  }
}
```

接好后让客户端列出工具(`tools/list`),应该能看到第 11 节清单里带 `[M]` 标记的那些(清单按你的账号生成,
没开通的功能对应的工具不会出现)。常用的有 `search_knowledge`、`get_item`、`save_insight`、`list_collections`、`kb_feedback`。
以客户端实际列出的为准。

**不用现成的 MCP 客户端、要自己手写 HTTP 请求时**(第 9 节的自测脚本就是这样做的),注意四点:

1. 每个请求都带三个头:`Authorization: Bearer <第 3 节的令牌>`、`Content-Type: application/json`、
   `Accept: application/json, text/event-stream`。**少了 Accept 会得到 406。**
2. 先 `POST {{BASE}}/mcp`,请求体 `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"my-client","version":"1"}}}`。
   响应头里的 `mcp-session-id` 就是会话 id。
3. **此后每个请求都要带 `mcp-session-id: <会话 id>` 头**(缺了得到 422)。先发一条通知
   `{"jsonrpc":"2.0","method":"notifications/initialized"}`(没有 `id`,返回 202),再发 `tools/list`、`tools/call`。
4. 响应可能是普通 JSON,也可能是 SSE 流。SSE 流的开头先有一个**空的** `data:` 事件(只是占位),要跳过它,
   取后面以 `data: {` 开头的那一行,冒号后面就是 JSON-RPC 响应。
   `tools/call` 的请求体 `params` 是 `{"name": "工具名", "arguments": {...}}`,结果文本在 `result.content[0].text`
   (多数工具返回的是一段 JSON 文本,需要再解析一次)。

## 5. 往知识库里放内容、让它自动更新

先看你能做哪些(第 11 节清单里「项目与数据源」「笔记、文档与上传」两组;没列出的就是账号没开通)。

### 5.0 导入规范(必须遵守)

**为什么要严格:** 知识库是给检索用的。无关内容会挤掉真正有用的结果;每一块内容都要算向量,占 CPU 和磁盘,
还会拖慢别人的导入;进库之后再清掉要重建索引。服务器**不会替你拦**这些(它只跳过明显的二进制、超大文件和下面的默认排除),
所以判断由你来做,并且要做得比服务器严。

**总原则:** 只导入「以后有人会想搜到、并且读了能用」的内容。拿不准就不导,先问用户。

**应该导入:**

- 自己写的源码:业务代码、脚本、配置模板、数据库迁移(建表和迁移脚本可以,数据转储不行);
- 说明和设计:README、设计文档、决策记录、接口说明(OpenAPI、proto)、开发规范、操作和运维手册;
- 结论性的过程文档:规格、交接、复盘、事故报告,只要最终版;
- 重要的办公文档和 PDF 手册,同一份只导一个版本。

**不要导入:**

| 类别 | 典型路径 / 文件 | 怎么判断 |
|---|---|---|
| 依赖和第三方代码 | `node_modules/`、`vendor/`、`third_party/`、`bower_components/`、`Pods/`、`.venv/`、`site-packages/` | 目录名就能看出来 |
| **自己项目里夹带的第三方库** | `public/**/lib(s)/`、`static/**/vendor/`、`assets/lib/`、复制进来的 SDK / 插件 / 编辑器 / 图表库、`*.min.js`、`*.min.css` | 文件头有 `@license` 或别的组织的 `Copyright`;目录名是库名或带版本号;`package.json` 里有同名依赖;单个 JS 文件超过 100 KB 且不是你们自己写的。**自己的代码要导,夹在旁边的库不要** |
| 构建和生成产物 | `dist/`、`build/`、`out/`、`target/`、`.next/`、`.nuxt/`、`coverage/`、`*.map`、`*.pb.go`、`*_pb2.py`、`*.generated.*`、锁文件 | 文件开头有 `@generated` / `DO NOT EDIT` 的,服务器会自己跳过 |
| 二进制和媒体 | 图片(**包括 SVG 截图**)、设计稿、音视频、字体、压缩包、可执行文件和库(exe / dll / so / jar / wasm)、数据库文件 | 看扩展名 |
| 数据和转储 | CSV / TSV / Parquet / JSONL 数据集、导出的 Excel 报表、`*.sql` 数据转储、`*.har` 抓包、大 JSON 样例 / fixtures | 内容是数据而不是文字说明 |
| 日志和运行产物 | `*.log`、`logs/`、`tmp/`、`.cache/`、`test-results/`、`playwright-report/`、`screenshots/`、性能剖析文件 | — |
| AI 和工具的过程产物 | 会话记录(`.claude/`、`.kiro/`、`.codex/`、`.cursor/` 里的 jsonl)、工具输出转储(如 `agent-tools/*.txt`)、预览和截图存档、质检流水、原始证据日志、临时目录(`.agent-scratch/`、`scratch/`、`_staging/`) | 结论性文档(规格、交接、决策)可以导,流水记录不导 |
| 密钥和隐私 | `.env*`、`*.pem`、`*.key`、`id_rsa*`、`credentials*`、`*.p12`、cookies、含账号密码的配置、客户个人数据 | 一律不导,也不要写进经验条目 |
| 重复内容 | 同一文档的多个版本(v1 / v2 / 最终版 / 最终版 2)、`*.bak`、`*~`、`*.orig`、镜像目录 | 只留最新的一份 |

服务器默认已经排除:{{DEFAULT_EXCLUDE}};项目里的 `.gitignore` 也会生效。上表里不在这两处的,要你自己排除。

**大小门槛:**

| 情况 | 服务器怎么处理 | 你要怎么做 |
|---|---|---|
| 项目里的代码 / 其他文本文件(`.txt`、配置、数据文件等,**不含**下一行的 Markdown)超过 {{TEXT_MAX_KB}} KB | 跳过 | 不要想办法绕过(例如改用上传);这么大的文本几乎都是数据、日志或生成文件 |
| 项目里的 Markdown 文档(`.md` / `.mdx`)超过 {{MD_MAX_MB}} MB | 跳过 | 不要想办法绕过;Markdown 的上限比代码宽,设计 / 决策 / 进度这类长文几百 KB 也能入库,超过这个大小的多半是误放进来的转储 |
| 文本文件超过 100 KB | 能入库 | 先确认是人写的,不是生成或导出的 |
| 办公文档 / PDF 超过 20 MB | 项目扫描上限是 {{DOC_MAX_MB}} MB | 先问用户;通常是扫描件或图片很多,能检索的文字很少 |
| 单个上传文件超过 {{UPLOAD_MAX_MB}} MB | 拒绝 | 不要拆分后再传。你的账号可能有更低的上限,以上传时服务器的回答为准 |

**必须先问用户的情况:** 一次要导入超过 300 个文件、合计超过 50 MB、有单个文件超过 10 MB,
或者有你判断不了该不该导的目录。把盘点结果给用户看,得到明确同意再导。

**步骤:**

1. **盘点。** 在目录里统计:文件总数和总大小;按顶层目录和扩展名的数量与大小;最大的 20 个文件。
   是 git 仓库时以 `git ls-files` 为准(已被 `.gitignore` 忽略的不用管)。
2. **定规则。** 对照上面两张表写出排除规则(glob,gitignore 语法),或者直接用白名单(`include`,例如只收 `src/**`、`docs/**`)。
3. **报告。** 告诉用户:准备导入几个文件、多大;排除了哪几类、各多少个;哪些拿不准。达到「必须先问」的情况就等用户确认。
4. **执行。** 按下面第 5 节 B / C / D 对应的方式做,且遵守其中的顺序(先排除,再索引)。
5. **复核。** 索引完成后,`job_get` 结果的 `checkpoint_json` 里有出错数(`errors`)和出错样例(`error_samples`);
   再用 `list_items`(`collection` + `path_prefix`)按顶层目录抽查实际入库的文件,看有没有混进噪音目录。
   上传的看 `list_ingest` 里 `failed` 的文件。发现漏掉的噪音,补排除规则再重建一次。
6. **大资料不整份导入。** 判断为不该导、但有参考价值的资料(数据集、大报表、第三方库文档),
   用 `save_insight` 记一条:它在哪、是什么、什么时候会用到。

**以后:** git hook 触发的增量索引沿用同一套排除规则;项目里新出现的大目录(新依赖、新的产物目录)要及时补排除。

**A. 记经验(最常用,MCP 工具 `save_insight`)**:一条经验 = 标题 + 正文 + 种类(decision / pitfall / howto / convention / note)
+ 标签 + 相关文件。保存后几秒内可被检索到(向量是异步生成的)。

### 5.1 正文里引用文件 / 模板(链接怎么写)

引用库内的文件一律写 Markdown 链接、指向**知识库里的路径**;不要写 `/api/v1/raw?...`、服务器绝对路径或 Windows 盘符
(`C:\...`、`file:` 这类只会被当成「原电脑路径」提示,点了也打不开,换个端口 / 换台机器更会全断)。

- **同一个集合里的文件**:相对路径,相对**这篇文档所在目录**:`[流程图](图.png)`、`[报价单](../模板/报价单.dotx)`。
  笔记没有文件路径,相对链接按集合根解析。
- **跨集合,或不确定在哪**:`kb://<collection>/<path>`,例如 `[规范](kb://proj_demo/docs/规范.md)`。
- **引用另一篇笔记**:`kb://note/<id>`(`search_knowledge` 结果里的 id)。
- **要下载而不是预览**(模板、CSV、压缩包):模板扩展名(`.dotx` / `.dotm` / `.xltx` / `.potx` …)自动按下载处理,
  其余文件显式加 `?download=1`;`kb://` 也一样:`kb://proj_demo/模板/报价单.dotx?download=1`。
- `[[...]]` 只保留给从 Obsidian 搬来的旧内容,**新写的内容不要用**。

**写之前先找准确路径**:`list_files`(`collection`,`path_prefix` 按目录、`q` 按关键词,分页)列出真实存在的文件和模板,
不要凭印象拼路径。

**写完自检**:`save_insight` 与 `doc_edit` 的返回里都有 `links`(逐条给 `state`:`ok` / `missing` / `outside` / `invalid`);
要一次查一批再调 `check_links`(最多 200 条)。`save_insight` 打开 `strict_links: true` 时,正文里的坏引用会让这次写入直接失败——
比写完让用户点开看到「未找到」好。

**坏引用怎么处理**:`missing` 是目标不存在(没上传,或者目录层级写错)——先用 `list_files` 找相近路径改链接;
确实没有这个文件,就告诉用户缺哪个、应该放在哪个路径,由用户自己上传:**AI 不能上传文件**(上传接口只给浏览器会话)。
`outside` 是目标跑到了集合外面(例如 `../` 越界),改成 `kb://` 跨集合写法。

**查影响面**:`doc_links`(`collection` + `path`,或 `note_id`;`direction` 取 `from` / `to` / `both`;目录用 `path_prefix`)
回答「谁引用了我」。要移动 / 删除一个被引用的文件时,先把入链报给用户,别直接动。

**B. 接入一个项目目录**(目录在**知识库服务器上**时;代码仓库、规则 / 制度 / 资料文件夹都一样,**不要求是 git**)。先按 5.0 盘点并定好排除规则,**再**注册:

```bash
# 1. 注册(需要「项目与数据源」功能)。注意:注册会立刻排一个全量索引,而且注册时不能带排除规则
curl -s -X POST {{BASE}}/api/v1/capabilities/add_project -H "Authorization: Bearer {{KEY}}" \
  -H "Content-Type: application/json" -d '{"path": "/服务器上的/项目/目录", "name": "my-project"}'
# 返回 data.job_id

# 2. 马上取消这个还在排队的索引任务(任务一旦开始跑就取消不了,会返回错误,那就直接做第 3 步)
curl -s -X POST {{BASE}}/api/v1/capabilities/job_cancel -H "Authorization: Bearer {{KEY}}" \
  -H "Content-Type: application/json" -d '{"id": "<上一步的 job_id>"}'

# 3. 设排除规则(或白名单 include)并重新全量索引;已经被写进去的、现在被排除的文件会在重建时清掉
curl -s -X POST {{BASE}}/api/v1/capabilities/update_project -H "Authorization: Bearer {{KEY}}" \
  -H "Content-Type: application/json" \
  -d '{"project": "my-project", "exclude": ["**/vendor/**", "**/*.svg", "docs/agent-workflow/previews/**"], "reindex": true}'
# 返回后用 job_list(states: ["running","queued"])/ job_get 看进度,state 变成 done 就索引完了;然后按 5.0 第 5 步复核
```

- **自动更新**:注册后项目就有**实时文件监听**(默认开,不需要 git,约半分钟内开始监听);**git 项目**注册时还会自动装
  「提交后自动索引」钩子(返回里的 `data.hooks.installed` 告诉你装没装上、没装上的原因;已有项目要装用 `install_hooks`,
  参数 `{"project": "my-project"}`)。手动更新用 `reindex_project`(`{"project": "...", "mode": "incremental"}`,
  `full` 是全量重建)。**不同类型的内容怎么保持最新,见 5.2。**
- `exclude` 是 gitignore 语法的 glob 列表,`include` 是白名单(给了就只收匹配的);两个都是整体替换,改的时候把原来要保留的一并带上。
- 项目目录必须在服务器本机。你的代码在**别的机器**上时用 C 或 D。

**C. 上传文件 / 文件夹**(任何机器都能用):只上传 5.0 盘点后留下的文件,**不要把整个目录原样上传**
(上传不会替你排除 `node_modules`、构建产物这些)。分片上传接口,四步,全部带 `Authorization: Bearer {{KEY}}`:

1. `POST /api/v1/uploads/precheck` `{"collection": "_global", "files": [{"rel_path","size","sha256"}]}`:去重预检,已有的不用传。
2. `POST /api/v1/uploads` `{"name","size","sha256","rel_path","collection","tags":[]}` → 返回 `upload_id`、分片大小。
3. `PUT /api/v1/uploads/<upload_id>/parts/<n>`(n 从 0 起),请求体是该分片的原始字节。
4. `POST /api/v1/uploads/<upload_id>/complete` → 合并并进入解析队列;用 `list_ingest` 看解析结果。

**D. 数据源**(服务器自己去拉):`add_source`。`kind` 取 `git`(仓库地址)、`web`(网页,可设抓取深度和白名单域名)、
`note`(一段手写文字)、`local_dir`(服务器本地目录)。`sync_source` 立刻同步一次;`web` / `git` / `local_dir` 来源
可以设 `refresh_minutes` 定时同步,内容没变的文件 / 页面不会重新处理。导入规范同样适用:`git` / `local_dir` 来源先按 5.0 盘点;
`web` 来源必须设白名单域名,抓取深度不要超过 2,不要整站抓取。

### 5.2 保持最新:按内容类型选做法(推荐都做)

用户给你的不一定是代码仓库,也不一定有 git:可能是一批规则、制度、资料文件夹,也可能只是几条要记下来的话。
**先判断内容在哪、是什么类型,再选下面一行;选完要把"它会怎么更新、多快"告诉用户。**

| 内容 | 怎么接入 | 怎么保持最新 | 多快 |
|---|---|---|---|
| 服务器上的目录,**是 git 仓库** | `add_project`(B) | 实时监听(默认开) + 提交后自动索引钩子(注册时自动装) | 几秒 |
| 服务器上的目录,**不是 git**(规则、制度、资料) | 同样 `add_project`(B),**不需要 git** | 实时监听(默认开);没有钩子也不需要 | 几秒 |
| 服务器上的目录,只当资料、不按项目管理 | `add_source`,`kind: "local_dir"` | 设 `refresh_minutes`(定时同步,没变的跳过),或 `sync_source` | 按间隔,**不实时** |
| 文件在**别的机器**上 | 上传(C) | 不会自动感知变化:改了的文件重新上传(先 `precheck`,没变的会跳过);要准实时就写脚本定时只传变化的,或者让用户把目录放到服务器上再按第 1、2 行做 | 取决于上传时机 |
| 托管在别处的 git 仓库 | `add_source`,`kind: "git"` | 设 `refresh_minutes`(定时 fetch),或 `sync_source` | 按间隔,**不实时** |
| 网页 | `add_source`,`kind: "web"` | 设 `refresh_minutes`,只有内容变了的页面才重新处理 | 按间隔,**不实时** |
| 要记下来的几条话、经验、规则 | `save_insight` / `create_item`,不需要接入 | 保存就进索引 | 几秒 |

要点:

- **服务器上的目录一律优先登记为项目**(B),不管是不是 git:只有项目才有实时监听,数据来源(`add_source`)不监听,只能定时或手动同步。
- **git 项目**注册时已经自动装了「提交后自动索引」钩子;它处理切分支、拉代码、改写历史这类一次改很多文件的操作,和文件监听互补。
  `data.hooks.installed` 为 `false` 时,把 `data.hooks.reason` 转告用户(常见:不是 git、仓库的钩子目录由别的工具托管)。
  **非 git 目录没有钩子**,只靠文件监听,这是正常的,不要为它报错。
- **不要关掉实时监听**(配置 `index.watch`,默认开)。另外每晚凌晨 3 点(站点时区)有一次自检,核对文件与索引是否一致、自动补漏,
  是兜底,不能代替监听。
- 网络盘(NFS / SMB)和某些挂载进来的目录通常收不到系统的文件变化通知:这类目录要靠夜间自检补上,或改用 `local_dir` 来源加 `refresh_minutes`。
- **首次索引**:注册项目会自动排全量索引;添加数据来源不会自动开始,要用 `sync_source` 触发第一次(或设 `refresh_minutes` 等它到点)。
  用 `job_list` / `job_get` 看进度,大致每秒几个块,一万块要一小时上下;别的任务多时会先排队。之后都是增量:内容没变的文件跳过。
  表行数够多(默认一万行以上)时向量索引自动建,不用手动。
- **验证实时更新生效**:改目录里一个文件(加一句有辨识度的话),几秒后用 `search_knowledge` 搜这句话;搜不到先看 `job_list`
  有没有排队中的任务(忙时会晚几十秒)。
- 规则、制度这类文字内容怎么写更容易搜到:用 Markdown,**按标题分节,一条规则一个小节**(按一、二、三级标题切块,一个小节命中一次);
  标题写成能单独看懂的话,别只写「第 3 条」;按主题拆成几个文件,更新时只重新处理改动的那个。
- **「自动提炼」(`extract_enabled`)和「允许云端大模型」(`allow_cloud_llm`)默认关,没有用户明确同意不要开**:开了以后项目里的会话和提交内容
  会发给外部的大模型接口。它们和内容保持最新无关,不开不影响索引和搜索。

## 6. 调用任何接口(第 11 节清单里的每一项)

所有「能力」都是同一个入口:

```bash
curl -s -X POST {{BASE}}/api/v1/capabilities/<能力名> \
  -H "Authorization: Bearer {{KEY}}" -H "Content-Type: application/json" -d '<参数 JSON>'
```

- 没有参数时发 `{}`。参数名、类型、必填(`*`)见第 11 节;完整说明用
  `GET {{BASE}}/api/v1/capabilities`(带同样的 Authorization 头)取,里面有每个能力的 JSON Schema。
  注意那个接口列出的是**全站所有**能力,条数比第 11 节多;第 11 节只列你这个账号真能调用的。
- **有副作用的接口先演练**:URL 后面加 `?dry_run=true`,只返回会发生什么,不落库(支持演练的接口才有效)。
- 权限级别:`R` 只读 · `W` 写入 · `G` 治理(删除、移除项目这类不可恢复的操作) · `A` 管理(系统设置)。
  `G`、`A` 级的接口在需要时会要求你在参数里显式带 `"confirm": true`,别在没问用户的情况下传。
- 删除、移除、覆盖这类**不可恢复**的操作,执行前先跟用户确认。

示例(搜索 → 取全文):

```bash
curl -s -X POST {{BASE}}/api/v1/capabilities/search_knowledge -H "Authorization: Bearer {{KEY}}" \
  -H "Content-Type: application/json" -d '{"query": "rerank 超时怎么降级", "k": 5}'
curl -s -X POST {{BASE}}/api/v1/capabilities/get_item -H "Authorization: Bearer {{KEY}}" \
  -H "Content-Type: application/json" -d '{"id": "<上一步结果里的 id>"}'
```

## 7. 给 AI 的使用要求(提示词)

把下面这段原样放进你的系统提示词,或者项目根目录的 `AGENTS.md` / `CLAUDE.md`:

```text
你接入了团队知识库(MCP 服务 knowledgebase)。使用规则:
1. 开始一个任务前,先用 search_knowledge 搜一下相关的决策、踩过的坑和约定;命中后用 get_item 读全文再动手。
   搜不到不要硬编,直接说"知识库里没有相关记录"。
2. 完成一件有复用价值的事之后(做了技术决策、踩了坑、找到了非显而易见的做法、定了约定),用 save_insight 记一条:
   - title 一句话说清结论;body 写背景、结论、原因和适用范围(markdown);
   - kind 选 decision / pitfall / howto / convention / note;tags 给 2-4 个;related_paths 写涉及的文件(项目内相对路径)。
   - 正文要引用库里的文件 / 模板时,先用 list_files 找到真实路径,再写相对路径或 kb://<collection>/<path>
     (模板和要下载的文件加 ?download=1);从返回的 links 里看有没有 missing,先修再交。AI 不能上传文件,
     缺文件要告诉用户放哪里。
3. 先搜再记:已经有同主题的条目,就再 save_insight 一条新的并把旧条目的 id 填进 supersedes(旧条目会被标成已取代),不要重复记。
   如果返回"已经被别人取代 / 刚刚被别人取代或修改了",说明有人抢先改了:重新检索,基于最新的一条再来。
4. 不要保存密码、密钥、令牌、个人隐私,也不要保存只对当前一次对话有用的临时信息。
5. 搜到的内容有用或没用,用 kb_feedback 反馈一下,检索质量会据此调整。
6. 不确定的操作(删除、移除项目、覆盖)先问用户,不要自己决定。
7. 导入任何内容前,先按接入指南第 5 节的 5.0 小节盘点。只导入人写的源码和文档;依赖和夹带的第三方库、构建产物、
   图片音视频和其他二进制、数据转储、日志、AI 会话和工具输出、密钥,一律不导入。
8. 一次要导入超过 300 个文件、合计超过 50 MB、或有单个文件超过 10 MB 时,先把盘点结果给用户确认,不要自己决定。
9. 注册项目或改排除规则后,检查索引结果里的出错数和实际入库的目录;发现噪音,补排除规则并重建。
10. 大文件和资料包不整份导入;需要留线索时用 save_insight 记一条,写清它在哪、讲什么。
```

## 8. 多个客户端 / 多个人同时用

- **同一个账号可以同时开多个客户端**,每个客户端用自己的访问令牌(第 3 节,名字区分开,比如 `laptop`、`ci`、`claude-desktop`)。
  它们各自握手、各有各的会话,互不影响;撤销其中一个令牌,另一个照常能用。
- **不同账号之间完全隔离**:每个人只能读写自己的知识库;MCP 检索想带上别人共享给你的内容,创建令牌时加 `include_shared: true`
  (只读,不能写进别人的库)。会话 id 只对开它的那个账号有效,借来的会话 id 用不了。
- **同时写同一条经验会有一个赢家**:两个客户端同时 `supersedes` 同一条旧经验,只有一个成功,另一个得到 409
  (`已经被别人取代` / `刚刚被别人取代或修改了`),并且不会留下半截数据。收到后重新检索、基于最新的一条再写。
- **同时重名建令牌**:只有一个成功,其余是 409 `已有同名令牌`。给每个客户端起不同的名字。
- **刚保存的经验立刻用 `get_item`(按 id)就能读到**;检索(`search_knowledge`)要等向量生成,通常几秒,大批量写入时更久。
- **多人正在编辑的文档**:如果你用 admin key 通过 REST 修改一篇此刻有人在线编辑的文档,请求里带上
  `X-KB-Client: <你的名字>` 头——你的改动会变成文档上的一条「AI 建议」评论,不会覆盖别人正在写的内容;不带这个头会被当成人,
  得到 409。
- **admin key 被轮换时**,正在进行的请求要么在轮换前完成,要么得到 401,不会出现 5xx;拿到 401 就重新下载本文档。

## 9. 自测脚本(运行它来确认接入成功)

保存为 `kb_selftest.py`,用 `python3 kb_selftest.py` 运行,只依赖 Python 3 标准库。它会依次:检查服务、验证 admin key、
创建一个临时 MCP 令牌、走一遍 MCP 握手并列出工具、保存一条测试经验、读回它,**最后把测试经验和临时令牌都清理掉**。
每一步打印 `[OK]` 或 `[FAIL]`;任何一步失败它也会先清理再以非零状态退出。

```python
{{SELFTEST}}
```

如果脚本被强行中断没来得及清理:

脚本开头会打印"本次运行编号"(6 位十六进制)。只清这一次的,别误删别人同时在跑的:

1. 删测试数据:`list_items`(`{"collection": "_global", "q": "<运行编号>"}`)找到标题含该编号的条目,
   逐个 `delete_item`(`{"id": "..."}`)。
2. 撤销临时令牌:`GET /api/v1/auth/tokens` 找到名字是 `kb-selftest-<运行编号>` 的,`DELETE /api/v1/auth/tokens/<id>`。

脚本跑完后,令牌列表里会留下一条已撤销的记录,任务列表(`job_list`)里会留下一条已完成的"保存经验"任务记录。
这是历史记录,不算残留的测试数据,不用也无法手工删除。

## 10. 其他不在「能力」里的接口

都带 `Authorization: Bearer {{KEY}}`。

| 接口 | 用途 |
|---|---|
| `GET /api/v1/health` | 服务是否在线(不需要认证) |
| `GET /api/v1/auth/me` | 当前身份和已开通的功能点 |
| `GET /api/v1/me/admin-key` | 查看 admin key(返回 `admin_key`、`created_at`、`rotated_at`) |
| `POST /api/v1/me/admin-key/rotate` | **轮换 admin key**:返回新 key,旧 key 立刻失效;本文档里的 key 随之作废,需重新下载 |
| `GET /api/v1/me/ai-guide?download=1` | 重新下载这份文档(不带 `download` 就是直接返回文本) |
| `GET /api/v1/auth/tokens` · `POST` · `DELETE /{id}` | 访问令牌管理(第 3 节) |
| `POST /api/v1/uploads` 等 | 分片上传(第 5 节 C) |
| `GET /api/v1/raw?collection=&path=` | 读文件原件(图片、音频预览) |
| `GET /api/v1/me/export` · `POST` · `GET /download` | 导出自己的全部数据 |
| `GET /api/v1/ws` | WebSocket 事件推送(索引进度、通知等) |

## 11. 接口清单(共 {{COUNT}} 个,按你这个账号当前的功能点生成)

记号:`W`/`R`/`G`/`A` = 权限级别;`[M]` = 也是 MCP 工具;参数里 `*` = 必填,`?` = 可为空,`[]` = 数组。
清单只列出你的账号能调用的;表里没有的接口,调用会得到 403。

{{CAPABILITIES}}

## 12. 常见问题

- **401 `admin key 无效`**:key 被轮换了或账号被停用。让用户在「使用指南 → AI 接入指南」里重新下载。
- **403 `你的账号没有开通这个功能`**:账号缺少该功能点,请管理员开通,不是 key 的问题。
- **403 `管理级能力只允许浏览器会话、admin key 或本机 UDS`**:你拿的是普通访问令牌,不是 admin key。
- **403 `只有在浏览器里登录后才能查看别人的知识库` / `管理员查看功能已关闭`**:`X-KB-Admin-View` 只给浏览器会话或本人 admin key;
  访问令牌与 MCP 不能用。整个部署也可能被 `[admin] inspect_enabled = false` 关掉。
- **MCP 连不上 / 401**:MCP 客户端用的必须是第 3 节创建的 `scope=mcp` 令牌,不能填 admin key。
- **引用点了「未找到」**:目标文件没进库、目录层级写错,或者写的是原电脑的绝对路径。引用该写库内相对路径或
  `kb://<collection>/<path>`(第 5.1 小节);先用 `list_files` 找准确路径,再用 `check_links` 复检。
- **AI 能不能帮我上传文件 / 模板**:不能。上传接口只给浏览器会话,AI 只能引用库里已有的文件;缺的先让用户传。
- **保存后立刻搜不到**:向量是异步生成的,等几秒再搜;`get_item` 用 id 读取是立刻可用的。
- **为什么有的文件没进库:** 项目扫描会跳过这几类:超过单个文件大小上限的、二进制的、开头标着 `@generated` / `DO NOT EDIT` 的生成文件、
  命中排除规则或 `.gitignore` 的。这是有意的。**不要用上传等别的办法把它们塞进去**;确实需要其中某个文件,先问用户。
- **注册项目后才想起来要排除:** 照第 5 节 B 的顺序补救:`job_cancel` 取消排队中的索引(取消不了就跳过),再 `update_project` 设排除并 `reindex: true`。
- **409 `已经被别人取代`**:你要取代的那条经验已经有新版本了。重新 `search_knowledge` / `get_item` 拿到最新的一条,再基于它写。
