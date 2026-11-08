// 在已渲染的 DOM(docx / pptx / 表格…)里找一句话并高亮,不改动 DOM 结构。
// 高亮走 CSS Custom Highlight API(`::highlight(kb-hit)`,Chrome 105+ / Safari 17.2+ / Firefox 140+);
// 不支持时只滚动到位置,不会报错。匹配时忽略空白与大小写(抽取文本和渲染文本的换行/空格常不一致)。

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT'])

interface Index {
  text: string
  nodes: Text[]
  /** 第 i 个有效字符属于 nodes[nodeAt[i]] 的第 offsetAt[i] 个字符 */
  nodeAt: Uint32Array
  offsetAt: Uint32Array
}

function buildIndex(root: Node): Index {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (SKIP.has(node.parentElement?.tagName ?? '') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  let total = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    nodes.push(text)
    total += text.data.length
  }
  const nodeAt = new Uint32Array(total)
  const offsetAt = new Uint32Array(total)
  let out = ''
  let count = 0
  nodes.forEach((node, index) => {
    const data = node.data
    for (let at = 0; at < data.length; at += 1) {
      const char = data[at]!
      if (/\s/.test(char)) continue
      out += char.toLowerCase()
      nodeAt[count] = index
      offsetAt[count] = at
      count += 1
    }
  })
  return { text: out, nodes, nodeAt, offsetAt }
}

const squash = (value: string) => value.replace(/\s+/g, '').toLowerCase()

/** 由长到短尝试前缀(整句 → 96 → 48 → 24 → 12 字);找不到返回 null。 */
export function findTextRange(root: Node, needle: string, minChars = 6): Range | null {
  const target = squash(needle)
  if (target.length < Math.min(minChars, 2)) return null
  const index = buildIndex(root)
  const sizes = [...new Set([Math.min(target.length, 240), 96, 48, 24, 12])].filter((size) => size <= target.length && size >= Math.min(minChars, target.length))
  for (const size of sizes) {
    const at = index.text.indexOf(target.slice(0, size))
    if (at < 0) continue
    const last = at + size - 1
    const range = document.createRange()
    range.setStart(index.nodes[index.nodeAt[at]!]!, index.offsetAt[at]!)
    range.setEnd(index.nodes[index.nodeAt[last]!]!, index.offsetAt[last]! + 1)
    return range
  }
  return null
}

/** 一次最多高亮多少处:再多既看不过来,也会拖慢页面。 */
export const MAX_RANGES = 500

/**
 * 在已渲染的 DOM 里找出所有词的所有出现位置(不区分大小写,忽略空白,和 [[findTextRange]] 口径一致)。
 * 每个词都从头到尾扫一遍;范围按在文档里的先后排列,最多 [[MAX_RANGES]] 个。
 */
export function findAllRanges(root: Node, terms: string[]): Range[] {
  const needles = [...new Set(terms.map(squash).filter((term) => term.length >= 1))]
  if (!needles.length) return []
  const index = buildIndex(root)
  const found: { start: number; end: number }[] = []
  for (const needle of needles) {
    let from = 0
    while (found.length < MAX_RANGES * 2) {
      const at = index.text.indexOf(needle, from)
      if (at < 0) break
      found.push({ start: at, end: at + needle.length - 1 })
      from = at + needle.length
    }
  }
  found.sort((left, right) => left.start - right.start || right.end - left.end)
  const ranges: Range[] = []
  let covered = -1
  for (const hit of found) {
    // 长词和它里面的短词重叠时,只留最先出现、最长的那个
    if (hit.start <= covered) continue
    covered = hit.end
    const range = document.createRange()
    range.setStart(index.nodes[index.nodeAt[hit.start]!]!, index.offsetAt[hit.start]!)
    range.setEnd(index.nodes[index.nodeAt[hit.end]!]!, index.offsetAt[hit.end]! + 1)
    ranges.push(range)
    if (ranges.length >= MAX_RANGES) break
  }
  return ranges
}

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void }
function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
  return css?.highlights ?? null
}

export function paintHighlight(name: string, range: Range | null) {
  const highlights = registry()
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  if (!highlights || !Highlight) return
  if (range) highlights.set(name, new Highlight(range))
  else highlights.delete(name)
}

/** 同一个名字下高亮多个范围;没有范围就是清掉。 */
export function paintHighlights(name: string, ranges: Range[]) {
  const highlights = registry()
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  if (!highlights || !Highlight) return
  if (ranges.length) highlights.set(name, new Highlight(...ranges))
  else highlights.delete(name)
}

export function clearHighlight(name: string) {
  registry()?.delete(name)
}

/** 把范围所在元素滚进视野中部(范围可能跨多个元素,取起点所在元素)。 */
export function revealRange(range: Range) {
  const start = range.startContainer
  const element = start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement
  element?.scrollIntoView({ block: 'center', inline: 'nearest' })
}
