import { chromium } from '@playwright/test'
import { installFixture } from './fixture.mjs'
const browser = await chromium.launch({ chromiumSandbox: false })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await installFixture(context)
const page = await context.newPage()
await page.goto(`${process.env.BASE}/dashboard`, { waitUntil: 'load' })
await page.waitForTimeout(1200)
const info = await page.evaluate(() => {
  const aside = document.querySelector('.xaside')
  const rect = aside?.getBoundingClientRect()
  return { hasAside: !!aside, rect: rect ? [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] : null, heat: document.body.innerText.includes('进化热力') }
})
console.log(JSON.stringify(info))
await browser.close()
