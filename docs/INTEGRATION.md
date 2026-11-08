# 接入 AI 客户端(kb mcp)

`kb mcp` 是一个 MCP stdio 服务:客户端通过标准输入输出与它对话,它再把调用转发给本机守护进程
(`kb daemon`)。**守护进程没在跑时,`kb mcp` 会自动用 `kb daemon --detach` 拉起来**(最多等 60 秒)。

配置片段可以用 `kb integrate <客户端>` 打印,加 `--apply` 会先备份再写入(Claude Code 除外,
它用自己的命令管理配置)。

## Kiro CLI

```jsonc
// ~/.kiro/settings/mcp.json
{
  "mcpServers": {
    "kb": { "command": "kb", "args": ["mcp"], "timeout": 120000 }
  }
}
```

```bash
kb integrate kiro --apply     # 合并进 mcpServers,保留其它 server;写前备份 *.bak-kb-<时间戳>
```

## Claude Code

```bash
claude mcp add --scope user kb -- kb mcp
```

Claude Code 自己管理配置文件,`kb integrate claude --apply` 会提示改用上面这条命令。

## Codex

```toml
# ~/.codex/config.toml
[mcp_servers.kb]
command = "kb"
args = ["mcp"]
```

```bash
kb integrate codex --apply    # 追加 [mcp_servers.kb],写前备份
```

## 远程接入(`/mcp`,streamable HTTP)

`kb mcp` 走 stdio,只适合本机客户端。远程客户端(例如云端助手)用守护进程上的 **`/mcp`** 端点,
协议是 MCP 的 streamable HTTP。

### 1. 开启

`/mcp` **默认关闭**。在 `<KB_HOME>/config.toml` 里显式打开:

```toml
[mcp]
transports = ["stdio", "http"]   # 默认 ["stdio"];只写 "http" 也能用
```

只开 `stdio` 时 `/mcp` 返回 **404**。

### 2. 生成 token

```bash
kb mcp token            # 不存在就生成,打印路径与 token
kb mcp token --rotate   # 轮换(旧 token 立即失效)
```

token 存在 `<KB_HOME>/run/mcp-token`,权限 **0600**。守护进程启动时检查文件存在;启用了 http 却没有
token 文件会直接启动失败并提示先运行 `kb mcp token`。**校验时每次都重新读文件**,所以 `--rotate`
之后旧 token 立即失效、新 token 立即生效,不需要重启守护进程。

### 3. 反向代理暴露 https

本项目**不内置 TLS**,也默认只监听 `127.0.0.1`;对外请用自己的反向代理或隧道。

`/mcp` 会校验 `Host` 头(防 DNS rebinding),默认只允许 `localhost` / `127.0.0.1` / `::1`。
经反向代理暴露时**二选一**:

- 在 `config.toml` 里把外部域名加进白名单(推荐):

  ```toml
  [mcp]
  transports = ["stdio", "http"]
  allowed_hosts = ["kb.example.com", "kb.example.com:443"]
  ```

- 或让代理把 `Host` 改写成上游地址(nginx:`proxy_set_header Host 127.0.0.1:7878;`,
  Caddy:`header_up Host {upstream_hostport}`)。

Caddy(自动证书):

```caddyfile
kb.example.com {
    reverse_proxy 127.0.0.1:7878
    # 若没有配置 mcp.allowed_hosts,改成:
    # reverse_proxy 127.0.0.1:7878 { header_up Host {upstream_hostport} }
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name kb.example.com;
    ssl_certificate     /etc/letsencrypt/live/kb.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/kb.example.com/privkey.pem;

    location /mcp {
        proxy_pass http://127.0.0.1:7878;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_buffering off;              # SSE 需要
        proxy_read_timeout 3600s;
    }
}
```

隧道(frp / cloudflared)同理,把远端端口映射到 `127.0.0.1:7878`。

### 4. 客户端配置

远程客户端填写的 URL 与鉴权头:

```
URL:    https://kb.example.com/mcp
Header: Authorization: Bearer <kb mcp token 打印出来的值>
```

`Accept` 建议带 `application/json, text/event-stream`(SSE 回退)。

### 4.1 REST 调用者注意:自定义头要百分号编码

`X-KB-Cwd` / `X-KB-Project` / `X-KB-Client` 的值**建议一律用百分号编码**
(`kb_core::pct::encode`:非 ASCII 与 `%` 转成 `%XX`,空格转 `%20`)。服务端的实际规则:

| 头里的内容 | 结果 |
|---|---|
| 百分号编码后的值(推荐) | 200,按解码后的值使用 |
| 纯 ASCII 路径(如 `/srv/workspace/demo`) | 200(向后兼容,可以直接写) |
| 未编码的空格 | 200(同上,但不建议依赖) |
| 形如合法转义的原始字符(如 `/tmp/a%41b`) | 200,但会被**误解码**成 `/tmp/aAb` —— 不要依赖 |
| 非 ASCII 字节(未编码的中文)、不合法的 `%XX`(如 `%zz` / `%+1`)、截断的 `%`、十六进制合法但解码后不是 UTF-8(如 `%FF`) | **400 `invalid_input`** |

非 Rust 的调用者可以用:

```bash
python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe="/"))' "/srv/workspace/我的 项目"
# → /srv/workspace/%E6%88%91%E7%9A%84%20%E9%A1%B9%E7%9B%AE
```

```bash
# 目录 /srv/workspace/我的 项目 → /srv/workspace/%E6%88%91%E7%9A%84%20%E9%A1%B9%E7%9B%AE
curl --unix-socket "$KB_HOME/run/kb.sock" \
  -H "X-KB-Cwd: /srv/workspace/%E6%88%91%E7%9A%84%20%E9%A1%B9%E7%9B%AE" \
  -H 'content-type: application/json' \
  -d '{"query":"双哈希"}' \
  http://localhost/api/v1/capabilities/search_knowledge
```

### 5. 安全约定

- `/mcp` 只挂在 TCP 监听上,UDS 上不存在;TCP 上的其它路径在默认配置下一律 401。
- 每个请求都校验 `Authorization: Bearer`,无 token / 错 token 一律 **401**。
- 校验 `Origin` 头防 DNS rebinding:默认只允许 `http://127.0.0.1:<端口>` 与
  `http://localhost:<端口>`;经代理暴露时,请求的 `Origin` 若不是这两个(浏览器场景)会被 **403**,
  非浏览器客户端(不带 `Origin`)不受影响。
- token 用常量时间比较,避免时序侧信道。

### 6. 远程模式的协议版本

`/mcp` 与 stdio 共用同一个 `Bridge`,协商逻辑相同。端到端测试(`crates/kb-cli/tests/e2e_mcp.rs`)
对远程模式跑过四个版本:`2024-11-05` / `2025-03-26` / `2025-06-18` / `2025-11-25` 均原样协商,
未知版本 `2025-07-01` 协商为 **`2025-11-25`**(与 stdio 一致，见下表)。

**真实远程客户端(云端助手)协商出的版本待验证**——用上面的反向代理接一个真实客户端后,
从日志取:

```bash
grep "MCP 客户端已连接" ~/.kb/logs/kb.log.* | tail -3
#   → client=<name> protocol=<版本>
```

## 未验证的客户端

Cursor、Gemini CLI 的 MCP 配置方式**未调研、未验证**;它们的格式与上面的不一定相同,
请以各自文档为准。

## 工具清单

MCP 面共 16 个工具(`crates/kb-web/tests/router.rs` 里有断言):`search_knowledge`、`search_code`、`get_item`、
`list_collections`、`list_projects`、`job_list`、`list_ingest`、`save_insight`、`kb_feedback`、`reindex_project`、
`doc_read`、`doc_edit`、`check_links`、`list_files`、`doc_links`,以及只给本机 stdio 用的 `agent_history`。
经网络 `/mcp` 用令牌连接时是前 15 个:`agent_history` 对远程令牌返回 403(`crates/kb-web/src/api/`)。
工具列表来自守护进程的 `GET /api/v1/capabilities?surface=mcp`,`kb mcp` 缓存 60 秒。

写笔记 / 改文档时怎么引用已有文件和模板,见 [用户指南 7.4.1](guide/USER_GUIDE.md#note-links);
这里只列工具:`list_files` 用来找准确路径,`save_insight` 用 `collection` 指定集合、用 `strict_links`
在写库前拒绝坏引用,`check_links` 做批量体检,`doc_links` 查谁引用了我。Agent 不能上传文件,
模板和附件必须先由人在网页上传,Agent 只引用已存在的路径。

## 协议版本协商

`kb mcp` 覆盖了 `ServerHandler::initialize`,调用 rmcp 的 `negotiate_initialize` 完成协商,
并把 `clientInfo.name` 与协商出的 `protocolVersion` 写进日志(不写 stdout)。

已验证(端到端测试 `cargo test -p kb-cli --features testkit --test e2e_mcp`,测试用的客户端名是 `kiro`):

| 请求的 protocolVersion | 协商结果 |
|---|---|
| `2024-11-05` | 原样 |
| `2025-03-26` | 原样 |
| `2025-06-18` | 原样 |
| `2025-11-25` | 原样 |
| `2025-07-01`(未知) | **`2025-11-25`**(rmcp 的最高可初始化版本，见下表) |

`2026-07-28` 不在测试范围内:该版本用 per-request `_meta` 承载生命周期,没有 `initialize` 握手。

**三个真实客户端各自协商出的版本:待验证。** 本会话没有在 Kiro / Claude Code / Codex 里实际
跑过一次(会修改用户的客户端配置且需要交互式会话)。验证方法:

```bash
# 1) 让客户端连上 kb(以 Kiro 为例)
kb integrate kiro --apply
# 2) 在该客户端里问一句,让它调用 search_knowledge
# 3) 从日志里读协商结果(默认写到 <KB_HOME>/logs/kb.log)
grep "MCP 客户端已连接" ~/.kb/logs/kb.log.* | tail -3
#   → client=kiro protocol=2025-06-18 之类
```

拿到三行日志后,把实际版本补进上表。
