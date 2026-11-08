// pdf.js 的加载与配置(只在 PDF 查看器第一次打开时动态加载,~1 MB)。
//
// 为什么这么绕:
//  - CSP 是 script-src 'self':worker 必须是同源文件。`?worker&url` 让 Vite 把 worker 打成 assets/*.js
//    (直接 `?url` 引 .mjs 会被内嵌静态服务器按 octet-stream 下发,模块 worker 拒绝加载)。
//  - CMap / 标准字体 / JS 回退解码器在 public/pdfjs/(scripts/copy-pdfjs-assets.mjs 复制),按需读取。
//  - 没有 'wasm-unsafe-eval':关掉 wasm,JBIG2 / JPX 走纯 JS 回退。
//  - pdf_viewer.mjs 从 globalThis.pdfjsLib 取核心库,所以要先挂上再 import 它。
import type * as PdfJs from 'pdfjs-dist'
import type * as PdfViewerLib from 'pdfjs-dist/web/pdf_viewer.mjs'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url'

export type PdfJsLib = typeof PdfJs
export type PdfViewerModule = typeof PdfViewerLib

export const PDFJS_ASSET_BASE = '/pdfjs/'

let loading: Promise<{ pdfjs: PdfJsLib; viewer: PdfViewerModule }> | null = null

export function loadPdfJs() {
  loading ??= (async () => {
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    ;(globalThis as { pdfjsLib?: PdfJsLib }).pdfjsLib = pdfjs
    const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs')
    return { pdfjs, viewer }
  })().catch((error) => {
    loading = null // 下次重试(例如 chunk 拉取失败)
    throw error
  })
  return loading
}

/** getDocument 的公共参数:不执行文档脚本、不 eval、不用 wasm。 */
export function documentParams(data: ArrayBuffer) {
  return {
    data: new Uint8Array(data),
    cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
    iccUrl: `${PDFJS_ASSET_BASE}iccs/`,
    wasmUrl: `${PDFJS_ASSET_BASE}wasm/`,
    useWasm: false,
    isEvalSupported: false,
    enableScripting: false,
  }
}
