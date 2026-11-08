// 仪表盘「集合」卡里的内容片段占比:按项目拆成环形图的数据。
// 项目多了图例会挤,所以只列占比最大的几个,其余并进「其它」(中性灰,不占项目色)。
import type { DonutItem } from '@kb-ui/index'

export interface ShareEntry {
  name: string
  rows: number
}

/**
 * 按内容片段数从多到少取前 `max` 个项目,其余加起来并成「其它」。
 * 项目的颜色由调用方给(和上面 7 日柱图用的是同一套项目色,同一个项目在两张图里是同一种颜色)。
 * 只剩刚好比上限多一个项目时直接列出它,不并成「其它 1 项」——并了反而看不出是谁。
 */
export function shareDonut(entries: ShareEntry[], colorOf: (name: string) => string, max = 5): DonutItem[] {
  const sorted = entries.filter((entry) => entry.rows > 0).sort((left, right) => right.rows - left.rows || left.name.localeCompare(right.name))
  const keep = sorted.length <= max + 1 ? sorted : sorted.slice(0, max)
  const rest = sorted.slice(keep.length)
  const items: DonutItem[] = keep.map((entry) => ({ name: entry.name, value: entry.rows, color: colorOf(entry.name) }))
  if (rest.length) items.push({ name: `其它 ${rest.length} 个项目`, value: rest.reduce((sum, entry) => sum + entry.rows, 0), other: true })
  return items
}
