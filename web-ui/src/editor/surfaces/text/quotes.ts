/**
 * 笔记文本面的选区批注：正文里的摘录高亮 + 摘录 ⇄ 统一锚点
 *
 * 为什么高亮用 ProseMirror 装饰（Decoration）而不是改文档：
 * 批注是“别人对这段话的评论”，不是正文内容。装饰只存在于视图层——不进文档、不进序列化结果、不产生撤销步骤、
 * 不经过协同房间，所以 `roomSchema` 的房间格式（Milkdown 兼容）一个字不动，新旧客户端能同屏编辑同一份笔记。
 *
 * 为什么锚点存“摘录 + 前后文”而不是位置：
 * 落库的格式是后端的 `Anchor::Quote`（见 utils/quoteAnchor.ts），正文被改过、段落挪了，摘录还能按文字找回来；
 * 摘录本身被改掉就找不到，评论保留，侧栏标“原文已改动”。位置每次渲染时现算，所以也不会被协同里别人的编辑弄错。
 * 内容面这一侧对外说统一锚点（`Anchor` 的 text 类）：{@link textAnchorOfRange} 把一段选区换成 `{block, offset, length, quote}`。
 */
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { buildTextIndex, locateQuote, type TextIndex } from '@/utils/quoteAnchor'
import type { Anchor, TextComments, TextQuote } from '../../types'
import { blockPathAt, blockStartAt, blockText } from './selection'

/** 文本类统一锚点 */
export type TextAnchor = Extract<Anchor, { kind: 'text' }>

/** 插件状态：装饰集合 + 现在找得到摘录的评论 id（已排序，便于比较） */
interface QuoteState {
  set: DecorationSet
  located: string[]
  /** 当前一共有几条摘录（0 条时首次不向页面汇报，避免评论列表还没加载就把全部标成“原文已改动”） */
  total: number
}

/** 同一段话最多比较多少处（防止在大文档里对一个常见词做无谓的计算，与 utils/quoteAnchor 同量级） */
const MAX_HITS = 200

export const quoteKey = new PluginKey<QuoteState>('kbTextQuotes')

const EMPTY: QuoteState = { set: DecorationSet.empty, located: [], total: 0 }

/** 摘录所在的文档位置区间；找不到（原文被改了）返回 null。出现多处时前后文吻合最多的那一处胜出 */
export function quoteRange(index: TextIndex, quote: Pick<TextQuote, 'text' | 'prefix' | 'suffix'>): { from: number; to: number } | null {
  return locateQuote(index, quote)
}

function buildState(doc: PMNode, quotes: readonly TextQuote[], active: string | null): QuoteState {
  if (!quotes.length) return EMPTY
  const index = buildTextIndex(doc)
  const decorations: Decoration[] = []
  const located: string[] = []
  for (const quote of quotes) {
    const range = quoteRange(index, quote)
    // 摘录找不到：不画高亮，评论栏会标“原文已改动”
    if (!range) continue
    located.push(quote.id)
    decorations.push(
      Decoration.inline(
        range.from,
        range.to,
        {
          class: `kb-quote${quote.resolved ? ' is-resolved' : ''}${quote.id === active ? ' is-active' : ''}`,
          'data-quote-id': quote.id,
        },
        { quoteId: quote.id },
      ),
    )
  }
  return { set: DecorationSet.create(doc, decorations), located: located.sort(), total: quotes.length }
}

export interface QuotePluginDeps {
  /** 每次现读：页面的评论列表是异步回来的，内容面挂载之后才有 */
  comments: () => TextComments | undefined
}

/**
 * 高亮插件。文档变了（含协同里别人的修改）或页面通知刷新（meta）时重新定位；其余事务只做映射，输入不为它付 O(n)。
 * 没有任何摘录时直接用空集合，编辑不受影响。
 */
export function quotePlugin(deps: QuotePluginDeps): Plugin<QuoteState> {
  const compute = (doc: PMNode): QuoteState => {
    const comments = deps.comments()
    return comments ? buildState(doc, comments.quotes(), comments.activeQuote()) : EMPTY
  }
  return new Plugin<QuoteState>({
    key: quoteKey,
    state: {
      init: (_config, state) => compute(state.doc),
      apply: (tr, old) => {
        if (tr.docChanged || tr.getMeta(quoteKey)) return compute(tr.doc)
        return old.set === DecorationSet.empty ? old : { ...old, set: old.set.map(tr.mapping, tr.doc) }
      },
    },
    props: {
      decorations: (state) => quoteKey.getState(state)?.set,
    },
    view: (view) => {
      // null = 还没汇报过
      let reported: string | null = null
      const report = (view: EditorView) => {
        const comments = deps.comments()
        const state = quoteKey.getState(view.state)
        if (!comments || !state) return
        const key = state.located.join('|')
        if (key === reported) return
        if (reported === null && state.total === 0) return
        reported = key
        comments.located([...state.located])
      }
      // 挂载时就汇报一次：评论列表在编辑器之前到的话，之后可能再没有任何事务触发 update
      report(view)
      return {
        update: (v) => report(v),
      }
    },
  })
}

/** 页面的评论列表 / 聚焦项变了：让高亮重算（只带 meta，不改文档） */
export function refreshQuotes(view: EditorView): void {
  if (!quoteKey.getState(view.state)) return
  view.dispatch(view.state.tr.setMeta(quoteKey, true))
}

/** 现在正文里找得到的摘录：评论 id + 统一锚点 */
export function locatedQuotes(state: EditorState, quotes: readonly TextQuote[]): { id: string; anchor: TextAnchor }[] {
  const index = buildTextIndex(state.doc)
  const found: { id: string; anchor: TextAnchor }[] = []
  for (const quote of quotes) {
    const range = quoteRange(index, quote)
    if (range) found.push({ id: quote.id, anchor: textAnchorOfRange(state.doc, range.from, range.to, quote.text) })
  }
  return found
}

/**
 * 文档位置区间 → 统一锚点（{@link TextAnchor}）。
 * block / offset 描述区间起点所在的文本块，length 只数到该块末尾；跨块的摘录用 quote 带全文，
 * 文档变了以后靠 quote 重新定位（见 {@link resolveAnchorRange}）。
 */
export function textAnchorOfRange(doc: PMNode, from: number, to: number, quote: string): TextAnchor {
  const block = blockPathAt(doc, from)
  const start = blockStartAt(doc, block)
  const offset = start ? from - start.start : 0
  const length = start ? Math.max(0, Math.min(to - from, blockText(start.node).length - offset)) : 0
  return { kind: 'text', block, offset, length, quote }
}

/**
 * 统一锚点 → 现在文档里的位置区间。
 * - 没带 quote（目录、搜索命中）：按 block / offset 取，和 `rangeFromAnchor` 一致；
 * - 带 quote（批注）：一律按 quote 在全文里找，出现多处时取离原位置（block / offset）最近的一处。
 *   这样正文被改过、段落挪了，锚点仍能找回来；没动过就恰好落在原处；
 * - quote 在全文里找不到，而原位置上的文字仍是 quote 的开头（quote 里带硬换行，文本索引不含换行节点）：沿用原位置；
 * - 其余返回 null（调用方说“锚点已失效”，评论栏标“原文已改动”）。
 */
export function resolveAnchorRange(doc: PMNode, anchor: Anchor): { from: number; to: number } | null {
  if (anchor.kind !== 'text') return null
  const start = blockStartAt(doc, anchor.block)
  let direct: { from: number; to: number } | null = null
  if (start) {
    const textLength = blockText(start.node).length
    const from = start.start + Math.max(0, Math.min(anchor.offset, textLength))
    direct = { from, to: Math.min(from + Math.max(0, anchor.length ?? 0), start.start + textLength) }
  }
  const quote = anchor.quote
  if (!quote) return direct
  const index = buildTextIndex(doc)
  const hits: number[] = []
  for (let at = index.text.indexOf(quote); at >= 0 && hits.length < MAX_HITS; at = index.text.indexOf(quote, at + 1)) hits.push(at)
  if (hits.length) {
    const origin = direct?.from ?? 0
    let best = hits[0]!
    for (const at of hits) {
      const pos = index.pos[at]
      const bestPos = index.pos[best]
      if (pos !== undefined && bestPos !== undefined && Math.abs(pos - origin) < Math.abs(bestPos - origin)) best = at
    }
    const first = index.pos[best]
    const last = index.pos[best + quote.length - 1]
    return first === undefined || last === undefined ? null : { from: first, to: last + 1 }
  }
  if (direct && direct.to > direct.from && quote.startsWith(doc.textBetween(direct.from, direct.to, '\n', '\n'))) return direct
  return null
}

/** 点中的是哪条批注高亮（不在高亮上返回 null） */
export function quoteIdAt(view: EditorView, target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  const hit = target.closest('[data-quote-id]')
  if (!hit || !view.dom.contains(hit)) return null
  return (hit as HTMLElement).dataset.quoteId ?? null
}

/** 把某条批注的高亮滚到视野中间；正文里找不到（原文已改动）返回 false */
export function revealQuote(view: EditorView, id: string): boolean {
  for (const el of view.dom.querySelectorAll<HTMLElement>('[data-quote-id]')) {
    if (el.dataset.quoteId !== id) continue
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    return true
  }
  return false
}
