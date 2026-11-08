// 选区批注的锚点:评论挂在一段选中的文字上。
//
// 锚点存"摘录 + 前后各一小段上下文",不存位置:正文被别人改过、段落挪了位置,摘录还能找回来;
// 同一句话出现多次时靠前后文挑对的那一处;摘录本身被改掉就找不到,界面标成"原文已改动",评论不丢。
// 位置只在渲染时现算(文档文本 → 摘录所在的编辑器位置),所以不跟具体的编辑器内容绑死。
// 只用到类型：直接从 prosemirror-model 取，不经过 Milkdown 的再导出（旧编辑器删除后这里不能跟着断）
import type { Node as PmNode } from 'prosemirror-model'

/** 后端 `Anchor::Quote` 的形状(kind 是 serde 的标签) */
export interface QuoteAnchor {
  kind: 'quote'
  text: string
  prefix: string
  suffix: string
}

/** 摘录最长多少字;更长的让用户缩短(评论是针对一句话 / 一小段,不是整章) */
export const MAX_QUOTE_CHARS = 1000
/** 前后文各取多少字 */
export const CONTEXT_CHARS = 32
/** 同一句话最多比较多少处(防止在大文档里对一个常见词做无谓的计算) */
const MAX_CANDIDATES = 200

export interface TextIndex {
  /** 文档纯文本,段落之间用 `\n` 隔开 */
  text: string
  /** `pos[i]` = 第 i 个字符在编辑器里的位置(段落分隔符记在该段开头的位置) */
  pos: number[]
}

/** 把编辑器文档拍平成"文本 + 每个字符的位置",摘录的查找和位置换算都基于它。 */
export function buildTextIndex(doc: PmNode): TextIndex {
  const chars: string[] = []
  const pos: number[] = []
  doc.descendants((node, at) => {
    if (node.isTextblock && chars.length) {
      chars.push('\n')
      pos.push(at)
    }
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) {
        chars.push(node.text[i]!)
        pos.push(at + i)
      }
    }
    return true
  })
  return { text: chars.join(''), pos }
}

export type QuoteResult = { ok: true; anchor: QuoteAnchor } | { ok: false; reason: string }

/** 编辑器里选中 [from, to) 这一段,生成它的锚点。选区是空的 / 只有空白 / 太长都不行,并说明原因。 */
export function buildQuoteAnchor(index: TextIndex, from: number, to: number): QuoteResult {
  let start = index.pos.findIndex((p) => p >= from)
  let end = -1
  for (let i = index.pos.length - 1; i >= 0; i--) {
    if (index.pos[i]! < to) {
      end = i
      break
    }
  }
  if (start < 0 || end < start) return { ok: false, reason: '先选中要评论的文字' }
  // 去掉首尾的空白和段落分隔,摘录才找得回来
  while (start <= end && /\s/.test(index.text[start]!)) start++
  while (end >= start && /\s/.test(index.text[end]!)) end--
  if (end < start) return { ok: false, reason: '先选中要评论的文字' }
  const text = index.text.slice(start, end + 1)
  if (text.length > MAX_QUOTE_CHARS) return { ok: false, reason: `选中的内容太长,请缩短到 ${MAX_QUOTE_CHARS} 字以内` }
  return {
    ok: true,
    anchor: {
      kind: 'quote',
      text,
      prefix: index.text.slice(Math.max(0, start - CONTEXT_CHARS), start),
      suffix: index.text.slice(end + 1, end + 1 + CONTEXT_CHARS),
    },
  }
}

const commonPrefix = (a: string, b: string) => {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}
const commonSuffix = (a: string, b: string) => {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

/** 摘录在编辑器里的位置;找不到(原文被改了)返回 null。出现多处时前后文吻合得最多的那一处胜出。 */
export function locateQuote(index: TextIndex, anchor: Pick<QuoteAnchor, 'text' | 'prefix' | 'suffix'>): { from: number; to: number } | null {
  const needle = anchor.text
  if (!needle) return null
  const hits: number[] = []
  for (let at = index.text.indexOf(needle); at >= 0 && hits.length < MAX_CANDIDATES; at = index.text.indexOf(needle, at + 1)) hits.push(at)
  if (!hits.length) return null
  let best = hits[0]!
  if (hits.length > 1) {
    let bestScore = -1
    for (const at of hits) {
      const before = index.text.slice(Math.max(0, at - CONTEXT_CHARS), at)
      const after = index.text.slice(at + needle.length, at + needle.length + CONTEXT_CHARS)
      const score = commonSuffix(before, anchor.prefix) + commonPrefix(after, anchor.suffix)
      if (score > bestScore) {
        bestScore = score
        best = at
      }
    }
  }
  const first = index.pos[best]
  const last = index.pos[best + needle.length - 1]
  if (first === undefined || last === undefined) return null
  return { from: first, to: last + 1 }
}

/** 评论列表里给人看的摘录:压掉多余空白,太长截断。 */
export function quotePreview(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
