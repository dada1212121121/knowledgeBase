import { chromium } from '@playwright/test'
import { installFixture } from './fixture.mjs'
const BASE = process.env.BASE
const pages = ['/login', '/login?setup=1', '/dashboard', '/browser', '/search', '/jobs', '/audit', '/settings', '/settings/appearance', '/projects', '/eval', '/sources', '/review', '/agent', '/dashboard?palette=1']
const browser = await chromium.launch({ chromiumSandbox: false })
for (const path of pages) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  await installFixture(context)
  const page = await context.newPage()
  await page.goto(`${BASE}${path}`, { waitUntil: 'load' })
  await page.waitForTimeout(900)
  const info = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    bodyScroll: document.body.scrollWidth,
  }))
  console.log(`${path.padEnd(22)} scroll=${info.scrollWidth} inner=${info.innerWidth} body=${info.bodyScroll} ${info.scrollWidth > info.innerWidth ? '✗ 溢出' : '✓'}`)
  await context.close()
}
await browser.close()
