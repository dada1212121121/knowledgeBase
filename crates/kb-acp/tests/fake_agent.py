#!/usr/bin/env python3
"""最小的 ACP 代理(测试用):initialize / session/new / session/prompt / 权限请求。

prompt 时先发两个权限请求:
1. 写 /etc/passwd(不在工作目录内,客户端应直接拒绝);
2. 写 <cwd>/note.txt(在工作目录内,客户端会问界面)。
"""
import json
import os
import sys

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def read():
    line = sys.stdin.readline()
    if not line:
        return None
    return json.loads(line)

def ask_permission(request_id, title, path, kind="edit"):
    send({"jsonrpc": "2.0", "id": request_id, "method": "session/request_permission", "params": {
        "sessionId": session,
        "toolCall": {
            "toolCallId": f"t{request_id}",
            "title": title,
            "kind": kind,
            "locations": [{"path": path}],
        },
        "options": [
            {"optionId": "allow", "name": "允许", "kind": "allow_once"},
            {"optionId": "deny", "name": "拒绝", "kind": "reject_once"},
        ],
    }})
    while True:
        reply = read()
        if reply is None:
            sys.exit(0)
        if reply.get("id") == request_id:
            outcome = reply.get("result", {}).get("outcome", {})
            return outcome.get("optionId", "cancelled")

def mcp_search(spec, mentioned):
    """拉起会话里配的 kb mcp,确认 agent.sock 令牌能检索。"""
    import subprocess

    env = os.environ.copy()
    for item in spec.get("env") or []:
        if isinstance(item, dict) and item.get("name"):
            env[str(item["name"])] = str(item.get("value") or "")
    command = spec.get("command")
    if not command:
        return "fail", ""
    proc = subprocess.Popen(
        [command, *spec.get("args", [])],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
        text=True,
    )

    def rpc(obj):
        proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        return json.loads(line) if line else {}

    try:
        rpc(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "fake", "version": "0"},
                },
            }
        )
        proc.stdin.write(
            json.dumps(
                {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}
            )
            + "\n"
        )
        proc.stdin.flush()
        listed = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        names = [
            tool.get("name")
            for tool in listed.get("result", {}).get("tools", [])
            if isinstance(tool, dict)
        ]
        called = rpc(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "search_knowledge",
                    "arguments": {"query": "hello"},
                },
            }
        )
        search = "ok" if "search_knowledge" in names and called.get("error") is None else "fail"
        extra = ""
        if mentioned:
            cited = history_status(
                rpc(
                    {
                        "jsonrpc": "2.0",
                        "id": 4,
                        "method": "tools/call",
                        "params": {
                            "name": "agent_history",
                            "arguments": {"session_id": mentioned[0]},
                        },
                    }
                )
            )
            denied = history_status(
                rpc(
                    {
                        "jsonrpc": "2.0",
                        "id": 5,
                        "method": "tools/call",
                        "params": {
                            "name": "agent_history",
                            "arguments": {
                                "session_id": "00000000-0000-0000-0000-000000000000"
                            },
                        },
                    }
                )
            )
            extra = f" 引用历史:{cited} 越权历史:{denied}"
        return search, extra
    except Exception:
        return "fail", ""
    finally:
        proc.kill()


def history_status(called):
    result = called.get("result") or {}
    content = result.get("content") or []
    text = ""
    if content and isinstance(content[0], dict):
        text = content[0].get("text") or ""
    if result.get("isError") or text.startswith("forbidden"):
        return "403"
    if '"messages"' in text or "messages" in text:
        return "ok"
    return "fail"


def mentioned_sessions(params):
    blob = json.dumps(params, ensure_ascii=False)
    marker = "kb://session/"
    found = []
    rest = blob
    while True:
        index = rest.find(marker)
        if index < 0:
            break
        tail = rest[index + len(marker) :]
        end = len(tail)
        for pos, ch in enumerate(tail):
            if ch in ")\n\r\t \"\\":
                end = pos
                break
        session_id = tail[:end]
        if session_id and session_id not in found:
            found.append(session_id)
        rest = tail[end:]
    return found


session = "s1"
mcp_count = 0
mcp_spec = None
mcp_shape = ""
cwd = "/tmp"
resumed = False
while True:
    msg = read()
    if msg is None:
        break
    method = msg.get("method")
    rid = msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": 1,
            "agentCapabilities": {"loadSession": True},
            "authMethods": [],
            "agentInfo": {"name": "fake-acp", "version": "0.1.0"},
        }})
    elif method == "session/new":
        params = msg.get("params", {})
        servers = params.get("mcpServers") or []
        mcp_count = len(servers)
        mcp_shape = ""
        for server in servers:
            if not isinstance(server, dict):
                continue
            mcp_shape = ",".join(server.keys())
            spec = server.get("stdio") if isinstance(server.get("stdio"), dict) else server
            if spec.get("type") == "stdio" or spec.get("command"):
                mcp_spec = spec
                break
        cwd = params.get("cwd", cwd)
        send({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": session}})
    elif method == "session/load":
        send({"jsonrpc": "2.0", "id": rid, "result": {}})
        resumed = True
    elif method == "session/prompt":
        outside = ask_permission(100, "写 /etc/passwd", "/etc/passwd")
        inside = ask_permission(101, "写工作目录里的文件", os.path.join(cwd, "note.txt"))
        send({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": session,
            "update": {"sessionUpdate": "agent_message_chunk",
                       "content": {"type": "text", "text": f"权限结果1:{outside} 权限结果2:{inside}\n"}},
        }})
        mentioned = mentioned_sessions(msg.get("params") or {})
        mcp_status, history_note = (
            mcp_search(mcp_spec, mentioned) if isinstance(mcp_spec, dict) else (f"skip:{mcp_shape}", "")
        )
        send({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": session,
            "update": {"sessionUpdate": "agent_message_chunk",
                       "content": {"type": "text", "text": f"你好,我是假代理。MCP:{mcp_count} MCP调用:{mcp_status}{history_note}"}},
        }})
        send({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "end_turn"}})
    elif method == "session/cancel":
        pass
