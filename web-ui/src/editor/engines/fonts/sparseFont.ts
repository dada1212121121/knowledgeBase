/**
 * 稀疏字体的拼装：把「核心字体」和若干「扩展字形包」拼回一个完整的 TTF（格式与生成见 scripts/build-docx-fonts.py）。
 *
 * - 核心字体是合法的 TTF：所有度量表原样，`glyf` 里只有核心字形有轮廓，`loca` 是长格式；
 * - 扩展字形包是只有 `glyf`（字形轮廓原样拼接）和私有表 `KGix`（条数 u32，每条 gid u16 + 字节数 u32）的 sfnt 容器。
 *
 * 拼装只做一件事：按 gid 顺序重新摆放 `glyf` / `loca`，扩展包里有的字形覆盖核心里的空字形，其余表一字节不动。
 * 所以排版用的度量（cmap / hmtx / GPOS / kern …）永远和完整字体一致，只有「轮廓有没有到位」不同；
 * 核心 + 全部扩展包拼出来的每个字形与原字体逐字节相同（生成脚本 `--verify` 与本文件的单测都检查）。
 */

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** 读 sfnt 表目录；文件被截断 / 表越界时抛错（下载到坏文件时不要把它交给引擎） */
export function readSfnt(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength < 12) throw new Error('字体文件太短')
  const data = view(bytes)
  const count = data.getUint16(4)
  const tables = new Map<string, Uint8Array>()
  for (let i = 0; i < count; i += 1) {
    const at = 12 + 16 * i
    if (at + 16 > bytes.byteLength) throw new Error('字体表目录被截断')
    const tag = String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)
    const offset = data.getUint32(at + 8)
    const length = data.getUint32(at + 12)
    if (offset + length > bytes.byteLength) throw new Error(`字体表 ${tag} 越界`)
    tables.set(tag, bytes.subarray(offset, offset + length))
  }
  return tables
}

/** 读扩展字形包：gid → 字形字节（子视图，不拷贝） */
export function readGlyphPack(pack: Uint8Array): Map<number, Uint8Array> {
  const tables = readSfnt(pack)
  const glyf = tables.get('glyf')
  const index = tables.get('KGix')
  if (!glyf || !index) throw new Error('不是扩展字形包（缺少 glyf / KGix）')
  const data = view(index)
  const count = data.getUint32(0)
  if (index.byteLength < 4 + count * 6) throw new Error('扩展字形包的索引被截断')
  const glyphs = new Map<number, Uint8Array>()
  let cursor = 0
  for (let i = 0; i < count; i += 1) {
    const gid = data.getUint16(4 + i * 6)
    const length = data.getUint32(6 + i * 6)
    if (cursor + length > glyf.byteLength) throw new Error('扩展字形包的字形越界')
    glyphs.set(gid, glyf.subarray(cursor, cursor + length))
    cursor += length
  }
  return glyphs
}

/** 表校验和：按 4 字节大端字相加（末尾不足 4 字节按 0 补） */
function checksum(bytes: Uint8Array): number {
  const data = view(bytes)
  const whole = bytes.byteLength - (bytes.byteLength % 4)
  let sum = 0
  for (let i = 0; i < whole; i += 4) sum = (sum + data.getUint32(i)) >>> 0
  if (whole < bytes.byteLength) {
    let tail = 0
    for (let i = whole; i < bytes.byteLength; i += 1) tail |= bytes[i]! << (24 - 8 * (i - whole))
    sum = (sum + (tail >>> 0)) >>> 0
  }
  return sum
}

/** 写 sfnt；有 head 表时校正 checkSumAdjustment（与 build-docx-fonts.py 的 write_sfnt 同一算法） */
function writeSfnt(tables: Map<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort()
  const count = tags.length
  const entrySelector = Math.floor(Math.log2(count))
  const searchRange = 2 ** entrySelector * 16
  const directory = 12 + 16 * count
  let total = directory
  for (const tag of tags) total += Math.ceil(tables.get(tag)!.byteLength / 4) * 4
  const out = new Uint8Array(total)
  const data = view(out)
  data.setUint32(0, 0x00010000)
  data.setUint16(4, count)
  data.setUint16(6, searchRange)
  data.setUint16(8, entrySelector)
  data.setUint16(10, count * 16 - searchRange)
  let offset = directory
  let headAt = -1
  tags.forEach((tag, i) => {
    let table = tables.get(tag)!
    if (tag === 'head') {
      // checkSumAdjustment 先清零再算校验和，最后整体校正
      table = table.slice()
      view(table).setUint32(8, 0)
      headAt = offset
    }
    const at = 12 + 16 * i
    for (let k = 0; k < 4; k += 1) out[at + k] = tag.charCodeAt(k)
    data.setUint32(at + 4, checksum(table))
    data.setUint32(at + 8, offset)
    data.setUint32(at + 12, table.byteLength)
    out.set(table, offset)
    offset += Math.ceil(table.byteLength / 4) * 4
  })
  if (headAt >= 0) data.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0)
  return out
}

/**
 * 把核心字体和扩展字形包拼成完整字体。扩展包之间字形重复时后面的覆盖前面的（内容相同）。
 * 返回新的 Uint8Array（独占一块 ArrayBuffer），输入不被修改。
 */
export function assembleFont(core: Uint8Array, packs: readonly Uint8Array[]): Uint8Array {
  const tables = readSfnt(core)
  const maxp = tables.get('maxp')
  const loca = tables.get('loca')
  const glyf = tables.get('glyf')
  if (!maxp || !loca || !glyf) throw new Error('核心字体缺少 maxp / loca / glyf')
  const numGlyphs = view(maxp).getUint16(4)
  if (loca.byteLength < (numGlyphs + 1) * 4) throw new Error('核心字体的 loca 不是长格式或被截断')
  const offsets = view(loca)
  const extra = new Map<number, Uint8Array>()
  for (const pack of packs) for (const [gid, bytes] of readGlyphPack(pack)) if (gid < numGlyphs) extra.set(gid, bytes)

  const parts: Uint8Array[] = []
  const newLoca = new Uint8Array((numGlyphs + 1) * 4)
  const newLocaView = view(newLoca)
  let length = 0
  for (let gid = 0; gid < numGlyphs; gid += 1) {
    newLocaView.setUint32(gid * 4, length)
    const bytes = extra.get(gid) ?? glyf.subarray(offsets.getUint32(gid * 4), offsets.getUint32(gid * 4 + 4))
    if (bytes.byteLength) {
      parts.push(bytes)
      length += bytes.byteLength
    }
  }
  newLocaView.setUint32(numGlyphs * 4, length)
  const newGlyf = new Uint8Array(length)
  let cursor = 0
  for (const part of parts) {
    newGlyf.set(part, cursor)
    cursor += part.byteLength
  }

  const next = new Map(tables)
  next.set('glyf', newGlyf)
  next.set('loca', newLoca)
  return writeSfnt(next)
}

/** 拼装结果交给引擎时要 ArrayBuffer；Uint8Array 正好占满自己的 buffer（writeSfnt 新建的），直接取 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer)
}
