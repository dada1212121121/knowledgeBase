# Headless Office 引擎适配层（`src/editor/engines/`）

> **单一入口约束**：全前端代码库中，**只有本目录（`web-ui/src/editor/engines/`）允许直接 `import '@betteroffice/{docx,xlsx,pptx}'`**。
> 上层 `EditorHost`、`Session`、`Surface` 与 `Codec` 一律依赖 `src/editor/types.ts` 定义的本仓接口，严禁泄漏上游类型。

---

## 1. 版本锁与依赖策略

| 包名 | 锁定版本 | 许可 | 说明 |
|---|---|---|---|
| `@betteroffice/docx` | `0.5.1`（精确锁） | Apache-2.0 | Word 解析、选择性保存、画布绘制、Worker 编辑会话、Yrs 协同 |
| `@betteroffice/xlsx` | `0.5.1`（精确锁） | Apache-2.0 | Excel 解析、公式重算、DisplayList 绘制、`WorkbookEditSession.command` 编辑、协同 |
| `@betteroffice/pptx` | `0.5.1`（精确锁） | Apache-2.0 | PowerPoint 解析、幻灯片布局绘制、`PptxWorkerEditorSession` 编辑、协同 |

- `web-ui/package.json` 必须将上述三个包声明为**直接依赖**，且严禁写 `^` 或 `~`。
- 阶段 6（``）已卸载 `@betteroffice/*-react`、`*-i18n`、`react`、`react-dom`、`pptx-preview`、`@milkdown/*`、`md-editor-v3` 和 `@betteroffice/fonts-cjk`（直接依赖）；本目录依赖的三个 core 包（docx / xlsx / pptx）不受影响。字体的取舍见 `fonts/README.md`。

---

## 2. 上游 0.5.1 真实公开 API 边界（已核验）

> 下表逐项对照 `node_modules/@betteroffice/*` 的 `package.json#exports` 与 `.d.ts` 实测得来。
> 任何一项变化都必须先让 `contract.spec.ts` 红灯，再人工复核。

### 2.1 子路径全景（别凭记忆写 import）

| 包 | 真实存在的子路径 |
|---|---|
| `@betteroffice/docx` | `.` / `./docx` / `./docx/wrapTypes` / `./styles` / `./layout` / `./layout/render` / `./layout/pagination` / `./plugin-api`(+2) / `./types/*` / `./utils`(+…) / `./yrs` / `./collaboration` / `./editor` / `./worker` |
| `@betteroffice/xlsx` | `.` / `./headless` / `./worker` / `./collaboration` |
| `@betteroffice/pptx` | `.` / `./worker` / `./collaboration` |

**没有** `@betteroffice/docx/worker-client`；**没有** `@betteroffice/docx/docxWorker`（Worker 入口只在 `dist/docxWorker.mjs`，见设计规范）。

### 2.2 各格式可用入口

| 格式 | 模块 | 允许使用的公开入口 | 明确的能力缺口 |
|---|---|---|---|
| **DOCX** 解析/保存 | `@betteroffice/docx` | `parseDocx`、`repackDocx`、`attemptSelectiveSave` | — |
| **DOCX** 排版/绘制 | `@betteroffice/docx/layout`<br>`@betteroffice/docx/layout/render` | `createRustMeasureSource`、`getRustTextEngine`、`configureDefaultFonts`、`resolveDefaultFontProvider`、`resolveHeaderFooter`<br>`drawDisplayPage`、`rasterizeDisplayListPages` | `./layout` 与 `./layout/pagination` **都不产出 `DisplayPage[]`**，整篇分页只在 `docx_edit_wasm` 会话内 |
| **DOCX** 会话 | `@betteroffice/docx/worker` | `DocxSourceWorkerClient`、`createDocxCommandConnection`、`createDocxWorkerEditSession`、`takePreloadedDocxSourceWorker` | 上游无 `spawnDocxSessionWorker` |
| **DOCX** 协同 | `@betteroffice/docx/yrs`<br>`@betteroffice/docx/collaboration` | `createYrsSession`、`saveYrsDocx`<br>`CollaborationProvider` | — |
| **XLSX** | `@betteroffice/xlsx`<br>`@betteroffice/xlsx/collaboration` | `initWasm`、`openWorkbook`（→ `WorkbookHandle`）、`openWorkbookSession`（只读窄会话）、`createWorkbookEditSession`（→ `WorkbookEditSession.command(WorkbookCommand)`）、`paintDisplayList`、`renderXlsxMarkdown`、`exportXlsxStructured`<br>`CollaborationProvider` | v0.5.1 未暴露交互式合并/拆分单元格与增删行列公开方法（设计规范已知限制） |
| **PPTX** 会话 | `@betteroffice/pptx` | `initWasm`、`openPresentation`（→ `PresentationHandle`，主线程）、`openPresentationSession`（→ `PresentationSession`，**窄只读**）、`createPptxWorkerEditorSession`（→ `PptxWorkerEditorSession`，**唯一编辑入口**）、`paintSlide`、`slideToPng`、`CollaborationProvider` | 无 `groupShapes`/`ungroupShape`、无 `addConnector`/`addTable`、无内置对齐分布、无像素裁剪；表格行列增删被 Worker 排除 |

### 2.3 PPTX 两条会话 API 的关键区别（最容易踩坑）

- `openPresentationSession().call` 只有 `version / readContent / findText / validateEdits / applyEdits / slides / slideSize / save`，
  `frame(slideIndex)` 取帧。**不能**做细粒度形状编辑。
- `createPptxWorkerEditorSession().apply(op)` 接受上游 `PresentationReplayOp`
  （即 `PresentationHandle` 同名方法 + 其参数），共 **39** 项可用：
  `insertText / deleteText / formatText / setStoryParagraphs / insertParagraphBreak / setParagraphAlignment /
  insertSlide / duplicateSlide / deleteSlide / moveSlide / setSlideNotes / setSlideLayout /
  addTextBox / addShape / addPicture / removeShape / moveShape / resizeShape /
  setShapeRect / setShapeFill / setShapeStroke / setShapeAdjust /
  bringShapeToFront / sendShapeToBack / bringShapeForward / sendShapeBackward /
  addComment / replyToComment / setCommentStatus / setCommentPosition / removeComment / setCommentFlavor /
  propose / acceptProposal / rejectProposal / applyEdits / addUndoBoundary / undo / redo`。
- 被排除的 4 项：`insertTableRow / deleteTableRow / insertTableColumn / deleteTableColumn`。
- 能力集合以 `version.ts` 的 `PPTX_WORKER_REPLAY_METHODS` / `PPTX_WORKER_UNSUPPORTED_METHODS` 为准，并由 `contract.spec.ts` 断言长度 39。

### 2.4 上游 Worker 入口与构建约束

上游 `@betteroffice/docx/worker` 内部用
`new Worker(new URL("./docxWorker.mjs", import.meta.url), { type: "module" })` 自拉 Worker，
但 `dist/docxWorker.mjs` **没有对应的 `exports` 子路径**，且它只有 31 字节、真正逻辑在 `dist/yrs/docxWorker.mjs` + 若干 `chunk-*.mjs`。
若当作静态资源直接拷贝，运行时相对 import 会 404。因此：

- `vite.config.ts` 提供 alias `@betteroffice/docx/worker-entry` → `node_modules/@betteroffice/docx/dist/docxWorker.mjs`；
- 我们自建的 `engines/docx/docx.worker.ts` 用 `?worker` 引入，由 Vite 把整张 Worker 图打成**单个同源 ES 模块文件**；
- 全仓禁止 `?inline` / `blob:` / `data:` Worker（`crates/kb-web/src/router.rs` 的 CSP `worker-src` 未放开 `blob:`）。

---

## 3. 只读与编辑两条加载路径

1. **DOCX 双模路径（遵守 零 WASM 首屏预算）**：
   - **默认轻只读**：`PageSurface` 外壳 + `docx-preview` 轻只读内核（0 WASM，总传输 ≤ 300 KB gzip，热首屏 ≤ 800 ms）；
   - **高保真画布审阅 / 编辑态**：按需或空闲预取，三步握手
     `new DocxSourceWorkerClient()` → `openSource({ bytes })`，
     `createDocxCommandConnection(client, init)`，
     `createDocxWorkerEditSession({ connection, echo, requestFullFrame, recovery })`，
     再用 `drawDisplayPage` 绘制分页画布。
2. **XLSX / PPTX 路径**：
   - 只读态：XLSX 用 `openWorkbookSession`，PPTX 用 `openPresentationSession`；主线程只拿当前视口/当前页 DisplayList 绘制 Canvas；
   - 编辑态：XLSX 用 `createWorkbookEditSession().command()`，PPTX 用 `createPptxWorkerEditorSession().apply()`；
   - 两条都走 `saveGuard.ts` + 服务端 `replace_bytes`（内建 `office_check::validate`、乐观锁 409、 房间锁）。

## 4. 升级与退回 `third_party/` Fork 触发条件

### 4.1 升级流程
1. 在测试分支修改 `web-ui/package.json` 与 `version.ts` 中的目标版本号；
2. 运行 `npx vitest run src/editor/engines/contract.spec.ts` 验证所有导出签名；
3. 运行 132 份真实 Office 语料「打开 → 不改保存」与「改一处保存」无损往返检查；
4. 更新 `ARCHITECTURE.md` 后方可合入。

### 4.2 启动 `third_party/betteroffice` 源码并入（兜底路径）的触发条件
出现以下任一情况时，不再停留在 npm 包层打补丁，立即启动源码并入：
1. 上游新版本删除或破坏本目录依赖的 headless 公开接口；
2. 触发未修复的页眉/页脚或部件丢失且无法通过前置 `roundtrip-check` 拦截；
3. 上游许可证变更（0.5.1 已锁定为 Apache-2.0）；
4. 需要在 DOCX 只读路径彻底剥离 `docx_edit_wasm`、从 Rust 侧直接导出整篇文档只读分页 `DisplayPage[]`。
