# knowledgeBase — 开发约定

面向在本仓库工作的开发者与 AI Agent。架构设计与可行性结论见 [ARCHITECTURE.md](ARCHITECTURE.md) 与 [FEASIBILITY.md](FEASIBILITY.md)。

## 1. 开发前

- 先读 `ARCHITECTURE.md` 的分层与端口约定,再动代码。
- Rust 按 crate 分层:`kb-core` 只放模型与端口,不得依赖 lancedb / fastembed / axum / rusqlite;适配器只依赖 `kb-core`;`kb-cli` 是唯一组装根。
- 前端页面只调用能力 API;样式走 `@kb/ui` 的 token 与组件,不在页面里写裸色值、裸字号、裸圆角。

## 2. 提交前必须真实执行的检查

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd web-ui && npm ci && npm run lint && npm run test && npm run build
```

- 禁止假绿:不得削弱断言、跳过失败用例、静默吞异常来让 CI 变绿。
- 改了前端交互或视觉,补对应的 vitest / e2e;改了抽取、分块、检索逻辑,补单测或快照。

## 3. 代码与注释

- 新增或修改的代码写中文注释,说明“为什么”和业务约束,不写重复代码表面的废话。
- 标识符、模块、公开接口用 Rust / Vue 标准命名;错误信息与日志用中文,便于用户理解。
- 不提交 API key、token、密码、Cookie、真实域名 / IP、个人路径等敏感信息;示例统一用 `example.com`、`203.0.113.0/24` 这类保留值。
- 临时脚本、调试产物放 `target/` 或系统临时目录,不要散落在业务目录,也不要提交进 Git。

## 4. 许可证与第三方代码

- 本项目采用 PolyForm Noncommercial 1.0.0,**禁止商业使用**;提交即表示同意以该许可证分发。
- 引入新依赖前先确认许可证兼容(禁止 GPL / AGPL / SSPL 进运行时);新增第三方代码或字体需同步更新 [NOTICE](NOTICE) 与 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。
- 不要移除或改写现有版权头与 NOTICE。
