/**
 * PPTX 只读入口（幻灯片面的只读加载器动态 import 的就是它）
 *
 * 默认路径：同源模块 Worker 里解析 / 排版，主线程只画（pptxReadWorker.ts）。
 * Worker 起不来时退回主线程打开（pptx.ts 的 openPptxReadOnMain），行为一致，只是回到长任务。
 */
import { loadLatinMetrics } from './fonts/pptxFonts'
import { sharedGlyphFaces } from './fonts/glyphFaces'
import { ensureEngine, openPptxReadOnMain, type PptxReadBackend } from './pptx'
import { openPptxReadInWorker, warmPptxReadWorker, type PptxReadWorkerBackend } from './pptxReadWorker'

/**
 * 提前开始下载引擎（WASM 1.6 MB brotli）、起 Worker 并让它实例化、下载字体。调用方在去取原件字节的同时调用它，
 * 几段下载与初始化重叠，冷开时间少一个原件往返；失败在这里吞掉，真正打开时会重新触发并报错。
 */
export function warmPptxEngine(): void {
  warmPptxReadWorker()
  void loadLatinMetrics().catch(() => undefined)
  void sharedGlyphFaces().ensureCore()
}

/** 只读打开一份 pptx。失败（文件损坏 / 引擎拒绝）会抛错，外壳据此走回退链。 */
export async function openPptxRead(bytes: Uint8Array): Promise<PptxReadWorkerBackend | PptxReadBackend> {
  const inWorker = await openPptxReadInWorker(bytes)
  if (inWorker) return inWorker
  await ensureEngine()
  return openPptxReadOnMain(bytes)
}
