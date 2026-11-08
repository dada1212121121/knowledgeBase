/**
 * 网格剪贴板
 *
 * 复制到 Excel / WPS 时必须是 TSV + HTML 双格式：纯文本保证任何表格软件都能读，
 * HTML 保留合并/换行（后续 xlsx 适配器会补样式）。粘贴反过来优先 TSV，
 * 因为 HTML 表格里可能混入样式噪声；只有剪贴板只有 HTML 时才解析 table。
 */

/** 解析 TSV / CSV 文本；返回矩阵，末尾空行会被丢掉但中间空行保留 */
export function parseDelimited(text: string, delimiter = '\t'): string[][] {
  if (text === '') return []
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let atFieldStart = true
  const pushField = () => {
    row.push(field)
    field = ''
    atFieldStart = true
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && atFieldStart) {
      quoted = true
      atFieldStart = false
      continue
    }
    if (char === delimiter) {
      pushField()
      continue
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      pushRow()
      continue
    }
    field += char
    atFieldStart = false
  }
  // 文件末尾没有换行时仍要收下最后一个字段；有换行时 pushRow 已经处理
  if (field !== '' || row.length > 0) pushRow()
  // 末尾连续换行会生成空行：只去掉完全空的尾部行
  while (rows.length > 0 && rows[rows.length - 1]!.length === 1 && rows[rows.length - 1]![0] === '') rows.pop()
  return rows
}

/** 序列化成 TSV；字段含分隔符 / 引号 / 换行时加引号并转义 */
export function serializeTsv(matrix: readonly (readonly string[])[]): string {
  return matrix
    .map((row) =>
      row
        .map((cell) => {
          const value = cell ?? ''
          return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
        })
        .join('\t'),
    )
    .join('\n')
}

/** HTML 转义，避免把用户单元格内容当标签执行 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 生成 Excel / WPS 能识别的 HTML 表格；`\n` 在单元格里转成 `<br>` */
export function serializeHtml(matrix: readonly (readonly string[])[]): string {
  const body = matrix
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell ?? '').replace(/\n/g, '<br>')}</td>`).join('')}</tr>`)
    .join('')
  return `<table>${body}</table>`
}

/** 解析 HTML 剪贴板里的第一张表；没有 DOMParser（Node 无 DOM）时返回空 */
export function parseHtmlTable(html: string): string[][] {
  if (!html.trim() || typeof DOMParser === 'undefined') return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const table = doc.querySelector('table')
  if (!table) return []
  return [...table.querySelectorAll('tr')].map((row) =>
    [...row.querySelectorAll('th,td')].map((cell) => (cell.textContent ?? '').replace(/\u00a0/g, ' ')),
  )
}

/** 剪贴板 → 矩阵：优先文本（Excel 的 TSV 最精确），没有文本才退回 HTML */
export function parseClipboard(text: string, html = ''): string[][] {
  const plain = text ? parseDelimited(text, text.includes('\t') ? '\t' : ',') : []
  if (plain.some((row) => row.length > 1) || plain.length > 1) return plain
  const fromHtml = parseHtmlTable(html)
  if (fromHtml.length) return fromHtml
  return plain
}

/**
 * 把粘贴矩阵贴到起点；返回 (相对起点的) 单元格列表。
 * 空字符串也写入，保证「粘贴空值」能清掉目标格，而不是被当成没有内容。
 */
export function pasteMatrix(matrix: readonly (readonly string[])[], start: { row: number; col: number }): { row: number; col: number; text: string }[] {
  const out: { row: number; col: number; text: string }[] = []
  matrix.forEach((row, rowIndex) => {
    row.forEach((text, colIndex) => {
      out.push({ row: start.row + rowIndex, col: start.col + colIndex, text })
    })
  })
  return out
}

/** 公式以 `=` 开头；上层据此决定走 engine.editCell 还是普通文本写入 */
export function isFormula(value: string): boolean {
  return value.startsWith('=')
}
