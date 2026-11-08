#!/usr/bin/env bash
# 在暂存区树上验证(此前记录过:直接在工作区跑会漏掉没暂存的编译错误)。
# 两种档位:
#   --full(默认):fmt → 依赖/文档门禁 → clippy → 全量 Rust 测试 → testkit e2e
#                 → 前端 lint + 全量 vitest + tsc → serve.mjs → 无 dist 的 kb-web check
#   --fast     :fmt → 依赖/文档门禁 → clippy → 核心 crate 测试 → 前端 lint + tsc(不跑 vitest)
# 快速档给 pre-push 钩子用(scripts/hooks/pre-push.sh),目标是三分钟内挡住「编译不过 / 门禁破」。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="full"
case "${1:-}" in
  --fast) MODE="fast" ;;
  --full | "") MODE="full" ;;
  *)
    echo "用法:$0 [--fast|--full]" >&2
    exit 2
    ;;
esac

START_TS=$(date +%s)
# 临时树放在固定路径(target/verify-tree,已 gitignore)而不是 mktemp:
# cargo 的指纹按源文件绝对路径记账,路径每次变就等于每次全量重编(clippy 一轮 4 分钟起)。
# 路径固定后,第二次跑只需重编真正改动过的 crate。
TREE="${VERIFY_TREE:-$ROOT/target/verify-tree}"
STAMP="$TREE.stamp"
NEW_TREE_ID="$(git write-tree)"
# 没有上次的标记就没法做差量,老老实实整棵重建
[ -f "$STAMP" ] || rm -rf "$TREE"
if [ -d "$TREE" ]; then
  # 只刷新变化的路径:整棵树重新 checkout 会把所有源文件 mtime 刷新,等于每次全量重编。
  OLD_TREE_ID="$(cat "$STAMP")"
  if git diff --name-status --no-renames "$OLD_TREE_ID" "$NEW_TREE_ID" >/dev/null 2>&1; then
    while read -r status path; do
      case "$status" in
        D) rm -rf "${TREE:?}/$path" ;;
        *) git checkout-index -f --prefix="$TREE/" -- "$path" ;;
      esac
    done < <(git diff --name-status --no-renames "$OLD_TREE_ID" "$NEW_TREE_ID")
  else
    rm -rf "$TREE"
  fi
fi
if [ ! -d "$TREE" ]; then
  mkdir -p "$TREE"
  git checkout-index -a -f --prefix="$TREE/"
fi
printf '%s\n' "$NEW_TREE_ID" >"$STAMP"
# 除了前端,office-worker 的 node_modules 也要软链:Office 协同的端到端用例
# 找不到真实引擎会直接 panic(「先在 office-worker 里 npm ci」),那是环境缺失不是回归。
for modules in "web-ui/node_modules" "office-worker/node_modules"; do
  if [ -d "$ROOT/$modules" ]; then
    mkdir -p "$(dirname "$TREE/$modules")"
    ln -sfn "$ROOT/$modules" "$TREE/$modules"
  fi
done
if [ -d "$ROOT/web-ui/dist" ]; then
  mkdir -p "$TREE/web-ui/dist"
  cp -a "$ROOT/web-ui/dist/." "$TREE/web-ui/dist/"
fi
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
# 协同子进程必须固定用这棵树自己的 office-worker:代码里的回退路径是编译期烘进二进制的
# CARGO_MANIFEST_DIR,而 CARGO_TARGET_DIR 是两棵树共用的。不钉死的话,在工作区与临时树之间
# 交替跑会拿到另一棵树的旧脚本 —— 红绿都可能骗人(就是靠这个 A/B 才看准的)。
export KB_OFFICE_WORKER_DIR="$TREE/office-worker"
cd "$TREE"

echo "== 模式:$MODE"

echo "== cargo fmt"
cargo fmt --all -- --check
echo "== 分层依赖"
node scripts/check-deps.mjs
echo "== 文档对表"
node scripts/gen-config-index.mjs
node scripts/check-file-size.mjs
echo "== clippy"
cargo clippy --workspace --all-targets -- -D warnings

if [ "$MODE" = "full" ]; then
  echo "== rust tests"
  cargo test --workspace --all-targets --no-fail-fast
  echo "== testkit e2e"
  cargo test -p kb-cli --features testkit --no-fail-fast
else
  # 快速档只跑纯逻辑 crate:kb-core(模型/端口)、kb-index(分块)、kb-meta(存储契约)。
  # service / web / cli 的集成测试依赖守护进程与夹具,留给全量档。
  echo "== rust tests(核心 crate)"
  cargo test -p kb-core -p kb-index -p kb-meta --no-fail-fast
fi

if [ -d web-ui/node_modules ]; then
  if [ "$MODE" = "full" ]; then
    echo "== web-ui(lint + vitest + tsc)"
    (cd web-ui && npm run lint && npm run test && npx vue-tsc --noEmit)
  else
    echo "== web-ui(lint + tsc)"
    (cd web-ui && npm run lint && npx vue-tsc --noEmit)
  fi
fi

if [ "$MODE" = "full" ] && [ -d web-ui/dist ]; then
  # 包体与首屏预算(dist-report 自带阈值，见下文)。
  # 只认工作区里已构建的 dist:没构建就跳过,不在验证里顺手跑一遍 build(那是 2 分钟)。
  echo "== 包体预算(dist-report)"
  (cd web-ui && node scripts/dist-report.mjs)
fi

if [ "$MODE" = "full" ]; then
  echo "== serve.mjs"
  node --test scripts/serve.test.mjs
  echo "== kb-web without frontend dist"
  rm -rf web-ui/dist
  # 复用上面的 target。没有 dist 时只重编 kb-web。
  cargo check -p kb-web
fi

echo "== verify ok($MODE,耗时 $(( $(date +%s) - START_TS )) s)"
