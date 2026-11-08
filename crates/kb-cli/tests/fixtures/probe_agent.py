#!/usr/bin/env python3
"""多用户 ACP 隔离测试用的探针代理。

收到 prompt 后不问权限,直接在它自己的沙箱里做几件事并把结果写在回复里(一行 JSON):
- cwd:daemon 告诉它的工作目录;
- wrote:在 cwd 里写 marker.txt 是否成功;
- read:prompt 里 `probe:` 之后用分号隔开的每个路径能不能读到(能读返回 true);
- config_write:往 prompt 里 `config:` 指定的目录写文件是否成功;
- sleep:prompt 里有 `sleep:N` 就先睡 N 秒(模拟一轮对话很长,占着名额)。
"""
import json
import os
import sys
import time


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read():
    line = sys.stdin.readline()
    return json.loads(line) if line else None


def prompt_text(params):
    parts = []
    for block in params.get("prompt") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text") or "")
    return "\n".join(parts)


def can_read(path):
    try:
        if os.path.isdir(path):
            os.listdir(path)
        else:
            with open(path, "rb") as handle:
                handle.read(1)
        return True
    except OSError:
        return False


def cap_eff():
    """本进程的有效 capability 位图(沙箱里应当是 0)。"""
    try:
        with open("/proc/self/status") as handle:
            for line in handle:
                if line.startswith("CapEff:"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return "unknown"


def can_mknod():
    """能不能造块设备节点(有 CAP_MKNOD 就能读写宿主磁盘)。"""
    import stat
    target = "/tmp/probe-blk"
    try:
        os.mknod(target, stat.S_IFBLK | 0o600, os.makedev(259, 0))
        os.unlink(target)
        return True
    except OSError:
        return False


def can_write(path):
    try:
        with open(path, "w") as handle:
            handle.write("x")
        return True
    except OSError:
        return False


session = "s1"
cwd = "/tmp"
while True:
    msg = read()
    if msg is None:
        break
    method = msg.get("method")
    rid = msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": 1,
            "agentCapabilities": {"loadSession": False},
            "authMethods": [],
            "agentInfo": {"name": "probe-acp", "version": "0.1.0"},
        }})
    elif method == "session/new":
        cwd = (msg.get("params") or {}).get("cwd", cwd)
        send({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": session}})
    elif method == "session/prompt":
        text = prompt_text(msg.get("params") or {})
        facts = {"cwd": cwd}
        facts["cap_eff"] = cap_eff()
        facts["mknod"] = can_mknod()
        # 环境里有哪些 *_API_KEY(只报名字,不报值)
        facts["api_key_vars"] = sorted(k for k in os.environ if k.endswith("_API_KEY"))
        facts["wrote"] = can_write(os.path.join(cwd, "marker.txt"))
        facts["read"] = {}
        if "probe:" in text:
            spec = text.split("probe:", 1)[1].split("\n", 1)[0]
            for path in [p.strip() for p in spec.split(";") if p.strip()]:
                facts["read"][path] = can_read(path)
        if "config:" in text:
            target = text.split("config:", 1)[1].split("\n", 1)[0].strip()
            facts["config_write"] = can_write(os.path.join(target, "tamper.txt"))
        if "early:" in text:
            # 先吐一段回复再慢慢做:模拟一轮还没结束时就有了部分正文
            send({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": session,
                "update": {"sessionUpdate": "agent_message_chunk",
                           "content": {"type": "text", "text": "还没说完的半句话"}},
            }})
        if "sleep:" in text:
            try:
                time.sleep(float(text.split("sleep:", 1)[1].split()[0]))
            except (ValueError, IndexError):
                pass
        send({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": session,
            "update": {"sessionUpdate": "agent_message_chunk",
                       "content": {"type": "text", "text": json.dumps(facts, ensure_ascii=False)}},
        }})
        send({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "end_turn"}})
    elif method == "session/cancel":
        pass
