/**
 * PPTX 只读引擎 Worker（同源模块 Worker，CSP `worker-src 'self'`，不用 blob:）
 *
 * 持有解析好的 `PresentationHandle`，按请求排版某一页、取图片字节、查找文字。
 * 与原来主线程只读后端（pptx.ts 的 PptxReadBackend）的行为逐项对应，差别只在「在哪个线程」：
 * 登记字体的顺序、第一页的排版、读屏文字的取法都没变，所以画面不变。
 */
import { initWasm, openPresentation, type PresentationHandle } from '@betteroffice/pptx'
import { deckText, fontNotice, hasCjk, slideTitle, substitutedFonts } from './pptxModel'
import type { ReadOpenReply, ReadPrepareReply, ReadRequest, ReadResponse } from './pptxReadProtocol'
import type { SlideMatch } from '../surfaces/slide/types'

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<{ id: number } & ReadRequest>) => void) | null
}

let handle: PresentationHandle | null = null
let families: readonly string[] = []
let engineReady: Promise<void> | null = null

function need(): PresentationHandle {
  if (!handle) throw new Error('演示文稿还没有打开')
  return handle
}

function open(request: Extract<ReadRequest, { op: 'open' }>): ReadOpenReply {
  families = request.families
  handle = openPresentation(request.bytes, {
    fonts: families.flatMap((family) => [
      { family, bytes: request.latin.regular },
      { family, bold: true, bytes: request.latin.bold },
    ]),
  })
  const snapshot = handle.snapshot()
  const notices: string[] = []
  const notice = fontNotice(substitutedFonts(snapshot))
  if (notice) notices.push(notice)
  const text = deckText(snapshot)
  return {
    summaries: snapshot.slides.map((slide) => ({
      id: slide.id,
      title: slideTitle(slide),
      notes: slide.notes ?? '',
      hidden: !!slide.hidden,
    })),
    notices,
    deckText: text,
    needsCjk: hasCjk(text),
  }
}

function prepare(): ReadPrepareReply {
  const h = need()
  const snapshot = h.snapshot()
  const texts = snapshot.slides.map((slide) => {
    const result = h.readContent({ slideIds: [slide.id] })
    return result.ok ? result.stories.map((story) => story.text).filter(Boolean).join('\n') : ''
  })
  // 第一页的排版决定页面尺寸；留给主线程当第一帧用，不重复排
  return { firstList: snapshot.slides.length ? h.layoutSlide(0) : null, emuSize: { width: snapshot.widthEmu, height: snapshot.heightEmu }, texts }
}

function search(query: string): SlideMatch[] {
  if (!query.trim()) return []
  return need()
    .searchText(query, { caseSensitive: false, limit: 2000 })
    .map((match) => ({
      slide: match.slideIndex,
      shapeId: match.shapeId,
      storyId: match.storyId,
      start: match.start,
      end: match.end,
      text: match.text,
    }))
}

async function run(request: ReadRequest): Promise<{ value: unknown; transfer?: Transferable[] }> {
  switch (request.op) {
    case 'init':
      engineReady ??= initWasm(request.wasm)
      await engineReady
      return { value: null }
    case 'open':
      // 主线程总是先发 init（预热或打开时），这里只是兜底
      if (!engineReady) throw new Error('引擎还没有初始化')
      await engineReady
      return { value: open(request) }
    case 'registerCjk':
      for (const family of families) need().registerFont({ family, bytes: request.bytes })
      return { value: null }
    case 'prepare':
      return { value: prepare() }
    case 'layout':
      return { value: need().layoutSlide(request.index) }
    case 'media': {
      // 复制一份再转移：WASM 返回的可能是线性内存上的视图，转移它会把整块内存作废
      const bytes = need().mediaBytes(request.assetId).slice()
      return { value: bytes, transfer: [bytes.buffer as ArrayBuffer] }
    }
    case 'search':
      return { value: search(request.query) }
  }
}

scope.onmessage = (event) => {
  const { id, ...request } = event.data
  void run(request as ReadRequest).then(
    ({ value, transfer }) => scope.postMessage({ id, ok: true, value } satisfies ReadResponse, transfer),
    (error: unknown) =>
      scope.postMessage({
        id,
        ok: false,
        error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) },
      } satisfies ReadResponse),
  )
}
