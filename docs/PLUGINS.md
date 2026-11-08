# 索引插件

> 这一份写的是 **知识库自己的插件**:放在 `<KB_HOME>/skills/<目录>/manifest.toml`。
> 仓库根目录的 `skills/system/*/SKILL.md` 是 Codeg 的技能,知识库不读,两者互不影响。

插件解决的是「内置解析器改不动、又不想把格式逻辑编进宿主」的那部分:Vue 单文件组件、
业务 SQL、内部文档格式、某个网站的结构化抓取。插件是**独立进程**,通过逐行 JSON-RPC 和宿主说话;
它崩了、卡了、吐脏数据,只让当前文件回退到内置实现,不会把守护进程一起带走。

## 1. 什么时候该写插件

| 场景 | 该用的钩子 | 说明 |
|---|---|---|
| 新格式要抽成文本 | `extract` | 输入原文件,输出纯文本;优先于内置抽取 |
| 某个格式的块切得不对 | `chunk` | 直接给块(标题 / 符号 / 行号);不给就走内置分块器 |
| 块要补上下文 | `enrich` | 给每块补 header / title / 符号;适合 contextual retrieval |
| 一个数据源要走自己的抓取 | `source` | 目前只支持网页来源(`kinds = ["web"]`) |
| 只需要「哪些文件进索引、打什么标签、按什么语言解析」 | `[index]` | **声明式**,不需要进程,也不需要 `allow_exec` |

只做标签 / 语言 / 排除的规则不要写进程插件:直接在 `[index]` 里写,加载快、没有安全面。

## 2. 清单

```toml
type = "plugin"
name = "vue-sfc"
version = "0.1.0"
api_version = 1
description = "把 .vue 的 template / script / style 分开抽文本"

# 声明式索引策略:不需要进程,allow_exec=false 时也生效
[index]
include = ["**/*.vue"]
exclude = ["**/node_modules/**", "**/dist/**"]
lang = "vue"
tags = ["frontend"]
priority = 100
# projects = ["proj_frontend"]   # 可选:只对某个项目生效

# 进程钩子:必须 allow_exec=true 才会启动
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["extract", "chunk", "enrich"]
timeout_ms = 20000
max_output_bytes = 16777216

# 可选:给网页来源用的抓取规则
# [source]
# match = ["https://docs.example.com/*"]
# kinds = ["web"]              # 缺省就是 web
# priority = 100

# 可选:进程权限。必须写在 [exec] 里(TOML 子表),不能提到顶层
[exec.permissions]
network = false      # 默认关:独立 network namespace,连本机回环都连不上
read_project = false # v1 未开放:写 true 会拒绝加载
llm = false          # v1 未开放:写 true 会拒绝加载
```

约束:

- `api_version` 必须是 `1`(当前宿主只支持 1)。
- `[exec].command` 可以是 PATH 里的命令(如 `python3`),也可以是插件目录内的相对路径。
- `[exec].hooks` 只能是 `extract` / `chunk` / `enrich` / `source`。
- 文件级钩子(`extract` / `chunk` / `enrich`)必须同时有 `[index].include`,避免插件对所有文件生效。
- 带 `extract` 的 `[index].include` 同时是扫描器的**二进制放行名单**:内置规则会把前 8KB 含 NUL
  的文件当二进制跳过,插件认领后才会放行(单个文件上限 16MB,超过仍跳过)。没有 `extract`
  的规则不会放行二进制——放行了也没人能把它解析成文本。
- `[source]` 必须同时把 `source` 写进 `[exec].hooks`,并且 `[source].match` 至少一条。
- `[exec.permissions]` 是 `[exec]` 的子表,不能写成顶层 `[permissions]`;网络权限按
  `network` 放行,`read_project` / `llm` 还没有实现,写 true 会在加载时被拒绝(见第 6 节)。
- `[index]` 里 `include` 与 `exclude` 至少有一个;纯排除规则不能再写 `lang` / `tags`。
- 优先级 `-1000..=1000`;数字大的先匹配。同一文件命中多个插件时:
  `tags` 合并去重,`lang` 和文件级钩子取优先级最高的那一个。
- `skills.allow_exec = false`(默认)**不会让整个插件消失**:`[index]` / 提示词 / 模板照常加载,
  进程钩子被禁用并在 `list_skills` 的 warnings 里说明。确认规则效果后,再在配置里打开
  `[skills] allow_exec = true`,插件进程才会启动。
- 打开后还要有可用的 bwrap 沙箱。没有沙箱时默认**连进程钩子也不启动**(只加载声明式部分);
  只有管理员显式设置 `skills.allow_unsandboxed = true` 才允许裸跑,设置页会一直显示告警。

### 2.1 装插件 / 改规则之后

- 项目索引:命中插件的文件**不再走“文件内容哈希没变就跳过”**,下一次 `kb index` 会重新
  extract → chunk → enrich;块内容没变时只更新元数据,不会无谓重嵌入。
- 数据源:同步只重新入队“大小或内容变了”的页面;已抓过的旧页面不会因为装了插件就自动重解析。
  需要让插件覆盖存量页面时,重建这个数据源。
- 源站删掉的页面:插件返回的是当前快照,磁盘目录与 URL 清单会整体替换;但**已经入库的块
  不会自动消失**,重建数据源才会清掉(与内置爬虫的既有行为一致)。
- 改 `version` 不会单独触发清理;真正的语义是“插件命中就重跑”,所以上面两条同样适用。

## 3. 协议

宿主启动进程后,把请求逐行写到 stdin,从 stdout 读一行 JSON;stdout 只允许协议数据,
日志一律写 stderr(宿主按 warn 记下最后 512 字节)。

### 3.1 初始化

宿主第一次调用某个钩子前自动发:

```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{
  "api_version":1,
  "hooks":["extract","chunk"],
  "plugin":{"name":"vue-sfc","version":"0.1.0"},
  "host":{"name":"kb","version":"0.1.0"}
}}
```

插件必须回:

```json
{"jsonrpc":"2.0","id":0,"result":{"api_version":1}}
```

`api_version` 不是 1 时宿主拒绝这个插件。

### 3.2 extract

请求 `params`:

```json
{
  "api_version": 1,
  "file": {"path": "src/App.vue", "project": "demo", "size": 1234, "mtime": 1760000000000},
  "bytes_base64": "PHRlbXBsYXRlPi4uLjwvdGVtcGxhdGU+"
}
```

`bytes_base64` 是原文件的完整字节(base64),二进制格式(自研文档、压缩包、特殊编码)
直接解 base64 就能拿到原始内容,不依赖宿主先把它当文本解码。请求体上限 32 MB。

返回:

```json
{"text":"抽出来的纯文本","lang":"vue"}
```

- `text` 不能超过 16 MB;`lang` 最长 32 字符。
- 返回错误或进程失败时,宿主回退到内置抽取 / 编码解码,文件照常入库。
- 插件只需要文本时,自己把 `bytes_base64` 解成 UTF-8 即可;不要假设 `source` 文件在插件目录里。

### 3.3 chunk

请求 `params`:

```json
{"doc": { "...同 extract 的 doc..." }}
```

返回:

```json
{"chunks":[
  {"key":"template","text":"...","start_line":1,"end_line":20,
   "header":"App.vue › template","symbol":"template","title":"模板"}
]}
```

- `key` 非空且在同一文件内唯一;`start_line >= 0`,`end_line >= start_line`。
- 单块 ≤ 1 MB,一次 ≤ 10,000 块,总量 ≤ 16 MB。
- `header` / `symbol` / `title` 可省略;宿主会给空 header 补 `项目 › 文件`。
- 返回错误、空数组、坏块时回退到内置分块器(tree-sitter / Markdown / plain)。

### 3.4 enrich

请求 `params`:

```json
{"doc": { "...同 extract..." }, "chunks": [ "...chunk 数组..." ]}
```

返回同样形状的 `chunks`,顺序和数量必须一致;`text` 不允许被改空。
失败时保留原块,不阻断索引。

### 3.5 source

请求 `params`:

```json
{
  "api_version": 1,
  "source": { "...Source 记录..." },
  "options": {"depth": 2, "allow_hosts": ["docs.example.com"]}
}
```

返回:

```json
{"pages":[
  {"url":"https://docs.example.com/a","rel_path":"docs.example.com/a.html",
   "content":"<html>…</html>","content_type":"text/html"}
]}
```

- 一次最多 500 页,单页 ≤ 8 MB,总量 ≤ 64 MB。
- `rel_path` 必须是相对路径,不能是绝对路径、不能含 `..`;重复的 `rel_path` 直接拒绝。
- **返回的是当前完整快照**:宿主先清空该数据源目录再写入,上一轮有、这轮没有的页面会被删除。
  如果只是「这次没有新内容」,返回空数组即可。
- 插件失败时回退到内置网页爬虫(仍受 `crawl_allow_private`、robots.txt、域名白名单约束)。
- 网页抓取可能超过默认 15 秒,`source` 插件建议把 `timeout_ms` 设到 60000~120000。

## 4. 一个最小例子:Vue SFC

`<KB_HOME>/skills/vue-sfc/manifest.toml`:

```toml
type = "plugin"
name = "vue-sfc"
version = "0.1.0"
api_version = 1
[index]
include = ["**/*.vue"]
lang = "vue"
tags = ["frontend"]
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["extract", "chunk"]
```

`plugin.py`:

```python
import json
import re
import sys

def read_source(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()

def extract(raw):
    # 只保留模板与脚本里的可读内容,丢掉样式和注释
    src = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    src = re.sub(r"<style[^>]*>.*?</style>", "", src, flags=re.S)
    src = re.sub(r"<!--.*?-->", "", src, flags=re.S)
    return re.sub(r"<[^>]+>", " ", src)

def chunk(src):
    chunks = []
    for name in ("template", "script"):
        m = re.search(rf"<{name}[^>]*>(.*?)</{name}>", src, flags=re.S)
        if not m:
            continue
        text = m.group(1).strip()
        if text:
            chunks.append({
                "key": name,
                "text": text,
                "start_line": src[:m.start()].count("\n"),
                "end_line": src[:m.end()].count("\n"),
                "header": f"{name} 段",
                "symbol": name,
            })
    return chunks

for line in sys.stdin:
    req = json.loads(line)
    rid, method, params = req.get("id"), req.get("method"), req.get("params") or {}
    if method == "initialize":
        result = {"api_version": 1}
    elif method == "shutdown":
        break
    elif method == "extract":
        # extract 拿的是原文件字节;文本格式自己解码
        import base64
        raw = base64.b64decode(params["bytes_base64"])
        result = {"text": extract(raw), "lang": "vue"}
    elif method == "chunk":
        doc = params["doc"]
        result = {"chunks": chunk(doc["text"])}
    else:
        result = {"error": f"unknown method {method}"}
    print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}), flush=True)
```

安装后:

1. 在配置里把 `[skills] allow_exec` 打开(默认 false),或先只靠 `[index]` 验证标签 / 语言。
2. `reload_skills`(设置页或能力接口)重扫目录。
3. 对目标项目 `reindex`,看 `list_skills` 的 `hooks` / `rules` 与索引结果。
4. 上线前跑 `kb eval`,确认检索没有退步。

## 5. 从设置页安装与编辑

设置页「Skills」分区已经包含插件的管理面,不用手写 TOML:

- **官方插件**:卡片列出八个随宿主分发的插件,可一键安装。安装会把清单和
  `plugin.py` 写到 `<KB_HOME>/skills/<编号>`,之后它就是一个普通插件,可以停用、改参数、
  删除;点「重新安装」会用宿主自带版本覆盖当前目录(先确认,目录里改过的内容会丢)。
- **新增插件 / 编辑**:只提交结构化字段和 UTF-8 文本文件,服务端按启动时同一套
  `load_one` 校验后生成 `manifest.toml`。界面里没有「粘贴整份 TOML」的入口,避免手写清单
  把路径、钩子、source 规则写得不一致。
- **启用 / 停用**:只翻转清单里的 `enabled`,不会重写脚本文件;插件行和声明式 skill
  共用这个入口。

| 官方插件编号 | 处理的文件 | 做法 |
|---|---|---|
| `official-vue` | `**/*.vue` | template / script 分开切,跳过 style |
| `official-json` | `**/*.json`、`**/*.jsonc` | 去注释、清尾逗号,按顶层键 / 数组项切;标量块保留 `path: value` |
| `official-sql` | `**/*.sql` | 按语句切,字符串与 `$$` 里的分号不误切,表名进 header |
| `official-svg` | `**/*.svg` | title / desc / text 单独成块,图形只留概况,不索引路径坐标 |
| `official-dart` | `**/*.dart` | 按顶层声明切,类和方法不拆散,directives 单独成块 |
| `official-kotlin` | `**/*.kt`、`**/*.kts` | 按顶层声明切,构造参数 / 多行函数签名不拆散,imports 单独成块 |
| `official-noise` | 全部文件(只排除) | 纯声明式排除 `node_modules`、`dist`、构建目录、快照、压缩产物和常见锁文件;装后可改 |
| `official-redact` | 常见文本资料(`.md` / `.txt` / `.json` / `.yaml` / `.env` / `.sql` 等) | `enrich` 钩子在嵌入前遮蔽常见密钥、令牌、私钥和密码赋值 |

格式插件只实现 `chunk` 钩子(extract 仍走宿主内置解码),`official-noise` 没有进程钩子,
`official-redact` 只实现 `enrich`;所以:

- 宿主需要有 `python3`(命令是 `python3 plugin.py <格式>`),没有 Python 时格式 / 脱敏插件
  会回退到内置实现,不会让索引失败;`official-noise` 不需要 Python;
- `allow_exec = false` 时安装仍然成功,但只有 `[index]` 的语言 / 标签 / 排除规则生效,
  切块 / 脱敏仍用内置实现——设置页会在插件编辑框里明确提示;
- 插件的 `[index]` 优先级是 100,会压过默认 loader 规则;不想要某个格式的专用切法就停用
  对应插件,或把它的 `priority` 调低;
- 脱敏只覆盖高置信度格式,不能替代宿主侧 `llm_sends` 的出站脱敏(见 `llm_gate.rs`);
  处理的是块文本,不改变块数 / key / 顺序,私钥块会保留原有行数。

对应的管理能力(都在管理员范围,Web 管理面;`list_official_plugins` 普通用户也可读):

| 能力 | 作用 |
|---|---|
| `list_official_plugins` | 八个官方插件 + 当前是否已安装、已装版本、命中的文件与排除项 |
| `install_official_plugin` / `uninstall_official_plugin` | 安装 / 覆盖安装 / 卸载(卸载前确认目录确实是同名官方插件) |
| `list_skills` | 已登记 skill 与插件、`allow_exec` / `sandbox_available` / `allow_unsandboxed`、加载告警 |
| `get_plugin` / `save_plugin` | 读回 / 保存插件表单;保存走临时目录校验,失败不留半成品 |
| `set_skill_enabled` | 只改启用状态,不动脚本和清单其余内容 |

表单限额与路径规则:名称 60 字、版本 32 字、说明 300 字、单个 glob / 地址 200 字、
列表最多 64 项、脚本最多 32 个、单文件 1MB、总量 8MB;脚本路径必须是插件目录内的相对路径,
不能以点开头、不能包含 `..` 或反斜杠,也不能占用根目录的 `manifest.toml`。编辑已有插件时,
服务端会读回目录里所有可编辑文本;保存以表单里的文件为准,命令或参数引用的相对脚本必须在这次提交里(参数里像 `plugin.py` 这种带脚本后缀的值也会检查)。
目录里有设置页读不了的东西(二进制、软链、隐藏文件、单个超过 1MB、超过 32 个或总量超过 8MB)时
直接拒绝保存,避免整目录替换把它们悄悄删掉——这种情况请直接改插件目录。

## 6. 安全与边界

- **进程默认在 bwrap 沙箱里**:独立的 PID / IPC / UTS / cgroup / user namespace,
  `--cap-drop ALL`;插件目录是唯一可写挂载,系统目录(`/usr`、`/lib*`、`/bin`、`/sbin` 等)
  只读,`/tmp` 是进程私有 tmpfs(上限 256MB);`/proc`、`/dev` 最小挂载,宿主家目录、
  `<KB_HOME>`、项目目录都不在里面。
- **网络由 `[exec.permissions].network` 控制**:`false` 时加 `--unshare-net`,连宿主本机
  监听的端口都连不上;`true` 时只去掉 network namespace,文件系统隔离仍然生效。
- **没有沙箱不硬跑**:启动时真实拉起一次 bwrap 探测;不可用时进程钩子默认禁用,只加载
  `[index]` / 提示词 / 模板。管理员可以设置 `skills.allow_unsandboxed = true` 显式允许裸跑,
  此时设置页会显示「未沙箱」并给出告警。没有 `allow_exec` 时旧 `type = "exec"` 仍拒绝。
- `read_project` / `llm` v1 未开放:沙箱不会挂项目目录,宿主也不向插件注入模型配置。
  清单里写 `true` 会让整个插件加载失败,而不是「支持但没生效」;插件只能处理宿主通过
  `extract` / `chunk` / `enrich` 传入的单文件内容。以后要开放,`read_project` 应走宿主代理的
  按项目授权读取,`llm` 应走宿主受控的模型接口,密钥不进插件。
- 插件进程默认 `env_clear`,只拿到 `PATH` / `HOME=<插件目录>` / `TMPDIR=/tmp` /
  `KB_PLUGIN_API` / `KB_PLUGIN_NAME` / `KB_PLUGIN_DIR`;宿主不会把 API key、数据库口令传给插件。
- 安装插件是管理员操作;普通用户只能看到 `list_skills` 的摘要,看不到清单全文。
- 插件返回的 `rel_path` 会经过与上传相同的路径校验;不能借 `..` 写到数据目录外。
- 每次调用有超时、响应有大小上限;超时 / 坏 JSON / 非零退出后进程被杀掉,下一次调用重新拉起。
- 进程钩子失败一律回退,不会让文件索引失败;但会在日志里留 warn,便于定位。

## 7. 五个方向怎么落

| 方向 | 插件里的位置 |
|---|---|
| 索引策略 | `[index]` 的 `include` / `exclude` / `projects` / `lang` / `tags` / `priority` |
| 新格式解析 | `extract`(优先于内置抽取) |
| 知识生产规范 | 同目录的 `prompt` / `insight-template` skill,和插件清单互不影响 |
| 数据增强 | `chunk` 给更好的块边界,`enrich` 给块补上下文 |
| 来源连接 | `source` 接管网页来源;只重嵌入变化页面由既有的内容哈希短路保证 |

## 8. 已知限制

- `source` 目前只支持 `web`;`local_dir` / `git` / 上传还没有钩子。
- `read_project` / `llm` 还没有实际能力,清单里写 `true` 会直接拒绝加载:前者需要宿主代理
  按项目授权读取,后者需要模型代理;两者都要先设计清楚,不能只把开关打开。
- bwrap 依赖内核允许 user namespace(或 setuid bwrap)。容器里如果 namespace 被 seccomp / LSM
  拒绝,插件会退回到「只加载声明式部分」;此时设置页显示「没有沙箱」,不会静默裸跑。
- 插件进程按插件串行调用;一个慢插件会拖慢引用它的文件,但不会拖慢其他插件。
- 插件不能直接访问宿主的 embedding / LLM 配置;需要模型时由宿主在后续版本提供显式接口。
