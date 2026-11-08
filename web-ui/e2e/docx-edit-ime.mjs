#!/usr/bin/env node
/**
 * Word 在线编辑的输入门禁（新旧两条实现共用）
 *
 * 在 20 页样本的前两页上，用 CDP 的 Input.imeSetComposition / Input.insertText 模拟中文输入法，
 * 再用岛自带的「读取文档文本」无障碍面板读回内容核对。守住三件事，任何一件退化就说明升级上游引擎或改外壳时把输入弄坏了：
 *   1. 点击定位后，拼音组合（compositionstart → update × N → end）上屏的汉字一个不丢、不重复；
 *   2. Backspace、方向键、Shift 扩选后输入替换、Enter 拆段，结果与预期逐字一致；
 *   3. 输入过程中没有页面报错。
 *
 * 这条基线也是「要不要用 Vue 重写输入层」的参照：重写版必须在同一脚本上全绿。
 * 事件耗时（Event Timing，含输入延迟与下一帧呈现）只报告、不设阈值，共享机上受其它租户影响很大。
 *
 * 用法（先 npm run build）：node e2e/docx-edit-ime.mjs [--cpu=4]
 * 起旧的 React 编辑岛已删除，`--engine=legacy|native|default` 选项随之去掉：只剩 Vue 原生编辑面这一条路径
 * （`.kb-office-host` 里每页一个 canvas、`textarea.paged-editor__input` 承接输入、`.sr-only` 里的「读取文档文本」面板）。
 */
import { chromium } from '@playwright/test'
import { adminMe, ALL_FEATURES, FILES, installFixture } from './fixture.mjs'
import { startStaticServer } from './serve.mjs'
import { COLLECTION } from './editor-helpers.mjs'

const DOCX = new URL('./fixtures/editor/doc-20p.docx', import.meta.url).pathname
process.env.KB_SAMPLE_DOCX = DOCX
const CPU = Number(process.argv.find((a) => a.startsWith('--cpu='))?.split('=')[1] ?? '1')
const failures = []

function check(name, ok, detail = '') {
  if (ok) console.log(`✓ ${name}`)
  else {
    failures.push(`${name}${detail ? `：${detail}` : ''}`)
    console.log(`✗ ${name}${detail ? `：${detail}` : ''}`)
  }
}

// 只有上传来的 docx 才能在线编辑；这里把夹具文件标成上传
FILES.file_docx.item.origin = 'upload'
FILES.file_docx.preview.origin = 'upload'

const { server, base } = await startStaticServer()
const browser = await chromium.launch({ chromiumSandbox: false })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' })
  await installFixture(context, {
    // 不带协同：单人编辑路径
    __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => id !== 'collab.edit'), true) },
    file_info: () => ({ sha256: 'sha-fixture-original', origin: 'upload', max_replace_bytes: 64 * 1024 * 1024 }),
  })
  const tab = await context.newPage()
  const cdp = await context.newCDPSession(tab)
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
  const errors = []
  tab.on('pageerror', (e) => errors.push(e.message.slice(0, 160)))

  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_docx`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="office-edit-open"]', { state: 'visible', timeout: 90_000 })
  await tab.click('[data-testid="office-edit-open"]')
  await tab.waitForSelector('.kb-office-host canvas', { state: 'visible', timeout: 120_000 })
  while (await tab.locator('[data-testid="office-veil"]').count()) await tab.waitForTimeout(50)
  await tab.waitForTimeout(1500)

  const page1 = await tab.evaluate(() => {
    const r = document.querySelector('.kb-office-host canvas').getBoundingClientRect()
    return { x: r.x, y: r.y }
  })
  // 路径断言：确认挂的是 Vue 原生编辑面，而不是别的什么降级视图
  const nativeSurface = await tab.evaluate(() => document.querySelector('.kb-office-host .kb-dex[data-testid="docx-edit-view"]') !== null)
  check('确实走的是 Vue 原生编辑面（.kb-dex）', nativeSurface)
  check('编辑面里有隐藏的输入框（Document input）并持有焦点', await tab.evaluate(() => document.activeElement?.classList.contains('paged-editor__input') === true))

  // 事件序列与耗时
  await tab.evaluate(() => {
    window.__seq = []
    for (const t of ['compositionstart', 'compositionupdate', 'compositionend']) document.addEventListener(t, () => window.__seq.push(t), true)
    window.__ev = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (/^key(down|press)$/.test(e.name)) window.__ev.push(e.duration)
    }).observe({ type: 'event', durationThreshold: 16, buffered: true })
  })

  /** 读回文档段落：无障碍面板在视觉上被页面盖住，用脚本点开；每次先关再开，保证按最新版本重读 */
  const paragraphs = async () => {
    await tab.evaluate(() => {
      const button = document.querySelector('.kb-office-host .sr-only button[aria-expanded]')
      if (button.getAttribute('aria-expanded') === 'true') button.click()
    })
    await tab.waitForTimeout(150)
    await tab.evaluate(() => document.querySelector('.kb-office-host .sr-only button[aria-expanded]').click())
    await tab.waitForFunction(() => document.querySelectorAll('.kb-office-host section[aria-label] p').length > 0, null, { timeout: 8000 })
    await tab.waitForTimeout(400)
    return tab.evaluate(() => [...document.querySelectorAll('.kb-office-host section[aria-label] p')].map((p) => p.textContent ?? ''))
  }
  const compose = async (steps, commit) => {
    for (const text of steps) {
      await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
      await tab.waitForTimeout(40)
    }
    await cdp.send('Input.insertText', { text: commit })
    await tab.waitForTimeout(150)
  }

  const before = await paragraphs()
  // 点第一页正文第三段（「评测采用…」）的开头附近；点击位置按页面左上角偏移，文档版式固定
  await tab.mouse.click(page1.x + 160, page1.y + 330)
  await tab.waitForTimeout(500)
  const hitIndex = before.findIndex((t) => t.startsWith('评测采用'))
  check('样本文档里有「评测采用」段落', hitIndex >= 0)

  await compose(['n', 'ni', 'ni h', 'ni ha', 'ni hao'], '你好')
  await compose(['s', 'sh', 'shi', 'shi j', 'shi jie'], '世界')
  await tab.keyboard.type('ABC', { delay: 30 })
  await tab.waitForTimeout(400)
  let now = await paragraphs()
  const want1 = '评测采你好世界ABC用'
  check('点击定位后中文输入法上屏：你好世界 + ABC 一个不丢不重', now[hitIndex]?.startsWith(want1), now[hitIndex]?.slice(0, 20))
  const seq = await tab.evaluate(() => window.__seq)
  check('组合事件完整：2 次 start / end，update 不少于 10 次', seq.filter((s) => s === 'compositionstart').length === 2 && seq.filter((s) => s === 'compositionend').length === 2 && seq.filter((s) => s === 'compositionupdate').length >= 10, `${seq.length} 个事件`)

  // Backspace 删 C，←，Shift+← 扩选两个字符（界、A），输入 xy 替换选区
  await tab.keyboard.press('Backspace')
  await tab.keyboard.press('ArrowLeft')
  await tab.keyboard.press('Shift+ArrowLeft')
  await tab.keyboard.press('Shift+ArrowLeft')
  await tab.keyboard.type('xy')
  await tab.waitForTimeout(300)
  now = await paragraphs()
  check('Backspace / 方向键 / Shift 扩选后输入替换结果正确', now[hitIndex]?.startsWith('评测采你好世xyB用'), now[hitIndex]?.slice(0, 20))

  // Enter 拆段
  await tab.keyboard.press('Enter')
  await tab.keyboard.type('换行后', { delay: 20 })
  await tab.waitForTimeout(300)
  now = await paragraphs()
  // 面板每页只读 32 段，所以不比总段数，看拆开的两段内容
  check('Enter 把段落拆成两段，后半段带着光标后的字', now[hitIndex] === '评测采你好世xy' && now[hitIndex + 1]?.startsWith('换行后B用'), `${now[hitIndex]?.slice(0, 12)} | ${now[hitIndex + 1]?.slice(0, 12)}`)

  // 连续输入 60 个字符，只报告耗时
  await tab.evaluate(() => { window.__ev = [] })
  for (let i = 0; i < 60; i++) {
    await tab.keyboard.type(String.fromCharCode(97 + (i % 26)))
    await tab.waitForTimeout(25)
  }
  await tab.waitForTimeout(500)
  const durations = (await tab.evaluate(() => window.__ev)).sort((a, b) => a - b)
  console.log(`  · 键盘事件到下一帧：≥16ms 的 ${durations.length} 个，中位 ${durations[Math.floor(durations.length / 2)] ?? 0} ms，最大 ${durations.at(-1) ?? 0} ms（CPU 降速 ${CPU}×）`)
  now = await paragraphs()
  check('连续输入 60 个字符一个不丢', (now[hitIndex + 1] ?? '').startsWith('换行后abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefgh'), now[hitIndex + 1]?.slice(0, 20))
  check('输入过程没有页面报错', errors.length === 0, errors.join(' | '))
  await context.close()
} finally {
  await browser.close()
  server.close()
}

if (failures.length) {
  console.error(`\nWord 编辑输入门禁失败：\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log(`\n✓ Word 编辑输入门禁通过`)
