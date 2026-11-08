// 任务页的图表数据:各状态的任务数(环形图)和已完成任务的用时分布(横向条)。
// 数字由服务端 job_stats 在 SQL 里算好(任务表能有上万行,不在浏览器里扫);这里只负责整形成图表要的样子。
// 状态的叫法沿用 utils/systemStatus.ts 的 jobStateText,免得图里和表格里对不上。
import { shareText, type DonutItem, type HBarRow } from '@kb-ui/index'
import type { JobSummary } from '@/api/client'
import { jobKindText, jobStateText } from './systemStatus'

// 状态的顺序按「需要关注的程度」排:正在跑的、等着的、停着的在前,结果在后。
// 颜色只给有语义的几个(运行中蓝、完成绿、失败红),排队 / 暂停 / 已取消用中性灰系,不占分类色
const STATES: { key: JobSummary['state']; color: string }[] = [
  { key: 'running', color: 'var(--viz-1)' },
  { key: 'queued', color: 'var(--viz-3)' },
  { key: 'paused', color: 'var(--viz-4)' },
  { key: 'done', color: 'var(--viz-2)' },
  { key: 'failed', color: 'var(--viz-6)' },
  { key: 'canceled', color: 'var(--viz-other)' },
]

/** 各状态的任务数。数量为 0 的状态不列(任务页天天有任务,一排 0 只会淹没有用的数字)。 */
export function stateBreakdown(counts: Partial<Record<JobSummary['state'], number>>): DonutItem[] {
  return STATES.map((state) => ({
    name: jobStateText(state.key),
    value: counts[state.key] ?? 0,
    color: state.color,
  })).filter((item) => item.value > 0)
}

/** 用时分段的名字,和服务端 `JOB_DURATION_EDGES_MS`(10 秒、1 分钟、5 分钟、30 分钟,含上界)一一对应。 */
export const DURATION_LABELS = ['10 秒内', '10 秒–1 分钟', '1–5 分钟', '5–30 分钟', '超过 30 分钟']

/** 已完成任务的用时分布。五段始终都在(0 也留着),一个已完成的都没有时返回空数组。 */
export function durationDistribution(buckets: number[]): HBarRow[] {
  const total = buckets.reduce((sum, count) => sum + count, 0)
  if (!total) return []
  return DURATION_LABELS.map((label, index) => {
    const count = buckets[index] ?? 0
    return {
      key: `d${index}`,
      label,
      segments: [{ name: label, value: count, color: 'var(--viz-1)' }],
      totalText: `${count} 个 · ${shareText(count, total)}`,
    }
  })
}

/**
 * 「类型」下拉:按中文名合并(evolve 和 extract 在界面上都叫「自动提炼」,下拉里不能出现两个同名选项),
 * 每个选项带上它对应的全部原始类型,筛选时一起发给服务端。
 */
export function kindGroups(kinds: { kind: string }[]): { label: string; kinds: string[] }[] {
  const groups = new Map<string, string[]>()
  for (const { kind } of kinds) {
    const label = jobKindText(kind)
    groups.set(label, [...(groups.get(label) ?? []), kind])
  }
  return [...groups.entries()].map(([label, list]) => ({ label, kinds: list.sort() })).sort((left, right) => left.label.localeCompare(right.label))
}
