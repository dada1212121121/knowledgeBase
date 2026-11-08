#!/usr/bin/env node
// 表格内核性能闸门（设计规范）。
//
// 只量用户能感知的三件事：
//   1. 5 万格合成表（10,000 行 × 5 列）滚动帧率；
//   2. 5 MB CSV 热打开耗时（第二次进入，静态资源已在缓存）；
//   3. 单元格输入处理耗时 + 390×844 手机视口不横向溢出。
//
// 用法（先 npm run build）：
//   node e2e/editor-grid-bench.mjs
//   KB_GRID_KEEP=1 node e2e/editor-grid-bench.mjs   # 留窗口肉眼看一下
import { chromium } from '@playwright/test'
import { FILES, installFixture } from './fixture.mjs'
import { SOLO_EDIT_FIXTURE } from './editor-helpers.mjs'
import { startStaticServer } from './serve.mjs'

const COLLECTION = 'knowledgeBase%2Finsights'
const ROUTE = (id) => `/kb?collection=${COLLECTION}&item=${id}`

/** 生成 CSV 文本；列数固定 5，便于和「5 万格」对齐 */
function makeCsv(rows, width = 5) {
  const cols = ['编号', '名称', '数量', '耗时', '备注']
  const out = [cols.join(',')]
  for (let row = 1; row <= rows; row += 1) {
    const cells = [String(row), `项目-${row % 997}`, String(row % 7), String(40 + (row % 90)), `备注-${row % 31}${'x'.repeat(12)}`]
    out.push(cells.slice(0, width).join(','))
  }
  return out.join('\n')
}

const small = makeCsv(10_000)
const large = makeCsv(150_000)
FILES.file_csv.preview.content = small

const issues = []
const { server, base } = await startStaticServer()
const browser = await chromium.launch({ headless: !process.env.KB_GRID_KEEP })

async function openGrid(tab) {
  await tab.goto(base + ROUTE('file_csv'), { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('.kb-fv', { timeout: 20_000 })
  await tab.click('[data-testid="csv-edit-open"]')
  await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="grid"] .kb-gs canvas', { timeout: 20_000 })
  // 等两帧，确保首屏 canvas 已经画完
  await tab.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function closeGrid(tab) {
  const cancel = tab.getByRole('button', { name: /^退出编辑$/ }).first()
  if (await cancel.count()) {
    await cancel.click()
    // 测过输入、表格有改动：页面会问要不要放弃（修好正文推送后才有这一步，以前改了也不提示）
    const discard = tab.getByRole('button', { name: '放弃修改' })
    if (await discard.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) await discard.click()
    await tab.waitForSelector('.kb-fv', { timeout: 10_000 })
  }
}

try {
  // ---------- 桌面：5 万格滚动 + 输入 ----------
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  await installFixture(desktop, SOLO_EDIT_FIXTURE)
  const tab = await desktop.newPage()
  const errors = []
  tab.on('pageerror', (error) => errors.push(error.message))
  await openGrid(tab)

  const scroll = await tab.evaluate(async () => {
    const el = document.querySelector('.kb-gs-scroll')
    if (!el) return null
    const deltas = []
    let last = performance.now()
    let frames = 0
    await new Promise((resolve) => {
      const step = (now) => {
        deltas.push(now - last)
        last = now
        el.scrollTop += 32
        frames += 1
        if (frames < 180) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
    const sorted = [...deltas].sort((a, b) => a - b)
    const avg = deltas.reduce((sum, d) => sum + d, 0) / deltas.length
    return { fps: 1000 / avg, p95: sorted[Math.floor(sorted.length * 0.95)], frames, scrolled: el.scrollTop, total: el.scrollHeight }
  })
  if (!scroll) issues.push('找不到网格滚动容器')
  else if (scroll.fps < 55) issues.push(`5 万格滚动只有 ${scroll.fps.toFixed(1)} fps（闸门 ≥55）`)
  if (scroll && scroll.total <= scroll.scrolled) issues.push('滚动没有走完大表（滚动高度不够）')

  // 输入：方向键移动 + F2 打开编辑 + Enter 提交；只量事件处理本身（不含浏览器合成帧）
  const input = await tab.evaluate(async () => {
    const grid = document.querySelector('.kb-gs')
    if (!grid) return null
    const t0 = performance.now()
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const t1 = performance.now()
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
    const t2 = performance.now()
    // 编辑框由 Vue 在 nextTick 后挂载，等一个宏任务再量提交
    await new Promise((resolve) => setTimeout(resolve, 0))
    const editor = document.querySelector('.kb-gs-editor')
    if (!editor) return { move: t1 - t0, open: t2 - t1, commit: null }
    editor.value = '改后'
    const t3 = performance.now()
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return { move: t1 - t0, open: t2 - t1, commit: performance.now() - t3 }
  })
  if (!input) issues.push('网格键盘输入没有响应')
  else {
    for (const [name, ms] of Object.entries(input)) {
      if (ms !== null && ms > 16) issues.push(`${name} 处理 ${ms.toFixed(2)} ms（闸门 <16 ms）`)
    }
  }

  await closeGrid(tab)

  // ---------- 桌面：5 MB 热打开 ----------
  // 先换夹具再重新进页面，让预览拿到新内容；第一次只用来暖静态资源，第二次才计时。
  FILES.file_csv.preview.content = large
  await openGrid(tab)
  await closeGrid(tab)
  const openSamples = []
  for (let run = 0; run < 3; run += 1) {
    openSamples.push(await tab.evaluate(async () => {
      const started = performance.now()
      document.querySelector('[data-testid="csv-edit-open"]')?.click()
      await new Promise((resolve) => {
        const check = () => {
          if (document.querySelector('[data-testid="editor-host"][data-surface-kind="grid"] .kb-gs-canvas')) resolve()
          else requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      })
      return performance.now() - started
    }))
    await closeGrid(tab)
  }
  openSamples.sort((a, b) => a - b)
  const openMs = openSamples[1]
  if (openMs > 800) issues.push(`5 MB CSV 热打开 ${openMs.toFixed(0)} ms（闸门 ≤800 ms；样本 ${openSamples.map((ms) => ms.toFixed(0)).join('/')}）`)
  if (errors.length) issues.push(`页面异常：${errors[0]}`)
  await desktop.close()

  // ---------- 手机：390×844 可用 ----------
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' })
  await installFixture(mobile, SOLO_EDIT_FIXTURE)
  const phone = await mobile.newPage()
  await openGrid(phone)
  const phoneInfo = await phone.evaluate(() => {
    const grid = document.querySelector('.kb-gs')
    const formula = document.querySelector('.kb-gs-formula')
    const box = grid?.getBoundingClientRect()
    return {
      width: box?.width ?? 0,
      height: box?.height ?? 0,
      formulaVisible: !!formula && formula.getBoundingClientRect().height > 0,
      bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    }
  })
  if (phoneInfo.width < 300 || phoneInfo.height < 300) issues.push(`390×844 下网格尺寸异常：${phoneInfo.width}×${phoneInfo.height}`)
  if (!phoneInfo.formulaVisible) issues.push('390×844 下公式栏不可见（软键盘会把它顶掉）')
  if (phoneInfo.bodyOverflow) issues.push('390×844 下页面横向溢出')
  await mobile.close()

  console.log(`5 万格滚动：${scroll ? `${scroll.fps.toFixed(1)} fps（p95 ${scroll.p95.toFixed(1)} ms，${scroll.frames} 帧）` : '未测到'}`)
  console.log(`输入处理：${input ? `移动 ${input.move.toFixed(2)} ms / 打开 ${input.open.toFixed(2)} ms / 提交 ${input.commit?.toFixed(2) ?? 'n/a'} ms` : '未测到'}`)
  console.log(`5 MB CSV 热打开：${openMs.toFixed(0)} ms（样本 ${openSamples.map((ms) => ms.toFixed(0)).join('/')}；${(large.length / 1024 / 1024).toFixed(2)} MB，${large.split('\n').length} 行）`)
  console.log(`390×844：${phoneInfo.width.toFixed(0)}×${phoneInfo.height.toFixed(0)}，公式栏${phoneInfo.formulaVisible ? '可见' : '不可见'}，横向溢出=${phoneInfo.bodyOverflow}`)
} finally {
  await browser.close()
  server.close()
}

if (issues.length) {
  console.log(`\n✗ ${issues.length} 项未通过\n  ${issues.join('\n  ')}`)
  process.exit(1)
}
console.log('\n✓ 表格性能闸门通过')
