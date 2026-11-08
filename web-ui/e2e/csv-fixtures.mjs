// CSV / TSV 表格编辑的 e2e 夹具:多种编码的小文件 + 大文件 + 空文件,
// 以及把它们种进假服务端(csv-server-fake.mjs)的函数。
//
// 约定:id 就是 `?item=` 里用的 id,路径(服务端里的文件名)是 fileItem 的第二个参数。
//   file_csv           评测明细.csv                 UTF-8,LF,无结尾换行(旧夹具,默认夹具里本来就有)
//   file_csv_bom       评测明细-bom.csv             UTF-8 带 BOM,CRLF            ≤512 KB → 本地适配器
//   file_csv_gbk       评测明细-gbk.csv             GBK,CRLF                      → 服务端分页适配器
//   file_csv_gb18030   评测明细-gb18030.csv         GB18030(含 4 字节字符)       → 服务端分页适配器
//   file_csv_u16le     评测明细-utf16le.csv         UTF-16LE,分号,CRLF           → 服务端分页适配器
//   file_csv_u16be     评测明细-utf16be.tsv         UTF-16BE,制表符,LF           → 服务端分页适配器
//   file_csv_big       大表-5m.csv                  UTF-8 带 BOM,CRLF,≈5 MB       → 服务端分页适配器
//   file_csv_32m       大表-32m.csv                 UTF-8,LF,≈31.5 MiB(接近 32 MB 上限)
//   file_csv_toobig    超限.csv                     33 MiB,csv_read 会拒绝(回退演练)
//   file_csv_empty     空表.csv                     0 字节
import { FILES, fileItem } from './fixture.mjs'
import { bigCsvBytes, decodeBytes, encodeText, sampleCsv } from './csv-server-fake.mjs'

/** 整份读进浏览器编辑的上限(与服务端 EDITABLE_MAX_BYTES 一致) */
export const EDITABLE_MAX_BYTES = 512 * 1024

let bigCache = null
let hugeCache = null
let tooBigCache = null

/** 每个文件的字节;大文件只在需要时生成一次(32 MiB 要几百毫秒) */
export const CSV_FILES = {
  file_csv_bom: { path: '评测明细-bom.csv', make: () => encodeText(sampleCsv({ rows: 40, newline: '\r\n' }), 'utf-8-bom') },
  file_csv_gbk: { path: '评测明细-gbk.csv', make: () => encodeText(sampleCsv({ rows: 40, newline: '\r\n' }), 'gb18030') },
  file_csv_gb18030: { path: '评测明细-gb18030.csv', make: () => encodeText(sampleCsv({ rows: 40, newline: '\r\n', rare: true }), 'gb18030') },
  file_csv_u16le: { path: '评测明细-utf16le.csv', make: () => encodeText(sampleCsv({ rows: 40, newline: '\r\n', delimiter: ';' }), 'utf-16le') },
  file_csv_u16be: { path: '评测明细-utf16be.tsv', make: () => encodeText(sampleCsv({ rows: 40, newline: '\n', delimiter: '\t' }), 'utf-16be') },
  file_csv_big: { path: '大表-5m.csv', make: () => (bigCache ??= bigCsvBytes(5 * 1024 * 1024, { encoding: 'utf-8-bom', newline: '\r\n' })) },
  file_csv_32m: { path: '大表-32m.csv', make: () => (hugeCache ??= bigCsvBytes(31.5 * 1024 * 1024)), big: true },
  file_csv_toobig: { path: '超限.csv', make: () => (tooBigCache ??= Buffer.alloc(33 * 1024 * 1024, 'a,b\n')), big: true },
  file_csv_empty: { path: '空表.csv', make: () => Buffer.alloc(0) },
}

/** 预览(file_preview):与真实后端一致——UTF-8 且 ≤512 KB 才可编辑、带全文;其它不可编辑,正文不给 */
function previewOf(id, bytes) {
  const ext = CSV_FILES[id].path.split('.').pop()
  let text = ''
  let editable = false
  try {
    if (bytes.length) {
      const decoded = decodeBytes(bytes)
      const utf8 = decoded.encoding === 'utf-8' || decoded.encoding === 'utf-8-bom'
      if (utf8 && bytes.length <= EDITABLE_MAX_BYTES) {
        text = decoded.encoding === 'utf-8-bom' ? `\ufeff${decoded.text}` : decoded.text
        editable = true
      }
    }
  } catch {
    // 解不开的文件:不可编辑、没有正文
  }
  return { format: ext, editable, extractor: 'text/csv', content: text, blocks: [], chunks: [] }
}

/** 把夹具文件登记进 FILES(fixture.mjs 的 file_preview / get_item 从这里取);重复调用是安全的 */
export function registerCsvFixtures() {
  for (const [id, spec] of Object.entries(CSV_FILES)) {
    if (FILES[id]) continue
    // 大文件不为了登记预览而生成字节:它们的预览本来就没有全文(超过可编辑上限)
    const preview = spec.big || id === 'file_csv_big' ? { format: 'csv', editable: false, extractor: 'text/csv', content: '', blocks: [], chunks: [] } : previewOf(id, spec.make())
    FILES[id] = { item: fileItem(id, spec.path, ['评测']), preview }
  }
}

/** 给一个新的假服务端种上夹具文件;`big` 为真时才带 32 MiB 级别的文件 */
export function seedCsvServer(server, { big = false } = {}) {
  server.addFile(FILES.file_csv.item.source, Buffer.from(FILES.file_csv.preview.content, 'utf8'))
  for (const spec of Object.values(CSV_FILES)) {
    if (spec.big && !big) continue
    server.addFile(spec.path, spec.make())
  }
  return server
}

/**
 * 两份字节的差异范围:最长公共前缀 / 后缀之外的部分。
 * 「只有那一格的字节变了」= 变化区间不超过旧格 + 新格的编码长度。
 */
export function diffRegion(before, after) {
  let prefix = 0
  const limit = Math.min(before.length, after.length)
  while (prefix < limit && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1
  return { prefix, changedBefore: before.length - suffix - prefix, changedAfter: after.length - suffix - prefix }
}
