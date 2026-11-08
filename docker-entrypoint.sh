#!/bin/sh
# 容器入口:首次启动时生成一份可直接对外映射端口的配置。
#
# 为什么需要它:守护进程默认只监听 127.0.0.1:7878(安全默认),容器里这样监听
# 等于端口映射不可达。这里只在 **配置文件不存在** 时写入容器用的配置;用户挂载
# 自己的 config.toml 后完全以用户的配置为准。
set -eu

: "${KB_HOME:=/data}"
mkdir -p "$KB_HOME"

if [ ! -f "$KB_HOME/config.toml" ]; then
  cat >"$KB_HOME/config.toml" <<'EOF'
# 由容器入口生成;挂载自己的 config.toml 可覆盖。
[server]
# 容器网络内监听所有网卡,请通过端口映射、反向代理或防火墙限制来源。
listen = "0.0.0.0:7878"
allow_remote = true
EOF
  echo "已生成 $KB_HOME/config.toml(监听 0.0.0.0:7878)" >&2
fi

exec /usr/local/bin/kb "$@"
