// 微信 / QQ 内置浏览器适配(设计规范)的页面场景。由 viewer-shots.mjs 引入。
// 内置浏览器没有办法在自动化里真的打开:这里把 navigator.userAgent 换成微信 / QQ 的 UA(页面里所有判断读的都是它),
// 所以验证的是「页面读到这样的 UA 时行为对不对」。iOS 微信的下载拦截、右上角菜单、长按保存图片只能在真机上看。
import { SHARE_STORY, smallTargets } from './share-scenarios.mjs'
import { FAKE_VISUAL_VIEWPORT } from './device-scenarios.mjs'

export const WECHAT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x18002831) NetType/WIFI Language/zh_CN'
export const QQ_UA = 'Mozilla/5.0 (Linux; Android 12; V2118A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.72 MQQBrowser/6.2 TBS/046011 Mobile Safari/537.36 V1_AND_SQ_8.9.28_4210_YYB_D QQ/8.9.28.12345 NetType/WIFI'

/** 在页面脚本之前把 UA 换掉(Playwright 的 userAgent 上下文选项只改请求头,页面里的 navigator.userAgent 在 WebKit 下不一定跟着变) */
const withUserAgent = (ua, extra = '') => `Object.defineProperty(navigator, 'userAgent', { get: () => ${JSON.stringify(ua)}, configurable: true });${extra}`

const rect = (tab, selector) =>
  tab.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }, selector)

async function touchIssues(tab, selector, label) {
  if (!(await tab.evaluate(() => matchMedia('(pointer: coarse)').matches))) return []
  return (await smallTargets(tab, selector)).map((item) => `${label}触屏可点区域不足 44px:${item}`)
}

/** 记下页面触发的下载:点之前先挂上监听 */
function watchDownloads(tab) {
  const seen = []
  tab.on('download', (download) => seen.push(download.suggestedFilename()))
  return seen
}

export const INAPP_SCENARIOS = {
  'inapp-share-wechat': {
    // 微信里打开公开分享页(文件链接):顶上说一次怎么下载(带「复制链接」);下载按钮旁不重复;安全区四边都让出;
    // 键盘占用能量出来(iOS 微信里布局视口不随键盘缩);页面层没有关掉图片的长按菜单
    route: '/s/tokGuide',
    ready: '[data-testid=shared-doc-title]',
    fixture: SHARE_STORY,
    init: withUserAgent(WECHAT_UA, FAKE_VISUAL_VIEWPORT),
    settle: 600,
    assert: async (tab, size) => {
      const issues = []
      const note = tab.locator('[data-testid=public-inapp]')
      if ((await note.count()) !== 1) return [`应有且只有一条下载提示,实际 ${await note.count()}`]
      const text = await note.innerText()
      if (!text.includes('在微信里不能直接下载文件')) issues.push(`提示应点名微信:${text.slice(0, 40)}`)
      if (!text.includes('点右上角「⋯」→「在浏览器中打开」,即可下载')) issues.push(`提示应写明怎么办:${text.slice(0, 80)}`)
      if ((await tab.locator('.kb-inapp').count()) !== 1) issues.push('下载提示不该在按钮旁又出现一遍')
      if (!(await note.getByRole('button', { name: '复制链接' }).count())) issues.push('提示里应有「复制链接」')
      // 提示在下载按钮的上面,二者同屏
      const noteBox = await rect(tab, '[data-testid=public-inapp]')
      const button = await rect(tab, '[data-testid=shared-doc-download]')
      if (!button) issues.push('文件链接应有「下载原件」按钮')
      else {
        if (noteBox.bottom > button.top + 1) issues.push(`提示应在下载按钮上方:提示下缘 ${Math.round(noteBox.bottom)},按钮上缘 ${Math.round(button.top)}`)
        if (button.top - noteBox.bottom > 400) issues.push('提示离下载按钮太远')
        if (button.right > size.width + 1 || button.left < -1) issues.push('下载按钮超出屏幕')
      }
      // 复制链接:点一下有反馈(复制的是当前页面地址)
      await note.getByRole('button', { name: '复制链接' }).click()
      await tab.waitForSelector('.kb-inapp .kb-copy.is-ok, .kb-inapp .kb-copy.is-fail', { timeout: 3000 }).catch(() => issues.push('点「复制链接」没有反馈'))
      if (await tab.locator('.kb-inapp .kb-copy.is-fail').count()) issues.push('「复制链接」失败了')
      issues.push(...(await touchIssues(tab, '.kb-inapp button, .kb-pub-top a, [data-testid=shared-doc-download]', '公开页')))

      // 安全区:顶 44、底 34、左右 47(横屏刘海机),顶栏和正文都要让开
      await tab.addStyleTag({ content: ':root{--safe-top:44px!important;--safe-right:47px!important;--safe-bottom:34px!important;--safe-left:47px!important}' })
      await tab.waitForTimeout(150)
      const top = await rect(tab, '.kb-pub-top')
      const main = await rect(tab, '.kb-pub-main')
      if (top.top < 43.5) issues.push(`顶栏应让开刘海(top ≥ 44),实际 ${Math.round(top.top)}`)
      if (top.left < 46.5 || top.right > size.width - 46.5) issues.push(`顶栏左右应让开 47px 的安全区:${Math.round(top.left)}–${Math.round(top.right)} / ${size.width}`)
      if (main.left < 46.5 || main.right > size.width - 46.5) issues.push(`正文左右应让开 47px 的安全区:${Math.round(main.left)}–${Math.round(main.right)} / ${size.width}`)
      const bottomPad = await tab.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.kb-pub')).paddingBottom))
      if (bottomPad < 33.5) issues.push(`页面底部应让开底部横条(≥34),实际 ${bottomPad}`)

      // 软键盘:评论框聚焦、键盘升起后,输入框在键盘上沿以上;--kbd-inset 量得出来
      const input = tab.locator('[data-testid=comment-input]')
      if (await input.count()) {
        await input.scrollIntoViewIfNeeded()
        await input.focus()
        const KB = Math.round(size.height * 0.4)
        await tab.evaluate((height) => window.__keyboard(height), KB)
        await tab.waitForTimeout(300)
        const state = await tab.evaluate(() => ({ kbd: document.documentElement.dataset.kbd, inset: document.documentElement.style.getPropertyValue('--kbd-inset') }))
        if (state.kbd !== 'open') issues.push(`键盘打开后 data-kbd 应是 open,实际 ${state.kbd}(公开页要自己量键盘占用)`)
        if (state.inset !== `${KB}px`) issues.push(`--kbd-inset 应是 ${KB}px,实际 ${state.inset}`)
        const box = await input.boundingBox()
        if (box && box.y + box.height > size.height - KB + 1) issues.push(`评论框被键盘挡住:下缘 ${Math.round(box.y + box.height)} > 键盘上沿 ${size.height - KB}`)
        await input.blur()
        await tab.evaluate(() => window.__keyboard(0))
      } else issues.push('评论者链接应有评论输入框(用来验证键盘)')

      // 长按保存图片:页面层没有给图片加 -webkit-touch-callout:none / pointer-events:none
      const image = await tab.evaluate(() => {
        const img = document.createElement('img')
        img.alt = '探针'
        img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
        document.querySelector('.kb-pub-main').appendChild(img)
        const style = getComputedStyle(img)
        const out = { callout: style.getPropertyValue('-webkit-touch-callout') || 'default', events: style.pointerEvents }
        img.remove()
        return out
      })
      if (image.callout === 'none') issues.push('页面层不该关掉图片的长按菜单(-webkit-touch-callout:none)')
      if (image.events === 'none') issues.push('页面层不该让图片 pointer-events:none(长按保存会失效)')
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      if (overflow > 1) issues.push(`整页横向溢出 ${overflow}px`)
      return issues
    },
  },

  'inapp-share-qq': {
    // QQ 里同样提示,点名的是 QQ;不能下载的链接(所有者关了下载)没有这条提示
    route: '/s/tokGuide',
    ready: '[data-testid=shared-doc-title]',
    fixture: SHARE_STORY,
    init: withUserAgent(QQ_UA),
    sizes: ['390x844', '820x1180'],
    settle: 500,
    assert: async (tab) => {
      const issues = []
      const text = await tab.locator('[data-testid=public-inapp]').innerText().catch(() => '')
      if (!text.includes('在QQ里不能直接下载文件')) issues.push(`QQ 里应点名 QQ:${text.slice(0, 40)}`)
      if (!text.includes('在浏览器中打开')) issues.push('应写明「在浏览器中打开」')
      // 换到不允许下载的链接:不提示
      await tab.goto(new URL('/s/tokNoDl', tab.url()).toString(), { waitUntil: 'networkidle' })
      await tab.waitForSelector('[data-testid=shared-doc-title]')
      if (await tab.locator('[data-testid=public-inapp], .kb-inapp').count()) issues.push('关了下载的链接不该提示下载')
      return issues
    },
  },

  'inapp-share-browser': {
    // 对照:普通浏览器里没有这条提示,下载按钮照常是链接
    route: '/s/tokGuide',
    ready: '[data-testid=shared-doc-title]',
    fixture: SHARE_STORY,
    sizes: ['390x844', '1440x900'],
    settle: 500,
    assert: async (tab) => {
      const issues = []
      if (await tab.locator('[data-testid=public-inapp], .kb-inapp').count()) issues.push('普通浏览器里不该有内置浏览器的提示')
      const href = await tab.locator('[data-testid=shared-doc-download]').getAttribute('href')
      // 下载按钮走流式下载地址(ShareAccess.downloadUrl,带 Content-Disposition,链接也能直接存盘),指向的是这份原件:同一个集合、同一个路径
      if (!/\/share\/tokGuide\/download\?/.test(href ?? '') || !href.includes('path=guide.md')) issues.push(`下载按钮应指向这份原件的下载地址,实际 ${href}`)
      return issues
    },
  },

  'inapp-download-kb': {
    // 知识库页(登录后)在微信里点「下载」:不是没反应,而是弹出说明(含复制链接),并留一个「仍然尝试下载」;更多菜单里的「下载原件」同样
    route: '/kb?collection=knowledgeBase%2Finsights&item=file_pdf',
    ready: '[data-testid=file-download]',
    init: withUserAgent(WECHAT_UA),
    settle: 800,
    assert: async (tab, size) => {
      const issues = []
      const downloads = watchDownloads(tab)
      const link = tab.locator('[data-testid=file-download]')
      if (!(await link.getAttribute('aria-label')) && size.width < 600) issues.push('手机上「下载」只剩图标,要有 aria-label')
      await link.click()
      const opened = await tab.waitForSelector('[role=dialog]', { timeout: 4000 }).then(() => true).catch(() => false)
      if (!opened) return [...issues, '微信里点「下载」应弹出说明']
      await tab.waitForTimeout(500)
      const dialog = await tab.locator('[role=dialog]').innerText().catch(() => '')
      for (const word of ['请在浏览器中打开', '在微信里不能直接下载文件', '在浏览器中打开', '复制链接', '仍然尝试下载', '知道了']) if (!dialog.includes(word)) issues.push(`说明里缺「${word}」`)
      if (downloads.length) issues.push(`弹出说明时不该同时触发下载:${downloads}`)
      const box = await tab.locator('[role=dialog]').boundingBox()
      if (box && (box.x < -1 || box.x + box.width > size.width + 1 || box.y + box.height > size.height + 1)) issues.push(`说明弹层超出屏幕:${JSON.stringify(box)}`)
      issues.push(...(await touchIssues(tab, '[role=dialog] button, [role=dialog] a', '说明弹层')))
      // 「仍然尝试下载」:关弹层并真的发起下载
      await tab.locator('[data-testid=inapp-try-download]').click()
      await tab.waitForTimeout(1200)
      if (await tab.locator('[role=dialog]').count()) issues.push('点「仍然尝试下载」后弹层应关闭')
      if (!downloads.length) issues.push('「仍然尝试下载」应发起下载')
      // 更多菜单里的「下载原件」也走说明
      await tab.getByRole('button', { name: '更多操作' }).click()
      await tab.getByRole('menuitem', { name: '下载原件' }).click()
      await tab.waitForSelector('[role=dialog]', { timeout: 4000 }).catch(() => issues.push('「更多 → 下载原件」在微信里也应弹出说明'))
      await tab.getByRole('button', { name: '知道了' }).click()
      await tab.waitForSelector('[role=dialog]', { state: 'detached', timeout: 3000 }).catch(() => issues.push('点「知道了」应关闭'))
      return issues
    },
  },

  'inapp-download-dialog': {
    // 只为截图和版面:微信里点「下载」后的说明(手机是贴底弹层,平板 / 电脑是居中对话框),在屏内、按钮够大
    route: '/kb?collection=knowledgeBase%2Finsights&item=file_pdf',
    ready: '[data-testid=file-download]',
    init: withUserAgent(WECHAT_UA),
    prepare: async (tab) => {
      await tab.locator('[data-testid=file-download]').click()
      await tab.waitForSelector('[role=dialog]')
    },
    sizes: ['390x844', '820x1180', '1440x900'],
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const box = await tab.locator('[role=dialog]').boundingBox()
      if (!box) return ['没有说明弹层']
      if (box.x < -1 || box.x + box.width > size.width + 1 || box.y < -1 || box.y + box.height > size.height + 1) issues.push(`说明弹层超出屏幕:${JSON.stringify(box)}`)
      if (size.width < 600 && Math.abs(box.y + box.height - size.height) > 2) issues.push(`手机上应是贴底的弹层,下缘 ${Math.round(box.y + box.height)} / ${size.height}`)
      issues.push(...(await touchIssues(tab, '[role=dialog] button, [role=dialog] a', '说明弹层')))
      return issues
    },
  },

  'inapp-download-kb-browser': {
    // 对照:普通浏览器里点「下载」直接下载,不弹说明
    route: '/kb?collection=knowledgeBase%2Finsights&item=file_pdf',
    ready: '[data-testid=file-download]',
    sizes: ['390x844', '1440x900'],
    settle: 800,
    assert: async (tab) => {
      const issues = []
      const downloads = watchDownloads(tab)
      await tab.locator('[data-testid=file-download]').click()
      await tab.waitForTimeout(1200)
      if (await tab.locator('[role=dialog]').count()) issues.push('普通浏览器里点「下载」不该弹说明')
      if (!downloads.length) issues.push('普通浏览器里点「下载」应直接下载')
      return issues
    },
  },

  'inapp-login-wechat': {
    // 微信里的登录页照常能用:不拦截;用户名 / 密码的自动填充属性齐全;不自动聚焦(不一进来就弹键盘);
    // 密码对了进两步验证,验证码框是数字键盘 + one-time-code;触屏可点区域 ≥44
    route: '/login',
    ready: '.auth-box',
    fixture: { __login: () => ({ status: 200, body: { logged_in: false, totp_required: true, challenge: 'chal-1' } }) },
    init: withUserAgent(WECHAT_UA),
    settle: 500,
    assert: async (tab, size) => {
      const issues = []
      const text = await tab.evaluate(() => document.body.innerText)
      if (text.includes('在浏览器中打开')) issues.push('登录页不该因为是微信就让人换浏览器')
      const attrs = await tab.evaluate(() => {
        const get = (selector) => {
          const el = document.querySelector(selector)
          return el ? { type: el.type, auto: el.getAttribute('autocomplete'), cap: el.getAttribute('autocapitalize'), focused: document.activeElement === el, size: parseFloat(getComputedStyle(el).fontSize) } : null
        }
        return { user: get('#login-user'), pass: get('#login-pass') }
      })
      if (attrs.user?.auto !== 'username') issues.push(`用户名框应是 autocomplete=username,实际 ${attrs.user?.auto}`)
      if (attrs.pass?.auto !== 'current-password') issues.push(`密码框应是 autocomplete=current-password,实际 ${attrs.pass?.auto}`)
      if (attrs.pass?.type !== 'password') issues.push(`密码框应是 password 类型,实际 ${attrs.pass?.type}`)
      if (attrs.user?.cap !== 'none') issues.push(`用户名框应 autocapitalize=none(不要把首字母大写),实际 ${attrs.user?.cap}`)
      if (attrs.user?.focused || attrs.pass?.focused) issues.push('登录页一打开不该自动聚焦输入框(会直接弹出键盘)')
      if (attrs.user && size.width < 600 && attrs.user.size < 16) issues.push(`输入框字号 ${attrs.user.size}px < 16px,iOS 聚焦会放大页面`)
      issues.push(...(await touchIssues(tab, '.auth-box button, .auth-box a, .auth-box input', '登录页')))
      // 密码对了 → 验证码
      await tab.locator('#login-user').fill('alice')
      await tab.locator('#login-pass').fill('Correct-Horse-9')
      await tab.locator('#login-pass').press('Enter')
      await tab.waitForSelector('[data-testid=login-totp]', { timeout: 5000 }).catch(() => issues.push('微信里密码对了应进入两步验证'))
      const otp = await tab.evaluate(() => {
        const input = document.querySelector('.kb-otp-input')
        return input ? { mode: input.getAttribute('inputmode'), auto: input.getAttribute('autocomplete') } : null
      })
      if (otp?.mode !== 'numeric') issues.push(`验证码框应弹数字键盘,实际 ${otp?.mode}`)
      if (otp?.auto !== 'one-time-code') issues.push(`验证码框应是 one-time-code,实际 ${otp?.auto}`)
      issues.push(...(await touchIssues(tab, '.auth-box button, .auth-box a', '两步验证')))
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      if (overflow > 1) issues.push(`整页横向溢出 ${overflow}px`)
      return issues
    },
  },
}
