#!/usr/bin/env node
// Word 在线编辑冷开的结构守卫（perf/docx-edit-cold）。
//
// 绝对耗时在 editor-samples-bench 里量（机器忙闲会让数字漂）；这里守的是**不随机器忙闲变化的结构**，
// 这些结构一旦退回去，冷开就会回到「一条串行线」（瀑布图见 src/editor/engines/docxWasm.ts 的说明）：
// 0. 打开 Word 只读预览时不预取引擎 / 字体（只允许悬停 / 点开「在线编辑」之后）；
//   1. 引擎 WASM 只下载一次，并且在「问编辑权 / 读原件字节」之前就开始（悬停 / 点击的同一刻，不等引擎 chunk）；
//   2. 画布先于无损检查出来：检查在编辑引擎就绪之后才开始，不挡首屏；
//   3. 检查期间引擎是只读的（敲字改不了文档），检查通过后才放开，之后能正常编辑；
//   4. 首屏前只下载「核心字体 + 文档用到的扩展包」：拉丁面的扩展包、用不到的汉字扩展包都不在首屏前下载；
//   5. 首屏之后字体补全（下载剩下的扩展包并重新登记），打字不会遇到缺字形。
//
// 用法（先 npm run build 或 KB_PRECOMPRESS=0 npx vite build）：node e2e/docx-cold-open.mjs
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { FILES, installFixture } from './fixture.mjs'
import { startStaticServer } from './serve.mjs'

const ROOT = resolve(import.meta.dirname, '..')
process.env.KB_SAMPLE_DOCX = join(ROOT, 'e2e', 'fixtures', 'editor', 'doc-20p.docx')
FILES.file_docx.item.origin = 'upload'
FILES.file_docx.preview.origin = 'upload'

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const { server, base } = await startStaticServer()
const browser = await chromium.launch({ chromiumSandbox: false })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' })
  await installFixture(context, { file_info: () => ({ sha256: 'sha-fixture-original', origin: 'upload', max_replace_bytes: 64 * 1024 * 1024 }) })
  // 无损检查的服务端比对慢 2 s：让「检查期间引擎是只读的」这一段能稳定地观察到，不依赖机器快慢
  await context.route('**/api/v1/files/roundtrip-check', async (route) => {
    await new Promise((done) => setTimeout(done, 2000))
    await route.fallback()
  })
  const started = Date.now()
  const log = []
  context.on('request', (request) => log.push({ t: Date.now() - started, url: request.url() }))
  const tab = await context.newPage()
  const problems = []
  tab.on('pageerror', (error) => problems.push(error.message))
  tab.on('console', (message) => {
    if (message.type() === 'error' && !/WebSocket|502/.test(message.text())) problems.push(message.text())
  })

  await tab.goto(`${base}/kb?collection=knowledgeBase%2Finsights&item=file_docx`, { waitUntil: 'commit' })
  await tab.waitForSelector('[data-testid="office-edit-open"]', { state: 'visible', timeout: 60_000 })
  await tab.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  // 只读预览不预取引擎（只允许悬停 / 点开「在线编辑」之后）：预览阶段没有任何 WASM、Word 字体请求
  const previewHeavy = log.filter((entry) => /\.wasm$|\/(?:latin|cjk)-[\w-]+\.ttf$/.test(new URL(entry.url).pathname)).map((entry) => new URL(entry.url).pathname.split('/').pop())
  check(previewHeavy.length === 0, '打开 Word 只读预览时不预取引擎 / 字体', previewHeavy.join(','))
  log.length = 0
  await tab.click('[data-testid="office-edit-open"]')
  await tab.waitForFunction(() => !!document.querySelector('.kb-office-host .kb-dex canvas') && !document.querySelector('[data-testid="office-veil"]'), null, { timeout: 120_000, polling: 'raf' })
  const readyAt = Date.now() - started
  const fontsAtReady = await tab.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((entry) => /\.ttf(?:\?|$)/.test(entry.name) && entry.responseEnd > 0)
      .map((entry) => ({ name: new URL(entry.name).pathname.split('/').pop(), bytes: entry.encodedBodySize })),
  )
  const checkingAtReady = await tab.locator('[data-testid="office-checking"]').count()
  // 检查期间引擎只读：往画布里敲字，不能出现「有未保存的改动」
  const page1 = await tab.evaluate(() => {
    const rect = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
    return { x: rect.x, y: rect.y }
  })
  await tab.mouse.click(page1.x + 200, page1.y + 330)
  await tab.waitForTimeout(300)
  await tab.keyboard.type('Z')
  await tab.waitForTimeout(400)
  const dirtyWhileChecking = await tab.locator('[data-testid="office-dirty"]').count()

  // 1. WASM 只下一次，且早于编辑权 / 原件字节
  const wasm = log.filter((entry) => /docx_edit_bg-[\w-]+\.wasm$/.test(new URL(entry.url).pathname))
  check(wasm.length === 1, 'Word 引擎 WASM 只下载一次', `（${wasm.length} 次）`)
  const lock = log.find((entry) => entry.url.includes('/api/v1/files/lock'))
  const raw = log.find((entry) => entry.url.includes('/api/v1/raw'))
  check(!!wasm[0] && !!lock && wasm[0].t <= lock.t, 'WASM 下载在申请编辑权之前开始', `（WASM ${wasm[0]?.t} ms，编辑权 ${lock?.t} ms）`)
  check(!!wasm[0] && !!raw && wasm[0].t <= raw.t, 'WASM 下载在读原件字节之前开始', `（原件 ${raw?.t} ms）`)

  check(checkingAtReady === 1, '画布出来时无损检查还在后台进行（界面写着「正在检查」，没有遮罩）')

  // 3. 检查期间只读
  check(dirtyWhileChecking === 0, '检查期间敲字改不了文档（引擎只读）')
  await tab.waitForFunction(() => !document.querySelector('[data-testid="office-checking"]'), null, { timeout: 60_000 })
  check((await tab.locator('[data-testid="office-readonly"]').count()) === 0, '检查通过后放开编辑（不是只读）')
  // 2. 画布先于无损检查
  const roundtrip = log.find((entry) => entry.url.includes('/api/v1/files/roundtrip-check'))
  check(!!roundtrip && roundtrip.t >= readyAt, '无损检查在画布出来之后才开始（不挡首屏）', `（画布 ${readyAt} ms，检查请求 ${roundtrip?.t} ms）`)
  await tab.mouse.click(page1.x + 200, page1.y + 330)
  await tab.waitForTimeout(800)
  await tab.keyboard.type('Z')
  const dirty = await tab
    .waitForSelector('[data-testid="office-dirty"]', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  check(dirty, '放开之后能正常编辑（敲字后出现「有未保存的改动」）')

  // 4. 首屏前的字体
  const names = fontsAtReady.map((font) => font.name)
  check(!names.some((name) => /^latin-.*-ext-[\w-]+\.ttf$/.test(name ?? '')), '首屏前没有下载拉丁字体的扩展包', names.filter((name) => /-ext-/.test(name ?? '')).join(','))
  const cjkExt = names.filter((name) => /^cjk-ext-\d+-[\w-]+\.ttf$/.test(name ?? ''))
  check(cjkExt.length > 0 && cjkExt.length < 9, '首屏前只下载文档用到的汉字扩展包（不是全部）', `（${cjkExt.length} 个）`)
  const firstBytes = fontsAtReady.reduce((sum, font) => sum + font.bytes, 0)
  check(firstBytes < 1_500_000, '首屏前字体传输 < 1.5 MB（补全前整套是 2.3 MB）', `（${(firstBytes / 1024).toFixed(0)} KB）`)

  // 5. 补全
  await tab.waitForFunction(
    () =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => /latin-carlito-regular-ext-[\w-]+\.ttf/.test(entry.name) && entry.responseEnd > 0).length > 0,
    null,
    { timeout: 30_000 },
  )
  check(true, '放开编辑后字体补全：拉丁扩展包已下载')
  check(problems.length === 0, '没有页面错误 / 控制台错误', problems.slice(0, 2).join(' | '))
} finally {
  await browser.close()
  server.close()
}
if (failures.length) {
  console.error(`\n✗ ${failures.length} 项失败`)
  process.exit(1)
}
console.log('\n✓ Word 冷开结构守卫全部通过')
