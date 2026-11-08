# syntax=docker/dockerfile:1.7
#
# knowledgeBase 一体化镜像(单用户/自部署)。
#
# 只构建核心守护进程与 Web 界面;办公文档多人协同所需的 office-worker(Node 子进程)
# 不在镜像内,需要协同时请按 docs/PLUGINS.md 自行安装。镜像以非 root 运行,
# 数据卷挂到 /data(对应 KB_HOME)。
#
# 构建:
#   docker build -t knowledgebase:dev .
# 运行:
#   docker run --rm -p 7878:7878 -v kb-data:/data knowledgebase:dev
# 首次启动后在容器内设置 Web 登录密码(密码从标准输入读取):
#   docker exec -it <容器> kb auth set-password

ARG RUST_IMAGE=rust:1.99-bookworm
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- 前端 ----------
FROM ${NODE_IMAGE} AS web
WORKDIR /src/web-ui
COPY web-ui/package.json web-ui/package-lock.json ./
# 构建脚本在 npm run build 里显式执行;这里不需要依赖的安装钩子。
RUN npm ci --ignore-scripts
COPY web-ui/ ./
# 指南页在编译期把用户手册原文打进包里,路径相对 web-ui/src 指向仓库根的 docs/guide。
COPY docs/guide /src/docs/guide
COPY NOTICE /src/NOTICE
# postbuild 的预压缩脚本从仓库根的 serve.mjs 取「哪些扩展名要压缩」这一份清单。
COPY scripts/serve.mjs /src/scripts/serve.mjs
RUN npm run build

# ---------- Rust 二进制 ----------
FROM ${RUST_IMAGE} AS build
WORKDIR /src
# kb-embed 的 fastembed 运行时需要 libgomp;构建期也用它做链接检查。
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev libgomp1 protobuf-compiler libprotobuf-dev \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY assets ./assets
# 编译期 include_str! 引用了仓库自带的 git hook 模板。
COPY scripts/hooks ./scripts/hooks
# rust-embed 在编译期读取 web-ui/dist;没有前端产物时 kb-web 会退化为 API-only。
COPY --from=web /src/web-ui/dist ./web-ui/dist
# 某些反向代理 / CDN 对 HTTP/2 多路复用兼容性差,cargo 会报
# "Stream error in the HTTP/2 framing layer";关掉多路复用并增加重试,避免构建随机失败。
ENV CARGO_HTTP_MULTIPLEXING=false \
    CARGO_NET_RETRY=5
RUN cargo build --release --locked -p kb-cli

# ---------- 运行时 ----------
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 kb \
    && useradd --system --uid 10001 --gid kb --home-dir /data --shell /usr/sbin/nologin kb \
    && mkdir -p /data \
    && chown -R kb:kb /data

COPY --from=build /src/target/release/kb /usr/local/bin/kb
COPY --from=build /src/scripts/hooks/kb-hook.sh /usr/local/share/kb/kb-hook.sh
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

# KB_HOME 决定配置、SQLite 与向量库的位置;容器里必须落在可写卷上。
ENV KB_HOME=/data
# 入口脚本只在 config.toml 不存在时生成监听 0.0.0.0:7878 的配置;
# 挂载自己的 config.toml 即可完全接管监听地址与远端访问策略。
EXPOSE 7878

USER kb
VOLUME ["/data"]
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["daemon"]
