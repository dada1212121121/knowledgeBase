import { describe, expect, it } from 'vitest'
import {
  byFormat,
  casesOfFormat,
  compareRuns,
  degradedNote,
  deltaView,
  elapsedText,
  formatOf,
  incomparableNote,
  intervalText,
  invalidNote,
  isInvalidSet,
  metricHelp,
  missedCount,
  modeText,
  rerankText,
  optionalMs,
  optionalPercent,
  percentText,
  previousOf,
  rankView,
  samplingNote,
  trendLabels,
  trendOf,
  type EvalCase,
  type EvalRun,
} from './evalRuns'

const run = (over: Partial<EvalRun> = {}): EvalRun => ({ at: 1, run_id: 'ev_a', hit_at_1: 0.8, hit_at_k: 0.9, k: 5, mrr: 0.85, ...over })

describe('数字与文字', () => {
  it('百分比保留一位小数;缺失的数显示「—」而不是编一个', () => {
    expect(percentText(0.943)).toBe('94.3%')
    expect(percentText(1)).toBe('100.0%')
    expect(optionalPercent(undefined)).toBe('—')
    expect(optionalPercent(null)).toBe('—')
    expect(optionalPercent(0)).toBe('0.0%')
    expect(optionalMs(null)).toBe('—')
    expect(optionalMs(211.6)).toBe('212 毫秒')
  })

  it('等待时间:一分钟内写秒,之后写分秒', () => {
    expect(elapsedText(0)).toBe('0 秒')
    expect(elapsedText(12_900)).toBe('12 秒')
    expect(elapsedText(65_000)).toBe('1 分 05 秒')
    expect(elapsedText(-5)).toBe('0 秒')
  })

  it('检索方式用人话,不认识的原样显示,缺了显示「—」', () => {
    expect(modeText('fts')).toBe('只用关键词')
    expect(modeText('hybrid')).toBe('关键词 + 语义')
    expect(modeText('hybrid+rerank')).toBe('关键词 + 语义 + 重排')
    expect(modeText('future-mode')).toBe('future-mode')
    expect(modeText(undefined)).toBe('—')
  })
})

describe('指标说明', () => {
  it('每个指标有中文名和帮助文字,键名放在帮助文字里', () => {
    const help = metricHelp(5)
    expect(help.hit1.label).toBe('第 1 条命中率')
    expect(help.hit1.help).toContain('hit_at_1')
    expect(help.hitk.label).toBe('前 5 条命中率')
    expect(help.hitk.help).toContain('前 5 条')
    expect(help.mrr.help).toContain('mrr')
    expect(help.p95.help).toContain('p95_ms')
    expect(help.degraded.help).toContain('degraded_cases')
    // 标签里不出现英文指标名
    for (const item of Object.values(help)) expect(item.label).not.toMatch(/[A-Za-z]/)
  })

  it('「前几条」跟着返回条数变', () => {
    expect(metricHelp(10).hitk.label).toBe('前 10 条命中率')
    expect(metricHelp(3).hitk.help).toContain('前 3 条')
  })

  it('「只用了关键词的查询」说的是向量模型不可用,而不是重排不可用(后端口径)', () => {
    const { degraded } = metricHelp(5)
    expect(degraded.help).toContain('向量模型')
    expect(degraded.help).not.toContain('重排不可用')
  })
})

describe('和上一次比较', () => {
  it('逐项相减', () => {
    const deltas = compareRuns(run({ hit_at_1: 0.9, hit_at_k: 1, mrr: 0.9 }), run({ hit_at_1: 0.8, hit_at_k: 0.95, mrr: 0.8 }))!
    expect(deltas.hit1).toBeCloseTo(0.1)
    expect(deltas.hitk).toBeCloseTo(0.05)
    expect(deltas.mrr).toBeCloseTo(0.1)
  })

  it('两次返回条数不同就不给差值,并说明为什么不能比', () => {
    const current = run({ k: 10, hit_at_k: 1 })
    const previous = run({ k: 5, hit_at_k: 0.5 })
    expect(compareRuns(current, previous)).toBeNull()
    expect(incomparableNote(current, previous)).toContain('返回条数')
  })

  it('用例集指纹不同(黄金集改过 / 抽样不同)也不给差值', () => {
    const current = run({ set_hash: 'aaa' })
    const previous = run({ set_hash: 'bbb' })
    expect(compareRuns(current, previous)).toBeNull()
    expect(incomparableNote(current, previous)).toContain('同一批用例')
    // 指纹相同就照比
    expect(compareRuns(run({ set_hash: 'aaa', hit_at_1: 1 }), run({ set_hash: 'aaa', hit_at_1: 0.5 }))!.hit1).toBeCloseTo(0.5)
    // 老记录没有指纹:当作同一份黄金集,不能因为缺字段就永远不给比
    expect(incomparableNote(run({ set_hash: null }), run({ set_hash: null }))).toBeNull()
    expect(compareRuns(run({ hit_at_1: 0.9 }), run({ hit_at_1: 0.8 }))!.hit1).toBeCloseTo(0.1)
  })

  it('没有上一次就没有对比', () => {
    expect(compareRuns(run(), null)).toBeNull()
    expect(compareRuns(null, run())).toBeNull()
  })

  it('变化文字带正负号,不只靠颜色;小到四舍五入为 0 的算持平', () => {
    expect(deltaView(0.05, 'point')).toEqual({ text: '+5.0 个百分点', tone: 'up' })
    expect(deltaView(-0.0125, 'point')).toEqual({ text: '−1.3 个百分点', tone: 'down' })
    expect(deltaView(0.033, 'score')).toEqual({ text: '+0.033', tone: 'up' })
    expect(deltaView(-0.2, 'score')).toEqual({ text: '−0.200', tone: 'down' })
    expect(deltaView(0, 'point')).toEqual({ text: '持平', tone: 'flat' })
    expect(deltaView(0.0004, 'point')).toEqual({ text: '持平', tone: 'flat' })
  })

  it('「上一次」是展示的这一次在历史里的下一条;不在历史里就取历史最新一条', () => {
    const history = [run({ run_id: 'ev_3', at: 3 }), run({ run_id: 'ev_2', at: 2 }), run({ run_id: 'ev_1', at: 1 })]
    expect(previousOf(history[0]!, history)?.run_id).toBe('ev_2')
    expect(previousOf(history[1]!, history)?.run_id).toBe('ev_1')
    expect(previousOf(history[2]!, history)).toBeNull()
    expect(previousOf(run({ run_id: 'ev_new', at: undefined }), history)?.run_id).toBe('ev_3')
    expect(previousOf(null, history)).toBeNull()
    expect(previousOf(run({ run_id: 'ev_new' }), [])).toBeNull()
  })

  it('老记录没有运行 id 时按时间对', () => {
    const history = [run({ run_id: undefined, at: 30 }), run({ run_id: undefined, at: 20 })]
    expect(previousOf(history[0]!, history)?.at).toBe(20)
  })
})

describe('逐条结果与按格式拆分', () => {
  const cases: EvalCase[] = [
    { query: 'a', rank: 1, expect: 'docs/ARCH.md' },
    { query: 'b', rank: 2, expect: 'docs/README.MD' },
    { query: 'c', rank: null, expect: 'src/main.rs' },
    { query: 'd', rank: 1, expect: 'src/lib.rs' },
    { query: 'e', rank: 4, expect: null },
    { query: 'f', rank: 1 },
  ]

  it('格式取期望文件的扩展名并转小写;没有期望的归到「未标注」', () => {
    expect(formatOf({ expect: 'docs/README.MD' })).toBe('md')
    expect(formatOf({ expect: null })).toBe('未标注')
    expect(formatOf({})).toBe('未标注')
    expect(formatOf({ expect: 'Makefile' })).toBe('未标注')
    expect(formatOf({ expect: '.gitignore' })).toBe('未标注')
  })

  it('按格式算命中率和平均排名得分,用例多的排前面', () => {
    const stats = byFormat(cases)
    expect(stats.map((item) => item.name)).toEqual(['md', 'rs', '未标注'])
    const md = stats.find((item) => item.name === 'md')!
    expect(md).toMatchObject({ total: 2, hit: 2, hitRate: 1 })
    expect(md.mrr).toBeCloseTo((1 + 0.5) / 2)
    const rs = stats.find((item) => item.name === 'rs')!
    expect(rs).toMatchObject({ total: 2, hit: 1, hitRate: 0.5 })
    expect(rs.mrr).toBeCloseTo(0.5)
    const none = stats.find((item) => item.name === '未标注')!
    expect(none.total).toBe(2)
    expect(none.mrr).toBeCloseTo((0.25 + 1) / 2)
  })

  it('没有用例时不除以零', () => {
    expect(byFormat([])).toEqual([])
    expect(missedCount([])).toBe(0)
  })

  it('没找到的条数', () => {
    expect(missedCount(cases)).toBe(1)
  })

  it('名次徽标:文字就说明结果', () => {
    expect(rankView(null)).toEqual({ text: '没找到', tone: 'danger' })
    expect(rankView(1)).toEqual({ text: '第 1 位', tone: 'success' })
    expect(rankView(3)).toEqual({ text: '第 3 位', tone: 'warning' })
  })

  it('按格式筛选:全部 / 某个格式', () => {
    expect(casesOfFormat(cases, 'all')).toHaveLength(6)
    expect(casesOfFormat(cases, 'rs').map((item) => item.query)).toEqual(['c', 'd'])
    expect(casesOfFormat(cases, '未标注').map((item) => item.query)).toEqual(['e', 'f'])
    expect(casesOfFormat(cases, 'pdf')).toEqual([])
  })
})

describe('历次趋势与可信度', () => {
  it('趋势取最近 8 次,从旧到新', () => {
    const history = Array.from({ length: 10 }, (_, index) => run({ run_id: `ev_${10 - index}`, at: 10 - index }))
    const trend = trendOf(history)
    expect(trend).toHaveLength(8)
    expect(trend.map((item) => item.at)).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
    expect(trendOf([])).toEqual([])
  })

  it('有降级的查询就提醒不要当基线;没有就不说', () => {
    expect(degradedNote(run({ degraded_cases: 50 }))).toContain('50 条')
    expect(degradedNote(run({ degraded_cases: 50 }))).toContain('不要当作对比基线')
    expect(degradedNote(run({ degraded_cases: 0 }))).toBeNull()
    expect(degradedNote(run({ degraded_cases: undefined }))).toBeNull()
    expect(degradedNote(null)).toBeNull()
  })
})

describe('趋势图的横轴标签', () => {
  // 按站点时区(默认上海)构造瞬间,避免依赖运行环境 / 浏览器的时区
  const at = (month: number, day: number, hour: number, minute: number) => Date.UTC(2026, month - 1, day, hour - 8, minute)

  it('宽屏写「月-日 时:分」', () => {
    expect(trendLabels([run({ at: at(10, 20, 22, 42) })], false)).toEqual(['10-20 22:42'])
  })

  it('手机上日期各不相同就只写「月-日」', () => {
    const runs = [run({ at: at(10, 18, 0, 42) }), run({ at: at(10, 19, 0, 42) }), run({ at: at(10, 20, 22, 42) })]
    expect(trendLabels(runs, true)).toEqual(['10-18', '10-19', '10-20'])
  })

  it('同一天跑了多次,手机上改写「日 时:分」,每组仍然能区分', () => {
    const runs = [run({ at: at(10, 20, 0, 42) }), run({ at: at(10, 20, 22, 42) })]
    const labels = trendLabels(runs, true)
    expect(labels).toEqual(['20 00:42', '20 22:42'])
    expect(new Set(labels).size).toBe(2)
  })
})

describe('真实与随机:预检、抽样、区间', () => {
  it('预检剔除的用例要一条条说出来,并提醒数字的分母已经变了', () => {
    expect(invalidNote(run())).toBeNull()
    const text = invalidNote(
      run({
        invalid_cases: [
          { query: '分镜方案', kind: '集合不存在', detail: 'proj_devkit_docs' },
          { query: 'issue-list', kind: '期望的文件不在库里', detail: 'proj_x(期望 docs/qa/round1/issue-list.md)' },
        ],
      }),
    )!
    expect(text).toContain('2 条')
    expect(text).toContain('集合不存在')
    expect(text).toContain('分母')
  })

  it('一条能跑的用例都没有 = 没跑出数字', () => {
    expect(isInvalidSet(run({ status: 'invalid_set' }))).toBe(true)
    expect(isInvalidSet(run({ status: 'partial' }))).toBe(false)
    expect(isInvalidSet(null)).toBe(false)
  })

  it('抽样要说清抽了几条、种子是多少,提醒差一两个点不算退步', () => {
    expect(samplingNote(run())).toBeNull()
    const sampled = samplingNote(run({ seed: 42, sample: 7, pool: 30 }))!
    expect(sampled).toContain('30 条')
    expect(sampled).toContain('7 条')
    expect(sampled).toContain('42')
    expect(sampled).toContain('差一两个点')
    // 没抽样:全部跑,但顺序还是随机的,种子照样要说
    const full = samplingNote(run({ seed: 42, sample: null, pool: 30 }))!
    expect(full).toContain('全部跑')
    expect(full).toContain('42')
  })

  it('命中率的 95% 区间按百分比写;老记录没有就返回 null', () => {
    expect(intervalText(run())).toBeNull()
    expect(intervalText(run({ hit_at_k_ci95: [0.158, 0.75] }))).toBe('95% 区间 15.8%–75.0%')
  })
})
