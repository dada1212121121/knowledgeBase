#!/usr/bin/env bash
# 给一个 git worktree 建一份「第三方依赖共享(硬链接)、工作区 crate 产物独立」的私有 CARGO_TARGET_DIR。
# 用法: scripts/private-target.sh <worktree 路径> <名字>   然后 export CARGO_TARGET_DIR=<脚本最后打印的路径>
#
# 为什么:多个 worktree 共用一个 target 时,Cargo 对工作区成员的产物哈希用相对工作区根的路径,
# 同名 crate 的哈希相同;新鲜度又只比文件 mtime,某个 worktree 会悄悄链接别人编出来的库跑测试(假绿 / 假红)。
# 私有副本里工作区 crate 的旧产物已清掉,第一次编译会按本 worktree 的源码重编;第三方依赖是硬链接,几乎不占磁盘。
#
# 硬链接要求同一文件系统。这台机器上主 target 是单独挂载的第二块盘,所以副本必须建在 `<主 target>/private/<名字>` 下。
# 路径按这台机器的布局;SRC_TARGET 可以覆盖。用完直接 rm -rf 那个目录即可(只会删掉副本里的链接,不影响主 target)。
set -euo pipefail
wt="${1:?用法: private-target.sh <worktree 路径> <名字>}"
name="${2:?用法: private-target.sh <worktree 路径> <名字>}"
src="${SRC_TARGET:-/srv/kb/target}"
dst="$src/private/$name"
if [ -e "$dst" ]; then echo "已存在: $dst"; exit 0; fi
mkdir -p "$dst/debug"
for d in deps build .fingerprint; do cp -al "$src/debug/$d" "$dst/debug/$d"; done
for f in .rustc_info.json CACHEDIR.TAG; do if [ -e "$src/$f" ]; then cp -a "$src/$f" "$dst/$f"; fi; done
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
cd "$wt"
pkgs=$(cargo metadata --no-deps --format-version 1 --offline 2>/dev/null | python3 -c 'import sys,json; print(" ".join("-p "+p["name"] for p in json.load(sys.stdin)["packages"]))')
# 只在私有副本里清掉工作区 crate 的产物(硬链接,删的只是副本里的链接)
CARGO_TARGET_DIR="$dst" cargo clean $pkgs 2>&1 | tail -2
echo "私有 target 已就绪: $dst"
