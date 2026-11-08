// 表格查看器用的纯函数:CSV 解析、文本解码、列字母、列宽估算。单测见 tabular.spec.ts。

/** Excel 列字母:0→A,25→Z,26→AA,701→ZZ,702→AAA。 */
export function columnLetter(index: number): string {
  let value = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (value % 26)) + out
    value = Math.floor(value / 26) - 1
  } while (value >= 0)
  return out
}

/** 字节 → 文本:先严格按 UTF-8,不行就当 GB18030(中文 Windows 导出的 CSV 常见)。去掉 BOM。 */
export function decodeText(buffer: ArrayBuffer): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      text = new TextDecoder('gb18030').decode(buffer)
    } catch {
      text = new TextDecoder('utf-8').decode(buffer)
    }
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 按首行猜分隔符:逗号 / 制表符 / 分号里出现最多的(引号外不区分,够用)。 */
export function sniffDelimiter(text: string): string {
  const head = text.slice(0, 4096).split(/\r?\n/, 1)[0] ?? ''
  const counts = [',', '\t', ';'].map((char) => [char, head.split(char).length - 1] as const)
  counts.sort((left, right) => right[1] - left[1])
  return counts[0]![1] > 0 ? counts[0]![0] : ','
}

/** RFC 4180 风格:支持引号、引号内换行、`""` 转义、CRLF;空行跳过。 */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const flushField = () => {
    row.push(field)
    field = ''
  }
  const flushRow = () => {
    flushField()
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!
    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') {
          field += '"'
          at += 1
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"' && field === '') quoted = true
    else if (char === delimiter) flushField()
    else if (char === '\n') flushRow()
    else if (char === '\r') {
      if (text[at + 1] === '\n') at += 1
      flushRow()
    } else field += char
  }
  if (field !== '' || row.length) flushRow()
  return rows
}

/** xlsx 单元格值 → 展示文本。 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    const iso = value.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}

/** 列宽(px):按前 `sample` 行里最长文本估算(CJK 按 2 个字符宽),夹在 [64, 360]。 */
export function columnWidths(rows: string[][], columns: number, sample = 200): number[] {
  const widths = new Array<number>(columns).fill(0)
  const limit = Math.min(rows.length, sample)
  for (let r = 0; r < limit; r += 1) {
    const row = rows[r]!
    for (let c = 0; c < columns; c += 1) {
      const text = row[c] ?? ''
      let units = 0
      for (const char of text) units += char.charCodeAt(0) > 0x2e80 ? 2 : 1
      if (units > widths[c]!) widths[c] = units
    }
  }
  return widths.map((units) => Math.min(360, Math.max(64, Math.round(units * 7.4 + 24))))
}

/** 首行像表头:全是非空字符串,且互不相同。 */
export function looksLikeHeader(row: string[] | undefined): boolean {
  if (!row || row.length < 2) return false
  if (row.some((cell) => cell.trim() === '' || /^-?\d+([.,]\d+)?$/.test(cell.trim()))) return false
  return new Set(row).size === row.length
}

export function maxColumns(rows: string[][], sample = 500): number {
  let max = 0
  for (let at = 0; at < Math.min(rows.length, sample); at += 1) max = Math.max(max, rows[at]!.length)
  return max
}
