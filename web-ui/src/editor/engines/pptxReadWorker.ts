/**
 * PPTX 只读：Worker 客户端与 Worker 版后端
 *
 * 取舍（量出来的，见 docs 报告里的长任务归因）：解析整份 deck 与排版一页都是一次同步的 WASM 调用，
 * 4× 降速下分别是 300~750 ms 和 20~50 ms，切不开，所以整个引擎副本放进同源模块 Worker；
 * 主线程只剩画布绘制（paintSlide）与图片解码，每一项都是毫秒级、可以一页一个任务地排。
 *
 * 失败降级：Worker 起不来（脚本加载失败、环境没有 Worker）时退回主线程打开（pptx.ts 的 openPptxReadOnMain），
 * 行为与之前一致；文档本身的错误（损坏、格式过旧）不降级，原样抛给外壳走回退链。
 */
import { decodePresentationImage, type SlideDisplayList } from '@betteroffice/pptx'
import { NATIVE_FONT_FAMILIES, loadCjkMetrics, loadLatinMetrics } from './fonts/pptxFonts'
import { sharedGlyphFaces, type GlyphFaces } from './fonts/glyphFaces'
import { EngineFrame, FONT_FAILURE_NOTICE, EMU_PER_PX } from './pptx'
import { listHasCjk, listText } from './pptxModel'
import { peekDeckText } from './pptxPeek'
import type { ReadOpenReply, ReadPrepareReply, ReadRequest, ReadResponse } from './pptxReadProtocol'
import { prefetchPptxWasm, pptxWasmModule } from './pptxWasm'
import type { SlideBackend, SlideFrame, SlideMatch, SlideSummary } from '../surfaces/slide/types'

/** Worker 本身出了问题（加载失败、崩溃），区别于「文档打不开」 */
export class ReadWorkerCrash extends Error {
  override name = 'ReadWorkerCrash'
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void }

/** 一个 Worker 的请求/应答封装：按 id 对应回包，Worker 崩溃时所有在等的请求一起失败 */
export class PptxReadClient {
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private dead: Error | null = null

  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<ReadResponse>) => {
      const reply = event.data
      const job = this.pending.get(reply.id)
      if (!job) return
      this.pending.delete(reply.id)
      if (reply.ok) job.resolve(reply.value)
      else {
        const error = new Error(reply.error.message)
        error.name = reply.error.name
        job.reject(error)
      }
    }
    worker.onerror = (event) => this.fail(new ReadWorkerCrash(event.message || '幻灯片引擎线程出错'))
    worker.onmessageerror = () => this.fail(new ReadWorkerCrash('幻灯片引擎线程的消息无法解析'))
  }

  private fail(error: Error): void {
    if (this.dead) return
    this.dead = error
    for (const job of this.pending.values()) job.reject(error)
    this.pending.clear()
    this.worker.terminate()
  }

  call<T>(request: ReadRequest, transfer: Transferable[] = []): Promise<T> {
    if (this.dead) return Promise.reject(this.dead)
    return new Promise<T>((resolve, reject) => {
      const id = (this.seq += 1)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      try {
        this.worker.postMessage({ id, ...request }, transfer)
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  terminate(): void {
    this.fail(new ReadWorkerCrash('幻灯片引擎线程已关闭'))
  }
}

/* ---------------- 预热槽 ---------------- */

interface Slot {
  client: PptxReadClient
  /** WASM 已在 Worker 里初始化好 */
  ready: Promise<void>
  timer: ReturnType<typeof setTimeout>
}

let slot: Slot | null = null
/** 预热了却没人认领（用户没点开）多久后销毁 */
const UNCLAIMED_MS = 30_000

function createSlot(): Slot | null {
  if (typeof Worker === 'undefined') return null
  let worker: Worker
  try {
    worker = new Worker(new URL('./pptxRead.worker.ts', import.meta.url), { type: 'module', name: 'kb-pptx-read' })
  } catch {
    return null
  }
  const client = new PptxReadClient(worker)
  // 模块由主线程编译一次后整个交给 Worker 实例化：不在 Worker 里再下载一遍，主线程也不实例化
  const ready = pptxWasmModule().then((wasm) => client.call<null>({ op: 'init', wasm }).then(() => undefined))
  ready.catch(() => undefined)
  const created: Slot = {
    client,
    ready,
    timer: setTimeout(() => {
      if (slot === created) slot = null
      client.terminate()
    }, UNCLAIMED_MS),
  }
  return created
}

/** 提前起 Worker、开始下载并实例化引擎；和取原件字节并行，冷开少一段串行时间 */
export function warmPptxReadWorker(): void {
  prefetchPptxWasm()
  slot ??= createSlot()
}

function takeSlot(): Slot | null {
  const taken = slot ?? createSlot()
  slot = null
  if (taken) clearTimeout(taken.timer)
  return taken
}

/* ---------------- 后端 ---------------- */

type ImageSource = CanvasImageSource | null
const IMAGE_CACHE = 48

export class PptxReadWorkerBackend implements SlideBackend {
  size = { width: 1280, height: 720 }
  private summaries: SlideSummary[]
  private texts: string[] = []
  private readonly noticeList: string[]
  private cjk: Promise<void> | null = null
  private firstList: SlideDisplayList | null = null
  private readonly images = new Map<string, Promise<ImageSource>>()
  private readonly glyphs: GlyphFaces = sharedGlyphFaces()
  private disposed = false

  constructor(
    private readonly client: PptxReadClient,
    private readonly opened: ReadOpenReply,
  ) {
    this.summaries = opened.summaries
    this.noticeList = [...opened.notices]
  }

  /** 打开之后的准备：（有中文才）登记中文度量 → 排第一页定尺寸 → 首页要用的字形 */
  async prepare(): Promise<void> {
    if (this.opened.needsCjk) await this.ensureCjk()
    const reply = await this.client.call<ReadPrepareReply>({ op: 'prepare' })
    this.texts = reply.texts
    this.firstList = reply.firstList
    this.size = reply.firstList
      ? { width: reply.firstList.width, height: reply.firstList.height }
      : { width: reply.emuSize.width / EMU_PER_PX, height: reply.emuSize.height / EMU_PER_PX }
    await this.loadGlyphs()
  }

  /** 常用拉丁字形 → 首页要用的字（取完才返回，「字体没加载成功」的提示才准）→ 其余页要用的字（后台） */
  private async loadGlyphs(): Promise<void> {
    await this.glyphs.ensureCore()
    await this.glyphs.ensureText(this.firstList ? listText(this.firstList) : '')
    void this.glyphs.ensureText(this.opened.deckText)
    if (this.glyphs.failures.size) this.noticeList.push(FONT_FAILURE_NOTICE)
  }

  private ensureCjk(): Promise<void> {
    this.cjk ??= (async () => {
      try {
        const bytes = await loadCjkMetrics()
        await this.client.call<null>({ op: 'registerCjk', bytes })
      } catch {
        this.noticeList.push('中文字体没有加载成功，中文暂时用系统字体显示，位置可能略有偏差')
      }
    })()
    return this.cjk
  }

  slides(): readonly SlideSummary[] {
    return this.summaries
  }

  notices(): readonly string[] {
    return this.noticeList
  }

  slideText(index: number): string {
    return this.texts[index] ?? ''
  }

  search(query: string): Promise<SlideMatch[]> {
    if (!query.trim() || this.disposed) return Promise.resolve([])
    return this.client.call<SlideMatch[]>({ op: 'search', query })
  }

  async frame(index: number): Promise<SlideFrame> {
    if (this.disposed) throw new Error('演示文稿已关闭')
    if (!Number.isInteger(index) || index < 0 || index >= this.summaries.length) throw new RangeError(`没有第 ${index + 1} 张幻灯片`)
    let list: SlideDisplayList
    if (index === 0 && this.firstList) {
      list = this.firstList
      this.firstList = null
    } else {
      list = await this.client.call<SlideDisplayList>({ op: 'layout', index })
    }
    // 表格 / 图表里的中文不在快照文本流里：排版出来发现有中文，补登记中文度量后重排这一页
    if (!this.cjk && listHasCjk(list)) {
      await this.ensureCjk()
      list = await this.client.call<SlideDisplayList>({ op: 'layout', index })
    }
    await this.glyphs.ensureText(listText(list))
    return new EngineFrame(list, this.resolveImage)
  }

  private resolveImage = (assetId: string): Promise<ImageSource> => {
    const hit = this.images.get(assetId)
    if (hit) {
      this.images.delete(assetId)
      this.images.set(assetId, hit)
      return hit
    }
    const loading = (async (): Promise<ImageSource> => {
      try {
        const bytes = await this.client.call<Uint8Array>({ op: 'media', assetId })
        return await decodePresentationImage(bytes, '无法解码幻灯片里的图片')
      } catch {
        // 一张图解不开不该让整页画不出来：这张留空，其余照常
        return null
      }
    })()
    this.images.set(assetId, loading)
    while (this.images.size > IMAGE_CACHE) {
      const oldest = this.images.keys().next().value
      if (oldest === undefined) break
      this.images.delete(oldest)
    }
    return loading
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.images.clear()
    this.client.terminate()
  }
}

/**
 * 用 Worker 只读打开一份 pptx。返回 null = Worker 起不来（调用方退回主线程）；
 * 文档本身有问题则抛错（和主线程路径一样）。
 */
export async function openPptxReadInWorker(bytes: Uint8Array): Promise<PptxReadWorkerBackend | null> {
  const claimed = takeSlot()
  if (!claimed) return null
  const { client, ready } = claimed
  // 与引擎下载并行：常用拉丁字形，以及前几页文字里出现的字所在的字形片（预测不全不要紧，取帧时会补取）
  const glyphs = sharedGlyphFaces()
  void glyphs.ensureCore()
  void peekDeckText(bytes).then((text) => glyphs.ensureText(text))
  try {
    const [latin] = await Promise.all([loadLatinMetrics(), ready])
    const opened = await client.call<ReadOpenReply>({ op: 'open', bytes, latin, families: NATIVE_FONT_FAMILIES })
    const backend = new PptxReadWorkerBackend(client, opened)
    try {
      await backend.prepare()
    } catch (error) {
      backend.dispose()
      throw error
    }
    return backend
  } catch (error) {
    client.terminate()
    if (error instanceof ReadWorkerCrash) return null
    throw error
  }
}
