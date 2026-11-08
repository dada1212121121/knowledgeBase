/**
 * 打开引擎之前先"偷看"一眼 pptx 里有没有中文（冷开优化）
 *
 * 为什么需要：中文字体 1.2 MB（brotli）只有 deck 里真有中文才下载。准确的判断要等引擎把 deck 解析完（快照里的文字），
 * 但那时 WASM 已经下完、解析已经做完，再串行下 1.2 MB 字体，冷开时间就是两段相加。
 * 这里只读 zip 的中央目录，解压前三页的 XML（几十 KB）扫一遍有没有汉字，有就让调用方**和 WASM 并行**去下字体。
 *
 * 这只是预测：猜错（只有后面几页有中文）不会出错，引擎解析完仍会按快照和绘制前的扫描补下载；
 * 猜中则字体与 WASM 下载重叠。读不出来（不是 zip / 浏览器没有 DecompressionStream）一律当"不知道"，不抛错。
 */
import { hasCjk } from './pptxModel'

/** 最多看前几页（含备注页之外的幻灯片 XML）；标题和正文基本都在前几页 */
const PEEK_SLIDES = 3
/** 单个 XML 解压后最多看多少字节，防止恶意压缩炸弹 */
const MAX_XML_BYTES = 2 * 1024 * 1024

interface Entry {
  name: string
  method: number
  compressedSize: number
  offset: number
}

function u16(view: DataView, at: number): number {
  return view.getUint16(at, true)
}
function u32(view: DataView, at: number): number {
  return view.getUint32(at, true)
}

/** 读中央目录；格式不对返回空数组 */
export function readEntries(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // 结尾记录在最后 22 字节之前（带注释时更靠前）
  let eocd = -1
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 22 - 0xffff); at -= 1) {
    if (u32(view, at) === 0x06054b50) {
      eocd = at
      break
    }
  }
  if (eocd < 0) return []
  const count = u16(view, eocd + 10)
  let at = u32(view, eocd + 16)
  const out: Entry[] = []
  for (let i = 0; i < count && at + 46 <= bytes.byteLength; i += 1) {
    if (u32(view, at) !== 0x02014b50) break
    const method = u16(view, at + 10)
    const compressedSize = u32(view, at + 20)
    const nameLength = u16(view, at + 28)
    const extraLength = u16(view, at + 30)
    const commentLength = u16(view, at + 32)
    const offset = u32(view, at + 42)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
    out.push({ name, method, compressedSize, offset })
    at += 46 + nameLength + extraLength + commentLength
  }
  return out
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  // 手工包一个只吐一块数据的 ReadableStream：比 Blob.stream 兼容面更宽（老 Safari、jsdom 都没有后者）
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_XML_BYTES) {
      void reader.cancel()
      break
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total > MAX_XML_BYTES ? MAX_XML_BYTES : total)
  let offset = 0
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, out.byteLength - offset)
    out.set(chunk.subarray(0, take), offset)
    offset += take
  }
  return out.subarray(0, offset)
}

async function entryText(bytes: Uint8Array, entry: Entry): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = entry.offset
  if (at + 30 > bytes.byteLength || u32(view, at) !== 0x04034b50) return ''
  const start = at + 30 + u16(view, at + 26) + u16(view, at + 28)
  const raw = bytes.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return new TextDecoder().decode(raw.subarray(0, MAX_XML_BYTES))
  if (entry.method !== 8 || typeof DecompressionStream === 'undefined') return ''
  return new TextDecoder().decode(await inflate(raw))
}

/**
 * 前几页文字节点里的全部文字（XML 实体原样保留，只用来挑字形片，不用来显示）。
 * 只看文字节点 <a:t>…</a:t>：属性值里的字（形状名、字体名 typeface="微软雅黑"）不代表要画。
 * 任何一步读不出来都返回已读到的部分（"不知道"按"没有"处理）。
 */
export async function peekDeckText(bytes: Uint8Array): Promise<string> {
  const parts: string[] = []
  try {
    const slides = readEntries(bytes)
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
      .sort((a, b) => Number(/\d+/.exec(a.name)![0]) - Number(/\d+/.exec(b.name)![0]))
      .slice(0, PEEK_SLIDES)
    for (const entry of slides) {
      const xml = await entryText(bytes, entry)
      for (const match of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)) parts.push(match[1]!)
    }
  } catch {
    // 预测失败不影响打开
  }
  return parts.join('')
}

/** 前几页的文字里有没有中文；任何一步读不出来都返回 false（"不知道"按"没有"处理） */
export async function peekDeckHasCjk(bytes: Uint8Array): Promise<boolean> {
  return hasCjk(await peekDeckText(bytes))
}
