/**
 * Canvas 网格绘制
 *
 * 只画「可见 + overscan」的格子：5 万格和 500 万格在屏幕上都是几百个矩形。
 * 这里不持有任何状态，也不改 DOM；滚动时由 view 在 rAF 里调用一次，
 * 避免每个 scroll 事件都触发 Vue 更新。
 */

import { HEADER_HEIGHT, HEADER_WIDTH, type GridGeometry } from './geometry'
import type { GridRange, GridSelection, GridSheet, GridViewport } from './types'

/** 颜色由调用方从设计 token 传入，绘制层不硬编码主题 */
export interface GridPalette {
  background: string
  text: string
  gridline: string
  headerBackground: string
  headerText: string
  selectionFill: string
  selectionBorder: string
  activeBorder: string
  /** 只读 / 命中高亮等额外的单元格底色 */
  highlight?: string
}

export interface PaintGridOptions {
  ctx: CanvasRenderingContext2D
  geometry: GridGeometry
  sheet: GridSheet
  viewport: GridViewport
  selection: GridSelection
  palette: GridPalette
  /** 设备像素比；画布 backing store 已按 dpr 放大 */
  dpr?: number
  /** 高亮区域（查找命中 / 评论锚点），可选 */
  highlights?: readonly GridRange[]
}

/** 只计算内容区（不含表头）的可见范围，供 view 与测试共用 */
export function contentViewport(viewport: GridViewport): GridViewport {
  return {
    ...viewport,
    width: Math.max(0, viewport.width - HEADER_WIDTH),
    height: Math.max(0, viewport.height - HEADER_HEIGHT),
  }
}

function clampRange(range: GridRange, geometry: GridGeometry): GridRange {
  return {
    top: Math.max(0, Math.min(range.top, geometry.rowCount - 1)),
    left: Math.max(0, Math.min(range.left, geometry.colCount - 1)),
    bottom: Math.max(0, Math.min(range.bottom, geometry.rowCount - 1)),
    right: Math.max(0, Math.min(range.right, geometry.colCount - 1)),
  }
}

/** 画一个可裁剪的文本单元格 */
function drawCellText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, height: number, align: 'left' | 'center' | 'right', color: string): void {
  if (!text) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(x + 2, y, Math.max(0, width - 4), height)
  ctx.clip()
  ctx.fillStyle = color
  ctx.textAlign = align
  const padding = 4
  const at = align === 'right' ? x + width - padding : align === 'center' ? x + width / 2 : x + padding
  ctx.fillText(text.replace(/\n/g, ' '), at, y + height / 2)
  ctx.restore()
}

/**
 * 绘制整个可见网格（含行号列与列标行）。
 * 调用方负责设置 canvas.width/height = css 尺寸 * dpr，并把 ctx 的 transform 归零。
 */
export function paintGrid(options: PaintGridOptions): void {
  const { ctx, geometry, sheet, viewport, selection, palette, dpr = 1 } = options
  const width = Math.max(0, viewport.width)
  const height = Math.max(0, viewport.height)
  const contentW = Math.max(0, width - HEADER_WIDTH)
  const contentH = Math.max(0, height - HEADER_HEIGHT)

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = palette.background
  ctx.fillRect(0, 0, width, height)
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
  ctx.textBaseline = 'middle'

  const visible = geometry.visibleRange(
    { scrollTop: viewport.scrollTop, scrollLeft: viewport.scrollLeft, width: contentW, height: contentH },
    1,
  )
  const active = selection.focus
  const selected = clampRange(
    {
      top: Math.min(selection.anchor.row, selection.focus.row),
      left: Math.min(selection.anchor.col, selection.focus.col),
      bottom: Math.max(selection.anchor.row, selection.focus.row),
      right: Math.max(selection.anchor.col, selection.focus.col),
    },
    geometry,
  )

  // 表头底色：行列两个固定条 + 左上角
  ctx.fillStyle = palette.headerBackground
  ctx.fillRect(0, 0, width, HEADER_HEIGHT)
  ctx.fillRect(0, 0, HEADER_WIDTH, height)

  // 内容区裁剪，滚动后不会画到表头上
  ctx.save()
  ctx.beginPath()
  ctx.rect(HEADER_WIDTH, HEADER_HEIGHT, contentW, contentH)
  ctx.clip()
  ctx.translate(HEADER_WIDTH - viewport.scrollLeft, HEADER_HEIGHT - viewport.scrollTop)

  // 选区填充先于文字，避免遮住内容
  const selectionVisible =
    selected.bottom >= visible.firstRow && selected.top < visible.lastRow && selected.right >= visible.firstCol && selected.left < visible.lastCol
  if (selectionVisible) {
    const rect = geometry.rangeRect(selected)
    ctx.fillStyle = palette.selectionFill
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
  }
  for (const range of options.highlights ?? []) {
    const rect = geometry.rangeRect(clampRange(range, geometry))
    ctx.fillStyle = palette.highlight ?? palette.selectionFill
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
  }

  // 网格线：只画可见轨道边界，合并区也先画，文字随后覆盖
  ctx.strokeStyle = palette.gridline
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let row = visible.firstRow; row <= visible.lastRow && row <= geometry.rowCount; row += 1) {
    const y = Math.round(geometry.rowTop(row)) + 0.5
    ctx.moveTo(geometry.colLeft(visible.firstCol), y)
    ctx.lineTo(geometry.colLeft(Math.min(geometry.colCount, visible.lastCol)), y)
  }
  for (let col = visible.firstCol; col <= visible.lastCol && col <= geometry.colCount; col += 1) {
    const x = Math.round(geometry.colLeft(col)) + 0.5
    ctx.moveTo(x, geometry.rowTop(visible.firstRow))
    ctx.lineTo(x, geometry.rowTop(Math.min(geometry.rowCount, visible.lastRow)))
  }
  ctx.stroke()

  // 合并区：同一块只画左上角；先收集避免每个单元格都查一遍数据源
  const merged = sheet.mergedRanges?.() ?? []
  const mergedAt = (row: number, col: number) => merged.find((r) => row >= r.top && row <= r.bottom && col >= r.left && col <= r.right)

  for (let row = visible.firstRow; row < visible.lastRow; row += 1) {
    for (let col = visible.firstCol; col < visible.lastCol; col += 1) {
      const cell = sheet.cell(row, col)
      if (!cell) continue
      const block = mergedAt(row, col)
      if (block && (row !== block.top || col !== block.left)) continue
      const rect = block ? geometry.rangeRect(block) : geometry.cellRect(row, col)
      if (cell.background) {
        ctx.fillStyle = cell.background
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      }
      ctx.font = `${cell.bold ? '600 ' : ''}12px ui-sans-serif, system-ui, sans-serif`
      drawCellText(ctx, cell.text, rect.x, rect.y, rect.width, rect.height, cell.align ?? 'left', cell.color ?? palette.text)
    }
  }

  // 选区边框与活动格边框：画在文字之上，保证鼠标位置始终可见
  const rect = geometry.rangeRect(selected)
  ctx.strokeStyle = palette.selectionBorder
  ctx.lineWidth = 2
  ctx.strokeRect(rect.x + 1, rect.y + 1, Math.max(0, rect.width - 2), Math.max(0, rect.height - 2))
  const activeRect = geometry.cellRect(active.row, active.col)
  ctx.strokeStyle = palette.activeBorder
  ctx.lineWidth = 2
  ctx.strokeRect(activeRect.x + 1, activeRect.y + 1, Math.max(0, activeRect.width - 2), Math.max(0, activeRect.height - 2))
  ctx.restore()

  // 表头文字：在内容裁剪之外绘制，始终固定
  ctx.fillStyle = palette.headerText
  ctx.textAlign = 'center'
  for (let col = visible.firstCol; col < visible.lastCol; col += 1) {
    const x = HEADER_WIDTH + geometry.colLeft(col) - viewport.scrollLeft
    if (x + geometry.colWidth(col) < HEADER_WIDTH || x > width) continue
    ctx.save()
    ctx.beginPath()
    ctx.rect(Math.max(HEADER_WIDTH, x), 0, Math.min(geometry.colWidth(col), width - x), HEADER_HEIGHT)
    ctx.clip()
    ctx.fillText(columnLabel(col), x + geometry.colWidth(col) / 2, HEADER_HEIGHT / 2)
    ctx.restore()
  }
  ctx.textAlign = 'center'
  for (let row = visible.firstRow; row < visible.lastRow; row += 1) {
    const y = HEADER_HEIGHT + geometry.rowTop(row) - viewport.scrollTop
    if (y + geometry.rowHeight(row) < HEADER_HEIGHT || y > height) continue
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, Math.max(HEADER_HEIGHT, y), HEADER_WIDTH, Math.min(geometry.rowHeight(row), height - y))
    ctx.clip()
    ctx.fillText(String(row + 1), HEADER_WIDTH / 2, y + geometry.rowHeight(row) / 2)
    ctx.restore()
  }

  // 表头与内容的分隔线
  ctx.strokeStyle = palette.gridline
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, HEADER_HEIGHT + 0.5)
  ctx.lineTo(width, HEADER_HEIGHT + 0.5)
  ctx.moveTo(HEADER_WIDTH + 0.5, 0)
  ctx.lineTo(HEADER_WIDTH + 0.5, height)
  ctx.stroke()
}

/** 0 → A，25 → Z，26 → AA；和表格软件的列标一致 */
export function columnLabel(col: number): string {
  let n = Math.max(0, Math.floor(col)) + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}
