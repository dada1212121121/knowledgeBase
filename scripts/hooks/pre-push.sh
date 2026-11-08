#!/usr/bin/env bash
# pre-push 钩子:推送前跑一遍快速验证(fmt / 依赖门禁 / clippy / 核心 crate 测试 / 前端 lint + tsc)。
#
# 为什么:这里的纪律是「真实命令验收」,但只写在 AGENTS.md 里等于靠自觉。
# 全量 verify 太慢(7 分钟起),推不动的纪律等于没有纪律——所以钩子只跑快速档,
# 全量档留给提交前的关键时刻和质量检查。
#
# 安装:scripts/install-hooks.sh(装到 .git/hooks/pre-push,原有钩子备份为 pre-push.kb-orig)
# 临时跳过:SKIP_VERIFY=1 git push(仅限「推的是文档分支」这种明确场景,别用它绕编译错误)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [ "${SKIP_VERIFY:-0}" = "1" ]; then
  echo "pre-push:SKIP_VERIFY=1,跳过快速验证" >&2
  exit 0
fi

# 只在推送分支时验证;纯 tag 推送不跑(打标签前已经验过)
pushed_branch=0
while read -r local_ref _local_sha remote_ref _remote_sha; do
  case "$local_ref" in
    refs/heads/*) pushed_branch=1 ;;
  esac
  : "$remote_ref"
done
if [ "$pushed_branch" = "0" ]; then
  echo "pre-push:只推 tag,跳过(打标签前应已跑过全量验证)" >&2
  exit 0
fi

echo "pre-push:跑 scripts/verify.sh --fast(要跳过用 SKIP_VERIFY=1 git push)" >&2
exec "$ROOT/scripts/verify.sh" --fast
