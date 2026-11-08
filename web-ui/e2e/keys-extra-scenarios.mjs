// 补充:首页、好友页的键盘场景(检查表里这两页的「键盘」格原来写的是未验证)。
//
// - 好友页:「添加好友」里在输入框按 Enter 就搜索(原来只有点按钮的场景);Esc 关闭后焦点回到「添加好友」按钮
// - 首页:Tab 依次走过去,每个停靠点都有可见的焦点指示;Enter 能激活「新建笔记」
import { FRIENDS_SCENARIOS } from './friends-scenarios.mjs'

/**
 * 当前焦点元素的描述,以及聚焦时有没有「看得出焦点在哪」的变化。
 * 做法是比较聚焦前后:先读聚焦时元素自己和它的 ::before / ::after 的 outline、box-shadow、背景、边框、文字颜色,
 * 再把焦点移开读一次,只要有任何一项不同就算有指示。只看「有没有 outline / box-shadow」会误报——
 * 例如侧栏拖拽条聚焦时是 ::after 伪元素变成强调色的 2px 竖线(见 shell.css),元素自己什么都没有。
 */
async function focusState(tab) {
  const snapshot = () =>
    tab.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const read = (target, pseudo) => {
        const cs = getComputedStyle(target, pseudo)
        return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.backgroundColor, cs.borderTopColor, cs.color, cs.textDecorationLine].join('|')
      }
      return {
        id: `${el.tagName}.${el.getAttribute('data-testid') ?? ''}.${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 20)}`,
        tag: el.tagName.toLowerCase(),
        name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24),
        testid: el.getAttribute('data-testid') ?? '',
        look: [read(el), read(el, '::before'), read(el, '::after')].join('||'),
      }
    })
  const focused = await snapshot()
  if (!focused) return null
  // 把焦点临时移开(blur 当前元素),再读同一个元素聚焦前的样子;读完把焦点放回去,不影响后面的 Tab
  await tab.evaluate(() => {
    window.__kbFocus = document.activeElement
    document.activeElement?.blur()
  })
  const looks = await tab.evaluate(() => {
    const el = window.__kbFocus
    const read = (target, pseudo) => {
      const cs = getComputedStyle(target, pseudo)
      return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.backgroundColor, cs.borderTopColor, cs.color, cs.textDecorationLine].join('|')
    }
    const out = [read(el), read(el, '::before'), read(el, '::after')].join('||')
    el.focus({ preventScroll: true })
    return out
  })
  return { ...focused, visible: focused.look !== looks }
}

export const KEYS_EXTRA_SCENARIOS = {
  'a7-keys-friends': {
    // 添加好友:在输入框里按 Enter 就搜索;搜到之后 Esc 关掉,焦点回到「添加好友」按钮(键盘用户不会丢位置)
    route: '/friends',
    ready: '[data-testid=friend-add]',
    fixture: FRIENDS_SCENARIOS['friends-add'].fixture,
    // 「24 小时内被拒绝过」这类步骤后端返回 403,浏览器会把它打进控制台;这里只搜两个名字,保险起见沿用同一个放行
    expectConsole: /403/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      await tab.locator('[data-testid=friend-add]').focus()
      await tab.keyboard.press('Enter')
      await tab.waitForSelector('[data-testid=add-friend]', { timeout: 3000 }).catch(() => issues.push('在「添加好友」按钮上按 Enter 应打开对话框'))
      const query = tab.locator('[data-testid=add-friend-query]')
      await query.fill('nobody')
      await tab.keyboard.press('Enter')
      await tab
        .waitForSelector('[data-testid=add-friend-found], [data-testid=add-friend-notfound], [role=alert]', { timeout: 3000 })
        .catch(() => issues.push('在搜索框里按 Enter 应该开始搜索(原来只有点按钮的场景),什么都没发生'))
      await query.fill('bob')
      await tab.keyboard.press('Enter')
      await tab.waitForSelector('[data-testid=add-friend-state]', { timeout: 3000 }).catch(() => issues.push('搜「bob」按 Enter 应显示他的状态'))
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid=add-friend]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('按 Esc 应关闭「添加好友」对话框'))
      const back = await tab.evaluate(() => document.activeElement?.getAttribute('data-testid'))
      if (back !== 'friend-add') issues.push(`关掉对话框后焦点应回到「添加好友」按钮,实际在 ${back ?? 'body(丢了)'}`)
      return issues
    },
  },

  'a7-keys-home': {
    // 首页:Tab 走过前几个停靠点,每一个都得有看得见的焦点指示;Enter 激活「新建笔记」能走通
    route: '/home',
    ready: '[data-testid=home]',
    settle: 500,
    // 触屏手机的首页没有顶栏的那些停靠点(底部标签栏另算),这里只在有键盘的常见尺寸上跑
    sizes: ['1180x820', '1440x900', '1920x1080'],
    assert: async (tab) => {
      const issues = []
      // 键盘用户进来第一个停靠点是「跳到主要内容」:用它跳过 20 多个侧栏链接,再从正文开始 Tab。
      // (不这样做的话,Tab 14 次全在侧栏里,测的就不是首页)
      await tab.keyboard.press('Tab')
      const skip = await focusState(tab)
      if (!skip || !/跳到主要内容/.test(skip.name)) issues.push(`首次 Tab 应落在「跳到主要内容」,实际是 ${skip ? skip.name : 'body'}`)
      await tab.keyboard.press('Enter')
      const seen = []
      for (let step = 0; step < 14; step += 1) {
        await tab.keyboard.press('Tab')
        const state = await focusState(tab)
        if (!state) {
          issues.push(`跳进正文后第 ${step + 1} 次 Tab 焦点落在了 body 上(丢了)`)
          break
        }
        seen.push(state)
      }
      // 这些停靠点必须在正文里,而不是又回到了侧栏
      const inMain = await tab.evaluate(() => [...document.querySelectorAll('main *, [role=main] *, .kb-home *')].includes(document.activeElement))
      if (!inMain && seen.length) issues.push(`跳到主要内容之后 Tab 走的还是侧栏:${seen.slice(0, 3).map((item) => item.name).join(' → ')}`)
      const invisible = seen.filter((item) => !item.visible).map((item) => `${item.tag}「${item.name}」`)
      if (invisible.length) issues.push(`这些停靠点聚焦时看不出焦点在哪(聚焦前后,它自己和 ::before / ::after 的 outline、阴影、背景、边框、文字颜色都没有变化):${invisible.join('、')}`)
      if (seen.length < 6) issues.push(`Tab 14 次只走到 ${seen.length} 个停靠点,首页的可操作元素太少或被跳过`)
      const names = seen.map((item) => item.testid || item.name)
      if (new Set(names).size < Math.min(seen.length, 6)) issues.push(`Tab 在原地打转:${names.join(' → ')}`)
      // Enter 激活「新建笔记」
      await tab.locator('[data-testid=home-new]').focus()
      await tab.keyboard.press('Enter')
      await tab.waitForFunction(() => location.pathname.startsWith('/kb'), null, { timeout: 4000 }).catch(() => issues.push('在「新建笔记」上按 Enter 应进入知识库页'))
      return issues
    },
  },
}
