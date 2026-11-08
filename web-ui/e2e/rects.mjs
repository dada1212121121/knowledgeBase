// 取若干选择器在指定视口下的矩形与文字(排查布局用)。
// 用法:node e2e/rects.mjs <route> <WxH> <selector...>
import { chromium } from '@playwright/test'
import { startStaticServer } from './serve.mjs'
import { installFixture, NOW } from './fixture.mjs'

const [route, vp, ...sels] = process.argv.slice(2)
const [width, height] = vp.split('x').map(Number)
const { server, base } = await startStaticServer(process.env.KB_DAEMON_URL)
const browser = await chromium.launch({ chromiumSandbox: false })
const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' })
await installFixture(context)
const page = await context.newPage()
await page.clock.install({ time: NOW })
await page.goto(base + route, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
const out = await page.evaluate((sels) => {
  const res = []
  for (const sel of sels) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      res.push(`${sel} @${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} ov=${cs.overflowX}/${cs.overflowY} :: ${(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)}`)
    }
  }
  return res
}, sels)
console.log(out.join('\n'))
await browser.close()
server.close()
