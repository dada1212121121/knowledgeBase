// 「账号与分享」页面组的补充场景:登录 / 注册 / 找回密码 / 个人设置 / 外观 / 我的分享 / 公开分享页。
// 已有场景分散在 viewer-shots(login*/register*/me-*)、security-scenarios、share-scenarios、friends-scenarios、inapp-scenarios;
// 这里只补盘点出的缺口:触屏 44px、AI 关闭字样、出错重试与文案、浅色、键盘与软键盘。
// 经 viewer-shots.mjs 引入,默认跑 core 五个尺寸 × 两个引擎。
import { ALL_FEATURES, adminMe } from './fixture.mjs'
import { FAKE_VISUAL_VIEWPORT } from './device-scenarios.mjs'
import { imeCommit, imeCompose, imeKey } from './editor-helpers.mjs'
import { SHARE_STORY, publicPage, smallTargets } from './share-scenarios.mjs'
import { shareLog } from './share-fixture.mjs'

const lightTheme = () => localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'light' }))
const isCoarse = (tab) => tab.evaluate(() => window.matchMedia('(pointer: coarse)').matches)

/** AI 总开关关掉的账号(没有 ai.* 与深度检索);sys 功能按需保留 */
const aiOffMe = (keepSys = true) => ({
  __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('ai.') && id !== 'search.deep' && (keepSys || !id.startsWith('sys.'))), false) },
})
/** AI 关闭 + 有数据的分享夹具:SHARE_STORY 有我的分享 / 链接 / 公开页数据,再叠上 AI 关闭的账号 */
const aiOffShares = () => ({ ...SHARE_STORY, ...aiOffMe(true) })
/** 普通用户:没有任何 sys.* 功能 */
const plainMe = { __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('sys.')), true) } }

/** 整页横向溢出 */
async function pageOverflow(tab) {
  const over = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  return over > 1 ? [`整页横向溢出 ${over}px`] : []
}

/** 页面上(文字 + title / aria-label / placeholder)有没有「AI」字样 */
async function aiWords(tab) {
  return tab.evaluate(() => {
    const out = []
    const text = document.body.innerText
    if (/\bAI\b/i.test(text)) out.push(`文字里有「AI」:${(text.match(/.{0,12}\bAI\b.{0,12}/i) ?? [''])[0].replace(/\s+/g, ' ')}`)
    for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],[alt]')) {
      for (const name of ['title', 'aria-label', 'placeholder', 'alt']) {
        const value = el.getAttribute(name)
        if (value && /\bAI\b/i.test(value)) out.push(`${name}=「${value.slice(0, 24)}」在 <${el.tagName.toLowerCase()}>`)
      }
    }
    return out.slice(0, 4)
  })
}


/** 让匹配的请求直接断开(浏览器的 fetch 会抛 TypeError:Chrome「Failed to fetch」、Safari「Load failed」) */
const dropRequests = (tab, pattern) => tab.context().route(pattern, (route) => route.abort('connectionfailed'))
/** 网关挂了:502 + 非 JSON 响应体,前端拿不到服务端的原因,只剩状态码 */
const badGateway = (tab, pattern) => tab.context().route(pattern, (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }))

/** 报错文案的共同要求:不露英文异常 / 状态码,而且说了怎么办 */
function copyIssues(what, text, { needs }) {
  const issues = []
  if (!text.trim()) return [`${what}:没有显示任何错误提示`]
  if (/failed to fetch|load failed|networkerror|bad gateway|\b50\d\b|\b40\d\b|请求失败/i.test(text)) issues.push(`${what}:不该露出英文异常或状态码:「${text.trim()}」`)
  if (!needs.some((word) => text.includes(word))) issues.push(`${what}:应说清楚怎么办(含「${needs.join('」或「')}」):「${text.trim()}」`)
  return issues
}
const NEXT_STEP = ['检查网络', '稍后再试', '请重试']


/**
 * 输入框聚焦、软键盘(用假的 visualViewport 模拟)升起之后:输入框的下缘必须在键盘上沿以上。
 * 要求场景的 init 装 FAKE_VISUAL_VIEWPORT(init: FAKE_VISUAL_VIEWPORT)。键盘高度竖屏约 40%,手机横屏约一半。
 * 用 locator.focus 而不是点击:自动化里点击会先把元素滚进视口,掩盖「聚焦后才被键盘盖住」的问题。
 */
async function underKeyboard(tab, selector, size, what) {
  const field = tab.locator(selector).first()
  await field.scrollIntoViewIfNeeded()
  await field.focus()
  const height = Math.round(size.height * (size.height < 500 ? 0.5 : 0.4))
  await tab.evaluate((value) => window.__keyboard(value), height)
  await tab.waitForTimeout(500)
  const state = await tab.evaluate(() => document.documentElement.dataset.kbd)
  const issues = []
  if (state !== 'open') issues.push(`${what}:键盘升起后 <html data-kbd> 应是 open,实际 ${state}(这个页面没有量软键盘)`)
  const box = await field.boundingBox()
  if (!box) return [...issues, `${what}:找不到输入框`]
  if (box.y + box.height > size.height - height + 1) issues.push(`${what}被键盘挡住:输入框下缘 ${Math.round(box.y + box.height)} > 键盘上沿 ${size.height - height}`)
  if (box.y < 0) issues.push(`${what}被滚出了屏幕上方`)
  await tab.evaluate(() => window.__keyboard(0))
  await tab.waitForTimeout(200)
  return issues
}

/** 页面里最底下的可操作元素(提交按钮 / 链接)能滚进视口:没有被裁掉滚不到 */
async function reachableBottom(tab, selector, what) {
  const target = tab.locator(selector).last()
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  const view = tab.viewportSize()
  if (!box) return [`${what}:找不到 ${selector}`]
  if (box.y + box.height > view.height + 1 || box.y < -1) return [`${what}:滚动之后「${selector}」仍在屏幕外 y=${Math.round(box.y)}~${Math.round(box.y + box.height)} / ${view.height}(被裁掉滚不到)`]
  return []
}


/**
 * 浅色主题下每个头像的首字母(白字)与底色的对比度必须 ≥ 3:1(头像字是大号文字,WCAG 大文本的下限)。
 * 底色的色相由用户 id 哈希决定、均匀分布,所以不能只看一个头像:黄、绿、青段(约 45°~180°)在浅色下最容易不够深。
 */
async function avatarContrast(tab) {
  return tab.evaluate(() => {
    const parse = (c) => (c.match(/[\d.]+/g) ?? [0, 0, 0]).map(Number)
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const bad = []
    let seen = 0
    for (const initial of document.querySelectorAll('.kb-avatar-initial')) {
      const avatar = initial.closest('.kb-avatar')
      const rect = avatar.getBoundingClientRect()
      if (rect.width === 0) continue
      seen += 1
      const [high, low] = [lum(parse(getComputedStyle(initial).color)), lum(parse(getComputedStyle(avatar).backgroundColor))].sort((a, b) => b - a)
      const ratio = (high + 0.05) / (low + 0.05)
      if (ratio < 3) bad.push(`「${initial.textContent.trim()}」${ratio.toFixed(1)}:1(色相 ${getComputedStyle(avatar).getPropertyValue('--avatar-hue').trim()})`)
    }
    return { seen, bad }
  })
}


/**
 * 浅色主题可读性:逐个文字节点算它和实际背景的对比度(WCAG 公式,算法同 e2e/theme-check.mjs),< 3:1 记为看不清;
 * 再找写死的深色大块背景(浅色主题下不该有)。预览、代码块、主题卡片里的深色是有意的,排除。
 */
async function lightReadability(tab) {
  return tab.evaluate(() => {
    const parse = (c) => (c.match(/[\d.]+/g) ?? [0, 0, 0, 1]).map(Number)
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const skip = '.pvw,.kb-appearance-preview,.thc,.kb-theme-pv,pre,code,svg,[aria-hidden=true]'
    const bgOf = (el) => {
      for (let a = el; a; a = a.parentElement) {
        const style = getComputedStyle(a)
        if (style.backgroundImage && style.backgroundImage !== 'none') return null
        const c = parse(style.backgroundColor)
        if ((c[3] ?? 1) > 0.9) return c
      }
      return parse(getComputedStyle(document.body).backgroundColor)
    }
    const out = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim()
      const el = node.parentElement
      if (!text || !el || el.closest(skip)) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || Number(style.opacity) < 0.5) continue
      const box = el.getBoundingClientRect()
      if (box.width < 1 || box.height < 1) continue
      const bg = bgOf(el)
      if (!bg) continue
      const [high, low] = [lum(parse(style.color)), lum(bg)].sort((a, b) => b - a)
      const ratio = (high + 0.05) / (low + 0.05)
      if (ratio < 3) out.push(`${ratio.toFixed(1)}:1「${text.slice(0, 14)}」<${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}>`)
    }
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest(skip)) continue
      const c = parse(getComputedStyle(el).backgroundColor)
      if ((c[3] ?? 1) < 0.9) continue
      const r = el.getBoundingClientRect()
      if (r.width * r.height >= 4000 && lum(c) < 0.06) out.push(`写死的深色背景 ${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(r.width)}×${Math.round(r.height)}`)
    }
    return out.slice(0, 6)
  })
}
/** 浅色场景的壳:route / ready / fixture 之外,统一装浅色主题、查溢出和可读性;before 里可以先点出对话框、触发错误 */
const lightScenario = (route, ready, { fixture, before, sizes = ['390x844', '1440x900'] } = {}) => ({
  route,
  ready,
  init: lightTheme,
  ...(fixture ? { fixture } : {}),
  sizes,
  settle: 500,
  assert: async (tab) => {
    if (before) await before(tab)
    return [...(await pageOverflow(tab)), ...(await lightReadability(tab))]
  },
})


/**
 * 对话框键盘:打开后焦点进入框内;Tab 绕 12 次焦点始终在框内(焦点陷阱);Esc 关闭;关闭后焦点回到触发按钮。
 * 初始状态下表单的主按钮是禁用的(还没填完),这正是焦点陷阱最容易失效的时候:
 * 隐藏的提交按钮(<button type="submit" hidden tabindex="-1">)排在可见按钮后面,被当成「最后一个」。
 */
async function dialogKeyboard(tab, trigger, ready, what) {
  const issues = []
  await trigger.focus()
  await trigger.press('Enter')
  await tab.waitForSelector(ready)
  await tab.waitForTimeout(350)
  const inside = () => tab.evaluate(() => !!document.querySelector('.kb-dialog')?.contains(document.activeElement))
  if (!(await inside())) issues.push(`${what}:打开后焦点没有进入对话框`)
  for (let step = 1; step <= 12; step += 1) {
    await tab.keyboard.press('Tab')
    if (!(await inside())) {
      issues.push(`${what}:第 ${step} 次 Tab 焦点跑出了对话框(键盘用户会走到被遮罩盖住的背景页面里)`)
      break
    }
  }
  await tab.keyboard.press('Escape')
  await tab.waitForSelector('.kb-dialog', { state: 'detached' }).catch(() => issues.push(`${what}:按 Esc 没有关闭`))
  const back = await tab.evaluate(() => (document.activeElement === document.body ? 'body' : (document.activeElement?.textContent ?? '').trim()))
  const want = (await trigger.innerText()).trim()
  if (back !== want) issues.push(`${what}:关闭后焦点应回到触发按钮「${want}」,实际「${back}」`)
  return issues
}

/** 外观页左侧「系统设置」页签的文字(只有管理员该看到) */
const SETTINGS_TABS = ['存储与索引', '检索调权', 'MCP 接入', '访问令牌']

export const ACCOUNT_SCENARIOS = {
  // ---------------------------------------------------------------- 手机软键盘不盖住输入框 / 小屏不被裁
  'a7-keyboard-login': {
    // 登录页:密码框聚焦、键盘升起,输入框在键盘上沿以上(以前登录 / 注册 / 找回密码根本没量软键盘)
    route: '/login',
    ready: '#login-pass',
    init: FAKE_VISUAL_VIEWPORT,
    sizes: ['390x844', '844x390', '375x667'],
    settle: 400,
    assert: async (tab, size) => [...(await pageOverflow(tab)), ...(await underKeyboard(tab, '#login-pass', size, '登录·密码框'))],
  },
  'a7-keyboard-register': {
    // 注册页:最底下的密码框(带邀请码时更靠下)聚焦后要滚到键盘上方;提交按钮也能滚到
    route: '/register?invite=KB-7H2K-9QXA',
    ready: '#reg-pass',
    init: FAKE_VISUAL_VIEWPORT,
    sizes: ['390x844', '844x390', '375x667'],
    settle: 800,
    assert: async (tab, size) => [
      ...(await pageOverflow(tab)),
      ...(await underKeyboard(tab, '#reg-pass', size, '注册·密码框')),
      ...(await reachableBottom(tab, '.auth-submit', '注册·提交按钮')),
    ],
  },
  'a7-keyboard-forgot': {
    // 找回密码页:新密码框(最底下)聚焦后在键盘上沿以上
    route: '/forgot',
    ready: '#fg-pass',
    init: FAKE_VISUAL_VIEWPORT,
    sizes: ['390x844', '844x390', '375x667'],
    settle: 400,
    assert: async (tab, size) => [...(await pageOverflow(tab)), ...(await underKeyboard(tab, '#fg-pass', size, '找回密码·新密码框'))],
  },
  'a7-keyboard-totp': {
    // 登录第二步(验证码):6 格输入框聚焦,键盘升起后在上方
    route: '/login',
    ready: '#login-pass',
    init: FAKE_VISUAL_VIEWPORT,
    fixture: { __login: () => ({ status: 200, body: { totp_required: true, challenge: 'chal-1' } }) },
    sizes: ['390x844', '844x390', '375x667'],
    settle: 400,
    assert: async (tab, size) => {
      await tab.locator('#login-pass').fill('Correct-Horse-9')
      await tab.locator('#login-pass').press('Enter')
      await tab.waitForSelector('[data-testid=login-totp]')
      return [...(await pageOverflow(tab)), ...(await underKeyboard(tab, '.kb-otp-input', size, '验证码输入框'))]
    },
  },
  'a7-keyboard-public-comment': {
    // 公开页评论框:键盘升起后在上方(上一轮在微信场景里测过一次;这里在普通浏览器里也覆盖,并加横屏)
    route: '/s/tokGuide',
    ready: '[data-testid=comment-input]',
    init: FAKE_VISUAL_VIEWPORT,
    fixture: publicPage(),
    sizes: ['390x844', '844x390', '375x667'],
    settle: 500,
    assert: async (tab, size) => [...(await pageOverflow(tab)), ...(await underKeyboard(tab, '[data-testid=comment-input]', size, '公开页·评论框'))],
  },

  // ---------------------------------------------------------------- AI 总开关关掉:任何位置都不出现「AI」字样
  // 文字、title、aria-label、placeholder、alt 都查(进度条的 aria-label「我今天的 AI 额度」就藏在属性里)。
  // 注意这里查的是字样;「模型」「ACP 接入」这类 AI 相关入口有没有消失,由各页自己的场景断言(例如 a7-appearance-ai-off)。
  'a7-ai-off-auth': {
    // 登录 → 报错 → 两步验证第二步 → 注册 → 找回密码:这条链上的每一屏都没有「AI」
    route: '/login',
    ready: '#login-pass',
    fixture: { ...aiOffMe(true), __login: () => ({ status: 200, body: { totp_required: true, challenge: 'c' } }) },
    sizes: ['390x844', '1440x900'],
    settle: 400,
    assert: async (tab) => {
      const issues = (await aiWords(tab)).map((item) => `登录:${item}`)
      await tab.locator('#login-pass').fill('x')
      await tab.locator('#login-pass').press('Enter')
      await tab.waitForSelector('[data-testid=login-totp]')
      issues.push(...(await aiWords(tab)).map((item) => `两步验证:${item}`))
      for (const [path, ready, what] of [['/register', '#reg-pass', '注册'], ['/forgot', '#fg-pass', '找回密码']]) {
        await tab.goto(new URL(path, tab.url()).toString(), { waitUntil: 'networkidle' })
        await tab.waitForSelector(ready)
        issues.push(...(await aiWords(tab)).map((item) => `${what}:${item}`))
      }
      return issues
    },
  },
  'a7-ai-off-me': {
    // 个人设置整页:用量卡(今日 AI 额度、AI 工作区、进度条的 aria-label)+ 弹出的四个对话框都没有「AI」
    route: '/me',
    ready: '[data-testid=my-usage] .kb-mu',
    fixture: { ...aiOffMe(true), __totp: { enabled: false } },
    sizes: ['390x844', '1440x900'],
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab)), ...(await aiWords(tab)).map((item) => `个人设置:${item}`)]
      const open = [
        ['更换邮箱', async () => tab.locator('.kb-me-facts').getByRole('button', { name: '更换' }).click(), '.kb-ut-form'],
        ['注销账号', async () => tab.getByRole('button', { name: /注销账号…/ }).click(), '.kb-me-consequences'],
        ['开启两步验证', async () => tab.locator('[data-testid=totp-enable]').click(), '[data-testid=totp-flow]'],
        ['新建访问令牌', async () => tab.locator('[data-testid=token-new]').click(), '[data-testid=token-form]'],
      ]
      for (const [what, click, ready] of open) {
        await click()
        await tab.waitForSelector(ready)
        issues.push(...(await aiWords(tab)).map((item) => `${what}对话框:${item}`))
        await tab.keyboard.press('Escape')
        await tab.waitForSelector('.kb-dialog, [role=dialog]', { state: 'detached' }).catch(() => undefined)
      }
      return issues
    },
  },
  'a7-ai-off-share': {
    // 我的分享、分享面板、公开分享页各状态都没有「AI」
    route: '/shares',
    ready: '[data-testid=rtable]',
    fixture: aiOffShares(),
    sizes: ['390x844', '1440x900'],
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab)), ...(await aiWords(tab)).map((item) => `我的分享:${item}`)]
      for (const [token, ready, what] of [['tokView', '[data-testid=shared-doc-title]', '只读'], ['tokGuide', '[data-testid=comment-input]', '可评论'], ['tokSecret', '[data-testid=public-password]', '密码页'], ['tokExpired', '[data-testid=public-status]', '已过期'], ['tokFolder', '[data-testid=shared-folder]', '文件夹'], ['tokBundle', '[data-testid=public-content]', '打包']]) {
        await tab.goto(new URL(`/s/${token}`, tab.url()).toString(), { waitUntil: 'networkidle' })
        await tab.waitForSelector(ready)
        issues.push(...(await aiWords(tab)).map((item) => `公开页·${what}:${item}`))
      }
      return issues
    },
    expectConsole: /status of 410/,
  },
  'a7-ai-off-appearance': {
    // 外观页:普通用户和管理员在 AI 关闭时都没有「AI」字样
    route: '/me/appearance',
    ready: '.ap',
    fixture: aiOffMe(false),
    sizes: ['390x844', '1440x900'],
    settle: 500,
    assert: async (tab) => [...(await pageOverflow(tab)), ...(await aiWords(tab))],
  },

  // ---------------------------------------------------------------- 键盘:对话框的焦点陷阱 / Esc / 焦点归位
  'a7-keyboard-me-dialogs': {
    // 个人设置的四个对话框:更换邮箱、注销账号、开启两步验证、新建访问令牌
    // (以前主按钮禁用时 Tab 会跑出对话框:隐藏的提交按钮被当成了「最后一个」)
    route: '/me',
    ready: '[data-testid=totp-enable]',
    fixture: { __totp: { enabled: false } },
    sizes: ['1440x900', '390x844'],
    settle: 500,
    assert: async (tab) => [
      ...(await dialogKeyboard(tab, tab.locator('.kb-me-facts').getByRole('button', { name: '更换' }), '.kb-ut-form', '更换邮箱')),
      ...(await dialogKeyboard(tab, tab.getByRole('button', { name: /注销账号…/ }), '.kb-me-consequences', '注销账号')),
      ...(await dialogKeyboard(tab, tab.locator('[data-testid=totp-enable]'), '[data-testid=totp-flow]', '开启两步验证')),
      ...(await dialogKeyboard(tab, tab.locator('[data-testid=token-new]'), '[data-testid=token-form]', '新建令牌')),
    ],
  },

  'a7-public-code-toolbar-touch': {
    // 公开页 / 共享页里只读的代码 / 文本查看器,顶上「查找」「换行」两个小按钮:触屏上可点区域要 ≥44px
    // (以前 min-height / min-width 写的是 36)。
    // 链接要指向一个代码文件(tokCode → scripts/restart.sh):Markdown(原来用的 guide.md)走渲染器,根本没有这两个按钮
    route: '/s/tokCode',
    ready: '.kb-ce .kb-ce-btn',
    fixture: publicPage(),
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab))]
      if (await isCoarse(tab)) for (const item of await smallTargets(tab, '.kb-ce .kb-ce-btn')) issues.push(`触屏可点区域不足 44px:${item}`)
      return issues
    },
  },

  // ---------------------------------------------------------------- 四种状态:加载
  'a7-public-loading': {
    // 公开分享页的加载态:接口慢的时候(微信里的慢网)不能是空白,要有占位(role=status、aria-label=加载中);回来后占位消失、正文出现
    // (此前这页的 正常 / 密码 / 失效 / 无权限 都有场景,加载态没有)
    route: '/s/tokView',
    ready: 'body',
    fixture: publicPage({ delayMs: 2500 }),
    sizes: ['390x844', '1440x900'],
    settle: 100,
    assert: async (tab) => {
      const issues = []
      await tab.reload({ waitUntil: 'commit' })
      await tab.waitForSelector('[data-testid=public-page]')
      const during = await tab.evaluate(() => {
        const skeleton = document.querySelector('[data-testid=public-page] .kb-skel')
        const box = skeleton?.getBoundingClientRect()
        return { skeleton: !!skeleton, role: skeleton?.getAttribute('role'), label: skeleton?.getAttribute('aria-label'), height: Math.round(box?.height ?? 0), overflow: document.documentElement.scrollWidth - window.innerWidth }
      })
      if (!during.skeleton) issues.push('加载中应该有骨架占位,实际页面是空的')
      else {
        if (during.role !== 'status' || during.label !== '加载中') issues.push(`骨架应带 role=status 和 aria-label=加载中,实际 role=${during.role} label=${during.label}`)
        if (during.height < 40) issues.push(`骨架高度只有 ${during.height}px,几乎看不见`)
      }
      if (during.overflow > 1) issues.push(`加载中整页横向溢出 ${during.overflow}px`)
      await tab.waitForSelector('[data-testid=shared-doc-title]', { timeout: 10_000 })
      // 正文先出来、评论区的骨架晚一点才消失(渐进加载),所以等所有骨架都没了再算;卡住不消失才是问题
      await tab.waitForFunction(() => !document.querySelector('[data-testid=public-page] .kb-skel'), null, { timeout: 10_000 }).catch(() => issues.push('加载完成后骨架应消失,10 秒后还有骨架没散'))
      return issues
    },
  },

  // ---------------------------------------------------------------- 触屏:表格选择列
  'a7-shares-table-touch': {
    // 我的分享(平板宽度走表格):触屏上复选框只有 22px,但整个选择格(52×48)都要是点击目标。
    // 用真实点击验证:点在复选框旁边 18px 的空白处也能勾上,并且不会误打开这一行;点复选框本身只切换一次
    route: '/shares',
    ready: '[data-testid=rtable] [data-testid=rt-row]',
    fixture: SHARE_STORY,
    sizes: ['820x1180', '1180x820'],
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab))]
      const box = tab.locator('[data-testid=rtable] tbody [data-testid=rt-row]').first().locator('input[type=checkbox]')
      const rect = await box.boundingBox()
      const cell = await box.evaluate((el) => {
        const r = el.closest('td').getBoundingClientRect()
        return { left: r.left, right: r.right }
      })
      if (!rect) return [...issues, '找不到第一行的复选框']
      // 取点:复选框右缘到格子右缘的中点(框外、格内)。不写死像素偏移:格子是 52 宽、框 22 宽且偏左,
      // 偏移取大了会落到格子外面的下一列(写死 +18 就恰好踩在格子边界上)
      const spaceX = (rect.x + rect.width + cell.right) / 2
      const spaceY = rect.y + rect.height / 2
      if (spaceX - (rect.x + rect.width) < 3) return [...issues, `复选框右边没有足够的空白可点(${Math.round(cell.right - rect.x - rect.width)}px),场景量不到东西`]
      const url = tab.url()
      await tab.mouse.click(spaceX, spaceY)
      if (!(await box.isChecked())) issues.push('点复选框旁边的空白处没有勾上(触屏上要精确点中 22px 的方框才行)')
      if (tab.url() !== url) issues.push('点选择格不该打开这一行')
      // 再点一次空白取消;然后直接点复选框本身,只切换一次(没有被格子的转发再切回去)
      await tab.mouse.click(spaceX, spaceY)
      if (await box.isChecked()) issues.push('再点一次空白处应取消勾选')
      await box.click()
      if (!(await box.isChecked())) issues.push('直接点复选框应勾上(只切换一次)')
      return issues
    },
  },

  // ---------------------------------------------------------------- 键盘:评论框的 Enter
  'a7-keyboard-comment-enter': {
    // 评论框:普通 Enter 是换行,Ctrl/⌘+Enter 才提交;中文输入法组字时按 Enter(把拼音上屏)绝不能提交——
    // 否则每次打中文都会把「nihao」当评论发出去。输入法用 e2e/editor-helpers.mjs 的模拟(Chromium 走 CDP,WebKit 走合成事件)
    route: '/s/tokGuide',
    ready: '[data-testid=comment-input]',
    fixture: publicPage(),
    sizes: ['1440x900', '390x844'],
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab))]
      const posts = async () => (await shareLog(tab)).filter((entry) => entry.name === 'public:add_annotation').length
      const input = tab.locator('[data-testid=comment-input]')
      if (!(await tab.locator('[data-testid=comment-send]').isDisabled())) issues.push('没写内容时「发表评论」应禁用')
      await input.click()
      await tab.keyboard.type('第一行')
      await tab.keyboard.press('Enter')
      await tab.keyboard.type('第二行')
      if ((await posts()) !== 0) issues.push('普通 Enter 不该提交评论(应是换行)')
      if (!(await input.inputValue()).includes('\n')) issues.push('普通 Enter 应该在评论框里换行')
      await input.fill('')
      await input.click()
      await imeCompose(tab, 'nihao')
      await imeKey(tab, 'Enter')
      if ((await posts()) !== 0) issues.push('输入法组字时按 Enter(拼音上屏)提交了评论:每次打中文都会把拼音当评论发出去')
      await imeCommit(tab, '你好')
      await input.fill('收到')
      await tab.keyboard.press('Control+Enter')
      await tab.waitForFunction(() => document.querySelectorAll('[data-testid=comment]').length >= 2, null, { timeout: 5000 }).catch(() => undefined)
      if ((await posts()) !== 1) issues.push(`Ctrl+Enter 应提交一次评论,实际 ${await posts()} 次`)
      if ((await input.inputValue()) !== '') issues.push('提交后评论框应清空')
      return issues
    },
  },

  // ---------------------------------------------------------------- 浅色
  'a7-light-avatar': {
    // 浅色主题下头像首字母看得清:默认管理员(色相 68°)的白字以前只有 2.2:1,约三分之一的用户 id 落在看不清的黄绿青段
    route: '/me',
    ready: '.kb-me-avatar .kb-avatar-initial',
    init: lightTheme,
    sizes: ['390x844', '1440x900'],
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab))]
      const { seen, bad } = await avatarContrast(tab)
      if (seen === 0) issues.push('页面上没有找到头像首字母,场景没有量到东西')
      for (const item of bad) issues.push(`浅色下头像首字母看不清:${item}`)
      return issues
    },
  },

  'a7-light-avatar-hues': {
    // 扫遍色相:头像底色的色相由用户 id 哈希决定,上面的场景只量得到默认管理员这一种。
    // 往页面里放一批带不同 --avatar-hue 的真实 .kb-avatar(用的是线上同一条 CSS 规则),逐个量,每 5° 一个,最差的也要 ≥ 3:1
    route: '/me',
    ready: '.kb-me-avatar .kb-avatar-initial',
    init: lightTheme,
    sizes: ['1440x900'],
    settle: 500,
    assert: async (tab) => {
      const worst = await tab.evaluate(() => {
        const parse = (c) => (c.match(/[\d.]+/g) ?? [0, 0, 0]).map(Number)
        const lum = ([r, g, b]) => {
          const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
        }
        const host = document.createElement('div')
        document.body.append(host)
        let worst = { ratio: 99, hue: -1 }
        for (let hue = 0; hue < 360; hue += 5) {
          host.innerHTML = `<span class="kb-avatar" style="--avatar-size:32px;--avatar-hue:${hue}"><span class="kb-avatar-initial">甲</span></span>`
          const avatar = host.firstElementChild
          const [high, low] = [lum(parse(getComputedStyle(avatar.firstElementChild).color)), lum(parse(getComputedStyle(avatar).backgroundColor))].sort((a, b) => b - a)
          const ratio = (high + 0.05) / (low + 0.05)
          if (ratio < worst.ratio) worst = { ratio, hue }
        }
        host.remove()
        return worst
      })
      return worst.ratio < 3 ? [`浅色下有的色相头像首字母看不清:最差 ${worst.ratio.toFixed(2)}:1(色相 ${worst.hue}°)`] : []
    },
  },

  'a7-light-login': lightScenario('/login', '.auth-box'),
  'a7-light-login-error': {
    // 登录报错在浅色下也看得清(错误色是红字,最容易在浅底上过淡)
    ...lightScenario('/login', '#login-pass', {
      fixture: { __login: () => ({ status: 401, body: { message: '用户名或密码不对' } }) },
      before: async (tab) => {
        await tab.locator('#login-pass').fill('x')
        await tab.locator('#login-pass').press('Enter')
        await tab.waitForSelector('.auth-error')
      },
    }),
    expectConsole: /status of 401/,
  },
  'a7-light-register': lightScenario('/register', '#reg-pass', {
    before: async (tab) => {
      // 填出会触发的提示:太短的密码、不合规的用户名
      await tab.locator('#reg-user').fill('a')
      await tab.locator('#reg-pass').fill('1')
      await tab.waitForTimeout(300)
    },
  }),
  'a7-light-forgot': lightScenario('/forgot', '#fg-pass'),
  'a7-light-me-dialogs': lightScenario('/me', '.kb-me-facts', {
    // 个人设置里的两个对话框(更换邮箱、注销账号)在浅色下的配色
    before: async (tab) => {
      await tab.locator('.kb-me-facts').getByRole('button', { name: '更换' }).click()
      await tab.waitForSelector('.kb-ut-form')
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('.kb-ut-form', { state: 'detached' })
      await tab.getByRole('button', { name: /注销账号…/ }).click()
      await tab.waitForSelector('.kb-me-consequences')
    },
  }),
  'a7-light-appearance': lightScenario('/me/appearance', '.ap'),
  'a7-light-shares': lightScenario('/shares', '[data-testid=rtable]', { fixture: SHARE_STORY }),
  'a7-light-public-states': {
    // 公开分享页的几种状态在浅色下可读:文档 + 评论、需要密码、已过期;一个场景里依次打开
    route: '/s/tokGuide',
    ready: '[data-testid=comment-input]',
    init: lightTheme,
    fixture: publicPage(),
    expectConsole: /status of 410/, // 依次打开「已过期」链接,410 是预期的
    sizes: ['390x844', '1440x900'],
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab)), ...(await lightReadability(tab)).map((item) => `评论页:${item}`)]
      for (const [token, ready, what] of [['tokSecret', '[data-testid=public-password]', '密码页'], ['tokExpired', '[data-testid=public-status]', '已过期'], ['tokFolder', '[data-testid=shared-folder]', '文件夹']]) {
        await tab.goto(new URL(`/s/${token}`, tab.url()).toString(), { waitUntil: 'networkidle' })
        await tab.waitForSelector(ready)
        issues.push(...(await lightReadability(tab)).map((item) => `${what}:${item}`))
      }
      return issues
    },
  },

  // ---------------------------------------------------------------- 报错文案(发生了什么 + 你可以怎么做)
  'a7-copy-login': {
    // 登录:断网说连不上并让人检查网络;网关挂了(没有服务端原因)不露状态码;两种情况之后都还能再试
    route: '/login',
    ready: '#login-pass',
    expectConsole: /ERR_CONNECTION_FAILED|status of 502/, // 场景自己制造的断网 / 网关错误,浏览器会把它们打进控制台
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab))]
      await dropRequests(tab, '**/api/v1/auth/login')
      await tab.locator('#login-pass').fill('secret')
      await tab.locator('#login-pass').press('Enter')
      await tab.waitForSelector('.auth-error')
      issues.push(...copyIssues('登录·断网', await tab.locator('.auth-error').innerText(), { needs: ['检查网络'] }))
      await tab.context().unroute('**/api/v1/auth/login')
      await badGateway(tab, '**/api/v1/auth/login')
      await tab.locator('#login-pass').press('Enter')
      await tab.waitForFunction(() => /稍后再试/.test(document.querySelector('.auth-error')?.textContent ?? ''))
      issues.push(...copyIssues('登录·网关错误', await tab.locator('.auth-error').innerText(), { needs: ['稍后再试'] }))
      if (await tab.locator('#login-pass').isDisabled()) issues.push('出错后输入框不该被锁住,要能再试')
      return issues
    },
  },
  'a7-copy-register': {
    // 注册:获取验证码断网、提交时网关挂了,都是人话;「获取验证码」按钮出错后仍可再点
    route: '/register',
    ready: '#reg-email',
    expectConsole: /ERR_CONNECTION_FAILED|status of 502/, // 场景自己制造的断网 / 网关错误,浏览器会把它们打进控制台
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab))]
      await dropRequests(tab, '**/api/v1/auth/email-code')
      await tab.locator('#reg-email').fill('new@example.com')
      await tab.getByRole('button', { name: '获取验证码' }).click()
      await tab.waitForFunction(() => /连不上服务器/.test(document.body.innerText))
      const sendError = await tab.evaluate(() => [...document.querySelectorAll('.auth-help.is-bad, .auth-error, [role=alert]')].map((el) => el.textContent.trim()).join(' '))
      issues.push(...copyIssues('注册·获取验证码断网', sendError, { needs: ['检查网络'] }))
      if (await tab.getByRole('button', { name: '获取验证码' }).isDisabled()) issues.push('验证码没发出去时按钮不该一直禁用(没有倒计时),要能再点')
      await badGateway(tab, '**/api/v1/auth/register')
      await tab.locator('#reg-code').fill('123456')
      await tab.locator('#reg-user').fill('new_user')
      await tab.locator('#reg-pass').fill('a-Strong-pass-123')
      await tab.getByRole('button', { name: '注册', exact: true }).click()
      await tab.waitForSelector('.auth-error')
      issues.push(...copyIssues('注册·网关错误', await tab.locator('.auth-error').innerText(), { needs: ['稍后再试'] }))
      return issues
    },
  },
  'a7-copy-forgot': {
    // 找回密码:提交时断网是人话
    route: '/forgot',
    ready: '#fg-email',
    expectConsole: /ERR_CONNECTION_FAILED|status of 502/, // 场景自己制造的断网 / 网关错误,浏览器会把它们打进控制台
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab))]
      await tab.locator('#fg-email').fill('a@example.com')
      await tab.locator('#fg-code').fill('123456')
      await tab.locator('#fg-pass').fill('a-Strong-pass-123')
      await dropRequests(tab, '**/api/v1/auth/password/reset')
      await tab.getByRole('button', { name: '重置密码' }).click()
      await tab.waitForSelector('.auth-error')
      issues.push(...copyIssues('找回密码·断网', await tab.locator('.auth-error').innerText(), { needs: ['检查网络'] }))
      return issues
    },
  },
  'a7-copy-forgot-retry': {
    // 找回密码页打开时连不上服务:整页不能只剩一句话,要有「重试」;重试成功后出现表单
    route: '/forgot',
    ready: '[data-testid=auth-retry]',
    fixture: { __authStatusFail: { status: 'abort', times: 2 } },
    expectConsole: /ERR_CONNECTION_FAILED|status of 502/, // 场景自己制造的断网 / 网关错误,浏览器会把它们打进控制台
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab))]
      issues.push(...copyIssues('找回密码·打不开', await tab.locator('.auth-box').innerText(), { needs: ['检查网络'] }))
      // 第一次重试仍然连不上(夹具让 /auth/status 连续断开两次):页面要留在可重试状态,不能变成死页面
      await tab.locator('[data-testid=auth-retry]').click()
      await tab.waitForTimeout(400)
      if (!(await tab.locator('[data-testid=auth-retry]').isVisible())) issues.push('重试仍失败时,「重试」按钮应还在,让人能再试')
      issues.push(...copyIssues('找回密码·重试仍失败', await tab.locator('.auth-box').innerText(), { needs: ['检查网络'] }))
      // 第二次重试连上了:表单出现,「重试」消失
      await tab.locator('[data-testid=auth-retry]').click()
      await tab.waitForSelector('#fg-email')
      if (await tab.locator('[data-testid=auth-retry]').count()) issues.push('重试成功后「重试」按钮应消失')
      return issues
    },
  },
  'a7-copy-register-retry': {
    // 注册页打开时连不上服务:同上,有「重试」
    route: '/register',
    ready: '[data-testid=auth-retry]',
    fixture: { __authStatusFail: { status: 'abort', times: 2 } },
    expectConsole: /ERR_CONNECTION_FAILED|status of 502/, // 场景自己制造的断网 / 网关错误,浏览器会把它们打进控制台
    settle: 400,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab))]
      issues.push(...copyIssues('注册·打不开', await tab.locator('.auth-box').innerText(), { needs: ['检查网络'] }))
      await tab.locator('[data-testid=auth-retry]').click()
      await tab.waitForTimeout(400)
      if (!(await tab.locator('[data-testid=auth-retry]').isVisible())) issues.push('重试仍失败时,「重试」按钮应还在,让人能再试')
      await tab.locator('[data-testid=auth-retry]').click()
      await tab.waitForSelector('#reg-email')
      if (await tab.locator('[data-testid=auth-retry]').count()) issues.push('重试成功后「重试」按钮应消失')
      return issues
    },
  },
  'a7-copy-me': {
    // 个人设置:更换邮箱(发验证码断网)、注销申请(网关挂了),错误提示在对话框里,人话 + 下一步
    route: '/me',
    ready: '.kb-me-facts',
    sizes: ['390x844', '1440x900'],
    expectConsole: /ERR_CONNECTION_FAILED|status of 502/, // 场景自己制造的断网 / 网关错误,浏览器会把它们打进控制台
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab))]
      await tab.locator('.kb-me-facts').getByRole('button', { name: '更换' }).click()
      await tab.waitForSelector('.kb-ut-form')
      const field = (label) => tab.locator('.kb-ut-form label', { hasText: label }).locator('input')
      await field('新邮箱').fill('new.me@example.com')
      await field('当前密码').fill('old-password-1')
      await dropRequests(tab, '**/api/v1/me/email-code')
      await tab.getByRole('button', { name: '发送验证码' }).click()
      await tab.waitForSelector('.kb-ut-form [role=alert]')
      issues.push(...copyIssues('更换邮箱·断网', await tab.locator('.kb-ut-form [role=alert]').innerText(), { needs: ['检查网络'] }))
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('.kb-ut-form', { state: 'detached' })

      await tab.getByRole('button', { name: /注销账号…/ }).click()
      await tab.waitForSelector('.kb-me-consequences')
      await tab.locator('.kb-ut-form input[type=password]').fill('old-password-1')
      await badGateway(tab, '**/api/v1/me/deletion')
      await tab.locator('.kb-ut-form').getByRole('button', { name: '申请注销', exact: true }).click()
      await tab.waitForSelector('.kb-ut-form [role=alert]')
      issues.push(...copyIssues('注销·网关错误', await tab.locator('.kb-ut-form [role=alert]').innerText(), { needs: ['稍后再试'] }))
      return issues
    },
  },

  'a7-appearance-plain': {
    // 个人外观页对所有用户开放:普通用户不该看到「系统设置」的页签(点进去只会是「没有开通」),面包屑写「个人设置」
    // (以前每个人的外观页左边都挂着 存储与索引 / 模型 / ACP 接入 / 备份 … 一整串系统设置页签)
    route: '/me/appearance',
    ready: '.ap',
    fixture: plainMe,
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab))]
      const text = await tab.evaluate(() => document.body.innerText)
      for (const word of [...SETTINGS_TABS, '模型', 'ACP 接入', '备份']) if (text.includes(word)) issues.push(`普通用户的外观页不该出现系统设置页签「${word}」`)
      if (await tab.locator('.kb-settings-nav').count()) issues.push('普通用户的外观页不该渲染系统设置导航栏(会留下空侧栏)')
      for (const word of ['主题', '强调色', '列表密度']) if (!text.includes(word)) issues.push(`外观内容缺少「${word}」`)
      const crumb = await tab.locator('.kb-topbar-bc').innerText().catch(() => '')
      if (crumb && !crumb.includes('个人设置')) issues.push(`面包屑应是「个人设置 / 外观」,实际:${crumb}`)
      return issues
    },
  },
  'a7-appearance-admin': {
    // 管理员的外观页保持原样:系统设置页签都在,点「存储与索引」去系统设置对应页签
    route: '/me/appearance',
    ready: '.kb-settings-nav',
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab))]
      const nav = await tab.locator('.kb-settings-nav').innerText()
      for (const word of [...SETTINGS_TABS, '模型', 'ACP 接入']) if (!nav.includes(word)) issues.push(`管理员的外观页应保留页签「${word}」`)
      await tab.locator('.kb-settings-nav .ni', { hasText: '存储与索引' }).click()
      await tab.waitForURL(/\/admin\/settings\?tab=storage/)
      return issues
    },
  },
  'a7-appearance-ai-off': {
    // AI 总开关关掉:管理员的外观页导航里不出现「模型」「ACP 接入」(都是 AI 相关),其余页签照旧
    route: '/me/appearance',
    ready: '.kb-settings-nav',
    fixture: aiOffMe(true),
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab)), ...(await aiWords(tab))]
      const nav = await tab.locator('.kb-settings-nav').innerText()
      for (const word of ['模型', 'ACP 接入']) if (nav.includes(word)) issues.push(`AI 关闭后不该有页签「${word}」`)
      for (const word of ['常规', '存储与索引', '备份']) if (!nav.includes(word)) issues.push(`其余页签应照常,缺「${word}」`)
      return issues
    },
  },
  'a7-public-login-hint-touch': {
    // 游客在只读链接里看到「想参与编辑?登录后…」:这行字中间的「登录」触屏上可点区域要 ≥44px
    // (以前只有 24×15,拇指几乎点不中,而这恰是游客想编辑时唯一要点的东西)
    route: '/s/tokView',
    ready: '[data-testid=public-login-hint]',
    fixture: publicPage(),
    settle: 500,
    assert: async (tab) => {
      const issues = [...(await pageOverflow(tab))]
      if (await isCoarse(tab)) for (const item of await smallTargets(tab, '[data-testid=public-login-hint] a')) issues.push(`触屏可点区域不足 44px:${item}`)
      return issues
    },
  },
}
