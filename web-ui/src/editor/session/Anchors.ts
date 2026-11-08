/**
 * Anchors：跨格式统一锚点工具（先实现 text，其余按同构补齐）
 *
 * 为什么需要统一锚点（设计规范）：
 * 搜索命中高亮、目录跳转、评论/批注定位、AI 引用与协同远端光标，本质都是「在文档里指一个位置」。
 * 过去每种视图各写一套 hit 结构（viewerHit.deriveHit），导致「搜索结果定位到评论框」「AI 引用点不到」
 * 这类跨模块问题。这里把它收敛成 `Anchor`（见 types.ts），并提供偏移维护工具：
 * 文档被编辑后，既有锚点必须跟着平移或收敛，而不是原位失效。
 */
import { formatAnchorKey, type Anchor, type Rect } from '../types'

/** 一次文本编辑对偏移的影响（block 内坐标；from 为编辑起点，removed/inserted 为字符数） */
export interface TextEditRange {
  /** 锚点所在的块（与 Anchor.block 同一标识体系） */
  block: string
  /** 编辑起点偏移 */
  from: number
  /** 被删除的字符数 */
  removed: number
  /** 新插入的字符数 */
  inserted: number
}

/** 各类型锚点的合法取值范围 */
export interface AnchorBounds {
  /** text：块内最大偏移 */
  maxOffset?: number
  /** code：最大行号（1 起） */
  lineCount?: number
  /** code：最大列号（1 起） */
  columnCount?: number
  /** page / pdf：最大页码（1 起） */
  pageCount?: number
  /** slide：最大页序（0 起） */
  slideCount?: number
}

/** 锚点稳定键，用于比对与去重 */
export function anchorKey(anchor: Anchor): string {
  return formatAnchorKey(anchor)
}

/** 两个锚点是否指向同一位置（忽略 quote / rect 这类展示辅助信息） */
export function sameAnchor(a: Anchor | null | undefined, b: Anchor | null | undefined): boolean {
  if (!a || !b) return false
  if (a.kind !== b.kind) return false
  return anchorKey(a) === anchorKey(b)
}

/**
 * 文本锚点在一次编辑之后的偏移修正。
 *
 * 四种情形（区间记作 [s, e)，e = offset + length）：
 * 1. 编辑完全在锚点之后（from >= e）→ 不动；
 * 2. 编辑完全在锚点之前（from + removed <= s）→ 整体平移 delta；
 * 3. 编辑落在锚点区间内部 → 起点不动、长度按 delta 伸缩；
 * 4. 编辑覆盖了锚点起点 → 起点收敛到编辑起点，长度归零（原选区已不可恢复）。
 */
export function shiftTextAnchor(anchor: Anchor, edit: TextEditRange): Anchor {
  if (anchor.kind !== 'text' || anchor.block !== edit.block) return anchor

  const start = anchor.offset
  const length = anchor.length ?? 0
  const end = start + length
  const delta = edit.inserted - edit.removed
  const editEnd = edit.from + edit.removed

  if (edit.from >= end) return anchor

  if (editEnd <= start) {
    return { ...anchor, offset: Math.max(0, start + delta) }
  }

  if (edit.from >= start && editEnd <= end) {
    return { ...anchor, offset: start, length: Math.max(0, length + delta) }
  }

  return { ...anchor, offset: Math.max(0, Math.min(edit.from, start)), length: 0 }
}

/** 把锚点夹回合法范围：文档变短或页数减少后，防止高亮落到不存在的行/页 */
export function clampAnchor(anchor: Anchor, bounds: AnchorBounds): Anchor {
  switch (anchor.kind) {
    case 'text': {
      // 偏移先夹进 [0, max]；长度不能超出剩余可用区间，避免高亮越过块尾
      const max = Math.max(0, bounds.maxOffset ?? Number.MAX_SAFE_INTEGER)
      const offset = Math.min(Math.max(0, anchor.offset), max)
      if (anchor.length === undefined) return { ...anchor, offset }
      const length = Math.max(0, Math.min(anchor.length, max - offset))
      return { ...anchor, offset, length }
    }
    case 'code': {
      const line = Math.min(Math.max(1, anchor.line), Math.max(1, bounds.lineCount ?? anchor.line))
      const column = Math.min(Math.max(1, anchor.column), Math.max(1, bounds.columnCount ?? anchor.column))
      return { ...anchor, line, column }
    }
    case 'page': {
      const page = Math.min(Math.max(1, anchor.page), Math.max(1, bounds.pageCount ?? anchor.page))
      return { ...anchor, page }
    }
    case 'slide': {
      const slide = Math.min(Math.max(0, anchor.slide), Math.max(0, bounds.slideCount ?? anchor.slide))
      return { ...anchor, slide }
    }
    case 'pdf': {
      const page = Math.min(Math.max(1, anchor.page), Math.max(1, bounds.pageCount ?? anchor.page))
      return { ...anchor, page, rect: normalizeRect(anchor.rect) }
    }
    case 'cell':
      // 表格锚点由工作表名 + 单元格坐标确定，不在这里夹取（由 Sheet Surface 结合 sheet 尺寸处理）
      return anchor
  }
}

/** 文本锚点的区间表示，长度缺省视为单点 */
export function textAnchorRange(anchor: Anchor): { start: number; end: number } | null {
  if (anchor.kind !== 'text') return null
  const start = anchor.offset
  return { start, end: start + (anchor.length ?? 0) }
}

/** 两个文本锚点是否重叠（用于搜索结果命中合并、评论区间冲突检测） */
export function textAnchorsOverlap(a: Anchor, b: Anchor): boolean {
  const ra = textAnchorRange(a)
  const rb = textAnchorRange(b)
  if (!ra || !rb) return false
  if (a.kind !== 'text' || b.kind !== 'text') return false
  if (a.block !== b.block) return false
  return ra.start < rb.end && rb.start < ra.end
}

/** 按文档顺序排序锚点（同块按偏移，跨块保持输入顺序的前后关系由调用方给块序号） */
export function sortTextAnchors(anchors: readonly Anchor[], blockOrder: readonly string[] = []): Anchor[] {
  const rank = new Map(blockOrder.map((block, index) => [block, index]))
  return [...anchors].sort((left, right) => {
    if (left.kind !== 'text' || right.kind !== 'text') {
      return anchorKey(left).localeCompare(anchorKey(right))
    }
    const leftRank = rank.get(left.block) ?? Number.MAX_SAFE_INTEGER
    const rightRank = rank.get(right.block) ?? Number.MAX_SAFE_INTEGER
    if (leftRank !== rightRank) return leftRank - rightRank
    if (left.block !== right.block) return left.block.localeCompare(right.block)
    return left.offset - right.offset
  })
}

/** 去重（同键只保留第一个），用于协同光标与评论高亮列表 */
export function dedupeAnchors(anchors: readonly Anchor[]): Anchor[] {
  const seen = new Set<string>()
  const result: Anchor[] = []
  for (const anchor of anchors) {
    const key = anchorKey(anchor)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(anchor)
  }
  return result
}

/** 把矩形收敛为非负宽高，避免 canvas 高亮出现负尺寸 */
function normalizeRect(rect: Rect): Rect {
  const x = Math.max(0, rect.x)
  const y = Math.max(0, rect.y)
  return { x, y, width: Math.max(0, rect.width), height: Math.max(0, rect.height) }
}
