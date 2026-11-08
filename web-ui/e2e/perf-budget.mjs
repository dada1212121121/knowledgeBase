// 性能预算检查(计划 15.7:主包 gzip ≤ 250 KB;4G + 中端手机首屏可交互 < 2.5 秒)。
//
//   1) 体积:读 dist/index.html 里首屏会加载的脚本 / 样式,逐个 gzip(-9)求和,超过预算就失败;
//   2) 首屏:Chromium 里模拟手机(390×844)、4× CPU 降速、4G 网络(9 Mbps / 70 ms 往返),
//      打开登录页,量"登录表单可见并可输入"的时间,超过 2.5 秒就失败;再量一档慢速网络只做参考。
//
// 用法:先 `npm run build`,再 `node e2e/perf-budget.mjs`。环境变量 KB_PERF_RUNS(默认 3)取中位数。
// 注意:机器上同时在跑编译 / 别的浏览器时时间会偏大,要量准请在空闲时跑。
import { readFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { startStaticServer } from './serve.mjs'
import { installFixture, NOW } from './fixture.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const SIZE_BUDGET = 250 * 1024
const TIME_BUDGET_MS = 2500
const RUNS = Number(process.env.KB_PERF_RUNS ?? 3)

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('没有 dist/index.html:先 npm run build')
  process.exit(2)
}

// ---- 1. 体积 ----
const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((match) => match[1])
let total = 0
console.log('首屏会加载的资源(gzip -9):')
for (const url of new Set(assets)) {
  const bytes = gzipSync(readFileSync(join(DIST, url)), { level: 9 }).length
  total += bytes
  console.log(`  ${(bytes / 1024).toFixed(1).padStart(7)} KB  ${url}`)
}
const sizeOk = total <= SIZE_BUDGET
console.log(`${sizeOk ? '✓' : '✗'} 合计 ${(total / 1024).toFixed(1)} KB(预算 ${SIZE_BUDGET / 1024} KB)`)

// ---- 2. 首屏时间 ----
// 两档网络,CPU 都按 4× 降速(中端手机):
//   4G(9 Mbps、往返 70 ms):计划里的预算,超了就失败;
//   慢速(1.6 Mbps、往返 150 ms,Lighthouse 的"移动端"档):只报告,让人知道最差情况大概多久。
const PROFILES = [
  { name: '4G', downMbps: 9, latency: 70, gate: true },
  { name: '慢速 4G / 快速 3G', downMbps: 1.6, latency: 150, gate: false },
]
const { server, base } = await startStaticServer()
const browser = await chromium.launch({ chromiumSandbox: false })
let timeOk = true
for (const profile of PROFILES) {
  const times = []
  for (let run = 0; run < RUNS; run += 1) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      serviceWorkers: 'block',
    })
    await installFixture(context)
    const tab = await context.newPage()
    await tab.clock.install({ time: NOW })
    const client = await context.newCDPSession(tab)
    await client.send('Network.enable')
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: profile.latency,
      downloadThroughput: (profile.downMbps * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    })
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    const started = Date.now()
    await tab.goto(`${base}/login`, { waitUntil: 'commit' })
    await tab.waitForSelector('#login-pass', { state: 'visible', timeout: 30_000 })
    times.push(Date.now() - started)
    await context.close()
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]
  const ok = median <= TIME_BUDGET_MS
  if (profile.gate && !ok) timeOk = false
  const mark = profile.gate ? (ok ? '✓' : '✗') : 'ℹ'
  console.log(`${mark} 登录页可输入用时 · ${profile.name}(4× CPU 降速):中位数 ${median} ms(${times.join(' / ')})${profile.gate ? `,预算 ${TIME_BUDGET_MS} ms` : ',仅供参考'}`)
}
await browser.close()
server.close()

process.exit(sizeOk && timeOk ? 0 : 1)
