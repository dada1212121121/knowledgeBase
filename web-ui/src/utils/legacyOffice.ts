// 老版 Office 二进制格式(.doc / .ppt,OLE 复合文档)的文字抽取。浏览器里没有可靠的渲染器,
// 所以这里只取**文字与表格**(不含版式、图片、批注),在查看器里按阅读视图显示并明确标注。
//   .doc:读 WordDocument 流的 FIB → 表流里的 Clx/PlcPcd(文本片段表)→ 按片段拼出正文,
//         再按 \r(段落)、\x07(单元格 / 行尾)、域代码 \x13..\x15 清理成段落与表格;
//   .ppt:遍历 PowerPoint Document 流的记录树,每个 Slide 容器里的 TextChars / TextBytes 原子按顺序取出,
//         TextHeader 的类型(0 / 6 = 标题)用来分出标题与正文;Notes 容器单独收集。
// 参考:[MS-DOC] 2.4.1 / 2.9.177,[MS-PPT] 2.4.* 。解析失败一律抛 LegacyOfficeError,由查看器退回提示。
import * as CFB from 'cfb'

export class LegacyOfficeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LegacyOfficeError'
  }
}

export interface OleFile {
  names: string[]
  stream(name: string): Uint8Array | null
}

export function openOle(bytes: Uint8Array): OleFile {
  let container: CFB.CFB$Container
  try {
    container = CFB.read(bytes, { type: 'array' })
  } catch {
    throw new LegacyOfficeError('不是有效的 Office 复合文档(文件可能已损坏)')
  }
  const names = container.FileIndex.filter((entry) => entry.type === 2).map((entry) => entry.name)
  return {
    names,
    stream(name) {
      const entry = CFB.find(container, `/${name}`) ?? container.FileIndex.find((item) => item.name === name && item.type === 2)
      const content = entry?.content
      if (!content) return null
      return content instanceof Uint8Array ? content : Uint8Array.from(content as ArrayLike<number>)
    },
  }
}

const u16 = (view: DataView, at: number) => view.getUint16(at, true)
const u32 = (view: DataView, at: number) => view.getUint32(at, true)
const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/* ------------------------------------------------------------------ .doc */

export type DocBlock = { kind: 'p'; text: string } | { kind: 'table'; rows: string[][] }

/** 把 Word 的字符流整理成段落 / 表格。 */
export function structureWordText(raw: string): DocBlock[] {
  // 1) 域:\x13 代码 \x14 结果 \x15;只保留结果。没有 \x14 的整个丢掉(如 TOC / PAGEREF 之类的纯代码)
  let cleaned = ''
  const stack: { hasResult: boolean; inCode: boolean }[] = []
  for (const char of raw) {
    const code = char.charCodeAt(0)
    if (code === 0x13) {
      stack.push({ hasResult: false, inCode: true })
      continue
    }
    if (code === 0x14 && stack.length) {
      const top = stack[stack.length - 1]!
      top.hasResult = true
      top.inCode = false
      continue
    }
    if (code === 0x15 && stack.length) {
      stack.pop()
      continue
    }
    if (stack.some((field) => field.inCode)) continue
    cleaned += char
  }
  // 2) 控制字符
  cleaned = cleaned
    .replace(/\x0b/g, '\n')
    .replace(/\x0c/g, '\r')
    .replace(/\x1e/g, '-')
    .replace(/[\x00-\x06\x08\x0e-\x12\x16-\x1d\x1f]/g, '')
  // 3) 段落与表格:\r 结束段落,\x07 结束单元格;连续两个 \x07(空单元格)= 行尾
  const blocks: DocBlock[] = []
  let row: string[] = []
  let table: string[][] = []
  const flushTable = () => {
    if (table.length) blocks.push({ kind: 'table', rows: table })
    table = []
  }
  let buffer = ''
  for (const char of cleaned) {
    if (char === '\x07') {
      if (buffer === '' && row.length) {
        table.push(row)
        row = []
      } else {
        row.push(buffer.trim())
      }
      buffer = ''
    } else if (char === '\r') {
      if (row.length) {
        // 表格行内遇到 \r:当成单元格内换行
        buffer += '\n'
        continue
      }
      flushTable()
      blocks.push({ kind: 'p', text: buffer })
      buffer = ''
    } else {
      buffer += char
    }
  }
  if (row.length) table.push(row)
  flushTable()
  if (buffer.trim()) blocks.push({ kind: 'p', text: buffer })
  // 压掉连续空段落(保留单个作段间距)
  const out: DocBlock[] = []
  for (const block of blocks) {
    const empty = block.kind === 'p' && block.text.trim() === ''
    if (empty && (out.length === 0 || (out[out.length - 1]!.kind === 'p' && (out[out.length - 1] as { text: string }).text.trim() === ''))) continue
    out.push(block)
  }
  return out
}

/** 读 .doc 的正文文本(未整理)。 */
export function readWordText(ole: OleFile): string {
  const main = ole.stream('WordDocument')
  if (!main || main.byteLength < 0x1a6 + 4) throw new LegacyOfficeError('没有找到 Word 正文流,可能不是 .doc 文件')
  const view = viewOf(main)
  if (u16(view, 0) !== 0xa5ec) throw new LegacyOfficeError('不是 Word 97 及以后的 .doc 格式(更老的 Word 6/95 不支持)')
  const flags = u16(view, 0x0a)
  if (flags & 0x0100) throw new LegacyOfficeError('这份文档设置了密码加密,无法在页内预览')
  const table = ole.stream(flags & 0x0200 ? '1Table' : '0Table')
  if (!table) throw new LegacyOfficeError('缺少 Word 表流(文档可能已损坏)')
  const textLength = u32(view, 0x4c) // ccpText:主文档字符数
  const clxAt = u32(view, 0x1a2)
  const clxLen = u32(view, 0x1a6)
  if (!clxLen || clxAt + clxLen > table.byteLength) throw new LegacyOfficeError('文本片段表缺失或越界(文档可能已损坏)')
  const clx = viewOf(table.subarray(clxAt, clxAt + clxLen))
  let at = 0
  while (at < clx.byteLength && clx.getUint8(at) === 0x01) at += 3 + clx.getUint16(at + 1, true)
  if (clx.getUint8(at) !== 0x02) throw new LegacyOfficeError('文本片段表格式不对')
  const plcLen = clx.getUint32(at + 1, true)
  const plc = at + 5
  const pieces = Math.floor((plcLen - 4) / 12)
  if (pieces <= 0 || plc + plcLen > clx.byteLength) throw new LegacyOfficeError('文本片段表为空')
  const cpAt = (index: number) => clx.getUint32(plc + index * 4, true)
  const pcdAt = (index: number) => plc + (pieces + 1) * 4 + index * 8
  const ansi = new TextDecoder('windows-1252')
  const unicode = new TextDecoder('utf-16le')
  let out = ''
  for (let index = 0; index < pieces && out.length < textLength; index += 1) {
    const from = cpAt(index)
    const to = Math.min(cpAt(index + 1), textLength)
    if (to <= from) continue
    const count = to - from
    const fcRaw = clx.getUint32(pcdAt(index) + 2, true)
    const compressed = (fcRaw & 0x40000000) !== 0
    const fc = fcRaw & 0x3fffffff
    if (compressed) {
      const start = fc >> 1
      if (start + count > main.byteLength) throw new LegacyOfficeError('文本片段越界(文档可能已损坏)')
      out += ansi.decode(main.subarray(start, start + count))
    } else {
      if (fc + count * 2 > main.byteLength) throw new LegacyOfficeError('文本片段越界(文档可能已损坏)')
      out += unicode.decode(main.subarray(fc, fc + count * 2))
    }
  }
  return out
}

export function extractDoc(bytes: Uint8Array): DocBlock[] {
  const blocks = structureWordText(readWordText(openOle(bytes)))
  if (!blocks.length) throw new LegacyOfficeError('文档里没有可显示的文字')
  return blocks
}

/* ------------------------------------------------------------------ .ppt */

export interface PptSlide {
  title: string
  body: string[]
  notes: string[]
}

const RT_SLIDE = 0x03ee
const RT_NOTES = 0x03f0
const RT_TEXT_HEADER = 0x0f9f
const RT_TEXT_CHARS = 0x0fa0
const RT_TEXT_BYTES = 0x0fa8
const TITLE_TYPES = new Set([0, 6])

interface Collected {
  title: string[]
  body: string[]
}

function collectText(view: DataView, bytes: Uint8Array, from: number, to: number, out: Collected, state: { type: number }) {
  const ansi = new TextDecoder('windows-1252')
  const unicode = new TextDecoder('utf-16le')
  let at = from
  while (at + 8 <= to) {
    const verInstance = u16(view, at)
    const type = u16(view, at + 2)
    const length = u32(view, at + 4)
    const body = at + 8
    const end = body + length
    if (end > to) break
    if ((verInstance & 0x0f) === 0x0f) {
      collectText(view, bytes, body, end, out, state)
    } else if (type === RT_TEXT_HEADER && length >= 4) {
      state.type = u32(view, body)
    } else if (type === RT_TEXT_CHARS || type === RT_TEXT_BYTES) {
      const raw = type === RT_TEXT_CHARS ? unicode.decode(bytes.subarray(body, body + (length & ~1))) : ansi.decode(bytes.subarray(body, end))
      const text = raw.replace(/\r\n?/g, '\n').replace(/[\x0b\u000b]/g, '\n').replace(/[\x00-\x08\x0c\x0e-\x1f]/g, '').trim()
      if (text) (TITLE_TYPES.has(state.type) ? out.title : out.body).push(text)
      state.type = -1
    }
    at = end
  }
}

export function extractPpt(bytes: Uint8Array): PptSlide[] {
  const stream = openOle(bytes).stream('PowerPoint Document')
  if (!stream) throw new LegacyOfficeError('没有找到 PowerPoint 正文流,可能不是 .ppt 文件')
  const view = viewOf(stream)
  const slides: PptSlide[] = []
  const notes: string[][] = []
  let at = 0
  while (at + 8 <= stream.byteLength) {
    const verInstance = u16(view, at)
    const type = u16(view, at + 2)
    const length = u32(view, at + 4)
    const body = at + 8
    const end = body + length
    if (end > stream.byteLength) break
    if (type === RT_SLIDE || type === RT_NOTES) {
      const collected: Collected = { title: [], body: [] }
      collectText(view, stream, body, end, collected, { type: -1 })
      if (type === RT_SLIDE) {
        slides.push({ title: collected.title.join(' '), body: collected.body, notes: [] })
      } else {
        notes.push([...collected.title, ...collected.body])
      }
    } else if ((verInstance & 0x0f) !== 0x0f && length > stream.byteLength) {
      break
    }
    at = end
  }
  if (!slides.length) throw new LegacyOfficeError('演示文稿里没有找到幻灯片文字')
  // 备注页与幻灯片的对应关系在持久化目录里,这里只在两边数量一致时按顺序配对,否则不猜
  if (notes.length === slides.length) notes.forEach((lines, index) => (slides[index]!.notes = lines))
  return slides
}
