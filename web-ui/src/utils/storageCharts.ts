// 存储与用量页的图表数据:全站占用构成(环形图)和每人占用(堆叠横向条 + 配额线)。
// 只做数据整形,不碰界面。分项和名字沿用 utils/usage.ts,免得图里的叫法和表格里的对不上。
import type { StorageRow } from '@/api/usage'
import type { DonutItem, HBarRow } from '@kb-ui/index'
import { formatBytes } from './accountForms'
import { PART_LABELS, ownerHandle, ownerName, partsOf } from './usage'

// 颜色按分项固定:环形图和横向条用同一组,同一种东西在两张图里是同一个颜色
const PART_COLORS = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)']

/** 全站占用按分项加总。四项都保留(哪怕是 0):图例的行数稳定,「代理工作目录 0 B」本身也是一条信息。 */
export function compositionOf(rows: StorageRow[]): DonutItem[] {
  const sums = { notes: 0, originals: 0, vectors: 0, workspace: 0 }
  for (const row of rows) {
    const parts = partsOf(row)
    sums.notes += parts.notes
    sums.originals += parts.originals
    sums.vectors += parts.vectors
    sums.workspace += parts.workspace
  }
  return PART_LABELS.map((part, index) => ({ name: part.label, value: sums[part.key], color: PART_COLORS[index] }))
}

/** 占用最多的几个人,每人一根按分项堆叠的条;配额线就是他的存储上限(不限的不画线)。 */
export function topUsersBars(rows: StorageRow[], limit = 8): HBarRow[] {
  return [...rows]
    .sort((left, right) => right.total_bytes - left.total_bytes)
    .slice(0, limit)
    .map((row) => {
      const parts = partsOf(row)
      return {
        key: row.space_id,
        label: ownerName(row),
        sub: ownerHandle(row),
        // 四项都给(包括 0):分段的名字集合在每一行里一致,图例和颜色才稳定
        segments: PART_LABELS.map((part, index) => ({ name: part.label, value: parts[part.key], color: PART_COLORS[index] })),
        limit: row.limit_bytes > 0 ? row.limit_bytes : 0,
        totalText: `${formatBytes(row.total_bytes)} / ${row.limit_bytes > 0 ? formatBytes(row.limit_bytes) : '不限'}`,
      }
    })
}
