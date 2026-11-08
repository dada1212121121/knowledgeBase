/**
 * Word 编辑引擎的同源模块 Worker 入口。
 *
 * 为什么自己放一个入口：上游 `dist/docxWorker.mjs` 没有在 exports map 里导出，裸路径会被拦下；
 * vite.config.ts 里给了显式 alias `@betteroffice/docx/worker-entry`，这里 import 它，
 * Vite 会把上游 Worker 的整张模块图打成一个同源 ES 模块文件（CSP `worker-src 'self'`，不用 `blob:`/`data:`）。
 * 上游的入口是副作用导入：加载即在 `self` 上注册消息处理，所以这里只需要 import。
 */
import '@betteroffice/docx/worker-entry'
