// 编辑器场景共用的夹具与小工具(viewer-shots.mjs 里的老编辑场景和 editor-mobile-scenarios.mjs 都用)。
import { ALL_FEATURES, adminMe } from './fixture.mjs'
import { FAKE_VISUAL_VIEWPORT } from './device-scenarios.mjs'

export { FAKE_VISUAL_VIEWPORT }

/**
 * 单人编辑夹具:默认夹具里的用户带 space_id 且拥有 collab.edit,进编辑就会去连协作房间;
 * 假后端没有这个房间(只有 collab-scenarios 自己接了假房间),编辑器会一直处于「正在连接」的只读状态。
 * 这些场景测的是单人编辑路径,所以把协作功能点关掉。
 */
export const SOLO_EDIT_FIXTURE = {
  __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => id !== 'collab.edit'), true) },
}

export const COLLECTION = 'knowledgeBase%2Finsights'

/** 当前页面跑在哪个引擎上:IME 模拟在 Chromium 用 CDP,在 WebKit 用合成事件 */
export const engineOf = (tab) => tab.context().browser().browserType().name()

/**
 * 新建一篇笔记并把光标放进正文(空文档,避免被样例正文里的链接 / 列表干扰)。
 * 用作场景的 prepare:路由是 `/kb?collection=…`。
 */
export async function openNewDoc(tab) {
  await tab.getByRole('button', { name: /新建/ }).first().click()
  await tab.waitForSelector('.kb-dp textarea.kb-dp-title', { timeout: 15_000 })
  await tab.waitForSelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)[contenteditable="true"]', { timeout: 15_000 })
  await tab.fill('.kb-dp textarea.kb-dp-title', '输入法与手机编辑')
  await tab.keyboard.press('Enter')
  await tab.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'), null, { timeout: 5000 })
}

/** 正文各块的简化 HTML(去掉属性、虚拟光标),断言文档结构用 */
export const blocksOf = (tab) =>
  tab.evaluate(() =>
    [...document.querySelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)').children]
      .filter((el) => !el.classList.contains('prosemirror-virtual-cursor'))
      .map((el) => el.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/ (data-[a-z-]+|class|contenteditable|style|id)="[^"]*"/g, '').replace(/<br>/g, '').slice(0, 120)),
  )

/* ---------------- 输入法(IME)模拟 ---------------- */
const cdpSessions = new WeakMap()
async function cdpOf(tab) {
  let session = cdpSessions.get(tab)
  if (!session) {
    session = await tab.context().newCDPSession(tab)
    cdpSessions.set(tab, session)
  }
  return session
}

/**
 * 开始(或更新)一段组字:焦点元素里出现带下划线的拼音。
 * Chromium 用 CDP 的 Input.imeSetComposition(真实的 compositionstart/update + 带 isComposing 的事件流);
 * WebKit 不支持 CDP 输入法,退而用合成事件:发 compositionstart,再用 execCommand 把预编辑文字写进焦点元素。
 */
export async function imeCompose(tab, text) {
  if (engineOf(tab) === 'chromium') {
    await (await cdpOf(tab)).send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
    return
  }
  await tab.evaluate((value) => {
    const el = document.activeElement
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    document.execCommand('insertText', false, value)
    el.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: value }))
  }, text)
}

/** 组字过程中的一次按键:keyCode 229 + isComposing,和真实输入法选词 / 上屏 / 取消时浏览器发的 keydown 一致 */
export async function imeKey(tab, key) {
  await tab.evaluate((value) => {
    const init = { key: value, code: value, keyCode: 229, isComposing: true, bubbles: true, cancelable: true }
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', init))
    document.activeElement.dispatchEvent(new KeyboardEvent('keyup', init))
  }, key)
}

/** 选词上屏:组字结束,文字变成最终文本(compositionend) */
export async function imeCommit(tab, text) {
  if (engineOf(tab) === 'chromium') {
    await (await cdpOf(tab)).send('Input.insertText', { text })
    return
  }
  await tab.evaluate((value) => document.activeElement.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value })), text)
}

/* ---------------- 软键盘(假的 visualViewport)与设备判断 ---------------- */

/** 这个尺寸按设计算不算「手机」:视口宽 < 600,或屏幕短边 < 500(手机横屏)。和 utils/editorMobile.ts 的规则一致,但在这里独立写一遍,断言才有意义 */
export const isPhoneLike = (size) => size.width < 600 || Math.min(size.width, size.height) < 500

/** 键盘高度:竖屏约 40%,手机横屏键盘占一半(横屏键盘比例更大) */
export const keyboardHeight = (size) => Math.round(size.height * (size.height < 500 ? 0.5 : 0.4))

/** 弹出 / 收起假键盘(要求场景的 init 装了 FAKE_VISUAL_VIEWPORT),等 useVisualViewport 的滚动定时器走完 */
export async function setKeyboard(tab, height) {
  await tab.evaluate((value) => window.__keyboard(value), height)
  await tab.waitForTimeout(350)
}

/** 取元素矩形(找不到返回 null) */
export const rectOf = (tab, selector) =>
  tab.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }
  }, selector)

/** 等元素位置稳定(进场动画、滚动结束):连续两次 top 相同 */
export async function settled(tab, selector, timeout = 2000) {
  let last = null
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const rect = await rectOf(tab, selector)
    if (rect && last && rect.top === last.top && rect.bottom === last.bottom) return rect
    last = rect
    await tab.waitForTimeout(60)
  }
  return last
}

/** 在正文末尾打 n 行文字,让文档长到需要滚动(用 insertText 比逐键快) */
export async function fillLines(tab, count) {
  for (let i = 1; i <= count; i += 1) {
    await tab.keyboard.insertText(`第 ${i} 行,用来把文档撑长`)
    await tab.keyboard.press('Enter')
  }
}

/** 这个页面里菜单该不该是底部面板:宽度 <600,或主要输入是触屏。问浏览器(同一个尺寸 Chromium 与 WebKit 的 pointer 判断可能不同),不猜 */
export const wantsSheet = (tab) => tab.evaluate(() => innerWidth < 600 || matchMedia('(pointer: coarse)').matches)

/**
 * 点一个元素的中心:触屏用真正的触摸(touchstart/touchend → pointer 事件),否则用鼠标。
 * 先把它滚进可见区(面板内的列表可能只露出一两行),再确认那个点上最顶层的元素就是它自己或它的子元素——
 * 否则点击会落在盖在上面的别的东西上(例如被面板压住的工具栏按钮),测试里很难看出来。
 */
export async function tapCenter(tab, locator) {
  await locator.scrollIntoViewIfNeeded()
  // 菜单列表带 scroll-behavior: smooth,滚动没停就量位置会点偏:等连续两次矩形一样
  let box = await locator.boundingBox()
  for (let i = 0; i < 40; i += 1) {
    await tab.waitForTimeout(50)
    const next = await locator.boundingBox()
    const same = box && next && box.x === next.x && box.y === next.y
    box = next
    if (same) break
  }
  if (!box) throw new Error('要点的元素没有矩形')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const handle = await locator.elementHandle()
  const hit = await handle.evaluate((el, point) => {
    const top = document.elementFromPoint(point.x, point.y)
    return el.contains(top) ? null : (top ? `${top.tagName}.${String(top.className).slice(0, 40)}` : '屏幕之外')
  }, { x, y })
  if (hit) throw new Error(`要点的元素被别的东西盖住了,点击会落在 ${hit} 上`)
  const touch = await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (touch) await tab.touchscreen.tap(x, y)
  else await tab.mouse.click(x, y)
  return box
}

/**
 * 面板上沿以上、编辑区可滚动容器可见部分里,放不放得下一行字(≥40px)。
 * 手机横屏键盘弹出后可视高度只有 ~200px,顶栏 + 贴键盘的工具栏 + 面板已经占满,物理上没地方给光标行,这时不该断言「光标行没被盖住」。
 */
export const roomForCaretAbove = (tab, panelTop) =>
  tab.evaluate((top) => {
    let node = document.querySelector(':is(.kb-dp .kb-md-read-body, .kb-dp .ProseMirror)')?.parentElement ?? null
    while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement
    const scrollerTop = node ? node.getBoundingClientRect().top : 0
    return top - Math.max(0, scrollerTop) >= 40
  }, panelTop)

/** 焦点是不是还在编辑器正文里(选中菜单项之后键盘不能收起),以及 <html data-kbd> */
export const focusState = (tab) =>
  tab.evaluate(() => ({
    inEditor: document.activeElement?.classList.contains('ProseMirror') ?? false,
    active: document.activeElement?.tagName + '.' + (document.activeElement?.className ?? '').toString().slice(0, 40),
    kbd: document.documentElement.dataset.kbd,
  }))
