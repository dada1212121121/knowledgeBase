# 变更记录

本文件记录对用户可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN)。

## [Unreleased]

### 计划中

- 提供带校验和的预编译 Linux 二进制与容器镜像
- 补充检索 / 索引的 OpenAPI 描述与 Prometheus 指标
- 继续拆分超长模块,降低二次开发门槛

## [0.1.0] - 2026-11-08

首个公开源码版本。

### 新增

- Rust 守护进程、CLI、MCP 服务与 Vue 3 管理端
- LanceDB 向量检索 + 内置 BM25 的混合检索与 RRF 融合
- tree-sitter 代码分块,Markdown / 文本 / PDF / Office / EPUB / 邮件 / 压缩包抽取
- 项目与集合、增量索引、任务队列、检索评测与反馈调权
- 多用户、角色与配额、文档分享、游客访问、审计与备份恢复
- 知识沉淀:git hook / 会话事件触发提炼,LLM 审核或人工审核收件箱
- CSV / TSV 保编码编辑,Word / Excel / PowerPoint 在线预览、编辑与协同
- MCP stdio 与带鉴权的 HTTP `/mcp`,CLI 与 Web 共用同一套能力与权限
- Dockerfile(多阶段构建、非 root 运行)与本地开发脚本
- 分层依赖、文档对表、单文件行数三道架构门禁

### 安全

- 默认只监听 `127.0.0.1`,远程访问需显式开启并放在 HTTPS 反向代理之后
- 登录会话使用 `HttpOnly` + `SameSite=Strict` Cookie,写操作校验 CSRF
- 密码与令牌不明文落盘;仓库不包含任何生产凭据或真实实例数据

[Unreleased]: https://github.com/dada1212121121/knowledgeBase/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dada1212121121/knowledgeBase/releases/tag/v0.1.0
