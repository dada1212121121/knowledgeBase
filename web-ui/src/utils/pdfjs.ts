// pdf.js 的加载与配置(只在 PDF 查看器第一次打开时动态加载,~1 MB)。
//
// 为什么这么绕:
//  - CSP 是 script-src 'self':worker 必须是同源文件。`?worker&url` 让 Vite 把 worker 打成 assets/*.js
//    (直接 `?url` 引 .mjs 会被内嵌静态服务器按 octet-stream 下发,模块 worker 拒绝加载)。
//  - 用 legacy 构建:它带 core-js 兼容垫片,能补 Chrome 114 / 国产浏览器缺的 Iterator、
//    Math.sumPrecise、Uint8Array.fromBase64/toBase64；现代构建缺这些 API 会让 PDF 模块直接失败。
//  - CMap / 标准字体 / JS 回退解码器在 public/pdfjs/(scripts/copy-pdfjs-assets.mjs 复制),按需读取。
//  - 没有 'wasm-unsafe-eval':关掉 wasm,JBIG2 / JPX 走纯 JS 回退。
//  - pdf_viewer.mjs 从 globalThis.pdfjsLib 取核心库,所以要先挂上再 import 它。
import type * as PdfJs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type * as PdfViewerLib from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import { installPromiseCompat } from './promiseCompat'
import workerUrl from './pdfWorker?worker&url'

// PDF.js 6 用到 Promise.withResolvers / Promise.try：必须在动态 import 之前补齐，
// 否则旧内核会在模块求值阶段直接失败（只看到“PDF 渲染失败”，没有任何细节）。
installPromiseCompat()

export type PdfJsLib = typeof PdfJs
export type PdfViewerModule = typeof PdfViewerLib

export const PDFJS_ASSET_BASE = '/pdfjs/'

let loading: Promise<{ pdfjs: PdfJsLib; viewer: PdfViewerModule }> | null = null

export function loadPdfJs() {
  loading ??= (async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    ;(globalThis as { pdfjsLib?: PdfJsLib }).pdfjsLib = pdfjs
    const viewer = await import('pdfjs-dist/legacy/web/pdf_viewer.mjs')
    return { pdfjs, viewer }
  })().catch((error) => {
    loading = null // 下次重试(例如 chunk 拉取失败)
    throw error
  })
  return loading
}

/** getDocument 的公共参数:不执行文档脚本、不 eval、不用 wasm。
 *
 * 传 `url` 而不是整份 `data`:pdf.js 会按 Range 分段取字节,首屏只等需要的页,
 * 大 PDF 不再先缓冲完整文件;`withCredentials` 保证同源会话 Cookie 能带上。
 * 服务端 `/api/v1/download` 已支持单段 Range,`/api/v1/raw`(分享页)仍会退回整份。
 */
export function documentParams(url: string) {
  return {
    url,
    withCredentials: true,
    // 只按需拉当前页附近的数据,不把整份 PDF 提前下载完(扫描件动辄几十 MB)
    disableAutoFetch: true,
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
