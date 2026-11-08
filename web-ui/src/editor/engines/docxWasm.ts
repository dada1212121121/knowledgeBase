/**
 * Word 编辑引擎的 WASM 模块：整个页面只下载、编译一次，所有编辑 / 探针 Worker 共用，并且能在引擎 JS 下完之前就开始下载
 *
 * 为什么要自己管（瀑布图实测，20 Mbps / 70 ms / CPU 4×，冷开 9.9 s）：
 * 1. 引擎 WASM 解压后 23 MB、下发 5.1 MB，是冷开里最长的一段（单独下载约 2.3 s）。上游默认在 `client.prewarm` 里才开始取，
 *    而那一步排在「动态载入 72 KB 的引擎适配层 chunk → 建 Worker」之后，点击后约 0.5 s 才发出请求；
 *    这个文件**不 import 引擎**（只要一个资源地址），所以悬停 / 点击的同一刻就能开始下载，把链路上这段空档白白省下来。
 * 2. 上游每个 Worker 的 `warm` 都会在主线程调 `editWasmModule` 取同一份模块；我们自己编译一次，
 *    由 `engines/docx.ts` 的客户端子类在 `warm` 里直接把这个 `WebAssembly.Module` 发给 Worker（`editModule` 消息），
 *    Worker 不再自己取、不再编译，无损探针的临时 Worker 也用同一份。
 * 3. 不用 `blob:` Worker、不在 Worker 里 fetch：CSP 只放行同源模块 Worker，模块对象经结构化克隆传递即可。
 *
 * 资源地址由 vite.config.ts 的别名指向 node_modules 里引擎自带的 WASM，构建后和上游自己 `new URL(...)` 引用的是
 * 同一个带内容哈希的文件（不会多出一份，`dist-report` 的 wasm 体积不变）。
 *
 * 不允许在每次打开 Word 预览时调用 `prefetchDocxWasm`：只允许悬停 / 聚焦「在线编辑」或已经点开编辑之后取。
 */
import wasmUrl from '@docx-wasm/edit/docx_edit_bg.wasm?url'

let compiled: Promise<WebAssembly.Module> | null = null

async function compile(url: string): Promise<WebAssembly.Module> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Word 引擎模块下载失败(HTTP ${response.status})`)
  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      // 边下载边编译（编译跟着字节流走，下完时已经编好）；clone 一份留给下面的非流式兜底（流只能读一次）
      return await WebAssembly.compileStreaming(response.clone())
    } catch (error) {
      // 响应头不是 application/wasm 时流式编译会拒绝，退到非流式；其余（真的编译失败）非流式也会失败，照常抛出
      if (response.headers.get('content-type') === 'application/wasm') throw error
    }
  }
  return WebAssembly.compile(await response.arrayBuffer())
}

/** 取（必要时开始下载并编译）Word 编辑引擎的 WASM 模块；失败不缓存，下次打开重试 */
export function docxEditWasmModule(): Promise<WebAssembly.Module> {
  compiled ??= compile(wasmUrl).catch((error) => {
    compiled = null
    throw error
  })
  return compiled
}

/** 只开始下载 + 编译，不关心结果（失败在真正打开时会重新触发并报错） */
export function prefetchDocxWasm(): void {
  void docxEditWasmModule().catch(() => undefined)
}
