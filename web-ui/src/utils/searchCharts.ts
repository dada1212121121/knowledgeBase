// 搜索 Explain 面板的各阶段耗时:整理成横向条要的行。
// 注意口径:BM25 和向量这两项是打开 explain 之后后端「额外多跑的两趟」(多个集合会累加),
// 不是主链路里的阶段,所以不能和其它几项当成一条串行流水线去加总;图里给它们中性灰,并在面板上写明。
import type { HBarRow } from '@kb-ui/index'
import type { SearchResponse } from '@/api/client'

export interface TimingRow extends HBarRow {
  /** true = explain 额外多跑的那一趟,不计入主链路 */
  extra: boolean
}

export function timingRows(timings: SearchResponse['timings']): TimingRow[] {
  if (!timings) return []
  const stages: { key: string; name: string; ms: number; extra: boolean }[] = [
    { key: 'parse', name: '解析 / 前缀', ms: timings.parse_ms, extra: false },
    { key: 'embed', name: '嵌入', ms: timings.embed_ms, extra: false },
    { key: 'fts', name: 'BM25 (explain 额外)', ms: timings.fts_ms, extra: true },
    { key: 'vector', name: '向量 (explain 额外)', ms: timings.vector_ms, extra: true },
    { key: 'fuse', name: 'RRF 融合', ms: timings.fuse_ms, extra: false },
    { key: 'rerank', name: '重排', ms: timings.rerank_ms, extra: false },
  ]
  return stages.map((stage) => ({
    key: stage.key,
    label: stage.name,
    extra: stage.extra,
    // 缺字段或不是数字的按 0 画,但文字照写,不假装没有这一项
    segments: [{ name: stage.name, value: Number.isFinite(stage.ms) ? Math.max(0, stage.ms) : 0, color: stage.extra ? 'var(--viz-other)' : 'var(--viz-1)' }],
    totalText: `${(Number.isFinite(stage.ms) ? stage.ms : 0).toFixed(1)} ms`,
  }))
}

/** 面板上要不要写那句「额外两趟不计入主链路」:只有这两项里确实有耗时才写。 */
export const hasExtraTimings = (rows: TimingRow[]): boolean => rows.some((row) => row.extra && (row.segments[0]?.value ?? 0) > 0)
