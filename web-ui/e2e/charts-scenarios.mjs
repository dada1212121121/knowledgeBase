// 图表(环形图 / 折线图 / 横向条)的页面场景:由 viewer-shots.mjs 引入。
// 查什么:没有横向溢出;图的颜色在当前主题的所有表面上对比度 ≥ 3:1(轴文字 ≥ 4.5:1),量的是浏览器里真正算出来的颜色,
// 不是 CSS 源码;折线图按真实像素画、键盘能逐期查看、回落的点有标记;没有数据时不画空图。
// 色板本身的对比度由 src/styles/charts.spec.ts 对五个主题逐一算过,这里确认「渲染出来的确实是那个色板」。
import { NOW } from './fixture.mjs'
import { overflowIssues } from './admin-scenarios.mjs'

const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))
const paperTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'paper' }))
const explainOn = () => localStorage.setItem('kb.search.prefs', JSON.stringify({ rerank: true, explain: true, k: 10 }))
const DAY = 86_400_000
const squash = (text) => text.replace(/\s+/g, ' ').trim()

/**
 * 图上的色块对表面色的对比度。marks: [[选择器, 取哪个颜色(background | stroke | fill), 至少多少], …]。
 * 表面色取当前主题的 --bg-canvas / --bg-sidebar / --surface-1…3 / --surface-sunken,每个标记取在所有表面上的最差值。
 * 每个选择器至少要找到一个有颜色的元素,免得选择器写错了变成「什么都没量就通过」。
 */
async function contrastIssues(tab, marks) {
  return tab.evaluate((list) => {
    const hexRgb = (text) => {
      const match = text.trim().match(/^#([0-9a-f]{6})$/i)
      return match ? [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16)) : null
    }
    const lum = ([r, g, b]) => {
      const f = (value) => ((value /= 255) <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    const root = getComputedStyle(document.documentElement)
    const surfaces = ['bg-canvas', 'bg-sidebar', 'surface-1', 'surface-2', 'surface-3', 'surface-sunken'].map((name) => hexRgb(root.getPropertyValue(`--${name}`))).filter(Boolean)
    if (!surfaces.length) return ['读不到当前主题的表面色']
    const WHAT = { background: '底色', stroke: '线色', fill: '填充色' }
    const out = []
    for (const [selector, prop, need] of list) {
      const found = [...document.querySelectorAll(selector)]
      if (!found.length) {
        out.push(`${selector}:一个都没找到,没法量对比度`)
        continue
      }
      let worst = Infinity
      for (const el of found) {
        const style = getComputedStyle(el)
        const raw = prop === 'stroke' ? style.stroke : prop === 'fill' ? style.fill : style.backgroundColor
        const nums = raw.match(/[\d.]+/g)?.map(Number)
        if (!nums || nums.length < 3 || (nums.length > 3 && nums[3] === 0)) continue
        for (const surface of surfaces) worst = Math.min(worst, ratio(nums.slice(0, 3), surface))
      }
      if (worst === Infinity) out.push(`${selector}:找到了但都没有颜色可量`)
      else if (worst < need) out.push(`${selector} 的${WHAT[prop]}对比度最差 ${worst.toFixed(2)}:1(要求 ≥ ${need}:1)`)
    }
    return out
  }, marks)
}

const box = (tab, selector) => tab.locator(selector).first().boundingBox()

/** 两张卡的排布:宽屏并排(顶部对齐),窄屏上下排(左边对齐)。中间的宽度不查,那里由内容区宽度决定。 */
async function sideBySide(tab, size, first, second, label, breakpoint = 840) {
  const [a, b] = [await box(tab, first), await box(tab, second)]
  if (!a || !b) return [`${label}:找不到两张卡`]
  if (size.width >= breakpoint + 200) return Math.abs(a.y - b.y) > 2 ? [`${label}:宽屏上应并排,顶部差了 ${Math.round(Math.abs(a.y - b.y))}px`] : []
  if (size.width < breakpoint) return b.y < a.y + a.height - 1 ? [`${label}:窄屏上应上下排`] : []
  return []
}

/** 元素的盒子必须落在容器里(图例、条、提示气泡不能被挤出卡片)。 */
async function insideIssues(tab, innerSelector, outerSelector, label) {
  const [inner, outer] = [await box(tab, innerSelector), await box(tab, outerSelector)]
  if (!inner || !outer) return [`${label}:找不到元素`]
  const out = []
  if (inner.x < outer.x - 1 || inner.x + inner.width > outer.x + outer.width + 1) out.push(`${label}左右超出了卡片`)
  return out
}

const STORAGE_MARKS = [
  ['[data-testid=storage-charts] .kb-donut-arc', 'stroke', 3],
  ['[data-testid=storage-charts] .kb-donut-sw', 'background', 3],
  ['[data-testid=storage-charts] .kb-hbars-seg', 'background', 3],
  ['[data-testid=storage-charts] .kb-hbars-limit', 'background', 3],
]

async function storageAssert(tab, size) {
  const issues = [...(await overflowIssues(tab))]
  const legend = await tab.locator('[data-testid=storage-charts] .kb-donut-name').allInnerTexts()
  if (legend.join('|') !== '笔记|原件|向量索引|代理工作目录') issues.push(`占用构成的图例应是 笔记|原件|向量索引|代理工作目录,实际 ${legend.join('|')}`)
  const rows = tab.locator('[data-testid=storage-charts] .kb-hbars-row')
  if ((await rows.count()) !== 7) issues.push(`每人占用应有 7 行,实际 ${await rows.count()}`)
  const first = squash(await rows.first().locator('.kb-hbars-label').innerText())
  if (!first.startsWith('王五')) issues.push(`占用最多的王五应排第一,实际「${first}」`)
  const over = await tab.locator('[data-testid=storage-charts] .kb-hbars-row.is-over').count()
  if (over < 1) issues.push('夹具里张三超额,至少应有一行标成已超额')
  if (!(await tab.locator('[data-testid=storage-charts] .kb-hbars-limit').count())) issues.push('有存储上限的人应画出配额线')
  issues.push(...(await sideBySide(tab, size, '[data-testid=storage-charts] > .card:nth-child(1)', '[data-testid=storage-charts] > .card:nth-child(2)', '占用构成与每人占用')))
  issues.push(...(await insideIssues(tab, '[data-testid=storage-charts] .kb-donut', '[data-testid=storage-charts] > .card:nth-child(1)', '环形图')))
  issues.push(...(await insideIssues(tab, '[data-testid=storage-charts] .kb-hbars-list', '[data-testid=storage-charts] > .card:nth-child(2)', '每人占用的条')))
  issues.push(...(await contrastIssues(tab, STORAGE_MARKS)))
  return issues
}

// ---- 评测:四次记录,最新一次第 1 位命中率从 0.90 掉到 0.80(回落),耗时 212 比最早的 34 慢很多 ----
const evalRun = (daysAgo, hit1, hitK, p95, extra = {}) => ({
  at: NOW - daysAgo * DAY,
  run_id: `ev_${daysAgo}`,
  mode: 'hybrid',
  hit_at_1: hit1,
  hit_at_3: Math.min(1, hit1 + 0.04),
  hit_at_k: hitK,
  hit_at_10: Math.min(1, hitK + 0.02),
  k: 5,
  mrr: 0.8,
  p95_ms: p95,
  degraded_cases: 0,
  reranked_cases: 0,
  ...extra,
})
const RANKS = [1, 1, 1, 1, 2, 2, 3, 6, 14, null]
const evalCases = RANKS.map((rank, index) => ({ query: `查询 ${index + 1}`, rank, expect: `docs/f${index}.md` }))
const EVAL_RUNS = [
  evalRun(0, 0.8, 0.9, 212, { cases: evalCases }),
  evalRun(1, 0.9, 0.95, 208),
  evalRun(2, 0.85, 0.9, 120),
  evalRun(3, 0.7, 0.8, 34),
]

async function evalAssert(tab, size) {
  const issues = [...(await overflowIssues(tab))]
  const trend = tab.locator('[data-testid=eval-trend]')
  if (!(await trend.count())) return [...issues, '有 4 次记录,应出现命中率走势']
  if (!squash(await trend.innerText()).includes('1 次比上一次低')) issues.push('最新一次比上一次低,副标题应写「1 次比上一次低」')
  // 两条线在同一次回落,各有一个红圈
  if ((await trend.locator('svg.kb-line-svg .kb-line-flag').count()) !== 2) issues.push('第 1 位和前 5 条命中率在最新一次都回落,应各有一个红圈')
  if ((await trend.locator('.kb-sr li').count()) !== 4) issues.push('读屏文字应有 4 行(4 次记录)')
  if (await tab.locator('[data-testid=eval-insights] table').count()) issues.push('图表区不该出现 <table>(手机上会被全局样式拆散)')
  // 按真实像素画:svg 的宽度就是 viewBox 的宽度(不缩放),手机上轴文字才是 11px
  const geometry = await trend.evaluate((figure) => {
    const svg = figure.querySelector('svg.kb-line-svg')
    const tick = figure.querySelector('text.kb-line-tick')
    const view = svg.viewBox.baseVal
    return { drawn: Math.round(svg.getBoundingClientRect().width), view: Math.round(view.width), font: tick ? parseFloat(getComputedStyle(tick).fontSize) : 0 }
  })
  if (Math.abs(geometry.drawn - geometry.view) > 1) issues.push(`折线图被缩放了:画出来 ${geometry.drawn}px,viewBox ${geometry.view}px`)
  if (geometry.font < 11) issues.push(`轴文字只有 ${geometry.font}px,应 ≥ 11px`)
  // 键盘:聚焦停在最后一期,←移到前一期
  await trend.locator('figure.kb-line').focus()
  const last = squash(await trend.locator('.kb-line-tip-title').innerText())
  await tab.keyboard.press('ArrowLeft')
  const previous = squash(await trend.locator('.kb-line-tip-title').innerText())
  if (!last || last === previous) issues.push(`键盘 ← 应切到前一期,实际「${last}」→「${previous}」`)
  // 气泡必须真的看得见(display:none 的元素 innerText 照样有字,所以只比文字会漏掉「被样式藏掉」),并且不超出图的范围
  const tipBox = await trend.locator('.kb-line-tip').boundingBox()
  const figBox = await trend.locator('figure.kb-line').boundingBox()
  if (!tipBox || tipBox.width < 1) issues.push('键盘聚焦后提示气泡应看得见(手机上被全局样式藏掉过)')
  else if (figBox && (tipBox.x < figBox.x - 1 || tipBox.x + tipBox.width > figBox.x + figBox.width + 1)) issues.push('提示气泡超出了图的范围')
  const verdict = squash(await trend.locator('[data-testid=eval-trend-verdict]').innerText())
  if (!(await trend.locator('[data-testid=eval-trend-verdict]').isVisible()) || !verdict.includes('1 次比上一次低')) issues.push(`走势的结论应看得见:「${verdict}」`)
  await tab.keyboard.press('Escape')
  // 其它两张卡
  const latency = squash(await tab.locator('[data-testid=eval-latency]').innerText())
  if (!latency.includes('毫秒')) issues.push('耗时走势应带「毫秒」单位')
  if ((await tab.locator('[data-testid=eval-ranks] .kb-hbars-row').count()) !== 7) issues.push('名次分布应有 7 行')
  const missed = squash(await tab.locator('[data-testid=eval-ranks] .kb-hbars-row').nth(6).innerText())
  if (!missed.includes('没找到') || !missed.includes('1 条 · 10%')) issues.push(`10 条查询里 1 条没找到,最后一行应写「1 条 · 10%」,实际「${missed}」`)
  issues.push(...(await sideBySide(tab, size, '[data-testid=eval-trend]', '[data-testid=eval-latency]', '走势与耗时')))
  issues.push(...(await contrastIssues(tab, EVAL_MARKS)))
  return issues
}

const EVAL_MARKS = [
  ['[data-testid=eval-trend] path.kb-line-path', 'stroke', 3],
  ['[data-testid=eval-trend] path.kb-line-dot', 'fill', 3],
  ['[data-testid=eval-trend] .kb-line-flag', 'stroke', 3],
  ['[data-testid=eval-trend] text.kb-line-tick', 'fill', 4.5],
  ['[data-testid=eval-ranks] .kb-hbars-seg', 'background', 3],
]

async function jobsAssert(tab, size) {
  const issues = [...(await overflowIssues(tab))]
  // 总数读环中间的大字(可见):卡片标题旁的小字在平板和手机上被样式藏掉,读它会在手机上量不到
  // 数字会滚动:读目标值(data-value),不读滚到一半的文字
  const total = Number(await tab.locator('[data-testid=jobs-state-chart] .kb-donut-value .kb-countup').getAttribute('data-value'))
  const counts = (await tab.locator('[data-testid=jobs-state-chart] .kb-donut-num .kb-countup').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-value')))).map(Number)
  if (!total || counts.reduce((sum, n) => sum + n, 0) !== total) issues.push(`状态环形图各行数量之和(${counts.join('+')})应等于环中间的总数 ${total}`)
  if (!(await tab.locator('[data-testid=jobs-duration-chart] .kb-hbars-note').isVisible())) issues.push('用时分布下面的说明(中位数)应该看得见')
  const names = (await tab.locator('[data-testid=jobs-state-chart] .kb-donut-name').allInnerTexts()).join('|')
  if (/running|queued|failed|canceled|paused/.test(names)) issues.push(`状态名应是中文,实际 ${names}`)
  if ((await tab.locator('[data-testid=jobs-duration-chart] .kb-hbars-row').count()) !== 5) issues.push('完成任务用时应分五段')
  issues.push(...(await sideBySide(tab, size, '[data-testid=jobs-state-chart]', '[data-testid=jobs-duration-chart]', '任务状态与用时')))
  issues.push(...(await insideIssues(tab, '[data-testid=jobs-state-chart] .kb-donut', '[data-testid=jobs-state-chart]', '任务状态环形图')))
  issues.push(...(await contrastIssues(tab, [
    ['[data-testid=jobs-state-chart] .kb-donut-arc', 'stroke', 3],
    ['[data-testid=jobs-state-chart] .kb-donut-sw', 'background', 3],
    ['[data-testid=jobs-duration-chart] .kb-hbars-seg', 'background', 3],
  ])))
  return issues
}

async function searchAssert(tab) {
  const issues = [...(await overflowIssues(tab))]
  await tab.waitForSelector('[data-testid=explain-timings]', { state: 'attached', timeout: 10_000 }).catch(() => issues.push('打开查看排序依据后,右侧应出现各阶段耗时'))
  const rows = (await tab.locator('[data-testid=explain-timings] .kb-hbars-head').allInnerTexts()).map(squash)
  const expected = ['解析 / 前缀 0.3 ms', '嵌入 8.4 ms', 'BM25 (explain 额外) 3.8 ms', '向量 (explain 额外) 11.6 ms', 'RRF 融合 0.2 ms', '重排 24.9 ms']
  if (rows.join('|') !== expected.join('|')) issues.push(`耗时行应是 ${expected.join(' / ')},实际 ${rows.join(' / ')}`)
  if (!squash(await tab.locator('[data-testid=explain-timings]').innerText()).includes('不计入上面几项的总耗时')) issues.push('灰色的两项应有「不计入总耗时」的说明')
  // 额外两趟是中性灰,不是主色
  const paints = await tab.locator('[data-testid=explain-timings] .kb-hbars-seg').evaluateAll((list) => list.map((el) => getComputedStyle(el).backgroundColor))
  if (paints[2] !== paints[3] || paints[2] === paints[1]) issues.push('BM25 和向量应同为灰色,且与主链路的颜色不同')
  issues.push(...(await contrastIssues(tab, [['[data-testid=explain-timings] .kb-hbars-seg', 'background', 3]])))
  return issues
}

async function overviewAssert(tab) {
  const issues = [...(await overflowIssues(tab))]
  const card = tab.locator('[data-testid=share-donut]')
  const names = (await card.locator('.kb-donut-name').allInnerTexts()).map(squash)
  if (names.length < 2) issues.push(`项目占比至少应列出 2 个项目,实际 ${names.join('|')}`)
  if (names.some((name) => /^proj_|^p_/.test(name))) issues.push(`项目名应是可读的名字,不是内部 id:${names.join('|')}`)
  if (!(await card.locator('.kb-donut-value').innerText()).trim()) issues.push('环中间应有内容片段总数')
  issues.push(...(await insideIssues(tab, '[data-testid=share-donut] .kb-donut', '[data-testid=share-donut]', '项目占比环形图')))
  issues.push(...(await contrastIssues(tab, [
    ['[data-testid=share-donut] .kb-donut-arc', 'stroke', 3],
    ['[data-testid=share-donut] .kb-donut-sw', 'background', 3],
  ])))
  return issues
}

const PHONE_AND_DESKTOP = ['390x844', '1440x900']

/** 同一个页面换主题再看一遍:确认渲染出来的是那个主题的颜色(主题没生效时对比度检查会量到错的表面),并复用同一组断言。 */
function themed(base, init, theme) {
  return {
    ...base,
    sizes: PHONE_AND_DESKTOP,
    init,
    assert: async (tab, size) => {
      const issues = [...(await base.assert(tab, size))]
      const applied = await tab.evaluate(() => document.documentElement.getAttribute('data-theme'))
      if (applied !== theme) issues.push(`应是 ${theme} 主题,实际 ${applied}`)
      return issues
    },
  }
}

const STORAGE = { route: '/admin/usage', ready: '[data-testid=storage-charts] .kb-donut-row', settle: 700, assert: storageAssert }
const EVAL = { route: '/admin/eval', ready: '[data-testid=eval-trend]', fixture: { eval_history: { runs: EVAL_RUNS } }, settle: 800, assert: evalAssert }
const JOBS = { route: '/tasks', ready: '[data-testid=jobs-charts]', settle: 600, assert: jobsAssert }
const OVERVIEW = { route: '/admin/overview', ready: '[data-testid=share-donut]', settle: 700, assert: overviewAssert }

export const CHARTS_SCENARIOS = {
  'charts-storage': STORAGE,
  'charts-storage-light': themed(STORAGE, lightTheme, 'light'),
  'charts-storage-paper': themed(STORAGE, paperTheme, 'paper'),
  'charts-storage-empty': {
    // 一个人都没统计到:不画空图,只显示原来的空状态
    route: '/admin/usage',
    ready: '[data-testid=storage-panel]',
    fixture: { storage_overview: () => ({ disk: { free_gb: 100, reserve_gb: 10, paused: false, warn: false }, totals: { measured_spaces: 0, total_spaces: 0, total_bytes: 0, vectors_bytes: 0, oldest_measured_at: null }, top: [] }) },
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (await tab.locator('[data-testid=storage-charts]').count()) issues.push('没有任何统计结果时不该画图')
      return issues
    },
  },

  'charts-eval': EVAL,
  'charts-eval-light': themed(EVAL, lightTheme, 'light'),
  'charts-eval-paper': themed(EVAL, paperTheme, 'paper'),
  'charts-eval-single': {
    // 只有一次记录:画不出走势,但名次分布照常;不出现空图
    route: '/admin/eval',
    ready: '[data-testid=eval-ranks]',
    fixture: { eval_history: { runs: [EVAL_RUNS[0]] } },
    settle: 600,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (await tab.locator('[data-testid=eval-trend], [data-testid=eval-latency]').count()) issues.push('只有一次记录时不该画走势')
      if ((await tab.locator('[data-testid=eval-ranks] .kb-hbars-row').count()) !== 7) issues.push('名次分布应有 7 行')
      return issues
    },
  },

  'charts-jobs': JOBS,
  'charts-jobs-light': themed(JOBS, lightTheme, 'light'),
  'charts-jobs-empty': {
    route: '/tasks',
    ready: '[data-testid=jobs]',
    fixture: { job_list: { jobs: [] } },
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (await tab.locator('[data-testid=jobs-charts]').count()) issues.push('一个任务都没有时不该画图')
      return issues
    },
  },

  'charts-search-explain': { route: '/search?q=uds', ready: '.kb-hit', init: explainOn, settle: 600, assert: searchAssert },

  'charts-overview': OVERVIEW,
  'charts-overview-light': themed(OVERVIEW, lightTheme, 'light'),
  'charts-overview-reduced-motion': {
    // 系统设了「减少动效」:环形图不播入场动画(直接是画好的样子),而不是先隐藏再等一个不会来的动画
    ...OVERVIEW,
    sizes: PHONE_AND_DESKTOP,
    assert: async (tab, size) => {
      const issues = [...(await overviewAssert(tab, size))]
      await tab.emulateMedia({ reducedMotion: 'reduce' })
      const name = await tab.locator('[data-testid=share-donut] .kb-donut-svg').evaluate((el) => getComputedStyle(el).animationName)
      if (name !== 'none') issues.push(`减少动效时环形图不该有入场动画,实际 animation-name=${name}`)
      return issues
    },
  },
}
