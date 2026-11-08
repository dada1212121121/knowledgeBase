// AI 助手(.7)的页面场景:由 viewer-shots.mjs 引入,默认跑 core 五个尺寸 × 两个引擎。
// 抽屉与独立页面是同一个组件:页面铺满内容区、宽屏左边常驻会话列表、手机占满页面;抽屉能「全屏打开」;
// 排队提示(acp.queued)、代理工作目录占用(满了拦住)、AI 关闭时页面显示没有开通。
import { ALL_FEATURES, adminMe, pushLive } from './fixture.mjs'
import { overflowIssues } from './admin-scenarios.mjs'
import { smallTargets } from './share-scenarios.mjs'

const MB = 1024 * 1024
// workspace_enforced: true = 受限账号(spaces/<id>/ 下的用户),服务端会对它拦工作目录超限;主知识库账号是 false
const AGENTS = { agents: [{ id: 'deepseek', name: 'DeepSeek', available: true }], default: 'deepseek', workspace_mb: 512, workspace_enforced: true }
const SESSIONS = {
  sessions: [
    { session_id: 's1', title: '梳理检索模块', project: 'knowledgeBase', backend: 'acp', pinned: true, created_at: Date.UTC(2026, 9, 19, 6, 0), last_at: Date.UTC(2026, 9, 20, 6, 0), messages: 12 },
    { session_id: 's2', title: '整理上周的笔记', project: '', backend: 'acp', pinned: false, created_at: Date.UTC(2026, 9, 18, 6, 0), last_at: Date.UTC(2026, 9, 19, 6, 0), messages: 4 },
  ],
}
const usage = (workspaceMb) => ({ storage: { sources_bytes: 0, uploads_bytes: 0, vectors_bytes: 0, meta_bytes: 0, workspace_bytes: workspaceMb * MB, total_bytes: workspaceMb * MB, limit_bytes: 0 }, ai: { day: '2026-10-20', tokens_today: 0, limit: 0 } })
const base = (extra = {}) => ({ acp_agents: AGENTS, agent_sessions: SESSIONS, usage_mine: usage(100), ...extra })
const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))

export const ASSISTANT_SCENARIOS = {
  'assistant-page': {
    // 独立页面:铺满内容区(不是浮层),输入框贴底;宽屏左边常驻会话列表,窄屏收起;显示代理工作目录占用
    route: '/assistant',
    ready: '[data-testid=assistant-page]',
    fixture: base(),
    settle: 700,
    assert: async (tab, size) => {
      const issues = []
      const root = await tab.locator('[data-testid=assistant-page]').boundingBox()
      const position = await tab.locator('[data-testid=assistant-page]').evaluate((el) => getComputedStyle(el).position)
      if (position === 'fixed') issues.push('页面模式不该是浮层(fixed)')
      if (!root || root.height < size.height * 0.5) issues.push(`页面应占满内容区,实际高 ${Math.round(root?.height ?? 0)}`)
      const sessions = await tab.locator('[data-testid=assistant-page] .kb-agent-sessions').count()
      if (size.width >= 840 && !sessions) issues.push('宽屏应常驻会话列表')
      if (size.width < 840 && sessions) issues.push('窄屏会话列表应收起')
      if (size.width >= 840 && !(await tab.locator('.kb-agent-sessions').innerText()).includes('梳理检索模块')) issues.push('会话列表应列出历史会话')
      // 输入框贴在页面底部、在屏幕内(手机上在标签栏上面)
      const foot = await tab.locator('[data-testid=assistant-page] .kb-agent-foot').boundingBox()
      if (!foot || foot.y + foot.height > size.height + 1) issues.push('输入区应完整在屏幕内')
      const tabbar = await tab.locator('[data-testid=tabbar]').boundingBox().catch(() => null)
      if (tabbar && foot && foot.y + foot.height > tabbar.y + 1) issues.push('手机上输入区不该被底部标签栏挡住')
      const hint = await tab.locator('[data-testid=assistant-workspace]').innerText().catch(() => '')
      if (hint !== '代理工作目录已用 100 MB / 上限 512 MB') issues.push(`应显示工作目录占用,实际「${hint}」`)
      if (await tab.locator('[data-testid=assistant-drawer]').count()) issues.push('在 /assistant 页面上不该再弹出抽屉')
      if (await tab.locator('[data-testid=assistant-page] [aria-label=收起]').count()) issues.push('页面模式不该有「收起」')
      const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
      if (coarse) for (const item of await smallTargets(tab, '[data-testid=assistant-page] .kb-agent-head button')) issues.push(`触屏可点区域不足 44px:${item}`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'assistant-expand': {
    // 抽屉里点「全屏打开」:收起抽屉、去 /assistant,同一个会话
    route: '/home',
    ready: '[data-testid=home]',
    fixture: base(),
    settle: 400,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-feature="ai.assistant"]').first().click()
      await tab.waitForSelector('[data-testid=assistant-drawer]', { timeout: 5000 }).catch(() => issues.push('点 AI 按钮应打开抽屉'))
      await tab.locator('[data-testid=assistant-expand]').click()
      await tab.waitForURL(/\/assistant/, { timeout: 8000 }).catch(() => issues.push('「全屏打开」应去 /assistant'))
      await tab.waitForSelector('[data-testid=assistant-page]', { timeout: 8000 }).catch(() => issues.push('应显示独立页面'))
      if (await tab.locator('[data-testid=assistant-drawer]').count()) issues.push('全屏打开后抽屉应收起')
      return issues
    },
  },

  'assistant-queue': {
    // 全站代理名额满了:后端推 acp.queued,输入框上方显示前面还有几个人
    route: '/assistant',
    ready: '[data-testid=assistant-page]',
    fixture: base({ __live: true, __hold: { acp_chat: 15_000 }, acp_chat: { session_id: 's9', text: '好的', trace: [], stop_reason: 'end' } }),
    settle: 500,
    assert: async (tab) => {
      const issues = []
      await tab.locator('.kb-composer-textarea').fill('帮我看看检索模块')
      await tab.locator('[aria-label=发送]').click()
      await tab.waitForTimeout(300)
      pushLive(tab.context(), { type: 'acp.queued', data: { ahead: 2 } })
      await tab.waitForSelector('[data-testid=assistant-queue]', { timeout: 5000 }).catch(() => issues.push('排队时应显示排队提示'))
      const text = await tab.locator('[data-testid=assistant-queue]').innerText().catch(() => '')
      if (!text.includes('前面还有 2 个人')) issues.push(`排队提示应写前面还有 2 个人,实际「${text}」`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'assistant-workspace-full': {
    // 代理工作目录满了:提示原因,发送按钮置灰
    route: '/assistant',
    ready: '[data-testid=assistant-page]',
    fixture: base({ usage_mine: usage(600) }),
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('[data-testid=assistant-workspace]').innerText().catch(() => '')
      if (!text.includes('满了')) issues.push(`应提示工作目录满了,实际「${text}」`)
      await tab.locator('.kb-composer-textarea').fill('还想问')
      if (!(await tab.locator('[aria-label=发送]').isDisabled())) issues.push('满了时发送按钮应置灰')
      return issues
    },
  },

  'assistant-workspace-unenforced': {
    // 服务端不对这个账号拦(主知识库账号):超过上限也只说用了多少,发送按钮不置灰;界面不能比服务端更严
    route: '/assistant',
    ready: '[data-testid=assistant-page]',
    fixture: base({ acp_agents: { ...AGENTS, workspace_enforced: false }, usage_mine: usage(600) }),
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('[data-testid=assistant-workspace]').innerText().catch(() => '')
      if (text.includes('满了') || text.includes('上限')) issues.push(`不受限账号不该写满了 / 上限,实际「${text}」`)
      await tab.locator('.kb-composer-textarea').fill('还想问')
      if (await tab.locator('[aria-label=发送]').isDisabled()) issues.push('不受限账号超了也不该置灰发送')
      return issues
    },
  },

  'assistant-off': {
    // AI 关闭 / 没有 ai.assistant:直接打开 /assistant 显示没有开通,不渲染助手、不请求代理
    route: '/assistant',
    ready: '[data-testid=assistant-off]',
    fixture: base({ __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('ai.') && id !== 'search.deep'), false) } }),
    assert: async (tab) => {
      const issues = []
      if (!(await tab.locator('[data-testid=assistant-off]').innerText()).includes('没有开通')) issues.push('应写没有开通')
      if (await tab.locator('[data-testid=assistant-page], [data-testid=assistant-drawer]').count()) issues.push('不该渲染助手')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'assistant-light': {
    route: '/assistant',
    ready: '[data-testid=assistant-page]',
    fixture: base(),
    init: lightTheme,
    assert: async (tab) => overflowIssues(tab),
  },
}
