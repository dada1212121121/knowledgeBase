/**
 * 行布局：把「底表的行 + 还没写进底表的新行 − 已删除的行」映射成网格看到的连续行号。
 *
 * 为什么需要它：
 * - CSV 里全空白的行在解析时被丢掉（和服务端「全空白行不占行号」同一口径），所以「插入一个空行」
 *   没法直接写进文本——写进去也看不见、点不了。新行必须先作为「待写入的行」留在视图里，
 *   用户填了内容才真正落进文本（本地适配器）或随保存提交（服务端分页适配器）。
 * - 服务端分页的表不会把删除行立刻改到文件里，而是记在草稿里；视图要把它们藏起来，
 *   行号整体上移，撤销时再放回来。
 *
 * 做法：把视图切成不超过 `2 × (新行数 + 删除数) + 1` 段，每段要么是底表里连续的一截，要么是一个新行；
 * 按视图行号二分，所以百万行的表也只是几次比较，不会为每一行存一个条目。
 * 纯数据、不依赖 Vue / DOM，便于单测。
 */

/** 一个待写入的新行：插在底表第 `at` 行之前（等于底表行数就是加在最后），同一位置的新行按数组顺序排 */
export interface InsertedRow {
  /** 本地编号，只用来在视图里认出这一行 */
  id: number
  /** 插在底表第几行之前 */
  at: number
  /** 已经填了的格子（可以比列数短） */
  values: string[]
}

/** 视图行对应的来源 */
export type RowSource = { kind: 'base'; row: number } | { kind: 'inserted'; inserted: InsertedRow } | null

/** 视图里连续的一截底表行 */
export interface BaseRun {
  viewStart: number
  baseStart: number
  length: number
}

type Segment = ({ kind: 'base' } & BaseRun) | { kind: 'inserted'; viewStart: number; inserted: InsertedRow }

export class RowLayout {
  /** 视图总行数 */
  readonly count: number
  private readonly segments: Segment[] = []
  /** 只含底表段，按 baseStart 递增（= 按 viewStart 递增） */
  private readonly runs: BaseRun[] = []

  constructor(baseCount: number, inserted: readonly InsertedRow[] = [], deleted: ReadonlySet<number> = new Set()) {
    const total = Math.max(0, Math.floor(baseCount))
    // 按位置排序、同位置保持数组顺序（带下标比较，不依赖引擎的排序是否稳定）
    const ins = inserted
      .map((row, index) => ({ row, index, at: Math.min(Math.max(0, Math.floor(row.at)), total) }))
      .sort((left, right) => left.at - right.at || left.index - right.index)
    const dels = [...deleted].filter((row) => row >= 0 && row < total).sort((left, right) => left - right)

    let cursor = 0
    let view = 0
    let insIndex = 0
    let delIndex = 0
    for (;;) {
      while (insIndex < ins.length && ins[insIndex]!.at === cursor) {
        this.segments.push({ kind: 'inserted', viewStart: view, inserted: ins[insIndex]!.row })
        view += 1
        insIndex += 1
      }
      if (cursor >= total) break
      while (delIndex < dels.length && dels[delIndex]! < cursor) delIndex += 1
      if (delIndex < dels.length && dels[delIndex] === cursor) {
        cursor += 1
        delIndex += 1
        continue
      }
      // 到下一个「有新行插进来」或「有行被删」的位置为止，中间是连续的底表行
      const nextInsert = insIndex < ins.length ? ins[insIndex]!.at : total
      const nextDelete = delIndex < dels.length ? dels[delIndex]! : total
      const end = Math.min(nextInsert, nextDelete, total)
      const run: BaseRun = { viewStart: view, baseStart: cursor, length: end - cursor }
      this.segments.push({ kind: 'base', ...run })
      this.runs.push(run)
      view += run.length
      cursor = end
    }
    this.count = view
  }

  /** 找到包含视图行 `view` 的那一段（二分）；超出范围返回 -1 */
  private segmentAt(view: number): number {
    if (view < 0 || view >= this.count) return -1
    let low = 0
    let high = this.segments.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (this.segments[mid]!.viewStart <= view) low = mid
      else high = mid - 1
    }
    return low
  }

  /** 视图行来自哪里；超出范围返回 null */
  at(view: number): RowSource {
    const index = this.segmentAt(view)
    if (index < 0) return null
    const segment = this.segments[index]!
    if (segment.kind === 'inserted') return { kind: 'inserted', inserted: segment.inserted }
    return { kind: 'base', row: segment.baseStart + (view - segment.viewStart) }
  }

  /** 底表第 `row` 行现在在视图的第几行；已被删除返回 -1 */
  viewOfBase(row: number): number {
    let low = 0
    let high = this.runs.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const run = this.runs[mid]!
      if (row < run.baseStart) high = mid - 1
      else if (row >= run.baseStart + run.length) low = mid + 1
      else return run.viewStart + (row - run.baseStart)
    }
    return -1
  }

  /** 新行 `id` 现在在视图的第几行；不存在返回 -1 */
  viewOfInserted(id: number): number {
    for (const segment of this.segments) if (segment.kind === 'inserted' && segment.inserted.id === id) return segment.viewStart
    return -1
  }

  /** 视图里连续的底表区段（查找、预取只关心底表行） */
  baseRuns(): readonly BaseRun[] {
    return this.runs
  }

  /** 视图里所有新行的位置（按视图顺序） */
  insertedViews(): ReadonlyArray<{ view: number; inserted: InsertedRow }> {
    const out: Array<{ view: number; inserted: InsertedRow }> = []
    for (const segment of this.segments) if (segment.kind === 'inserted') out.push({ view: segment.viewStart, inserted: segment.inserted })
    return out
  }
}
