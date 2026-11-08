// PWA(设计规范)的 Playwright 场景:manifest 与图标可用、主题色跟主题走、service worker 只缓存静态资源且不碰 API、独立窗口里补后退 / 刷新并接管外部链接。
// 由 viewer-shots.mjs 引入,在设备矩阵 × 引擎下跑。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rect } from './shell-scenarios.mjs'

/** service worker 当前声明的缓存名(public/sw.js 的 CACHE)。升版本只改 sw.js 一处,场景跟着走,不再写死某一代的名字 */
const SW_CACHE = /const CACHE = '([^']+)'/.exec(readFileSync(join(import.meta.dirname, '../public/sw.js'), 'utf8'))?.[1]

/** 让页面认为自己跑在已安装的独立窗口里:display-mode: standalone 命中 + 记录 window.open。 */
export const STANDALONE_INIT = `
  (() => {
    const original = window.matchMedia.bind(window)
    window.matchMedia = (query) => {
      if (/display-mode:\\s*standalone/.test(query)) {
        return { matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false } }
      }
      return original(query)
    }
    window.__opened = []
    window.open = (...args) => { window.__opened.push(args); return null }
  })()
`

export const PWA_SCENARIOS = {
  'pwa-manifest': {
    // 页面声明了 manifest / 图标 / 主题色;每个被引用的文件都取得到;Chromium 里再问浏览器它解析出了什么、能不能安装
    route: '/home',
    ready: '.kb-topbar',
    sizes: ['390x844', '1440x900'],
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      const head = await tab.evaluate(() => ({
        manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href'),
        theme: document.querySelector('meta[name=theme-color]')?.getAttribute('content'),
        apple: document.querySelector('link[rel=apple-touch-icon]')?.getAttribute('href'),
        capable: document.querySelector('meta[name=apple-mobile-web-app-capable]')?.getAttribute('content'),
        statusBar: document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]')?.getAttribute('content'),
        icon: document.querySelector('link[rel=icon][type="image/svg+xml"]')?.getAttribute('href'),
      }))
      if (head.manifest !== '/manifest.webmanifest') issues.push(`缺 manifest 链接:${head.manifest}`)
      if (head.theme !== '#08080a') issues.push(`深色主题的 theme-color 应是 #08080a,实际 ${head.theme}`)
      if (head.apple !== '/icons/apple-touch-icon.png') issues.push(`缺 apple-touch-icon:${head.apple}`)
      if (head.capable !== 'yes') issues.push('缺 apple-mobile-web-app-capable')
      if (head.statusBar !== 'black') issues.push(`状态栏样式应是 black,实际 ${head.statusBar}`)
      if (!head.icon) issues.push('缺 SVG 图标 link')
      const fetched = await tab.evaluate(async () => {
        const manifest = await (await fetch('/manifest.webmanifest')).json()
        const urls = [...manifest.icons.map((icon) => icon.src), '/icon.svg', '/icons/apple-touch-icon.png']
        const results = []
        for (const url of urls) {
          const response = await fetch(url)
          results.push([url, response.status, response.headers.get('content-type')])
        }
        return { manifest, results }
      })
      for (const [url, status, type] of fetched.results) {
        if (status !== 200) issues.push(`${url} 取不到:${status}`)
        else if (/\.png$/.test(url) && type !== 'image/png') issues.push(`${url} 类型应是 image/png,实际 ${type}`)
      }
      if (fetched.manifest.display !== 'standalone') issues.push(`display 应是 standalone:${fetched.manifest.display}`)
      if (!fetched.manifest.icons.some((icon) => icon.purpose === 'maskable')) issues.push('缺 maskable 图标')
      // Chromium:让浏览器自己解析一遍(WebKit 没有这个协议)
      if (tab.context().browser().browserType().name() === 'chromium') {
        const session = await tab.context().newCDPSession(tab)
        const result = await session.send('Page.getAppManifest')
        if (result.errors?.length) issues.push(`浏览器解析 manifest 报错:${result.errors.map((e) => e.message).join(';')}`)
        const parsed = JSON.parse(result.data || '{}')
        if (parsed.name !== 'knowledgeBase') issues.push(`浏览器读到的 name:${parsed.name}`)
        const installability = await session.send('Page.getInstallabilityErrors')
        // 自动化环境里没有 service worker 控制页面、也不是 https,这两类不算 manifest 的问题;其它的(图标尺寸、缺字段)要为零
        const real = (installability.installabilityErrors ?? []).filter((item) => !['not-from-secure-origin', 'no-matching-service-worker', 'not-installable-yet', 'no-url-for-service-worker', 'already-installed'].includes(item.errorId))
        if (real.length) issues.push(`浏览器报告不可安装:${real.map((item) => item.errorId).join(',')}`)
      }
      void size
      return issues
    },
  },
  'pwa-theme-color': {
    // 浏览器 / 系统栏颜色跟着当前主题走:首屏(boot 脚本)和运行时(外观设置)都要对
    route: '/me/appearance',
    ready: '.kb-topbar',
    sizes: ['390x844'],
    init: `localStorage.setItem('kb.appearance', JSON.stringify({ theme: 'paper' }))`,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const read = () => tab.evaluate(() => [...document.querySelectorAll('meta[name=theme-color]')].map((meta) => [meta.getAttribute('content'), meta.getAttribute('media')]))
      const first = await read()
      if (first.length !== 1 || first[0][0] !== '#f6f3ec') issues.push(`纸张主题的 theme-color 应是 #f6f3ec,实际 ${JSON.stringify(first)}`)
      const expected = { dark: '#08080a', oled: '#000000', slate: '#0a0e16', light: '#fafafa' }
      // 走外观页上真实的主题卡片,切换后系统栏颜色要立刻跟着变
      const labels = { dark: '暗夜', oled: '纯黑 OLED', slate: '深海石墨', light: '浅色' }
      for (const [theme, color] of Object.entries(expected)) {
        await tab.getByText(labels[theme], { exact: true }).first().click()
        await tab.waitForTimeout(150)
        const actual = await tab.evaluate(() => document.documentElement.getAttribute('data-theme'))
        if (actual !== theme) {
          issues.push(`点「${labels[theme]}」后 data-theme 应是 ${theme},实际 ${actual}`)
          continue
        }
        const now = await read()
        if (now.length !== 1 || now[0][0] !== color || now[0][1]) issues.push(`${theme} 的 theme-color 应是 ${color}(且没有 media),实际 ${JSON.stringify(now)}`)
      }
      return issues
    },
  },
  'pwa-service-worker': {
    // service worker:能注册、只缓存静态资源、不缓存 API 和页面、断网时给离线说明
    route: '/home',
    ready: '.kb-topbar',
    sizes: ['1440x900'],
    // WebKit 里一旦有 service worker 接管页面,Playwright 的 context.route(fixture)就拦不到页面发出的请求了(自动化的限制,不是应用问题),
    // 所以只在 Chromium 打开;WebKit 上 service worker 的逻辑由 vitest 里的沙箱测试覆盖,注册路径由 manifest 场景保证页面不报错
    serviceWorkers: (engine) => (engine === 'chromium' ? 'allow' : 'block'),
    settle: 300,
    assert: async (tab) => {
      const issues = []
      if (tab.context().browser().browserType().name() !== 'chromium') return issues
      const registered = await tab.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready
        return { scope: registration.scope, script: registration.active?.scriptURL }
      })
      if (!registered.script?.endsWith('/sw.js')) issues.push(`service worker 脚本应是 /sw.js:${registered.script}`)
      if (!registered.scope.endsWith('/')) issues.push(`作用域:${registered.scope}`)
      // 注册后的页面还没被接管:重新加载一次,让资源请求经过 service worker
      await tab.reload({ waitUntil: 'networkidle' })
      await tab.waitForSelector('.kb-topbar')
      await tab.waitForTimeout(500)
      const cached = await tab.evaluate(async () => {
        const names = await caches.keys()
        const urls = []
        for (const name of names) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname)
        return { names, urls }
      })
      if (!SW_CACHE) issues.push('读不出 public/sw.js 里声明的缓存名')
      else if (!cached.names.includes(SW_CACHE)) issues.push(`应有缓存 ${SW_CACHE}:${cached.names}`)
      // 升版本时 activate 会删掉旧版本的缓存:只该剩当前这一代
      const stale = cached.names.filter((name) => name.startsWith('kb-static-') && name !== SW_CACHE)
      if (stale.length) issues.push(`旧版本的缓存没清掉:${stale}`)
      if (!cached.urls.some((url) => url.startsWith('/assets/'))) issues.push('应缓存了 /assets/ 下的静态资源')
      const bad = cached.urls.filter((url) => !/^\/(assets\/|icons\/|icon\.svg$)/.test(url))
      if (bad.length) issues.push(`不该缓存这些:${bad.slice(0, 4).join(' ')}`)
      // 断网:导航给离线说明;已缓存的资源仍可取
      await tab.context().setOffline(true)
      const page = await tab.context().newPage()
      await page.goto(new URL('/home', tab.url()).toString()).catch(() => {})
      const offlineText = await page.locator('body').innerText().catch(() => '')
      if (!offlineText.includes('连不上服务器')) issues.push(`断网时应显示离线说明,实际:${offlineText.slice(0, 40)}`)
      await page.close()
      await tab.context().setOffline(false)
      return issues
    },
  },
  'pwa-standalone': {
    // 独立窗口:顶栏补后退 / 刷新,外部链接新开并提示;普通浏览器窗口里这些都不出现(见 pwa-browser-window)
    route: '/home',
    ready: '.kb-topbar',
    sizes: ['390x844', '820x1180', '1440x900'],
    init: STANDALONE_INIT,
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      const mode = await tab.evaluate(() => document.documentElement.dataset.displayMode)
      if (mode !== 'standalone') issues.push(`html[data-display-mode] 应是 standalone,实际 ${mode}`)
      if (!(await tab.getByTestId('topbar-reload').isVisible())) return [...issues, '独立窗口的顶栏应有刷新按钮']
      const reload = await rect(tab, '[data-testid=topbar-reload]')
      if (reload.width < 35.5 || reload.height < 35.5) issues.push(`刷新按钮太小:${reload.width}×${reload.height}`)
      if (size.touch && (reload.width < 43.5 || reload.height < 43.5)) issues.push(`触屏上刷新按钮应 ≥44:${reload.width}×${reload.height}`)
      // 刷新:真的重新加载页面(标记丢失)
      await tab.evaluate(() => { window.__marker = 1 })
      await Promise.all([tab.waitForNavigation({ waitUntil: 'networkidle' }), tab.getByTestId('topbar-reload').click()])
      await tab.waitForSelector('.kb-topbar')
      if (await tab.evaluate(() => window.__marker)) issues.push('点刷新后页面应重新加载')
      // 后退:首页没有历史 → 置灰;去别的页面后可退
      const back = tab.getByTestId('topbar-history-back')
      if (await back.count()) {
        if (!(await back.isDisabled())) issues.push('没有历史时后退应置灰')
      } else if (size.width >= 840) issues.push('桌面 / 平板的独立窗口顶栏应有后退按钮')
      return issues
    },
  },
  'pwa-standalone-navigation': {
    // 在应用内走一步(路由跳转,不是整页加载),顶栏的后退就该可用并真的退回去;外部链接被接管
    route: '/home',
    ready: '.kb-topbar',
    sizes: ['1440x900', '820x1180'],
    init: STANDALONE_INIT,
    settle: 300,
    assert: async (tab, size) => {
      const issues = []
      const wide = size.width >= 840
      if (wide) await tab.locator('.kb-nav a', { hasText: '搜索' }).first().click()
      else await tab.getByTestId('tabbar').getByText('搜索').click()
      await tab.waitForURL('**/search')
      const back = tab.getByTestId('topbar-history-back')
      if (!(await back.isVisible())) return [...issues, '独立窗口里应有后退按钮']
      if (await back.isDisabled()) issues.push('应用内跳转之后后退应可用')
      await back.click()
      await tab.waitForURL('**/home')
      // 外部链接:preventDefault + window.open(noopener) + 提示
      await tab.evaluate(() => {
        const link = document.createElement('a')
        link.id = 'ext'
        link.href = 'https://example.org/docs'
        link.textContent = '外链'
        link.style.cssText = 'position:fixed;top:80px;left:80px;z-index:9999'
        document.body.appendChild(link)
      })
      await tab.locator('#ext').click()
      await tab.waitForTimeout(200)
      const state = await tab.evaluate(() => ({ url: location.pathname, opened: window.__opened }))
      if (state.url !== '/home') issues.push(`外部链接不该在本窗口里跳转:${state.url}`)
      if (state.opened.length !== 1 || state.opened[0][0] !== 'https://example.org/docs') issues.push(`应新开外部链接:${JSON.stringify(state.opened)}`)
      else if (!String(state.opened[0][2]).includes('noopener')) issues.push('新开外部链接要带 noopener')
      if (!(await tab.getByText('外部链接已在浏览器中打开').first().isVisible().catch(() => false))) issues.push('应提示外部链接已在浏览器中打开')
      // 站内链接不受影响
      await tab.evaluate(() => {
        const link = document.createElement('a')
        link.id = 'inner'
        link.href = '/mine'
        link.textContent = '站内'
        link.style.cssText = 'position:fixed;top:120px;left:80px;z-index:9999'
        document.body.appendChild(link)
      })
      // 外壳的点击接管在 document 上;这里在更后面的 window 冒泡阶段看它有没有 preventDefault,再自己拦下避免真的整页跳走
      await tab.evaluate(() => {
        window.addEventListener('click', (event) => { window.__innerPrevented = event.defaultPrevented; event.preventDefault() }, { once: true })
      })
      const before = await tab.evaluate(() => window.__opened.length)
      await tab.locator('#inner').click()
      await tab.waitForTimeout(200)
      const inner = await tab.evaluate(() => ({ prevented: window.__innerPrevented, opened: window.__opened.length }))
      if (inner.prevented !== false) issues.push(`站内链接的点击不该被外链接管拦下:defaultPrevented=${inner.prevented}`)
      if (inner.opened !== before) issues.push('站内链接不该被当成外链新开')
      return issues
    },
  },
  'pwa-browser-window': {
    // 普通浏览器窗口(不是独立窗口):顶栏不加后退 / 刷新(浏览器自带),外部链接照常
    route: '/home',
    ready: '.kb-topbar',
    sizes: ['390x844', '1440x900'],
    settle: 300,
    assert: async (tab) => {
      const issues = []
      const mode = await tab.evaluate(() => document.documentElement.dataset.displayMode)
      if (mode !== 'browser') issues.push(`普通窗口 data-display-mode 应是 browser,实际 ${mode}`)
      for (const id of ['topbar-reload', 'topbar-history-back']) if (await tab.getByTestId(id).count()) issues.push(`普通窗口的顶栏不该有 ${id}`)
      return issues
    },
  },
  'pwa-ios-standalone': {
    // iOS 主屏幕 App:靠 navigator.standalone 判断(display-mode 不一定命中)
    route: '/home',
    ready: '.kb-topbar',
    sizes: ['390x844'],
    init: `Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })`,
    settle: 300,
    assert: async (tab) => {
      const issues = []
      if (!(await tab.getByTestId('topbar-reload').isVisible().catch(() => false))) issues.push('navigator.standalone=true 时也应进入独立窗口模式')
      return issues
    },
  },
}
