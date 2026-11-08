// CSV / TSV 表格编辑的「假服务端」。
//
// 目的:让 e2e 能验证「GBK / GB18030 / UTF-16 / 带 BOM 的 UTF-8 逐字节往返」,而不是返回写死的响应。
// 所以这里真的:
//   - 持有文件的**字节**,按 BOM / UTF-8 / GB18030 的顺序识别编码(与 crates/kb-extract/src/text_codec.rs 一致);
//   - csv_read:解码 → 按记录切行(引号、空白行不占行号、分隔符嗅探、行尾)→ 取一页;
//   - csv_edit:按 crates/kb-extract/src/csv_edit.rs 的算法(行号指修改之前的表、从后往前套补丁、
//     删最后一行不留结尾换行……)改文本,再**按原编码**编回字节;乐观锁(版本号 + sha256)不对就拒绝;
//   - save_file(本地小文件那条路):内容按文件原来的编码写回(BOM 保持)。
// 它是测试替身,不是第二份产品实现:规则照搬服务端,单测里也会拿它和客户端行为对拍。
import { createHash } from 'node:crypto'

const MAX_EDIT_BYTES = 32 * 1024 * 1024
const MAX_OPS = 5000

/* ---------------------------------------------------------------- 编码 */

let gbTable = null
/** GB18030 的 2 字节部分:字符 → 字节(用 Node 的 TextDecoder 反推,不依赖第三方包) */
function gbTwoByteTable() {
  if (gbTable) return gbTable
  gbTable = new Map()
  const decoder = new TextDecoder('gb18030')
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue
      const char = decoder.decode(Uint8Array.of(lead, trail))
      if (char.length === 1 && char !== '\ufffd' && !gbTable.has(char)) gbTable.set(char, [lead, trail])
    }
  }
  return gbTable
}

let gbFourByte = null
/** 4 字节部分的全部解码结果(1587600 个序列各对应一个码点,无效的是 U+FFFD) */
function gbFourByteText() {
  if (gbFourByte) return gbFourByte
  const leads = 0xfe - 0x81 + 1
  const buffer = Buffer.alloc(leads * 10 * leads * 10 * 4)
  let n = 0
  for (let a = 0x81; a <= 0xfe; a += 1) for (let b = 0x30; b <= 0x39; b += 1) for (let c = 0x81; c <= 0xfe; c += 1) for (let d = 0x30; d <= 0x39; d += 1) {
    buffer[n++] = a
    buffer[n++] = b
    buffer[n++] = c
    buffer[n++] = d
  }
  gbFourByte = new TextDecoder('gb18030').decode(buffer)
  return gbFourByte
}

/** 一个 Unicode 码点在 4 字节区里的字节(找不到返回 null);只有遇到 2 字节表里没有的字符才会走到这里 */
function gbFourBytesOf(char) {
  const text = gbFourByteText()
  const at = text.indexOf(char)
  if (at < 0) return null
  const index = [...text.slice(0, at)].length
  const d = 0x30 + (index % 10)
  const c = 0x81 + (Math.floor(index / 10) % 126)
  const b = 0x30 + (Math.floor(index / 1260) % 10)
  const a = 0x81 + Math.floor(index / 12600)
  return [a, b, c, d]
}

export function gb18030Encode(text) {
  const table = gbTwoByteTable()
  const out = []
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code < 0x80) out.push(code)
    else {
      const bytes = table.get(char) ?? gbFourBytesOf(char)
      if (!bytes) throw new Error(`假服务端:GB18030 编不出 ${char}`)
      out.push(...bytes)
    }
  }
  return Buffer.from(out)
}

export function encodeText(text, encoding) {
  switch (encoding) {
    case 'utf-8':
      return Buffer.from(text, 'utf8')
    case 'utf-8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf-16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf-16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])
    case 'gb18030':
      return gb18030Encode(text)
    default:
      throw new Error(`假服务端:不认识的编码 ${encoding}`)
  }
}

export const ENCODING_LABELS = { utf8: 'UTF-8', 'utf-8': 'UTF-8', 'utf-8-bom': 'UTF-8(带 BOM)', 'utf-16le': 'UTF-16LE', 'utf-16be': 'UTF-16BE', gb18030: 'GB18030' }

/** 按 BOM → UTF-8 → GB18030 的顺序识别并解码;解码再编码必须逐字节还原,否则拒绝(与服务端一致) */
export function decodeBytes(bytes) {
  let encoding
  let text
  const fatal = (name) => new TextDecoder(name, { fatal: true })
  try {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      encoding = 'utf-8-bom'
      text = fatal('utf-8').decode(bytes.subarray(3))
    } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      encoding = 'utf-16le'
      text = fatal('utf-16le').decode(bytes.subarray(2))
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      encoding = 'utf-16be'
      text = fatal('utf-16be').decode(bytes.subarray(2))
    } else {
      try {
        text = fatal('utf-8').decode(bytes)
        encoding = 'utf-8'
      } catch {
        text = fatal('gb18030').decode(bytes)
        encoding = 'gb18030'
      }
    }
  } catch {
    throw new FakeError(400, 'invalid_input', '不是受支持的文本编码(UTF-8 / UTF-16 / GB18030)')
  }
  if (!encodeText(text, encoding).equals(Buffer.from(bytes))) {
    throw new FakeError(400, 'invalid_input', '这个文件的编码无法逐字节还原(解码再编码后字节不同),在线编辑可能改动没碰过的内容;请先另存为 UTF-8')
  }
  return { text, encoding }
}

/* ---------------------------------------------------------------- 表格 */

export class FakeError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const isWs = (code) => code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff

/** 一遍扫出所有记录:起点 / 行内结束 / 行尾之后 / 字段数 / 是否全空白(不为每个字段建对象,32 MB 的表也能扫) */
function scanRecords(text, delimiter, maxNonBlank = Infinity) {
  const start = []
  const end = []
  const termEnd = []
  const fields = []
  const blank = []
  const len = text.length
  const d = delimiter.charCodeAt(0)
  let nonBlank = 0
  let i = 0
  while (i < len && nonBlank < maxNonBlank) {
    start.push(i)
    let count = 0
    let any = false
    for (;;) {
      count += 1
      if (i < len && text.charCodeAt(i) === 34) {
        i += 1
        while (i < len) {
          const code = text.charCodeAt(i)
          if (code === 34) {
            if (i + 1 < len && text.charCodeAt(i + 1) === 34) {
              any = true // 转义出来的引号是内容
              i += 2
            } else {
              i += 1
              break
            }
          } else {
            if (!isWs(code)) any = true
            i += 1
          }
        }
      }
      while (i < len) {
        const code = text.charCodeAt(i)
        if (code === d || code === 10 || code === 13) break
        if (!isWs(code)) any = true
        i += 1
      }
      if (i < len && text.charCodeAt(i) === d) {
        i += 1
        continue
      }
      break
    }
    end.push(i)
    let term = i
    if (i < len && text.charCodeAt(i) === 13) term = i + 1 < len && text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1
    else if (i < len && text.charCodeAt(i) === 10) term = i + 1
    termEnd.push(term)
    fields.push(count)
    blank.push(!any)
    if (any) nonBlank += 1
    i = term
  }
  return { start, end, termEnd, fields, blank }
}

/** 分隔符嗅探:逗号 / 分号 / 制表符 / 竖线里按「前 20 条非空记录的列数众数」打分(与服务端同一个办法) */
function detectDelimiter(text) {
  let best = [',', 0]
  for (const candidate of [',', ';', '\t', '|']) {
    const scan = scanRecords(text, candidate, 20)
    const widths = new Map()
    let kept = 0
    for (let r = 0; r < scan.start.length && kept < 20; r += 1) {
      if (scan.blank[r]) continue
      kept += 1
      widths.set(scan.fields[r], (widths.get(scan.fields[r]) ?? 0) + 1)
    }
    if (!kept) continue
    let modalWidth = 1
    let modalCount = 0
    for (const [width, count] of widths) {
      if (count > modalCount || (count === modalCount && width > modalWidth)) {
        modalWidth = width
        modalCount = count
      }
    }
    if (modalWidth < 2) continue
    const score = (modalCount / kept) * (modalWidth - 1)
    if (score > best[1]) best = [candidate, score]
  }
  return best[0]
}

/** 一条记录的字段(含引号写法);只在取页 / 改格子时对需要的记录调用 */
function parseFields(text, from, to, delimiter) {
  const fields = []
  const d = delimiter.charCodeAt(0)
  let i = from
  for (;;) {
    const fieldStart = i
    let value = ''
    let quoted = false
    if (i < to && text.charCodeAt(i) === 34) {
      quoted = true
      i += 1
      while (i < to) {
        if (text.charCodeAt(i) === 34) {
          if (i + 1 < to && text.charCodeAt(i + 1) === 34) {
            value += '"'
            i += 2
          } else {
            i += 1
            break
          }
        } else {
          value += text[i]
          i += 1
        }
      }
    }
    while (i < to && text.charCodeAt(i) !== d) {
      value += text[i]
      i += 1
    }
    fields.push({ start: fieldStart, end: i, quoted, value })
    if (i < to && text.charCodeAt(i) === d) {
      i += 1
      continue
    }
    break
  }
  return fields
}

const serialize = (value, delimiter, wasQuoted) => {
  const needs = value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')
  return needs || wasQuoted ? `"${value.replaceAll('"', '""')}"` : value
}

/** 解码后的 CSV 文档(同一版本的字节只解析一次) */
export class FakeCsvDoc {
  constructor(bytes, extension) {
    if (bytes.length > MAX_EDIT_BYTES) {
      throw new FakeError(400, 'invalid_input', `文件有 ${Math.floor(bytes.length / (1024 * 1024))} MB,超过在线编辑的上限 32 MB;请下载后用 Excel 编辑`)
    }
    this.original = Buffer.from(bytes)
    const { text, encoding } = decodeBytes(bytes)
    this.text = text
    this.encoding = encoding
    this.delimiter = extension === 'tsv' ? '\t' : detectDelimiter(text)
    this.scan = scanRecords(text, this.delimiter)
    this.rows = []
    for (let r = 0; r < this.scan.start.length; r += 1) if (!this.scan.blank[r]) this.rows.push(r)
    const firstTerm = this.scan.termEnd.findIndex((term, r) => term > this.scan.end[r])
    const piece = firstTerm < 0 ? '\n' : text.slice(this.scan.end[firstTerm], this.scan.termEnd[firstTerm])
    this.newlineId = piece === '\r\n' ? 'crlf' : piece === '\r' ? 'cr' : 'lf'
    this.newline = this.newlineId === 'crlf' ? '\r\n' : this.newlineId === 'cr' ? '\r' : '\n'
    const last = this.scan.start.length - 1
    this.trailingNewline = last >= 0 && this.scan.termEnd[last] > this.scan.end[last]
  }

  format() {
    return { encoding: this.encoding, encoding_label: ENCODING_LABELS[this.encoding], delimiter: this.delimiter, newline: this.newlineId, trailing_newline: this.trailingNewline }
  }

  columnCount() {
    let max = 0
    for (const r of this.rows) max = Math.max(max, this.scan.fields[r])
    return max
  }

  page(offset, limit) {
    return this.rows.slice(offset, offset + limit).map((r) => parseFields(this.text, this.scan.start[r], this.scan.end[r], this.delimiter).map((field) => field.value))
  }

  record(row) {
    const r = this.rows[row]
    if (r === undefined) throw new FakeError(400, 'invalid_input', `第 ${row + 1} 行不存在(现在有 ${this.rows.length} 行)`)
    return {
      index: r,
      start: this.scan.start[r],
      end: this.scan.end[r],
      termEnd: this.scan.termEnd[r],
      fields: parseFields(this.text, this.scan.start[r], this.scan.end[r], this.delimiter),
    }
  }

  /** 应用一批操作,返回新文件的字节(什么都没变时就是原来的字节);算法与 csv_edit.rs 一致 */
  apply(ops) {
    if (ops.length > MAX_OPS) throw new FakeError(400, 'invalid_input', `一次最多提交 ${MAX_OPS} 个操作,这次有 ${ops.length} 个`)
    const delimiter = this.delimiter
    const cells = new Map()
    const deleted = new Set()
    const inserts = []
    for (const op of ops) {
      if (op.op === 'set_cell') {
        this.record(op.row)
        if (op.value.includes('\0')) throw new FakeError(400, 'invalid_input', '格子里不能有 NUL 字符(会让文件被当成二进制)')
        cells.set(`${op.row}:${op.col}`, op.value)
      } else if (op.op === 'delete_row') {
        this.record(op.row)
        deleted.add(op.row)
      } else if (op.op === 'insert_row') {
        if (op.at > this.rows.length) throw new FakeError(400, 'invalid_input', `不能插到第 ${op.at + 1} 行之前(现在只有 ${this.rows.length} 行)`)
        inserts.push(op)
      } else throw new FakeError(400, 'invalid_input', `不认识的操作 ${op.op}`)
    }
    for (const key of cells.keys()) {
      const row = Number(key.split(':')[0])
      if (deleted.has(row)) throw new FakeError(400, 'invalid_input', `第 ${row + 1} 行同时被修改和删除`)
    }
    const splices = []
    let order = 0
    const push = (start, end, insert) => splices.push({ start, end, insert, order: order++ })

    const byRow = new Map()
    for (const [key, value] of cells) {
      const [row, col] = key.split(':').map(Number)
      if (!byRow.has(row)) byRow.set(row, new Map())
      byRow.get(row).set(col, value)
    }
    for (const [row, edits] of [...byRow].sort((a, b) => a[0] - b[0])) {
      const record = this.record(row)
      for (const [col, value] of [...edits].sort((a, b) => a[0] - b[0])) {
        if (col >= record.fields.length) continue
        const field = record.fields[col]
        const replacement = serialize(value, delimiter, field.quoted)
        if (this.text.slice(field.start, field.end) !== replacement) push(field.start, field.end, replacement)
      }
      const lastCol = Math.max(...edits.keys())
      if (lastCol >= record.fields.length) {
        let appended = ''
        for (let col = record.fields.length; col <= lastCol; col += 1) {
          appended += delimiter
          if (edits.has(col)) appended += serialize(edits.get(col), delimiter, false)
        }
        push(record.end, record.end, appended)
      }
    }
    for (const row of [...deleted].sort((a, b) => a - b)) {
      const record = this.record(row)
      if (record.termEnd === record.end && record.index > 0) push(this.scan.end[record.index - 1], record.end, '')
      else push(record.start, record.termEnd, '')
    }
    for (const { at, values } of inserts) {
      const line = values.map((value) => serialize(value, delimiter, false)).join(delimiter)
      if (at < this.rows.length) {
        const record = this.record(at)
        push(record.start, record.start, `${line}${this.newline}`)
      } else if (this.rows.length) {
        const record = this.record(this.rows.length - 1)
        if (record.termEnd > record.end) push(record.termEnd, record.termEnd, `${line}${this.newline}`)
        else push(record.end, record.end, `${this.newline}${line}`)
      } else push(this.text.length, this.text.length, `${line}${this.newline}`)
    }
    if (!splices.length) return this.original

    splices.sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order)
    const merged = []
    for (const splice of splices) {
      const last = merged[merged.length - 1]
      if (last && splice.start < last.end) {
        if (last.insert !== '' || splice.insert !== '') throw new FakeError(400, 'invalid_input', '这批操作互相冲突(同一处既要修改又要删除或插入),请分开提交')
        last.end = Math.max(last.end, splice.end)
        continue
      }
      merged.push({ ...splice })
    }
    let text = ''
    let cursor = 0
    for (const splice of merged) {
      text += this.text.slice(cursor, splice.start) + splice.insert
      cursor = splice.end
    }
    text += this.text.slice(cursor)
    const lastRow = this.rows.length ? this.record(this.rows.length - 1) : null
    if (lastRow && lastRow.termEnd === lastRow.end && deleted.has(this.rows.length - 1) && text.endsWith(this.newline)) text = text.slice(0, -this.newline.length)
    if (text === this.text) return this.original
    return encodeText(text, this.encoding)
  }
}

/* ---------------------------------------------------------------- 假服务端 */

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const extensionOf = (path) => path.split('.').pop().toLowerCase()

export class FakeCsvServer {
  constructor() {
    /** 路径 → { bytes, version, sha256 } */
    this.files = new Map()
    this.docs = new Map()
    this.reads = []
    this.edits = []
    this.saves = []
  }

  addFile(path, bytes, version = 1) {
    this.files.set(path, { bytes: Buffer.from(bytes), version, sha256: sha256(bytes) })
    this.docs.delete(path)
  }

  bytes(path) {
    return this.files.get(path)?.bytes
  }

  /** 模拟「别人先保存了」:字节换成新的、版本 +1 */
  replaceExternally(path, bytes) {
    const file = this.files.get(path)
    this.files.set(path, { bytes: Buffer.from(bytes), version: file.version + 1, sha256: sha256(bytes) })
    this.docs.delete(path)
  }

  entry(path) {
    const file = this.files.get(path)
    if (!file) throw new FakeError(404, 'not_found', `${path} 不存在`)
    return file
  }

  doc(path) {
    const file = this.entry(path)
    const cached = this.docs.get(path)
    if (cached && cached.version === file.version) return cached.doc
    const doc = new FakeCsvDoc(file.bytes, extensionOf(path))
    this.docs.set(path, { version: file.version, doc })
    return doc
  }

  read({ path, offset = 0, limit = 500 }) {
    this.reads.push({ path, offset, limit })
    const file = this.entry(path)
    const doc = this.doc(path)
    const size = Math.min(Math.max(limit, 1), 2000)
    return { total_rows: doc.rows.length, columns: doc.columnCount(), rows: doc.page(offset, size), offset, format: doc.format(), sha256: file.sha256, version: file.version }
  }

  edit({ path, ops, expected_version: expectedVersion, expected_sha256: expectedSha }) {
    this.edits.push({ path, ops, expectedVersion, expectedSha })
    const file = this.entry(path)
    if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== file.version) {
      throw new FakeError(409, 'conflict', `版本冲突:你看到的是 v${expectedVersion},现在是 v${file.version}`)
    }
    if (expectedSha && expectedSha.toLowerCase() !== file.sha256) {
      throw new FakeError(400, 'invalid_input', '这个文件在你打开之后已被改动(可能有人保存过,或文件在磁盘上被别的程序改了);请刷新后重新编辑,你这次的修改没有保存')
    }
    const doc = this.doc(path)
    const next = doc.apply(ops)
    const nextSha = sha256(next)
    if (nextSha === file.sha256) return { collection: 'c', path, changed: false, version: file.version, embedded: 0, chunks: 1, version_id: '', sha256: file.sha256, format: doc.format() }
    const version = file.version + 1
    this.files.set(path, { bytes: Buffer.from(next), version, sha256: nextSha })
    this.docs.delete(path)
    return { collection: 'c', path, changed: true, version, embedded: 1, chunks: 1, version_id: `v${version}`, sha256: nextSha, format: doc.format() }
  }

  /** 本地小文件那条路的 save_file:按文件原来的编码写回(UTF-8 BOM 保持),乐观锁看版本号 */
  saveText({ path, content, expected_version: expectedVersion }) {
    this.saves.push({ path, content, expectedVersion })
    const file = this.entry(path)
    const { encoding } = decodeBytes(file.bytes)
    // 页面给的 content 带着原来的 BOM 字符(codec 把它加回去了);服务端 encode 前会去掉,再按编码加回
    const text = content.startsWith('\ufeff') ? content.slice(1) : content
    const next = encodeText(text, encoding)
    const version = file.version + 1
    this.files.set(path, { bytes: next, version, sha256: sha256(next) })
    this.docs.delete(path)
    return { version, embedded: 1, chunks: 1 }
  }

  /** 给浏览器上下文装上 csv_read / csv_edit 两个能力(后注册的路由先匹配,盖过 fixture 里写死的版本) */
  async install(context) {
    const respond = (route, produce) => {
      try {
        const data = produce(route.request().postDataJSON() ?? {})
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) })
      } catch (error) {
        if (!(error instanceof FakeError)) throw error
        return route.fulfill({ status: error.status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }) })
      }
    }
    await context.route(/\/api\/v1\/capabilities\/csv_read(\?|$)/, (route) => respond(route, (args) => this.read(args)))
    await context.route(/\/api\/v1\/capabilities\/csv_edit(\?|$)/, (route) => respond(route, (args) => this.edit(args)))
  }
}

/* ---------------------------------------------------------------- 夹具文件 */

/** 造一份 CSV 文本(行尾可选);第 3 行含带逗号的引号字段 */
export function sampleCsv({ rows = 40, newline = '\r\n', delimiter = ',', trailing = true, rare = false } = {}) {
  const head = ['编号', '查询', '命中名次', '备注']
  const lines = [head.join(delimiter)]
  for (let i = 1; i <= rows; i += 1) {
    const query = i === 3 ? `"UDS 断线, 第 ${i} 次"` : `UDS 断线第${i}次`
    const note = rare && i === 2 ? '𠮷野家 䶮' : i % 2 ? '中文备注' : 'plain'
    lines.push([`q${String(i).padStart(3, '0')}`, query, String((i % 7) + 1), note].join(delimiter))
  }
  return lines.join(newline) + (trailing ? newline : '')
}

/** 把行拼成大文件的字节(固定内容),至少 `minBytes` 字节 */
export function bigCsvBytes(minBytes, { encoding = 'utf-8', newline = '\n' } = {}) {
  const rows = ['编号,查询,命中名次,耗时(ms),备注']
  let bytes = rows[0].length + newline.length
  for (let i = 1; bytes < minBytes; i += 1) {
    const note = i % 97 === 0 ? '"含逗号,引号""与换行"' : i % 3 ? '中文备注 · 混合检索' : 'plain note'
    const row = `q${String(i).padStart(7, '0')},UDS 断线怎么降级 ${i},${(i % 7) + 1},${40 + ((i * 13) % 90)},${note}`
    rows.push(row)
    bytes += Buffer.byteLength(row) + newline.length
  }
  return encodeText(rows.join(newline) + newline, encoding)
}
