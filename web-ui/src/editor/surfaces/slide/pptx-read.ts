/**
 * PPTX 只读后端的装配：取原件字节 → 动态加载引擎 → 打开
 *
 * 引擎（JS 约 100 KB + WASM 6.3 MB）放在动态 import 后面：幻灯片面本身的 chunk 很小，
 * 引擎只在真有人打开 pptx 时才下载，不进首屏、不进阅读其它格式的路径。
 * 解析和排版在同源模块 Worker 里做（engines/pptxReadWorker.ts），主线程只画；Worker 起不来才退回主线程。
 */
import { fetchOriginal, OriginalError } from '@/utils/fetchOriginal'
import type { EditorSource } from '../../types'
import type { SlideLoaderFactory } from './surface'
import { SlideSurface } from './surface'

/** 从打开请求里取字节：宿主已经给了字节就直接用，否则按原件地址下载（带进度、可取消） */
export async function readSourceBytes(source: EditorSource | null, signal: AbortSignal, onProgress: (ratio: number) => void): Promise<Uint8Array> {
  if (source?.kind === 'bytes' && source.bytes.byteLength) return source.bytes
  if (!source?.url) throw new Error('演示文稿缺少可读取的原件地址')
  const buffer = await fetchOriginal(source.url, { signal, onProgress: (done, total) => onProgress(total ? done / total : 0) })
  return new Uint8Array(buffer)
}

export const createPptxReadLoader: SlideLoaderFactory = (ctx) => async ({ signal, onProgress }) => {
  // 引擎（JS + WASM + 拉丁字体）和原件同时开始下载、Worker 同时起来并实例化 WASM：冷开时几段时间重叠。
  // 代价是原件读不到时白下了引擎——那种情况很少，而且字节有 HTTP 缓存，下次不会再付
  const engine = import('../../engines/pptxRead').then((module) => {
    module.warmPptxEngine()
    return module
  })
  void engine.catch(() => undefined)
  let bytes: Uint8Array
  try {
    bytes = await readSourceBytes(ctx.document.payload as EditorSource | null, signal, onProgress)
  } catch (error) {
    if (error instanceof OriginalError) throw new Error(error.message)
    throw error
  }
  const { openPptxRead } = await engine
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  try {
    return await openPptxRead(bytes)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`这份演示文稿渲染失败（可能已损坏或格式过旧）：${reason}`)
  }
}

/** 注册表工厂：只读幻灯片面 */
export function createPptxReadSurface(): SlideSurface {
  return new SlideSurface(createPptxReadLoader)
}
