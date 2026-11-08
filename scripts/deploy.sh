#!/usr/bin/env bash
# 生产更新:从 git 归档当前 ref,构建管理端和 kb,替换二进制并重启。
# 不读取 GIT_CONFIG_*。路径按这台机器的 /opt/kb 布局。
# 用法: scripts/deploy.sh [git-ref,默认 main]
# 环境变量: SKIP_WEB=1 跳过前端,SKIP_KBD=1 跳过守护进程二进制,SKIP_CONVERT=1 不装 LibreOffice,
# SKIP_OFFICE_WORKER=1 不装办公文档协同的依赖,ALLOW_BRANCH=1 允许部署非 main 的引用。
set -euo pipefail
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 || true
REPO=${REPO:-/srv/kb}
BASE=${BASE:-/opt/kb}
REF=${1:-main}
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:/usr/local/bin:${PATH}"
# config.toml 的 [convert] 段里有没有 `enabled = true`(只看这一段,别段的 enabled 不算)
convert_enabled() {
  [ -f "$1" ] && awk '/^\[/{ in_convert = ($0 ~ /^\[convert\][ \t]*(#.*)?$/) } in_convert && /^[ \t]*enabled[ \t]*=[ \t]*true([ \t]|#|$)/ { found = 1 } END { exit !found }' "$1"
}
exec 9>"$BASE/.deploy.lock"
flock -n 9 || { echo "deploy already running"; exit 1; }
SHA=$(git -C "$REPO" rev-parse --short "$REF")
echo "== deploying $SHA"
# 护栏(多用户开发期):默认只部署 main;其它引用(开发分支、未合并提交)要显式 ALLOW_BRANCH=1
MAIN_SHA=$(git -C "$REPO" rev-parse --short main)
if [ "$SHA" != "$MAIN_SHA" ] && [ -z "${ALLOW_BRANCH:-}" ]; then
  echo "拒绝部署 $REF($SHA):它不是 main($MAIN_SHA)。确认要部署开发分支请加 ALLOW_BRANCH=1" >&2
  exit 3
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git -C "$REPO" archive "$REF" | tar -x -C "$TMP"
rsync -a --delete --exclude target --exclude node_modules --exclude web-ui/dist "$TMP/" "$BASE/src/"
if [ -z "${SKIP_WEB:-}" ]; then
  cd "$BASE/src/web-ui"
  if [ ! -d node_modules ] || ! cmp -s package-lock.json node_modules/.deploy-lock; then
    npm ci --no-audit --no-fund
    cp package-lock.json node_modules/.deploy-lock
  fi
  npm run build
  rsync -a --delete dist/ "$BASE/web.new/"
  # 旧版本留下的带哈希的资源文件继续留着:已经打开的标签页还记着旧文件名,点到流程图、公式、各种编辑器时才去懒加载,
  # 文件被删了就报 "Failed to fetch dynamically imported module"(部署两次就够让一个开着的页面坏掉)。
  # 文件名带内容哈希,同名一定同内容,留着不会串版本;只留 14 天内的,免得越攒越多。
  # --ignore-existing:新构建里有的以新的为准(rsync -a 保留修改时间,旧文件的时间就是它们上次被构建出来的时间)
  if [ -d "$BASE/web/assets" ]; then
    rsync -a --ignore-existing "$BASE/web/assets/" "$BASE/web.new/assets/"
    find "$BASE/web.new/assets" -type f -mtime +14 -delete
  fi
  rm -rf "$BASE/web.old"
  if [ -d "$BASE/web" ]; then mv "$BASE/web" "$BASE/web.old"; fi
  mv "$BASE/web.new" "$BASE/web"
  printf '{"hash":"%s","at":"%s"}\n' "$SHA" "$(date -Is)" > "$BASE/web/version.json"
fi
# 办公文档多人协同的服务端副本(office-worker）:守护进程按需启动它,要装好它的引擎依赖。
# 装不上不挡部署:打开 Office 文件时会退回单人编辑。
if [ -z "${SKIP_OFFICE_WORKER:-}" ] && [ -f "$BASE/src/office-worker/package-lock.json" ]; then
  cd "$BASE/src/office-worker"
  if [ ! -d node_modules ] || ! cmp -s package-lock.json node_modules/.deploy-lock; then
    if npm ci --omit=dev --no-audit --no-fund; then
      cp package-lock.json node_modules/.deploy-lock
    else
      echo "!! office-worker 的依赖没装成功(不影响部署):办公文档会退回单人编辑"
    fi
  fi
fi
if [ -z "${SKIP_KBD:-}" ]; then
  cd "$BASE/src"
  CARGO_TARGET_DIR="$BASE/target" CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release -p kb-cli
  install -m 755 "$BASE/target/release/kb" "$BASE/bin/kb.new"
  mv -f "$BASE/bin/kb.new" "$BASE/bin/kb"
  # 旧格式 Office 入库转换:配置里把 [convert] enabled 打开了,就装 / 核对锁定版本的 LibreOffice
  # (下载约 220 MB、解开约 590 MB,已经装好就只核对一遍)。装不上不挡部署:转换只是不生效,旧格式文件照旧原样保存。
  # SKIP_CONVERT=1 跳过。
  KB_HOME_DIR="${KB_HOME:-$BASE/home}"
  if [ -z "${SKIP_CONVERT:-}" ] && convert_enabled "$KB_HOME_DIR/config.toml"; then
    KB_HOME="$KB_HOME_DIR" "$BASE/bin/kb" convert install || echo "!! LibreOffice 没装成功(不影响部署):手动运行 KB_HOME=$KB_HOME_DIR $BASE/bin/kb convert install"
  fi
  systemctl restart kbd.service
fi
# 静态服务用的是归档里的那份(不是工作区的):部署就该等于「部署的那个 ref」,
# 工作区里有未提交改动时不能被顺手带上。漏装这一份的后果是白部署——前端换了、
# 静态服务的 MIME / 缓存头还是旧的(2026-11-02 的 .webmanifest 就是这么漏掉的)。
install -m 644 "$BASE/src/scripts/serve.mjs" "$BASE/serve.mjs"
systemctl restart kbase.service
echo "$SHA $(date -Is)" > "$BASE/DEPLOYED"
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:18600/api/v1/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:18600/api/v1/health
echo
curl -fsS -D - -o /dev/null http://127.0.0.1:18600/ | head -n 20
echo "== deployed $SHA"
