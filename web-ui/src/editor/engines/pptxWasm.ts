/**
 * PPTX 引擎的 WASM 模块：整个页面只下载、编译一次，主线程与编辑 Worker 共用
 *
 * 为什么要自己管：
 * 1. 引擎默认让每个编辑会话的 Worker 自己 fetch + 编译一次 WASM（1.6 MB brotli / 6.2 MB 原始），
 *    主线程的只读后端又会再来一遍。实测（9 Mbps / 70 ms）热开编辑 2.0~2.3 s 里约 1.65 s 是 Worker 重新取 WASM；
 *    引擎自带的 Worker 内模块缓存在我们的构建里没有生效（Worker 从未把编译好的模块发回主线程）。
 * 2. 编译好的 `WebAssembly.Module` 可以经结构化克隆交给任意同源 Worker，不用再取、不用再编译。
 *    所以这里编译一次，主线程 `initWasm(module)` 与 `createPptxWorkerEditorSession({ wasm: module })` 都用它，
 *    和 HTTP 缓存策略无关（生产环境哈希资源是 immutable，但测试服务器、新开标签页的内存都得不到这个好处）。
 *
 * 为什么放在单独的小文件：它**不 import 引擎**（只要一个资源 URL），所以能在引擎 chunk 还没下完时就被调用，
 * 把 WASM 下载提前到「知道这是 pptx」的那一刻；冷开时链路在引擎 JS 下载完之前是空闲的，提前开始就是白赚。
 */
// 资源地址由 vite.config.ts 的别名指向 node_modules 里引擎自带的 WASM，构建后是带内容哈希的同一个资源文件
// （引擎自己 `new URL('./generated/pptx_wasm_bg.wasm', import.meta.url)` 引用的也是它，不会多出一份）。
import wasmUrl from '@pptx-wasm/pptx_wasm_bg.wasm?url'

let compiled: Promise<WebAssembly.Module> | null = null

async function compile(url: string): Promise<WebAssembly.Module> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`引擎模块下载失败(HTTP ${response.status})`)
  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      // 边下载边编译；clone 一份留给下面的非流式兜底（流只能读一次）
      return await WebAssembly.compileStreaming(response.clone())
    } catch (error) {
      // 响应头不是 application/wasm 等情况下流式编译会拒绝；其余错误（编译失败）非流式也会失败，照常抛出
      if (response.headers.get('content-type') === 'application/wasm') throw error
    }
  }
  return WebAssembly.compile(await response.arrayBuffer())
}

/** 取（必要时开始下载并编译）引擎的 WASM 模块；失败不缓存，下次打开重试 */
export function pptxWasmModule(): Promise<WebAssembly.Module> {
  compiled ??= compile(wasmUrl).catch((error) => {
    compiled = null
    throw error
  })
  return compiled
}

/** 只开始下载，不关心结果（失败在真正打开时会重新触发并报错） */
export function prefetchPptxWasm(): void {
  void pptxWasmModule().catch(() => undefined)
}
