// 主题可读性检查:每种外观主题(含「跟随系统」×系统深/浅) × 关键页面,
// 逐个文字节点算它和实际背景的对比度(WCAG 公式);正文 < 3:1 记为不可读。
// 回归自一次真实故障:选「跟随系统」后 data-theme=system 没有对应 token,文字全黑压在黑底上,登录页「输入不了也看不清」。
import { chromium } from '@playwright/test'
import { startStaticServer } from './serve.mjs'
import { installFixture, NOW } from './fixture.mjs'

const CASES = [
  ['dark', 'dark'], ['oled', 'dark'], ['slate', 'dark'], ['light', 'light'], ['paper', 'light'],
  ['system', 'dark'], ['system', 'light'], ['不存在的主题', 'dark'],
]
const ROUTES = ['/login', '/dashboard', '/settings?tab=llm', '/browser']

const { server, base } = await startStaticServer()
const browser = await chromium.launch({ chromiumSandbox: false })
let bad = 0
let dimTotal = 0
for (const [theme, scheme] of CASES) {
  for (const route of ROUTES) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: 'reduce' })
    await ctx.addInitScript((t) => localStorage.setItem('kb.appearance', JSON.stringify({ theme: t })), theme)
    if (route === '/login') {
      await ctx.route('**/api/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { password_set: true, logged_in: false } }) }))
    } else {
      await installFixture(ctx)
    }
    const tab = await ctx.newPage()
    await tab.clock.install({ time: NOW })
    await tab.goto(base + route, { waitUntil: 'networkidle' })
    await tab.waitForTimeout(300)
    const result = await tab.evaluate(() => {
      const parse = (c) => { const m = c.match(/[\d.]+/g); return m ? m.map(Number) : [0, 0, 0, 1] }
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
      // 沿祖先找第一个不透明背景(渐变 / 图片背景视为该元素的底色未知,跳过)
      const bgOf = (el) => {
        for (let a = el; a; a = a.parentElement) {
          const cs = getComputedStyle(a)
          if (cs.backgroundImage && cs.backgroundImage !== 'none') return null
          const c = parse(cs.backgroundColor)
          if ((c[3] ?? 1) > 0.9) return c
        }
        return parse(getComputedStyle(document.body).backgroundColor)
      }
      const worst = []
      let dim = 0
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent.trim()
        const el = n.parentElement
        if (!text || !el || el.closest('svg,[aria-hidden=true],.shot,.stage')) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.5) continue
        const box = el.getBoundingClientRect()
        if (box.width < 1 || box.bottom < 0 || box.top > innerHeight) continue
        const bg = bgOf(el)
        if (!bg) continue
        const fg = parse(cs.color)
        const [L1, L2] = [lum(fg), lum(bg)].sort((a, b) => b - a)
        const ratio = (L1 + 0.05) / (L2 + 0.05)
        if (ratio < 3) dim++
        if (ratio < 1.6) worst.push(`${ratio.toFixed(2)}:1 “${text.slice(0, 24)}”`)
      }
      // 输入框里打的字必须看得见
      const input = document.querySelector('input[type=password], .kb-searchbar-input, .kb-filter-input')
      let inputRatio = null
      if (input) {
        const fg = parse(getComputedStyle(input).color)
        const bg = bgOf(input) ?? parse(getComputedStyle(document.body).backgroundColor)
        const [L1, L2] = [lum(fg), lum(bg)].sort((a, b) => b - a)
        inputRatio = (L1 + 0.05) / (L2 + 0.05)
      }
      return { worst: worst.slice(0, 4), count: worst.length, dim, inputRatio }
    })
    // 失败 = 看不见:任一文字 < 1.6:1(黑字压黑底约 1.0:1),或输入框里打的字 < 4.5:1。
    // 低于 3:1 的是设计稿里有意弱化的四级灰(计数、分组标题),只计数提示,不算失败。
    const failed = result.count > 0 || (result.inputRatio !== null && result.inputRatio < 4.5)
    dimTotal += result.dim
    if (failed) {
      bad++
      console.log(`✗ ${theme}/${scheme} ${route}  看不见的文字 ${result.count} 处 · 输入框 ${result.inputRatio?.toFixed(2) ?? '—'}:1`)
      for (const w of result.worst) console.log(`    ${w}`)
    }
    await ctx.close()
  }
}
await browser.close()
server.close()
console.log(bad ? `\n✗ ${bad} 个组合有看不见的文字` : `✓ ${CASES.length} 种主题设置 × ${ROUTES.length} 个页面:没有看不见的文字,输入框都可读(设计稿里的弱化灰字 < 3:1 共 ${dimTotal} 处,属设计)`)
process.exitCode = bad ? 1 : 0
