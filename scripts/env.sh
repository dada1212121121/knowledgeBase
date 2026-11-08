#!/usr/bin/env bash
# 开发环境变量(开发环境约定)。用法: source scripts/env.sh
#
# 本机代理 127.0.0.1:17890 很慢(每次 TLS 握手约 5.5 秒);下面这些域名直连更快,
# 因此从代理里排除。huggingface.co API 与 github.com 仍走代理(HTTPS_PROXY 不变)。

export NO_PROXY="localhost,127.0.0.1,::1,.crates.io,crates.io,.hf.co,registry.npmmirror.com,registry.npmjs.org,release-assets.githubusercontent.com,objects.githubusercontent.com"
export no_proxy="$NO_PROXY"

# 不要设置 HF_ENDPOINT=https://hf-mirror.com:
# fastembed 走它会报 "Content-Range missing" 而失败(开发环境约定)。
unset HF_ENDPOINT

# rustup / cargo(提供 cargo、rustc、rustfmt、clippy)
. "$HOME/.cargo/env"
