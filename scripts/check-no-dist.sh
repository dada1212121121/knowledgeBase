#!/usr/bin/env bash
# 没有 web-ui/dist 时 kb-web 也必须能编过(rust-embed 的 allow_missing = true)。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
HIDDEN=""
if [ -d web-ui/dist ]; then
  HIDDEN="$(mktemp -d)"
  mv web-ui/dist "$HIDDEN/dist"
fi
cleanup() {
  if [ -n "$HIDDEN" ] && [ -d "$HIDDEN/dist" ]; then
    rm -rf web-ui/dist
    mv "$HIDDEN/dist" web-ui/dist
  fi
  if [ -n "$HIDDEN" ]; then
    rm -rf "$HIDDEN"
  fi
}
trap cleanup EXIT
# 复用主 target。目录内容一变,rust-embed 会重新展开;下次带着 dist 编译会再编一次 kb-web。
cargo check -p kb-web
echo "== kb-web compiles without web-ui/dist"
