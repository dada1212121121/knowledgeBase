# 贡献指南

感谢你愿意参与 knowledgeBase。提交前请先读一遍本指南与 [AGENTS.md](AGENTS.md)。

## 许可证

本项目采用 **PolyForm Noncommercial License 1.0.0**:允许个人学习、研究与非商业用途,禁止商业使用。
提交 Pull Request 即表示你同意以同一许可证分发你的贡献,并确认你有权提交这些代码。
请勿提交来源不明或许可证不兼容的代码、字体、图片与词典。

## 开发环境

需要:

- Rust 1.91+(仓库用 `rust-toolchain.toml` 锁定版本)
- `g++`、`protobuf-compiler`、`pkg-config`、`libssl-dev`
- Node.js 22+ 与 npm 10+

```bash
# 后端
cargo build
cargo test --workspace

# 前端
cd web-ui
npm ci
npm run build
```

完整安装、模型缓存与 systemd / Docker 部署见 [README](README.md)。

## 提交前检查

提交前至少跑快速档;改动跨 crate、检索 / 抽取逻辑或准备发版时跑全量档:

```bash
scripts/install-hooks.sh      # 安装 pre-push 钩子
scripts/verify.sh --fast      # 三分钟档:格式 / 架构门禁 / Clippy / 核心测试 / 前端 lint + tsc
scripts/verify.sh --full      # 全量:再加 Rust 全量测试、vitest、serve.mjs、无 dist 的 kb-web 编译
```

也可以分开跑:

```bash
cargo fmt --all -- --check
node scripts/check-deps.mjs
node scripts/check-docs.mjs
node scripts/check-file-size.mjs
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd web-ui && npm run lint && npm run test && npm run build
```

- 不要为了“变绿”而删除断言、跳过失败用例或吞掉错误。
- 修 bug 请附最小复现或回归测试;新增检索 / 分块 / 抽取逻辑请补单测或快照。
- 改动界面请附截图或录屏,并确认深色 / 浅色、窄屏与键盘操作没有回归。

## 提交信息

使用清晰的中文说明“做了什么、为什么”:

```
修复上传分片在断网重连后重复入库

- complete 前按 upload_id + 分片号去重
- 补一条断网续传的集成测试
```

一个提交只做一件事;格式化、重命名等无关改动不要混进功能提交。

提交必须带 Developer Certificate of Origin 签名(见 [DCO](DCO)):

```bash
git commit -s
```

`Signed-off-by` 的姓名与邮箱要和提交作者一致。

## 安全与隐私

- 不要提交 API key、token、密码、Cookie、真实域名 / IP、个人路径或内部项目名。
- 示例统一使用 `example.com`、`203.0.113.0/24` 等保留值。
- 发现安全问题请按 [SECURITY.md](SECURITY.md) 私下报告,不要开公开 issue。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
