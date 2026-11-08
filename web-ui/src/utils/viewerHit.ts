// 搜索命中 → 查看器要去的位置。命中块(chunk)的锚点各格式不同,这里统一成一个结构,
// 各查看器只取自己需要的字段(PDF 取 page + text,表格取 sheet + row,代码取 lines…)。
import type { PreviewChunk } from '@kb-ui/index'

export interface ViewerHit {
  /** 命中的句子(去掉首尾空白);查看器用它在页面上找并高亮 */
  text: string
  page: number | null
  slide: number | null
  sheet: string | null
  /** 表格行号(1 起,与 Excel 行号一致) */
  row: number | null
  /** 代码行区间(1 起,含两端) */
  lines: [number, number] | null
}

const EMPTY: ViewerHit = { text: '', page: null, slide: null, sheet: null, row: null, lines: null }

/** `R3` / `A1:D2` / `Sheet1!R3` 里的行号;认不出来返回 null。 */
export function rowOf(cell: string | undefined | null): number | null {
  if (!cell) return null
  const explicit = /R(\d+)/i.exec(cell)
  if (explicit) return Number(explicit[1])
  const a1 = /^[A-Za-z]+(\d+)/.exec(cell)
  return a1 ? Number(a1[1]) : null
}

export function deriveHit(chunks: PreviewChunk[], highlight: string | null): ViewerHit {
  if (!highlight) return EMPTY
  const chunk = chunks.find((item) => item.id === highlight)
  if (!chunk) return EMPTY
  const anchor = chunk.anchor
  let lines: [number, number] | null = null
  if (chunk.start_line && chunk.end_line) lines = [chunk.start_line, chunk.end_line]
  else if (anchor?.kind === 'line' && anchor.start) lines = [anchor.start, anchor.end ?? anchor.start]
  return {
    text: chunk.text.trim(),
    page: anchor?.kind === 'page' ? (anchor.page ?? 1) : null,
    slide: anchor?.kind === 'slide' ? (anchor.slide ?? 1) : null,
    sheet: anchor?.kind === 'cell' ? (anchor.sheet ?? null) : null,
    row: anchor?.kind === 'cell' ? rowOf(anchor.cell) : null,
    lines,
  }
}
