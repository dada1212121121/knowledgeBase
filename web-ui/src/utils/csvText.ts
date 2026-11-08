// CSV / TSV 的「文字 ⇄ 表格」模型(多人协同用):表格只是同一个纯文本房间(Y.Text)的另一种视图。
// 改一个格子 / 加删一行 = 对文字做一次最小的替换(只动那几个字),所以:
// - 两个人同时改不同的格子,改的是文字的不同位置,协同自然合并;
// - 和别人用源码编辑器改同一份文件也能同时进行;
// - 引号写法、行尾、没碰过的字节都保持原样(编码由服务端落地时按原编码写回)。
//
// 规则逐条照搬 crates/kb-extract/src/csv_edit.rs(单人表格编辑的服务端实现),两边用同一组用例对过:
// 引号只在字段开头才算、"" 转义、引号字段里可以有分隔符和换行;全空白的行不占行号;
// 原来带引号的格子仍带引号,原来没有的只在必须时才加;删掉末尾没有换行的最后一行时连它前面的换行一起删。
// 位置是 JS 字符串下标(UTF-16),和 Y.Text 的下标一致。
//
// 性能:表格结构存成类型数组(每个字段只记起止位置与是否带引号,值用到时再从原文切出来)。
// 以前每个字段一个对象、值逐字拼接,5 MB / 40 万字段的 CSV 解析要 550 ms、JS 堆 +130 MB,而且分隔符嗅探把
// 全文解析了 4 遍、每改一格又整份重解析一遍(协同时别人每敲一个字也一样)。现在只解析一遍,
// 改格子用 applySpliceToTable 只重解析那一条记录、其余记录平移位置。

/** 参考实现用的对象结构(测试与分隔符嗅探用;表格本身用下面的紧凑结构) */
export interface CsvField {
  start: number
  end: number
  quoted: boolean
  value: string
}

export interface CsvRecord {
  start: number
  /** 最后一个字段结束的位置(不含行尾) */
  end: number
  /** 行尾之后的位置;最后一行没有换行时等于 end */
  termEnd: number
  fields: CsvField[]
}

export interface CsvTable {
  text: string
  delimiter: string
  newline: '\n' | '\r\n' | '\r'
  /** 记录(物理行,含空白行)条数;记录 i 的位置是 recStart[i] / recEnd[i] / recTermEnd[i] */
  recordCount: number
  recStart: Int32Array
  recEnd: Int32Array
  recTermEnd: Int32Array
  /** 记录 i 的字段是 field* 数组里的 [recField[i], recField[i + 1]);长度 recordCount + 1 */
  recField: Int32Array
  fieldStart: Int32Array
  fieldEnd: Int32Array
  fieldQuoted: Uint8Array
  /** 非空白行在记录里的下标(行号 = 这里的下标) */
  rows: Int32Array
  columns: number
}

/** 一次替换:从 `index` 起删 `remove` 个字,插入 `insert` */
export interface Splice {
  index: number
  remove: number
  insert: string
}

const QUOTE = 34
const LF = 10
const CR = 13

/** 与 String.prototype.trim 同一组空白字符:判断「全空白的行」要和服务端的 trim 口径一致 */
function isWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}

const isBlankRecord = (record: CsvRecord) => record.fields.every((field) => field.value.trim() === '')

/**
 * 参考实现:逐条记录解析成对象(规则的「原文」;紧凑解析器与它逐条比对过,见 csvText.spec.ts)。
 * `maxNonBlank` 给分隔符嗅探用:收集到这么多条非空白记录就停,不必解析整份文件。
 */
export function parseRecords(text: string, delimiter: string, maxNonBlank = Number.POSITIVE_INFINITY): CsvRecord[] {
  const records: CsvRecord[] = []
  const len = text.length
  let nonBlank = 0
  let i = 0
  while (i < len && nonBlank < maxNonBlank) {
    const start = i
    const fields: CsvField[] = []
    for (;;) {
      const fieldStart = i
      let value = ''
      let quoted = false
      if (i < len && text[i] === '"') {
        quoted = true
        i += 1
        while (i < len) {
          if (text[i] === '"') {
            if (i + 1 < len && text[i + 1] === '"') {
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
      while (i < len && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') {
        value += text[i]
        i += 1
      }
      fields.push({ start: fieldStart, end: i, quoted, value })
      if (i < len && text[i] === delimiter) {
        i += 1
        continue
      }
      break
    }
    const end = i
    let termEnd = i
    if (i < len && text[i] === '\r') termEnd = i + 1 < len && text[i + 1] === '\n' ? i + 2 : i + 1
    else if (i < len && text[i] === '\n') termEnd = i + 1
    const record = { start, end, termEnd, fields }
    records.push(record)
    if (!isBlankRecord(record)) nonBlank += 1
    i = termEnd
  }
  return records
}

/** 嗅探时每个候选分隔符只看前这么多条非空白记录(和服务端同一个打分办法) */
const SNIFF_RECORDS = 20

/** 在逗号、分号、制表符、竖线里挑分隔符(和服务端同一个打分办法)。只解析开头 20 条非空白记录。 */
export function detectDelimiter(text: string): string {
  let best: [string, number] = [',', 0]
  for (const candidate of [',', ';', '\t', '|']) {
    const records = parseRecords(text, candidate, SNIFF_RECORDS).filter((record) => !isBlankRecord(record)).slice(0, SNIFF_RECORDS)
    if (!records.length) continue
    const widths = new Map<number, number>()
    for (const record of records) widths.set(record.fields.length, (widths.get(record.fields.length) ?? 0) + 1)
    let modalWidth = 1
    let modalCount = 0
    for (const [width, count] of widths) {
      if (count > modalCount || (count === modalCount && width > modalWidth)) {
        modalWidth = width
        modalCount = count
      }
    }
    if (modalWidth < 2) continue
    const score = (modalCount / records.length) * (modalWidth - 1)
    if (score > best[1]) best = [candidate, score]
  }
  return best[0]
}

/** 字段的值:不带引号的直接切片;带引号的去掉引号、`""` 还原成 `"`、闭引号后面的字照常接上 */
function valueAt(text: string, start: number, end: number, quoted: boolean): string {
  if (!quoted) return text.slice(start, end)
  let out = ''
  let i = start + 1
  let segment = i
  while (i < end) {
    if (text.charCodeAt(i) === QUOTE) {
      if (i + 1 < end && text.charCodeAt(i + 1) === QUOTE) {
        out += text.slice(segment, i + 1)
        i += 2
        segment = i
        continue
      }
      return out + text.slice(segment, i) + text.slice(i + 1, end)
    }
    i += 1
  }
  // 没闭合的引号:一直到字段末尾都是值
  return out + text.slice(segment, end)
}

function fieldIsBlank(text: string, start: number, end: number, quoted: boolean): boolean {
  if (quoted) return valueAt(text, start, end, true).trim() === ''
  for (let i = start; i < end; i += 1) if (!isWhitespace(text.charCodeAt(i))) return false
  return true
}

/** 一段文字解析出来的记录与字段(位置相对 `offset` 之前的原点;`offset` 让增量更新只解析一条记录) */
interface Scanned {
  recordCount: number
  recStart: Int32Array
  recEnd: Int32Array
  recTermEnd: Int32Array
  recField: Int32Array
  fieldStart: Int32Array
  fieldEnd: Int32Array
  fieldQuoted: Uint8Array
}

/** 紧凑解析 text[from, to):规则与 parseRecords 完全相同,只是不建对象、不拼值 */
function scan(text: string, delimiter: string, from = 0, to = text.length): Scanned {
  const d = delimiter.charCodeAt(0)
  // 先数一遍分隔符和换行,按上限一次分配好数组(引号里的也算进去,只会多分配不会少)
  let lines = 0
  let delimiters = 0
  for (let i = from; i < to; i += 1) {
    const code = text.charCodeAt(i)
    if (code === LF || code === CR) lines += 1
    else if (code === d) delimiters += 1
  }
  const recordCap = lines + 1
  const fieldCap = delimiters + recordCap
  const recStart = new Int32Array(recordCap)
  const recEnd = new Int32Array(recordCap)
  const recTermEnd = new Int32Array(recordCap)
  const recField = new Int32Array(recordCap + 1)
  const fieldStart = new Int32Array(fieldCap)
  const fieldEnd = new Int32Array(fieldCap)
  const fieldQuoted = new Uint8Array(fieldCap)
  let r = 0
  let f = 0
  let i = from
  while (i < to) {
    recStart[r] = i
    recField[r] = f
    for (;;) {
      const start = i
      let quoted = 0
      if (i < to && text.charCodeAt(i) === QUOTE) {
        quoted = 1
        i += 1
        while (i < to) {
          if (text.charCodeAt(i) === QUOTE) {
            if (i + 1 < to && text.charCodeAt(i + 1) === QUOTE) i += 2
            else {
              i += 1
              break
            }
          } else i += 1
        }
      }
      while (i < to) {
        const code = text.charCodeAt(i)
        if (code === d || code === LF || code === CR) break
        i += 1
      }
      fieldStart[f] = start
      fieldEnd[f] = i
      fieldQuoted[f] = quoted
      f += 1
      if (i < to && text.charCodeAt(i) === d) {
        i += 1
        continue
      }
      break
    }
    recEnd[r] = i
    let termEnd = i
    if (i < to && text.charCodeAt(i) === CR) termEnd = i + 1 < to && text.charCodeAt(i + 1) === LF ? i + 2 : i + 1
    else if (i < to && text.charCodeAt(i) === LF) termEnd = i + 1
    recTermEnd[r] = termEnd
    r += 1
    i = termEnd
  }
  recField[r] = f
  return {
    recordCount: r,
    recStart: recStart.subarray(0, r),
    recEnd: recEnd.subarray(0, r),
    recTermEnd: recTermEnd.subarray(0, r),
    recField: recField.subarray(0, r + 1),
    fieldStart: fieldStart.subarray(0, f),
    fieldEnd: fieldEnd.subarray(0, f),
    fieldQuoted: fieldQuoted.subarray(0, f),
  }
}

function recordIsBlank(text: string, s: Scanned, record: number): boolean {
  for (let f = s.recField[record]; f < s.recField[record + 1]; f += 1) {
    if (!fieldIsBlank(text, s.fieldStart[f], s.fieldEnd[f], s.fieldQuoted[f] === 1)) return false
  }
  return true
}

/** 由记录结构算出行号表、列数、换行风格,组成完整的表 */
function finish(text: string, delimiter: string, s: Scanned): CsvTable {
  const rows = new Int32Array(s.recordCount)
  let count = 0
  let columns = 0
  for (let r = 0; r < s.recordCount; r += 1) {
    if (recordIsBlank(text, s, r)) continue
    rows[count] = r
    count += 1
    columns = Math.max(columns, s.recField[r + 1] - s.recField[r])
  }
  let ending: CsvTable['newline'] = '\n'
  for (let r = 0; r < s.recordCount; r += 1) {
    if (s.recTermEnd[r] > s.recEnd[r]) {
      const piece = text.slice(s.recEnd[r], s.recTermEnd[r])
      ending = piece === '\r\n' ? '\r\n' : piece === '\r' ? '\r' : '\n'
      break
    }
  }
  return { text, delimiter, newline: ending, ...s, rows: rows.subarray(0, count), columns }
}

/** 解析整份文字。`tsv` 为真时分隔符固定是制表符(和服务端按扩展名一致)。 */
export function parseTable(text: string, tsv: boolean): CsvTable {
  const delimiter = tsv ? '\t' : detectDelimiter(text)
  return finish(text, delimiter, scan(text, delimiter))
}

/** 一个值写成 CSV 字段:含分隔符、引号、换行的必须加引号;原来就带引号的保持带引号。 */
export function serializeField(value: string, delimiter: string, wasQuoted: boolean): string {
  const needsQuotes = value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')
  return needsQuotes || wasQuoted ? `"${value.replaceAll('"', '""')}"` : value
}

/** 第 `row` 行第 `col` 列的值。 */
export function cellValue(table: CsvTable, row: number, col: number): string {
  if (row < 0 || row >= table.rows.length || col < 0) return ''
  const record = table.rows[row]
  const field = table.recField[record] + col
  if (field >= table.recField[record + 1]) return ''
  return valueAt(table.text, table.fieldStart[field], table.fieldEnd[field], table.fieldQuoted[field] === 1)
}

/** 第 `row` 行有几个字段(含行尾的空字段) */
export function rowFieldCount(table: CsvTable, row: number): number {
  const record = table.rows[row]
  return record === undefined ? 0 : table.recField[record + 1] - table.recField[record]
}

/** 改一个格子要对文字做的替换;值没变返回 null。列超出这一行就在行尾补分隔符和空格子。 */
export function setCellSplice(table: CsvTable, row: number, col: number, value: string): Splice | null {
  const record = table.rows[row]
  if (record === undefined || row < 0) throw new Error(`第 ${row + 1} 行不存在`)
  if (value.includes('\0')) throw new Error('格子里不能有 NUL 字符')
  const first = table.recField[record]
  const count = table.recField[record + 1] - first
  if (col < count) {
    const field = first + col
    const start = table.fieldStart[field]
    const end = table.fieldEnd[field]
    const replacement = serializeField(value, table.delimiter, table.fieldQuoted[field] === 1)
    if (table.text.slice(start, end) === replacement) return null
    return { index: start, remove: end - start, insert: replacement }
  }
  if (value === '') return null
  let appended = ''
  for (let c = count; c <= col; c++) {
    appended += table.delimiter
    if (c === col) appended += serializeField(value, table.delimiter, false)
  }
  return { index: table.recEnd[record], remove: 0, insert: appended }
}

/** 删一行要做的替换。 */
export function deleteRowSplice(table: CsvTable, row: number): Splice {
  const index = table.rows[row]
  if (index === undefined || row < 0) throw new Error(`第 ${row + 1} 行不存在`)
  // 最后一行没有换行:连它前面那个换行一起删,文件末尾仍然「没有换行」
  if (table.recTermEnd[index] === table.recEnd[index] && index > 0) {
    const previousEnd = table.recEnd[index - 1]
    return { index: previousEnd, remove: table.recEnd[index] - previousEnd, insert: '' }
  }
  return { index: table.recStart[index], remove: table.recTermEnd[index] - table.recStart[index], insert: '' }
}

/** 在第 `at` 行之前插入一行(`at` 等于行数就是加在最后)。 */
export function insertRowSplice(table: CsvTable, at: number, values: string[]): Splice {
  const line = values.map((value) => serializeField(value, table.delimiter, false)).join(table.delimiter)
  if (at < table.rows.length) {
    return { index: table.recStart[table.rows[at]], remove: 0, insert: `${line}${table.newline}` }
  }
  const lastIndex = table.rows.at(-1)
  if (lastIndex === undefined) return { index: table.text.length, remove: 0, insert: `${line}${table.newline}` }
  if (table.recTermEnd[lastIndex] > table.recEnd[lastIndex]) {
    return { index: table.recTermEnd[lastIndex], remove: 0, insert: `${line}${table.newline}` }
  }
  return { index: table.recEnd[lastIndex], remove: 0, insert: `${table.newline}${line}` }
}

/** 把替换用到一段文字上(测试和单人模式用;协同模式直接作用在 Y.Text 上)。 */
export function applySplice(text: string, splice: Splice): string {
  return text.slice(0, splice.index) + splice.insert + text.slice(splice.index + splice.remove)
}

/** 最后一个起点 ≤ pos 的记录(二分);没有记录或 pos 在第一条之前返回 -1 */
function recordAt(table: CsvTable, pos: number): number {
  let low = 0
  let high = table.recordCount - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (table.recStart[mid] <= pos) {
      found = mid
      low = mid + 1
    } else high = mid - 1
  }
  return found
}

/** 记录 r 是不是参与分隔符嗅探的前 20 条非空白记录之一(改了它,分隔符可能要重选) */
function inSniffWindow(table: CsvTable, record: number): boolean {
  const limit = table.rows[SNIFF_RECORDS - 1]
  return limit === undefined || record <= limit
}

/**
 * 把一次替换作用到表上,返回新表(旧表不动:撤销栈里还拿着它)。
 *
 * 替换只落在一条记录内部(改格子、行尾补列)时,只重解析这一条、后面的记录整体平移位置——
 * 5 MB 的表改一格从 550 ms 的整份重解析变成 1~2 ms 的数组复制。
 * 其余情况(删行、插行、改到行尾、引号没闭合导致吞掉后面的行、改动可能让分隔符重选)整份重解析,结果与 parseTable 相同。
 */
export function applySpliceToTable(table: CsvTable, splice: Splice, tsv: boolean): CsvTable {
  const text = applySplice(table.text, splice)
  const record = recordAt(table, splice.index)
  const full = () => parseTable(text, tsv)
  if (record < 0) return full()
  const start = table.recStart[record]
  // 必须完全落在这条记录的字段区内:碰到行尾 / 下一条记录就是结构变化
  if (splice.index < start || splice.index + splice.remove > table.recEnd[record]) return full()
  // 在记录开头插入可能是插一整行(insertRowSplice),交给整份重解析
  if (splice.index === start && splice.remove === 0) return full()
  if (!tsv && inSniffWindow(table, record)) {
    // 前 20 条非空白记录决定分隔符:改了它们要重新嗅探,换了分隔符整张表都得重来
    if (detectDelimiter(text) !== table.delimiter) return full()
  }
  // 上一行只以 CR 结尾、这一行改完以 LF 开头:两者会拼成一个 CRLF,这一行并进上一行
  if (start > 0 && text.charCodeAt(start - 1) === CR && text.charCodeAt(start) === LF) return full()
  const delta = splice.insert.length - splice.remove
  const regionEnd = table.recTermEnd[record] + delta
  const one = scan(text, table.delimiter, start, regionEnd)
  // 只解析出一条、并且正好到原来的行尾:后面的记录不受影响(否则是改动插了换行之类)
  if (one.recordCount !== 1 || one.recTermEnd[0] !== regionEnd) return full()
  // 原来有行尾,新的也必须是真的行尾:引号没闭合时引号会把行尾连同后面的行一起吞掉,
  // 只解析这一段看不出来(扫到区间末尾就停了),必须整份重解析
  if (table.recTermEnd[record] > table.recEnd[record] && one.recTermEnd[0] === one.recEnd[0]) return full()
  const fieldsBefore = table.recField[record]
  const oldFields = table.recField[record + 1] - fieldsBefore
  const newFields = one.recField[1]
  const fieldShift = newFields - oldFields
  const totalFields = table.fieldStart.length + fieldShift
  const fieldStart = new Int32Array(totalFields)
  const fieldEnd = new Int32Array(totalFields)
  const fieldQuoted = new Uint8Array(totalFields)
  fieldStart.set(table.fieldStart.subarray(0, fieldsBefore))
  fieldEnd.set(table.fieldEnd.subarray(0, fieldsBefore))
  fieldQuoted.set(table.fieldQuoted.subarray(0, fieldsBefore))
  fieldStart.set(one.fieldStart, fieldsBefore)
  fieldEnd.set(one.fieldEnd, fieldsBefore)
  fieldQuoted.set(one.fieldQuoted, fieldsBefore)
  const afterFrom = fieldsBefore + oldFields
  const afterTo = fieldsBefore + newFields
  for (let f = afterFrom, g = afterTo; f < table.fieldStart.length; f += 1, g += 1) {
    fieldStart[g] = table.fieldStart[f] + delta
    fieldEnd[g] = table.fieldEnd[f] + delta
    fieldQuoted[g] = table.fieldQuoted[f]
  }
  const recStart = table.recStart.slice()
  const recEnd = table.recEnd.slice()
  const recTermEnd = table.recTermEnd.slice()
  const recField = table.recField.slice()
  recEnd[record] = one.recEnd[0]
  recTermEnd[record] = one.recTermEnd[0]
  for (let r = record + 1; r < table.recordCount; r += 1) {
    recStart[r] += delta
    recEnd[r] += delta
    recTermEnd[r] += delta
    recField[r] += fieldShift
  }
  recField[table.recordCount] += fieldShift
  const scanned: Scanned = { recordCount: table.recordCount, recStart, recEnd, recTermEnd, recField, fieldStart, fieldEnd, fieldQuoted }
  // 行号表 / 列数 / 换行风格:空白状态、字段数、甚至「第一条有行尾的记录」都可能变了(没闭合的引号被补上时),
  // 重算一遍——只是遍历数组,换行风格通常在第一条记录就定了
  return finish(text, table.delimiter, scanned)
}

/** 依次作用一串替换(每一笔都基于上一笔的结果);太多时直接整份重解析一次更快 */
export function applySplicesToTable(table: CsvTable, splices: readonly Splice[], tsv: boolean): CsvTable {
  if (splices.length > 64) {
    let text = table.text
    for (const splice of splices) text = applySplice(text, splice)
    return parseTable(text, tsv)
  }
  let next = table
  for (const splice of splices) next = applySpliceToTable(next, splice, tsv)
  return next
}
