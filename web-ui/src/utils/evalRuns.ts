import { stampText } from './time'
// 评测页的纯逻辑:指标的人话解释、和上一次比较、按文件格式拆分、历次趋势。
//
// 评测 = 拿一份「查询 → 应该命中哪个文件」的清单(黄金集)逐条搜索,记下正确文件排第几。
// 指标的算法以 crates/kb-cli/src/commands/eval.rs 为准:
//   hit@1 = 排第 1 的占比;hit@k = 排在前 k 的占比;MRR = 每条取 1/名次(没找到取 0)再平均;
//   degraded_cases = 向量模型不可用、只能退回关键词检索的条数(重排不可用不算降级);
//   p95_ms = 95% 的查询在这个毫秒数内完成。

export interface EvalCase {
  query: string
  rank: number | null
  expect?: string | null
}

/** 预检挑出来的无效用例:collection 或期望的文件不在库里时,检索再好也只会记「未命中」。 */
export interface EvalIssue {
  query: string
  kind: string
  detail: string
}

/** 一次评测的结果。`eval_run` 的返回没有 `at`,`eval_history` 的每条都有。 */
export interface EvalRun {
  at?: number
  run_id?: string
  mode?: string | null
  hit_at_1: number
  hit_at_k: number
  /** 前 k 条命中率的 95% 置信区间(Wilson),样本小的时候区间很宽,这本身就是信息 */
  hit_at_k_ci95?: [number, number] | null
  hit_at_3?: number | null
  hit_at_10?: number | null
  k: number
  mrr: number
  p95_ms?: number | null
  degraded_cases?: number | null
  reranked_cases?: number | null
  /** 这次要的是重排还是关掉:on / off / auto(老记录没有这一项) */
  rerank?: string | null
  cases?: EvalCase[] | null
  /** ok / partial(剔过无效用例)/ invalid_set(一条能跑的都没有);老记录没有这一项 */
  status?: string | null
  /** 这一跑用的是哪份黄金集(只有文件名,不含路径);老记录没有这一项 */
  set?: string | null
  /** 这一批用例的指纹:两次只有指纹相同才谈得上谁高谁低 */
  set_hash?: string | null
  /** 本次的随机种子,填回去可复现同一批用例 */
  seed?: number | null
  /** 从黄金集里抽了多少条(没抽样是 null) */
  sample?: number | null
  /** 黄金集总条数 */
  pool?: number | null
  /** 真正参与计算的用例数 */
  valid_cases?: number | null
  /** 被预检剔除的用例 */
  invalid_cases?: EvalIssue[] | null
}

// ---------------------------------------------------------------- 数字格式

/** 0.943 → 94.3%。样本只有几十条,差一条就是 1–2 个百分点,所以保留一位小数。 */
export const percentText = (value: number, digits = 1): string => `${(value * 100).toFixed(digits)}%`

/** 历史里可能缺 hit@3 / hit@10 / p95(老记录),缺了显示「—」,不编数字。 */
export const optionalPercent = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : percentText(value))
export const optionalMs = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : `${Math.round(value)} 毫秒`)

export const scoreText = (value: number): string => value.toFixed(3)

/** 运行 id 里的时间戳显示成「月-日 时:分」。 */
export function stamp(at: number | undefined): string {
  return at ? stampText(at) : '—'
}

/** 评测在等的时候显示「已用多久」。 */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

// ---------------------------------------------------------------- 检索方式

const MODE_TEXT: Record<string, string> = {
  fts: '只用关键词',
  hybrid: '关键词 + 语义',
  'hybrid+rerank': '关键词 + 语义 + 重排',
}

/** 「模式」列:后端给的是 fts / hybrid / hybrid+rerank,界面上写人话;不认识的原样显示,缺了显示「—」。 */
export const modeText = (mode: string | null | undefined): string => (mode ? (MODE_TEXT[mode] ?? mode) : '—')

const RERANK_TEXT: Record<string, string> = {
  on: '强制开',
  off: '强制关',
  auto: '按配置',
}

/**
 * 这次评测的重排情况。
 *
 * 「按配置」但实际一条都没重排,说明重排器没装好:光看模式列会以为重排跑过了,
 * 所以这里把「要了什么」和「真跑了几条」一起说。
 */
export function rerankText(run: EvalRun): string {
  const asked = run.rerank ? (RERANK_TEXT[run.rerank] ?? run.rerank) : '未记录'
  const ran = run.reranked_cases
  if (ran === null || ran === undefined) return asked
  if (ran === 0) return `${asked},一条都没重排`
  return `${asked},实际重排 ${ran} 条`
}

// ---------------------------------------------------------------- 指标说明

export interface MetricHelp {
  /** 中文名,当标签用 */
  label: string
  /** 一句帮助文字,键名放在括号里 */
  help: string
}

/** 四张指标卡和历次结果表的列用同一份说明,避免两处各说各话。`k` 是这次评测取的前几条。 */
export function metricHelp(k: number): Record<'hit1' | 'hitk' | 'hit3' | 'hit10' | 'mrr' | 'p95' | 'degraded', MetricHelp> {
  return {
    hit1: { label: '第 1 条命中率', help: '正确文件排在第 1 位的查询占比(hit_at_1)。越高越好。' },
    hitk: { label: `前 ${k} 条命中率`, help: `正确文件出现在前 ${k} 条结果里的查询占比(hit_at_k)。这里的 k 就是页面上的「返回条数」。` },
    hit3: { label: '前 3 条命中率', help: '正确文件出现在前 3 条结果里的查询占比(hit_at_3)。' },
    hit10: { label: '前 10 条命中率', help: '正确文件出现在前 10 条结果里的查询占比(hit_at_10)。' },
    mrr: { label: '平均排名得分', help: '正确文件排第 1 得 1 分,第 2 得 0.5 分,第 3 得 0.33 分,没找到得 0,再取平均(mrr)。满分 1。' },
    p95: { label: '慢查询耗时', help: '95% 的查询在这个时间内完成(p95_ms),单位毫秒。' },
    degraded: { label: '只用了关键词的查询', help: '向量模型当时不可用、退回只用关键词检索的查询条数(degraded_cases)。不是 0 的话,这次的数字不要当作对比基线。' },
  }
}

// ---------------------------------------------------------------- 和上一次比较

export interface Deltas {
  hit1: number
  hitk: number
  mrr: number
}

/**
 * 两次为什么不能直接比:返回一句话说明,能比时返回 null。
 *
 * 比命中率的前提是「同一道题」:返回条数(k)一样、用例集指纹一样。
 * 黄金集改过 / 抽样抽到另一批,差的那几个点是用例的差,不是检索的差。
 */
export function incomparableNote(current: EvalRun | null, previous: EvalRun | null): string | null {
  if (!current || !previous) return null
  if (current.k !== previous.k) return `上一次的「返回条数」是 ${previous.k},这次是 ${current.k},命中率不能直接比。`
  const before = current.set_hash ?? null
  const after = previous.set_hash ?? null
  // 老记录没有指纹:当作可比(那时候还没有随机抽样,用例集是同一份文件)
  if (before && after && before !== after) return '上一次跑的不是同一批用例(黄金集改过或随机抽样不同),两次命中率不能直接比。'
  return null
}

/** 数值差:不能比时返回 null,页面就不显示「↑/↓」徽章,而不是拿两个不同的题算差。 */
export function compareRuns(current: EvalRun | null, previous: EvalRun | null): Deltas | null {
  if (!current || !previous) return null
  if (incomparableNote(current, previous)) return null
  return {
    hit1: current.hit_at_1 - previous.hit_at_1,
    hitk: current.hit_at_k - previous.hit_at_k,
    mrr: current.mrr - previous.mrr,
  }
}

/**
 * 「上一次」是哪次。展示的这一次在历史里就取它后面那条;不在历史里(刚跑完但历史没写进去)就取历史最新一条。
 * 用运行 id 对,没有 id 的老记录退回比时间。
 */
export function previousOf(shown: EvalRun | null, history: EvalRun[]): EvalRun | null {
  if (!shown) return null
  const index = history.findIndex((item) => (shown.run_id && item.run_id ? item.run_id === shown.run_id : item.at !== undefined && item.at === shown.at))
  return index >= 0 ? (history[index + 1] ?? null) : (history[0] ?? null)
}

export interface DeltaView {
  /** 带正负号的文字:+5.0 个百分点 / −0.033 / 持平。颜色之外,正负号和文字也说明方向 */
  text: string
  tone: 'up' | 'down' | 'flat'
}

/** `unit` = 'point' 时 value 是 0–1 的比例,按「个百分点」显示;'score' 时直接显示三位小数。 */
export function deltaView(value: number, unit: 'point' | 'score'): DeltaView {
  const scaled = unit === 'point' ? value * 100 : value
  const digits = unit === 'point' ? 1 : 3
  const rounded = Number(scaled.toFixed(digits))
  if (rounded === 0) return { text: '持平', tone: 'flat' }
  const sign = rounded > 0 ? '+' : '−'
  const body = Math.abs(rounded).toFixed(digits)
  return { text: unit === 'point' ? `${sign}${body} 个百分点` : `${sign}${body}`, tone: rounded > 0 ? 'up' : 'down' }
}

// ---------------------------------------------------------------- 逐条结果

/** 期望源文件的扩展名,没有期望时归到「未标注」。 */
export function formatOf(item: Pick<EvalCase, 'expect'>): string {
  const source = item.expect ?? ''
  const dot = source.lastIndexOf('.')
  return dot > 0 ? source.slice(dot + 1).toLowerCase() : '未标注'
}

export interface FormatStat {
  name: string
  total: number
  hit: number
  /** 该格式下找到了正确文件的占比(评测时只取前 k 条,所以「找到」就是排进了前 k) */
  hitRate: number
  /** 该格式下的平均排名得分 */
  mrr: number
}

/** 按期望文件的格式聚合;用例最多的格式排前面,一样多按名字排,顺序稳定。 */
export function byFormat(cases: EvalCase[]): FormatStat[] {
  const buckets = new Map<string, { total: number; hit: number; rankSum: number }>()
  for (const item of cases) {
    const key = formatOf(item)
    const bucket = buckets.get(key) ?? { total: 0, hit: 0, rankSum: 0 }
    bucket.total += 1
    if (item.rank !== null) {
      bucket.hit += 1
      bucket.rankSum += 1 / item.rank
    }
    buckets.set(key, bucket)
  }
  return [...buckets.entries()]
    .map(([name, bucket]) => ({
      name,
      total: bucket.total,
      hit: bucket.hit,
      hitRate: bucket.hit / Math.max(1, bucket.total),
      mrr: bucket.rankSum / Math.max(1, bucket.total),
    }))
    .sort((left, right) => right.total - left.total || left.name.localeCompare(right.name))
}

export const missedCount = (cases: EvalCase[]): number => cases.filter((item) => item.rank === null).length

export interface RankView {
  text: string
  tone: 'success' | 'warning' | 'danger'
}

/** 名次徽标:第 1 绿、其余黄、没找到红;文字本身就说明结果,不只靠颜色。 */
export function rankView(rank: number | null): RankView {
  if (rank === null) return { text: '没找到', tone: 'danger' }
  return { text: `第 ${rank} 位`, tone: rank === 1 ? 'success' : 'warning' }
}

/** 逐条结果按格式筛。 */
export const casesOfFormat = (cases: EvalCase[], format: string): EvalCase[] => (format === 'all' ? cases : cases.filter((item) => formatOf(item) === format))

// ---------------------------------------------------------------- 历次趋势

/** 趋势图要的:最近 `limit` 次,时间从旧到新。 */
export const trendOf = (history: EvalRun[], limit = 8): EvalRun[] => [...history].reverse().slice(-limit)

/** 这次结果的可信度提示(有降级就提醒不要当基线);没有降级返回 null。 */
export function degradedNote(run: Pick<EvalRun, 'degraded_cases'> | null): string | null {
  const count = run?.degraded_cases ?? 0
  return count > 0 ? `有 ${count} 条查询当时只能用关键词检索(向量模型不可用),这次的数字不要当作对比基线。` : null
}

/** 一条能跑的用例都没有:这次不算评测,不下任何结论。 */
export const isInvalidSet = (run: Pick<EvalRun, 'status'> | null): boolean => run?.status === 'invalid_set'

/**
 * 预检剔掉的用例。这些用例不管检索多好都只会记「未命中」,留在分母里就是把命中率往下拉——
 * 历史上那次 42.9% 有一半是黄金集过期,不是检索退步。
 */
export function invalidNote(run: Pick<EvalRun, 'invalid_cases'> | null): string | null {
  const issues = run?.invalid_cases ?? []
  if (!issues.length) return null
  const head = issues
    .slice(0, 3)
    .map((item) => `「${item.query}」${item.kind}`)
    .join('、')
  const more = issues.length > 3 ? ` 等 ${issues.length} 条` : ''
  return `黄金集里有 ${issues.length} 条用例对不上库(${head}${more}),已从分母里剔除,没有算进命中率。修好 eval/golden.toml 里的集合名或文件路径再跑一次,数字才算数。`
}

/** 抽样/打乱是怎么做的:告诉读的人「换一次 seed 数字会动」,也告诉怎么复现这一批。 */
export function samplingNote(run: Pick<EvalRun, 'seed' | 'sample' | 'pool'> | null): string | null {
  if (!run || run.seed === undefined || run.seed === null) return null
  const pool = run.pool ?? 0
  if (run.sample !== undefined && run.sample !== null && pool > run.sample) {
    return `本次从 ${pool} 条用例里随机抽了 ${run.sample} 条(seed ${run.seed})。再跑一次就是另一批用例,命中率会跟着动——差一两个点不必当成退步。`
  }
  return `${pool} 条用例全部跑,顺序按 seed ${run.seed} 随机打乱。想复现这一批,把 seed 填回去再跑。`
}

/** 命中率的 95% 区间:0–1 的比例,页面按百分比写。 */
export function intervalText(run: Pick<EvalRun, 'hit_at_k_ci95'> | null): string | null {
  const interval = run?.hit_at_k_ci95
  if (!interval || interval.length !== 2) return null
  return `95% 区间 ${percentText(interval[0])}–${percentText(interval[1])}`
}

// ---------------------------------------------------------------- 趋势图的横轴标签

/**
 * 趋势图每组柱子下面的标签。手机上一组只有 40–50px 宽,「10-20 22:42」会被截断成看不出是哪次:
 * 紧凑模式下,日期都不同就只写「月-日」,同一天跑了多次就写「日 时:分」。
 */
export function trendLabels(runs: EvalRun[], compact: boolean): string[] {
  if (!compact) return runs.map((run) => stamp(run.at))
  const days = runs.map((run) => stamp(run.at).slice(0, 5))
  if (new Set(days).size === days.length) return days
  return runs.map((run) => {
    const text = stamp(run.at)
    return `${text.slice(3, 5)} ${text.slice(6)}`
  })
}
