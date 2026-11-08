// 「搜索与排序」分区里「按反馈调整权重」的展示逻辑(纯函数,便于单测)。
// 数据来自能力 `tune_retrieval`(后端 `kb-service` 的 FeedbackTuning):按每个集合上「有用 / 无用」反馈的有用率,
// 给出融合排序时各集合的权重建议;应用时写进 `search.collection_weights`,前后各跑一次评测,得分下降自动回滚。

export interface WeightSuggestion {
  collection: string
  current: number
  suggested: number
  delta: number
  samples: number
  useful_rate: number
  reason: string
}

export interface TuneGroup {
  collection: string
  kind: string
  prefix: string
  total: number
  useful: number
  rate: number
}

export interface TuneResult {
  feedback: number
  matched: number
  overall_rate: number
  groups: TuneGroup[]
  suggestions: WeightSuggestion[]
  skipped: string[]
  applied?: boolean
  rolled_back?: boolean
  weights?: Record<string, number>
  eval?: {
    before: { mrr?: number; hit_at_5?: number } | null
    after: { mrr?: number; hit_at_5?: number } | null
    before_error?: string | null
    after_error?: string | null
  }
  notes?: string[]
}

/** 百分比不带小数(术语表「数字、时间与单位」)。 */
export const percent = (rate: number) => `${Math.round(rate * 100)}%`

/** 评测得分(MRR,越高越好);没有就写「—」,不编数。 */
export function mrrText(value: { mrr?: number } | null | undefined): string {
  return value?.mrr === undefined ? '—' : value.mrr.toFixed(3)
}

/** 权重变化:`1.00 → 1.20`。 */
export const weightText = (row: Pick<WeightSuggestion, 'current' | 'suggested'>) => `${row.current.toFixed(2)} → ${row.suggested.toFixed(2)}`

/** 调整幅度:`+0.20` / `-0.05`。 */
export const deltaText = (delta: number) => `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`

/** 预演结果的概况一句话。 */
export function tuneSummary(result: Pick<TuneResult, 'feedback' | 'matched' | 'overall_rate'>): string {
  return `反馈 ${result.feedback} 条 · 能对上记录 ${result.matched} 条 · 全局有用率 ${percent(result.overall_rate)}`
}

/**
 * 应用之后的结果:回滚(得分下降)、已应用、没有变化。
 * 回滚要明说原因——“应用了但又撤回了”和“没应用”对用户是两回事。
 */
export function applyOutcome(result: TuneResult): { tone: 'danger' | 'success' | 'neutral'; label: string; detail: string } | null {
  if (result.applied === undefined) return null
  const score = `评测得分 ${mrrText(result.eval?.before)} → ${mrrText(result.eval?.after)}`
  if (result.rolled_back) return { tone: 'danger', label: '已回滚', detail: `应用后评测得分下降,已自动撤回。${score}` }
  if (result.applied) return { tone: 'success', label: '已应用', detail: `新权重已写入并立即生效。${score}` }
  return { tone: 'neutral', label: '没有变化', detail: '建议的权重与现在的一致。' }
}
