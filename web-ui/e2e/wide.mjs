import { chromium } from '@playwright/test'
import { installFixture } from './fixture.mjs'
const BASE = process.env.BASE
const browser = await chromium.launch({ chromiumSandbox: false })
for (const path of ['/browser', '/search']) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  await installFixture(context)
  const page = await context.newPage()
  await page.goto(`${BASE}${path}`, { waitUntil: 'load' })
  await page.waitForTimeout(900)
  const worst = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect()
      if (rect.right > window.innerWidth + 1) out.push({ tag: el.tagName.toLowerCase(), cls: el.className?.toString().slice(0, 40), right: Math.round(rect.right), width: Math.round(rect.width) })
    }
    return out.sort((a, b) => b.right - a.right).slice(0, 5)
  })
  console.log(path, JSON.stringify(worst))
  await context.close()
}
await browser.close()
