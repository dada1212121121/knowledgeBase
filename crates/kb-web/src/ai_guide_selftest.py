#!/usr/bin/env python3
"""知识库接入自测:admin key -> 临时 MCP 令牌 -> MCP 握手 -> 写入 -> 读回 -> 清理。只用标准库。"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = "{{BASE}}"
ADMIN_KEY = "{{KEY}}"
TAG = "[kb-selftest]"
RUN = os.urandom(3).hex()  # 本次运行的编号:并发跑多份自测也不会互相撞名、互相清理
UA = "kb-selftest/1.0"

failed = False
cleanup = []  # 倒序执行的清理动作:(说明, 函数)


def step(ok, text, extra=""):
    global failed
    if not ok:
        failed = True
    print(("[OK]   " if ok else "[FAIL] ") + text + (("  " + extra) if extra else ""))
    return ok


def http(method, path, body=None, token=None, extra_headers=None):
    """返回 (状态码, 响应头, 文本)。网络错误抛 URLError。"""
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(BASE + path, data=data, method=method)
    request.add_header("User-Agent", UA)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", "Bearer " + token)
    for key, value in (extra_headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.headers, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read().decode("utf-8", "replace")


def api(method, path, body=None, token=None):
    status, _, text = http(method, path, body, token or ADMIN_KEY)
    try:
        payload = json.loads(text)
    except ValueError:
        payload = {"ok": False, "error": {"message": text[:200]}}
    return status, payload


def capability(name, args, token=None):
    status, payload = api("POST", "/api/v1/capabilities/" + name, args, token)
    return status, payload.get("data"), (payload.get("error") or {}).get("message", "")


def mcp(session, method, params=None, token=None, notification=False):
    """发一条 MCP JSON-RPC;响应可能是 JSON,也可能是 SSE 的 data: 行。返回 (头, 结果 dict)。"""
    message = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        message["params"] = params
    if not notification:
        message["id"] = int(time.time() * 1000) % 1000000
    headers = {"Accept": "application/json, text/event-stream"}
    if session:
        headers["Mcp-Session-Id"] = session
    status, response_headers, text = http("POST", "/mcp", message, token, headers)
    if notification:
        return response_headers, {"status": status}
    if status >= 400:
        return response_headers, {"error": {"message": "HTTP %d %s" % (status, text[:160])}}
    body = text.strip()
    if "data:" in body and not body.startswith("{"):
        lines = [line[5:].strip() for line in body.splitlines() if line.startswith("data:")]
        body = next((line for line in reversed(lines) if line.startswith("{")), "{}")
    try:
        return response_headers, json.loads(body)
    except ValueError:
        return response_headers, {"error": {"message": "无法解析响应:" + text[:160]}}


def tool_text(result):
    parts = (result.get("result") or {}).get("content") or []
    return "".join(part.get("text", "") for part in parts if isinstance(part, dict))


def run():
    print("本次运行编号 %s(令牌名 kb-selftest-%s,测试经验标题含 %s)" % (RUN, RUN, RUN))
    # 1. 服务在线
    status, _, _ = http("GET", "/api/v1/health")
    if not step(status == 200, "服务在线 GET /api/v1/health", "HTTP %d" % status):
        return

    # 2. admin key 有效
    status, payload = api("GET", "/api/v1/auth/me")
    user = ((payload.get("data") or {}).get("user") or {}).get("username")
    if not step(status == 200 and bool(user), "admin key 有效", "账号 %s" % user if user else "HTTP %d" % status):
        return

    # 3. 用 admin key 创建临时 MCP 令牌
    token_name = "kb-selftest-%s" % RUN
    status, payload = api("POST", "/api/v1/auth/tokens", {"name": token_name, "scope": "mcp"})
    data = payload.get("data") or {}
    token, token_id = data.get("token"), data.get("id")
    if not step(status == 200 and bool(token), "创建临时 MCP 令牌", token_name):
        return
    cleanup.append(("撤销临时令牌", lambda: api("DELETE", "/api/v1/auth/tokens/" + token_id)[0] in (200, 404)))

    # 4. MCP 握手并列出工具
    headers, result = mcp(None, "initialize", {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "kb-selftest", "version": "1.0"},
    }, token)
    session = headers.get("Mcp-Session-Id") or headers.get("mcp-session-id")
    if not step("result" in result, "MCP initialize", (result.get("error") or {}).get("message", "")):
        return
    mcp(session, "notifications/initialized", None, token, notification=True)
    _, listed = mcp(session, "tools/list", {}, token)
    names = [tool.get("name") for tool in (listed.get("result") or {}).get("tools", [])]
    need = ["search_knowledge", "save_insight", "get_item"]
    if not step(all(n in names for n in need), "MCP 工具列表含 %s" % "、".join(need), "共 %d 个工具" % len(names)):
        return

    # 5. 通过 MCP 写入一条测试经验
    title = "%s %s 接入自测" % (TAG, RUN)
    _, saved = mcp(session, "tools/call", {"name": "save_insight", "arguments": {
        "title": title,
        "body": "这是接入自测写入的临时数据,脚本结束时会自动删除。",
        "kind": "note",
        "tags": ["kb-selftest"],
        "global": True,
    }}, token)
    text = tool_text(saved)
    item_id = None
    try:
        item_id = json.loads(text).get("id")
    except (ValueError, AttributeError):
        pass
    if not step(bool(item_id), "MCP save_insight 写入测试经验", ("id=%s" % item_id) if item_id else (text or str(saved))[:160]):
        return
    cleanup.append(("删除测试经验", lambda: capability("delete_item", {"id": item_id})[0] in (200, 404)))

    # 6. 用 id 读回(立刻可用),并检索(向量异步生成,检索只是尽力而为)
    status, data, message = capability("get_item", {"id": item_id})
    got = json.dumps(data, ensure_ascii=False) if data else ""
    step(status == 200 and TAG in got, "读回测试经验 get_item", message)
    found = False
    for _ in range(10):
        _, hits = mcp(session, "tools/call", {"name": "search_knowledge", "arguments": {"query": title, "k": 5}}, token)
        if item_id in tool_text(hits):
            found = True
            break
        time.sleep(2)
    print(("[OK]   " if found else "[WARN] ") + "检索到测试经验 search_knowledge"
          + ("" if found else "  (20 秒内没搜到:向量可能还在生成,不算失败)"))


try:
    run()
except urllib.error.URLError as err:
    step(False, "网络错误", str(err))
finally:
    # 清理:倒序执行,每一项失败都要说出来,让人知道还有残留
    for label, action in reversed(cleanup):
        try:
            ok = action()
        except Exception as err:  # noqa: BLE001
            ok, label = False, "%s(%s)" % (label, err)
        if not ok:
            failed = True
        print(("[OK]   清理:" if ok else "[FAIL] 清理失败,需要手工处理:") + label)

print("\n结果:" + ("有步骤失败,见上面的 [FAIL]" if failed else "全部通过,接入成功"))
sys.exit(1 if failed else 0)
