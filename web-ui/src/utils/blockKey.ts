/**
 * 阅读 → 编辑交接时，怎么认出「阅读页上的这一块」在编辑器里是哪一块。
 *
 * 阅读页（MarkdownRead，markdown-it 出的 HTML）和编辑器（ProseMirror）是两套 DOM，块的顺序大体一致，
 * 但下标对不上（阅读页会把表格包一层滚动容器、流程图换成图片…）。所以按块的文字认：去掉空白后取开头一段，
 * 两边谁是谁的前缀就算同一块（双链在阅读页显示标题、在编辑器里是原文，开头一段之后才不一样的情况也认得出）；
 * 同样文字的块按第几次出现区分。认不出来（流程图、公式这类两边文字不同的块）就换下一块，或者放弃不动。
 */

/** 参与比较的开头长度：够区分绝大多数段落，又不至于被后面的双链 / 公式差异干扰 */
const KEY_LENGTH = 48
/** 前缀比较至少要这么长才算数（太短的块，例如只有一个字，只能完全相同才算） */
const MIN_PREFIX = 24

/** 块的比较用文字：去掉所有空白，取开头一段 */
export function blockKey(text: string): string {
  return text.replace(/\s+/g, '').slice(0, KEY_LENGTH)
}

/** 两块是不是同一块：完全相同，或者较短的一方够长、并且是另一方的前缀 */
export function blockKeysMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= MIN_PREFIX && long.startsWith(short.slice(0, MIN_PREFIX))
}

/** 阅读页一块元素的比较用文字：代码块只取代码本身（阅读页的代码块可能带语言标签之类的界面文字） */
export function readerBlockKey(el: Element): string {
  const code = el.tagName === 'PRE' ? el.querySelector('code') : null
  return blockKey((code ?? el).textContent ?? '')
}
