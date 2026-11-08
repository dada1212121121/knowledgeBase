/**
 * 列表「稳定刷新」：保存 / 编辑之后重新读列表时，已经在列表里的行留在原来的位置。
 *
 * 为什么：列表默认按更新时间倒序，改完一篇笔记再读列表，这一篇会跑到最前面，下面的行整体往下挪一格，
 * 用户盯着看的那一行突然不见了。刷新只该更新内容（标题、时间、标签），不该把行重新排队；
 * 要看真正的顺序，翻页 / 换筛选 / 刷新页面时自然会重排。
 *
 * 规则：
 * - 上一屏里还在服务端结果里的行，保持原顺序，内容换成最新的；
 * - 上一屏里的行不在新结果里了（被删、被改到别的页）：去掉；
 * - 新出现的行（刚新建 / 刚索引完）：放在它在服务端结果里前一行的后面，没有前一行就放最前；
 * - 总数不超过 limit（一页的条数）。
 */
export function mergeStableOrder<T extends { id: string }>(previous: readonly T[], next: readonly T[], limit: number): T[] {
  const fresh = new Map(next.map((row) => [row.id, row]))
  const out = previous.filter((row) => fresh.has(row.id)).map((row) => fresh.get(row.id)!)
  const present = new Set(out.map((row) => row.id))
  next.forEach((row, index) => {
    if (present.has(row.id)) return
    let before: T | undefined
    for (let at = index - 1; at >= 0; at -= 1) {
      if (present.has(next[at]!.id)) {
        before = next[at]
        break
      }
    }
    const position = before ? out.findIndex((item) => item.id === before!.id) + 1 : 0
    out.splice(position, 0, row)
    present.add(row.id)
  })
  return out.slice(0, limit)
}
