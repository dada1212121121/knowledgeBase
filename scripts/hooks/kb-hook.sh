#!/bin/sh
# kb 链式 git hook 模板。
#
# 安装时会被写入 <hooks>/<name>,并把原 hook 改名为 <name>.kb-orig。
# 行为:先执行原 hook 并**原样返回它的退出码**,再在后台通知守护进程,不阻塞 git。
# 守护进程没运行时 curl 静默失败,git 操作不受影响。

name="$(basename "$0")"
dir="$(dirname "$0")"
orig="$dir/$name.kb-orig"

status=0
if [ -x "$orig" ]; then
  "$orig" "$@"
  status=$?
fi

# 后台通知:--max-time 1 + 子 shell & 保证 hook 立即返回
if [ -S "__KB_SOCKET__" ]; then
  (
    curl -s --max-time 1 --unix-socket "__KB_SOCKET__" \
      -X POST "http://localhost/api/v1/events" \
      -H 'content-type: application/json' \
      -d "{\"kind\":\"__KB_KIND__\",\"project_root\":\"$PWD\"}" \
      >/dev/null 2>&1
  ) &
fi

exit $status
