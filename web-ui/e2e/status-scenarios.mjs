// 错误与状态页的页面场景:由 viewer-shots.mjs 引入,默认跑 core 五个尺寸 × 两个引擎。
// 404、服务不可用(维护中 / 出错 / 连不上 / 离线,自动重试后回到原页面)、快捷键表(按 ?)、新用户引导、公开分享页的失效状态。
import { ALL_FEATURES, adminMe } from './fixture.mjs'
import { overflowIssues } from './admin-scenarios.mjs'
import { smallTargets } from './share-scenarios.mjs'

const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))

async function touchIssues(tab, selector) {
  const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (!coarse) return []
  return (await smallTargets(tab, selector)).map((item) => `触屏可点区域不足 44px:${item}`)
}

/** 一条笔记都没有、没有数据源的新账号 */
const GUIDE_FIXTURE = {
  stats_overview: { collections: [], totals: { rows: 0, insights: 0, projects: 0 }, jobs: { queued: 0, running: 0, paused: 0, done: 0, failed: 0, canceled: 0 }, drafts_pending: 0, activity_7d: [], recent_events: [] },
  list_sources: { sources: [] },
}

export const STATUS_SCENARIOS = {
  'status-404': {
    // 认不出的地址:外壳里的「找不到这个页面」,显示出错的地址,能回首页;手机上不溢出
    route: '/no/such/page?x=1',
    ready: '[data-testid=not-found]',
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('[data-testid=not-found]').innerText()
      if (!text.includes('找不到这个页面')) issues.push('应写「找不到这个页面」')
      if ((await tab.locator('[data-testid=nf-path]').innerText()) !== '/no/such/page?x=1') issues.push('应显示出错的地址')
      if (!(await tab.locator('.kb-nav, .kb-tabbar').count())) issues.push('404 应在外壳里(侧栏 / 标签栏还在,用户能去别处)')
      issues.push(...(await touchIssues(tab, '[data-testid=not-found] button')))
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'status-404-home': {
    // 点「回首页」真的回到首页(单独成场景:运行器在断言之后截图,放在一起的话 404 的截图就变成首页了)
    route: '/no/such/page',
    ready: '[data-testid=not-found]',
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=nf-home]').click()
      await tab.waitForURL(/\/home/, { timeout: 8000 }).catch(() => issues.push('点「回首页」应到 /home'))
      await tab.waitForSelector('[data-testid=home]', { timeout: 8000 }).catch(() => issues.push('回到的应是真正的首页'))
      return issues
    },
  },

  'status-404-legacy': {
    // 旧地址仍然重定向,不会被 404 兜底吞掉
    route: '/dashboard',
    ready: '[data-testid=home], .kb-nav, .kb-tabbar',
    settle: 600,
    assert: async (tab) => {
      const issues = []
      if (await tab.locator('[data-testid=not-found]').count()) issues.push('旧地址 /dashboard 不该变成 404')
      if (!new URL(tab.url()).pathname.startsWith('/admin/overview')) issues.push(`旧地址应重定向到 /admin/overview,实际 ${new URL(tab.url()).pathname}`)
      return issues
    },
  },

  'status-maintenance': {
    // 服务返回 503:不是扔去登录页,而是「服务正在维护」;自动重试,恢复后回到要去的页面
    route: '/kb?collection=knowledgeBase%2Finsights',
    ready: '[data-testid=unavailable]',
    fixture: { __authStatusFail: { status: 503, times: 2 } },
    settle: 300,
    expectConsole: /503|Failed to load resource/,
    assert: async (tab) => {
      const issues = []
      const url = new URL(tab.url())
      if (url.pathname !== '/unavailable') issues.push(`应在服务不可用页,实际 ${url.pathname}`)
      if (url.searchParams.get('kind') !== 'maintenance') issues.push(`原因应是 maintenance,实际 ${url.searchParams.get('kind')}`)
      if (!(await tab.locator('[data-testid=unavailable]').innerText()).includes('服务正在维护')) issues.push('应写「服务正在维护」')
      if (await tab.locator('.kb-login, [data-testid=login]').count()) issues.push('不该落在登录页')
      issues.push(...(await touchIssues(tab, '[data-testid=unavail-retry]')))
      issues.push(...(await overflowIssues(tab)))
      // 点重试:第 2 次仍失败(fixture 一共失败 2 次),显示已重试 1 次;再点一次,服务恢复,回到原来的页面
      await tab.locator('[data-testid=unavail-retry]').click()
      await tab.waitForSelector('[data-testid=unavail-attempts]', { timeout: 8000 })
      if (!(await tab.locator('[data-testid=unavail-attempts]').innerText()).includes('已重试 1 次')) issues.push('点重试失败后应显示「已重试 1 次」')
      await tab.locator('[data-testid=unavail-retry]').click()
      await tab.waitForURL(/\/kb\?/, { timeout: 10_000 }).catch(() => issues.push('服务恢复后应回到 /kb 原来的页面'))
      // 知识库页加载完会在地址里补上 item 等参数:等地址稳定再比,别取到半路上的值
      await tab.waitForFunction(() => new URLSearchParams(location.search).has('item'), null, { timeout: 8000 }).catch(() => undefined)
      if (new URL(tab.url()).searchParams.get('collection') !== 'knowledgeBase/insights') issues.push(`回去的地址应保留原来的查询参数 collection,实际 ${tab.url()}`)
      return issues
    },
  },

  'status-server-error': {
    // 服务返回 500:「服务出了点问题」
    route: '/home',
    ready: '[data-testid=unavailable]',
    fixture: { __authStatusFail: { status: 500 } },
    expectConsole: /500|Failed to load resource/,
    assert: async (tab) => {
      const issues = []
      if (new URL(tab.url()).searchParams.get('kind') !== 'server') issues.push('原因应是 server')
      if (!(await tab.locator('[data-testid=unavailable]').innerText()).includes('服务出了点问题')) issues.push('应写「服务出了点问题」')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'status-network': {
    // 连接直接断开(守护进程没起来):「连不上服务器」
    route: '/home',
    ready: '[data-testid=unavailable]',
    fixture: { __authStatusFail: { status: 'abort' } },
    expectConsole: /ERR_|Failed to load resource|NetworkError|Load failed/,
    assert: async (tab) => {
      const issues = []
      if (new URL(tab.url()).searchParams.get('kind') !== 'network') issues.push(`原因应是 network,实际 ${new URL(tab.url()).searchParams.get('kind')}`)
      if (!(await tab.locator('[data-testid=unavailable]').innerText()).includes('连不上服务器')) issues.push('应写「连不上服务器」')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'status-light': {
    route: '/unavailable?kind=maintenance&next=%2Fhome',
    ready: '[data-testid=unavailable]',
    init: lightTheme,
    fixture: { __authStatusFail: { status: 503 } },
    expectConsole: /503|Failed to load resource/,
    assert: async (tab) => overflowIssues(tab),
  },

  'status-shortcuts': {
    // 按 ? 打开快捷键表(电脑);表里有跳转键(含 D 系统概览)和搜索页的键;输入框里按 ? 不触发;手机没有
    route: '/home',
    ready: '[data-testid=home]',
    sizes: ['820x1180', '1180x820', '1440x900', '1920x1080'],
    settle: 500,
    assert: async (tab) => {
      const issues = []
      await tab.locator('body').click({ position: { x: 5, y: 5 } })
      await tab.keyboard.type('?')
      await tab.waitForSelector('[data-testid=shortcuts]', { timeout: 5000 }).catch(() => issues.push('按 ? 应打开快捷键表'))
      const text = await tab.locator('[data-testid=shortcuts]').innerText().catch(() => '')
      for (const word of ['命令面板', '系统概览', '评测', '聚焦搜索框', '保存', '查看这张快捷键表']) if (!text.includes(word)) issues.push(`快捷键表缺少「${word}」`)
      await tab.keyboard.press('Escape')
      await tab.waitForFunction(() => !document.querySelector('[data-testid=shortcuts]')).catch(() => issues.push('Esc 应关掉快捷键表'))
      // 在输入框里打 ? 是在打字,不该弹表
      await tab.goto(new URL('/search', tab.url()).toString(), { waitUntil: 'networkidle' })
      await tab.locator('input.kb-searchbar-input').fill('')
      await tab.locator('input.kb-searchbar-input').press('?')
      if (await tab.locator('[data-testid=shortcuts]').count()) issues.push('在输入框里按 ? 不该打开快捷键表')
      if ((await tab.locator('input.kb-searchbar-input').inputValue()) !== '?') issues.push('在输入框里按 ? 应该输入问号')
      return issues
    },
  },

  'status-shortcuts-phone': {
    // 手机没有键盘:按 ? 不响应
    route: '/home',
    ready: '[data-testid=home]',
    sizes: ['390x844'],
    assert: async (tab) => {
      await tab.keyboard.type('?')
      await tab.waitForTimeout(300)
      return (await tab.locator('[data-testid=shortcuts]').count()) ? ['手机上按 ? 不该打开快捷键表'] : []
    },
  },

  'status-guide': {
    // 新用户引导:一条笔记都没有 → 首页顶上有「先从这几步开始」;点「写下第一条笔记」直接进新建表单
    route: '/home',
    ready: '[data-testid=home-guide]',
    fixture: GUIDE_FIXTURE,
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const steps = await tab.locator('[data-testid=home-guide] [data-step]').evaluateAll((els) => els.map((el) => el.dataset.step))
      if (steps.join(',') !== 'note,import,search,friends,assistant') issues.push(`引导步骤应是 note,import,search,friends,assistant,实际 ${steps.join(',')}`)
      issues.push(...(await touchIssues(tab, '[data-testid=home-guide] button')))
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'status-guide-note': {
    route: '/home',
    ready: '[data-testid=home-guide]',
    fixture: GUIDE_FIXTURE,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-step=note] button').click()
      await tab.waitForSelector('.kb-dp-title-input', { timeout: 15_000 }).catch(() => issues.push('「写下第一条笔记」应直接进入新建表单'))
      return issues
    },
  },

  'status-guide-dismiss': {
    // 点「不再显示」:马上收起;刷新页面也不会再冒出来(用户资料是刷新后才取回的,读取时机错了就会冒出来)
    route: '/home',
    ready: '[data-testid=home-guide]',
    fixture: GUIDE_FIXTURE,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=guide-dismiss]').click()
      if (await tab.locator('[data-testid=home-guide]').count()) issues.push('点「不再显示」应马上收起')
      await tab.reload({ waitUntil: 'networkidle' })
      await tab.waitForSelector('[data-testid=home]')
      await tab.waitForTimeout(600)
      if (await tab.locator('[data-testid=home-guide]').count()) issues.push('关掉以后刷新不该再出现')
      return issues
    },
  },

  'status-guide-ai-off': {
    // AI 关掉:引导里没有助手这一步,首页没有「AI」字样
    route: '/home',
    ready: '[data-testid=home-guide]',
    fixture: { ...GUIDE_FIXTURE, __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('ai.') && id !== 'search.deep'), false) } },
    assert: async (tab) => {
      const issues = []
      const steps = await tab.locator('[data-testid=home-guide] [data-step]').evaluateAll((els) => els.map((el) => el.dataset.step))
      if (steps.includes('assistant')) issues.push('AI 关闭后引导里不该有助手这一步')
      const body = await tab.locator('[data-testid=home]').innerText()
      if (/AI/.test(body)) issues.push(`AI 关闭后首页不该出现「AI」,出现在:${body.match(/.{0,10}AI.{0,10}/)?.[0]}`)
      return issues
    },
  },
}
