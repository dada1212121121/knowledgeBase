/**
 * Word 引擎 Worker 客户端：和上游 `DocxSourceWorkerClient` 只差一个 `warm`。
 *
 * 上游 `warm` 的做法是：给 Worker 发 `warm`（Worker 等宿主送来编译好的模块，最多等 10 s），同时在主线程调
 * `editWasmModule` 自己取并编译 WASM，再用 `editModule` 消息把 `WebAssembly.Module` 发给 Worker。
 * 问题在于那个「自己取」发生在 `warm` 被调用的时刻——也就是引擎适配层 chunk 下完、Worker 建好之后，
 * 点击后约 0.5 s 才开始下载 5.1 MB，而且每个引擎页面只能用上游的那一份缓存（无法提前，也无法替换）。
 *
 * 这里把「取模块」换成 `docxEditWasmModule`（`docxWasm.ts`，不依赖引擎，可以在悬停 / 点击的同一刻开始下载）：
 * 协议和上游完全一致——同样先发 `warm` 请求，再发一条 `editModule`；模块拿不到时发 `null`，Worker 退回自己取（保留原有的容错）。
 * 无损探针的临时 Worker 与编辑会话的 Worker 因此共用同一份编译结果，WASM 整页只下载、编译一次。
 *
 * 为什么放在 engines/：要 import `@betteroffice/docx/worker`，全仓只有 engines/ 允许这样做。
 */
import { DocxSourceWorkerClient } from '@betteroffice/docx/worker'
import { docxEditWasmModule } from '../docxWasm'

export class KbDocxWorkerClient extends DocxSourceWorkerClient {
  override async warm(): Promise<void> {
    // 先登记 warm 请求再取模块：和上游同序，Worker 收到 warm 后才开始等 editModule
    const warmed = this.request({ type: 'warm', hostModule: true })
    const hand = (module: WebAssembly.Module | null) => {
      try {
        this.worker.postMessage({ type: 'editModule', module })
      } catch {
        // 模块对象发不出去（极少见）：退回让 Worker 自己取，再不行就由 warm 请求的错误如实报告
        try {
          this.worker.postMessage({ type: 'editModule', module: null })
        } catch {
          // Worker 已经没了；warm 请求会因此失败，错误走正常路径
        }
      }
    }
    void docxEditWasmModule().then(hand, () => hand(null))
    await warmed
  }
}
