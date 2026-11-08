/**
 * 检索命中文字 → 幻灯片里的查找候选
 *
 * 检索结果给的是「块文本」：可能是整页一大段（多行用换行连接）、结尾带省略号、条目之间用 ` · ` 分隔。
 * 引擎的查找是精确的、按段落的，拿整块去找几乎一定找不到，所以按「整句 → 第一行 → 分隔后的小段 →
 * 逐步截短的前缀」依次试，第一个在目标页上找到的就是命中位置（与旧预览的 findTextRange 前缀策略一致）。
 */

/** 最少多少个字才值得拿去查：1 个字在一页里到处都是，高亮出来没有意义 */
const MIN_LENGTH = 2

export function hitCandidates(text: string): string[] {
  const clean = text.trim().replace(/[….]{2,}$/u, '').trim()
  if (!clean) return []
  const out: string[] = []
  const add = (value: string) => {
    const v = value.trim()
    if (v.length >= MIN_LENGTH && !out.includes(v)) out.push(v)
  }
  add(clean)
  const first = clean.split(/\n+/u)[0] ?? ''
  add(first)
  for (const piece of first.split(/\s[·|]\s|\s{2,}/u)) add(piece)
  for (const size of [48, 24, 12]) if (first.length > size) add(first.slice(0, size))
  return out
}
