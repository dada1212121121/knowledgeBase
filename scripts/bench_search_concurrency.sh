#!/usr/bin/env bash
# 检索并发压测:// 共用。
#
# 口径:
# - 默认不带 explain。explain=true 会额外跑一遍纯 FTS + 纯向量,尾延迟和 CPU 都会偏高,
# 不能拿来当用户请求的基线(见 实测报告)。
# - 默认 project 为空 = 全库;`--project knowledgebase` 只测该项目 + _global,这是多数用户的真实 scope。
# - `--pending` 只是给输出打标签。实际积压必须由 的 `kb index --text-only` 造出来,
#   脚本不会伪造 pending 行,也不会改数据库。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${KB_BASE:-http://127.0.0.1:17878}"
TOKEN="${KB_TOKEN:-${KB_BENCH_TOKEN:-}}"
PROJECT="${KB_BENCH_PROJECT:-}"
CONCURRENCY="1,8,32,100"
PENDING="0"
REQUESTS="${KB_BENCH_REQUESTS:-50}"
PID="${KB_BENCH_PID:-}"
QUERIES="${KB_BENCH_QUERIES:-$ROOT/eval/golden.toml}"
EXPLAIN=0
TIMEOUT=120

usage() {
  cat <<'EOF'
用法: scripts/bench_search_concurrency.sh [选项]

必填环境变量:
  KB_TOKEN        API token(有 api scope);不会打印到输出

选项:
  --base URL         默认 http://127.0.0.1:17878
  --project NAME     短名,如 knowledgebase;不传=全库
  --concurrency LIST 默认 1,8,32,100
  --requests N       每档请求数,默认 50
  --pid PID          守护进程 PID,用于统计 CPU;不传则 cpu_s=0
  --queries FILE     默认 eval/golden.toml
  --pending LIST     默认 0;如 0,50,90,只作为标签
  --explain          打开 explain(会多跑 FTS/向量,仅用于分解耗时,不用于门槛)
  --timeout SEC      单请求超时,默认 120
  -h, --help

示例:
  KB_TOKEN=... scripts/bench_search_concurrency.sh --project knowledgebase --concurrency 1,8,32,100
  KB_TOKEN=... scripts/bench_search_concurrency.sh --project knowledgebase --pending 0,50,90

注意:
  --pending 不会造积压。先跑 `kb index --text-only` 留下 pending,再运行本脚本;
  未造积压却标 50/90 的结果无效。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --concurrency) CONCURRENCY="$2"; shift 2 ;;
    --requests) REQUESTS="$2"; shift 2 ;;
    --pid) PID="$2"; shift 2 ;;
    --queries) QUERIES="$2"; shift 2 ;;
    --pending) PENDING="$2"; shift 2 ;;
    --explain) EXPLAIN=1; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$TOKEN" ]] || { echo "缺少 KB_TOKEN" >&2; exit 2; }
[[ -f "$QUERIES" ]] || { echo "找不到查询文件: $QUERIES" >&2; exit 2; }
[[ -n "$PID" && ! -r "/proc/$PID/stat" ]] && { echo "PID 不可读: $PID" >&2; exit 2; }

# 查询正文从黄金集里取;只取单行 query = "...",黄金集的格式由 kb eval 锁定。
mapfile -t QUERY_LIST < <(python3 - "$QUERIES" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
for q in re.findall(r'^query = "(.*)"$', text, re.M):
    print(q.replace('\\"', '"').replace('\\\\', '\\'))
PY
)
[[ ${#QUERY_LIST[@]} -gt 0 ]] || { echo "查询文件里没有 query" >&2; exit 2; }

export BASE TOKEN PROJECT REQUESTS PID QUERIES EXPLAIN TIMEOUT PENDING
python3 - "$CONCURRENCY" "${QUERY_LIST[@]}" <<'PY'
import concurrent.futures as cf
import json, os, statistics, sys, time, urllib.request

concs = [int(x) for x in sys.argv[1].split(",") if x.strip()]
queries = sys.argv[2:]
base = os.environ["BASE"].rstrip("/")
url = base + "/api/v1/capabilities/search_knowledge"
token = os.environ["TOKEN"]
project = os.environ.get("PROJECT", "")
explain = os.environ.get("EXPLAIN") == "1"
timeout = float(os.environ.get("TIMEOUT", "120"))
requests = max(1, int(os.environ.get("REQUESTS", "50")))
pid = os.environ.get("PID", "")
pending_labels = [x.strip() for x in os.environ.get("PENDING", "0").split(",") if x.strip()]

def cpu_seconds():
    if not pid:
        return 0.0
    fields = open(f"/proc/{pid}/stat").read().split()
    return (int(fields[13]) + int(fields[14])) / os.sysconf("SC_CLK_TCK")

def pick(n):
    # 查询数不足时循环复用,保证每档请求数一致。
    return [queries[i % len(queries)] for i in range(n)]

def one(q):
    body = {"query": q, "k": 5, "explain": explain}
    if project:
        body["project"] = project
    raw = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(
        url, data=raw,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            payload = json.load(response)
        data = payload.get("data") or {}
        timings = data.get("timings") or {}
        return {
            "ms": (time.perf_counter() - started) * 1000,
            "ok": payload.get("ok") is True,
            # `timings` 只在 explain=true 时返回;门槛档不带 explain,queue 记 0 是预期口径,
            # 排队行为用 --explain 冒烟档单独观察,不混进 p95。
            "queue": timings.get("queue_ms", 0.0) if explain else 0.0,
            "error": None,
        }
    except Exception as exc:
        return {"ms": (time.perf_counter() - started) * 1000, "ok": False, "queue": 0.0, "error": repr(exc)}

def pct(values, q):
    values = sorted(values)
    if not values:
        return 0.0
    return values[round((len(values) - 1) * q)]

# 预热一次,不进入统计;避免模型/索引首次 mmap 污染第一档。
one(queries[0])

for label in pending_labels:
    if label != "0" and os.environ.get("KB_PENDING_READY") != "1":
        print(
            f"警告: --pending {label} 只是标签;未设置 KB_PENDING_READY=1。"
            "请先用 --text-only 造积压,否则该档无效。",
            file=sys.stderr,
        )
    for conc in concs:
        batch = pick(requests)
        cpu0 = cpu_seconds()
        t0 = time.perf_counter()
        with cf.ThreadPoolExecutor(max_workers=conc) as pool:
            results = list(pool.map(one, batch))
        wall = time.perf_counter() - t0
        cpu1 = cpu_seconds()
        ok = [r for r in results if r["ok"]]
        lat = [r["ms"] for r in ok]
        queue = [r["queue"] for r in ok]
        print(json.dumps({
            "scope": project or "all",
            "pending": label,
            "explain": explain,
            "concurrency": conc,
            "requests": len(batch),
            "ok": len(ok),
            "wall_s": round(wall, 2),
            "qps": round(len(ok) / wall, 2) if wall else 0.0,
            "p50_ms": round(pct(lat, .5), 1),
            "p95_ms": round(pct(lat, .95), 1),
            "p99_ms": round(pct(lat, .99), 1),
            "max_ms": round(max(lat, default=0.0), 1),
            "queue_p50_ms": round(pct(queue, .5), 1),
            "queue_p95_ms": round(pct(queue, .95), 1),
            "cpu_s": round(cpu1 - cpu0, 2),
            "errors": [r["error"] for r in results if not r["ok"]][:3],
        }, ensure_ascii=False), flush=True)
PY
