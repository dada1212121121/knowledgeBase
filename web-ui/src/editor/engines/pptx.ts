/**
 * PPTX Headless 引擎适配层（只读；现在追加编辑会话）
 *
 * 工程铁律：全仓只有 `src/editor/engines/` 允许 import `@betteroffice/pptx`。
 * 本文件把「打开 → 布局 → 绘制」收成 `SlideBackend`（见 surfaces/slide/types.ts），外壳只认这个契约。
 *
 * 关键取舍（来自 实测报告 的踩坑记录）：
 * 1. 只读默认在同源模块 Worker 里解析和排版（pptxReadWorker.ts）：4× 降速下解析 30 页 deck 要 300~750 ms、
 *    排一页 20~50 ms，都是一次不可切分的 WASM 调用，放在主线程就是长任务。本文件里的 `openPptxReadOnMain`
 * 只在 Worker 起不来时用；编辑态本来就要在主线程持有同一份 peer（见下文），那条路径仍走这里的基类。
 * 2. 画布绘制走浏览器字体：引擎拿到字节做排版，`paintSlide` 却用 `ctx.font` 里的族名取浏览器字体，
 *    所以宿主必须把**同样的字节**再登记成 `FontFace`，否则拉丁字母会退回系统衬线体、宽度对不上。
 * 3. 排版与画字分开喂字体：引擎排版只拿度量字体（几十 KB，字形轮廓清空，见 fonts/pptxFonts.ts），
 *    浏览器画字用的字形按文档里实际出现的字分片加载（fonts/glyphFaces.ts）。原来整套 Carlito + Noto Sans SC
 *    要 1.6 MB brotli，占冷开传输近一半；一份典型中文 deck 现在只取 150~450 KB，纯拉丁 deck 约 50 KB。
 *    是否把中文度量登记进引擎仍按「文档里有没有中文」来：登记会让英文字宽跟着变（引擎的同族名后登记者覆盖常规体），
 *    这是现有的排版行为，必须原样保留，不能因为字体变小就改了。
 */
import { decodePresentationImage, initWasm, openPresentation, paintSlide, type DeckSnapshot, type PresentationHandle, type SlideDisplayList } from '@betteroffice/pptx'
import { NATIVE_FONT_FAMILIES, loadCjkMetrics, loadLatinMetrics } from './fonts/pptxFonts'
import { sharedGlyphFaces, type GlyphFaces } from './fonts/glyphFaces'
import type { SlideBackend, SlideFrame, SlideMatch, SlideRect, SlideSummary } from '../surfaces/slide/types'
import { deckText, fontNotice, hasCjk, listHasCjk, listText, slideTitle, substitutedFonts, textRectsFor } from './pptxModel'
import { peekDeckText } from './pptxPeek'
import { pptxWasmModule } from './pptxWasm'

/** EMU（English Metric Unit）→ CSS 像素：914400 EMU = 1 英寸 = 96 px */
export const EMU_PER_PX = 9525
/** 解码后的图片最多缓存多少张（同一张徽标在每页都出现很常见，重复解码很贵） */
const IMAGE_CACHE = 48

/** 字体没有加载成功时给用户的提示（排版仍按引擎度量，只是字形退回系统字体，位置可能略有偏差） */
export const FONT_FAILURE_NOTICE = '字体没有加载成功，文字暂时用系统字体显示，位置可能略有偏差'

/* ---------------- 后端 ---------------- */

type ImageSource = CanvasImageSource | null

export class EngineFrame implements SlideFrame {
  readonly width: number
  readonly height: number

  constructor(
    private readonly list: SlideDisplayList,
    private readonly resolveImage: (assetId: string) => Promise<ImageSource>,
  ) {
    this.width = list.width
    this.height = list.height
  }

  paint(ctx: CanvasRenderingContext2D, dpr: number, scale: number): Promise<void> {
    return paintSlide(ctx, this.list, dpr, scale, { resolveImage: this.resolveImage })
  }

  textRects(match: { storyId: string; start: number; end: number }): SlideRect[] {
    return textRectsFor(this.list, match)
  }
}

/** 读取和绘制用到的那一小块句柄：只读的 `PresentationHandle` 和编辑会话的 peer（`PptxWorkerEditorAccess`）都满足它 */
export type ReadHandle = Pick<PresentationHandle, 'layoutSlide' | 'snapshot' | 'mediaBytes' | 'readContent' | 'searchText'>

/**
 * 只读与编辑共用的后端：目录、取帧、图片解码、全文查找、读屏文字。
 * 编辑后端在此之上追加编辑接口（见 pptxEdit.ts）；两者的差别只在句柄从哪来、字体怎么登记。
 */
export abstract class PptxBackendBase implements SlideBackend {
  size = { width: 1280, height: 720 }
  protected summaries: SlideSummary[] = []
  protected readonly images = new Map<string, Promise<ImageSource>>()
  protected readonly texts = new Map<number, string>()
  protected readonly noticeList: string[] = []
  protected disposed = false
  /** 中文度量是否已经登记进引擎（编辑后端打开时就带上了，只读后端按需登记） */
  protected cjk: Promise<void> | null = null
  protected firstList: SlideDisplayList | null = null
  /** 浏览器字形：按文字分片加载，整个页面共用一份 */
  protected readonly glyphs: GlyphFaces = sharedGlyphFaces()

  protected abstract get h(): ReadHandle
  abstract dispose(): void | Promise<void>

  /** 只读后端在这里补登记中文度量；编辑后端不需要 */
  protected ensureCjk(): Promise<void> {
    return Promise.resolve()
  }

  /** 从快照重建目录与提示；编辑后每次内容变化后调用 */
  protected readSummaries(snapshot: DeckSnapshot = this.h.snapshot()): void {
    this.summaries = snapshot.slides.map((slide) => ({
      id: slide.id,
      title: slideTitle(slide),
      notes: slide.notes ?? '',
      hidden: !!slide.hidden,
    }))
    this.texts.clear()
  }

  slides(): readonly SlideSummary[] {
    return this.summaries
  }

  notices(): readonly string[] {
    return this.noticeList
  }

  async frame(index: number): Promise<SlideFrame> {
    if (this.disposed) throw new Error('演示文稿已关闭')
    if (!Number.isInteger(index) || index < 0 || index >= this.summaries.length) throw new RangeError(`没有第 ${index + 1} 张幻灯片`)
    let list = index === 0 && this.firstList ? this.firstList : this.h.layoutSlide(index)
    if (index === 0) this.firstList = null
    // 表格 / 图表里的中文不在快照文本流里：布局出来发现有中文，补登记中文度量后重排这一页
    if (!this.cjk && listHasCjk(list)) {
      await this.ensureCjk()
      list = this.h.layoutSlide(index)
    }
    // 画之前要有这页文字的字形（排版只靠度量，与字形有没有加载无关，所以不用再重排）。
    // 已经加载过的片这里是个已完成的 Promise；新出现的字（编辑时敲进来的）第一次会等一次下载
    await this.glyphs.ensureText(listText(list))
    return new EngineFrame(list, this.resolveImage)
  }

  protected resolveImage = (assetId: string): Promise<ImageSource> => {
    const hit = this.images.get(assetId)
    if (hit) {
      this.images.delete(assetId)
      this.images.set(assetId, hit)
      return hit
    }
    const loading = (async (): Promise<ImageSource> => {
      try {
        return await decodePresentationImage(this.h.mediaBytes(assetId), '无法解码幻灯片里的图片')
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

  slideText(index: number): string {
    const cached = this.texts.get(index)
    if (cached !== undefined) return cached
    const id = this.summaries[index]?.id
    if (!id) return ''
    const result = this.h.readContent({ slideIds: [id] })
    const text = result.ok ? result.stories.map((story) => story.text).filter(Boolean).join('\n') : ''
    this.texts.set(index, text)
    return text
  }

  search(query: string): SlideMatch[] {
    if (!query.trim() || this.disposed) return []
    return this.h.searchText(query, { caseSensitive: false, limit: 2000 }).map((match) => ({
      slide: match.slideIndex,
      shapeId: match.shapeId,
      storyId: match.storyId,
      start: match.start,
      end: match.end,
      text: match.text,
    }))
  }

  /**
   * 打开后的字形准备（读 / 编辑 / 协同共用）：常用拉丁字形 → 首页要用的字 → 其余页要用的字（后台）。
   * 首页先取、取完才返回，这样「字体没有加载成功」的提示是准确的；其余页等首页取完再取（缩略图要用），不和首屏抢带宽。
   */
  async loadGlyphs(snapshot?: DeckSnapshot): Promise<void> {
    await this.glyphs.ensureCore()
    await this.glyphs.ensureText(this.firstList ? listText(this.firstList) : '')
    void this.glyphs.ensureText(deckText(snapshot ?? this.h.snapshot()))
    if (this.glyphs.failures.size) this.noticeList.push(FONT_FAILURE_NOTICE)
  }

  /** 第一次布局决定页面尺寸（以真实的显示列表为准，EMU 换算有取整差），并把这次布局留给第一次取帧，不重复算 */
  protected measureSize(snapshot: DeckSnapshot = this.h.snapshot()): void {
    if (snapshot.slides.length) {
      this.firstList = this.h.layoutSlide(0)
      this.size = { width: this.firstList.width, height: this.firstList.height }
    } else {
      this.size = { width: snapshot.widthEmu / EMU_PER_PX, height: snapshot.heightEmu / EMU_PER_PX }
    }
  }
}

export class PptxReadBackend extends PptxBackendBase {
  constructor(private readonly handle: PresentationHandle) {
    super()
  }

  protected get h(): ReadHandle {
    return this.handle
  }

  /** 打开之后的准备：目录、尺寸、字体提示，以及首页要用的字形 */
  async prepare(): Promise<void> {
    this.readSummaries()
    const snapshot = this.handle.snapshot()
    const notice = fontNotice(substitutedFonts(snapshot))
    if (notice) this.noticeList.push(notice)
    if (hasCjk(deckText(snapshot))) await this.ensureCjk()
    this.measureSize()
    await this.loadGlyphs()
  }

  protected override ensureCjk(): Promise<void> {
    this.cjk ??= (async () => {
      try {
        const bytes = await loadCjkMetrics()
        for (const family of NATIVE_FONT_FAMILIES) this.handle.registerFont({ family, bytes })
      } catch {
        this.noticeList.push('中文字体没有加载成功，中文暂时用系统字体显示，位置可能略有偏差')
      }
    })()
    return this.cjk
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.images.clear()
    this.texts.clear()
    try {
      this.handle.dispose()
    } catch {
      // 句柄已经失效（比如 WASM 内存被回收）时释放失败可以忽略
    }
  }
}

let engineReady: Promise<void> | null = null

/**
 * WASM 只初始化一次；失败不缓存（网络抖动后再开一次能成功）。
 * 用自己编译好的模块初始化（见 pptxWasm.ts）：编辑会话的 Worker 拿同一个模块，不再各取各的。
 */
export function ensureEngine(): Promise<void> {
  engineReady ??= pptxWasmModule()
    .then((module) => initWasm(module))
    .catch((error) => {
      engineReady = null
      throw error
    })
  return engineReady
}

/**
 * 在主线程只读打开一份 pptx（Worker 起不来时的退路；默认路径见 pptxRead.ts / pptxReadWorker.ts）。
 * 失败（文件损坏 / 引擎拒绝）会抛错，外壳据此走回退链。
 * WASM、度量字体、常用拉丁字形并行下载；先偷看前几页的文字（见 pptxPeek.ts），把这些字所在的字形片也一起预取，
 * 不等引擎解析完。预测不全不会出错：首页和其余页的字形在 `prepare` / 取帧时按真实内容补取。
 */
export async function openPptxReadOnMain(bytes: Uint8Array): Promise<PptxReadBackend> {
  const glyphs = sharedGlyphFaces()
  void glyphs.ensureCore()
  void peekDeckText(bytes).then((text) => glyphs.ensureText(text))
  const [latin] = await Promise.all([loadLatinMetrics(), ensureEngine()])
  const handle = openPresentation(bytes, {
    fonts: NATIVE_FONT_FAMILIES.flatMap((family) => [
      { family, bytes: latin.regular },
      { family, bold: true, bytes: latin.bold },
    ]),
  })
  const backend = new PptxReadBackend(handle)
  try {
    await backend.prepare()
  } catch (error) {
    backend.dispose()
    throw error
  }
  return backend
}
