/**
 * Word 修订（Track Changes）的纯逻辑与控制器。
 *
 * 修订在画布上由引擎自己画（插入带下划线和作者色、删除带删除线）；侧栏只列出"有哪些修订"并让人逐条接受 / 拒绝。
 * 引擎的修订种类很多（文字插入 / 删除、段落属性变化、表格行插删…），侧栏把它们翻成人话，认不得的原样显示种类名而不是丢掉。
 */
import type { CommandResult } from '../../../types'

export interface RawRevision {
  revisionId: string
  author: string
  date: string
  /** insertion / deletion / pPrChange / trIns / trDel / tableIns / tableDel … */
  kind: string
  story: string
  preview: string
  /** 范围（同一段内）；引擎没给就不能合并 */
  range?: { story: string; start: { paraId: string; offset: number }; end: { paraId: string; offset: number } }
}

export interface RevisionView extends RawRevision {
  /** 合并显示时这一条背后的全部引擎修订 id（接受 / 拒绝要对每一条都生效）；没有合并就只有自己 */
  ids: string[]
  /** 给人看的种类，如"插入"、"删除" */
  label: string
  /** 是我做的 */
  mine: boolean
}

const KIND_LABELS: Record<string, string> = {
  insertion: '插入',
  deletion: '删除',
  pPrIns: '新增段落',
  pPrDel: '删除段落',
  pPrChange: '段落格式变化',
  trIns: '插入表格行',
  trDel: '删除表格行',
  tableIns: '插入表格',
  tableDel: '删除表格',
}

export function revisionLabel(kind: string): string {
  return KIND_LABELS[kind] ?? `修订（${kind}）`
}

/** 按作者分组统计，侧栏头部显示"甲 3 处、乙 1 处" */
export function summarizeByAuthor(revisions: readonly RawRevision[]): Array<{ author: string; count: number }> {
  const counts = new Map<string, number>()
  for (const revision of revisions) counts.set(revision.author, (counts.get(revision.author) ?? 0) + 1)
  return [...counts.entries()].map(([author, count]) => ({ author, count })).sort((left, right) => right.count - left.count || left.author.localeCompare(right.author))
}

/**
 * 把相邻的碎片合并成一条显示。
 *
 * 为什么要合并：引擎在修订模式下把键入的每个字符各记成一个插入（实测敲 " ADDED" 得到 6 个 `w:ins`），
 * 内容和 Word 能读的文件都是对的，但侧栏里 6 条单字"插入"没法用——Word 里一次连续输入是一条修订。
 * 合并条件：同作者、同种类、同一个故事，且后一条从前一条结束的位置开始（首尾相接，没有别的字夹在中间）。
 * 只合并文字类（插入 / 删除）；表格行、段落属性变化各算各的。只合并显示，接受 / 拒绝时对这一组的每条 id 都生效。
 */
export function mergeAdjacent(revisions: readonly RawRevision[]): Array<RawRevision & { ids: string[] }> {
  const merged: Array<RawRevision & { ids: string[] }> = []
  for (const revision of revisions) {
    const previous = merged.at(-1)
    const joins =
      !!previous &&
      !!previous.range &&
      !!revision.range &&
      (revision.kind === 'insertion' || revision.kind === 'deletion') &&
      previous.author === revision.author &&
      previous.kind === revision.kind &&
      previous.story === revision.story &&
      previous.range.end.paraId === revision.range.start.paraId &&
      previous.range.end.offset === revision.range.start.offset
    if (previous && joins && previous.range && revision.range) {
      previous.ids.push(revision.revisionId)
      previous.range = { story: previous.range.story, start: previous.range.start, end: revision.range.end }
      previous.preview = `${previous.preview}${revision.preview}`
    } else merged.push({ ...revision, ids: [revision.revisionId] })
  }
  return merged
}

export function toRevisionViews(revisions: readonly RawRevision[], me: string): RevisionView[] {
  return mergeAdjacent(revisions).map((revision) => ({ ...revision, label: revisionLabel(revision.kind), mine: revision.author === me }))
}

/** 修订预览文字：空的（纯格式修订）显示占位；过长的截断，加省略号 */
export function previewText(preview: string, max = 60): string {
  const flat = preview.replace(/\s+/g, ' ').trim()
  if (!flat) return '（无文字）'
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/* ---------------- 控制器 ---------------- */

export interface RevisionBackend {
  read(): Promise<RawRevision[]>
  /** 接受 / 拒绝一条；修订已经不存在返回 `{ok:false}` */
  decide(revisionId: string, accept: boolean): Promise<CommandResult>
  /** 点修订 → 选中它并滚过去 */
  reveal(revisionId: string): Promise<boolean>
}

export interface RevisionControllerOptions {
  me: string
  editable: () => boolean
  onChange(revisions: readonly RevisionView[]): void
}

export class DocxRevisionController {
  private revisions: RevisionView[] = []
  private reading: Promise<void> | null = null
  private again = false

  constructor(
    private readonly backend: RevisionBackend,
    private readonly options: RevisionControllerOptions,
  ) {}

  get current(): readonly RevisionView[] {
    return this.revisions
  }

  refresh(): Promise<void> {
    if (this.reading) {
      this.again = true
      return this.reading
    }
    this.reading = (async () => {
      try {
        do {
          this.again = false
          this.revisions = toRevisionViews(await this.backend.read(), this.options.me)
          this.options.onChange(this.revisions)
        } while (this.again)
      } finally {
        this.reading = null
      }
    })()
    return this.reading
  }

  /** 接受 / 拒绝一条。不管成败都刷新：失败常常是别人（协同）已经处理了它，刷新后用户看到的才是真实状态 */
  async decide(revisionId: string, accept: boolean): Promise<CommandResult> {
    if (!this.options.editable()) return { ok: false, reason: '文档当前是只读的，不能接受或拒绝修订' }
    // 合并显示的一条背后可能是好几个引擎修订：每一个都要处理，缺一个就会在文档里留下半截修订
    const ids = this.revisions.find((revision) => revision.ids.includes(revisionId))?.ids ?? [revisionId]
    let result: CommandResult = { ok: true }
    try {
      for (const id of ids) {
        result = await this.backend.decide(id, accept)
        if (!result.ok) break
      }
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    await this.refresh().catch(() => undefined)
    return result
  }

  /**
   * 全部接受 / 全部拒绝：逐条用新鲜的目标提交，遇到失败就停（不带着旧 id 硬往下做），返回已处理几条。
   * 不做成引擎的一次整批命令，是因为引擎的接受 / 拒绝按单个修订 id 定义；逐条的好处是每一步都可撤销、失败可定位。
   */
  async decideAll(accept: boolean, only?: (revision: RevisionView) => boolean): Promise<CommandResult & { done?: number }> {
    if (!this.options.editable()) return { ok: false, reason: '文档当前是只读的，不能接受或拒绝修订' }
    await this.refresh()
    const targets = this.revisions.filter((revision) => !only || only(revision)).map((revision) => revision.revisionId)
    let done = 0
    for (const id of targets) {
      const result = await this.decide(id, accept)
      if (!result.ok) {
        // 失败了：`decide` 已经刷新过列表。这一条若已不在列表里，就是读到列表之后被别人（协同）处理掉了，
        // 不算失败，继续下一条；还在，才是真的失败，停下。不靠错误文案判断，文案会随引擎版本变
        if (!this.revisions.some((revision) => revision.revisionId === id)) continue
        return { ...result, done }
      }
      done += 1
    }
    return { ok: true, done }
  }

  reveal(revisionId: string): Promise<boolean> {
    return this.backend.reveal(revisionId)
  }
}
