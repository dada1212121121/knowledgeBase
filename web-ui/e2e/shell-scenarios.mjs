// 统一外壳的 Playwright 场景:由 viewer-shots.mjs 引入,和其它场景一样在设备矩阵 × 引擎下跑。
// 约定同 viewer-shots:assert 返回问题数组(空 = 通过);fixture 里的 __ 开头键是 e2e/fixture.mjs 的钩子。
import { ALL_FEATURES, adminMe, pushLive } from './fixture.mjs'

/** 取元素的外接矩形(不存在返回 null)。 */
export const rect = (tab, selector) =>
  tab.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const box = el.getBoundingClientRect()
    return { left: box.left, top: box.top, width: box.width, height: box.height, right: box.right, bottom: box.bottom }
  }, selector)

/** 侧栏占位当前宽度(隐藏时占位为 0)。 */
const navWidth = async (tab) => Math.round((await rect(tab, '.kb-nav-slot'))?.width ?? -1)
const savedUi = (tab) => tab.evaluate(() => JSON.parse(localStorage.getItem('kb.ui') || '{}'))
const fixturePrefs = (tab) => tab.evaluate(() => fetch('/api/v1/__fixture/prefs').then((r) => r.json())).then((body) => body.data)

// 页面地址集中在这里,路由重组(.4)时只改这一处
const HOME = '/home'
const PAGES = ['/search', '/tasks', '/admin/overview', '/admin/settings', '/admin/projects', '/review', '/kb']

export const SHELL_SCENARIOS = {
  'shell-nav-states': {
    // 电脑:默认展开 240;⌘B 依次 展开 → 图标栏 64 → 隐藏 0 → 展开;每一步都记进 localStorage 并防抖写回服务端;
    // 所有页面都能收起(逐页验证,含文档工作台);刷新后状态还在
    route: HOME,
    ready: '.kb-nav',
    sizes: ['1440x900', '1920x1080'],
    settle: 300,
    assert: async (tab) => {
      const issues = []
      if ((await navWidth(tab)) !== 240) issues.push(`电脑默认应展开 240,实际 ${await navWidth(tab)}`)
      await tab.keyboard.press('Control+b')
      if ((await navWidth(tab)) !== 64) issues.push(`⌘B 一次应收成图标栏 64,实际 ${await navWidth(tab)}`)
      if ((await tab.locator('.kb-nav-name').isVisible())) issues.push('图标栏里不该显示文字')
      if ((await savedUi(tab)).sidebar !== 'rail') issues.push('选择没有记进 localStorage')
      await tab.keyboard.press('Control+b')
      if ((await navWidth(tab)) !== 0) issues.push(`⌘B 两次应隐藏(0),实际 ${await navWidth(tab)}`)
      if (!(await tab.locator('[data-testid=nav-reveal]').isVisible())) issues.push('隐藏后应有找回把手')
      // 找回把手能把导航请回来
      await tab.locator('[data-testid=nav-reveal]').click()
      if ((await navWidth(tab)) !== 240) issues.push(`点找回把手应展开 240,实际 ${await navWidth(tab)}`)
      // 最后一次变更 500ms 后整体写回服务端,带 ui 键
      const put = await tab.waitForRequest((req) => req.url().includes('/api/v1/me/prefs') && req.method() === 'PUT', { timeout: 4000 }).catch(() => null)
      if (!put) issues.push('变更后没有写回 /api/v1/me/prefs')
      else {
        if (put.headers()['x-kb-csrf'] !== '1') issues.push('写偏好缺 X-KB-CSRF')
        const sent = JSON.parse(put.postData() ?? '{}')
        if (sent.prefs?.ui?.sidebar !== 'expanded') issues.push(`写回的 ui.sidebar 不对:${JSON.stringify(sent.prefs?.ui)}`)
      }
      // 刷新后状态保持:用 ⌘B 真实改一次,等防抖写回,再刷新(服务端的偏好会覆盖本地,所以两边都要对)
      await tab.goto(new URL(HOME, tab.url()).toString(), { waitUntil: 'networkidle' })
      await tab.waitForSelector('.kb-nav')
      if ((await navWidth(tab)) !== 240) await tab.keyboard.press('Control+b')
      await tab.keyboard.press('Control+b')
      await tab.waitForTimeout(900)
      await tab.reload({ waitUntil: 'networkidle' })
      await tab.waitForSelector('.kb-nav')
      if ((await navWidth(tab)) !== 64) issues.push(`刷新后应保持图标栏,实际 ${await navWidth(tab)}`)
      return issues
    },
  },
  'shell-nav-everywhere': {
    // 每个页面都能收起(不是只有浏览器一页):逐页 ⌘B,宽度必须变小。服务端偏好设成只读,逐页互不影响
    route: HOME,
    ready: '.kb-nav-slot',
    sizes: ['1440x900'],
    fixture: { __prefs: { ui: { sidebar: 'expanded' } }, __prefsReadOnly: true },
    settle: 300,
    assert: async (tab) => {
      const issues = []
      for (const path of PAGES) {
        await tab.goto(new URL(path, tab.url()).toString(), { waitUntil: 'networkidle' })
        await tab.waitForSelector('.kb-nav-slot', { state: 'attached' })
        // 工作台页面默认就是图标栏;先展开,再验证能收起
        await tab.evaluate(() => localStorage.removeItem('kb.ui'))
        const before = await navWidth(tab)
        if (before < 200) await tab.keyboard.press('Control+b')
        const wide = await navWidth(tab)
        await tab.keyboard.press('Control+b')
        const after = await navWidth(tab)
        if (!(after < wide)) issues.push(`${path}:⌘B 没能收起(${wide} → ${after})`)
        await tab.keyboard.press('Control+b')
        if ((await navWidth(tab)) !== 0) issues.push(`${path}:再按一次应隐藏`)
      }
      return issues
    },
  },
  'shell-nav-drag': {
    // 拖动边缘:拖宽 → 记住宽度;拖到很窄 → 图标栏;拖到几乎为 0 → 隐藏;键盘也能调
    route: HOME,
    ready: '[data-testid=nav-resizer]',
    sizes: ['1440x900'],
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const handle = await rect(tab, '[data-testid=nav-resizer]')
      if (!handle) return ['没有拖动边缘']
      const y = handle.top + 200
      const x = handle.left + handle.width / 2
      await tab.mouse.move(x, y)
      await tab.mouse.down()
      await tab.mouse.move(x + 60, y, { steps: 6 })
      const live = await navWidth(tab)
      if (live < 290 || live > 310) issues.push(`拖动过程中宽度应跟手(约 300),实际 ${live}`)
      await tab.mouse.up()
      if ((await navWidth(tab)) !== 300) issues.push(`松手后应是 300,实际 ${await navWidth(tab)}`)
      const saved = await savedUi(tab)
      if (saved.sidebarWidth !== 300 || saved.sidebar !== 'expanded') issues.push(`宽度没记住:${JSON.stringify(saved)}`)
      // 拖得过大被限制在 360
      let box = await rect(tab, '[data-testid=nav-resizer]')
      await tab.mouse.move(box.left + 4, y)
      await tab.mouse.down()
      await tab.mouse.move(700, y, { steps: 5 })
      await tab.mouse.up()
      if ((await navWidth(tab)) !== 360) issues.push(`最宽应夹在 360,实际 ${await navWidth(tab)}`)
      // 拖到很窄 → 图标栏
      box = await rect(tab, '[data-testid=nav-resizer]')
      await tab.mouse.move(box.left + 4, y)
      await tab.mouse.down()
      await tab.mouse.move(90, y, { steps: 8 })
      await tab.mouse.up()
      if ((await navWidth(tab)) !== 64) issues.push(`拖到 90 应吸附成图标栏 64,实际 ${await navWidth(tab)}`)
      // 从图标栏再拖出来 → 展开
      box = await rect(tab, '[data-testid=nav-resizer]')
      await tab.mouse.move(box.left + 4, y)
      await tab.mouse.down()
      await tab.mouse.move(260, y, { steps: 8 })
      await tab.mouse.up()
      if ((await navWidth(tab)) !== 260) issues.push(`从图标栏拖到 260 应展开成 260,实际 ${await navWidth(tab)}`)
      // 拖到几乎为 0 → 隐藏
      box = await rect(tab, '[data-testid=nav-resizer]')
      await tab.mouse.move(box.left + 4, y)
      await tab.mouse.down()
      await tab.mouse.move(10, y, { steps: 8 })
      await tab.mouse.up()
      if ((await navWidth(tab)) !== 0) issues.push(`拖到 10 应隐藏,实际 ${await navWidth(tab)}`)
      // 键盘:找回后聚焦边缘,→ 加宽、Enter 切换
      await tab.locator('[data-testid=nav-reveal]').click()
      await tab.locator('[data-testid=nav-resizer]').focus()
      const before = await navWidth(tab)
      await tab.keyboard.press('ArrowRight')
      if ((await navWidth(tab)) !== before + 16) issues.push(`→ 应加宽 16,实际 ${before} → ${await navWidth(tab)}`)
      await tab.keyboard.press('Enter')
      if ((await navWidth(tab)) !== 64) issues.push('Enter 应在展开 / 图标栏之间切换')
      return issues
    },
  },
  'shell-nav-server': {
    // 服务端已有偏好:登录后覆盖本地;写回时带上别的键(整体替换语义不能冲掉它们);写失败静默
    route: HOME,
    ready: '.kb-nav',
    sizes: ['1440x900'],
    fixture: { __prefs: { theme: 'light', ui: { sidebar: 'rail', sidebarWidth: 280, density: 'compact' }, other: { keep: true } } },
    settle: 600,
    assert: async (tab) => {
      const issues = []
      if ((await navWidth(tab)) !== 64) issues.push(`服务端存的是图标栏,应以服务端为准,实际 ${await navWidth(tab)}`)
      const attr = await tab.evaluate(() => document.documentElement.getAttribute('data-ui-density'))
      if (attr !== 'compact') issues.push(`服务端存的密度是 compact,实际 ${attr}`)
      await tab.keyboard.press('Control+b')
      await tab.keyboard.press('Control+b')
      await tab.keyboard.press('Control+b')
      await tab.waitForTimeout(1200)
      const server = await fixturePrefs(tab)
      if (server.puts !== 1) issues.push(`三次连按应合并成一次写回(防抖),实际 ${server.puts} 次`)
      if (server.prefs.ui?.sidebar !== 'rail') issues.push(`最终应是图标栏,服务端存的是 ${server.prefs.ui?.sidebar}`)
      if (server.prefs.theme !== 'light' || server.prefs.other?.keep !== true) issues.push(`写回冲掉了别的偏好键:${JSON.stringify(server.prefs)}`)
      if (server.prefs.ui?.sidebarWidth !== 280 || server.prefs.ui?.density !== 'compact') issues.push(`ui 里没改的键丢了:${JSON.stringify(server.prefs.ui)}`)
      return issues
    },
  },
  'shell-nav-prefs-down': {
    // 偏好服务不可用(500):界面照常,本地照样记住,不弹错误
    route: HOME,
    ready: '.kb-nav',
    sizes: ['1440x900'],
    fixture: { __prefsFail: true },
    expectConsole: /status of 500/,
    settle: 400,
    assert: async (tab) => {
      const issues = []
      await tab.keyboard.press('Control+b')
      await tab.waitForTimeout(900)
      if ((await navWidth(tab)) !== 64) issues.push('偏好服务挂了也该能收起')
      if ((await savedUi(tab)).sidebar !== 'rail') issues.push('本地没记住')
      if (await tab.locator('.kb-toast').count()) issues.push('偏好写失败不该弹提示')
      return issues
    },
  },
  'shell-nav-tablet': {
    // 平板 / 小屏:默认图标栏;「展开」是浮层,盖在内容上而不挤压;Esc / 点遮罩 / 跳转后收回;不写进偏好
    route: HOME,
    ready: '.kb-nav-slot, [data-testid=tabbar]',
    sizes: ['820x1180', '1180x820', '1024x1366'],
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      if (size.width < 840 && size.height > size.width) {
        // 竖屏的 600–839 用底部标签栏(1.3),这里没有侧栏
        return issues
      }
      if ((await navWidth(tab)) !== 64) issues.push(`平板默认应是图标栏 64,实际 ${await navWidth(tab)}`)
      const mainBefore = (await rect(tab, '.main'))?.left
      await tab.locator('[data-testid=nav-collapse]').click()
      const overlay = await rect(tab, '.kb-nav')
      if (!overlay || Math.round(overlay.width) !== 240) issues.push(`浮层展开应是 240 宽,实际 ${overlay?.width}`)
      if ((await rect(tab, '.main'))?.left !== mainBefore) issues.push('浮层展开不该挤压内容')
      if (!(await tab.locator('.kb-nav .kb-nav-name').isVisible())) issues.push('浮层里应显示文字')
      if (Object.keys(await savedUi(tab)).length && (await savedUi(tab)).sidebar) issues.push('浮层开合不该写进偏好')
      await tab.keyboard.press('Escape')
      if ((await rect(tab, '.kb-nav'))?.width !== 64) issues.push('Esc 应收回浮层')
      await tab.keyboard.press('Control+b')
      if ((await rect(tab, '.kb-nav'))?.width !== 240) issues.push('⌘B 应打开浮层')
      await tab.mouse.click(size.width - 20, size.height / 2)
      if ((await rect(tab, '.kb-nav'))?.width !== 64) issues.push('点遮罩应收回浮层')
      await tab.locator('[data-testid=nav-collapse]').click()
      await tab.locator('.kb-nav a[data-nav-id=search]').click()
      await tab.waitForURL(/search/)
      if ((await rect(tab, '.kb-nav'))?.width !== 64) issues.push('点了一个入口后浮层应收回')
      return issues
    },
  },

  'shell-topbar': {
    // 顶栏:标题 / 页面操作 / ⌘K / AI / 通知 / 头像菜单;没有刷新、退出、底部状态栏、悬浮球
    route: '/admin/eval',
    ready: '.kb-topbar',
    // 竖屏的 820 用底部标签栏(搜索 / 通知在标签栏里),顶栏的手机形态在 shell-tabbar 里验证
    sizes: ['1180x820', '1440x900', '1920x1080'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const bar = await rect(tab, '.kb-topbar')
      if (!bar || Math.round(bar.height) !== 52) issues.push(`顶栏应是 52px 高,实际 ${bar?.height}`)
      const barText = await tab.locator('.kb-topbar').innerText()
      if (!barText.includes('评测')) issues.push('顶栏应写着页面标题「评测」')
      if (/刷新/.test(barText)) issues.push('顶栏不该再有「刷新」')
      if (/退出/.test(barText)) issues.push('退出登录不该放在顶栏(进了头像菜单)')
      const body = await tab.evaluate(() => document.body.innerText)
      for (const word of ['UDS', 'kbd.sock', 'HTTP 127', '同步于', 'MCP 会话']) if (body.includes(word)) issues.push(`页面上不该再出现服务器内部信息「${word}」`)
      if (await tab.locator('.foot').count()) issues.push('底部状态栏应已移除')
      if (await tab.locator('.kb-fab').count()) issues.push('悬浮球应已移除')
      // 没有告警时头像上没有圆点
      if (await tab.locator('[data-testid=alert-dot]').count()) issues.push('没有告警时不该有圆点')
      // ⌘K:顶栏按钮打开命令面板
      await tab.locator('[data-testid=topbar-search]').click()
      await tab.waitForSelector('.pal', { timeout: 3000 }).catch(() => issues.push('点搜索没有打开命令面板'))
      await tab.keyboard.press('Escape')
      await tab.keyboard.press('Control+k')
      await tab.waitForSelector('.pal', { timeout: 3000 }).catch(() => issues.push('Ctrl+K 没有打开命令面板'))
      await tab.keyboard.press('Escape')
      // 通知:角标是 2(夹具两条未读),点开抽屉,全部已读后角标消失
      const badge = await tab.locator('[data-testid=bell-badge]').first().innerText().catch(() => '')
      if (badge.trim() !== '2') issues.push(`通知角标应是 2,实际「${badge}」`)
      await tab.locator('[data-testid=bell]').first().click()
      await tab.waitForSelector('[data-testid=notification-drawer]', { timeout: 3000 }).catch(() => issues.push('点铃铛没有打开通知抽屉'))
      if (!(await tab.locator('[data-testid=notification-unread]').innerText().catch(() => '')).includes('2 条未读')) issues.push('抽屉里应写「2 条未读」')
      await tab.getByRole('button', { name: '全部标为已读' }).click()
      await tab.waitForTimeout(300)
      if (await tab.locator('[data-testid=bell-badge]').count()) issues.push('全部已读后角标应消失')
      const reads = await tab.evaluate(() => fetch('/api/v1/__fixture/notifications').then((r) => r.json())).then((r) => r.data.reads)
      if (!reads.some((entry) => entry.all === true)) issues.push(`没有向服务端发 notification_read {all:true}:${JSON.stringify(reads)}`)
      await tab.keyboard.press('Escape')
      // 头像菜单:个人设置 / 外观 / 快捷键 / 退出登录;键盘可操作;Esc 关闭并还焦点
      await tab.locator('[data-testid=account-trigger]').click()
      const menuText = await tab.locator('[data-testid=account-menu]').innerText().catch(() => '')
      for (const word of ['个人设置', '外观', '快捷键', '系统状态', '退出登录']) if (!menuText.includes(word)) issues.push(`头像菜单缺「${word}」`)
      const box = await rect(tab, '[data-testid=account-menu]')
      if (box && (box.right > size.width + 1 || box.left < -1 || box.bottom > size.height + 1)) issues.push('头像菜单超出了屏幕')
      await tab.keyboard.press('ArrowDown')
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid=account-menu]', { state: 'detached', timeout: 2000 }).catch(() => issues.push('Esc 应关闭头像菜单'))
      if (!(await tab.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'account-trigger'))) issues.push('关闭菜单后焦点应回到头像')
      // 快捷键对话框
      await tab.locator('[data-testid=account-trigger]').click()
      await tab.getByRole('menuitem', { name: '快捷键' }).click()
      const keys = await tab.locator('[data-testid=shortcuts]').innerText().catch(() => '')
      for (const word of ['⌘K', '⌘B', '⌘J']) if (!keys.includes(word)) issues.push(`快捷键表缺 ${word}`)
      await tab.keyboard.press('Escape')
      // 退出登录在菜单里,点了会发出 logout 并回登录页
      const logout = tab.waitForRequest((req) => req.url().includes('/api/v1/auth/logout'), { timeout: 5000 }).catch(() => null)
      await tab.locator('[data-testid=account-trigger]').click()
      await tab.locator('[data-testid=signout]').click()
      if (!(await logout)) issues.push('点退出登录没有请求 /auth/logout')
      await tab.waitForURL(/\/login/, { timeout: 5000 }).catch(() => issues.push('退出后应回到登录页'))
      return issues
    },
  },
  'shell-assistant': {
    // AI 助手:顶栏按钮 + 右侧抽屉(桌面在顶栏下方,不再有悬浮球);Esc / ⌘J / 再点按钮收起;总开关关闭时按钮和抽屉都不存在
    route: '/admin/eval',
    ready: '.kb-topbar',
    sizes: ['820x1180', '1180x820', '1440x900'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const toggle = tab.locator('[data-testid=assistant-toggle]').first()
      if ((await toggle.getAttribute('data-feature')) !== 'ai.assistant') issues.push('AI 按钮应带 data-feature="ai.assistant"')
      if (await tab.locator('.kb-agent-widget').count()) issues.push('默认不该展开抽屉')
      await toggle.click()
      await tab.waitForSelector('.kb-agent-widget', { timeout: 3000 }).catch(() => issues.push('点 AI 按钮没有打开抽屉'))
      const drawer = await rect(tab, '.kb-agent-widget')
      // 手机和竖屏小平板(用底部标签栏的尺寸)抽屉是全屏;其余是顶栏下方的右侧抽屉
      const wantFull = size.width < 600 || (size.width < 840 && size.height > size.width)
      if (drawer) {
        if (Math.round(drawer.right) !== size.width) issues.push(`抽屉应贴右边,右缘 ${drawer.right}`)
        if (Math.round(drawer.bottom) !== size.height) issues.push('抽屉应一直到底')
        if (wantFull) {
          if (Math.round(drawer.width) !== size.width || drawer.top !== 0) issues.push(`这个尺寸抽屉应全屏,实际 ${drawer.width}×${drawer.top}`)
        } else {
          if (drawer.top < 51 || drawer.top > 53) issues.push(`抽屉应从顶栏下方开始(52),实际 ${drawer.top}`)
          if (drawer.width > 521) issues.push(`抽屉太宽:${drawer.width}`)
        }
      }
      // 抽屉没有盖住顶栏(桌面 / 横屏)时,顶栏上的按钮仍可点:再点一次收起;全屏时(手机 / 竖屏小平板)用抽屉自己的收起按钮
      const fullScreen = drawer && Math.round(drawer.width) >= size.width
      if (fullScreen) await tab.locator('.kb-agent-widget button[aria-label=收起]').click()
      else await toggle.click()
      await tab.waitForSelector('.kb-agent-widget', { state: 'detached', timeout: 2000 }).catch(() => issues.push('再点按钮 / 收起应关闭抽屉'))
      await tab.keyboard.press('Control+j')
      if (!(await tab.locator('.kb-agent-widget').count())) issues.push('⌘J 应打开抽屉')
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('.kb-agent-widget', { state: 'detached', timeout: 2000 }).catch(() => issues.push('Esc 应收起抽屉'))
      // 通知抽屉与助手抽屉互斥(全屏抽屉会盖住铃铛,这里直接用 store 的行为:先开助手,再开通知)
      if (!fullScreen) {
        await toggle.click()
        await tab.locator('[data-testid=bell]').first().click()
        await tab.waitForSelector('.kb-agent-widget', { state: 'detached', timeout: 2000 }).catch(() => issues.push('打开通知时应收起助手抽屉'))
      }
      return issues
    },
  },
  'shell-assistant-off': {
    // AI 总开关关闭:顶栏没有 AI 按钮、没有抽屉,⌘J 也不会打开任何东西;其它按钮照常
    route: '/admin/eval',
    ready: '.kb-topbar',
    sizes: ['1440x900'],
    fixture: { __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('ai.') && id !== 'search.deep'), false) } },
    settle: 600,
    assert: async (tab) => {
      const issues = []
      if (await tab.locator('[data-feature="ai.assistant"]').count()) issues.push('AI 关闭后不该有 AI 按钮')
      await tab.keyboard.press('Control+j')
      await tab.waitForTimeout(200)
      if (await tab.locator('.kb-agent-widget').count()) issues.push('AI 关闭后 ⌘J 不该打开抽屉')
      if (!(await tab.locator('[data-testid=bell]').count())) issues.push('通知按钮应照常')
      if (!(await tab.locator('[data-testid=account-trigger]').count())) issues.push('头像菜单应照常')
      return issues
    },
  },
  'shell-alert-dot': {
    // 管理员:磁盘 95% → 头像上有圆点,菜单里写明原因;没有系统功能的账号即使磁盘满了也看不到(不暴露服务器状态)
    route: '/admin/eval',
    ready: '.kb-topbar',
    sizes: ['1440x900'],
    fixture: { system_status: { overview: { service: { version: '0.4.0', uptime_seconds: 3600, host: 'demo-host' } }, resources: { disk: { mount: '/srv', free_gb: 2, total_gb: 100, used_ratio: 0.95 } }, network: {} } },
    settle: 600,
    assert: async (tab) => {
      const issues = []
      if (!(await tab.locator('[data-testid=alert-dot]').count())) issues.push('磁盘 95% 时管理员头像上应有圆点')
      await tab.locator('[data-testid=account-trigger]').click()
      const alertText = await tab.locator('[data-testid=alert-text]').allInnerTexts()
      if (!alertText.some((text) => text.includes('95%'))) issues.push(`菜单里应写明磁盘 95%,实际 ${JSON.stringify(alertText)}`)
      return issues
    },
  },
  'shell-alert-dot-plain': {
    route: '/admin/eval',
    ready: '.kb-topbar',
    sizes: ['1440x900'],
    fixture: {
      __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('sys.')), true) },
      system_status: { overview: { service: {} }, resources: { disk: { used_ratio: 0.99 } }, network: {} },
    },
    settle: 600,
    assert: async (tab) => {
      const issues = []
      if (await tab.locator('[data-testid=alert-dot]').count()) issues.push('没有系统功能的账号不该看到告警圆点')
      await tab.locator('[data-testid=account-trigger]').click()
      const text = await tab.locator('[data-testid=account-menu]').innerText()
      if (text.includes('系统状态')) issues.push('普通用户的菜单里不该有「系统状态」')
      return issues
    },
  },
  'shell-notify-live': {
    // WebSocket 推来新通知:角标立刻变成服务端给的未读数(不用刷新)
    route: '/admin/eval',
    ready: '.kb-topbar',
    sizes: ['1440x900'],
    fixture: { __live: true },
    settle: 800,
    assert: async (tab) => {
      const issues = []
      if (((await tab.locator('[data-testid=bell-badge]').first().innerText()).trim()) !== '2') issues.push('起始角标应是 2')
      pushLive(tab.context(), { type: 'notify', data: { notification: { id: 9, kind: 'share.added', data: {}, read_at: null, created_at: Date.now() }, unread: 5 } })
      await tab.waitForFunction(() => document.querySelector('[data-testid=bell-badge]')?.textContent?.trim() === '5', null, { timeout: 3000 }).catch(() => issues.push('推送后角标应变成 5'))
      pushLive(tab.context(), { type: 'notify', data: { unread: 120 } })
      await tab.waitForFunction(() => document.querySelector('[data-testid=bell-badge]')?.textContent?.trim() === '99+', null, { timeout: 3000 }).catch(() => issues.push('超过 99 应显示 99+'))
      return issues
    },
  },
  'shell-workbench-chrome': {
    // 文档工作台:全站统一顶栏(面包屑、操作、搜索、AI 助手、通知、头像);侧栏底部保持干净
    route: '/kb',
    ready: '.kb-workspace-bar',
    sizes: ['1440x900', '1920x1080'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      if (!(await tab.locator('.kb-topbar').isVisible())) issues.push('知识库页面应保留全局顶栏')
      for (const id of ['assistant-toggle', 'bell', 'account-trigger', 'topbar-search']) {
        if (!(await tab.locator(`.kb-topbar [data-testid=${id}]`).isVisible())) issues.push(`顶栏缺 ${id}`)
      }
      for (const id of ['assistant-toggle', 'bell', 'account-trigger']) {
        if (await tab.locator(`.kb-nav-foot [data-testid=${id}]`).isVisible()) issues.push(`导航底部不应有 ${id}`)
      }
      if (((await tab.locator('.kb-topbar [data-testid=bell-badge]').innerText().catch(() => '')).trim()) !== '2') issues.push('顶栏铃铛应带角标 2')
      await tab.locator('.kb-topbar [data-testid=account-trigger]').click()
      const box = await rect(tab, '[data-testid=account-menu]')
      const trigger = await rect(tab, '.kb-topbar [data-testid=account-trigger]')
      if (!box) issues.push('点头像没有出菜单')
      else {
        if (box.top < trigger.bottom - 4) issues.push('顶栏里的账号菜单应在头像下方弹出')
        if (box.top < 0 || box.bottom > size.height + 1 || box.right > size.width + 1) issues.push('账号菜单超出屏幕')
      }
      await tab.keyboard.press('Escape')
      await tab.locator('.kb-topbar [data-testid=assistant-toggle]').click()
      const drawer = await rect(tab, '.kb-agent-widget')
      if (!drawer || Math.abs(drawer.top - 52) > 2) issues.push(`工作台助手抽屉应在顶栏下方(top ~52),实际 ${drawer?.top}`)
      return issues
    },
  },

  'shell-workbench-keeps-nav': {
    // 从别的页面点进知识库浏览器(文档工作台),侧栏不能自己收成图标栏;用户自己收起的状态则要一直保持
    route: '/home',
    ready: '.kb-nav-slot',
    sizes: ['1440x900', '1920x1080'],
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const before = await navWidth(tab)
      if (before <= 64) return [`首页的侧栏应是展开的,实际宽 ${before}`]
      await tab.locator('.kb-nav [data-nav-id=kb]').click()
      await tab.waitForSelector('.kb-workspace-bar', { timeout: 8000 })
      await tab.waitForTimeout(300)
      const after = await navWidth(tab)
      if (after !== before) return [`点进知识库后侧栏宽度从 ${before} 变成 ${after}(不该自己收起)`]
      // 用户自己收成图标栏:离开再回来仍是图标栏
      await tab.keyboard.press('Control+b')
      await tab.waitForTimeout(250)
      if ((await navWidth(tab)) !== 64) issues.push('手动收起后应是图标栏(64)')
      await tab.locator('.kb-nav [data-nav-id=home]').click()
      await tab.waitForSelector('[data-testid=home]', { timeout: 8000 })
      await tab.locator('.kb-nav [data-nav-id=kb]').click()
      await tab.waitForSelector('.kb-workspace-bar', { timeout: 8000 })
      if ((await navWidth(tab)) !== 64) issues.push('用户手动收起的图标栏,进出知识库后应保持')
      return issues
    },
  },

  'shell-home': {
    // 首页是个人工作台(不再是占位页):有问候标题、继续编辑 / 共享 / 待处理三块;「全部」能去知识库;所有尺寸都不溢出。
    // 各块的数据、空、报错、AI 关闭等状态在 home-scenarios.mjs 里;这里只守外壳层面:首页路由、标题、没有残留的占位文案
    route: '/home',
    ready: '[data-testid=home]',
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      if (text.includes('功能建设中')) issues.push('首页不该再是「功能建设中」的占位页')
      if (!(await tab.locator('h1, .kb-page-title').filter({ hasText: /好|夜深了/ }).count())) issues.push('首页应有问候标题')
      for (const id of ['home-recent', 'home-shared', 'home-pending']) if (!(await tab.locator(`[data-testid=${id}]`).count())) issues.push(`首页缺少 ${id} 这一块`)
      await tab.locator('[data-testid=home-recent]').getByRole('button', { name: '全部' }).click()
      await tab.waitForURL(/\/kb/, { timeout: 5000 }).catch(() => issues.push('「全部」应跳到知识库'))
      return issues
    },
  },
  'shell-tabbar': {
    // 手机 / 竖屏小平板:底部标签栏 首页·知识库·搜索·通知·我的;可点区域 ≥44;没有汉堡、悬浮球、侧栏;横屏同尺寸换回图标栏
    route: '/home',
    ready: '[data-testid=tabbar]',
    sizes: ['360x780', '375x667', '390x844', '430x932', '673x841', '744x1133', '820x1180'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const labels = await tab.locator('.kb-tabbar .kb-tab').allInnerTexts()
      const names = labels.map((label) => label.replace(/\d+\+?/g, '').trim())
      if (JSON.stringify(names) !== JSON.stringify(['首页', '知识库', '搜索', '通知', '我的'])) issues.push(`标签应是 首页·知识库·搜索·通知·我的,实际 ${JSON.stringify(names)}`)
      for (const handle of await tab.locator('.kb-tabbar .kb-tab').all()) {
        const box = await handle.boundingBox()
        if (!box || box.width < 44 || box.height < 44) issues.push(`标签可点区域不足 44px:${JSON.stringify(box)}`)
      }
      const bar = await rect(tab, '.kb-tabbar')
      if (!bar || Math.round(bar.bottom) !== size.height) issues.push(`标签栏应贴底,下缘 ${bar?.bottom} / ${size.height}`)
      if (await tab.locator('.kb-nav-slot').isVisible()) issues.push('标签栏形态下不该有侧栏')
      // 标签栏形态的顶栏:48px 一行,有标题、AI、头像;侧栏开关 / 搜索 / 通知(在标签栏里)不在顶栏
      const topbar = await rect(tab, '.kb-topbar')
      if (!topbar || Math.round(topbar.height) !== 48) issues.push(`标签栏形态的顶栏应 48px 高,实际 ${topbar?.height}`)
      for (const id of ['nav-toggle', 'topbar-search', 'bell']) if (await tab.locator(`.kb-topbar [data-testid=${id}]`).isVisible()) issues.push(`标签栏形态下顶栏不该有 ${id}`)
      for (const id of ['assistant-toggle', 'account-trigger']) if (!(await tab.locator(`.kb-topbar [data-testid=${id}]`).isVisible())) issues.push(`顶栏应有 ${id}`)
      if (!(await tab.locator('.kb-topbar-title').innerText()).includes('首页')) issues.push('顶栏标题应是「首页」')
      if (await tab.locator('.hamb, .kb-fab, .kb-mobile-nav-wrap').count()) issues.push('汉堡按钮 / 悬浮球 / 导航抽屉应已移除')
      if ((await tab.locator('[data-tab=home]').getAttribute('aria-current')) !== 'page') issues.push('首页标签应是当前页')
      // 通知角标 2;点通知标签打开抽屉并高亮,再点收起
      if (((await tab.locator('[data-testid=tab-badge-notify]').innerText()).trim()) !== '2') issues.push('通知标签角标应是 2')
      await tab.locator('[data-tab=notify]').click()
      await tab.waitForSelector('[data-testid=notification-drawer]', { timeout: 3000 }).catch(() => issues.push('点通知标签没有打开抽屉'))
      await tab.keyboard.press('Escape')
      await tab.waitForSelector('[data-testid=notification-drawer]', { state: 'detached', timeout: 2000 }).catch(() => issues.push('Esc 应关闭通知抽屉'))
      // 知识库 / 搜索 / 我的 各自跳转并高亮
      for (const [tabId, pattern] of [['kb', /\/kb/], ['search', /\/search/], ['mine', /\/mine/]]) {
        await tab.locator(`[data-tab=${tabId}]`).click()
        await tab.waitForURL(pattern, { timeout: 5000 }).catch(() => issues.push(`点 ${tabId} 标签没有跳转`))
        if ((await tab.locator(`[data-tab=${tabId}]`).getAttribute('aria-current')) !== 'page') issues.push(`${tabId} 标签应高亮`)
      }
      return issues
    },
  },
  'shell-tabbar-landscape': {
    // 同样是小屏,横屏(宽 ≥840 或 600–839 横屏)用图标栏,不用标签栏
    route: '/home',
    ready: '.kb-nav-slot',
    sizes: ['844x390'],
    settle: 400,
    assert: async (tab) => {
      const issues = []
      if (await tab.locator('[data-testid=tabbar]').count()) issues.push('横屏不该用标签栏')
      if ((await navWidth(tab)) !== 64) issues.push(`横屏应是图标栏 64,实际 ${await navWidth(tab)}`)
      return issues
    },
  },
  'shell-mine': {
    // 「我的」页:账号卡片、按功能表过滤的入口、外观、退出登录;从这里进入的页面左上角有返回,回到「我的」
    route: '/mine',
    ready: '[data-testid=mine]',
    sizes: ['390x844', '673x841', '820x1180'],
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('[data-testid=mine]').innerText()
      for (const word of ['管理员', '我的', '管理', '审核收件箱', '任务', '导入', '系统概览', '用户与权限', '系统参数', '系统设置', '系统状态', 'AI 助手', '外观', '退出登录']) if (!text.includes(word)) issues.push(`「我的」页缺「${word}」`)
      // 标签栏里已经有的入口不在这里重复(按入口 id 判断,不靠文字)
      const rows = await tab.locator('[data-nav-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-nav-id')))
      for (const id of ['home', 'kb', 'search', 'assistant']) if (rows.includes(id)) issues.push(`标签栏 / 抽屉里已有的「${id}」不该在「我的」页重复`)
      if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push('页面横向溢出')
      for (const row of await tab.locator('.kb-mine-row').all()) {
        const box = await row.boundingBox()
        if (box && box.height < 44) issues.push(`行高不足 44:${box.height}`)
      }
      // 进入「任务」,左上角返回回到「我的」
      await tab.locator('[data-nav-id=tasks]').click()
      await tab.waitForURL(/\/tasks/)
      await tab.waitForSelector('[data-testid=topbar-back]', { timeout: 3000 }).catch(() => issues.push('从「我的」进入的页面应有返回键'))
      await tab.locator('[data-testid=topbar-back]').click()
      await tab.waitForURL(/\/mine/, { timeout: 3000 }).catch(() => issues.push('返回应回到「我的」'))
      // 点 AI 助手打开全屏抽屉
      await tab.locator('[data-testid=mine-assistant]').click()
      await tab.waitForSelector('.kb-agent-widget', { timeout: 3000 }).catch(() => issues.push('点 AI 助手没有打开抽屉'))
      const drawer = await rect(tab, '.kb-agent-widget')
      if (drawer && drawer.top !== 0) issues.push(`手机上的助手抽屉应全屏,top=${drawer.top}`)
      await tab.locator('.kb-agent-widget button[aria-label=收起]').click()
      // 退出登录
      const logout = tab.waitForRequest((req) => req.url().includes('/api/v1/auth/logout'), { timeout: 5000 }).catch(() => null)
      await tab.locator('[data-testid=mine-signout]').click()
      if (!(await logout)) issues.push('点退出登录没有请求 /auth/logout')
      await tab.waitForURL(/\/login/, { timeout: 5000 }).catch(() => issues.push('退出后应回到登录页'))
      await tab.waitForLoadState('networkidle')
      return issues
    },
  },
  'shell-phone-workbench': {
    // 手机上的知识库:列表页有全局顶栏(标题 + AI),进入文档后让位给文档自己的顶栏(只剩一条)
    route: '/kb',
    ready: '.kb-workbench-dual',
    sizes: ['390x844'],
    settle: 600,
    assert: async (tab) => {
      const issues = []
      if (!(await tab.locator('.kb-topbar').isVisible())) issues.push('列表页应保留全局顶栏')
      await tab.locator('.kb-sidebar-item').first().click()
      await tab.waitForTimeout(400)
      if (await tab.locator('.kb-topbar').isVisible()) issues.push('进入文档后全局顶栏应让位')
      if (!(await tab.locator('.kb-workspace-bar').isVisible())) issues.push('进入文档后应只剩文档自己的顶栏')
      return issues
    },
  },

  'shell-redirects': {
    // 旧地址在真实浏览器里重定向到新地址(书签、邮件里的链接):保留 query / hash,页面正常渲染,导航高亮对应入口
    route: '/home',
    ready: '.kb-topbar, [data-testid=tabbar]',
    sizes: ['1440x900'],
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const base = new URL(tab.url()).origin
      const cases = [
        ['/dashboard', '/admin/overview', '系统概览'],
        ['/browser?collection=knowledgeBase%2Finsights&item=ins_8f21', '/kb?collection=knowledgeBase%2Finsights&item=ins_8f21', null],
        ['/sources', '/import', null],
        ['/ingest?batch=all&filter=failed', '/import/queue?batch=all&filter=failed', null],
        ['/jobs', '/tasks', '任务'],
        ['/audit?tab=batches', '/admin/audit?tab=batches', null],
        ['/settings?tab=appearance', '/me/appearance', null],
        ['/settings?tab=backup', '/admin/settings?tab=backup', null],
        ['/settings/appearance', '/me/appearance', null],
        ['/agent', '/assistant', null],
        ['/users', '/admin/users', null],
        ['/params', '/admin/params', null],
        ['/projects', '/admin/projects', null],
        ['/system', '/admin/system', null],
        ['/eval', '/admin/eval', '评测'],
      ]
      // 浏览器会把 query 里的 %2F 规范化成 /,所以按「路径 + 解码后的 query」比较,不比字符串
      const norm = (value) => {
        const url = new URL(value, 'http://x')
        return `${url.pathname}?${[...url.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort().join('&')}${url.hash}`
      }
      for (const [from, to, word] of cases) {
        await tab.goto(`${base}${from}`, { waitUntil: 'networkidle' })
        const landed = new URL(tab.url())
        if (norm(`${landed.pathname}${landed.search}${landed.hash}`) !== norm(to)) issues.push(`${from} 应重定向到 ${to},实际 ${landed.pathname}${landed.search}`)
        await tab.waitForSelector('.kb-nav-slot, [data-testid=tabbar]', { state: 'attached' })
        if (word && !(await tab.locator('.kb-topbar').innerText()).includes(word)) issues.push(`${from} → 顶栏应写「${word}」`)
        if (await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth) > 1) issues.push(`${to} 横向溢出`)
      }
      // 根地址 → 首页
      await tab.goto(`${base}/`, { waitUntil: 'networkidle' })
      if (new URL(tab.url()).pathname !== '/home') issues.push(`/ 应去首页,实际 ${tab.url()}`)
      // 重定向用 replace:从旧地址进来后「返回」回到之前的页面,不会又弹回旧地址
      await tab.goto(`${base}/search`, { waitUntil: 'networkidle' })
      await tab.evaluate(() => { location.href = '/jobs' })
      await tab.waitForURL(/\/tasks/)
      return issues
    },
  },
  'shell-nav-groups': {
    // 「我的 / 管理」两组:管理员两组都有且没有项目树;普通用户没有「管理」组;AI 关闭没有审核收件箱和 AI 助手;当前页高亮
    // 本场景只管「有哪些入口」,所以把分组钉成手动展开(默认矮屏会自动收起「管理」,行为见 shell-nav-fits)
    route: '/tasks',
    ready: '.kb-nav',
    sizes: ['1440x900'],
    fixture: { __prefs: { ui: { navCollapsed: [] } } },
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const groups = await tab.locator('.kb-nav .kb-nav-group').allInnerTexts()
      if (JSON.stringify(groups.map((text) => text.trim())) !== JSON.stringify(['我的', '管理'])) issues.push(`分组应是 我的 / 管理,实际 ${JSON.stringify(groups)}`)
      const ids = await tab.locator('.kb-nav [data-nav-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-nav-id')))
      const want = ['home', 'kb', 'search', 'shares', 'trash', 'review', 'import', 'tasks', 'friends', 'assistant', 'overview', 'users', 'params', 'usage', 'projects', 'system', 'audit', 'eval', 'settings']
      if (JSON.stringify(ids) !== JSON.stringify(want)) issues.push(`入口应是 ${want.join(',')},实际 ${ids.join(',')}`)
      const text = await tab.locator('.kb-nav').innerText()
      for (const word of ['SampleApp', 'sampleproj', '管理项目与集合']) if (text.includes(word)) issues.push(`侧栏里不该再固定列出项目「${word}」`)
      if ((await tab.locator('.kb-nav a[aria-current=page]').getAttribute('data-nav-id')) !== 'tasks') issues.push('当前页「任务」应高亮')
      const hrefs = await tab.locator('.kb-nav [data-nav-id]').evaluateAll((els) => els.map((el) => el.getAttribute('href')))
      if (hrefs.some((href) => /^\/(dashboard|browser|sources|ingest|jobs|audit|eval|projects|system|settings|agent|params|users)(\/|$|\?)/.test(href ?? ''))) issues.push(`侧栏里还有旧地址:${hrefs.join(',')}`)
      return issues
    },
  },
  'shell-nav-groups-plain': {
    route: '/tasks',
    ready: '.kb-nav',
    sizes: ['1440x900'],
    fixture: { __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('sys.') && id !== 'sources.local' && id !== 'search.tune'), true) } },
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const groups = (await tab.locator('.kb-nav .kb-nav-group').allInnerTexts()).map((text) => text.trim())
      if (JSON.stringify(groups) !== JSON.stringify(['我的'])) issues.push(`普通用户只该有「我的」组,实际 ${JSON.stringify(groups)}`)
      const ids = await tab.locator('.kb-nav [data-nav-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-nav-id')))
      if (ids.some((id) => ['overview', 'users', 'params', 'projects', 'system', 'audit', 'eval', 'settings'].includes(id))) issues.push(`普通用户不该看到管理入口:${ids.join(',')}`)
      return issues
    },
  },
  'shell-nav-groups-ai-off': {
    route: '/tasks',
    ready: '.kb-nav',
    sizes: ['1440x900'],
    fixture: { __prefs: { ui: { navCollapsed: [] } }, __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => !id.startsWith('ai.') && id !== 'search.deep'), false) } },
    settle: 600,
    assert: async (tab) => {
      const issues = []
      const ids = await tab.locator('.kb-nav [data-nav-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-nav-id')))
      for (const id of ['review', 'assistant']) if (ids.includes(id)) issues.push(`AI 关闭后不该有「${id}」入口`)
      for (const id of ['home', 'kb', 'search', 'import', 'tasks', 'overview']) if (!ids.includes(id)) issues.push(`非 AI 入口「${id}」应照常`)
      return issues
    },
  },

  'shell-nav-fits': {
    // 左侧导航整列要放得下:矮屏(900 / 800 高)自动收起「管理」,任何入口都不能被切在滚动区边缘;
    // 高屏(1080) 默认全展;用户点开/收起后记住选择(空数组 = 就要展开)
    route: '/tasks',
    ready: '.kb-nav',
    sizes: ['1440x900', '1920x1080'],
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      const probe = () =>
        tab.evaluate(() => {
          const nav = document.querySelector('.kb-nav-scroll')
          if (!nav) return null
          const box = nav.getBoundingClientRect()
          const sliced = [...nav.querySelectorAll('.kb-nav-item')]
            .filter((el) => {
              const b = el.getBoundingClientRect()
              return b.top < box.bottom - 0.5 && b.bottom > box.bottom + 0.5
            })
            .map((el) => (el.textContent || '').trim())
          return {
            sliced,
            overflow: nav.scrollHeight - nav.clientHeight,
            expanded: document.querySelector('[data-testid=nav-group-toggle]')?.getAttribute('aria-expanded') ?? null,
            ids: [...nav.querySelectorAll('[data-nav-id]')].map((el) => el.getAttribute('data-nav-id')),
          }
        })
      const state = await probe()
      if (!state) return ['找不到 .kb-nav-scroll']
      if (state.sliced.length) issues.push(`有入口被切在滚动区边缘:${state.sliced.join(',')}`)
      if (state.expanded !== 'false' && state.expanded !== 'true') issues.push('缺少分组折叠开关(应是一个 aria-expanded 的按钮)')
      const short = size.height < 1000
      if (short) {
        // 矮屏:收起「管理」,自己那组入口一个不少
        if (state.expanded !== 'false') issues.push(`矮屏(${size.name})应自动收起「管理」`)
        if (state.ids.includes('users')) issues.push('收起后不该还渲染管理入口')
        if (!state.ids.includes('tasks')) issues.push('收起后不该影响「我的」那组')
        if (state.overflow > 0) issues.push(`矮屏收起后整列仍溢出 ${state.overflow}px`)
        // 点开 = 明确表态:记进偏好(空数组),刷新后也保持展开
        await tab.locator('[data-testid=nav-group-toggle]').click()
        if ((await probe()).expanded !== 'true') issues.push('点一下应展开「管理」')
        const saved = await savedUi(tab)
        if (JSON.stringify(saved.navCollapsed) !== '[]') issues.push(`手动展开应记成空数组,实际 ${JSON.stringify(saved.navCollapsed)}`)
        await tab.reload({ waitUntil: 'networkidle' })
        await tab.waitForSelector('.kb-nav')
        if ((await probe()).expanded !== 'true') issues.push('刷新后应保持手动展开')
        // 再点回去:记成 ['admin'],也不再切入口(靠滚动看得到)
        await tab.locator('[data-testid=nav-group-toggle]').click()
        if ((await probe()).expanded !== 'false') issues.push('再点一下应收起')
        if (JSON.stringify((await savedUi(tab)).navCollapsed) !== '["admin"]') issues.push('手动收起应记成 ["admin"]')
      } else {
        // 高屏:放得下就别拿折叠烦人
        if (state.expanded !== 'true') issues.push(`高屏(${size.name})默认不应收起「管理」`)
        if (!state.ids.includes('settings')) issues.push('高屏下管理入口应全在')
        if (state.overflow > 0) issues.push(`高屏整列不该溢出,实际 ${state.overflow}px`)
      }
      // 当前页在「管理」里的页面:那一组必须展开,否则正看的那一页在导航里消失
      await tab.goto(new URL('/admin/eval', tab.url()).toString(), { waitUntil: 'networkidle' })
      await tab.waitForSelector('.kb-nav')
      const inside = await probe()
      if (inside.expanded !== 'true') issues.push('当前页在「管理」里时应自动展开该组')
      return issues
    },
  },

  'shell-savebar': {
    // 页面里固定在底部的保存条跟着外壳走:左边让出侧栏(三态 / 拖动都对),手机上让出标签栏,不被盖住
    route: '/admin/params',
    ready: '.kb-sp-body',
    sizes: ['390x844', '820x1180', '1180x820', '1440x900'],
    settle: 400,
    assert: async (tab, size) => {
      const issues = []
      await tab.locator('.kb-sp-row', { hasText: '每人存储配额' }).locator('input').fill('500')
      await tab.waitForSelector('.kb-sp-save')
      const bar = async () => rect(tab, '.kb-sp-save')
      const tabbed = await tab.locator('[data-testid=tabbar]').isVisible()
      if (tabbed) {
        const tabs = await rect(tab, '.kb-tabbar')
        const save = await bar()
        if (Math.round(save.bottom) > Math.round(tabs.top)) issues.push(`保存条被标签栏盖住:保存条下缘 ${save.bottom},标签栏上缘 ${tabs.top}`)
        if (save.left < 0 || save.right > size.width) issues.push(`标签栏形态下保存条超出屏幕:${save.left}~${save.right}`)
      } else {
        const expected = await navWidth(tab)
        const save = await bar()
        if (Math.round(save.left) !== expected) issues.push(`保存条左边应让出侧栏 ${expected},实际 ${save.left}`)
        if (size.width >= 1280) {
          await tab.keyboard.press('Control+b')
          if (Math.round((await bar()).left) !== 64) issues.push(`侧栏收成图标栏后保存条左边应是 64,实际 ${(await bar()).left}`)
          await tab.keyboard.press('Control+b')
          if (Math.round((await bar()).left) !== 0) issues.push(`侧栏隐藏后保存条应从最左开始,实际 ${(await bar()).left}`)
        }
      }
      // 保存按钮真的点得到(没被别的东西盖住)
      const request = tab.waitForRequest((req) => req.url().includes('/capabilities/update_config'), { timeout: 5000 }).catch(() => null)
      await tab.locator('.kb-sp-save .kb-btn.is-primary').click({ timeout: 5000 }).catch(() => issues.push('保存按钮点不到(被盖住了?)'))
      if (!(await request)) issues.push('点保存没有发出请求')
      return issues
    },
  },

  'shell-savebar-short-app': {
    // 手机浏览器自带底部工具栏时,外壳(100dvh)比窗口矮几十像素:fixed 的保存条会掉到标签栏下面(真机截图)。
    // 这里把外壳人为缩短,保存条在任何滚动位置都必须在标签栏上方,按钮点得到
    route: '/admin/params',
    ready: '.kb-sp-body',
    sizes: ['390x844', '360x640'],
    settle: 400,
    assert: async (tab) => {
      const issues = []
      if (!(await tab.locator('[data-testid=tabbar]').isVisible())) return issues
      await tab.addStyleTag({ content: '.kb-app{height:calc(100dvh - 50px)!important}' })
      await tab.locator('.kb-sp-row', { hasText: '每人存储配额' }).locator('input').fill('500')
      await tab.waitForSelector('.kb-sp-save')
      for (const [label, top] of [['顶部', 0], ['中段', 1500], ['滚到底', 1e6]]) {
        await tab.evaluate((y) => { document.querySelector('.content').scrollTop = y }, top)
        await tab.waitForTimeout(150)
        const save = await rect(tab, '.kb-sp-save')
        const tabs = await rect(tab, '.kb-tabbar')
        if (Math.round(save.bottom) > Math.round(tabs.top)) issues.push(`${label}:保存条被标签栏盖住,保存条下缘 ${save.bottom},标签栏上缘 ${tabs.top}`)
      }
      const request = tab.waitForRequest((req) => req.url().includes('/capabilities/update_config'), { timeout: 5000 }).catch(() => null)
      await tab.locator('.kb-sp-save .kb-btn.is-primary').click({ timeout: 5000 }).catch(() => issues.push('保存按钮点不到(被盖住了?)'))
      if (!(await request)) issues.push('点保存没有发出请求')
      return issues
    },
  },

  'ui-density': {
    // 密度两档(舒适 / 紧凑)+ 侧栏默认状态:在「外观」里改,立刻生效、写回服务端偏好、列表行高和导航项高跟着变;触屏上紧凑档也不低于 44
    route: '/me/appearance',
    ready: '[data-testid=list-density]',
    sizes: ['1440x900', '1180x820', '390x844'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const attr = () => tab.evaluate(() => document.documentElement.getAttribute('data-ui-density'))
      const rowHeight = async () => {
        await tab.goto(new URL('/dev/kit', tab.url()).toString(), { waitUntil: 'networkidle' })
        await tab.waitForSelector('[data-testid=rt-row], [data-testid=rt-card]')
        const box = await tab.locator('[data-testid=rt-row], [data-testid=rt-card]').first().boundingBox()
        return Math.round(box.height)
      }
      const navItemHeight = async () => (size.width >= 840 ? Math.round((await tab.locator('.kb-nav .kb-nav-scroll .kb-nav-item').first().boundingBox()).height) : null)
      if ((await attr()) !== 'comfortable') issues.push(`默认应是舒适档,实际 ${await attr()}`)
      const comfortableRow = await rowHeight()
      const comfortableNav = await navItemHeight()
      if (size.touch ? comfortableRow < 44 : comfortableRow !== 49 && comfortableRow !== 48) issues.push(`舒适档的行高应是 48(表格行含 1px 分隔线),实际 ${comfortableRow}`)
      // 去「外观」选紧凑
      await tab.goto(new URL('/me/appearance', tab.url()).toString(), { waitUntil: 'networkidle' })
      await tab.waitForSelector('[data-testid=list-density]')
      const put = tab.waitForRequest((req) => req.url().includes('/api/v1/me/prefs') && req.method() === 'PUT', { timeout: 4000 }).catch(() => null)
      await tab.locator('[data-testid=list-density]').getByRole('tab', { name: '紧凑' }).click()
      if ((await attr()) !== 'compact') issues.push(`选紧凑后 <html data-ui-density> 应立刻变成 compact,实际 ${await attr()}`)
      const sent = await put
      if (!sent) issues.push('改密度后没有写回偏好')
      else if (JSON.parse(sent.postData() ?? '{}').prefs?.ui?.density !== 'compact') issues.push(`写回的 ui.density 不对:${sent.postData()}`)
      const compactRow = await rowHeight()
      const compactNav = await navItemHeight()
      if (size.touch) {
        if (compactRow < 44) issues.push(`触屏上紧凑档行高也不能低于 44,实际 ${compactRow}`)
      } else {
        if (compactRow >= comfortableRow) issues.push(`紧凑档行高应小于舒适档:${compactRow} vs ${comfortableRow}`)
        if (compactRow < 36 || compactRow > 37) issues.push(`紧凑档行高应是 36,实际 ${compactRow}`)
        if (compactNav !== null && compactNav >= comfortableNav) issues.push(`紧凑档导航项应更矮:${compactNav} vs ${comfortableNav}`)
      }
      // 刷新后仍是紧凑(本地存储 + 服务端)
      await tab.reload({ waitUntil: 'networkidle' })
      if ((await attr()) !== 'compact') issues.push('刷新后应仍是紧凑')
      // 侧栏默认状态(只有有侧栏的尺寸)
      if (size.width >= 1280) {
        await tab.goto(new URL('/me/appearance', tab.url()).toString(), { waitUntil: 'networkidle' })
        const nav = async () => Math.round((await rect(tab, '.kb-nav-slot')).width)
        const choose = (name) => tab.locator('[data-testid=sidebar-choice]').getByRole('tab', { name }).click()
        await choose('图标栏')
        if ((await nav()) !== 64) issues.push(`选「图标栏」后侧栏应是 64,实际 ${await nav()}`)
        await choose('隐藏')
        if ((await nav()) !== 0) issues.push(`选「隐藏」后侧栏应是 0,实际 ${await nav()}`)
        await choose('展开')
        if ((await nav()) !== 240) issues.push(`选「展开」后侧栏应是 240,实际 ${await nav()}`)
        const reset = tab.waitForRequest((req) => req.url().includes('/api/v1/me/prefs') && req.method() === 'PUT', { timeout: 4000 }).catch(() => null)
        await choose('自动')
        const body = await reset
        if (body && 'sidebar' in (JSON.parse(body.postData() ?? '{}').prefs?.ui ?? {})) issues.push('选「自动」应把侧栏选择从偏好里去掉')
        if ((await nav()) !== 240) issues.push(`「自动」在电脑上应展开 240,实际 ${await nav()}`)
      }
      return issues
    },
  },
  'ui-contrast': {
    // 真实浏览器里的对比度:五个主题下,文字 token 叠在各层背景上都要达标(校准文件 contrast.css 在层叠里确实生效)
    route: '/dev/kit',
    ready: '[data-testid=kit]',
    sizes: ['1440x900', '390x844'],
    settle: 400,
    assert: async (tab) => {
      const issues = []
      const result = await tab.evaluate(() => {
        const need = { 'text-primary': 7, 'text-secondary': 7, 'text-tertiary': 4.5, 'text-quaternary': 3, 'status-success-text': 4.5, 'status-warning-text': 4.5, 'status-danger-text': 4.5, 'status-info-text': 4.5 }
        const bgs = ['bg-canvas', 'bg-sidebar', 'surface-1', 'surface-2', 'surface-3', 'surface-sunken']
        const probe = document.createElement('i')
        document.body.append(probe)
        const rgb = (value) => {
          probe.style.color = value
          return getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number)
        }
        const lum = ([r, g, b]) => [r, g, b].map((c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0)
        const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
        const out = []
        for (const theme of ['dark', 'oled', 'slate', 'light', 'paper']) {
          document.documentElement.setAttribute('data-theme', theme)
          for (const [token, min] of Object.entries(need)) {
            const color = rgb(`var(--${token})`)
            const worst = Math.min(...bgs.map((bg) => ratio(color, rgb(`var(--${bg})`))))
            if (worst < min) out.push(`${theme} ${token} ${worst.toFixed(2)} < ${min}`)
          }
        }
        probe.remove()
        return out
      })
      for (const line of result) issues.push(`对比度不达标:${line}`)
      return issues
    },
  },

  'shell-all-pages': {
    // .7:每个现有页面都套着新外壳——有顶栏(或手机标题栏)带着页面标题、有导航(侧栏或标签栏)、当前入口高亮,
    // 没有旧的底部状态栏 / 悬浮球 / 汉堡按钮,没有横向溢出。页面内容本身这一轮不改。
    route: '/home',
    ready: '.kb-app',
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      const pages = [
        ['/home', '首页', 'home'], ['/kb', null, 'kb'], ['/search', '搜索', 'search'], ['/review', '审核收件箱', 'review'],
        ['/import', '导入', 'import'], ['/import/queue', '导入', 'import'], ['/tasks', '任务', 'tasks'], ['/assistant', 'AI 助手', 'assistant'],
        ['/mine', '我的', null], ['/me', '个人设置', null], ['/me/appearance', '外观', null],
        ['/admin/overview', '系统概览', 'overview'], ['/admin/users', '用户与权限', 'users'], ['/admin/params', '系统参数', 'params'],
        ['/admin/projects', '项目与集合', 'projects'], ['/admin/system', '系统状态', 'system'], ['/admin/audit', '审计', 'audit'],
        ['/admin/eval', '评测', 'eval'], ['/admin/settings?tab=general', '设置', 'settings'], ['/dev/kit', '组件库', null],
      ]
      const base = new URL(tab.url()).origin
      const tabbed = size.width < 600 || (size.width < 840 && size.height > size.width)
      for (const [path, title, navId] of pages) {
        await tab.goto(`${base}${path}`, { waitUntil: 'networkidle' })
        await tab.waitForSelector(tabbed ? '[data-testid=tabbar]' : '.kb-nav-slot', { state: 'attached' })
        const info = await tab.evaluate(() => {
          const visible = (selector) => { const el = document.querySelector(selector); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0 }
          const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? ''
          return {
            topbar: visible('.kb-topbar'),
            title: text('#kb-slot-bc') || text('#kb-slot-mbar'),
            legacy: ['.foot', '.mbar', '.kb-fab', '.hamb', '.tabbar'].filter((selector) => document.querySelector(selector)),
            active: document.querySelector('.kb-nav a[aria-current=page]')?.getAttribute('data-nav-id') ?? null,
            overflow: document.documentElement.scrollWidth - innerWidth,
            appHeight: Math.round(document.querySelector('.kb-app').getBoundingClientRect().height),
          }
        })
        if (info.legacy.length) issues.push(`${path}:还有旧外壳元素 ${info.legacy.join(' ')}`)
        if (info.overflow > 1) issues.push(`${path}:横向溢出 ${info.overflow}px`)
        if (info.appHeight !== size.height) issues.push(`${path}:外壳高度 ${info.appHeight} ≠ 视口 ${size.height}`)
        if (path !== '/kb' && !info.topbar) issues.push(`${path}:没有顶栏`)
        if (title && !info.title.includes(title)) issues.push(`${path}:顶栏标题应含「${title}」,实际「${info.title}」`)
        if (!tabbed && navId && info.active !== navId) issues.push(`${path}:侧栏应高亮「${navId}」,实际 ${info.active}`)
      }
      return issues
    },
  },
}
