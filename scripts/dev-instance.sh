#!/usr/bin/env bash
# 多用户开发实例:和生产完全隔离的一套 daemon + 前端 + 收信服务。
#
# 数据 $KB_DEV_ROOT/home (默认 /opt/kb/home;与生产 /opt/kb/home 无关)
#   daemon   127.0.0.1:27878              (仅本机)
#   前端     http://127.0.0.1:28600       (scripts/serve.mjs 提供 web-ui/dist,/api 反代到 daemon)
#   收信     SMTP 127.0.0.1:1025,网页 http://127.0.0.1:8025(Mailpit,所有外发邮件都落在这里,不会真发)
#
# 用法: scripts/dev-instance.sh <init|build|start|stop|restart|status|logs|passwd|seed|reset|env>
#   init     建目录与 config.toml(已存在则保留)
#   build    cargo build -p kb-cli(增量)与 web-ui 构建(dist 比源码旧时)
#   start    起 Mailpit、daemon、前端静态服务
#   stop     全部停掉
#   passwd   设管理员密码(默认 dev-pass-123,可用 KB_DEV_PASSWORD 改)
#   seed     灌入示例笔记(需要已 start + passwd)
#   reset    停服并清空数据目录(需要 --yes)
#   env      打印可 eval 的环境变量(eval "$(scripts/dev-instance.sh env)" 后就能直接用 kb 命令连开发实例)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEV=${KB_DEV_ROOT:-/opt/kb}
HOME_DIR=$DEV/home
BIN_DIR=$DEV/bin
RUN_DIR=$DEV/run
LOG_DIR=$DEV/logs
DAEMON_PORT=${KB_DEV_DAEMON_PORT:-27878}
WEB_PORT=${KB_DEV_WEB_PORT:-28600}
SMTP_PORT=${KB_DEV_SMTP_PORT:-1025}
MAIL_UI_PORT=${KB_DEV_MAIL_UI_PORT:-8025}
KB_BIN=${KB_BIN:-$ROOT/target/debug/kb}
PASSWORD=${KB_DEV_PASSWORD:-dev-pass-123}
PROD_HOME=/opt/kb/home
MODELS_DIR=${KB_DEV_MODELS_DIR:-${HOME}/.cache/kb-models}

# 安全闸:任何情况下都不允许把开发实例指向生产数据目录
guard() {
  local real
  real=$(readlink -f "$HOME_DIR" 2>/dev/null || echo "$HOME_DIR")
  if [ "$real" = "$(readlink -f "$PROD_HOME")" ] || [ "$DAEMON_PORT" = "17878" ] || [ "$WEB_PORT" = "18600" ]; then
    echo "拒绝:开发实例不能使用生产的数据目录或端口($real / $DAEMON_PORT / $WEB_PORT)" >&2
    exit 4
  fi
}

# 后台启动:新会话(setsid)、标准输入关掉、输出进日志,这样调用方(终端、CI、工具)不会被后台进程拖住不返回
spawn() {
  local name=$1; shift
  setsid "$@" </dev/null >"$LOG_DIR/$name.log" 2>&1 &
  echo $! >"$RUN_DIR/$name.pid"
}

pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
stop_one() {
  local name=$1 pidfile=$RUN_DIR/$1.pid
  if pid_alive "$pidfile"; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    for _ in $(seq 1 20); do pid_alive "$pidfile" || break; sleep 0.5; done
    pid_alive "$pidfile" && kill -9 "$(cat "$pidfile")" 2>/dev/null || true
    echo "已停止 $name"
  fi
  rm -f "$pidfile"
}

cmd_init() {
  guard
  mkdir -p "$HOME_DIR" "$BIN_DIR" "$RUN_DIR" "$LOG_DIR"
  if [ ! -f "$HOME_DIR/config.toml" ]; then
    cat >"$HOME_DIR/config.toml" <<EOF
# 多用户开发实例配置(scripts/dev-instance.sh init 生成,可自行修改)
[server]
listen = "127.0.0.1:$DAEMON_PORT"

[paths]
# 与生产共用同一份只读模型缓存,避免再下载几个 GB
models_dir = "$MODELS_DIR"

[embed]
backend = "fastembed"
model = "bge-m3-int8"
preload = false
EOF
    echo "已写入 $HOME_DIR/config.toml"
  fi
  if [ ! -x "$BIN_DIR/mailpit" ]; then
    echo "缺少 $BIN_DIR/mailpit:从 https://github.com/axllent/mailpit/releases 下载 mailpit-linux-amd64.tar.gz 解压到该目录" >&2
  fi
}

cmd_build() {
  guard
  # shellcheck disable=SC1091
  . "$ROOT/scripts/env.sh"
  (cd "$ROOT" && cargo build -p kb-cli)
  if [ ! -d "$ROOT/web-ui/dist" ] || [ -n "$(find "$ROOT/web-ui/src" "$ROOT/web-ui/packages" -newer "$ROOT/web-ui/dist/index.html" -type f 2>/dev/null | head -1)" ]; then
    (cd "$ROOT/web-ui" && npm run build)
  else
    echo "web-ui/dist 已是最新"
  fi
}

wait_http() {
  local url=$1 tries=${2:-60}
  for _ in $(seq 1 "$tries"); do
    curl -fsS -m 3 -o /dev/null "$url" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

cmd_start() {
  guard
  cmd_init
  [ -x "$KB_BIN" ] || { echo "找不到 $KB_BIN,先运行 scripts/dev-instance.sh build" >&2; exit 1; }
  if [ -x "$BIN_DIR/mailpit" ] && ! pid_alive "$RUN_DIR/mailpit.pid"; then
    spawn mailpit "$BIN_DIR/mailpit" --smtp "127.0.0.1:$SMTP_PORT" --listen "127.0.0.1:$MAIL_UI_PORT" --database "$DEV/mailpit.db"
  fi
  if ! pid_alive "$RUN_DIR/daemon.pid"; then
    (cd "$HOME_DIR" && KB_HOME="$HOME_DIR" spawn daemon "$KB_BIN" daemon)
  fi
  wait_http "http://127.0.0.1:$DAEMON_PORT/api/v1/health" 90 || { echo "daemon 没有在 90 秒内就绪,见 $LOG_DIR/daemon.log" >&2; exit 1; }
  if [ -d "$ROOT/web-ui/dist" ] && ! pid_alive "$RUN_DIR/web.pid"; then
    KBASE_PORT=$WEB_PORT KBD_PORT=$DAEMON_PORT KBASE_WEB="$ROOT/web-ui/dist" spawn web node "$ROOT/scripts/serve.mjs"
    wait_http "http://127.0.0.1:$WEB_PORT/" 15 || echo "前端静态服务没起来,见 $LOG_DIR/web.log" >&2
  fi
  cmd_status
}

cmd_stop() {
  stop_one web
  stop_one daemon
  stop_one mailpit
}

cmd_status() {
  local name state
  for name in daemon web mailpit; do
    if pid_alive "$RUN_DIR/$name.pid"; then state="运行中 (pid $(cat "$RUN_DIR/$name.pid"))"; else state="未运行"; fi
    printf '%-8s %s\n' "$name" "$state"
  done
  echo "daemon   http://127.0.0.1:$DAEMON_PORT"
  echo "前端     http://127.0.0.1:$WEB_PORT"
  echo "收信箱   http://127.0.0.1:$MAIL_UI_PORT   (SMTP 127.0.0.1:$SMTP_PORT,无认证,无 TLS)"
  echo "数据     $HOME_DIR"
}

cmd_logs() { tail -n "${2:-80}" -f "$LOG_DIR/${1:-daemon}.log"; }

cmd_passwd() {
  guard
  printf '%s\n' "$PASSWORD" | KB_HOME="$HOME_DIR" "$KB_BIN" auth set-password
  echo "管理员密码已设为 $PASSWORD(开发实例专用)"
}

cmd_seed() {
  guard
  KB_DEV_BASE="http://127.0.0.1:$DAEMON_PORT" KB_DEV_PASSWORD="$PASSWORD" node "$ROOT/scripts/dev-seed.mjs"
}

cmd_reset() {
  guard
  [ "${2:-}" = "--yes" ] || { echo "这会删除 $HOME_DIR 下的全部开发数据。确认请加 --yes" >&2; exit 2; }
  cmd_stop
  rm -rf "$HOME_DIR" "$DEV/mailpit.db"
  echo "已清空 $HOME_DIR"
}

cmd_env() {
  echo "export KB_HOME=$HOME_DIR"
  echo "export KB_BASE_URL=http://127.0.0.1:$DAEMON_PORT"
}

case "${1:-}" in
  init) cmd_init ;;
  build) cmd_build ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  logs) cmd_logs "${2:-daemon}" ;;
  passwd) cmd_passwd ;;
  seed) cmd_seed ;;
  reset) cmd_reset "$@" ;;
  env) cmd_env ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
