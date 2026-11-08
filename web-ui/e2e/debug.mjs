// 调试用:node e2e/debug.mjs <route> —— 带 fixture 打开页面,打印控制台错误与页面文本
import { chromium } from '@playwright/test'
import { startStaticServer } from './serve.mjs'
import { installFixture, NOW } from './fixture.mjs'
const route = process.argv[2] ?? '/dashboard'
const { server, base } = await startStaticServer(process.env.KB_DAEMON_URL)
const browser = await chromium.launch({ chromiumSandbox: false })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' })
await installFixture(context)
const tab = await context.newPage()
await tab.clock.install({ time: NOW })
tab.on('pageerror', (err) => console.log('PAGEERROR', err.message))
tab.on('console', (msg) => msg.type() === 'error' && console.log('CONSOLE', msg.text()))
await tab.goto(`${base}${route}`, { waitUntil: 'networkidle' })
await tab.waitForTimeout(800)
if (process.env.KB_SHOT) await tab.screenshot({ path: process.env.KB_SHOT })
if (!process.env.KB_SHOT) console.log((await tab.locator('body').innerText()).slice(0, 3000))
if (process.env.KB_EVAL) console.log('EVAL', JSON.stringify(await tab.evaluate(process.env.KB_EVAL)))
await browser.close()
server.close()
