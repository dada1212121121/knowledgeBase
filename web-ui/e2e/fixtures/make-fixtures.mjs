// 生成需要 JS 库才能写出的样本:xls / ods(SheetJS)、合成的 .doc / .ppt(cfb 按规范拼最小文件)。
// 用法:node e2e/fixtures/make-fixtures.mjs   (与 make-fixtures.py 互补;生成结果已提交)
import * as CFB from 'cfb'
import * as XLSX from '@e965/xlsx'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/* ---------------- xls / ods ---------------- */
const rows = [['编号', '查询', '命中名次', '耗时(ms)'], ...Array.from({ length: 300 }, (_, i) => [`q${String(i + 1).padStart(3, '0')}`, `UDS 断线怎么降级 ${i + 1}`, (i % 7) + 1, 40 + ((i * 13) % 90)])]
const book = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '评测汇总')
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['指标', '值'], ['hit@1', 0.85], ['hit@5', 1], ['MRR', 0.893]]), '指标')
writeFileSync(join(HERE, 'sample.xls'), XLSX.write(book, { type: 'buffer', bookType: 'biff8' }))
writeFileSync(join(HERE, 'sample.ods'), XLSX.write(book, { type: 'buffer', bookType: 'ods' }))

/* ---------------- 合成 .doc ---------------- */
function ole(streams) {
  const container = CFB.utils.cfb_new()
  for (const [name, data] of Object.entries(streams)) CFB.utils.cfb_add(container, name, data)
  return Buffer.from(CFB.write(container, { type: 'array' }))
}
function makeDoc(text) {
  const body = Buffer.alloc(text.length * 2)
  for (let i = 0; i < text.length; i += 1) body.writeUInt16LE(text.charCodeAt(i), i * 2)
  const header = 0x400
  const main = Buffer.alloc(header + body.length)
  main.writeUInt16LE(0xa5ec, 0)
  main.writeUInt16LE(0x0200, 0x0a)
  main.writeUInt32LE(text.length, 0x4c)
  body.copy(main, header)
  const plc = Buffer.alloc(16)
  plc.writeUInt32LE(0, 0)
  plc.writeUInt32LE(text.length, 4)
  plc.writeUInt32LE(header, 10) // 非压缩(UTF-16)片段
  const clx = Buffer.alloc(5 + plc.length)
  clx[0] = 2
  clx.writeUInt32LE(plc.length, 1)
  plc.copy(clx, 5)
  main.writeUInt32LE(0, 0x1a2)
  main.writeUInt32LE(clx.length, 0x1a6)
  return ole({ WordDocument: main, '1Table': clx })
}
const docText =
  '向量检索综述（旧版 .doc）\r' +
  '稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。\r' +
  '倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化。\r' +
  'k\x0720\x0760\x07100\x07\x07' + 'nDCG\x070.412\x070.438\x070.431\x07\x07' +
  '结尾段落。\r'
writeFileSync(join(HERE, 'sample.doc'), makeDoc(docText))

/* ---------------- 合成 .ppt ---------------- */
const record = (ver, type, payload) => {
  const out = Buffer.alloc(8 + payload.length)
  out.writeUInt16LE(ver, 0)
  out.writeUInt16LE(type, 2)
  out.writeUInt32LE(payload.length, 4)
  payload.copy(out, 8)
  return out
}
const utf16 = (text) => Buffer.from(text, 'utf16le')
const u32 = (value) => {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value, 0)
  return out
}
const box = (type, text) => record(0x0f, 0x0f00, Buffer.concat([record(0, 0x0f9f, u32(type)), record(0, 0x0fa0, utf16(text))]))
const slide = (...boxes) => record(0x0f, 0x03ee, record(0x0f, 0x040c, Buffer.concat(boxes)))
const notes = (text) => record(0x0f, 0x03f0, record(0x0f, 0x040c, box(2, text)))
const deck = Buffer.concat([
  slide(box(0, '产品路线图（旧版 .ppt）'), box(1, '批次 1 · PDF / Office\r批次 2 · OCR / 音视频')),
  notes('先讲批次 1 的收益'),
  slide(box(6, '检索质量'), box(1, 'RRF 融合\r交叉编码器重排\r反馈调权')),
  notes('补充 RRF 公式'),
  slide(box(0, '收尾'), box(1, '谢谢')),
  notes('提问环节'),
])
writeFileSync(join(HERE, 'sample.ppt'), ole({ 'PowerPoint Document': deck }))
console.log('xls / ods / doc / ppt 已生成')
