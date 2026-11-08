// 「在正文里找到」(UI-3,AI 修改建议):建议里的原文是存储里的 Markdown,正文(阅读页 / 编辑器)里显示的是去掉标记的文字。
// 取原文第一行非空内容,去掉行首的列表 / 标题 / 引用标记和行内的加粗、删除线、行内代码、链接写法,得到可以在显示文字里查找的一段。
// 只找第一行:跨段落的原文在显示文字里没有换行,整段对不上;第一行足够定位到位置。

/** 最长取多少字:太长的一行逐字比对没有必要,前面一截已经足够唯一 */
const MAX_NEEDLE = 120

export function locateNeedle(markdown: string): string {
  const line = markdown
    .split('\n')
    .map((item) => item.trim())
    .find(Boolean)
  if (!line) return ''
  return line
    .replace(/^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+|>\s*)+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)\*(?!\w)/g, '$1$2')
    .trim()
    .slice(0, MAX_NEEDLE)
}

/**
 * 在一块已渲染的正文里找文字并选中、滚到中间(阅读页没有编辑器,用浏览器原生选区当高亮)。
 * 文字可能被行内标记拆成好几个文本节点:先把文本节点首尾相接,在整串里找,再把位置换回节点里的偏移。
 */
export function selectTextIn(root: Element, needle: string): boolean {
  if (!needle) return false
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const starts: number[] = []
  let all = ''
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    starts.push(all.length)
    nodes.push(node)
    all += node.data
  }
  const at = all.indexOf(needle)
  if (at < 0) return false
  const locate = (index: number, end: boolean) => {
    let i = nodes.length - 1
    // 结束位置落在两个节点交界处时取前一个节点的末尾，选区不会多带一个空节点
    while (i > 0 && (end ? starts[i]! >= index : starts[i]! > index)) i -= 1
    return { node: nodes[i]!, offset: index - starts[i]! }
  }
  const start = locate(at, false)
  const finish = locate(at + needle.length, true)
  const range = root.ownerDocument.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(finish.node, finish.offset)
  const selection = root.ownerDocument.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  start.node.parentElement?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  return true
}
