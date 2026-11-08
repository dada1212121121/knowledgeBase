# 发布流程

面向维护者。发布以 **公开仓库的 `main` 分支** 为准:先让 `main` 通过全量验收,再打标签、生成发布物。

## 1. 版本与变更记录

1. 确认 `Cargo.toml` 的 `workspace.package.version`、`web-ui/package.json`、`office-worker/package.json`
 版本一致;当前使用 `0.x.y`,破坏性变更升次版本号。
2. 在 `CHANGELOG.md` 顶部增加 `## [x.y.z] - YYYY-MM-DD`,写清新增、变更、修复与安全相关条目。
3. 更新 `README.md` / `README.en.md` 中受影响的安装步骤、截图与限制说明。

## 2. 全量验收

在干净的 `main` 上执行:

```bash
source scripts/env.sh
scripts/install-hooks.sh
scripts/verify.sh --full
```

`verify.sh --full` 会跑格式、分层依赖、文档对表、配置索引、文件行数、Clippy、Rust 全量测试、
前端 lint / vitest / tsc、`serve.mjs` 测试,以及没有前端产物时的 `kb-web` 编译检查。

再跑一次安全与链接检查:

```bash
gitleaks detect --no-banner
```

确认工作树没有未提交改动。发布提交必须通过 CI 的 Rust、Web 与 office-worker 三个 job。

## 3. 构建发布物

```bash
VERSION=0.1.0

# 前端产物会被 rust-embed 打进 kb-web
(cd web-ui && npm ci && npm run build)
cargo build --release --locked -p kb-cli

mkdir -p dist
tar -C target/release -czf "dist/knowledgeBase-${VERSION}-x86_64-linux.tar.gz" kb
(cd dist && sha256sum ./*.tar.gz > SHA256SUMS)
```

发布包至少包含:

- `kb` 二进制
- `web-ui/dist`(如果希望前端与二进制分开部署)
- `LICENSE`、`NOTICE`、`THIRD_PARTY_LICENSES.md`、`README.md`、`CHANGELOG.md`

容器镜像可选,但发布前必须实际构建并启动一次:

```bash
docker build -t knowledgebase:${VERSION} .
docker run --rm -p 7878:7878 -v kb-data:/data knowledgebase:${VERSION}
```

## 4. 打标签与发布

```bash
git tag -a "v${VERSION}" -m "knowledgeBase ${VERSION}"
git push origin main
git push origin "v${VERSION}"
```

推送 `v*` 标签会触发 `.github/workflows/release.yml`,构建 Linux 二进制并附加校验和。
发布说明直接取 `CHANGELOG.md` 对应版本段落,不要只写“修复若干问题”。

## 5. 发布后

- 在干净目录按 README 走一遍安装(不要复用本机缓存),确认能启动、能登录、能索引一个小项目。
- 检查 release 资产与 `SHA256SUMS` 可下载,链接没有 404。
- 把新版本号写回 `README` 的 badge(如有)与 `ROADMAP.md` 的当前重点。
- 安全问题按 `SECURITY.md` 的时限跟进,修复版本单独发版并在 CHANGELOG 致谢。
