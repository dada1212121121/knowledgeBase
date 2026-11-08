# README 截图

这些图片由 `web-ui/e2e/readme-shots.mjs` 使用公开、确定性的测试夹具生成，不读取真实实例数据。

| 文件 | 页面 |
|---|---|
| `home.png` | 首页 · 个人工作台 |
| `search.png` | 搜索 · 混合检索与 RRF 解释 |
| `browser-editor.png` | 知识库 · 在线编辑 |
| `import-sources.png` | 导入 · 数据来源 |
| `preview-xlsx.png` | Excel 在线预览 |
| `preview-pptx.png` | PowerPoint 在线预览 |
| `projects.png` | 项目与集合 |
| `admin-overview.png` | 管理端 · 系统概览 |
| `home-mobile.png` | 移动端首页 |

重新生成（需要先构建 `web-ui/dist`，并安装 Playwright 浏览器）：

```bash
cd web-ui
npm ci
npm run build
node e2e/readme-shots.mjs
```

脚本固定使用 1440×900（移动端 390×844 @2x）、`Asia/Shanghai` 时区和模拟时钟，
因此同一提交生成的截图应当稳定可复现。新增或替换截图时，请同步检查画面里不能出现真实项目名、
用户目录、内部域名、令牌或个人信息。
