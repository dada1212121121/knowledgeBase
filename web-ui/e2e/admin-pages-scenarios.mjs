// 管理组三页整理的页面场景:评测、系统状态、项目与集合(项目卡片 + 集合表)。
// 经 viewer-shots.mjs 引入;默认跑 core 五个尺寸(手机 390×844、平板 820×1180 / 1180×820、电脑 1440×900、宽屏 1920×1080),
// KB_ENGINE=webkit 换引擎。每页都有 正常 / 空 / 报错(可重试)/ 无权限 / 手机卡片 / 浅色主题 / AI 关闭 的场景。
//
// 「读不到」类场景用 failing+heal:失败由开关控制而不是数次数——外壳(侧栏、顶栏)和别的区块也会读同一批接口,
// 数次数会被它们抢走,场景就时灵时不灵。点「重试」之前先 heal,重试才会成功。
import { ALL_FEATURES, adminMe, ingestStory, NOW, projectsStory } from './fixture.mjs'
import { meWithout, overflowIssues } from './admin-scenarios.mjs'
import { smallTargets } from './share-scenarios.mjs'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))
/** AI 总开关关闭的账号:没有 ai.* 与深度检索功能,ai_enabled = false */
const aiOffMe = { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('ai.') && id !== 'search.deep'), false) }
const isPhone = (size) => size.width < 600
const bodyText = (tab) => tab.evaluate(() => document.body.innerText)
const normalize = (text) => text.replace(/\s+/g, ' ')

/** 界面上不该出现的英文术语(术语表 / 产品要求)。键名只能出现在帮助文字里,而且是 snake_case,不会命中这些;
 *  insight 不查:集合名(knowledgeBase/insights)是数据,不是界面文字。 */
const TECH_WORDS = /\b(token|tokens|rerank|top-k|explain|embedding|dry-run|collection|MRR)\b|\bLLM\b|hit@/
function techIssues(text, where) {
  const hit = text.match(TECH_WORDS)
  return hit ? [`${where}里出现了不该露的英文术语「${hit[0]}」`] : []
}
/** AI 关闭后页面任何位置不出现「AI」字样(含侧栏、顶栏) */
function aiWordIssues(text, where) {
  return /\bAI\b/.test(text) ? [`${where}:AI 已关闭,页面上不该出现「AI」字样`] : []
}

async function coarse(tab) {
  return tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
}
/** 触屏上这些控件的可点区域要 ≥ 44px(见 share-scenarios 的 smallTargets) */
async function touchIssues(tab, selector) {
  if (!(await coarse(tab))) return []
  return (await smallTargets(tab, selector)).map((item) => `触屏可点区域不足 44px:${item}`)
}
/** 等一个弹层升起来(约 0.3 秒进场动画):连续两次量到的顶部位置一样才算稳定 */
async function settled(tab, selector) {
  await tab.evaluate(() => void (window.__settledTop = undefined))
  await tab.waitForFunction(
    (sel) => {
      const top = document.querySelector(sel)?.getBoundingClientRect().top
      const last = window.__settledTop
      window.__settledTop = top
      return top !== undefined && top === last
    },
    selector,
    { polling: 120 },
  )
}
async function inViewport(tab, selector, size, what) {
  const box = await tab.locator(selector).first().boundingBox()
  if (!box) return [`${what}不可见`]
  const out = []
  if (box.x < -1 || box.x + box.width > size.width + 1) out.push(`${what}左右超出屏幕:x=${Math.round(box.x)} w=${Math.round(box.width)}`)
  if (box.y < -1 || box.y + box.height > size.height + 1) out.push(`${what}上下超出屏幕:y=${Math.round(box.y)} h=${Math.round(box.height)}`)
  return out
}

// ---------------------------------------------------------------- 可控的失败与延迟

const switches = new WeakMap()
/**
 * 让某个能力在开关打开时返回错误。`initial: false` 表示一开始正常,场景里 breakIt 之后才失败。
 * 返回给 fixture 的 `__after` 用(每个浏览器上下文调用一次)。
 */
function failing(name, { status = 503, message = '服务暂时不可用', initial = true } = {}) {
  return async (context) => {
    const state = { fail: initial }
    switches.set(context, { ...(switches.get(context) ?? {}), [name]: state })
    await context.route(new RegExp(`/capabilities/${name}(\\?|$)`), (route) => {
      if (!state.fail) return route.fallback()
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: status === 403 ? 'forbidden' : 'internal', message } }) })
    })
  }
}
const heal = (tab, name) => void (switches.get(tab.context())[name].fail = false)
const breakIt = (tab, name) => void (switches.get(tab.context())[name].fail = true)

const gates = new WeakMap()
/** 把某个能力的响应挂起,直到场景调用 release;用来停在「运行中」的状态上做断言 */
function gated(name) {
  return async (context) => {
    let release
    const promise = new Promise((resolve) => (release = resolve))
    gates.set(context, release)
    await context.route(new RegExp(`/capabilities/${name}(\\?|$)`), async (route) => {
      await promise
      await route.fallback()
    })
  }
}
const release = (tab) => gates.get(tab.context())()
const together = (...hooks) => async (context) => {
  for (const hook of hooks) await hook(context)
}

// ================================================================ 评测

const evalRun = (id, hoursAgo, over = {}) => ({
  at: NOW - hoursAgo * HOUR,
  run_id: id,
  mode: 'hybrid+rerank',
  hit_at_1: 0.9,
  hit_at_3: 0.94,
  hit_at_k: 0.96,
  hit_at_10: 0.98,
  k: 5,
  mrr: 0.927,
  p95_ms: 212,
  degraded_cases: 0,
  reranked_cases: 50,
  ...over,
})
const EVAL_CASES = [
  { query: '双哈希增量索引怎么做', rank: 1, expect: 'docs/ARCHITECTURE.md' },
  { query: 'UDS 断线后命令行怎么降级', rank: 1, expect: 'crates/kb-cli/src/client.rs' },
  { query: '一个特别特别长的查询,用来检查手机上换行之后卡片不会被撑出屏幕,也不会把名次徽标挤成竖排', rank: 2, expect: 'docs/MULTI_USER_ADMIN.md' },
  { query: '迁移断点续跑', rank: null, expect: 'docs/ARCHITECTURE.md' },
  { query: '备份校验怎么做', rank: 1, expect: 'docs/BACKUP_RESTORE.md' },
  { query: '会话 hook 怎么配置', rank: 3, expect: 'README.md' },
  { query: '嵌入模型缓存放哪', rank: 1, expect: 'config.toml' },
  { query: '没有标注期望文件的查询', rank: 4 },
]
const EVAL_RUNS = [
  evalRun('ev_0k7x2a', 2, { cases: EVAL_CASES }),
  evalRun('ev_0k6t91', 26, { mode: 'hybrid', hit_at_1: 0.85, hit_at_3: 0.9, hit_at_k: 0.97, hit_at_10: 0.97, mrr: 0.894, p95_ms: 208 }),
  evalRun('ev_0k5p04', 50, { mode: 'fts', hit_at_1: 0.62, hit_at_3: 0.7, hit_at_k: 0.78, hit_at_10: 0.85, mrr: 0.72, p95_ms: 19, degraded_cases: 50, reranked_cases: 0 }),
]
const evalFixture = { eval_history: { runs: EVAL_RUNS } }
const EVAL_METRIC_LABELS = ['第 1 条命中率', '前 5 条命中率', '平均排名得分', '只用了关键词的查询']

const historyItems = (tab) => tab.locator('[data-testid=eval-history] [data-testid=rt-row], [data-testid=eval-history] [data-testid=rt-card]')
const caseItems = (tab) => tab.locator('[data-testid=eval-cases] [data-testid=rt-row], [data-testid=eval-cases] [data-testid=rt-card]')

export const ADMIN_PAGES_SCENARIOS = {
  'admin-eval': {
    // 评测 · 正常:四个指标是中文标签 + 帮助文字,和上一次的对比带正负号,历次结果与逐条结果手机上是卡片,可按文件格式筛选
    route: '/admin/eval',
    ready: '[data-testid=eval-metrics]',
    fixture: evalFixture,
    settle: 600,
    assert: async (tab, size) => {
      const issues = [...(await overflowIssues(tab))]
      const labels = (await tab.locator('[data-testid=eval-metrics] .metric .k').allInnerTexts()).map((item) => item.trim())
      if (labels.join('|') !== EVAL_METRIC_LABELS.join('|')) issues.push(`指标标签应是 ${EVAL_METRIC_LABELS.join(' / ')},实际 ${labels.join(' / ')}`)
      const first = normalize(await tab.locator('[data-testid=metric-hit1]').innerText())
      if (!first.includes('90.0%') || !first.includes('+5.0 个百分点') || !first.includes('hit_at_1')) issues.push(`第 1 条命中率卡应有 90.0% / +5.0 个百分点 / 帮助文字里的键名,实际「${first}」`)
      const second = normalize(await tab.locator('[data-testid=metric-hitk]').innerText())
      if (!second.includes('−1.0 个百分点')) issues.push(`前 5 条命中率比上次低 1 个百分点,应写「−1.0 个百分点」,实际「${second}」`)
      const phone = isPhone(size)
      const cards = await tab.locator('[data-testid=eval-history] [data-testid=rt-card]').count()
      const rows = await tab.locator('[data-testid=eval-history] [data-testid=rt-row]').count()
      if (phone && (cards !== 3 || rows !== 0)) issues.push(`手机上历次结果应是 3 张卡片,实际卡片 ${cards} 行 ${rows}`)
      if (!phone && (rows !== 3 || cards !== 0)) issues.push(`平板 / 电脑上历次结果应是 3 行表格,实际行 ${rows} 卡片 ${cards}`)
      if ((await caseItems(tab).count()) !== 8) issues.push(`逐条结果应有 8 条,实际 ${await caseItems(tab).count()}`)
      if (!normalize(await tab.locator('[data-testid=eval-meta]').innerText()).includes('关键词 + 语义 + 重排')) issues.push('检索方式应写成人话「关键词 + 语义 + 重排」')
      issues.push(...techIssues(await bodyText(tab), '评测页'))
      // 名次徽标不被长查询挤成竖排:徽标只占一行
      const wrapped = await tab.evaluate(() =>
        [...document.querySelectorAll('.kb-ev-rank')].filter((el) => {
          const range = document.createRange()
          range.selectNodeContents(el)
          return range.getClientRects().length > 1
        }).length,
      )
      if (wrapped) issues.push(`${wrapped} 个名次徽标被挤成了多行`)
      // 图:先是历次趋势,可以切到按文件格式
      if (!(await tab.locator('[data-testid=eval-chart]').innerText()).includes('历次趋势')) issues.push('图应先显示「历次趋势」')
      await tab.locator('[data-testid=eval-chart] [role=tab]', { hasText: '按文件格式' }).click()
      const groups = await tab.locator('[data-testid=eval-chart] .kb-gbars-label').allInnerTexts()
      if (groups[0] !== 'md') issues.push(`按文件格式拆分,用例最多的 md 应排第一,实际 ${groups.join(',')}`)
      // 按文件格式筛选逐条结果
      await tab.getByRole('button', { name: '按文件格式筛选' }).click()
      await tab.getByRole('option', { name: /^md/ }).click()
      if ((await caseItems(tab).count()) !== 5) issues.push(`筛选 md 后应剩 5 条,实际 ${await caseItems(tab).count()}`)
      // 运行参数(抽样条数 / 随机种子 / 换一批用例)必须一眼能看到,手机上也要够大好点
      for (const id of ['eval-sample', 'eval-seed', 'eval-reroll']) {
        if (!(await tab.locator(`[data-testid=${id}]`).count())) issues.push(`缺了运行参数里的 ${id}`)
      }
      if (!normalize(await bodyText(tab)).includes('换一批用例')) issues.push('应说明「换一批用例」是干什么的')
      issues.push(...(await touchIssues(tab, '.kb-ph-actions button, [data-testid=eval-cases] button, [data-testid=eval-chart] [role=tab], [data-testid=eval-sample], [data-testid=eval-seed], [data-testid=eval-reroll]')))
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'admin-eval-partial': {
    // 评测 · 剔过无效用例、且和上一次不是同一批用例:分母变了要说清,不可比就不给 ↑↓ 徽标
    route: '/admin/eval',
    ready: '[data-testid=eval-metrics]',
    fixture: {
      eval_history: {
        runs: [
          evalRun('ev_part', 1, {
            status: 'partial',
            pool: 9,
            seed: 42,
            sample: 6,
            set_hash: 'aaa',
            invalid_cases: [{ query: '分镜方案', kind: '集合不存在', detail: 'proj_devkit_docs' }],
            cases: EVAL_CASES,
          }),
          evalRun('ev_prev', 26, { set_hash: 'bbb' }),
        ],
      },
    },
    settle: 600,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const invalid = normalize(await tab.locator('[data-testid=eval-invalid]').innerText())
      if (!invalid.includes('1 条') || !invalid.includes('已从分母里剔除')) issues.push(`应说清剔除了几条与后果,实际「${invalid}」`)
      const incomparable = normalize(await tab.locator('[data-testid=eval-incomparable]').innerText())
      if (!incomparable.includes('同一批用例')) issues.push(`用例集不同应说明为什么不能比,实际「${incomparable}」`)
      const sampling = normalize(await tab.locator('[data-testid=eval-sampling]').innerText())
      if (!sampling.includes('9') || !sampling.includes('6') || !sampling.includes('42')) issues.push(`抽样说明应写清池子 / 抽了几条 / seed,实际「${sampling}」`)
      if (await tab.locator('.kb-ev-delta').count()) issues.push('不是同一批用例时不该给 ↑↓ 徽标')
      if (!(await tab.locator('[data-testid=metric-hit1] .v').count())) issues.push('结果本身还是要显示')
      issues.push(...techIssues(await bodyText(tab), '评测页'))
      return issues
    },
  },

  'admin-eval-empty': {
    // 评测 · 没跑过:一句说明 + 一个「运行评测」,不画空的指标和空表
    route: '/admin/eval',
    ready: '[data-testid=eval-empty]',
    fixture: { eval_history: { runs: [] } },
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = normalize(await tab.locator('[data-testid=eval-empty]').innerText())
      if (!text.includes('还没有跑过评测')) issues.push('应写「还没有跑过评测」')
      if (!(await tab.locator('[data-testid=eval-empty] button', { hasText: '运行评测' }).count())) issues.push('空状态应有可点的「运行评测」')
      if (await tab.locator('[data-testid=eval-metrics], [data-testid=eval-history]').count()) issues.push('没有记录时不该画指标和历次结果表')
      if ((await bodyText(tab)).includes('暂无数据')) issues.push('不该出现「暂无数据」')
      return issues
    },
  },

  'admin-eval-error': {
    // 评测 · 读不到历史:整块报错 + 重试,标题和运行按钮还在;恢复后点重试能读到
    route: '/admin/eval',
    ready: '[data-testid=admin-error]',
    fixture: { ...evalFixture, __after: failing('eval_history') },
    expectConsole: /503|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = normalize(await tab.locator('[data-testid=admin-error]').innerText())
      if (!text.includes('读取评测记录失败') || !text.includes('重试')) issues.push(`报错应说清楚并给「重试」,实际「${text}」`)
      if (!(await tab.locator('[data-testid=eval-run]').count())) issues.push('读不到历史时「运行评测」仍应可用')
      heal(tab, 'eval_history')
      await tab.locator('[data-testid=admin-error] button', { hasText: '重试' }).click()
      await tab.waitForSelector('[data-testid=eval-metrics]')
      if (await tab.locator('[data-testid=admin-error]').count()) issues.push('重试成功后报错应消失')
      return issues
    },
  },

  'admin-eval-forbidden': {
    // 评测 · 无权限:账号没有 search.tune —— 说明原因,不给重试,没有运行按钮
    route: '/admin/eval',
    ready: '[data-testid=admin-forbidden]',
    fixture: { ...evalFixture, __me: meWithout('search.tune') },
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await tab.locator('[data-testid=admin-forbidden]').innerText()
      if (!text.includes('你的账号没有开通这个功能')) issues.push('应说明账号没有开通这个功能')
      if (await tab.getByRole('button', { name: '重试' }).count()) issues.push('无权限不该给「重试」')
      if (await tab.locator('[data-testid=eval-run], [data-testid=eval-metrics]').count()) issues.push('没有功能点时不该显示运行按钮和指标')
      return issues
    },
  },

  'admin-eval-running': {
    // 评测 · 运行中:按钮禁用并写「评测中…」,有进度条和已用时间;跑完后指标换成新结果、提示条出现
    route: '/admin/eval',
    ready: '[data-testid=eval-metrics]',
    fixture: {
      ...evalFixture,
      eval_run: () => evalRun('ev_fresh', 0, { hit_at_1: 0.95, cases: EVAL_CASES }),
      __after: gated('eval_run'),
    },
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      await tab.locator('[data-testid=eval-run]').click()
      await tab.waitForSelector('[data-testid=eval-running]')
      const waiting = normalize(await tab.locator('[data-testid=eval-running]').innerText())
      if (!/正在评测,已用 \d+ 秒/.test(waiting)) issues.push(`运行中应写「正在评测,已用 N 秒」,实际「${waiting}」`)
      if (!(await tab.locator('[data-testid=eval-running] .kb-ev-wait-bar').count())) issues.push('运行中应有进度条')
      if (!(await tab.locator('[data-testid=eval-run]').isDisabled())) issues.push('运行中「运行评测」应禁用,防重复点')
      if (!(await tab.locator('[data-testid=eval-run]').innerText()).includes('评测中')) issues.push('运行中按钮应写「评测中…」')
      issues.push(...(await overflowIssues(tab)))
      issues.push(...(await touchIssues(tab, '.kb-ph-actions button')))
      release(tab)
      await tab.waitForSelector('[data-testid=eval-running]', { state: 'detached' })
      await tab.waitForSelector('.kb-toast')
      if (!(await tab.locator('.kb-toast').first().innerText()).includes('评测完成')) issues.push('跑完应弹出「评测完成」提示条')
      if (!normalize(await tab.locator('[data-testid=metric-hit1]').innerText()).includes('95.0%')) issues.push('跑完后第 1 条命中率应换成 95.0%')
      if (!(await tab.locator('[data-testid=eval-meta]').innerText()).includes('刚跑完的这一次')) issues.push('应标明这是刚跑完的这一次')
      if (await tab.locator('[data-testid=eval-run]').isDisabled()) issues.push('跑完后「运行评测」应恢复可点')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'admin-eval-run-failed': {
    // 评测 · 运行失败:就地说原因 + 怎么办 + 「重新运行」;页面原来的结果还在;不露英文前缀
    route: '/admin/eval',
    ready: '[data-testid=eval-metrics]',
    fixture: {
      ...evalFixture,
      __capabilityError: { eval_run: { status: 400, code: 'invalid_input', message: 'invalid input: 读取黄金集 eval/golden.example.toml 失败: 文件不存在' } },
    },
    expectConsole: /400|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=eval-run]').click()
      await tab.waitForSelector('[data-testid=eval-run-error]')
      const text = normalize(await tab.locator('[data-testid=eval-run-error]').innerText())
      if (!text.includes('运行评测失败:读取黄金集')) issues.push(`应说清楚发生了什么,实际「${text}」`)
      if (!text.includes('请确认黄金集文件存在')) issues.push('应告诉用户怎么办')
      if (/invalid input/i.test(text)) issues.push('不该露英文前缀 invalid input')
      if (!(await tab.locator('[data-testid=eval-retry]').count())) issues.push('应给「重新运行」')
      if (!(await tab.locator('[data-testid=metric-hit1]').count())) issues.push('失败不该清掉页面上原来的结果')
      if (await tab.locator('[data-testid=eval-run]').isDisabled()) issues.push('失败后「运行评测」应恢复可点')
      issues.push(...(await overflowIssues(tab)))
      issues.push(...(await touchIssues(tab, '[data-testid=eval-run-error] button')))
      return issues
    },
  },

  'admin-eval-phone': {
    // 评测 · 手机:历次结果和逐条结果都是卡片;卡片里有中文标签;没有横向滚动;按钮 ≥44px
    route: '/admin/eval',
    ready: '[data-testid=eval-metrics]',
    fixture: evalFixture,
    sizes: ['390x844'],
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (await tab.locator('table').count()) issues.push('手机上不该有表格')
      const card = normalize(await historyItems(tab).first().innerText())
      for (const word of ['运行编号', '检索方式', '前 3 条命中率', '前 10 条命中率', '平均排名得分', '慢查询耗时', '212 毫秒']) if (!card.includes(word)) issues.push(`历次结果卡片缺少「${word}」`)
      const caseCard = normalize(await caseItems(tab).nth(3).innerText())
      if (!caseCard.includes('没找到')) issues.push(`第 4 条查询没找到,卡片上应写「没找到」,实际「${caseCard}」`)
      // 下拉的触发按钮、按钮、折叠的说明:触屏上可点区域都要 ≥44px(下拉菜单里没展开的选项不算)
      issues.push(...(await touchIssues(tab, '.kb-select > button, .kb-btn, summary, [role=tab]')))
      return issues
    },
  },

  'admin-eval-light': {
    route: '/admin/eval',
    ready: '[data-testid=eval-metrics]',
    fixture: evalFixture,
    init: lightTheme,
    assert: async (tab) => overflowIssues(tab),
  },

  'admin-eval-ai-off': {
    // 评测 · AI 关闭:页面(含侧栏、顶栏)任何位置没有「AI」字样,评测本身照常
    route: '/admin/eval',
    ready: '[data-testid=eval-metrics]',
    fixture: { ...evalFixture, __me: aiOffMe },
    sizes: ['390x844', '1440x900'],
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      issues.push(...aiWordIssues(await bodyText(tab), '评测页'))
      if ((await tab.locator('[data-testid=eval-metrics] .metric').count()) !== 4) issues.push('AI 关闭后评测的四个指标应照常')
      return issues
    },
  },

  // ================================================================ 系统状态

  'admin-system': {
    // 系统状态 · 正常:五个页签逐页看——服务 / 资源 / 组件 / 任务 / 日志;没有编出来的内容、没有英文术语、每页都没有横向溢出
    route: '/admin/system',
    ready: '[data-testid=card-service]',
    fixture: { system_status: sysSnapshot() },
    settle: 600,
    assert: async (tab, size) => {
      const issues = [...(await overflowIssues(tab))]
      const tabs = (await tab.locator('[data-testid=status-tabs] [role=tab]').allInnerTexts()).map((item) => item.trim())
      if (tabs.join('|') !== '服务|资源|组件|任务|日志') issues.push(`页签应是 服务|资源|组件|任务|日志,实际 ${tabs.join('|')}`)
      // 页签条在屏幕里(手机上 5 个页签放得下,不需要横滑才看到)
      for (const box of await tab.locator('[data-testid=status-tabs] [role=tab]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right))) {
        if (box > size.width + 1) issues.push('页签超出了屏幕')
      }
      // 服务
      let text = normalize(await bodyText(tab))
      for (const word of ['服务信息', '数据规模', '网络与访问', '云端模型用量', '3 天 4 小时', '允许远程访问', 'server.allow_remote', '需要注意']) if (!text.includes(word)) issues.push(`服务页缺少「${word}」`)
      issues.push(...techIssues(text, '服务页'))
      if (/Nginx|2024-11|Unix Domain|LlmGate|端口与到达性/.test(text)) issues.push('服务页不该有编出来的内容(Nginx / 协议版本号 / LlmGate…)')
      // 资源
      await tab.locator('[data-testid=status-tabs] [role=tab]', { hasText: '资源' }).click()
      await tab.waitForSelector('[data-testid=card-cpu]')
      text = normalize(await bodyText(tab))
      for (const word of ['处理器', '内存', '磁盘', '显卡', '加速与工具', '22 GB / 100 GB', '未采集']) if (!text.includes(word)) issues.push(`资源页缺少「${word}」`)
      if (text.includes('负载走势图')) issues.push('CPU 卡不该有拿三个负载值画的「走势图」')
      // 处理器卡里是环形仪表;页面上方有四张真实采样的曲线(处理器 / 内存 / 磁盘 / 本服务)
      if (!(await tab.locator('[data-testid=card-cpu] .kb-gauge').count())) issues.push('CPU 卡里应有环形仪表')
      for (const id of ['cpu', 'memory', 'disk', 'proc']) {
        if (!(await tab.locator(`[data-testid=chart-${id}] .kb-line-path`).count())) issues.push(`资源曲线「${id}」应画出线`)
      }
      issues.push(...techIssues(text, '资源页'), ...(await overflowIssues(tab)))
      // 组件
      await tab.locator('[data-testid=status-tabs] [role=tab]', { hasText: '组件' }).click()
      await tab.waitForSelector('[data-testid=kind-embed]')
      text = normalize(await bodyText(tab))
      for (const word of ['文字识别(OCR)', '索引模型', '重排模型', '云端模型', '未安装', '当前使用', '去系统设置']) if (!text.includes(word)) issues.push(`组件页缺少「${word}」`)
      issues.push(...techIssues(text, '组件页'), ...(await overflowIssues(tab)))
      // 任务
      await tab.locator('[data-testid=status-tabs] [role=tab]', { hasText: '任务' }).click()
      await tab.waitForSelector('[data-testid=card-queue]')
      text = normalize(await bodyText(tab))
      for (const word of ['任务队列', '导入队列', '最近的任务', '运行中', '排队', '失败', '自动提炼', '重建索引']) if (!text.includes(word)) issues.push(`任务页缺少「${word}」`)
      if (/Tokio|Worker|Checkpoint|指数退避|并发槽位|队列健康度|吞吐与限流/.test(text)) issues.push('任务页不该有写死的「工作线程 / 吞吐与限流 / 队列健康度」')
      for (const id of ['flow', 'depth']) {
        if (!(await tab.locator(`[data-testid=chart-${id}]`).count())) issues.push(`任务趋势缺少「${id}」图`)
      }
      if (/\b(queued|running|failed|index|reindex)\b/.test(await tab.locator('[data-testid=card-queue], [data-testid=card-recent]').allInnerTexts().then((list) => list.join(' ')))) issues.push('任务页的状态和类型应是中文,不露 queued / running / failed')
      issues.push(...techIssues(text, '任务页'), ...(await overflowIssues(tab)))
      // 日志
      await tab.locator('[data-testid=status-tabs] [role=tab]', { hasText: '日志' }).click()
      await tab.waitForSelector('[data-testid=log-tail]')
      const problems = (await tab.locator('[data-testid=problem]').allInnerTexts()).map(normalize)
      if (problems.length !== 2 || !problems[0].includes('警告') || !problems[1].includes('错误')) issues.push(`最近的警告和错误应有 1 条警告 + 1 条错误,实际 ${JSON.stringify(problems)}`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'admin-system-blocks': {
    // 系统状态 · 一块读不到:只有那一块显示「没读到」+「重新读取」,别的块和页签照常,不是整页空白
    route: '/admin/system',
    ready: '[data-testid=card-service]',
    fixture: { system_status: sysSnapshot({ network: undefined, logs: undefined }) },
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const missing = await tab.locator('[data-testid=block-missing]').evaluateAll((els) => els.map((el) => el.getAttribute('data-block')))
      if (missing.join('|') !== '网络与访问') issues.push(`服务页只应有「网络与访问」没读到,实际 ${missing.join('|')}`)
      for (const id of ['card-service', 'card-scale']) if (!(await tab.locator(`[data-testid=${id}]`).count())) issues.push(`其它块应照常显示:缺 ${id}`)
      if (await tab.locator('[data-testid=card-llm]').count()) issues.push('云端模型用量依赖网络块,网络块没读到时不该显示')
      const text = normalize(await tab.locator('[data-testid=block-missing]').innerText())
      if (!text.includes('其它部分不受影响') || !text.includes('重新读取')) issues.push(`应说明其它部分不受影响并给「重新读取」,实际「${text}」`)
      await tab.locator('[data-testid=status-tabs] [role=tab]', { hasText: '日志' }).click()
      await tab.waitForSelector('[data-testid=block-missing]')
      const logsMissing = await tab.locator('[data-testid=block-missing]').getAttribute('data-block')
      if (logsMissing !== '日志') issues.push(`日志页应显示「日志」没读到,实际 ${logsMissing}`)
      await tab.locator('[data-testid=status-tabs] [role=tab]', { hasText: '资源' }).click()
      await tab.waitForSelector('[data-testid=card-cpu]')
      if (await tab.locator('[data-testid=block-missing]').count()) issues.push('资源页的块都读到了,不该有「没读到」')
      issues.push(...(await touchIssues(tab, '[data-testid=status-tabs] [role=tab], [data-testid=status-refresh]')))
      return issues
    },
  },

  'admin-system-error': {
    // 系统状态 · 第一次就读不到:内容区整块报错 + 重试,标题、页签、刷新按钮还在;恢复后点重试能读到
    route: '/admin/system',
    ready: '[data-testid=admin-error]',
    fixture: { system_status: sysSnapshot(), __after: failing('system_status') },
    expectConsole: /503|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = normalize(await tab.locator('[data-testid=admin-error]').innerText())
      if (!text.includes('读取系统状态失败') || !text.includes('重试') || !text.includes('守护进程')) issues.push(`报错应说清楚、给重试并告诉用户怎么办,实际「${text}」`)
      if ((await tab.locator('[data-testid=status-tabs] [role=tab]').count()) !== 5) issues.push('读不到时页签仍应在')
      if (!(await tab.locator('[data-testid=status-refresh]').count())) issues.push('读不到时刷新按钮仍应在')
      heal(tab, 'system_status')
      await tab.locator('[data-testid=admin-error] button', { hasText: '重试' }).click()
      await tab.waitForSelector('[data-testid=card-service]')
      if (await tab.locator('[data-testid=admin-error]').count()) issues.push('重试成功后报错应消失')
      return issues
    },
  },

  'admin-system-stale': {
    // 系统状态 · 读到之后自动刷新失败:数据留着,说明显示的是几点的数据;恢复后提示消失
    route: '/admin/system',
    ready: '[data-testid=card-service]',
    fixture: { system_status: sysSnapshot(), __after: failing('system_status', { initial: false }) },
    expectConsole: /503|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      breakIt(tab, 'system_status')
      await tab.clock.runFor(10_500)
      await tab.waitForSelector('[data-testid=status-stale]')
      const text = normalize(await tab.locator('[data-testid=status-stale]').innerText())
      if (!text.includes('显示的是') || !text.includes('的数据')) issues.push(`应说明显示的是几点的数据,实际「${text}」`)
      if (await tab.locator('[data-testid=admin-error]').count()) issues.push('已有数据时刷新失败不该换成整块报错')
      if (!(await tab.locator('[data-testid=card-service]').count())) issues.push('刷新失败不该清掉页面上的数据')
      issues.push(...(await overflowIssues(tab)))
      heal(tab, 'system_status')
      await tab.clock.runFor(10_500)
      await tab.waitForSelector('[data-testid=status-stale]', { state: 'detached' }).catch(() => issues.push('恢复后「显示的是旧数据」的提示应消失'))
      return issues
    },
  },

  'admin-system-empty': {
    // 系统状态 · 什么都还没有:每一页给一句说明,不是空白卡片
    route: '/admin/system',
    ready: '[data-testid=card-service]',
    fixture: {
      system_status: sysSnapshot({
        components: [],
        jobs: { by_state: [], recent: [], ingest: [] },
        logs: { dir: '/data/kb/logs', files: [], tail: [] },
      }),
    },
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const expectOn = async (label, selector, words) => {
        await tab.locator('[data-testid=status-tabs] [role=tab]', { hasText: label }).click()
        await tab.waitForSelector(selector)
        const text = normalize(await bodyText(tab))
        for (const word of words) if (!text.includes(word)) issues.push(`${label}页缺少「${word}」`)
        if (text.includes('暂无数据')) issues.push(`${label}页不该出现「暂无数据」`)
        issues.push(...(await overflowIssues(tab)))
      }
      await expectOn('组件', '.card', ['没有检测到组件'])
      await expectOn('任务', '[data-testid=card-queue]', ['还没有任何任务', '导入队列是空的', '还没有任务', '去导入'])
      await expectOn('日志', '[data-testid=card-files]', ['日志目录里还没有日志文件', '最近没有警告或错误', '还没有日志输出'])
      return issues
    },
  },

  'admin-system-forbidden': {
    // 系统状态 · 无权限:账号没有 sys.ops —— 说明原因,不给重试,不渲染数据
    route: '/admin/system',
    ready: '[data-testid=admin-forbidden]',
    fixture: { system_status: sysSnapshot(), __me: meWithout('sys.ops') },
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (!(await tab.locator('[data-testid=admin-forbidden]').innerText()).includes('你的账号没有开通这个功能')) issues.push('应说明账号没有开通这个功能')
      if (await tab.getByRole('button', { name: '重试' }).count()) issues.push('无权限不该给「重试」')
      if (await tab.locator('[data-testid=card-service], [data-testid=status-refresh]').count()) issues.push('没有功能点时不该渲染数据和刷新按钮')
      return issues
    },
  },

  'admin-system-forbidden-server': {
    // 前端以为有权限,但服务端 403:同样显示无权限,不当成可重试的报错
    route: '/admin/system',
    ready: '[data-testid=admin-forbidden]',
    fixture: { system_status: sysSnapshot(), __after: failing('system_status', { status: 403, message: '你的账号没有开通这个功能' }) },
    expectConsole: /403|Failed to load resource/,
    sizes: ['390x844', '1440x900'],
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (await tab.locator('[data-testid=admin-forbidden]').getByRole('button', { name: '重试' }).count()) issues.push('403 不该给「重试」')
      if (await tab.locator('[data-testid=admin-error]').count()) issues.push('403 不该当成可重试的报错')
      return issues
    },
  },

  'admin-system-phone': {
    // 系统状态 · 手机:五个页签都在屏内;日志尾部是自己滚动、自己换行的区域,页面不被撑宽;链接和按钮 ≥44px
    route: '/admin/system?tab=logs',
    ready: '[data-testid=log-tail]',
    fixture: { system_status: sysSnapshot() },
    sizes: ['390x844'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = [...(await overflowIssues(tab))]
      const tail = await tab.locator('[data-testid=log-tail]').evaluate((el) => {
        const style = getComputedStyle(el)
        const box = el.getBoundingClientRect()
        return { overflowY: style.overflowY, scrollable: el.scrollHeight > el.clientHeight + 1, hScroll: el.scrollWidth - el.clientWidth, right: box.right, tabindex: el.getAttribute('tabindex') }
      })
      if (!/(auto|scroll)/.test(tail.overflowY)) issues.push(`日志区应自己纵向滚动,overflow-y=${tail.overflowY}`)
      if (!tail.scrollable) issues.push('夹具里有 60+ 行日志,日志区应该能滚动(内容比框高)')
      if (tail.hScroll > 1) issues.push(`很长的一行日志应自动换行,日志区不该横向滚动 ${tail.hScroll}px`)
      if (tail.right > size.width + 1) issues.push('日志区超出了屏幕')
      if (tail.tabindex !== '0') issues.push('日志区应能用键盘聚焦滚动(tabindex=0)')
      // 滚到底:最后一行可见
      await tab.locator('[data-testid=log-tail]').evaluate((el) => (el.scrollTop = el.scrollHeight))
      const last = await tab.locator('[data-testid=log-tail] .kb-ss-line').last().innerText()
      if (!last.includes('最后一行')) issues.push(`日志区滚到底应看到最后一行,实际「${last.slice(0, 40)}」`)
      issues.push(...(await touchIssues(tab, '[data-testid=status-tabs] [role=tab], [data-testid=status-refresh], .kb-ss-link, .kb-btn')))
      await tab.locator('[data-testid=status-tabs] [role=tab]', { hasText: '任务' }).click()
      await tab.waitForSelector('[data-testid=card-queue]')
      issues.push(...(await touchIssues(tab, '.kb-ss-link, .kb-btn')), ...(await overflowIssues(tab)))
      return issues
    },
  },

  'admin-system-light': {
    route: '/admin/system?tab=resources',
    ready: '[data-testid=card-cpu]',
    fixture: { system_status: sysSnapshot() },
    init: lightTheme,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      for (const label of ['服务', '组件', '任务', '日志']) {
        await tab.locator('[data-testid=status-tabs] [role=tab]', { hasText: label }).click()
        await tab.waitForTimeout(150)
        issues.push(...(await overflowIssues(tab)))
      }
      return issues
    },
  },

  'admin-system-disk-full': {
    // 系统状态 · 磁盘快满:红色进度条 + 文字「快满了」(不只靠颜色),「需要注意」里也说一句
    route: '/admin/system?tab=resources',
    ready: '[data-testid=card-disk]',
    fixture: { system_status: sysSnapshot({ resources: { ...sysSnapshot().resources, disk: { mount: '/data', free_gb: 7, total_gb: 100, used_ratio: 0.93 } } }) },
    sizes: ['390x844', '1440x900'],
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if ((await tab.locator('[data-testid=level-disk]').innerText()).trim() !== '快满了') issues.push('磁盘 93% 应有「快满了」徽标')
      // 磁盘用量在卡片里换成了环形仪表(KbGauge,图是装饰、真实数据写在外层 role=img 的 aria-label 里),不再是 role=progressbar:
      // 读它的无障碍说明,必须写明 93%,并带上不靠颜色的文字「接近上限」(≥90%)
      const gauge = (await tab.locator('[data-testid=card-disk] [role=img]').first().getAttribute('aria-label')) ?? ''
      if (!gauge.includes('93%')) issues.push(`磁盘仪表的说明应写明 93%,实际 ${gauge}`)
      if (!gauge.includes('接近上限')) issues.push(`磁盘 93% 的仪表说明应带文字「接近上限」(不只靠颜色),实际 ${gauge}`)
      await tab.locator('[data-testid=status-tabs] [role=tab]', { hasText: '服务' }).click()
      await tab.waitForSelector('[data-testid=status-notes]')
      if (!(await tab.locator('[data-testid=status-notes]').innerText()).includes('磁盘已用 93%')) issues.push('「需要注意」里应说磁盘已用 93%')
      return issues
    },
  },

  'admin-system-ai-off': {
    // 系统状态 · AI 关闭:云端模型用量、云端模型 / 审核模型组件、自动提炼类任务都不出现;每个页签(含侧栏顶栏)没有「AI」字样
    route: '/admin/system',
    ready: '[data-testid=card-service]',
    fixture: { system_status: sysSnapshot(), __me: aiOffMe },
    sizes: ['390x844', '1440x900'],
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      for (const label of ['服务', '资源', '组件', '任务', '日志']) {
        await tab.locator('[data-testid=status-tabs] [role=tab]', { hasText: label }).click()
        await tab.waitForTimeout(200)
        const text = await bodyText(tab)
        issues.push(...aiWordIssues(text, `${label}页`))
        if (label !== '日志' && /自动提炼|云端模型|审核模型/.test(text)) issues.push(`${label}页不该出现自动提炼 / 云端模型 / 审核模型`)
      }
      await tab.locator('[data-testid=status-tabs] [role=tab]', { hasText: '组件' }).click()
      await tab.waitForSelector('[data-testid=kind-embed]')
      if (await tab.locator('[data-testid=kind-llm], [data-testid=kind-review]').count()) issues.push('组件页不该有云端模型 / 审核模型')
      const summary = normalize(await tab.locator('[data-testid=components-summary]').innerText())
      if (!summary.includes('3 / 4 个组件就绪')) issues.push(`就绪数应按剩下的 4 个组件算:3 / 4,实际「${summary}」`)
      return issues
    },
  },

  // ================================================================ 项目与集合

  'admin-projects': {
    // 项目与集合 · 正常:三张项目卡(开关有中文名和帮助文字)、集合表(手机是卡片)、服务器目录与 Git 来源那一块原样在
    route: '/admin/projects',
    ready: '[data-testid=collections-section] [data-testid=rt-row], [data-testid=collections-section] [data-testid=rt-card]',
    fixture: projectsFixture(),
    settle: 700,
    assert: async (tab, size) => {
      const issues = [...(await overflowIssues(tab))]
      const names = await tab.locator('[data-testid=project-card] .kb-pj-name').allInnerTexts()
      if (names.length !== 3) issues.push(`应有 3 张项目卡,实际 ${names.length}`)
      const switches = await tab.locator('[data-testid=project-card]').first().locator('[data-testid^=switch-]').evaluateAll((els) => els.map((el) => el.querySelector('.kb-pj-sw-text span')?.textContent))
      if (switches.join('|') !== '提交后自动索引|允许发给云端模型|自动提炼') issues.push(`开关应是 提交后自动索引|允许发给云端模型|自动提炼,实际 ${switches.join('|')}`)
      const help = normalize(await tab.locator('[data-testid=switch-cloud]').first().innerText())
      if (!help.includes('allow_cloud_llm')) issues.push('帮助文字里应带键名 allow_cloud_llm')
      // 三个都是 git 仓库:提交后自动索引的开关可用,不该有「不是 git 仓库」的说明
      const hookToggles = await tab.locator('[data-testid=project-card] [data-testid=switch-hooks] [role=switch]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-disabled')))
      if (hookToggles.length !== 3 || hookToggles.some((value) => value === 'true')) issues.push(`git 项目的提交后自动索引开关应可用,实际 aria-disabled=${hookToggles.join(',')}`)
      if (await tab.locator('[data-testid=switch-note]').count()) issues.push('git 项目的卡片上不该出现开关说明')
      const phone = isPhone(size)
      const rows = await tab.locator('[data-testid=collections-section] [data-testid=rt-row]').count()
      const cards = await tab.locator('[data-testid=collections-section] [data-testid=rt-card]').count()
      if (phone && (cards !== 6 || rows !== 0)) issues.push(`手机上集合应是 6 张卡片,实际卡片 ${cards} 行 ${rows}`)
      if (!phone && (rows !== 6 || cards !== 0)) issues.push(`平板 / 电脑上集合应是 6 行表格,实际行 ${rows} 卡片 ${cards}`)
      const section = normalize(await tab.locator('[data-testid=collections-section]').innerText())
      if (!section.includes('更换中 41%') || !section.includes('换成 bge-m3-q8')) issues.push('更换中的集合应写「更换中 41%」和「换成 bge-m3-q8」')
      if (section.includes('迁移计划')) issues.push('「迁移计划」那一行已并进状态,不该再出现')
      if (!section.includes('笔记') || /经验/.test(section)) issues.push('笔记集合的类型应写「笔记」,不叫「经验」')
      // 服务器目录与 Git 来源还在,而且只列这两类
      const sources = (await tab.locator('[data-testid=server-sources] .kb-srct-title').allInnerTexts()).map((item) => item.trim()).sort()
      if (sources.join('|') !== 'SampleApp|knowledgeBase|sampleproj') issues.push(`服务器来源应原样列出 SampleApp|knowledgeBase|sampleproj,实际 ${sources.join('|')}`)
      issues.push(...techIssues(await bodyText(tab), '项目与集合页'))
      issues.push(...(await touchIssues(tab, '[data-testid=project-card] button, [data-testid=collections-section] button, [data-testid=project-add]')))
      // 开关在触屏上也要有足够大的可点区域
      issues.push(...(await touchIssues(tab, '[data-testid=project-card] [role=switch]')))
      return issues
    },
  },

  'admin-projects-empty': {
    // 项目与集合 · 空:项目和集合各给一句说明 + 一个下一步;服务器来源那块照常
    route: '/admin/projects',
    ready: '[data-testid=projects-empty]',
    fixture: projectsFixture({ list_projects: { projects: [] }, list_collections: { collections: [] }, job_list: { jobs: [] } }),
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const empty = normalize(await tab.locator('[data-testid=projects-empty]').innerText())
      if (!empty.includes('还没有项目') || !empty.includes('添加项目')) issues.push(`项目空状态应说明并给「添加项目」,实际「${empty}」`)
      const colls = normalize(await tab.locator('[data-testid=collections-section]').innerText())
      if (!colls.includes('还没有集合') || !colls.includes('去导入')) issues.push(`集合空状态应说明并给「去导入」,实际「${colls}」`)
      if (!(await tab.locator('[data-testid=server-sources]').count())) issues.push('服务器目录与 Git 来源那一块应照常显示')
      await tab.locator('[data-testid=projects-empty] button', { hasText: '添加项目' }).click()
      await tab.waitForSelector('[data-testid=project-add-card]')
      const go = tab.locator('[data-testid=project-add-go]')
      if (!(await go.isDisabled())) issues.push('没填目录时「添加并索引」应禁用')
      await tab.locator('[data-testid=project-add-card] input').first().fill('/srv/workspace/new-proj')
      if (await go.isDisabled()) issues.push('填了目录后「添加并索引」应可点')
      issues.push(...(await overflowIssues(tab)), ...(await touchIssues(tab, '[data-testid=project-add-card] button')))
      return issues
    },
  },

  'admin-projects-error': {
    // 项目与集合 · 项目读不到:只有项目这一块整块报错 + 重试,集合和服务器来源照常;恢复后点重试能读到
    route: '/admin/projects',
    ready: '[data-testid=projects-section] [data-testid=admin-error]',
    fixture: projectsFixture({ __after: failing('list_projects') }),
    expectConsole: /503|Failed to load resource/,
    settle: 600,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = normalize(await tab.locator('[data-testid=projects-section] [data-testid=admin-error]').innerText())
      if (!text.includes('读取项目失败') || !text.includes('重试')) issues.push(`项目报错应说清楚并给「重试」,实际「${text}」`)
      if (!(await tab.locator('[data-testid=collections-section] [data-testid=rt-row], [data-testid=collections-section] [data-testid=rt-card]').count())) issues.push('项目读不到时集合应照常显示')
      if (await tab.locator('[data-testid=collections-section] [data-testid=admin-error]').count()) issues.push('集合没出错,不该有报错')
      if (!(await tab.locator('[data-testid=server-sources]').count())) issues.push('服务器来源应照常显示')
      heal(tab, 'list_projects')
      await tab.locator('[data-testid=projects-section] [data-testid=admin-error] button', { hasText: '重试' }).click()
      await tab.waitForSelector('[data-testid=project-card]')
      if (await tab.locator('[data-testid=projects-section] [data-testid=admin-error]').count()) issues.push('重试成功后报错应消失')
      return issues
    },
  },

  'admin-projects-collections-error': {
    // 项目与集合 · 集合读不到:只有集合这一块报错 + 重试,项目照常;不会因为概览读不到就整块失败
    route: '/admin/projects',
    ready: '[data-testid=collections-section] [data-testid=admin-error]',
    fixture: projectsFixture({ __after: together(failing('list_collections'), failing('stats_overview')) }),
    expectConsole: /503|Failed to load resource/,
    settle: 600,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = normalize(await tab.locator('[data-testid=collections-section] [data-testid=admin-error]').innerText())
      if (!text.includes('读取集合失败') || !text.includes('重试')) issues.push(`集合报错应说清楚并给「重试」,实际「${text}」`)
      if ((await tab.locator('[data-testid=project-card]').count()) !== 3) issues.push('集合读不到时项目卡片应照常显示')
      heal(tab, 'list_collections')
      await tab.locator('[data-testid=collections-section] [data-testid=admin-error] button', { hasText: '重试' }).click()
      await tab.waitForSelector('[data-testid=collections-section] [data-testid=rt-row], [data-testid=collections-section] [data-testid=rt-card]')
      // 概览仍然读不到:集合照样显示,只是少了「当前索引模型」
      if ((await tab.locator('[data-testid=projects-summary]').innerText()).includes('当前索引模型')) issues.push('概览读不到时不该编一个「当前索引模型」')
      return issues
    },
  },

  'admin-projects-forbidden': {
    // 项目与集合 · 无权限:账号没有 sources.local —— 整页说明未开通,没有添加按钮,不渲染项目和来源
    route: '/admin/projects',
    ready: '[data-testid=admin-forbidden]',
    fixture: projectsFixture({ __me: meWithout('sources.local') }),
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (!(await tab.locator('[data-testid=admin-forbidden]').innerText()).includes('你的账号没有开通这个功能')) issues.push('应说明账号没有开通这个功能')
      if (await tab.getByRole('button', { name: '重试' }).count()) issues.push('无权限不该给「重试」')
      if (await tab.locator('[data-testid=project-card], [data-testid=server-sources], [data-testid=project-add]').count()) issues.push('没有功能点时不该渲染项目、服务器来源和添加按钮')
      return issues
    },
  },

  'admin-projects-phone': {
    // 项目与集合 · 手机:集合是卡片(名字 + 类型 + 状态 + 一行模型和片段数 + 整行的操作),长集合名换行不溢出;项目卡片的开关和按钮 ≥44px
    route: '/admin/projects',
    ready: '[data-testid=collection-card]',
    fixture: projectsFixture(),
    sizes: ['390x844'],
    settle: 600,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (await tab.locator('[data-testid=collections-section] table').count()) issues.push('手机上集合不该是表格')
      const card = normalize(await tab.locator('[data-testid=collection-card]').first().innerText())
      for (const word of ['knowledgeBase/code', '代码', '就绪', 'bge-m3-int8 · 1024 维', '个内容片段', '更换索引模型', '删除']) if (!card.includes(word)) issues.push(`集合卡片缺少「${word}」`)
      const migrating = tab.locator('[data-testid=collection-card]', { hasText: '更换中' }).first()
      if (!(await migrating.locator('[role=progressbar]').count())) issues.push('更换中的集合卡片应有进度条')
      if (!(await migrating.locator('[data-testid=collection-migrate]').isDisabled())) issues.push('更换中的集合不能再点「更换索引模型」')
      issues.push(...(await touchIssues(tab, '[data-testid=collection-card] button, [data-testid=project-card] button, [data-testid=project-card] [role=switch]')))
      const badges = await tab.evaluate(() =>
        [...document.querySelectorAll('[data-testid=collection-card] .kb-pj-badge')].filter((el) => {
          const range = document.createRange()
          range.selectNodeContents(el)
          return range.getClientRects().length > 1
        }).length,
      )
      if (badges) issues.push(`${badges} 个徽标被挤成了多行`)
      return issues
    },
  },

  'admin-projects-migrate': {
    // 项目与集合 · 更换索引模型:先估算再确认(写清后台执行、旧索引保留);手机是底部弹层,完整在屏内,「确认」点得到
    route: '/admin/projects',
    ready: '[data-testid=collections-section] [data-testid=rt-row], [data-testid=collections-section] [data-testid=rt-card]',
    fixture: projectsFixture(),
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      await tab.locator('[data-testid=collection-migrate]:not([disabled])').first().click()
      await tab.waitForSelector('[data-testid=migrate-plan]')
      await settled(tab, '[role=dialog]')
      const dialog = normalize(await tab.locator('[role=dialog]').innerText())
      for (const word of ['更换索引模型', '旧索引会保留,可以回滚', '新的索引模型', '需要', '5,100 个片段(其中笔记 390 条)', '约 1 分 36 秒']) if (!dialog.includes(word)) issues.push(`对话框缺少「${word}」`)
      if (/insight|dry-run|嵌入器|物理表|兼容组/.test(dialog)) issues.push('对话框里不该露 insight / dry-run / 嵌入器 / 物理表 / 兼容组')
      issues.push(...(await inViewport(tab, '[role=dialog]', size, '对话框')))
      await tab.locator('[data-testid=migrate-go]').scrollIntoViewIfNeeded()
      issues.push(...(await inViewport(tab, '[data-testid=migrate-go]', size, '「确认更换」按钮')))
      // 只查本页自己的按钮和下拉;对话框右上角的「关闭」是 KbDialog 自带的 .btn.sm(宽 42px,见报告),不在这一页的范围
      issues.push(...(await touchIssues(tab, '[role=dialog] .kb-btn, [role=dialog] .kb-select > button')))
      await tab.locator('[data-testid=migrate-go]').click()
      await tab.waitForSelector('.kb-toast')
      if (!(await tab.locator('.kb-toast').first().innerText()).includes('已开始更换')) issues.push('确认后应提示「已开始更换…进度在「任务」页」')
      await tab.waitForSelector('[role=dialog]', { state: 'detached' }).catch(() => issues.push('确认后对话框应关闭'))
      return issues
    },
  },

  'admin-projects-hooks': {
    // 项目与集合 · 提交后自动索引:非 git 目录置灰并写明原因、点不动;git 项目开启前的确认写全(四个钩子 / .kb-orig / 不调用大模型 / 首次全量扫描);
    // 仓库 hooks 目录由别的工具托管(后端回 managed_by_other)时弹警告、不弹「已开启」、开关保持关;正常开启仍弹「已开启」
    route: '/admin/projects',
    ready: '[data-testid=project-card]',
    fixture: hooksFixture(),
    sizes: ['390x844', '1440x900'],
    settle: 600,
    assert: async (tab, size) => {
      const issues = [...(await overflowIssues(tab))]
      const toggleOf = (name) => tab.locator(`[data-testid=project-card][data-project=${name}] [data-testid=switch-hooks] [role=switch]`)
      const toastOf = (text) => tab.locator('.kb-toast', { hasText: text })

      // 1. 非 git 目录:置灰 + 可见说明 + 点了没有任何反应
      const plain = toggleOf('audit-system')
      await plain.scrollIntoViewIfNeeded()
      if ((await plain.getAttribute('aria-disabled')) !== 'true') issues.push('非 git 目录的提交后自动索引应置灰(aria-disabled=true)')
      const note = tab.locator('[data-testid=project-card][data-project=audit-system] [data-testid=switch-note]')
      if (!(await note.isVisible())) issues.push('非 git 目录应有可见的说明文字')
      else if (!normalize(await note.innerText()).includes('这个目录不是 git 仓库,没有可装的提交钩子')) issues.push(`说明文字不对:「${normalize(await note.innerText())}」`)
      if ((await plain.getAttribute('aria-describedby')) !== (await note.getAttribute('id'))) issues.push('置灰的开关应通过 aria-describedby 关联到说明文字')
      await plain.click({ force: true })
      await tab.waitForTimeout(400)
      if (await tab.locator('[role=alertdialog]').count()) issues.push('点置灰的开关不该弹出确认框')
      if (await tab.locator('.kb-toast').count()) issues.push('点置灰的开关不该有任何提示')
      for (const name of ['knowledgeBase', 'SampleApp', 'sampleproj', 'devkit']) {
        if ((await toggleOf(name).getAttribute('aria-disabled')) === 'true') issues.push(`${name} 是 git 仓库,开关不该置灰`)
      }

      // 2. 开启前的确认:写全后果,在屏幕里,取消什么也不发生
      const confirm = async (name) => {
        await toggleOf(name).scrollIntoViewIfNeeded()
        await toggleOf(name).click()
        await tab.waitForSelector('[role=alertdialog]')
        await settled(tab, '[role=alertdialog]')
      }
      await confirm('sampleproj')
      const text = normalize(await tab.locator('[role=alertdialog]').innerText())
      for (const word of ['开启「sampleproj」提交后自动索引?', 'post-commit', 'post-merge', 'post-checkout', 'post-rewrite', '.kb-orig', '链式调用', '不调用大模型', '全量扫描']) {
        if (!text.includes(word)) issues.push(`开启确认缺少「${word}」,实际「${text}」`)
      }
      issues.push(...(await inViewport(tab, '[role=alertdialog]', size, '确认框')))
      await tab.locator('[role=alertdialog]').getByRole('button', { name: '取消' }).click()
      await tab.waitForSelector('[role=alertdialog]', { state: 'detached' })
      if ((await toggleOf('sampleproj').getAttribute('aria-checked')) !== 'false') issues.push('取消后开关应保持关')

      // 3. hooksPath 被托管:警告、不弹「已开启」、开关仍是关
      await confirm('sampleproj')
      await tab.locator('[role=alertdialog]').getByRole('button', { name: '开启' }).click()
      await tab.waitForSelector('.kb-toast.is-warning')
      const warning = normalize(await tab.locator('.kb-toast.is-warning').first().innerText())
      for (const word of ['core.hooksPath', 'kb 没有改动', '手动加一行通知命令']) if (!warning.includes(word)) issues.push(`托管警告缺少「${word}」,实际「${warning}」`)
      if (await toastOf('已开启').count()) issues.push('hooksPath 被托管时不该弹「已开启提交后自动索引」')
      if ((await toggleOf('sampleproj').getAttribute('aria-checked')) !== 'false') issues.push('hooksPath 被托管时开关应保持关')

      // 4. 正常的 git 仓库:照常弹「已开启」(不是警告)
      await confirm('devkit')
      await tab.locator('[role=alertdialog]').getByRole('button', { name: '开启' }).click()
      await toastOf('已开启提交后自动索引').first().waitFor()
      if (await tab.locator('.kb-toast.is-success', { hasText: '已开启提交后自动索引' }).count() !== 1) issues.push('正常开启应弹一条成功提示「已开启提交后自动索引」')
      return issues
    },
  },

  'admin-projects-delete': {
    // 项目与集合 · 删除集合 / 移除项目:红色确认,写清后果(不能恢复);点取消什么也不发生
    route: '/admin/projects',
    ready: '[data-testid=collections-section] [data-testid=rt-row], [data-testid=collections-section] [data-testid=rt-card]',
    fixture: projectsFixture(),
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      await tab.locator('[data-testid=collection-delete]').first().click()
      await tab.waitForSelector('[role=alertdialog]')
      await settled(tab, '[role=alertdialog]')
      let text = normalize(await tab.locator('[role=alertdialog]').innerText())
      if (!text.includes('删除集合「knowledgeBase/code」?') || !text.includes('不能恢复')) issues.push(`删除集合的确认应写清后果,实际「${text}」`)
      issues.push(...(await inViewport(tab, '[role=alertdialog]', size, '确认框')))
      await tab.locator('[role=alertdialog]').getByRole('button', { name: '取消' }).click()
      await tab.waitForSelector('[role=alertdialog]', { state: 'detached' })
      await tab.locator('[data-testid=project-remove]').first().click()
      await tab.waitForSelector('[role=alertdialog]')
      await settled(tab, '[role=alertdialog]')
      text = normalize(await tab.locator('[role=alertdialog]').innerText())
      if (!text.includes('移除项目') || !text.includes('不能恢复') || !text.includes('目录里的文件不受影响')) issues.push(`移除项目的确认应写清后果,实际「${text}」`)
      await tab.locator('[role=alertdialog]').getByRole('button', { name: '取消' }).click()
      await tab.waitForSelector('[role=alertdialog]', { state: 'detached' })
      if ((await tab.locator('[data-testid=project-card]').count()) !== 3) issues.push('取消后项目卡片应不变')
      return issues
    },
  },

  'admin-projects-light': {
    route: '/admin/projects',
    ready: '[data-testid=collections-section] [data-testid=rt-row], [data-testid=collections-section] [data-testid=rt-card]',
    fixture: projectsFixture(),
    init: lightTheme,
    assert: async (tab) => overflowIssues(tab),
  },

  'admin-projects-ai-off': {
    // 项目与集合 · AI 关闭:卡片上没有「允许发给云端模型」「自动提炼」,编辑对话框里也没有;页面任何位置没有「AI」字样
    route: '/admin/projects',
    ready: '[data-testid=project-card]',
    fixture: projectsFixture({ __me: aiOffMe }),
    sizes: ['390x844', '1440x900'],
    settle: 600,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (await tab.locator('[data-testid=switch-cloud], [data-testid=switch-extract]').count()) issues.push('AI 关闭后卡片上不该有云端模型 / 自动提炼开关')
      if ((await tab.locator('[data-testid=switch-hooks]').count()) !== 3) issues.push('提交后自动索引开关应照常(3 张卡各一个)')
      await tab.locator('[data-testid=project-edit]').first().click()
      await tab.waitForSelector('[data-testid=project-save]')
      const text = await bodyText(tab)
      issues.push(...aiWordIssues(text, '项目与集合页'))
      if (/云端|提炼/.test(text)) issues.push('AI 关闭后编辑对话框里不该有云端模型 / 自动提炼')
      return issues
    },
  },
}

// ================================================================ 夹具

/** 系统状态的完整样本:组件含云端模型 / 审核模型(AI 关闭时要隐藏),任务含自动提炼,日志有警告和错误还有一行很长。 */
function sysSnapshot(over = {}) {
  const tail = Array.from({ length: 64 }, (_, index) => `00:${String(10 + Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')} INFO  batch ${index + 1}/64 · 64 chunks · iGPU ${38 + (index % 5)} ms/batch`)
  tail[20] = '00:15:00 WARN  chunk doc_0441 truncated 8192→8000 tokens'
  tail[40] = `00:20:30 ERROR embed failed: sidecar timeout ${'/very/long/path/segment'.repeat(10)}`
  tail[63] = '00:25:45 INFO  这是最后一行'
  return {
    overview: {
      service: { version: '0.4.0', uptime_seconds: 3 * 86400 + 4 * 3600 + 600, home: '/srv/kb', listen: '127.0.0.1:7878', host: 'demo-host' },
      collections: 7,
      projects: 3,
      sources: 2,
      pending_drafts: 7,
      components_ready: [5, 6],
      note: '不可用组件:rapidocr(文档 OCR)',
    },
    resources: {
      cpu: { cores: 8, busy_ratio: 0.21, load: [0.8, 0.7, 0.6] },
      memory: { total_mb: 32768, available_mb: 18000, used_ratio: 0.45 },
      disk: { mount: '/data', free_gb: 22, total_gb: 100, used_ratio: 0.78 },
      gpu: { name: 'Intel Iris Xe', utilization: null, memory_used_mb: null, note: 'GPU 利用率 / 显存未采集(没有统一的跨厂商接口);当前只用它判断是否存在独显' },
    },
    components: [
      { kind: 'ocr', id: 'rapidocr', name: 'RapidOCR(PP-OCRv6) · PP-OCRv6 small', installed: false, ready: false, current: true, detail: '找不到命令 rapidocr;装 rapidocr-onnxruntime 或指向薄封装脚本', model: null },
      { kind: 'embed', id: 'bge-m3', name: 'bge-m3 · ONNX', installed: true, ready: true, current: true, detail: '核显', model: null },
      { kind: 'rerank', id: 'bge-reranker-v2-m3', name: 'bge-reranker-v2-m3', installed: true, ready: true, current: true, detail: '核显', model: null },
      { kind: 'llm', id: 'deepseek-chat', name: 'deepseek-chat', installed: true, ready: true, current: true, detail: '云端', model: null },
      { kind: 'review', id: 'qwen2.5-14b', name: 'qwen2.5-14b (本地)', installed: true, ready: true, current: true, detail: '未加载', model: null },
      { kind: 'sidecar', id: 'onnx-sidecar', name: 'onnx-sidecar :7071', installed: true, ready: true, current: true, detail: 'pid 4182', model: null },
    ],
    env: { cpu_cores: 8, memory_mb: 32768, disk_free_gb: 22, has_nvidia: false, gpu: 'Intel Iris Xe', has_intel_gpu: true, tools: ['git', 'python3', 'node'] },
    jobs: {
      by_state: [['queued', 2], ['running', 1], ['paused', 0], ['done', 42], ['failed', 1], ['canceled', 0]],
      recent: [
        { id: 'job_4414', kind: 'reindex', state: 'running', done: 41, total: 100, updated_at: NOW - 5 * MINUTE },
        { id: 'job_4413', kind: 'evolve', state: 'done', done: 1, total: 1, updated_at: NOW - 3 * HOUR },
        { id: 'job_4412', kind: 'embed', state: 'failed', done: 0, total: null, updated_at: NOW - 30 * HOUR },
        { id: 'job_4411', kind: 'backup', state: 'done', done: 1, total: 1, updated_at: NOW - 2 * DAY },
      ],
      ingest: [['queued', 0], ['extracting', 1], ['embedding', 3], ['done', 120], ['skipped', 0], ['quarantined', 1], ['failed', 2]],
    },
    network: { listen: '127.0.0.1:7878', socket: '/data/kb/run/kb.sock', allow_remote: false, mcp_transports: ['stdio', 'http'], mcp_allowed_hosts: [], mcp_sessions: 2, llm_calls_today: 18, llm_tokens_today: [182000, 41000], llm_sends_today: 18 },
    logs: { dir: '/data/kb/logs', files: [['kbd.log', 482_113], ['kbd.log.1', 2_048_000]], tail, diagnostics: [] },
    ...over,
  }
}

/**
 * 「提交后自动索引」开关的夹具:在三个 git 项目之外,加一个关着钩子的 git 项目(devkit)和一个非 git 目录(audit-system)。
 * sampleproj 的 core.hooksPath 被 husky 之类托管:装钩子时后端回 managed_by_other,其它项目照常装上。
 */
function hooksFixture() {
  const [kb, sampleapp, sampleproj] = projectsStory.list_projects.projects
  const extra = (name, over) => ({
    project: { ...sampleproj.project, id: `px_${name}`, name, slug: name, root_path: `/srv/workspace/${name}`, hooks_installed: false, ...over },
    collection: `proj_${name.replace('-', '_')}`,
    rows: 1200,
    items: 90,
  })
  return projectsFixture({
    list_projects: { projects: [kb, sampleapp, sampleproj, extra('devkit', {}), extra('audit-system', { is_git: false, last_commit: null })] },
    install_hooks: (args) => ({ hooks_dir: `/srv/workspace/${args.project}/.git/hooks`, managed_by_other: args.project === 'sampleproj', hooks: [] }),
  })
}

/** 项目与集合页的夹具:三个项目、六个集合(其中一个正在更换索引模型 41%)、服务器目录与 Git 来源;估算结果随目标模型变。 */
function projectsFixture(extra = {}) {
  return {
    ...ingestStory,
    ...projectsStory,
    migrate_plan: (args) => ({
      collection: args.collection,
      to_table: `${String(args.collection).replace('/', '_')}__v2`,
      from_embedder: 'fastembed:bge-m3-int8',
      to_embedder: `fastembed:${args.to}`,
      rows: 5100,
      insight_rows: 390,
      estimated_seconds: 96,
      can_switch_without_reembed: false,
    }),
    ...extra,
  }
}
