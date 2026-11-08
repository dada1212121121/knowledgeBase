#!/bin/bash
# 升级 / 回滚预发演练(单用户 → 多用户):在**临时数据目录**里走一遍
#   旧二进制建数据 → 新二进制升级 → 挪走 system.db 回滚到旧二进制 → 再升级
# 每一步都检查:能用旧密码登录、旧笔记还在。任何一步不对就非零退出。
#
# 用法:
#   scripts/rehearse-upgrade.sh <旧二进制> [新二进制]
# 例:scripts/rehearse-upgrade.sh /opt/kb/bin/kb target/release/kb
#
# 只读使用旧二进制(拿它起一个守护进程,数据目录在 /tmp 下),不碰生产数据目录、不部署任何东西。
# 用真实的本机嵌入模型(默认读 ~/.cache/kb-models),所以需要模型缓存在;首次启动要等十几秒加载。
set -u

OLD=${1:?用法: $0 <旧二进制> [新二进制]}
NEW=${2:-$(dirname "$0")/../target/release/kb}
WORK=${REHEARSE_DIR:-/tmp/kb-rehearsal}
PORT=${REHEARSE_PORT:-17979}
PASSWORD='rehearsal-password-1'
export KB_HOME="$WORK/home"

# 安全闸:数据目录必须在临时位置,绝不能指到生产或开发数据目录上
case "$KB_HOME" in
  /tmp/*|/var/tmp/*) ;;
  *) echo "拒绝:演练目录必须在 /tmp 或 /var/tmp 下(现在是 $KB_HOME)"; exit 2 ;;
esac
[ -x "$OLD" ] || { echo "旧二进制不可执行: $OLD"; exit 2; }
[ -x "$NEW" ] || { echo "新二进制不可执行: $NEW"; exit 2; }
# 访问本机端口不走代理(其余代理环境保持原样,模型缓存校验可能要用)
export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1

rm -rf "$WORK"; mkdir -p "$KB_HOME" "$WORK/parked"
cat > "$KB_HOME/config.toml" <<CFG
[server]
listen = "127.0.0.1:$PORT"
[embed]
backend = "fastembed"
model = "bge-m3-int8"
preload = false
threads = 2
CFG

PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; }
trap cleanup EXIT
fail() { echo "✗ 演练失败:$*"; exit 1; }

start() { # $1=二进制 $2=日志名
  nohup "$1" daemon >"$WORK/$2.log" 2>&1 &
  PID=$!
  for _ in $(seq 1 300); do
    kill -0 "$PID" 2>/dev/null || fail "$2 的守护进程退出了:$(tail -3 "$WORK/$2.log")"
    curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1 && [ -S "$KB_HOME/run/kb.sock" ] && return 0
    sleep 0.3
  done
  fail "$2 在 90 秒内没起来"
}
stop() {
  kill "$PID" 2>/dev/null
  for _ in $(seq 1 100); do kill -0 "$PID" 2>/dev/null || { PID=""; return 0; }; sleep 0.2; done
  kill -9 "$PID"; PID=""
}
login() { # 用法: login '<json>' → 打印 cookie
  curl -sS -i -X POST "http://127.0.0.1:$PORT/api/v1/auth/login" -H 'content-type: application/json' -d "$1" \
    | grep -i '^set-cookie:' | head -1 | sed 's/^[^:]*: *//; s/;.*//'
}
cap() { curl -sS -X POST "http://127.0.0.1:$PORT/api/v1/capabilities/$2" -H 'content-type: application/json' -H 'X-KB-CSRF: 1' -H "cookie: $1" -d "$3"; }
has_note() { # 经 API 列出 _global 的条目,要求里面有「旧版笔记」
  cap "$1" list_items '{"collection":"_global","page_size":50}' | grep -q '旧版笔记'
}
note_in_sqlite() { # 直接读元数据库(只读),确认数据本身没丢
  python3 - "$KB_HOME/meta.db" <<'PY'
import sqlite3, sys
con = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
titles = [row[0] for row in con.execute("select title from insights")]
version = con.execute("pragma user_version").fetchone()[0]
print(f"   meta.db: schema v{version}, 条目 {titles}")
sys.exit(0 if "旧版笔记" in titles else 1)
PY
}
step() { echo; echo "== $*"; }
ok() { echo "✓ $*"; }

step "1. 旧二进制建数据"
start "$OLD" old1
printf '%s\n' "$PASSWORD" | "$OLD" auth set-password >/dev/null || fail "设置密码失败"
C=$(login "{\"password\":\"$PASSWORD\"}"); [ -n "$C" ] || fail "旧二进制登不上"
cap "$C" create_item '{"collection":"_global","title":"旧版笔记","body":"升级前写的内容","kind":"note"}' | grep -q '"ok":true' || fail "建笔记失败"
for _ in $(seq 1 90); do has_note "$C" && break; sleep 2; done
has_note "$C" || fail "笔记没有嵌入完成"
note_in_sqlite || fail "元数据库里没有笔记"
stop; ok "旧版本数据就绪"

step "2. 新二进制升级(零操作)"
start "$NEW" new1
C=$(login "{\"login\":\"admin\",\"password\":\"$PASSWORD\"}"); [ -n "$C" ] || fail "升级后 admin 不能用旧密码登录"
has_note "$C" || fail "升级后看不到旧笔记"
[ -f "$KB_HOME/system.db" ] || fail "没有建出 system.db"
note_in_sqlite || fail "升级后元数据库里没有笔记"
stop; ok "旧密码可登录(账号 admin),旧笔记在,system.db 已建出"

step "3. 回滚:挪走 system.db,旧二进制接着用"
mv "$KB_HOME"/system.db* "$WORK/parked/"
start "$OLD" old2
C=$(login "{\"password\":\"$PASSWORD\"}"); [ -n "$C" ] || fail "回滚后旧二进制登不上"
has_note "$C" || fail "回滚后旧二进制看不到旧笔记"
note_in_sqlite || fail "回滚后元数据库里没有笔记"
stop; ok "旧二进制在升级过的数据目录上正常工作(它不认识新表,但不受影响)"

step "4. 再升级(把 system.db 放回去)"
mv "$WORK"/parked/system.db* "$KB_HOME/"
start "$NEW" new2
C=$(login "{\"login\":\"admin\",\"password\":\"$PASSWORD\"}"); [ -n "$C" ] || fail "再升级后 admin 登不上"
has_note "$C" || fail "再升级后看不到旧笔记"
stop; ok "再升级正常"

echo; echo "全部通过:升级 → 回滚 → 再升级都能登录并读到全部旧数据。演练目录:$WORK"
