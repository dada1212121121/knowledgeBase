// 多设备基础（设计规范）的 Playwright 场景:viewport-fit 与安全区、软键盘、触屏可点区域、悬停之外的入口、横屏低高度、:has 兜底。
// 由 viewer-shots.mjs 引入,在设备矩阵 × 引擎下跑。
import { rect } from './shell-scenarios.mjs'

/** 用假的 visualViewport 模拟软键盘:真键盘在自动化环境里弹不出来,所以让页面看到「可视视口缩小了」。 */
export const FAKE_VISUAL_VIEWPORT = `
  (() => {
    const fake = Object.assign(new EventTarget(), { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, scale: 1, pageTop: 0, pageLeft: 0 })
    Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true })
    window.__keyboard = (height) => { fake.height = innerHeight - height; fake.dispatchEvent(new Event('resize')) }
  })()
`

export const DEVICE_SCENARIOS = {
  'device-viewport': {
    // viewport-fit=cover;外壳用 dvh;安全区 token 被外壳各处用到(把 env 换成固定值来验证:顶栏让开刘海、标签栏让开底部横条、横屏让开两侧)
    route: '/home',
    ready: '.kb-topbar',
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      const meta = await tab.evaluate(() => document.querySelector('meta[name=viewport]')?.getAttribute('content') ?? '')
      if (!meta.includes('viewport-fit=cover')) issues.push(`viewport 应带 viewport-fit=cover:${meta}`)
      if (!meta.includes('width=device-width')) issues.push(`viewport 应带 width=device-width:${meta}`)
      if (/maximum-scale|user-scalable=no/.test(meta)) issues.push('不能禁用缩放(无障碍)')
      const app = await rect(tab, '.kb-app')
      if (Math.abs(app.height - size.height) > 1) issues.push(`外壳高度应等于视口高度:${app.height} vs ${size.height}`)
      const overflowY = await tab.evaluate(() => document.documentElement.scrollHeight - innerHeight)
      if (overflowY > 1) issues.push(`整页不该出现纵向滚动(外壳自己管滚动):${overflowY}`)
      // 注入固定的安全区:顶 44、底 34、左右 47(横屏刘海机)
      await tab.addStyleTag({ content: ':root{--safe-top:44px!important;--safe-right:47px!important;--safe-bottom:34px!important;--safe-left:47px!important}' })
      await tab.waitForTimeout(150)
      const bar = await rect(tab, '.kb-topbar')
      if (bar.top < 43.5) issues.push(`顶栏应让开刘海(top ≥ 44),实际 ${bar.top}`)
      const main = await rect(tab, '.main')
      if (main.right > size.width - 46) issues.push(`内容右边应让开 47px 的安全区,右缘 ${main.right} / ${size.width}`)
      const tabbed = await tab.locator('[data-testid=tabbar]').isVisible()
      if (tabbed) {
        const tabs = await rect(tab, '.kb-tabbar')
        if (tabs.height < 56 + 34 - 1) issues.push(`标签栏应带底部安全区(≥ 56+34),实际 ${tabs.height}`)
        const firstTab = await rect(tab, '.kb-tabbar .kb-tab')
        if (Math.round(firstTab.bottom) > Math.round(tabs.bottom - 34 + 1)) issues.push('标签项不该压在底部横条上')
        if (firstTab.left < 46) issues.push(`标签栏左边应让开安全区:${firstTab.left}`)
      } else {
        const slot = await rect(tab, '.kb-nav-slot')
        if (slot.left < 46) issues.push(`侧栏左边应让开安全区:${slot.left}`)
        const body = await rect(tab, '.body-row')
        if (body.bottom > size.height - 33) issues.push(`内容底部应让开底部横条:${body.bottom} / ${size.height}`)
      }
      return issues
    },
  },
  'device-keyboard': {
    // 软键盘弹出:输入框和底部操作条都在键盘上方;标签栏让位;键盘收起后恢复。用假 visualViewport 模拟(iOS 那种布局视口不变的环境)
    route: '/dev/kit',
    ready: '[data-testid=kit]',
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      await tab.addInitScript(FAKE_VISUAL_VIEWPORT)
      await tab.reload({ waitUntil: 'networkidle' })
      await tab.waitForSelector('[data-testid=kit]')
      const field = tab.getByLabel('昵称')
      await field.scrollIntoViewIfNeeded()
      await field.focus()
      const KB = Math.round(size.height * 0.4)
      await tab.evaluate((height) => window.__keyboard(height), KB)
      await tab.waitForTimeout(250)
      const state = await tab.evaluate(() => ({ kbd: document.documentElement.dataset.kbd, inset: document.documentElement.style.getPropertyValue('--kbd-inset') }))
      if (state.kbd !== 'open') issues.push(`键盘打开后 <html data-kbd> 应是 open,实际 ${state.kbd}`)
      if (state.inset !== `${KB}px`) issues.push(`--kbd-inset 应是 ${KB}px,实际 ${state.inset}`)
      const visibleBottom = size.height - KB
      const input = await field.boundingBox()
      if (input.y + input.height > visibleBottom + 1) issues.push(`输入框被键盘挡住:下缘 ${input.y + input.height} > 键盘上沿 ${visibleBottom}`)
      if (input.y < 0) issues.push('输入框被滚出了屏幕上方')
      const app = await rect(tab, '.kb-app')
      const bodyBottom = (await rect(tab, '.body-row')).bottom
      if (bodyBottom > visibleBottom + 1) issues.push(`内容区应止于键盘上沿:${bodyBottom} > ${visibleBottom}`)
      const actionbar = await rect(tab, '.kb-actionbar')
      if (actionbar && actionbar.bottom > visibleBottom + 1) issues.push(`底部操作条应贴在键盘上方:${actionbar.bottom} > ${visibleBottom}`)
      if (await tab.locator('[data-testid=tabbar]').isVisible().catch(() => false)) issues.push('键盘打开时底部标签栏应让位')
      void app
      // 键盘收起 → 恢复
      await field.blur()
      await tab.evaluate(() => window.__keyboard(0))
      await tab.waitForTimeout(200)
      const after = await tab.evaluate(() => document.documentElement.dataset.kbd)
      if (after !== 'closed') issues.push(`键盘收起后应是 closed,实际 ${after}`)
      if (size.width < 600 || (size.width < 840 && size.height > size.width)) {
        if (!(await tab.locator('[data-testid=tabbar]').isVisible())) issues.push('键盘收起后标签栏应回来')
      }
      return issues
    },
  },
  'device-keyboard-fixed': {
    // 底部固定的元素(系统参数的保存条、底部弹层)在 iOS 式键盘下也要在键盘上沿
    route: '/admin/params',
    ready: '.kb-sp-body',
    sizes: ['390x844', '820x1180', '1440x900'],
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      await tab.addInitScript(FAKE_VISUAL_VIEWPORT)
      await tab.reload({ waitUntil: 'networkidle' })
      await tab.waitForSelector('.kb-sp-body')
      const input = tab.locator('.kb-sp-row', { hasText: '每人存储配额' }).locator('input')
      await input.fill('500')
      await input.focus()
      const KB = Math.round(size.height * 0.4)
      await tab.evaluate((height) => window.__keyboard(height), KB)
      await tab.waitForTimeout(250)
      const save = await rect(tab, '.kb-sp-save')
      if (!save) return [...issues, '改了参数应出现保存条']
      if (save.bottom > size.height - KB + 1) issues.push(`保存条应在键盘上沿以上:${save.bottom} > ${size.height - KB}`)
      const box = await input.boundingBox()
      if (box.y + box.height > size.height - KB + 1) issues.push('输入框被键盘挡住')
      return issues
    },
  },
  'device-touch-targets': {
    // 触屏上外壳与组件库的可点区域 ≥44px(小按钮视觉 36、伪元素撑到 44);相邻可点元素间距 ≥8px(外壳里)
    route: '/dev/kit',
    ready: '[data-testid=kit]',
    sizes: ['390x844', '820x1180', '1180x820'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      if (!size.touch) return issues
      const check = async (scope, label) => {
        const boxes = await tab.evaluate((selector) => {
          const out = []
          for (const el of document.querySelectorAll(`${selector} button, ${selector} a[href], ${selector} [role=tab], ${selector} [role=menuitem], ${selector} input:not([type=hidden])`)) {
            const style = getComputedStyle(el)
            const box = el.getBoundingClientRect()
            if (style.display === 'none' || style.visibility === 'hidden' || box.width === 0 || box.height === 0) continue
            // 小按钮(.sm)视觉 36,伪元素外扩到 44:这里把外扩算进可点区域
            const extend = /\bsm\b|is-sm/.test(el.className) ? 8 : 0
            // 复选框 / 单选框本体小,可点区域是外面的 label 或整行;只看文本类输入
            if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)) continue
            out.push({ name: (el.getAttribute('aria-label') || el.textContent || el.className).trim().slice(0, 18), w: box.width + extend, h: box.height + extend })
          }
          return out
        }, scope)
        for (const item of boxes) if (item.h < 43.5 || item.w < 43.5) issues.push(`${label}「${item.name}」可点区域不足 44px:${Math.round(item.w)}×${Math.round(item.h)}`)
      }
      await check('.kb-topbar', '顶栏')
      await check('.kb-tabbar', '标签栏')
      await check('.kb-nav', '侧栏')
      await check('[data-testid=kit]', '组件库')
      return issues.slice(0, 8)
    },
  },
  'device-hover-none': {
    // 触屏没有悬停:「悬停才出现」的操作要常驻可见(会话列表的重命名 / 删除)
    route: '/dev/kit',
    ready: '[data-testid=kit]',
    sizes: ['390x844', '820x1180'],
    fixture: { agent_sessions: { sessions: [{ session_id: 's1', title: '部署清单整理', project: 'knowledgeBase', pinned: false, updated_at: 1792000000000, backend: 'builtin' }] } },
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      const hoverNone = await tab.evaluate(() => matchMedia('(hover: none)').matches)
      if (!size.touch) return issues
      if (!hoverNone) return [...issues, '触屏设备应匹配 (hover: none)']
      await tab.locator('[data-testid=assistant-toggle]').first().click()
      await tab.waitForSelector('.kb-agent-widget')
      await tab.getByRole('button', { name: '历史会话' }).click()
      await tab.waitForSelector('.kb-agent-sessions-item')
      const opacity = await tab.locator('.kb-agent-session-del').first().evaluate((el) => getComputedStyle(el).opacity)
      if (Number(opacity) < 0.99) issues.push(`触屏上会话的删除按钮应常驻可见,opacity=${opacity}`)
      return issues
    },
  },
  'device-landscape-low': {
    // 手机横屏(高 <500):顶栏 / 导航压缩,弹层不超过屏幕;内容不被截断
    route: '/mine',
    ready: '.kb-nav-slot',
    sizes: ['844x390'],
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const bar = await rect(tab, '.kb-topbar')
      if (Math.round(bar.height) > 40) issues.push(`横屏低高度顶栏应压缩到 40,实际 ${bar.height}`)
      const brand = await rect(tab, '.kb-nav-brand')
      if (brand.height > 41) issues.push(`侧栏品牌行应压缩,实际 ${brand.height}`)
      await tab.goto(new URL('/dev/kit', tab.url()).toString(), { waitUntil: 'networkidle' })
      await tab.getByRole('button', { name: '打开底部弹层' }).click()
      await tab.waitForSelector('[data-testid=sheet]')
      await tab.waitForTimeout(150)
      const sheet = await rect(tab, '[data-testid=sheet]')
      if (sheet.top < 0 || sheet.bottom > 391) issues.push(`弹层不该超出屏幕:${sheet.top}–${sheet.bottom}`)
      await tab.keyboard.press('Escape')
      await tab.getByRole('button', { name: '打开对话框' }).click()
      await tab.waitForSelector('.kb-dialog')
      await tab.waitForTimeout(150)
      const dialog = await rect(tab, '.kb-dialog')
      if (dialog.top < 0 || dialog.bottom > 391) issues.push(`对话框不该超出屏幕:${dialog.top}–${dialog.bottom}`)
      return issues
    },
  },
  'device-no-has': {
    // :has 兜底:把 :has 能力关掉(CSS.supports 打桩不改变真实渲染,所以这里直接验证「不依赖 :has 的类名」都在)
    route: '/dev/kit',
    ready: '[data-testid=kit]',
    sizes: ['390x844', '1440x900'],
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      // 手机卡片:表头行(thead tr)靠普通选择器隐藏,而不是 tr:has(th)
      if (size.width < 640) {
        const shown = await tab.evaluate(() => [...document.querySelectorAll('thead tr')].filter((tr) => getComputedStyle(tr).display !== 'none').length)
        if (shown) issues.push(`手机上表头行应隐藏,仍显示 ${shown} 个`)
      }
      // 对话框在手机上贴底:靠 .kb-dlg-wrap:not(.kb-confirm-wrap),不是 :has
      await tab.getByRole('button', { name: '打开对话框' }).click()
      await tab.waitForSelector('.kb-dialog')
      await tab.waitForTimeout(150)
      const dialog = await rect(tab, '.kb-dialog')
      if (size.width < 640 && Math.round(dialog.bottom) !== size.height) issues.push(`手机上对话框应贴底:${dialog.bottom}`)
      // 样式表里不再有 :has(依赖(全站 CSS 文本)
      const hasUsage = await tab.evaluate(() => {
        let count = 0
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) if (rule.cssText.includes(':has(')) count += 1
          } catch { /* 跨域样式表读不了,忽略 */ }
        }
        return count
      })
      if (hasUsage > 1) issues.push(`样式表里还有 ${hasUsage} 条依赖 :has() 的规则(应只剩编辑器附件那一条装饰性的)`)
      return issues
    },
  },
}
