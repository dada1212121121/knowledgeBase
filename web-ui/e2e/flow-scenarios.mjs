// 逐页检查(flow 组)补充场景:审核 / 任务 / 导入(含批次、文件时间线)/ AI 助手 / 好友 / 通知 / 外壳 / 状态页。
// 由 viewer-shots.mjs 引入,默认跑 core 五个尺寸 × 两个引擎。场景名统一以 a7f- 开头。
//
// 这里补的是各页已有场景没有覆盖的横切项:
// · AI 总开关关掉后「全页面无 AI 字样」(正文 + 属性 + 页面标题一起查)
// · 触屏可点区域 ≥ 44px
// · 键盘:Tab 顺序、Esc 关弹层并还焦点、Enter 提交
// · 浅色主题下看不清的字 / 写死的深色底
// · 批次详情、文件时间线(此前没有任何场景)的四种状态
// 每条断言都先验证过「去掉修复会变红」,对应的提交说明里写了怎么验证的。
import { ALL_FEATURES, adminMe, ingestDoneStory, ingestStory } from './fixture.mjs'
import { overflowIssues } from './admin-scenarios.mjs'
import { ASSISTANT_SCENARIOS } from './assistant-scenarios.mjs'

/** AI 总开关关闭的账号:后端会把 ai.* 与深度检索从功能列表里去掉,并把 ai_enabled 置为 false */
export const AI_OFF_ME = { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('ai.') && id !== 'search.deep'), false) }
export const AI_OFF = { __me: AI_OFF_ME }

/** 夹具里批次与文件的 id(ingestStory 的批次 bat_0c71…,失败的文件是第 7 个) */
export const BATCH_ID = 'bat_0c71-6d1e-7f3a-92b4-5a8c1e07d3aa'
export const FILE_ID = 'ing_7'

const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))
/** 另一个浅色主题「纸张」 */
const paperTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'paper' }))

/**
 * 页面(或 root 选择器圈出的一块)上所有「AI」字样:可见文字、常见的带文案属性(title / aria-label / placeholder / alt …)、页面标题。
 * 只认独立的 AI(前后不是英文字母),免得把 email、maintain 之类误报。
 */
export async function aiLeaks(tab, root = 'body') {
  return tab.evaluate((rootSelector) => {
    const hits = []
    const re = /(?<![A-Za-z])AI(?![A-Za-z])/
    const scope = document.querySelector(rootSelector)
    if (!scope) return [`找不到范围 ${rootSelector}`]
    for (const line of scope.innerText.split('\n')) if (re.test(line)) hits.push(`文字「${line.trim().slice(0, 40)}」`)
    for (const el of scope.querySelectorAll('*')) {
      for (const attr of ['title', 'aria-label', 'placeholder', 'alt', 'aria-description', 'aria-roledescription', 'data-tip', 'value']) {
        const value = el.getAttribute(attr)
        if (value && re.test(value)) hits.push(`属性 ${attr}「${value.slice(0, 40)}」`)
      }
    }
    if (rootSelector === 'body' && re.test(document.title)) hits.push(`页面标题「${document.title}」`)
    return [...new Set(hits)]
  }, root)
}

/**
 * 让某个接口一直不回(请求挂起),再用页面里的路由器做站内跳转——截「读取中」状态用。
 * 不能用 goto:它要等网络空闲,挂起的请求永远不空闲。
 */
export async function hangThenGo(tab, pattern, path) {
  await tab.context().route(pattern, () => {})
  await tab.evaluate((to) => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(to), path)
}

/** 跳到另一个地址(同一个浏览器页,保留夹具),等网络空闲再给页面一点渲染时间 */
export async function visit(tab, path, settle = 450) {
  await tab.goto(new URL(path, tab.url()).href, { waitUntil: 'networkidle' })
  await tab.waitForTimeout(settle)
}

/** 页面里所有「可以点 / 可以聚焦」的东西(行内正文链接另算,见 hitIssues) */
export const INTERACTIVE = 'a[href], button, [role=button], [role=tab], [role=menuitem], [role=option], summary, input:not([type=hidden]), select, textarea'

/**
 * 触屏设备上,选择器命中的每一个可点元素,可点区域都要 ≥44px;非触屏返回空。
 * · 勾选框 / 单选框本体只有 22px,看它外面那层 label(没有 label 就看它自己);
 * · 用 ::before 外扩的小按钮,把伪元素的尺寸算进去(和 smallTargets 一样);
 * · 看不见的(display:none / visibility:hidden / 零尺寸)和正文里的行内链接不算。
 */
export async function touchIssues(tab, selector) {
  const coarse = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (!coarse) return []
  const found = await tab.evaluate((sel) => {
    const out = []
    for (const el of document.querySelectorAll(sel)) {
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      if (el.tagName === 'A' && style.display === 'inline') continue
      const target = el.matches('input[type=checkbox], input[type=radio]') ? (el.closest('label') ?? el) : el
      const box = target.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      let width = box.width
      let height = box.height
      const before = getComputedStyle(target, '::before')
      if (before.content !== 'none' && before.position === 'absolute') {
        width = Math.max(width, Number.parseFloat(before.width) || 0)
        height = Math.max(height, Number.parseFloat(before.height) || 0)
      }
      if (height < 43.5 || width < 43.5) out.push(`${(el.getAttribute('aria-label') || el.textContent || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 14)} ${Math.round(width)}×${Math.round(height)}`)
    }
    return out
  }, selector)
  return found.map((item) => `触屏可点区域不足 44px:${item}`)
}

export const isPhone = (size) => size.width < 600

/**
 * 浅色主题的运行时检查(既有的 *-light 场景只量了横向溢出,不会发现「浅色下看不清」或「写死的深色底」):
 * 1. 主题真的是浅色(页面底色亮度 > 0.6),避免场景没生效时检查恒通过;
 * 2. 每个可见文字的前景色叠在真实背景上(逐层叠加半透明背景,算上透明度)对比度 ≥ minRatio(默认 3,即「肉眼看不清」的底线);
 * 背景里有渐变 / 图片的文字、禁用控件里的文字不查;
 * 3. 没有大块(面积 ≥ 6000px²)不透明的深色底(亮度 < 0.1),除了本来就是深色的代码块 / 日志区(.code、pre)。
 * 颜色统一用 canvas 解析成 sRGB,color-mix / oklch 算出来的颜色也能读到。
 */
export async function lightIssues(tab, { root = 'body', minRatio = 3 } = {}) {
  return tab.evaluate(
    ({ rootSelector, min }) => {
      const out = []
      const scope = document.querySelector(rootSelector)
      if (!scope) return [`找不到范围 ${rootSelector}`]
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      const rgba = (value) => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = '#000'
        ctx.fillStyle = value
        ctx.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
        // getImageData 返回的是还原过的非预乘值;完全透明时 r/g/b 为 0,没有意义
        return { r, g, b, a: a / 255 }
      }
      const over = (top, bottom) => ({
        r: top.r * top.a + bottom.r * (1 - top.a),
        g: top.g * top.a + bottom.g * (1 - top.a),
        b: top.b * top.a + bottom.b * (1 - top.a),
        a: 1,
      })
      const lum = ({ r, g, b }) => [r, g, b].map((c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
      const ratio = (a, b) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
        return (hi + 0.05) / (lo + 0.05)
      }
      /** 元素背后实际的底色;祖先里有渐变 / 图片背景时返回 null(无法可靠判断) */
      const backdrop = (el) => {
        const chain = []
        for (let node = el; node; node = node.parentElement) chain.push(node)
        let acc = { r: 255, g: 255, b: 255, a: 1 }
        for (const node of chain.reverse()) {
          const style = getComputedStyle(node)
          if (style.backgroundImage !== 'none') return null
          const bg = rgba(style.backgroundColor)
          if (bg.a > 0) acc = over(bg, acc)
        }
        return acc
      }
      const effectiveOpacity = (el) => {
        let value = 1
        for (let node = el; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity)
        return value
      }

      const page = backdrop(document.body) ?? { r: 255, g: 255, b: 255 }
      if (lum(page) < 0.6) out.push(`页面底色不是浅色(亮度 ${lum(page).toFixed(2)}),浅色主题没有生效`)

      const seen = new Set()
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue
        const el = node.parentElement
        if (!el || seen.has(el) || el.closest('script,style,svg,[aria-hidden=true],:disabled,[aria-disabled=true]')) continue
        seen.add(el)
        const style = getComputedStyle(el)
        if (style.visibility === 'hidden' || style.display === 'none') continue
        const box = el.getBoundingClientRect()
        if (box.width < 2 || box.height < 2 || box.right <= 0 || box.bottom <= 0) continue
        const back = backdrop(el)
        if (!back) continue
        const opacity = effectiveOpacity(el)
        if (opacity === 0) continue
        const color = rgba(style.color)
        const front = over({ ...color, a: color.a * opacity }, back)
        const value = ratio(front, back)
        if (value < min) out.push(`文字「${node.textContent.trim().slice(0, 16)}」对比度 ${value.toFixed(2)} < ${min}(${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]})`)
      }

      for (const el of scope.querySelectorAll('*')) {
        const box = el.getBoundingClientRect()
        if (box.width * box.height < 6000 || box.right <= 0 || box.bottom <= 0) continue
        const style = getComputedStyle(el)
        if (style.visibility === 'hidden' || style.display === 'none' || style.backgroundImage !== 'none') continue
        if (el.closest('.code, pre, .kb-code, .cm-editor')) continue
        const bg = rgba(style.backgroundColor)
        if (bg.a >= 0.9 && lum(bg) < 0.1) out.push(`写死的深色底:${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(box.width)}×${Math.round(box.height)} rgb(${bg.r},${bg.g},${bg.b})`)
      }
      return [...new Set(out)].slice(0, 12)
    },
    { rootSelector: root, min: minRatio },
  )
}

export { lightTheme, overflowIssues }

/** AI 关闭后逐页检查的地址。每修好一页,就把它加进来(场景先红、修完变绿)。 */
const AI_OFF_PAGES = [
  ['/review', '审核收件箱', '[data-testid=review-off]'],
  ['/assistant', 'AI 助手页', '[data-testid=assistant-off]'],
  ['/tasks', '任务'],
  ['/admin/audit', '审计 / 批次'],
  ['/import', '导入记录'],
  ['/import?tab=sources', '数据来源'],
  [`/import/batches/${BATCH_ID}`, '批次详情'],
  [`/import/files/${FILE_ID}`, '文件时间线'],
  ['/friends', '好友'],
  ['/mine', '我的'],
  ['/unavailable?kind=maintenance&next=%2Fhome', '服务暂时不可用'],
  ['/no/such/page', '找不到页面'],
]

/** 浅色主题逐页检查的地址 */
const LIGHT_PAGES = [
  ['/review', '审核收件箱'],
  ['/tasks', '任务'],
  ['/admin/audit', '审计 / 批次'],
  ['/import', '导入记录'],
  ['/import?tab=sources', '数据来源'],
  [`/import/batches/${BATCH_ID}`, '批次详情'],
  [`/import/files/${FILE_ID}`, '文件时间线'],
  ['/assistant', 'AI 助手'],
  ['/friends', '好友'],
  ['/mine', '我的'],
  ['/no/such/page', '找不到页面'],
  ['/unavailable?kind=maintenance&next=%2Fhome', '服务暂时不可用'],
]

export const FLOW_SCENARIOS = {
  'a7f-ai-off-pages': {
    // AI 总开关关闭:本组的页面(含批次详情、文件时间线、状态页)正文、属性、标题里都不出现「AI」
    route: '/home',
    ready: '.kb-topbar',
    fixture: { ...ingestStory, ...AI_OFF },
    settle: 300,
    assert: async (tab) => {
      const issues = []
      for (const [path, name, off] of AI_OFF_PAGES) {
        await visit(tab, path)
        // 本身就不该进的页面(审核、助手):要写清「没有开通」,而不是渲染出内容
        if (off && !(await tab.locator(off).count())) issues.push(`${name}(${path}):AI 关闭后应显示「没有开通」(${off})`)
        // 页面没渲染出来(空白 / 白屏)时扫描会「恒通过」,先确认确有内容
        if ((await tab.evaluate(() => document.body.innerText.trim().length)) < 20) issues.push(`${name}(${path}):页面几乎是空白,扫描没有意义`)
        for (const hit of await aiLeaks(tab)) issues.push(`${name}(${path}):AI 关闭后不该出现 ${hit}`)
      }
      return issues
    },
  },

  'a7f-review-forbidden': {
    // 功能列表还说有 ai.extract,但列表请求被后端 403「AI 功能已关闭」(AI 总开关刚被关掉、会话里的功能列表要 20 秒才刷新):
    // 页面内容区写「没有开通」,不照搬服务端那句带 AI 的话,也不给没用的「重新加载」。
    // 只查内容区:这时壳子里的助手按钮还在(功能列表没刷新),那不是这一页的问题
    route: '/review',
    ready: '[data-testid=review-off]',
    fixture: { __capabilityError: { list_drafts: { status: 403, code: 'forbidden', message: 'AI 功能已关闭' } } },
    expectConsole: /403|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      for (const hit of await aiLeaks(tab, '[data-testid=review]')) issues.push(`403 后审核页内容区不该出现 ${hit}`)
      if (await tab.locator('[data-testid=review-error]').count()) issues.push('403 不该显示带「重新加载」的报错')
      if (!(await tab.locator('[data-testid=review-off]').innerText()).includes('请联系管理员')) issues.push('应写「请联系管理员」')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7f-shortcuts-ai-off': {
    // AI 关闭:快捷键表(按 ? 打开)里没有「呼出 AI 助手」、跳转行里没有审核;「G 然后 R」不会把人带进没开通的审核页。
    // 手机没有键盘,这些键不响应,只在平板横屏和电脑上跑
    route: '/tasks',
    ready: '.kb-topbar',
    sizes: ['1180x820', '1440x900', '1920x1080'],
    fixture: AI_OFF,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      await tab.keyboard.press('?')
      await tab.waitForSelector('[data-testid=shortcuts]', { timeout: 5000 }).catch(() => issues.push('按 ? 应打开快捷键表'))
      const table = (await tab.locator('[data-testid=shortcuts]').innerText().catch(() => '')).replace(/\s+/g, ' ')
      for (const hit of await aiLeaks(tab)) issues.push(`快捷键表打开后页面里不该出现 ${hit}`)
      if (table.includes('⌘J')) issues.push('AI 关闭后不该有 ⌘J(呼出助手)这一行')
      if (/跳转:[^⌘]*审核/.test(table)) issues.push(`跳转行里不该有审核:${table.slice(0, 80)}`)
      if (!table.includes('⌘K')) issues.push('其它行应照常(⌘K)')
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid=shortcuts]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('Esc 应关闭快捷键表'))
      await tab.keyboard.press('g')
      await tab.keyboard.press('r')
      await tab.waitForTimeout(400)
      if (new URL(tab.url()).pathname !== '/tasks') issues.push(`AI 关闭后 G R 不该跳转,实际到了 ${new URL(tab.url()).pathname}`)
      await tab.keyboard.press('g')
      await tab.keyboard.press('h')
      await tab.waitForFunction(() => location.pathname === '/home', null, { timeout: 3000 }).catch(() => issues.push('G H 应照常回首页'))
      return issues
    },
  },

  'a7f-shortcuts-ai-on': {
    // 对照:AI 开着时快捷键表有「呼出 AI 助手」和审核,G R 去审核页
    route: '/tasks',
    ready: '.kb-topbar',
    sizes: ['1180x820', '1440x900', '1920x1080'],
    settle: 400,
    assert: async (tab) => {
      const issues = []
      await tab.keyboard.press('?')
      await tab.waitForSelector('[data-testid=shortcuts]', { timeout: 5000 }).catch(() => issues.push('按 ? 应打开快捷键表'))
      const table = (await tab.locator('[data-testid=shortcuts]').innerText().catch(() => '')).replace(/\s+/g, ' ')
      if (!table.includes('⌘J') || !table.includes('AI 助手')) issues.push('AI 开着时应有 ⌘J 呼出 AI 助手')
      if (!/跳转:[^⌘]*审核/.test(table)) issues.push('跳转行里应有审核')
      await tab.keyboard.press('Escape')
      await tab.keyboard.press('g')
      await tab.keyboard.press('r')
      await tab.waitForFunction(() => location.pathname === '/review', null, { timeout: 3000 }).catch(() => issues.push('G R 应去审核页'))
      return issues
    },
  },

  'a7f-touch-review': {
    // 触屏:审核页每一个可点的东西(勾选框、全选、展开、依据、通过 / 修订、「⋯」)都 ≥44px
    route: '/review',
    ready: '[data-testid=draft-card]',
    settle: 500,
    assert: async (tab) => [...(await touchIssues(tab, `[data-testid=review] ${INTERACTIVE}`)), ...(await overflowIssues(tab))],
  },

  'a7f-touch-tasks': {
    // 触屏:任务页的筛选、新任务、日志卡里的「取消 / 下载」(手机是点卡片后底部弹层里的按钮)都 ≥44px
    route: '/tasks',
    ready: '.kb-jobs-table [data-testid=rt-row], .kb-jobs-table [data-testid=rt-card]',
    settle: 500,
    assert: async (tab, size) => {
      const issues = [...(await touchIssues(tab, `[data-testid=jobs] ${INTERACTIVE}`))]
      if (isPhone(size)) {
        await tab.locator('[data-testid=rt-card]').first().click()
        await tab.waitForSelector('.kb-sheet', { timeout: 5000 })
        await tab.waitForTimeout(500)
        issues.push(...(await touchIssues(tab, `.kb-sheet ${INTERACTIVE}`)))
      }
      return issues
    },
  },

  'a7f-touch-import-file': {
    // 触屏:文件时间线的「重试此阶段 / 跳过 / 移入隔离」都 ≥44px
    route: `/import/files/${FILE_ID}`,
    ready: '.kb-topbar',
    fixture: ingestStory,
    settle: 600,
    assert: async (tab) => {
      await tab.waitForSelector('button.btn', { timeout: 8000 })
      return [...(await touchIssues(tab, `.content ${INTERACTIVE}`)), ...(await overflowIssues(tab))]
    },
  },

  'a7f-touch-import-batch': {
    // 触屏:批次详情(运行中)的「暂停 / 取消 / 查看文件」都 ≥44px
    route: `/import/batches/${BATCH_ID}`,
    ready: '.kb-topbar',
    fixture: ingestStory,
    settle: 600,
    assert: async (tab) => {
      await tab.waitForSelector('button.btn', { timeout: 8000 })
      return [...(await touchIssues(tab, `.content ${INTERACTIVE}`)), ...(await overflowIssues(tab))]
    },
  },

  'a7f-touch-import-batch-done': {
    // 触屏:批次完成页的「撤销整批 / 全部重试」、问题文件行、搜索框都 ≥44px
    route: `/import/batches/${BATCH_ID}`,
    ready: '.kb-topbar',
    fixture: ingestDoneStory,
    settle: 600,
    assert: async (tab) => {
      await tab.waitForSelector('.kb-done', { timeout: 8000 })
      return [...(await touchIssues(tab, `.content ${INTERACTIVE}`)), ...(await overflowIssues(tab))]
    },
  },

  'a7f-touch-assistant': {
    // 触屏:助手页的输入区(上传、模型选择、发送)和头部按钮都 ≥44px
    route: '/assistant',
    ready: '[data-testid=assistant-page]',
    fixture: ASSISTANT_SCENARIOS['assistant-page'].fixture,
    settle: 700,
    assert: async (tab) => {
      const issues = [...(await touchIssues(tab, `.kb-agent-widget ${INTERACTIVE}`))]
      // 窄屏会话列表收在「历史会话」里,点开再查一遍(置顶星标、重命名、删除)
      const history = tab.locator('[aria-label=历史会话]')
      if (!(await tab.locator('.kb-agent-sessions').count()) && (await history.count())) {
        await history.click()
        await tab.waitForSelector('.kb-agent-sessions-item', { timeout: 5000 })
        await tab.waitForTimeout(400)
        issues.push(...(await touchIssues(tab, `.kb-agent-sessions ${INTERACTIVE}`)))
      }
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7f-touch-notify-drawer': {
    // 触屏:通知抽屉的「关闭 / 全部标为已读 / 筛选 / 每条通知上的操作」都 ≥44px
    route: '/tasks',
    ready: '.kb-topbar',
    settle: 400,
    assert: async (tab, size) => {
      // 手机和竖屏小平板用底部标签栏的「通知」,其余用顶栏铃铛
      if (await tab.locator('[data-tab=notify]').count()) await tab.locator('[data-tab=notify]').click()
      else await tab.locator('[data-testid=bell]').click()
      await tab.waitForSelector('[data-testid=notification-list]', { timeout: 5000 })
      await tab.waitForTimeout(500)
      return touchIssues(tab, `.kb-drawer ${INTERACTIVE}`)
    },
  },

  'a7f-touch-breadcrumb': {
    // 触屏(平板横屏顶栏有面包屑):批次详情 / 文件时间线 / 批次完成页顶栏里的链接(导入 / 导入记录 / 批次号)都 ≥44px
    route: `/import/files/${FILE_ID}`,
    ready: '.kb-topbar',
    fixture: ingestDoneStory,
    settle: 500,
    assert: async (tab) => {
      const issues = []
      for (const [path, name] of [[`/import/files/${FILE_ID}`, '文件时间线'], [`/import/batches/${BATCH_ID}`, '批次完成页']]) {
        await visit(tab, path, 500)
        for (const item of await touchIssues(tab, '.kb-topbar-bc a')) issues.push(`${name}:${item}`)
      }
      return issues
    },
  },

  'a7f-tasks-labels': {
    // 任务页:类型显示中文名(不露 reindex / evolve / embed 这类键名),类型筛选里也是中文
    route: '/tasks',
    ready: '.kb-jobs-table [data-testid=rt-row], .kb-jobs-table [data-testid=rt-card]',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const RAW = ['reindex', 'evolve', 'extract', 'review', 'embed', 'ingest', 'sync', 'backup', 'migrate', 'index']
      const leaks = await tab.evaluate((raw) => [...document.querySelectorAll('.kb-jobs *')].filter((el) => el.children.length === 0 && raw.includes(el.textContent.trim())).map((el) => el.textContent.trim()), RAW)
      if (leaks.length) issues.push(`任务页露出了英文键名:${[...new Set(leaks)].join('、')}`)
      const table = (await tab.locator('.kb-jobs-table').innerText()).replace(/\s+/g, ' ')
      for (const word of ['重建索引', '自动提炼', '导入解析']) if (!table.includes(word)) issues.push(`任务类型应显示中文「${word}」`)
      // 统计卡「运行中」写的是正在跑的任务类型
      const metric = (await tab.locator('.kb-jobs .metric').first().innerText()).replace(/\s+/g, ' ')
      if (!metric.includes('重建索引')) issues.push(`运行中统计卡应写中文类型,实际「${metric}」`)
      // 类型筛选下拉里也是中文
      await tab.locator('[aria-label^=按类型筛选]').click()
      const options = (await tab.locator('[role=option]').allInnerTexts()).map((text) => text.trim())
      if (!options.includes('重建索引') || options.some((text) => RAW.includes(text))) issues.push(`类型筛选里应是中文名,实际 ${options.join('|')}`)
      await tab.keyboard.press('Escape')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7f-tasks-ai-off': {
    // AI 关闭:任务页不出现自动提炼 / 审核类任务(也不能有 AI 字样);其它任务照常
    route: '/tasks',
    ready: '.kb-jobs-table [data-testid=rt-row], .kb-jobs-table [data-testid=rt-card]',
    fixture: AI_OFF,
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const table = (await tab.locator('.kb-jobs-table').innerText()).replace(/\s+/g, ' ')
      if (table.includes('自动提炼') || table.includes('evolve')) issues.push('AI 关闭后不该列出自动提炼类任务')
      if (!table.includes('重建索引') || !table.includes('导入解析')) issues.push('其它任务应照常显示')
      await tab.locator('[aria-label^=按类型筛选]').click()
      const options = (await tab.locator('[role=option]').allInnerTexts()).map((text) => text.trim())
      if (options.includes('自动提炼')) issues.push('类型筛选里不该有自动提炼')
      await tab.keyboard.press('Escape')
      for (const hit of await aiLeaks(tab, '.kb-jobs')) issues.push(`任务页不该出现 ${hit}`)
      return issues
    },
  },

  'a7f-ai-off-rail': {
    // 宽屏(≥1920)右栏:AI 关闭没有审核收件箱卡片和 G R 提示,也没有旧叫法「进化热力」;其余照常
    route: '/tasks',
    ready: '.xaside',
    sizes: ['1920x1080'],
    fixture: AI_OFF,
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const text = (await tab.locator('.xaside').innerText()).replace(/\s+/g, ' ')
      if (text.includes('审核') || text.includes('G R')) issues.push(`右栏不该有审核收件箱 / G R:${text}`)
      if (text.includes('进化')) issues.push('右栏不该再叫「进化热力」(术语表:自动提炼)')
      if (!text.includes('新增笔记') || !text.includes('命令面板')) issues.push(`右栏其余内容应照常:${text}`)
      for (const hit of await aiLeaks(tab, '.xaside')) issues.push(`右栏不该出现 ${hit}`)
      return issues
    },
  },

  'a7f-rail-ai-on': {
    // 对照:AI 开着时右栏有审核收件箱卡片,点「去审核」到审核页
    route: '/tasks',
    ready: '.xaside',
    sizes: ['1920x1080'],
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const text = (await tab.locator('.xaside').innerText()).replace(/\s+/g, ' ')
      if (!text.includes('审核收件箱') || !text.includes('G R')) issues.push(`AI 开着时右栏应有审核收件箱和 G R:${text}`)
      await tab.locator('[data-testid=rail-review] button').click().catch(() => issues.push('找不到「去审核」'))
      await tab.waitForFunction(() => location.pathname === '/review', null, { timeout: 3000 }).catch(() => issues.push('点「去审核」应进审核页'))
      return issues
    },
  },

  'a7f-palette-ai-off': {
    // AI 关闭:⌘K 命令面板里没有审核收件箱、没有「进化」、没有 AI 字样;分区叫「笔记」不叫 Insights;其余命令照常
    route: '/tasks?palette=1',
    ready: '.pal',
    fixture: AI_OFF,
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const rows = (await tab.locator('.pal .ni').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim())
      if (rows.some((text) => text.startsWith('审核收件箱'))) issues.push(`AI 关闭后不该有审核收件箱:${rows.join('|')}`)
      if (rows.some((text) => text.includes('进化'))) issues.push(`不该再有「进化」:${rows.join('|')}`)
      if (!rows.some((text) => text.startsWith('搜索'))) issues.push('其余命令应照常(搜索)')
      for (const hit of await aiLeaks(tab)) issues.push(`命令面板打开后页面里不该出现 ${hit}`)
      await tab.locator('.pal-input').fill('审核')
      if (await tab.locator('.pal .ni').count()) issues.push('输入「审核」也不该搜出命令')
      await tab.locator('.pal-input').fill('#')
      await tab.waitForTimeout(200)
      const sections = (await tab.locator('.pal .sec').allInnerTexts()).map((text) => text.trim())
      if (sections.includes('Insights') || !sections.includes('笔记')) issues.push(`笔记分区应叫「笔记」,实际 ${sections.join('|')}`)
      return issues
    },
  },

  'a7f-palette-phone': {
    // 手机:命令面板铺满屏幕,要有看得见的「取消」(≥44px);不显示快捷键提示;Tab 在输入框和取消之间循环
    route: '/home?palette=1',
    ready: '.pal',
    sizes: ['390x844'],
    settle: 600,
    assert: async (tab) => {
      const issues = []
      if (await tab.locator('.pal .ni .kbd').count()) issues.push('手机上不显示快捷键提示(G S 等)')
      const close = tab.locator('[data-testid=palette-close]')
      if (!(await close.count())) return [...issues, '手机上应有「取消」按钮']
      const box = await close.boundingBox()
      issues.push(...(await touchIssues(tab, '[data-testid=palette-close], .pal .ni, .pal-input')))
      if (box && box.x + box.width > 390 + 1) issues.push('「取消」不该超出屏幕右边')
      const inputBox = await tab.locator('.pal-input').boundingBox()
      if (inputBox && box && inputBox.x + inputBox.width > box.x + 1) issues.push('输入框不该压住「取消」')
      await tab.keyboard.press('Tab')
      if (!(await close.evaluate((el) => el === document.activeElement))) issues.push('Tab 应从输入框走到「取消」')
      await tab.keyboard.press('Tab')
      if (!(await tab.locator('.pal-input').evaluate((el) => el === document.activeElement))) issues.push('再按 Tab 应回到输入框(不能跑到面板后面的页面)')
      await close.click()
      await tab.waitForSelector('.pal', { state: 'detached', timeout: 3000 }).catch(() => issues.push('点「取消」应关闭面板'))
      if (new URL(tab.url()).searchParams.has('palette')) issues.push('关闭后地址里不该还有 palette 参数')
      return issues
    },
  },

  'a7f-palette-keyboard': {
    // 电脑 / 平板横屏:键盘走完整个面板——方向键走到被裁掉的最后一行时自动滚进视野;Tab 不跑到后面的页面;
    // Esc 关闭后焦点回到打开它的顶栏搜索按钮
    route: '/tasks',
    ready: '[data-testid=topbar-search]',
    sizes: ['1180x820', '1440x900', '1920x1080'],
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const trigger = tab.locator('[data-testid=topbar-search]')
      await trigger.click()
      await tab.waitForSelector('.pal-input', { timeout: 5000 })
      await tab.waitForTimeout(500)
      // 输入 > 列出全部操作后,再多按几次 ↓ 走到列表末尾
      const count = await tab.locator('.pal .ni').count()
      for (let i = 0; i < count - 1; i += 1) await tab.keyboard.press('ArrowDown')
      await tab.waitForTimeout(200)
      const visible = await tab.evaluate(() => {
        const list = document.querySelector('.pal-list')
        const row = document.querySelector('.pal .ni.on')
        if (!list || !row) return null
        const a = list.getBoundingClientRect()
        const b = row.getBoundingClientRect()
        return b.top >= a.top - 1 && b.bottom <= a.bottom + 1
      })
      if (visible !== true) issues.push('方向键走到最后一行后,选中的行应在列表的可视范围内')
      for (let i = 0; i < 3; i += 1) {
        await tab.keyboard.press('Tab')
        if (!(await tab.evaluate(() => !!document.activeElement?.closest('.pal')))) issues.push('Tab 不该把焦点带到面板后面的页面上')
      }
      const role = await tab.locator('.pal-input').getAttribute('role')
      if (role !== 'combobox') issues.push('输入框应是 combobox,读屏软件才知道下面是候选列表')
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('.pal', { state: 'detached', timeout: 3000 }).catch(() => issues.push('Esc 应关闭面板'))
      await tab.waitForTimeout(200)
      if (!(await trigger.evaluate((el) => el === document.activeElement))) issues.push('关闭后焦点应回到打开它的顶栏搜索按钮')
      return issues
    },
  },

  'a7f-batch-running': {
    // 批次详情(运行中):预计剩余(不写 ETA)、阶段说明里没有「魔数」;流水线、四个指标、正在处理都在;无溢出
    route: `/import/batches/${BATCH_ID}`,
    ready: '.kb-pl',
    fixture: ingestStory,
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const body = await tab.evaluate(() => document.body.innerText)
      if (!body.includes('预计剩余')) issues.push('应写「预计剩余」')
      for (const word of ['ETA', '魔数', 'RRF']) if (body.includes(word)) issues.push(`页面上不该出现「${word}」`)
      for (const word of ['正在处理', '吞吐', '已用时', '暂停', '查看文件']) if (!body.includes(word)) issues.push(`缺少「${word}」`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7f-batch-done': {
    // 批次完成页:示例搜索词是人话(没有 RRF / k);需要处理的文件行都是去文件时间线的链接;无溢出
    route: `/import/batches/${BATCH_ID}`,
    ready: '.kb-done',
    fixture: ingestDoneStory,
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const placeholder = await tab.locator('.kb-done-input input').getAttribute('placeholder')
      if (/RRF|\bk\b/.test(placeholder ?? '') || !placeholder) issues.push(`搜索框示例不该有术语,实际「${placeholder}」`)
      const hrefs = await tab.locator('.kb-done-row').evaluateAll((els) => els.map((el) => el.getAttribute('href')))
      if (hrefs.length !== 3 || hrefs.some((href) => !href?.startsWith('/import/files/'))) issues.push(`需要处理的 3 行都应链到文件时间线,实际 ${hrefs.join(',')}`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7f-batch-error': {
    // 批次详情读取失败:说清楚发生了什么 + 重试(触屏 ≥44px);截图停在报错上(点重试恢复见 a7f-batch-error-retry)
    route: `/import/batches/${BATCH_ID}`,
    ready: '[data-testid=admin-error]',
    fixture: { ...ingestStory, __capabilityError: { get_batch_progress: { status: 503, message: '服务暂时不可用', times: 1 } } },
    expectConsole: /503|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const failure = (await tab.locator('[data-testid=admin-error]').innerText()).replace(/\s+/g, ' ')
      if (!failure.includes('读取批次进度失败') || !failure.includes('重试')) issues.push(`报错应说清楚并给「重试」,实际「${failure}」`)
      issues.push(...(await touchIssues(tab, '[data-testid=admin-error] button')))
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7f-batch-error-retry': {
    // 点「重试」后恢复成批次详情,报错消失
    route: `/import/batches/${BATCH_ID}`,
    ready: '[data-testid=admin-error]',
    fixture: { ...ingestStory, __capabilityError: { get_batch_progress: { status: 503, message: '服务暂时不可用', times: 1 } } },
    expectConsole: /503|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=admin-error] button').click()
      await tab.waitForSelector('.kb-pl', { timeout: 8000 }).catch(() => issues.push('点「重试」后应恢复成批次详情'))
      if (await tab.locator('[data-testid=admin-error]').count()) issues.push('恢复后报错应消失')
      return issues
    },
  },

  'a7f-batch-loading': {
    // 批次详情读取中:骨架屏(不是一行「读取中…」)
    route: '/tasks',
    ready: '.kb-topbar',
    fixture: ingestStory,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await hangThenGo(tab, /capabilities\/get_batch_progress/, `/import/batches/${BATCH_ID}`)
      await tab.waitForSelector('[data-testid=admin-loading]', { timeout: 5000 }).catch(() => issues.push('读取中应显示骨架屏'))
      if ((await tab.evaluate(() => document.body.innerText)).includes('读取中')) issues.push('读取中应是骨架屏,不要写「读取中…」')
      const box = await tab.locator('[data-testid=admin-loading]').boundingBox().catch(() => null)
      if (!box || box.height < 40) issues.push('骨架屏应有高度')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7f-file-timeline': {
    // 文件时间线(失败):阶段列表、失败阶段的三个操作、文件信息;无溢出
    route: `/import/files/${FILE_ID}`,
    ready: '.kb-tl-card',
    fixture: ingestStory,
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const body = await tab.evaluate(() => document.body.innerText)
      for (const word of ['重试此阶段', '跳过', '移入隔离', '文件信息', '失败原因', '扫描件-合同-2019.pdf']) if (!body.includes(word)) issues.push(`缺少「${word}」`)
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7f-file-error': {
    // 文件时间线读取失败:说清楚 + 重试(触屏 ≥44px);截图停在报错上(点重试恢复见 a7f-file-error-retry)
    route: `/import/files/${FILE_ID}`,
    ready: '[data-testid=admin-error]',
    fixture: { ...ingestStory, __capabilityError: { get_file_timeline: { status: 503, message: '服务暂时不可用', times: 1 } } },
    expectConsole: /503|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const failure = (await tab.locator('[data-testid=admin-error]').innerText()).replace(/\s+/g, ' ')
      if (!failure.includes('读取文件时间线失败') || !failure.includes('重试')) issues.push(`报错应说清楚并给「重试」,实际「${failure}」`)
      issues.push(...(await touchIssues(tab, '[data-testid=admin-error] button')))
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7f-file-error-retry': {
    // 点「重试」后恢复成文件时间线,报错消失
    route: `/import/files/${FILE_ID}`,
    ready: '[data-testid=admin-error]',
    fixture: { ...ingestStory, __capabilityError: { get_file_timeline: { status: 503, message: '服务暂时不可用', times: 1 } } },
    expectConsole: /503|Failed to load resource/,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=admin-error] button').click()
      await tab.waitForSelector('.kb-tl-card', { timeout: 8000 }).catch(() => issues.push('点「重试」后应恢复成文件时间线'))
      if (await tab.locator('[data-testid=admin-error]').count()) issues.push('恢复后报错应消失')
      return issues
    },
  },

  'a7f-file-loading': {
    // 文件时间线读取中:骨架屏
    route: '/tasks',
    ready: '.kb-topbar',
    fixture: ingestStory,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      await hangThenGo(tab, /capabilities\/get_file_timeline/, `/import/files/${FILE_ID}`)
      await tab.waitForSelector('[data-testid=admin-loading]', { timeout: 5000 }).catch(() => issues.push('读取中应显示骨架屏'))
      if ((await tab.evaluate(() => document.body.innerText)).includes('读取中')) issues.push('读取中应是骨架屏,不要写「读取中…」')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7f-kbd-skip-link': {
    // 键盘:进任何一页后第一次按 Tab 落在「跳到主要内容」(出现在屏幕左上角、有焦点样式),Enter 之后焦点进内容区,
    // 再按 Tab 走的是页面内容而不是又回到侧栏(侧栏有近 20 个入口)
    route: '/tasks',
    ready: '.kb-topbar',
    settle: 300,
    assert: async (tab) => {
      const issues = []
      for (const [path, name] of [['/tasks', '任务'], ['/review', '审核'], ['/import', '导入'], ['/friends', '好友'], [`/import/files/${FILE_ID}`, '文件时间线']]) {
        await visit(tab, path, 400)
        await tab.keyboard.press('Tab')
        const first = await tab.evaluate(() => {
          const el = document.activeElement
          const box = el?.getBoundingClientRect()
          const style = el ? getComputedStyle(el) : null
          return { skip: !!el?.classList.contains('kb-skip-link'), text: el?.textContent?.trim().slice(0, 12), x: box?.left ?? -1, y: box?.top ?? -1, w: box?.width ?? 0, ring: !!style && (style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0)) }
        })
        if (!first.skip) {
          issues.push(`${name}:第一次按 Tab 应落在「跳到主要内容」,实际落在「${first.text}」`)
          continue
        }
        if (first.x < 0 || first.y < 0 || first.w < 40) issues.push(`${name}:聚焦后「跳到主要内容」应出现在屏幕里,实际位置 ${Math.round(first.x)},${Math.round(first.y)}`)
        if (!first.ring) issues.push(`${name}:「跳到主要内容」聚焦后应有可见的焦点样式`)
        await tab.keyboard.press('Enter')
        if (!(await tab.evaluate(() => document.activeElement?.id === 'kb-main'))) issues.push(`${name}:按 Enter 后焦点应进内容区`)
        if (new URL(tab.url()).hash) issues.push(`${name}:不该改地址栏的 hash(${new URL(tab.url()).hash})`)
        await tab.keyboard.press('Tab')
        if (!(await tab.evaluate(() => !!document.activeElement?.closest('#kb-main')))) issues.push(`${name}:跳过之后再按 Tab 应进到页面内容里,而不是又回到侧栏`)
      }
      return issues
    },
  },

  'a7f-kbd-drawer': {
    // 键盘:通知抽屉是模态的——用 Enter 打开,Tab / Shift+Tab 都出不了抽屉,Esc 关闭,焦点回到打开它的铃铛(手机是标签栏的「通知」)
    route: '/tasks',
    ready: '.kb-topbar',
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const trigger = (await tab.locator('[data-tab=notify]').count()) ? tab.locator('[data-tab=notify]') : tab.locator('[data-testid=bell]')
      await trigger.focus()
      await tab.keyboard.press('Enter')
      await tab.waitForSelector('[data-testid=notification-drawer]', { timeout: 5000 }).catch(() => issues.push('焦点在铃铛上按 Enter 应打开通知抽屉'))
      await tab.waitForTimeout(500)
      const inside = () => tab.evaluate(() => !!document.activeElement?.closest('.kb-drawer'))
      if (!(await inside())) issues.push('抽屉打开后焦点应在抽屉里')
      for (let i = 0; i < 14; i += 1) {
        await tab.keyboard.press('Tab')
        if (!(await inside())) {
          issues.push(`Tab 第 ${i + 1} 下把焦点带出了抽屉(落在 ${await tab.evaluate(() => document.activeElement?.tagName + '.' + String(document.activeElement?.className).split(' ')[0])})`)
          break
        }
      }
      for (let i = 0; i < 14; i += 1) {
        await tab.keyboard.press('Shift+Tab')
        if (!(await inside())) {
          issues.push(`Shift+Tab 第 ${i + 1} 下把焦点带出了抽屉`)
          break
        }
      }
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid=notification-drawer]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('Esc 应关闭通知抽屉'))
      await tab.waitForTimeout(200)
      if (!(await trigger.evaluate((el) => el === document.activeElement))) issues.push('关闭后焦点应回到打开抽屉的按钮')
      return issues
    },
  },

  'a7f-kbd-dialogs': {
    // 键盘:审核页「修订后通过」对话框——Enter 打开、焦点进标题、Tab 出不了对话框、Esc 关闭并回到按钮;
    // 在标题里按 Enter 就提交(不用再摸到「按此版本转正」);账号菜单 Esc 关闭并回到头像按钮
    route: '/review',
    ready: '[data-testid=draft-card]',
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const revise = tab.locator('[data-testid=draft-revise]').first()
      await revise.focus()
      await tab.keyboard.press('Enter')
      await tab.waitForSelector('.kb-dialog', { timeout: 5000 }).catch(() => issues.push('Enter 应打开「修订后通过」'))
      await tab.waitForTimeout(500)
      if (!(await tab.evaluate(() => document.activeElement?.tagName === 'INPUT' && !!document.activeElement.closest('.kb-dialog')))) issues.push('对话框打开后焦点应在标题输入框')
      for (let i = 0; i < 10; i += 1) {
        await tab.keyboard.press('Tab')
        if (!(await tab.evaluate(() => !!document.activeElement?.closest('.kb-dialog')))) {
          issues.push(`Tab 第 ${i + 1} 下把焦点带出了对话框`)
          break
        }
      }
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('.kb-dialog', { state: 'detached', timeout: 3000 }).catch(() => issues.push('Esc 应关闭对话框'))
      await tab.waitForTimeout(200)
      if (!(await revise.evaluate((el) => el === document.activeElement))) issues.push('关闭后焦点应回到「修订后通过」按钮')
      // 再开一次:在标题里按 Enter 提交
      await revise.focus()
      await tab.keyboard.press('Enter')
      await tab.waitForSelector('.kb-dialog input', { timeout: 5000 })
      await tab.waitForTimeout(400)
      await tab.locator('.kb-dialog input').first().fill('改过的标题')
      const sent = tab.waitForRequest((request) => request.url().includes('/capabilities/review_draft'), { timeout: 3000 }).catch(() => null)
      await tab.keyboard.press('Enter')
      const request = await sent
      if (!request) issues.push('在标题里按 Enter 应提交「按此版本转正」')
      else if (!String(request.postData() ?? '').includes('改过的标题')) issues.push(`提交的请求里应带着改过的标题,实际 ${request.postData()}`)
      // 提交成功后对话框会自己关掉(等它关完,否则下面的 Esc 会先被对话框接走)
      await tab.waitForSelector('.kb-dialog', { state: 'detached', timeout: 4000 }).catch(() => issues.push('提交成功后对话框应关闭'))
      // 账号菜单(手机顶栏没有头像菜单入口,只在电脑 / 平板验证)
      if (!isPhone(size)) {
        const account = tab.locator('[data-testid=account-trigger]').first()
        await account.focus()
        await tab.keyboard.press('Enter')
        await tab.waitForSelector('[data-testid=account-menu]', { timeout: 3000 }).catch(() => issues.push('账号按钮上按 Enter 应打开菜单'))
        await tab.keyboard.press('Escape')
        await tab.waitForSelector('[data-testid=account-menu]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('Esc 应关闭账号菜单'))
        await tab.waitForTimeout(200)
        if (!(await account.evaluate((el) => el === document.activeElement))) issues.push('账号菜单关闭后焦点应回到头像按钮')
      }
      return issues
    },
  },

  'a7f-kbd-enter': {
    // 键盘:各页的输入框按 Enter 就提交——导入页粘贴网址(不像网址给提示、像就打开「添加数据」)、
    // 批次完成页搜索框(进搜索页并带上搜索词)
    route: '/import',
    ready: '[data-testid=import-web]',
    fixture: ingestDoneStory,
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const input = tab.locator('[data-testid=import-web] input').first()
      await input.fill('不是网址')
      await tab.keyboard.press('Enter')
      await tab.waitForTimeout(300)
      if (!(await tab.locator('[data-testid=import-web]').innerText()).includes('这不像一个网址')) issues.push('不像网址时按 Enter 应提示「这不像一个网址」')
      await input.fill('https://docs.example.com/guide')
      await tab.keyboard.press('Enter')
      await tab.waitForSelector('.kb-dialog', { timeout: 4000 }).catch(() => issues.push('网址正确时按 Enter 应打开「添加数据」'))
      await tab.keyboard.press('Escape')
      await visit(tab, `/import/batches/${BATCH_ID}`, 500)
      await tab.waitForSelector('.kb-done-input input', { timeout: 5000 })
      await tab.locator('.kb-done-input input').fill('部署说明')
      await tab.keyboard.press('Enter')
      await tab.waitForFunction(() => location.pathname === '/search' && new URLSearchParams(location.search).get('q') === '部署说明', null, { timeout: 4000 }).catch(() => issues.push(`批次完成页搜索框按 Enter 应进搜索页并带上搜索词,实际 ${tab.url()}`))
      return issues
    },
  },

  'a7f-light-pages': {
    // 浅色主题:本组各页的文字对比度、有没有写死的深色底(逐页检查,每页的问题单独报出来)
    route: '/home',
    ready: '.kb-topbar',
    init: lightTheme,
    fixture: { ...ingestStory, ...ASSISTANT_SCENARIOS['assistant-page'].fixture },
    settle: 300,
    assert: async (tab) => {
      const issues = []
      for (const [path, name] of LIGHT_PAGES) {
        await visit(tab, path, 500)
        for (const item of await lightIssues(tab)) issues.push(`${name}(${path}):${item}`)
      }
      return issues
    },
  },

  'a7f-paper-pages': {
    // 另一个浅色主题「纸张」:同一批页面,同样的对比度 / 深色底检查
    route: '/tasks',
    ready: '.kb-topbar',
    init: paperTheme,
    fixture: { ...ingestStory, ...ASSISTANT_SCENARIOS['assistant-page'].fixture },
    settle: 300,
    assert: async (tab) => {
      const issues = []
      for (const [path, name] of LIGHT_PAGES) {
        await visit(tab, path, 500)
        for (const item of await lightIssues(tab)) issues.push(`${name}(${path}):${item}`)
      }
      return issues
    },
  },

  'a7f-light-ai-off': {
    // 浅色 + AI 关闭:审核页、助手页的「没有开通」说明
    route: '/review',
    ready: '[data-testid=review-off]',
    init: lightTheme,
    fixture: AI_OFF,
    settle: 300,
    assert: async (tab) => {
      const issues = [...(await lightIssues(tab))]
      await visit(tab, '/assistant', 500)
      issues.push(...(await lightIssues(tab)).map((item) => `助手页:${item}`))
      return issues
    },
  },

  'a7f-light-batch': {
    // 浅色:批次详情(运行中)
    route: `/import/batches/${BATCH_ID}`,
    ready: '.kb-pl',
    init: lightTheme,
    fixture: ingestStory,
    settle: 600,
    assert: async (tab) => [...(await lightIssues(tab)), ...(await overflowIssues(tab))],
  },

  'a7f-light-batch-done': {
    // 浅色:批次完成页
    route: `/import/batches/${BATCH_ID}`,
    ready: '.kb-done',
    init: lightTheme,
    fixture: ingestDoneStory,
    settle: 600,
    assert: async (tab) => [...(await lightIssues(tab)), ...(await overflowIssues(tab))],
  },

  'a7f-light-batch-error': {
    // 浅色:批次详情读取失败
    route: `/import/batches/${BATCH_ID}`,
    ready: '[data-testid=admin-error]',
    init: lightTheme,
    fixture: { ...ingestStory, __capabilityError: { get_batch_progress: { status: 503, message: '服务暂时不可用', times: 1 } } },
    expectConsole: /503|Failed to load resource/,
    settle: 300,
    assert: async (tab) => [...(await lightIssues(tab)), ...(await overflowIssues(tab))],
  },

  'a7f-light-file': {
    // 浅色:文件时间线(失败)
    route: `/import/files/${FILE_ID}`,
    ready: '.kb-tl-card',
    init: lightTheme,
    fixture: ingestStory,
    settle: 600,
    assert: async (tab) => [...(await lightIssues(tab)), ...(await overflowIssues(tab))],
  },

  'a7f-light-palette': {
    // 浅色:⌘K 命令面板(含搜笔记的分区)
    route: '/tasks?palette=1',
    ready: '.pal',
    init: lightTheme,
    settle: 600,
    assert: async (tab) => {
      const issues = [...(await lightIssues(tab, { root: '.pal' }))]
      await tab.locator('.pal-input').fill('#')
      await tab.waitForTimeout(300)
      issues.push(...(await lightIssues(tab, { root: '.pal' })))
      return [...new Set(issues)]
    },
  },

  'a7f-light-shortcuts': {
    // 浅色:快捷键表(手机没有)
    route: '/tasks',
    ready: '.kb-topbar',
    sizes: ['1180x820', '1440x900', '1920x1080'],
    init: lightTheme,
    settle: 400,
    assert: async (tab) => {
      await tab.keyboard.press('?')
      await tab.waitForSelector('[data-testid=shortcuts]', { timeout: 5000 })
      await tab.waitForTimeout(500)
      return lightIssues(tab, { root: '.kb-dialog' })
    },
  },

  'a7f-light-drawer': {
    // 浅色:通知抽屉
    route: '/tasks',
    ready: '.kb-topbar',
    init: lightTheme,
    settle: 400,
    assert: async (tab) => {
      if (await tab.locator('[data-tab=notify]').count()) await tab.locator('[data-tab=notify]').click()
      else await tab.locator('[data-testid=bell]').click()
      await tab.waitForSelector('[data-testid=notification-list]', { timeout: 5000 })
      await tab.waitForTimeout(500)
      return lightIssues(tab, { root: '.kb-drawer' })
    },
  },

  'a7f-light-account-menu': {
    // 浅色:头像菜单(手机的头像菜单也在顶栏右上角,同样查)
    route: '/tasks',
    ready: '.kb-topbar',
    init: lightTheme,
    settle: 400,
    assert: async (tab) => {
      await tab.locator('[data-testid=account-trigger]').first().click()
      await tab.waitForSelector('[data-testid=account-menu]', { timeout: 3000 })
      await tab.waitForTimeout(400)
      return lightIssues(tab, { root: '[data-testid=account-menu]' })
    },
  },

  'a7f-assistant-sessions-error': {
    // 助手页:历史会话列表读取失败——写"没能读取历史会话"并给重试(不是"还没有历史会话"),点了恢复;窄屏先点开"历史会话"
    route: '/assistant',
    ready: '[data-testid=assistant-page]',
    fixture: { ...ASSISTANT_SCENARIOS['assistant-page'].fixture, __capabilityError: { agent_sessions: { status: 503, message: '服务暂时不可用', times: 1 } } },
    expectConsole: /503|Failed to load resource/,
    settle: 600,
    assert: async (tab) => {
      const issues = []
      if (!(await tab.locator('.kb-agent-sessions').count())) {
        await tab.locator('[aria-label=历史会话]').click()
        await tab.waitForSelector('.kb-agent-sessions', { timeout: 5000 })
      }
      await tab.waitForSelector('[data-testid=sessions-error]', { timeout: 5000 }).catch(() => issues.push('读取失败应显示"没能读取历史会话"'))
      const body = await tab.evaluate(() => document.body.innerText)
      if (body.includes('还没有历史会话')) issues.push('读不到不能说成"还没有历史会话"')
      issues.push(...(await touchIssues(tab, '[data-testid=sessions-retry]')))
      return issues
    },
  },

  'a7f-assistant-sessions-retry': {
    // 点"重试"后历史会话列表恢复
    route: '/assistant',
    ready: '[data-testid=assistant-page]',
    fixture: { ...ASSISTANT_SCENARIOS['assistant-page'].fixture, __capabilityError: { agent_sessions: { status: 503, message: '服务暂时不可用', times: 1 } } },
    expectConsole: /503|Failed to load resource/,
    settle: 600,
    assert: async (tab) => {
      const issues = []
      if (!(await tab.locator('.kb-agent-sessions').count())) {
        await tab.locator('[aria-label=历史会话]').click()
        await tab.waitForSelector('.kb-agent-sessions', { timeout: 5000 })
      }
      await tab.locator('[data-testid=sessions-retry]').click()
      await tab.waitForSelector('[data-testid=sessions-error]', { state: 'detached', timeout: 5000 }).catch(() => issues.push('重试后错误提示应消失'))
      // 重试期间先是骨架屏,等会话行出来再看内容
      await tab.waitForSelector('.kb-agent-sessions-item', { timeout: 5000 }).catch(() => issues.push('重试后应列出历史会话'))
      if (!(await tab.locator('.kb-agent-sessions').innerText()).includes('梳理检索模块')) issues.push('重试后应列出「梳理检索模块」')
      return issues
    },
  },

  'a7f-assistant-welcome': {
    // 助手欢迎卡:用术语表里的说法(叫「AI 助手」,不叫"管家";不露 ACP / 工具链 / 条目);没有审核功能的账号看不到"审核收件箱"那张卡
    route: '/assistant',
    ready: '.kb-agent-welcome',
    fixture: { ...ASSISTANT_SCENARIOS['assistant-page'].fixture, __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => id !== 'ai.extract'), true) } },
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const text = (await tab.locator('.kb-agent-welcome').innerText()).replace(/\s+/g, ' ')
      for (const word of ['管家', 'ACP', '工具链', '条目']) if (text.includes(word)) issues.push(`欢迎卡不该出现「${word}」:${text.slice(0, 80)}`)
      if (!text.includes('AI 助手')) issues.push('欢迎卡标题应是「AI 助手」')
      if (text.includes('审核收件箱')) issues.push('没有"自动提炼与审核"功能的账号不该看到审核收件箱这张卡')
      if (!text.includes('总结最近新增与更新的笔记')) issues.push('其它预设卡应照常')
      issues.push(...(await touchIssues(tab, '.kb-agent-welcome button')))
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7f-loading-states': {
    // 读取中:审核、任务、导入记录各自显示骨架屏(role=status + aria-busy),页面上没有一行"读取中… / 加载中…"的文字;
    // 通知抽屉同理。截图停在最后一个(通知抽屉)的读取中上
    route: '/home',
    ready: '.kb-topbar',
    fixture: ingestStory,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const check = async (name, selector) => {
        await tab.waitForSelector(`${selector} [aria-busy=true], ${selector}[aria-busy=true]`, { timeout: 5000 }).catch(() => issues.push(`${name}:读取中应显示骨架屏(aria-busy)`))
        const plain = await tab.evaluate(() => /读取中|加载中…|加载中\.\.\./.test(document.querySelector('.content, .kb-drawer')?.innerText ?? ''))
        if (plain) issues.push(`${name}:读取中不该是一行文字`)
      }
      await hangThenGo(tab, /capabilities\/list_drafts/, '/review')
      await check('审核收件箱', '[data-testid=review-loading]')
      await hangThenGo(tab, /capabilities\/job_list/, '/tasks')
      await check('任务', '.kb-jobs-table')
      await hangThenGo(tab, /capabilities\/list_ingest/, '/import')
      await check('导入记录', '[data-testid=import-records]')
      await hangThenGo(tab, /capabilities\/notification_list/, '/tasks')
      if (await tab.locator('[data-tab=notify]').count()) await tab.locator('[data-tab=notify]').click()
      else await tab.locator('[data-testid=bell]').click()
      await tab.waitForSelector('.kb-drawer', { timeout: 5000 })
      await check('通知抽屉', '.kb-drawer')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7f-notify-forbidden': {
    // 通知抽屉:账号没有开通通知(403)——写"你的账号没有开通通知 / 请联系管理员",不给没用的重试,不照搬服务端的话
    route: '/tasks',
    ready: '.kb-topbar',
    fixture: { __notificationsFail: 403 },
    expectConsole: /403|Failed to load resource/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      if (await tab.locator('[data-tab=notify]').count()) await tab.locator('[data-tab=notify]').click()
      else await tab.locator('[data-testid=bell]').click()
      await tab.waitForSelector('[data-testid=notification-forbidden]', { timeout: 5000 }).catch(() => issues.push('403 应显示"没有开通通知"'))
      const text = (await tab.locator('.kb-drawer').innerText()).replace(/\s+/g, ' ')
      if (!text.includes('请联系管理员')) issues.push(`应写"请联系管理员",实际「${text}」`)
      if (await tab.locator('[data-testid=notification-error]').count()) issues.push('403 不该显示带重试的报错')
      issues.push(...(await touchIssues(tab, `.kb-drawer ${INTERACTIVE}`)))
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },

  'a7f-audit-filter': {
    // 审计日志页签的筛选控件完整可见、点得到(手机上以前被固定高度的标题条裁掉),选了之后带着它重新读取审计日志。
    // 管理组整理把这个页签换成了 AuditPanel(「按操作筛选」下拉),场景跟着改到新结构,意图不变
    route: '/admin/audit',
    ready: '.kb-ap-bar',
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const trigger = tab.locator('.kb-ap-bar .kb-select > button')
      const head = await tab.locator('.kb-ap-bar').boundingBox()
      const box = await trigger.boundingBox()
      if (!head || !box) return ['找不到筛选条或筛选控件']
      if (box.y + box.height > head.y + head.height + 1) issues.push(`筛选控件被标题条裁掉:控件底 ${Math.round(box.y + box.height)} > 标题条底 ${Math.round(head.y + head.height)}`)
      if (box.x < -1 || box.x + box.width > (await tab.evaluate(() => innerWidth)) + 1) issues.push('筛选控件不该超出屏幕')
      issues.push(...(await touchIssues(tab, '.kb-ap-bar .kb-select > button')))
      const sent = tab.waitForRequest((request) => request.url().includes('/capabilities/audit_list') && String(request.postData() ?? '').includes('save_insight'), { timeout: 4000 }).catch(() => null)
      await trigger.click()
      await tab.getByRole('option', { name: '保存笔记' }).click()
      if (!(await sent)) issues.push('选了筛选项后应带着它重新读取审计日志')
      issues.push(...(await overflowIssues(tab)))
      return issues
    },
  },
}
