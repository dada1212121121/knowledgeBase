// 首页(个人工作台)的页面场景:由 viewer-shots.mjs 引入,默认跑 core 五个尺寸 × 两个引擎。
// 每个场景都在假接口(fixture)下真实渲染、真实点击:正常 / 空 / 部分报错可重试 / AI 关闭 / 没有任何功能。
import { ALL_FEATURES, NOW, adminMe } from './fixture.mjs'
import { myUsageFixture } from './fixture-admin.mjs'
import { PEOPLE, shareFixture } from './share-fixture.mjs'
import { SHARED_ITEMS, SHARED_SPACES, smallTargets } from './share-scenarios.mjs'
import { overflowIssues } from './admin-scenarios.mjs'

const MINUTE = 60_000
const pendingAccess = {
  to_decide: [
    {
      id: 'ar_1',
      key: 'doc:sp_primary/knowledgeBase%2Finsights/i/ins_8f21',
      target: { kind: 'insight', space_id: 'sp_primary', collection: 'knowledgeBase/insights', id: 'ins_8f21' },
      title: '部署清单',
      requester: PEOPLE.lisi,
      role: 'editor',
      message: null,
      state: 'pending',
      created_at: NOW - 120 * MINUTE,
      decided_at: null,
    },
  ],
  mine: [],
}

/** 有数据的首页夹具:共享 4 项、一条访问申请(好友申请和草稿数来自基础夹具)、用量。 */
export const homeFixture = (extra = {}, shareInitial = {}) =>
  shareFixture({ sharedWithMe: structuredClone(SHARED_ITEMS), spaces: structuredClone(SHARED_SPACES), accessRequests: structuredClone(pendingAccess), ...shareInitial }, { usage_mine: () => myUsageFixture, ...extra })

const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))
const rect = (tab, selector) => tab.locator(selector).first().boundingBox()
const texts = (tab, selector) => tab.locator(selector).allInnerTexts().then((list) => list.map((item) => item.replace(/\s+/g, ' ').trim()))

/** 触屏上所有可点的东西 ≥44px(行、按钮),电脑上不检查 */
async function touchIssues(tab) {
  const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (!coarse) return []
  const small = await smallTargets(tab, '[data-testid=home] a.kb-home-row, [data-testid=home] .kb-home-row button, [data-testid=home] .kb-home-quick button, [data-testid=home] .kb-home-head button')
  return small.map((item) => `触屏可点区域不足 44px:${item}`)
}

export const HOME_SCENARIOS = {
  'home-full': {
    // 四块都有数据:最近编辑去重且新的在前、共享动态、待处理(好友申请 + 访问申请 + 草稿)、统计卡;窄屏待处理在最前
    route: '/home',
    ready: '[data-testid=home-recent-item]',
    fixture: homeFixture(),
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      // 基础夹具有 6 个集合、每个集合返回同样的前 6 行,其中第 5 行是「已取代」的(夹具不看 status 参数,真实后端会过滤):
      // 合并去重并滤掉已取代的之后,应是不重复的 5 条
      const recent = await texts(tab, '[data-testid=home-recent-item] .kb-home-t')
      if (recent.length !== 5) issues.push(`最近编辑应是 5 条(6 条里有 1 条已取代),实际 ${recent.length}`)
      if (recent.some((title) => title.includes('Windows 下 UDS'))) issues.push('已取代的笔记不该出现在「继续编辑」里')
      if (new Set(recent).size !== recent.length) issues.push(`最近编辑里有重复的笔记:${recent.join(' | ')}`)
      if (recent[0] !== 'UDS 断线后 CLI 自动降级为直读 SQLite') issues.push(`最近更新的应排第一,实际「${recent[0]}」`)
      const shared = await texts(tab, '[data-testid=home-shared-item] .kb-home-t')
      if (shared.length !== 4) issues.push(`共享动态应有 4 条,实际 ${shared.length}`)
      if (shared[0] !== 'Bob 分享了笔记「Bob 的周报」给你') issues.push(`最新分享的应排第一,实际「${shared[0]}」`)
      const pendingKinds = await tab.locator('[data-testid=home-pending-item]').evaluateAll((els) => els.map((el) => el.dataset.kind))
      if (pendingKinds.join(',') !== 'friend,access,review') issues.push(`待处理应依次是 好友申请、访问申请、草稿,实际 ${pendingKinds.join(',')}`)
      if ((await tab.locator('[data-testid=home-pending-count]').innerText()).trim() !== '3') issues.push('待处理的角标应是 3')
      if ((await tab.locator('[data-testid=home-stats] .metric').count()) !== 4) issues.push('应有 4 张统计卡')
      const aiText = await tab.locator('[data-testid=home-ai]').innerText().catch(() => '')
      if (!aiText.includes('今日 AI 用量')) issues.push('AI 开着时应显示今日 AI 用量')

      // 版面(UI-8,按用户要求恢复原来的布局):统计卡 → 图表 → 工作协同(继续编辑 / 共享 / 快捷操作 / 待处理 / AI 用量)。
      // 宽屏两栏,继续编辑在左、待处理在右;窄屏右栏提前,待处理在继续编辑之前。
      const pending = await rect(tab, '[data-testid=home-pending]')
      const recentBox = await rect(tab, '[data-testid=home-recent]')
      const stats = await rect(tab, '[data-testid=home-stats]')
      const charts = await rect(tab, '[data-testid=home-charts]')
      if (!(stats.y + stats.height <= charts.y + 2)) issues.push('统计卡应在图表之前')
      if (!(charts.y + charts.height <= Math.min(pending.y, recentBox.y) + 2)) issues.push('图表应在继续编辑 / 待处理之前')
      if (size.width < 960) {
        if (!(pending.y < recentBox.y)) issues.push('窄屏上待处理应在继续编辑前面')
        if (Math.abs(pending.x - recentBox.x) > 2) issues.push('窄屏应是单列')
      } else {
        if (!(pending.x > recentBox.x + recentBox.width - 2)) issues.push('宽屏应是两栏,待处理在右侧')
        const cols = await tab.locator('.kb-home-cols > .kb-home-col').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))
        if (cols.length !== 2 || Math.abs(cols[0] - cols[1]) > 2) issues.push(`宽屏两栏应顶部对齐,实际两栏顶边 ${cols}`)
      }
      issues.push(...(await touchIssues(tab)), ...(await overflowIssues(tab)))
      return issues
    },
  },

  'home-open-recent': {
    // 点最近编辑的一条 = 去知识库页并打开它(地址里带集合和条目)
    route: '/home',
    ready: '[data-testid=home-recent-item]',
    fixture: homeFixture(),
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=home-recent-item]').first().click()
      await tab.waitForURL(/\/kb\?/)
      const url = new URL(tab.url())
      if (url.pathname !== '/kb') issues.push(`应进知识库页,实际 ${url.pathname}`)
      if (url.searchParams.get('item') !== 'ins_8f21') issues.push(`应打开最近更新的 ins_8f21,实际 ${url.searchParams.get('item')}`)
      return issues
    },
  },

  'home-open-shared': {
    // 点共享动态的一条 = 去知识库页的「共享给我」并选中那一项
    route: '/home',
    ready: '[data-testid=home-shared-item]',
    fixture: homeFixture(),
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=home-shared-item]').first().click()
      await tab.waitForURL(/\/kb\?/)
      const url = new URL(tab.url())
      if (url.searchParams.get('scope') !== 'shared') issues.push(`应切到共享给我,实际 scope=${url.searchParams.get('scope')}`)
      if (!url.searchParams.get('open')) issues.push('应带上要打开的那一项(open)')
      return issues
    },
  },

  'home-new-note': {
    // 「新建笔记」直接进入新建表单:不先打开列表第一条;地址里的 new 参数用完即去
    route: '/home',
    ready: '[data-testid=home-new]',
    fixture: homeFixture(),
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=home-new]').click()
      await tab.waitForSelector('.kb-dp-title-input', { timeout: 15_000 })
      const url = new URL(tab.url())
      if (url.pathname !== '/kb') issues.push(`应进知识库页,实际 ${url.pathname}`)
      if (url.searchParams.has('new')) issues.push('进入新建表单后地址里不该还留着 new=1(刷新会再弹一次)')
      if (url.searchParams.has('item')) issues.push('新建时不该同时打开某一条笔记')
      const title = await tab.locator('.kb-dp-title-input').inputValue()
      if (title !== '') issues.push(`新建表单的标题应为空,实际「${title}」`)
      return issues
    },
  },

  'home-pending-go': {
    // 待处理的按钮去对应的页:好友申请 → 好友页「申请」,访问申请 → 我的分享「访问申请」
    route: '/home',
    ready: '[data-testid=home-pending-item]',
    fixture: homeFixture(),
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=home-pending-item][data-kind=friend] button').click()
      await tab.waitForURL(/\/friends/)
      if (new URL(tab.url()).searchParams.get('tab') !== 'requests') issues.push('好友申请应去好友页的「申请」页签')
      await tab.goBack()
      await tab.waitForSelector('[data-testid=home-pending-item][data-kind=access]')
      await tab.locator('[data-testid=home-pending-item][data-kind=access] button').click()
      await tab.waitForURL(/\/shares/)
      if (new URL(tab.url()).searchParams.get('tab') !== 'requests') issues.push('访问申请应去我的分享的「访问申请」页签')
      return issues
    },
  },

  'home-empty': {
    // 什么都还没有:每一块各自给下一步,不是一片空白
    route: '/home',
    ready: '[data-testid=home-recent-empty]',
    fixture: homeFixture(
      {
        list_items: () => ({ items: [], total: 0, page: 1, page_size: 6 }),
        friend_requests: () => ({ incoming: [], outgoing: [] }),
        stats_overview: { collections: [], totals: { rows: 0, insights: 0, projects: 0 }, jobs: { queued: 0, running: 0, paused: 0, done: 0, failed: 0, canceled: 0 }, drafts_pending: 0, activity_7d: [], recent_events: [] },
      },
      { sharedWithMe: [], accessRequests: { to_decide: [], mine: [] } },
    ),
    assert: async (tab) => {
      const issues = []
      for (const [id, words] of [
        ['home-recent-empty', ['还没有笔记', '新建笔记']],
        ['home-shared-empty', ['还没有人分享内容给你', '去找好友']],
        ['home-pending-empty', ['没有待处理的事']],
      ]) {
        const text = await tab.locator(`[data-testid=${id}]`).innerText().catch(() => '')
        for (const word of words) if (!text.includes(word)) issues.push(`${id} 缺少「${word}」`)
      }
      if (await tab.locator('[data-testid=home-pending-count]').count()) issues.push('没有待处理时不该有角标')
      issues.push(...(await touchIssues(tab)), ...(await overflowIssues(tab)))
      return issues
    },
  },

  'home-errors': {
    // 个别块失败只影响那一块:最近编辑与共享动态各失败一次 → 各自报错并可重试,别的块照常;重试后恢复
    route: '/home',
    ready: '[data-testid=home-recent-error]',
    fixture: homeFixture(
      { __capabilityError: { list_collections: { status: 503, message: '服务暂时不可用', times: 1 } } },
      { fail: { shared_with_me: { status: 500, message: 'internal: boom', times: 1 } } },
    ),
    settle: 800,
    expectConsole: /503|500|Failed to load resource/,
    assert: async (tab) => {
      const issues = []
      if (!(await tab.locator('[data-testid=home-shared-error]').count())) issues.push('共享动态失败应显示报错')
      if (!(await tab.locator('[data-testid=home-pending-item]').count())) issues.push('最近编辑和共享失败时,待处理应照常显示')
      if ((await tab.locator('[data-testid=home-stats] .metric').count()) !== 4) issues.push('统计卡应照常显示')
      const text = await tab.locator('[data-testid=home-recent-error]').innerText()
      if (!text.includes('重试')) issues.push('可恢复的错误应给「重试」')
      await tab.locator('[data-testid=home-recent-error] button').click()
      await tab.waitForSelector('[data-testid=home-recent-item]')
      if (await tab.locator('[data-testid=home-recent-error]').count()) issues.push('重试成功后报错应消失')
      await tab.locator('[data-testid=home-shared-error] button').click()
      await tab.waitForSelector('[data-testid=home-shared-item]')
      issues.push(...(await touchIssues(tab)), ...(await overflowIssues(tab)))
      return issues
    },
  },

  'home-ai-off': {
    // AI 总开关关掉:首页任何位置都不出现「AI」字样,也没有 AI 用量卡和审核草稿
    route: '/home',
    ready: '[data-testid=home-recent-item]',
    fixture: homeFixture({ __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('ai.') && id !== 'search.deep'), false) } }),
    assert: async (tab) => {
      const issues = []
      const body = await tab.evaluate(() => document.querySelector('[data-testid=home]').innerText)
      if (/AI/i.test(body)) issues.push(`AI 关闭后首页不该出现「AI」,出现在:${body.match(/.{0,12}AI.{0,12}/i)?.[0]}`)
      if (await tab.locator('[data-testid=home-ai]').count()) issues.push('AI 关闭后不该有 AI 用量卡')
      if (await tab.locator('[data-testid=home-pending-item][data-kind=review]').count()) issues.push('AI 关闭后待处理里不该有草稿审核')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'home-no-features': {
    // 角色只有最基本的功能:没有新建 / 导入按钮,没有快速开始,不请求好友和访问申请,页面不崩
    route: '/home',
    ready: '[data-testid=home]',
    fixture: homeFixture({ __me: { local: false, user: adminMe(['search.basic'], true) } }),
    settle: 800,
    assert: async (tab) => {
      const issues = []
      for (const id of ['home-new', 'home-import', 'home-quick']) if (await tab.locator(`[data-testid=${id}]`).count()) issues.push(`没有对应功能时不该有 ${id}`)
      if (await tab.locator('[data-testid=home-pending-item][data-kind=friend]').count()) issues.push('没有好友功能时不该有好友申请')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'home-light': {
    // 浅色主题下同样没有溢出,文字在卡片里读得清(对比度由 lint 的 check-contrast 兜底)
    route: '/home',
    ready: '[data-testid=home-recent-item]',
    fixture: homeFixture(),
    init: lightTheme,
    assert: async (tab) => overflowIssues(tab),
  },
}
