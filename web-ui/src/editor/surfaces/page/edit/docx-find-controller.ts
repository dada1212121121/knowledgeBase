/**
 * Word 编辑面的查找控制器：持有查找状态，对 Host 的 `search.*` 命令作答。
 *
 * 只依赖一个窄接口 `FindBackend`（查 / 选中 / 替换 / 取高亮矩形），真引擎的绑定在 `createFindBackend`，
 * 所以控制器的逻辑（命中游走、替换后的状态、版本过期的处理）用假后端就能测，不需要起引擎。
 *
 * 几条必须保持的约定：
 * - 替换前总是重新查一遍再对着"新鲜的命中 + 新鲜的版本"替换：用户查找之后别人（协同）或自己又改了文档，
 *   旧命中的位置可能已经不对；引擎自己也会因为 `expectVersion` 不符而拒绝，但我们不依赖被拒绝来发现；
 * - 当前命中不在新鲜结果里（被别人改没了）时不替换别处，如实告诉用户并更新列表；
 * - 替换全部是一个整批的引擎命令：要么全部替换要么都不替换，撤销一次回到替换前（一个撤销步骤）。
 */
import type { CommandResult } from '../../../types'
import {
  buildReplaceRequest,
  EMPTY_FIND,
  FIND_LIMIT,
  highlightRange,
  selectionForMatch,
  stepIndex,
  toFindResult,
  validateReplacement,
  type DocxMatch,
  type FindResult,
  type FindState,
} from './docx-find'

/** 页面上的一块高亮（页内坐标；View 加上页的位置后画） */
export interface FindRect {
  pageId: string
  pageIndex: number
  x: number
  y: number
  width: number
  height: number
  /** 是不是当前命中（画得更醒目） */
  current: boolean
}

export interface FindBackend {
  /** 在正文里按"接受修订后的文字"查 `query` */
  find(query: string): Promise<{ version: string; matches: DocxMatch[]; truncated: boolean }>
  /**
   * 选中某个命中；失败（文档已变）`ok` 为 false。
   * `shown` 在含这个选区的几何帧装好之后落定：引擎的回执比那一帧早到（机器忙时能早几秒），
   * 回执一到就按几何滚会读到上一个命中的位置，所以滚动要等 `shown`
   */
  select(match: DocxMatch): Promise<{ ok: boolean; shown: Promise<void> }>
  /** 把这些范围替换成 `text`；`version` 是查找时的文档版本。`suggesting` 有值时作为修订标记提交 */
  replace(request: ReturnType<typeof buildReplaceRequest>): Promise<{ ok: boolean; reason?: string }>
  /** 取这些命中在页面上的矩形（每个命中可能多块）；换算失败（文档在算的过程中变了）返回 null */
  highlights(matches: readonly DocxMatch[]): Promise<Array<Array<Omit<FindRect, 'current'>>> | null>
  /** 当前是不是修订模式（是则替换变成修订标记）；返回作者 */
  suggesting(): { name: string } | undefined
}

export interface FindControllerHooks {
  /** 高亮变了（View 重画） */
  onHighlights(rects: readonly FindRect[]): void
  /** 选中的命中已进入几何之后把它滚到可见：实现按选区几何滚，不依赖高亮矩形 */
  reveal(): void
  /** 命中所在页码（1 起） */
  pageOf(pageIndex: number): number
}

export class DocxFindController {
  private state: FindState = EMPTY_FIND
  private version = ''
  private rects: Array<Array<Omit<FindRect, 'current'>>> = []
  /** 防止快速连续输入时旧请求的结果盖掉新请求 */
  private ticket = 0
  /** 最近一次跳转的编号：连按"下一个"时，前面几次的几何帧后到，它们不该再把页面滚到中间的命中去 */
  private jump = 0

  constructor(
    private readonly backend: FindBackend,
    private readonly hooks: FindControllerHooks,
  ) {}

  get current(): FindState {
    return this.state
  }

  private result(): FindResult {
    return toFindResult(this.state, (match) => {
      const first = this.rects[this.state.matches.indexOf(match)]?.[0]
      return first ? this.hooks.pageOf(first.pageIndex) : 0
    })
  }

  private async paint(): Promise<void> {
    const ticket = this.ticket
    const rects = await this.backend.highlights(this.state.matches).catch(() => null)
    if (ticket !== this.ticket) return
    this.rects = rects ?? []
    this.hooks.onHighlights(this.rects.flatMap((group, index) => group.map((rect) => ({ ...rect, current: index === this.state.index }))))
  }

  /** 查找并停在第一个命中（从头开始，和浏览器查找一致） */
  async set(query: string): Promise<CommandResult> {
    const ticket = ++this.ticket
    if (!query) return this.clear()
    const found = await this.backend.find(query)
    if (ticket !== this.ticket) return { ok: true, data: this.result() }
    this.version = found.version
    this.state = { query, matches: found.matches.slice(0, FIND_LIMIT), index: found.matches.length ? 0 : -1, truncated: found.truncated }
    await this.paint()
    if (ticket !== this.ticket) return { ok: true, data: this.result() }
    await this.goto()
    return { ok: true, data: this.result() }
  }

  private async goto(): Promise<void> {
    const match = this.state.matches[this.state.index]
    if (!match) return
    const jump = ++this.jump
    const selected = await this.backend.select(match)
    if (!selected.ok) return
    // 不阻塞命令返回（计数 / 当前下标要马上更新），帧到了再滚；这段时间里又跳去别处的话由新的那次去滚
    void selected.shown.then(() => {
      if (jump === this.jump) this.hooks.reveal()
    })
  }

  async step(backward: boolean): Promise<CommandResult> {
    if (!this.state.matches.length) return { ok: true, data: this.result() }
    this.state = { ...this.state, index: stepIndex(this.state.index, this.state.matches.length, backward) }
    // 重画一遍让"当前"那块变醒目，再滚过去
    this.hooks.onHighlights(this.rects.flatMap((group, index) => group.map((rect) => ({ ...rect, current: index === this.state.index }))))
    await this.goto()
    return { ok: true, data: this.result() }
  }

  /** 替换当前命中并停在下一个 */
  async replaceOne(text: string): Promise<CommandResult> {
    const invalid = validateReplacement(text)
    if (invalid) return { ok: false, reason: invalid }
    const target = this.state.matches[this.state.index]
    if (!target) return { ok: false, reason: '没有可替换的命中' }
    const fresh = await this.backend.find(this.state.query)
    const targetKey = JSON.stringify(target.range)
    const stillThere = fresh.matches.find((match) => JSON.stringify(match.range) === targetKey)
    if (!stillThere) {
      // 文档在查找之后变了，这一处已经不在了：更新列表，让用户重新看一眼再决定，不替换别处
      this.version = fresh.version
      this.state = { query: this.state.query, matches: fresh.matches, index: fresh.matches.length ? 0 : -1, truncated: fresh.truncated }
      await this.paint()
      return { ok: false, reason: '文档在你查找之后被改动了，这一处已经不在原位置，已重新查找', data: this.result() }
    }
    const outcome = await this.backend.replace(buildReplaceRequest([stillThere], text, fresh.version, this.backend.suggesting()))
    if (!outcome.ok) return { ok: false, reason: outcome.reason ?? '替换没有成功' }
    // 替换后重新查：后面命中的位置都变了（长度不同），不能沿用旧的
    const keep = this.state.index
    const after = await this.backend.find(this.state.query)
    this.version = after.version
    // 修订模式下被替换的文字还在文档里（作为删除标记），"接受后的文字"里不再有它，所以命中自然少一个；
    // 光标停在原下标（= 原来的下一个命中），到末尾就停在最后一个
    this.state = { query: this.state.query, matches: after.matches, index: after.matches.length ? Math.min(keep, after.matches.length - 1) : -1, truncated: after.truncated }
    await this.paint()
    await this.goto()
    return { ok: true, data: this.result() }
  }

  /** 替换全部：整批一次提交 */
  async replaceAll(text: string): Promise<CommandResult> {
    const invalid = validateReplacement(text)
    if (invalid) return { ok: false, reason: invalid }
    if (!this.state.query) return { ok: false, reason: '先输入要查找的内容' }
    const fresh = await this.backend.find(this.state.query)
    if (!fresh.matches.length) {
      this.state = { query: this.state.query, matches: [], index: -1, truncated: false }
      await this.paint()
      return { ok: true, data: { ...this.result(), replaced: 0 } }
    }
    if (fresh.truncated) return { ok: false, reason: `命中超过 ${FIND_LIMIT} 处，请缩小查找范围后再替换全部` }
    const outcome = await this.backend.replace(buildReplaceRequest(fresh.matches, text, fresh.version, this.backend.suggesting()))
    if (!outcome.ok) return { ok: false, reason: outcome.reason ?? '替换没有成功' }
    const after = await this.backend.find(this.state.query)
    this.version = after.version
    this.state = { query: this.state.query, matches: after.matches, index: after.matches.length ? 0 : -1, truncated: after.truncated }
    await this.paint()
    return { ok: true, data: { ...this.result(), replaced: fresh.matches.length } }
  }

  clear(): CommandResult {
    this.ticket += 1
    this.state = EMPTY_FIND
    this.rects = []
    this.hooks.onHighlights([])
    return { ok: true, data: this.result() }
  }

  /**
   * 只重取高亮矩形（不重新查找）。命中跳到还没挂载的页时，引擎取不到那一页的矩形（页没有画出来），
   * 页窗口移过去、页建好之后要再取一次，当前命中的高亮才会出现。
   */
  async repaint(): Promise<void> {
    if (!this.state.matches.length) return
    // 当前命中已经有矩形就不用重取：滚动时几何每帧都在变，不能每次都去问引擎
    if (this.rects[this.state.index]?.length) return
    this.ticket += 1
    await this.paint()
  }

  /** 文档变了（本地或协同）：已有命中的位置不可信，重新查一遍保持高亮和计数同步 */
  async refresh(): Promise<void> {
    if (!this.state.query) return
    const query = this.state.query
    const keep = this.state.index
    const ticket = ++this.ticket
    const found = await this.backend.find(query).catch(() => null)
    if (!found || ticket !== this.ticket) return
    this.version = found.version
    this.state = { query, matches: found.matches.slice(0, FIND_LIMIT), index: found.matches.length ? Math.min(Math.max(keep, 0), found.matches.length - 1) : -1, truncated: found.truncated }
    await this.paint()
  }

  get documentVersion(): string {
    return this.version
  }
}

/** 查找状态里的 `selectionForMatch` 与 `highlightRange` 给真后端用 */
export { highlightRange, selectionForMatch }
