#!/usr/bin/env bash
# 安装仓库自带的 git 钩子(目前只有 pre-push)。
#
# 为什么需要安装脚本:.git/hooks 不进版本库,新人 clone 下来是空的。这里把
# scripts/hooks/*.sh 链到 .git/hooks 下,已有的同名钩子按项目惯例改名为 <name>.kb-orig,
# 卸载时再换回来。
#
# 用法:
#   scripts/install-hooks.sh          安装 / 更新
#   scripts/install-hooks.sh --check  只检查装没装(CI 与新人自查用)
#   scripts/install-hooks.sh --remove 卸载并还原被备份的原钩子
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_DIR="$(git -C "$ROOT" rev-parse --git-path hooks)"
if [ "${HOOKS_DIR#/}" = "$HOOKS_DIR" ]; then
  HOOKS_DIR="$ROOT/$HOOKS_DIR"
fi
mkdir -p "$HOOKS_DIR"

# 只管理这里列出的钩子,别的一概不碰
HOOKS=(pre-push)

install_one() {
  local name="$1" src="$ROOT/scripts/hooks/$name.sh" dst="$HOOKS_DIR/$name"
  chmod +x "$src"
  if [ -f "$dst" ] && ! cmp -s "$dst" "$src"; then
    mv "$dst" "$dst.kb-orig"
    echo "  原 $name 已备份为 $name.kb-orig"
  fi
  ln -sf "$src" "$dst"
  echo "  已安装 $name → scripts/hooks/$name.sh"
}

case "${1:-}" in
  --check)
    missing=0
    for name in "${HOOKS[@]}"; do
      if [ ! -e "$HOOKS_DIR/$name" ]; then
        echo "缺钩子:$name(跑 scripts/install-hooks.sh)" >&2
        missing=1
      fi
    done
    [ "$missing" = "0" ] && echo "✓ git 钩子已就位"
    exit "$missing"
    ;;
  --remove)
    for name in "${HOOKS[@]}"; do
      rm -f "$HOOKS_DIR/$name"
      if [ -f "$HOOKS_DIR/$name.kb-orig" ]; then
        mv "$HOOKS_DIR/$name.kb-orig" "$HOOKS_DIR/$name"
        echo "  已还原原 $name"
      fi
    done
    exit 0
    ;;
esac

echo "安装 git 钩子到 $HOOKS_DIR:"
for name in "${HOOKS[@]}"; do install_one "$name"; done
