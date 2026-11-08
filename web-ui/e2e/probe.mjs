import { chromium } from '@playwright/test'
import { installFixture } from './fixture.mjs'
const browser = await chromium.launch({ chromiumSandbox: false })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await installFixture(page.context())
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 120)) })
await page.goto('http://127.0.0.1:20663/dashboard', { waitUntil: 'load' })
await page.waitForTimeout(1200)
console.log('url', page.url())
console.log('side count', await page.locator('.side').count())
console.log('body', (await page.locator('body').innerText()).slice(0, 120).replace(/\n/g, ' | '))
await browser.close()
