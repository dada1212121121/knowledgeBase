// 管理组五页(系统概览 / 用户与权限 / 系统参数 / 存储与用量 / 审计与批次)的场景:
// 正常 / 空 / 加载 / 出错(可重试)/ 无权限 / 浅色 / AI 总开关关闭 / 危险操作确认。
// 评测、系统状态、项目与集合、系统设置各有自己的场景(admin-pages-scenarios.mjs、settings-scenarios.mjs),这里不重复。
// 经 viewer-shots.mjs 引入;默认跑 core 五个尺寸,KB_ENGINE=webkit 换引擎。
import { ALL_FEATURES, NOW, adminMe } from './fixture.mjs'
import { meWithout, overflowIssues } from './admin-scenarios.mjs'
import { smallTargets } from './share-scenarios.mjs'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))
const aiOffMe = { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('ai.') && id !== 'search.deep'), false) }
const bodyText = (tab) => tab.evaluate(() => document.body.innerText)
const normalize = (text) => text.replace(/\s+/g, ' ')
/** 页面上所有 title / aria-label / placeholder 拼起来(AI 关闭后这些属性里也不能有「AI」) */
const attrText = (tab) =>
  tab.evaluate(() =>
    [...document.querySelectorAll('[title],[aria-label],[placeholder]')]
      .map((el) => `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''}`)
      .join(' '),
  )
/** AI 总开关关闭:文字和属性里都不能有「AI」 */
async function noAi(tab, where) {
  const issues = []
  const text = await bodyText(tab)
  const hit = text.match(/[\s\S]{0,12}\bAI\b[\s\S]{0,12}/)?.[0]
  if (hit) issues.push(`${where}:AI 关闭后文字里不该出现「AI」,出现在「${normalize(hit)}」`)
  const attrs = await attrText(tab)
  const attrHit = attrs.match(/[\s\S]{0,12}\bAI\b[\s\S]{0,12}/)?.[0]
  if (attrHit) issues.push(`${where}:AI 关闭后 title / aria-label / 占位符里不该出现「AI」,出现在「${normalize(attrHit)}」`)
  return issues
}
/** 界面上不该露的内部词(键名只会出现在 title 里,不进 innerText) */
const INTERNAL = /(?<![-\w])sidecar(?![-\w])|LanceDB|\bInsights\b|\bhit@|\bMRR\b|\bP95\b|\bLLM\b|\btoken\b|\brerank\b|save_insight|git_commit|usr_[0-9a-f]{6}|role_user|invite:|\bUTC\+8\b/
const internalIssues = (text, where) => {
  const hit = text.match(INTERNAL)
  return hit ? [`${where}里出现了不该露的内部词「${hit[0]}」`] : []
}
async function coarse(tab) {
  return tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
}
async function touchIssues(tab, selector, what) {
  if (!(await coarse(tab))) return []
  return (await smallTargets(tab, selector)).map((item) => `${what}触屏可点区域不足 44px:${item}`)
}
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
/** 弹层整体在屏幕里(手机上是底部弹层 / 确认框,不能被裁掉) */
async function inViewport(tab, selector, size, what) {
  const box = await tab.locator(selector).first().boundingBox()
  if (!box) return [`${what}不可见`]
  const out = []
  if (box.x < -1 || box.x + box.width > size.width + 1) out.push(`${what}左右超出屏幕:x=${Math.round(box.x)} w=${Math.round(box.width)}`)
  if (box.y < -1 || box.y + box.height > size.height + 1) out.push(`${what}上下超出屏幕:y=${Math.round(box.y)} h=${Math.round(box.height)}`)
  return out
}

// ---------------------------------------------------------------- 可控的失败与挂起(admin-pages-scenarios 里的同名工具是私有的,这里各取所需)

const switches = new WeakMap()
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
/** 某个能力的响应晚 ms 毫秒才回来:先等页面第一次读完,再 reload 并在响应提交后立刻去看加载中的样子 */
function delayed(name, ms = 1500) {
  return async (context) => {
    await context.route(new RegExp(`/capabilities/${name}(\\?|$)`), async (route) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      await route.fallback()
    })
  }
}
/** 重新载入,只等响应提交就返回(配合 delayed 看加载态) */
const reloadQuick = (tab) => tab.reload({ waitUntil: 'commit' })
const together = (...hooks) => async (context) => {
  for (const hook of hooks) await hook(context)
}

// ---------------------------------------------------------------- 夹具(形状与真实后端一致:事件种类是 git_commit 这类,能力名是 save_insight 这类)

const job = (id, kind, collection, state, over = {}) => ({
  id,
  kind,
  collection,
  state,
  progress_done: state === 'running' ? 64 : 100,
  progress_total: 100,
  created_at: NOW - 30 * MINUTE,
  started_at: NOW - 20 * MINUTE,
  finished_at: state === 'done' || state === 'failed' ? NOW - 5 * MINUTE : null,
  detail: null,
  error: null,
  ...over,
})
const overviewStats = {
  collections: [
    { name: 'knowledgeBase/insights', rows: 482 },
    { name: 'knowledgeBase/code', rows: 3114 },
    { name: 'SampleApp/docs', rows: 912 },
  ],
  totals: { rows: 12438, insights: 1206, projects: 3 },
  jobs: { queued: 1, running: 1, paused: 0, done: 4, failed: 1, canceled: 0 },
  drafts_pending: 7,
  embedder: { id: 'bge-m3', dim: 1024, state: 'ready', error: null },
  reranker: { mode: 'local', available: true },
  recent_events: [
    { id: 'ev_1', kind: 'git_commit', project_id: null, payload_json: '{}', received_at: NOW - 3 * MINUTE, processed_at: null, result: null },
    { id: 'ev_2', kind: 'session_end', project_id: null, payload_json: '{}', received_at: NOW - 9 * MINUTE, processed_at: null, result: null },
  ],
  activity_7d: [{ day: '2026-10-20', collection: 'knowledgeBase/insights', insights: 18 }],
}
const overviewAudit = {
  entries: [
    { id: 1, at: NOW - 2 * MINUTE, actor: 'usr_0123456789abcdef', capability: 'save_insight', args_json: '{"id":"ins_8f21","embedder":"bge-m3"}', ok: true, error: null, batch_id: 'bat_1', dry_run: false },
    { id: 2, at: NOW - 4 * MINUTE, actor: 'mcp:Claude Code', capability: 'agent_send', args_json: '{}', ok: true, error: null, batch_id: null, dry_run: false },
    { id: 3, at: NOW - 6 * MINUTE, actor: 'usr_0123456789abcdef', capability: 'search_knowledge', args_json: '{"query":"重试","took_ms":41}', ok: true, error: null, batch_id: null, dry_run: false },
  ],
  total: 3,
}
const overviewComponents = {
  overview: { components_ready: [4, 5] },
  resources: { cpu: { busy_ratio: 0.2 }, gpu: { name: 'Intel UHD', utilization: 0.38 } },
  components: [
    { kind: 'embed', name: 'bge-m3', installed: true, ready: true, current: true, detail: 'iGPU', model: null },
    { kind: 'rerank', name: 'bge-reranker-v2-m3', installed: true, ready: true, current: true, detail: 'iGPU', model: null },
    { kind: 'llm', name: 'deepseek-chat', installed: true, ready: true, current: true, detail: 'API', model: null },
    { kind: 'sidecar', name: 'onnx-sidecar :7071', installed: true, ready: true, current: false, detail: 'pid 4182', model: null },
    { kind: 'review', name: 'qwen2.5-14b', installed: true, ready: false, current: true, detail: '未加载', model: null },
  ],
}
const overviewStory = {
  stats_overview: overviewStats,
  job_list: { jobs: [job('j1', 'reindex', 'SampleApp/docs', 'running'), job('j2', 'evolve', 'knowledgeBase/insights', 'queued'), job('j3', 'ingest', 'knowledgeBase/code', 'done'), job('j4', 'embed', 'SampleApp/docs', 'failed')] },
  audit_list: overviewAudit,
  system_status: overviewComponents,
  eval_history: { runs: [{ at: NOW - HOUR, hit_at_k: 0.96, k: 5, mrr: 0.927 }] },
}

export const ADMIN_FLOW_SCENARIOS = {
  // ================================================================ 系统概览
  'a7-overview': {
    // 正常:没有内部词;集合 / 任务 / 事件三张卡不是 table,行是按钮;「模型运行服务」不压到名字上;手机无横向溢出
    route: '/admin/overview',
    ready: '.kb-ov-item',
    fixture: overviewStory,
    settle: 600,
    assert: async (tab, size) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await bodyText(tab)
      issues.push(...internalIssues(text, '系统概览'))
      for (const word of ['内容片段', '笔记', '慢查询耗时', '前 5 条命中率', '平均排名得分', '模型与组件', '重建索引', '提交了代码', '保存笔记', '已建好', '待审核草稿']) {
        if (!text.includes(word)) issues.push(`缺少「${word}」`)
      }
      // 原来页头那个点了没用的 30 / 90 天已经去掉;现在 30 / 90 天只会出现在「活动趋势」卡的范围切换里(点了会重新取数)
      const stray = await tab.evaluate(() => [...document.querySelectorAll('.content *')].filter((el) => el.children.length === 0 && /^(30|90) 天$/.test(el.textContent.trim()) && !el.closest('[data-testid=activity-trend]')).length)
      if (stray) issues.push('不该有点了没用的 30 / 90 天(只允许在活动趋势卡里)')
      if (!(await tab.locator('[data-testid=activity-trend] .kb-line-path').count())) issues.push('活动趋势卡应画出线')
      if (!(await tab.locator('[data-testid=ov-resources] [role=img]').count())) issues.push('本机资源卡应至少有一个仪表')
      if (await tab.locator('.content table').count()) issues.push('概览里不该再用 table(手机上会被拆成错位的卡片)')
      if (!(await tab.locator('button.kb-ov-item').count())) issues.push('集合 / 任务行应是按钮')
      // 组件标签列不能压到名字上:量标签**文字**的右边(标签元素本身被固定宽度框住,文字溢出时它的盒子不会变宽)
      const overlap = await tab.evaluate(() => {
        const out = []
        for (const row of document.querySelectorAll('.kb-model-row')) {
          const label = row.querySelector('.kb-model-label')
          const name = row.querySelector('.mono')?.getBoundingClientRect()
          if (!label || !name) continue
          const range = document.createRange()
          range.selectNodeContents(label)
          if (range.getBoundingClientRect().right > name.left + 0.5) out.push(label.textContent.trim())
        }
        return out
      })
      if (overlap.length) issues.push(`组件标签压到了名字:${overlap.join('、')}`)
      issues.push(...(await touchIssues(tab, 'button.kb-ov-item', '概览的行')))
      if (size.width < 640) {
        // 手机:集合行里名字在上、行数 / 进度在下,不是挤在一行
        const stacked = await tab.evaluate(() => {
          const item = document.querySelector('button.kb-ov-coll')
          const name = item?.querySelector('.kb-ov-name')?.getBoundingClientRect()
          const num = item?.querySelector('.kb-ov-num')?.getBoundingClientRect()
          return !!name && !!num && num.top >= name.bottom - 1
        })
        if (!stacked) issues.push('手机上集合行应是两行(名字一行、行数和进度一行)')
      }
      return issues
    },
  },

  'a7-overview-many-projects': {
    // 项目很多、名字很长时:「近 7 天新增笔记」标题不能被挤成竖排,图例不能溢出卡片压到右边的卡片(用户真机截图:10 个项目)
    route: '/admin/overview',
    ready: '.kb-ov-item',
    fixture: {
      ...overviewStory,
      list_projects: {
        projects: ['sampleERP', 'audit-system', 'SampleApp', 'devkit', 'EA', 'knowledgeBase', 'sampleproj', 'review_materials', 'a-very-long-project-name-that-wraps'].map((name, index) => ({
          project: { id: `px${index}`, name, slug: name.toLowerCase(), root_path: `/srv/workspace/${name}`, include: [], exclude: [], is_git: true, last_commit: null, last_indexed_at: NOW, allow_cloud_llm: false, extract_enabled: false, hooks_installed: false, created_at: NOW },
          collection: `proj_${name}`,
          rows: 100 + index,
        })),
      },
    },
    settle: 700,
    assert: async (tab) => {
      const issues = []
      const info = await tab.evaluate(() => {
        const card = document.querySelector('[data-testid=activity-legend]')?.closest('.card')
        const title = card?.querySelector('.kb-ch-title')
        const legend = card?.querySelector('[data-testid=activity-legend]')
        const lineHeight = title ? parseFloat(getComputedStyle(title).lineHeight) || 20 : 20
        const c = card?.getBoundingClientRect()
        const l = legend?.getBoundingClientRect()
        const titleBox = title?.getBoundingClientRect()
        return {
          has: !!card,
          titleLines: titleBox ? Math.round(titleBox.height / lineHeight) : 0,
          legendOverflow: l && c ? Math.max(l.right - c.right, c.left - l.left, 0) : 0,
          items: [...(legend?.querySelectorAll('.kb-legend-item') ?? [])].map((el) => {
            const r = el.getBoundingClientRect()
            return r.right - (c?.right ?? 0)
          }),
          docOverflow: document.documentElement.scrollWidth - window.innerWidth,
        }
      })
      if (!info.has) return ['找不到图例']
      if (info.titleLines > 1) issues.push(`「近 7 天新增笔记」被挤成 ${info.titleLines} 行`)
      if (info.legendOverflow > 1) issues.push(`图例溢出卡片 ${Math.round(info.legendOverflow)}px`)
      if (info.items.some((over) => over > 1)) issues.push('有图例项伸出卡片右边')
      if (info.docOverflow > 1) issues.push(`整页横向溢出 ${info.docOverflow}px`)
      return issues
    },
  },

  'a7-overview-keyboard': {
    // 键盘:Tab 能走到集合行,焦点可见(有描边),Enter 打开对应集合
    route: '/admin/overview',
    ready: '.kb-ov-item',
    fixture: overviewStory,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      await tab.locator('button.kb-ov-coll').first().focus()
      const ring = await tab.evaluate(() => {
        const el = document.activeElement
        const style = getComputedStyle(el)
        return { tag: el.className, shadow: style.boxShadow, outline: style.outlineStyle }
      })
      if (!String(ring.tag).includes('kb-ov-item')) issues.push(`焦点应落在集合行上,实际 ${ring.tag}`)
      if (ring.shadow === 'none' && ring.outline === 'none') issues.push('获得焦点的行应有可见的焦点环')
      await tab.keyboard.press('Enter')
      await tab.waitForURL(/\/kb\?collection=/, { timeout: 4000 }).catch(() => issues.push(`按 Enter 应打开集合,当前 ${tab.url()}`))
      return issues
    },
  },

  'a7-overview-loading': {
    // 加载:stats_overview 回得慢 —— 骨架屏,不是一排 0,也不写「读取中…」;读完换成内容
    route: '/admin/overview',
    ready: '.kb-ov-item',
    fixture: { ...overviewStory, __after: delayed('stats_overview') },
    settle: 100,
    assert: async (tab) => {
      const issues = []
      await reloadQuick(tab)
      await tab.waitForSelector('[data-testid=admin-loading]', { timeout: 8000 })
      const text = await bodyText(tab)
      if (text.includes('读取中')) issues.push('不该写「读取中…」')
      issues.push(...(await overflowIssues(tab)))
      await tab.waitForSelector('.kb-ov-item', { timeout: 10_000 })
      return issues
    },
  },

  'a7-overview-error': {
    // 出错:整页写原因 + 重试;点重试恢复
    route: '/admin/overview',
    ready: '[data-testid=admin-error]',
    fixture: { ...overviewStory, __after: failing('stats_overview') },
    expectConsole: /503|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = normalize(await tab.locator('[data-testid=admin-error]').innerText())
      if (!text.includes('读取系统概览失败') || !text.includes('重试')) issues.push(`报错应说清楚并给「重试」,实际「${text}」`)
      heal(tab, 'stats_overview')
      await tab.locator('[data-testid=admin-error] button', { hasText: '重试' }).click()
      await tab.waitForSelector('.kb-ov-item')
      if (await tab.locator('[data-testid=admin-error]').count()) issues.push('重试成功后报错应消失')
      return issues
    },
  },

  'a7-overview-part-error': {
    // 任务读不到:只有任务卡写「没能读到任务」,其余照常;不把「没读到」说成「队列是空的」
    route: '/admin/overview',
    ready: '.kb-ov-item',
    fixture: { ...overviewStory, __after: failing('job_list') },
    expectConsole: /503|Failed to load resource/,
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await bodyText(tab)
      if (!text.includes('没能读到任务')) issues.push('任务读不到时应写「没能读到任务」')
      if (text.includes('队列是空的')) issues.push('不该把没读到说成队列是空的')
      return issues
    },
  },

  'a7-overview-forbidden': {
    route: '/admin/overview',
    ready: '[data-testid=admin-forbidden]',
    fixture: { ...overviewStory, __after: failing('stats_overview', { status: 403, message: 'forbidden' }) },
    expectConsole: /403|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const box = tab.locator('[data-testid=admin-forbidden]')
      if (!(await box.innerText()).includes('你的账号没有开通这个功能')) issues.push('应说明账号没有开通这个功能')
      if (await box.locator('button').count()) issues.push('没开通时不该给重试')
      return issues
    },
  },

  'a7-overview-ai-off': {
    // AI 总开关关闭:没有待审核草稿、云端模型、审核模型、自动提炼任务、助手事件;任何位置没有「AI」
    route: '/admin/overview',
    ready: '.kb-ov-item',
    fixture: { ...overviewStory, __me: aiOffMe },
    settle: 600,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab)), ...(await noAi(tab, '系统概览'))]
      const text = await bodyText(tab)
      for (const word of ['待审核草稿', '去审核', '云端模型', '审核模型', '自动提炼', '助手对话']) if (text.includes(word)) issues.push(`AI 关闭后不该出现「${word}」`)
      if (!text.includes('索引模型')) issues.push('本机的索引模型应照常显示')
      return issues
    },
  },

  'a7-overview-light': {
    route: '/admin/overview',
    ready: '.kb-ov-item',
    fixture: overviewStory,
    init: lightTheme,
    settle: 500,
    assert: async (tab) => [...(await overflowIssues(tab))],
  },

  'a7-overview-chart-font': {
    // 概览的堆叠柱图是 viewBox 560 宽、width=100% 的 SVG:窄屏上整张图缩小,写死的 font-size=10 在 390 宽手机上只有约 5.8px,读不了。
    // sweep / clipcheck 查的是溢出和被裁,查不出这个,所以单独守:渲染后的字号、文字不出图、相邻日期不重叠
    route: '/admin/overview',
    ready: '.kb-chart-svg',
    fixture: overviewStory,
    settle: 800,
    assert: async (tab) => {
      const issues = []
      const info = await tab.evaluate(() => {
        const svg = document.querySelector('.kb-chart-svg')
        const box = svg.getBoundingClientRect()
        const texts = [...svg.querySelectorAll('text')]
        const px = Math.min(...texts.map((t) => parseFloat(t.getAttribute('font-size')) * (box.width / 560)))
        const outside = texts.filter((t) => { const b = t.getBoundingClientRect(); return b.left < box.left - 0.5 || b.right > box.right + 0.5 }).map((t) => t.textContent)
        const days = texts.filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.getBoundingClientRect())
        let overlap = 0
        for (let i = 1; i < days.length; i += 1) if (days[i].left < days[i - 1].right - 0.5) overlap += 1
        return { px, outside, overlap, count: texts.length }
      })
      if (info.count < 2) issues.push('图里没找到坐标轴文字')
      if (info.px < 10.5) issues.push(`坐标轴文字渲染后只有 ${info.px.toFixed(1)}px,读不了(目标约 11px)`)
      if (info.outside.length) issues.push(`坐标轴文字被画到图外:${info.outside.join('、')}`)
      if (info.overlap) issues.push(`相邻日期标签重叠 ${info.overlap} 处`)
      return issues
    },
    // 320 宽触到字号上限(再大相邻日期会挤),渲染约 10px,这是有意的取舍,不在这里断言
    sizes: ['390x844', '820x1180', '1180x820', '1440x900', '1920x1080'],
  },

  // ================================================================ 用户与权限
  'a7-users-roles': {
    // 角色页:没有内部词(role_user…);AI 开着有 AI 功能点;手机角色是横向药丸;配额编辑器不写 token;触屏可点区域够大
    route: '/admin/users',
    ready: '.kb-ut-detail',
    settle: 500,
    assert: async (tab, size) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await bodyText(tab)
      issues.push(...internalIssues(text, '角色页'))
      if (!text.includes('配额覆盖')) issues.push('缺少「配额覆盖」')
      issues.push(...(await touchIssues(tab, '.kb-ut-tabs button, .kb-ut-role', '页签 / 角色')))
      issues.push(...(await touchIssues(tab, '.kb-ut-feature .sw', '功能开关')))
      if (size.width < 640) {
        const wide = await tab.evaluate(() => document.querySelector('.kb-ut-roles')?.getBoundingClientRect().width ?? 0)
        if (wide > size.width) issues.push(`角色列表比屏幕宽 ${wide}`)
      }
      return issues
    },
  },

  'a7-users-loading': {
    route: '/admin/users',
    ready: '.kb-ut-detail',
    fixture: { __after: delayed('role_list') },
    settle: 100,
    assert: async (tab) => {
      const issues = []
      await reloadQuick(tab)
      await tab.waitForSelector('[data-testid=admin-loading]', { timeout: 8000 })
      if ((await bodyText(tab)).includes('加载中…')) issues.push('不该用「加载中…」文字')
      issues.push(...(await overflowIssues(tab)))
      await tab.waitForSelector('.kb-ut-detail', { timeout: 10_000 })
      return issues
    },
  },

  'a7-users-error': {
    // 角色读不到:整页写原因 + 重试,没有页签和新建按钮;点重试恢复
    route: '/admin/users',
    ready: '[data-testid=admin-error]',
    fixture: { __after: failing('role_list') },
    expectConsole: /503|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = normalize(await tab.locator('[data-testid=admin-error]').innerText())
      if (!text.includes('读取角色和功能失败') || !text.includes('重试')) issues.push(`报错应说清楚并给「重试」,实际「${text}」`)
      if (await tab.locator('.kb-ut-tabs').count()) issues.push('读不到时不该有页签')
      heal(tab, 'role_list')
      await tab.locator('[data-testid=admin-error] button', { hasText: '重试' }).click()
      await tab.waitForSelector('.kb-ut-detail')
      return issues
    },
  },

  'a7-users-forbidden': {
    route: '/admin/users',
    ready: '[data-testid=admin-forbidden]',
    fixture: { __after: failing('role_list', { status: 403, message: 'forbidden' }) },
    expectConsole: /403|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (await tab.locator('[data-testid=admin-forbidden] button').count()) issues.push('没开通时不该给重试')
      return issues
    },
  },

  'a7-users-list-error': {
    // 用户列表读不到:在列表位置报错 + 重试,不是「没有符合条件的用户」
    route: '/admin/users',
    ready: '.kb-ut-detail',
    fixture: { __after: failing('user_list', { initial: false }) },
    expectConsole: /503|Failed to load resource/,
    settle: 300,
    prepare: async (tab) => {
      breakIt(tab, 'user_list')
      await tab.getByRole('tab', { name: '用户' }).click()
      await tab.waitForSelector('[data-testid=admin-error]')
    },
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await bodyText(tab)
      if (!text.includes('读取用户列表失败')) issues.push('应写「读取用户列表失败」')
      if (text.includes('没有符合条件的用户')) issues.push('不该把没读到说成没有符合条件的用户')
      heal(tab, 'user_list')
      await tab.locator('[data-testid=admin-error] button', { hasText: '重试' }).click()
      await tab.waitForSelector('.kb-ut-list')
      return issues
    },
  },

  'a7-users-detail': {
    // 用户详情:注册方式 / 存储是人话;危险操作(重设密码、停用、改成管理员)先确认且写明后果,确认框完整在屏幕里
    route: '/admin/users',
    ready: '.kb-ut-tabs',
    settle: 400,
    prepare: async (tab) => {
      await tab.getByRole('tab', { name: '用户' }).click()
      await tab.waitForSelector('.kb-ut-list')
      await tab.locator('.kb-ut-row', { hasText: 'alice' }).click()
      await tab.waitForSelector('[role=dialog], .kb-dlg')
    },
    assert: async (tab, size) => {
      const issues = [...(await overflowIssues(tab))]
      const detail = await tab.locator('[role=dialog], .kb-dlg').first().innerText()
      issues.push(...internalIssues(detail, '用户详情'))
      if (!/注册方式:/.test(detail)) issues.push('应写「注册方式」')
      issues.push(...(await touchIssues(tab, '.kb-dlg button, [role=dialog] button, .kb-ut-select', '用户详情的按钮 / 下拉框')))
      // 重设密码:先确认
      await tab.locator('.kb-ut-inline input').first().fill('longenough1')
      const reset = tab.waitForRequest((req) => req.url().includes('/capabilities/user_set_password'), { timeout: 1500 }).catch(() => null)
      await tab.getByRole('button', { name: '重设', exact: true }).click()
      await tab.waitForSelector('[role=alertdialog]')
      await settled(tab, '[role=alertdialog]')
      const confirmText = await tab.locator('[role=alertdialog]').innerText()
      for (const word of ['所有设备上的登录都会失效', '记入审计']) if (!confirmText.includes(word)) issues.push(`重设密码的确认里缺「${word}」`)
      if (await reset) issues.push('确认之前不该发出重设密码的请求')
      issues.push(...(await inViewport(tab, '[role=alertdialog]', size, '确认框')))
      issues.push(...(await touchIssues(tab, '[role=alertdialog] button', '确认框按钮')))
      // 键盘:Esc 关掉确认框,什么都不发
      await tab.keyboard.press('Escape')
      await tab.waitForFunction(() => !document.querySelector('[role=alertdialog]'), null, { timeout: 3000 }).catch(() => issues.push('按 Esc 应关掉确认框'))
      if (await tab.locator('[role=alertdialog]').count()) await tab.locator('[role=alertdialog] button', { hasText: '取消' }).first().click()
      await tab.waitForFunction(() => !document.querySelector('[role=alertdialog]'))
      // 停用账号:先确认
      await tab.getByRole('button', { name: '停用账号' }).click()
      await tab.waitForSelector('[role=alertdialog]')
      await settled(tab, '[role=alertdialog]')
      const stopText = await tab.locator('[role=alertdialog]').innerText()
      for (const word of ['退出所有设备', '笔记和文件都保留']) if (!stopText.includes(word)) issues.push(`停用的确认里缺「${word}」`)
      issues.push(...(await inViewport(tab, '[role=alertdialog]', size, '停用确认框')))
      return issues
    },
  },

  'a7-users-ai-off': {
    // AI 总开关关闭:角色页、用户详情、配额里都没有「AI」;AI 功能点和 AI 额度收起
    route: '/admin/users',
    ready: '.kb-ut-detail',
    fixture: { __me: aiOffMe },
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab)), ...(await noAi(tab, '角色页'))]
      const text = await bodyText(tab)
      if (!text.includes('大模型相关的功能已在系统参数里关闭')) issues.push('应说明大模型相关功能已关闭、先收起')
      await tab.getByRole('tab', { name: '用户' }).click()
      await tab.waitForSelector('.kb-ut-list')
      await tab.locator('.kb-ut-row', { hasText: 'alice' }).click()
      await tab.waitForSelector('[role=dialog], .kb-dlg')
      issues.push(...(await noAi(tab, '用户详情')))
      return issues
    },
  },

  'a7-users-light': {
    route: '/admin/users',
    ready: '.kb-ut-detail',
    init: lightTheme,
    settle: 500,
    assert: async (tab) => [...(await overflowIssues(tab))],
  },

  'a7-users-invites': {
    // 邀请码页签:空状态有说明和「生成邀请码」;读不到有重试;触屏按钮 ≥44
    route: '/admin/users',
    ready: '.kb-ut-tabs',
    settle: 400,
    prepare: async (tab) => {
      await tab.getByRole('tab', { name: '邀请码' }).click()
      await tab.waitForSelector('.kb-inv-list')
    },
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      issues.push(...internalIssues(await bodyText(tab), '邀请码'))
      issues.push(...(await touchIssues(tab, '.kb-inv-actions button, .kb-inv-bar button', '邀请码的按钮')))
      return issues
    },
  },

  'a7-users-invites-empty': {
    route: '/admin/users',
    ready: '.kb-ut-tabs',
    fixture: { invite_list: () => ({ invites: [], now: NOW }) },
    settle: 400,
    prepare: async (tab) => {
      await tab.getByRole('tab', { name: '邀请码' }).click()
      await tab.waitForSelector('.kb-empty')
    },
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const empty = normalize(await tab.locator('.kb-empty').innerText())
      if (!empty.includes('还没有邀请码') || !empty.includes('生成后可以发给要邀请的人')) issues.push(`空状态应有说明,实际「${empty}」`)
      if (!(await tab.locator('.kb-empty button', { hasText: '生成邀请码' }).count())) issues.push('空状态应有「生成邀请码」')
      return issues
    },
  },

  'a7-users-invites-error': {
    route: '/admin/users',
    ready: '.kb-ut-tabs',
    fixture: { __after: failing('invite_list', { initial: false }) },
    expectConsole: /503|Failed to load resource/,
    settle: 300,
    prepare: async (tab) => {
      breakIt(tab, 'invite_list')
      await tab.getByRole('tab', { name: '邀请码' }).click()
      await tab.waitForSelector('[data-testid=admin-error]')
    },
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (!(await tab.locator('[data-testid=admin-error]').innerText()).includes('读取邀请码失败')) issues.push('应写「读取邀请码失败」')
      heal(tab, 'invite_list')
      await tab.locator('[data-testid=admin-error] button', { hasText: '重试' }).click()
      await tab.waitForSelector('.kb-inv-list')
      return issues
    },
  },

  // ================================================================ 系统参数
  'a7-params': {
    // 正常:没有内部词(token / LLM / role_user…);默认角色是下拉;数字框有数字键盘;每个控件有名字;触屏 ≥44
    route: '/admin/params',
    ready: '.kb-sp-body',
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await bodyText(tab)
      issues.push(...internalIssues(text, '系统参数'))
      if (/用户管理/.test(text)) issues.push('说明里不该指向不存在的「用户管理」页')
      if (!(await tab.locator('select[aria-label="新用户的默认角色"]').count())) issues.push('默认角色应是下拉')
      const unnamed = await tab.evaluate(() => [...document.querySelectorAll('.kb-sp-row input, .kb-sp-row [role=switch]')].filter((el) => !el.getAttribute('aria-label')).length)
      if (unnamed) issues.push(`${unnamed} 个输入框 / 开关没有名字`)
      issues.push(...(await touchIssues(tab, '.kb-sp-nav button, .kb-sp-select, .kb-sp-row .sw', '参数页的控件')))
      // 横滑的分组导航:相邻按钮不能互相叠住(触屏下 min-width 把按钮压窄过,文字叠在一起)
      const overlap = await tab.evaluate(() => {
        const boxes = [...document.querySelectorAll('.kb-sp-nav button')].map((b) => ({ r: b.getBoundingClientRect(), t: b.textContent.trim(), w: b.scrollWidth }))
        const out = []
        for (let i = 0; i + 1 < boxes.length; i++) if (boxes[i].r.right > boxes[i + 1].r.left + 0.5 && boxes[i].r.top === boxes[i + 1].r.top) out.push(`${boxes[i].t}×${boxes[i + 1].t}`)
        for (const b of boxes) if (b.w > b.r.width + 1) out.push(`${b.t} 文字比按钮宽`)
        return out
      })
      if (overlap.length) issues.push(`分组导航的按钮叠在一起:${overlap.join('、')}`)
      return issues
    },
  },

  'a7-params-ai-off': {
    // AI 总开关关闭:整页(含属性)没有「AI」,只剩总开关一行,能重新打开
    route: '/admin/params',
    ready: '.kb-sp-body',
    fixture: { __me: aiOffMe, get_config: { ai: { enabled: false }, quota: { storage_gb: 100, max_upload_mb: 200, disk_reserve_gb: 30, llm_tokens_per_day: 200000, acp_concurrency_total: 4, acp_concurrency_per_user: 1, acp_minutes: 30, links_per_user: 1000, friends_per_user: 1000 }, accounts: { registration_open: true, require_invite: false, default_role: 'role_user', email_domain_allowlist: [], block_disposable_email: false, deletion_cooling_off_days: 30, invites_per_user: 0, require_admin_totp: false }, index: { parallel_slices: 0 }, network: { crawl_allow_private: false }, share: { allow_guest_view: true, allow_guest_comment: false, allow_guest_edit: false, guest_link_gb_per_day: 5, room_max_users: 10 }, site: { name: 'knowledgeBase', tagline: '个人与团队知识库', public_url: 'https://kb.example.com' } } },
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab)), ...(await noAi(tab, '系统参数'))]
      const text = await bodyText(tab)
      if (!text.includes('启用大模型功能(总开关)')) issues.push('应有中性写法的总开关')
      if (text.includes('每人每天')) issues.push('关闭后不该列额度')
      await tab.locator('.kb-sp-row', { hasText: '启用大模型功能' }).locator('.sw').click()
      await tab.waitForSelector('[data-testid=ai-turning-on]')
      issues.push(...(await noAi(tab, '系统参数(刚打开未保存)')))
      return issues
    },
  },

  'a7-params-risky': {
    // 打开有风险的设置、关闭大模型总开关:保存前先确认并写明后果;确认框完整在屏幕里,取消不保存
    route: '/admin/params',
    ready: '.kb-sp-body',
    settle: 400,
    assert: async (tab, size) => {
      const issues = [...(await overflowIssues(tab))]
      await tab.locator('.kb-sp-row', { hasText: '允许游客编辑' }).locator('.sw').click()
      await tab.waitForSelector('.kb-sp-save')
      const save = tab.waitForRequest((req) => req.url().includes('/capabilities/update_config'), { timeout: 1500 }).catch(() => null)
      await tab.locator('.kb-sp-save .kb-btn.is-primary').click()
      await tab.waitForSelector('[role=alertdialog]')
      await settled(tab, '[role=alertdialog]')
      const text = await tab.locator('[role=alertdialog]').innerText()
      if (!text.includes('确认保存这些有风险的设置?') || !text.includes('所有修改记在「访客」名下')) issues.push(`风险确认的文字不对:${normalize(text).slice(0, 80)}`)
      if (await save) issues.push('确认之前不该发出保存请求')
      issues.push(...(await inViewport(tab, '[role=alertdialog]', size, '确认框')))
      issues.push(...(await touchIssues(tab, '[role=alertdialog] button', '确认框按钮')))
      return issues
    },
  },

  'a7-params-loading': {
    route: '/admin/params',
    ready: '.kb-sp-body',
    fixture: { __after: delayed('get_config') },
    settle: 100,
    assert: async (tab) => {
      const issues = []
      await reloadQuick(tab)
      await tab.waitForSelector('[data-testid=admin-loading]', { timeout: 8000 })
      issues.push(...(await overflowIssues(tab)))
      await tab.waitForSelector('.kb-sp-body', { timeout: 10_000 })
      return issues
    },
  },

  'a7-params-forbidden': {
    route: '/admin/params',
    ready: '[data-testid=admin-forbidden]',
    fixture: { __after: failing('get_config', { status: 403, message: 'forbidden' }) },
    expectConsole: /403|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (await tab.locator('[data-testid=admin-forbidden] button').count()) issues.push('没开通时不该给重试')
      return issues
    },
  },

  'a7-params-light': {
    route: '/admin/params',
    ready: '.kb-sp-body',
    init: lightTheme,
    settle: 500,
    assert: async (tab) => [...(await overflowIssues(tab))],
  },

  // ================================================================ 存储与用量
  'a7-usage-ai-off': {
    // AI 总开关关闭:没有「AI 额度」页签;旧链接 ?tab=ai 回到存储;页头、存储、分享链接三处都没有「AI」
    route: '/admin/usage?tab=ai',
    ready: '[data-testid=storage-panel] .kb-su-stats',
    fixture: { __me: aiOffMe },
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab)), ...(await noAi(tab, '存储'))]
      const tabs = await tab.locator('[data-testid=usage-tabs] [role=tab]').allInnerTexts()
      if (tabs.some((label) => /AI/.test(label))) issues.push(`不该有 AI 页签:${tabs.join('、')}`)
      if (tabs.length !== 2) issues.push(`应只有「存储」「分享链接」两页,实际 ${tabs.length}`)
      await tab.getByRole('tab', { name: '分享链接' }).click()
      await tab.waitForSelector('[data-testid=share-admin-panel] .kb-su-stats')
      issues.push(...(await noAi(tab, '分享链接')))
      return issues
    },
  },

  'a7-usage-ai': {
    // AI 额度页:不写 token;额度日按站点时区计(b9f15e4f 起不再按浏览器本地时区);触屏控件 ≥44
    route: '/admin/usage?tab=ai',
    ready: '[data-testid=llm-panel] .kb-su-stats',
    settle: 500,
    assert: async (tab, size) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await bodyText(tab)
      if (/token/i.test(text)) issues.push('额度页不该写 token')
      // 说明句写的是站点时区,不是死字:默认站点时区 Asia/Shanghai 显示成「北京时间」(换时区见 a7-usage-ai-tz)
      const hint = (await tab.locator('[data-testid=llm-day-hint]').innerText()).replace(/\s+/g, ' ')
      if (!hint.includes('日期按站点时区(北京时间)计,每天 0 点重置额度')) issues.push(`额度日说明应写明按站点时区(北京时间)计,实际 ${hint.slice(0, 60)}`)
      // 表头「今日额度」只在表格里有,手机是卡片
      for (const word of ['榜内合计用量', '两者之和就是已用额度', ...(size.width >= 600 ? ['今日额度'] : [])]) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      issues.push(...(await touchIssues(tab, '[data-testid=usage-tabs] [role=tab], [data-testid=llm-prev], [data-testid=llm-next], .kb-lu-date', '额度页的控件')))
      return issues
    },
  },

  'a7-usage-ai-tz': {
    // 站点时区不是默认值时,额度日说明跟着换成那个时区名,不再写死「北京时间」
    route: '/admin/usage?tab=ai',
    ready: '[data-testid=llm-panel] .kb-su-stats',
    fixture: { __status: () => ({ site: { name: '知识库', tagline: '', timezone: 'America/New_York' } }) },
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const hint = (await tab.locator('[data-testid=llm-day-hint]').innerText()).replace(/\s+/g, ' ')
      if (hint.includes('北京时间')) issues.push(`站点时区是 America/New_York 时不该写北京时间:${hint.slice(0, 60)}`)
      if (!hint.includes('America/New_York')) issues.push(`额度日说明应写出站点时区名,实际 ${hint.slice(0, 60)}`)
      return issues
    },
  },

  'a7-usage-storage': {
    // 存储页:分项叫「代理工作目录」;整盘保护告警(暂停上传)写清现状和下一步;触屏 ≥44
    route: '/admin/usage',
    ready: '[data-testid=storage-panel] .kb-su-stats',
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await bodyText(tab)
      if (text.includes('AI 工作区')) issues.push('分项应叫「代理工作目录」')
      if (!text.includes('代理工作目录')) issues.push('缺少「代理工作目录」')
      issues.push(...internalIssues(text, '存储'))
      issues.push(...(await touchIssues(tab, '[data-testid=usage-tabs] [role=tab], .kb-su-bar button, .kb-su-bar .sw', '存储页的控件')))
      return issues
    },
  },

  'a7-usage-loading': {
    route: '/admin/usage',
    ready: '[data-testid=storage-panel] .kb-su-stats',
    fixture: { __after: delayed('storage_overview') },
    settle: 100,
    assert: async (tab) => {
      const issues = []
      await reloadQuick(tab)
      await tab.waitForSelector('[data-testid=admin-loading]', { timeout: 8000 })
      issues.push(...(await overflowIssues(tab)))
      await tab.waitForSelector('[data-testid=storage-panel] .kb-su-stats', { timeout: 10_000 })
      return issues
    },
  },

  // ================================================================ 审计与批次
  'a7-audit': {
    // 审计日志:操作、操作者、详情都是中文,没有能力名 / 用户 id / JSON;手机是卡片;筛选框完整可点
    route: '/admin/audit',
    ready: '[data-testid=audit-panel] .kb-ap-card',
    fixture: { audit_list: { entries: overviewAudit.entries.map((entry) => ({ ...entry, batch_id: entry.batch_id })), total: 3, page_size: 24, offset: 0 } },
    settle: 500,
    assert: async (tab, size) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await bodyText(tab)
      issues.push(...internalIssues(text, '审计日志'))
      for (const word of ['保存笔记', '助手对话', '搜索', '编号 ins_8f21', '查询「重试」', 'MCP 客户端 Claude Code']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      if (/"id"|embedder|search_knowledge|agent_send/.test(text)) issues.push('不该露能力名 / 参数 JSON')
      const cards = await tab.locator('[data-testid=rt-card]').count()
      const rows = await tab.locator('[data-testid=rt-row]').count()
      if (size.width < 600 && rows) issues.push(`手机上审计日志不该是表格行,实际 ${rows} 行`)
      if (size.width >= 600 && cards) issues.push(`平板 / 电脑上审计日志不该是卡片,实际 ${cards} 张`)
      // 筛选框完整可见、够大(以前手机上被压成一条缝)
      const box = await tab.locator('.kb-ap-bar .kb-select > button').boundingBox()
      if (!box || box.height < 28 || box.x < -1 || box.x + box.width > size.width + 1) issues.push(`筛选框被压扁或超出屏幕:${JSON.stringify(box)}`)
      issues.push(...(await touchIssues(tab, '.kb-ap-bar .kb-select > button', '审计筛选')))
      // 没有值的行不占位(设计稿):手机卡片里不留「所属批次 —」「详情 —」;桌面表格保留「—」,列才对得齐
      const dashes = await tab.evaluate(() => [...document.querySelectorAll('[data-testid=rt-card] .kb-rt-meta dd, [data-testid=rt-row] td')].filter((el) => el.textContent.trim() === '—').length)
      if (size.width < 600 && dashes) issues.push(`手机卡片里不该有只写「—」的行,实际 ${dashes} 行`)
      if (size.width >= 600 && !dashes) issues.push('桌面表格里没有值的单元格仍应写「—」,实际一个都没有')
      return issues
    },
  },

  'a7-audit-empty': {
    route: '/admin/audit',
    ready: '[data-testid=audit-empty]',
    fixture: { audit_list: { entries: [], total: 0, page_size: 24, offset: 0 } },
    settle: 300,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = normalize(await tab.locator('[data-testid=audit-empty]').innerText())
      if (!text.includes('还没有调用记录') || !text.includes('方便事后追查')) issues.push(`空状态应有说明,实际「${text}」`)
      return issues
    },
  },

  'a7-audit-error': {
    // 读不到:写原因 + 重试(以前停在骨架屏);点重试恢复
    route: '/admin/audit',
    ready: '[data-testid=admin-error]',
    fixture: { __after: failing('audit_list') },
    expectConsole: /503|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      const text = normalize(await tab.locator('[data-testid=admin-error]').innerText())
      if (!text.includes('读取审计日志失败') || !text.includes('重试')) issues.push(`报错应说清楚并给「重试」,实际「${text}」`)
      if (await tab.locator('[data-testid=admin-loading]').count()) issues.push('不该停在骨架屏')
      heal(tab, 'audit_list')
      await tab.locator('[data-testid=admin-error] button', { hasText: '重试' }).click()
      await tab.waitForSelector('[data-testid=audit-panel] .kb-ap-card')
      return issues
    },
  },

  'a7-audit-forbidden': {
    route: '/admin/audit',
    ready: '[data-testid=admin-forbidden]',
    fixture: { __after: failing('audit_list', { status: 403, message: 'forbidden' }) },
    expectConsole: /403|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab))]
      if (await tab.locator('[data-testid=admin-forbidden] button').count()) issues.push('没开通时不该给重试')
      return issues
    },
  },

  'a7-audit-loading': {
    route: '/admin/audit',
    ready: '[data-testid=audit-panel] .kb-ap-card',
    fixture: { __after: delayed('audit_list') },
    settle: 100,
    assert: async (tab) => {
      const issues = []
      await reloadQuick(tab)
      await tab.waitForSelector('[data-testid=admin-loading]', { timeout: 8000 })
      issues.push(...(await overflowIssues(tab)))
      await tab.waitForSelector('[data-testid=audit-panel] .kb-ap-card', { timeout: 10_000 })
      return issues
    },
  },

  'a7-batches-revert': {
    // 批次:说明是中文;点「撤销整批」先确认,写明范围和后果,确认框完整在屏幕里,触屏 ≥44;取消后不撤销
    route: '/admin/audit?tab=batches',
    ready: '[data-testid=batch-panel] .kb-bp-card',
    fixture: {
      batch_list: {
        total: 2,
        page_size: 20,
        offset: 0,
        batches: [
          { id: 'bat_1002', actor: 'usr_0123456789abcdef', description: 'edit_item 调用', created_at: NOW - 10 * MINUTE, reverted_at: null, changes: [{ seq: 1, target: 'ins_1', op: 'insight.update', revertible: true }, { seq: 2, target: 'ins_2', op: 'insight.update', revertible: true }] },
          { id: 'bat_1001', actor: 'mcp:Claude Code', description: 'save_insight 调用', created_at: NOW - HOUR, reverted_at: NOW - 30 * MINUTE, changes: [{ seq: 1, target: 'ins_3', op: 'insight.create', revertible: true }] },
        ],
      },
    },
    settle: 400,
    assert: async (tab, size) => {
      const issues = [...(await overflowIssues(tab))]
      const text = await bodyText(tab)
      issues.push(...internalIssues(text, '批次'))
      if (/edit_item|save_insight/.test(text)) issues.push('批次说明不该露能力名')
      for (const word of ['修改内容', '保存笔记', '可撤销', '已撤销']) if (!text.includes(word)) issues.push(`缺少「${word}」`)
      if ((await tab.locator('[data-testid=batch-revert]').count()) !== 1) issues.push('只有可撤销的批次有「撤销整批」')
      issues.push(...(await touchIssues(tab, '[data-testid=batch-revert]', '撤销按钮')))
      const revert = tab.waitForRequest((req) => req.url().includes('/capabilities/revert_batch'), { timeout: 1500 }).catch(() => null)
      await tab.locator('[data-testid=batch-revert]').click()
      await tab.waitForSelector('[role=alertdialog]')
      await settled(tab, '[role=alertdialog]')
      const confirmText = await tab.locator('[role=alertdialog]').innerText()
      for (const word of ['撤销批次「修改内容」?', '2 项改动会恢复', '不能再次撤销', '记入审计', '先不撤销']) if (!confirmText.includes(word)) issues.push(`撤销确认里缺「${word}」`)
      if (await revert) issues.push('确认之前不该发出撤销请求')
      issues.push(...(await inViewport(tab, '[role=alertdialog]', size, '撤销确认框')))
      issues.push(...(await touchIssues(tab, '[role=alertdialog] button', '确认框按钮')))
      // 键盘:Esc 关掉确认框,不撤销
      await tab.keyboard.press('Escape')
      await tab.waitForFunction(() => !document.querySelector('[role=alertdialog]'), null, { timeout: 3000 }).catch(() => issues.push('按 Esc 应关掉撤销确认框'))
      await tab.waitForTimeout(300)
      if (await revert) issues.push('按 Esc 关掉确认框后不该撤销')
      return issues
    },
  },

  'a7-batches-ai-off': {
    route: '/admin/audit?tab=batches',
    ready: '[data-testid=batch-panel] .kb-bp-card',
    fixture: { __me: aiOffMe },
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await overflowIssues(tab)), ...(await noAi(tab, '批次'))]
      await tab.getByRole('tab', { name: '审计日志' }).click()
      await tab.waitForSelector('[data-testid=audit-panel] .kb-ap-card')
      issues.push(...(await noAi(tab, '审计日志')))
      return issues
    },
  },

  'a7-audit-light': {
    route: '/admin/audit',
    ready: '[data-testid=audit-panel] .kb-ap-card',
    init: lightTheme,
    settle: 500,
    assert: async (tab) => [...(await overflowIssues(tab))],
  },
}
