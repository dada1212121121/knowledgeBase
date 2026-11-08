#!/usr/bin/env node
/**
 * XLSX 只读网格性能门禁
 *
 * 夹具在本地按固定种子生成，避免把 5 MB 二进制提交进仓库；形状固定为
 * 500 行 × 100 列（5 万格），长随机文本让 zip 压不动、文件稳定落在 5 MB 以上。
 * 门禁测的是真实浏览器：同源 Worker + WASM + display list + canvas。
 *
 * 用法：
 *   npm run build && node e2e/editor-xlsx-bench.mjs
 *   KB_XLSX_BENCH_KEEP=1 node e2e/editor-xlsx-bench.mjs   # 保留夹具便于手工看
 */
import { execFileSync } from 'node:child_process'
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as XLSX from '@e965/xlsx'
import { contextOptions, launch } from './devices.mjs'
import { installFixture } from './fixture.mjs'
import { SOLO_EDIT_FIXTURE } from './editor-helpers.mjs'
import { startStaticServer } from './serve.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const COLLECTION = 'knowledgeBase%2Finsights'
const BENCH = join(ROOT, 'e2e', '.xlsx-bench.xlsx')
const TARGET_BYTES = 5 * 1024 * 1024
const OPEN_LIMIT_MS = 2000
const FPS_FLOOR = 55
const MEMORY_LIMIT_MB = 400

/** 固定种子生成 5 万格；60 字符随机串让 zip 约 5.0 MB，刚好覆盖验收上限 */
function makeWorkbook() {
  let seed = 0x5eed1234
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed
  }
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789中文检索向量排序'
  const text = () => {
    let out = ''
    for (let i = 0; i < 70; i += 1) out += chars[rnd() % chars.length]
    return out
  }
  const rows = []
  for (let r = 0; r < 500; r += 1) {
    const row = []
    for (let c = 0; c < 100; c += 1) {
      // 首行给可检索的表头，其余用长文本，既压不动又能验证字符串/数字单位换算
      row.push(r === 0 ? `列${c + 1}` : c % 10 === 0 ? r * 100 + c : text())
    }
    rows.push(row)
  }
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [XLSX.utils.decode_range('A1:E1')]
  ws['!cols'] = Array.from({ length: 100 }, (_, index) => ({ wch: index < 5 ? 18 : 26 }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '压测')
  const note = XLSX.utils.aoa_to_sheet([['XLSX 原生只读网格压测'], ['50,000 格 / 500 行 × 100 列']])
  XLSX.utils.book_append_sheet(wb, note, '说明')
  writeFileSync(BENCH, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
  return statSync(BENCH).size
}

/** 当前进程快照：性能门禁开始前记下，之后只统计新出现的 Chromium 进程 */
function processBaseline() {
  const pids = new Set()
  for (const row of execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n')) {
    const match = row.trim().match(/^(\d+)\s/)
    if (match) pids.add(match[1])
  }
  return pids
}

/** Chromium 进程 RSS 汇总（含 renderer / GPU / utility），比只看 JS heap 更接近任务管理器 */
function browserRssMb(baseline) {
  const pids = new Set()
  let kb = 0
  for (const row of execFileSync('ps', ['-eo', 'pid,rss,args'], { encoding: 'utf8' }).split('\n')) {
    if (!/chrome|headless_shell/i.test(row)) continue
    const match = row.trim().match(/^(\d+)\s+(\d+)\s/)
    if (!match || baseline.has(match[1]) || pids.has(match[1])) continue
    pids.add(match[1])
    kb += Number(match[2])
  }
  return { mb: Math.round(kb / 1024), processes: pids.size }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  return false
}

async function openXlsx(tab, base) {
  const started = performance.now()
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_xlsx`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="grid"] .kb-xg .kb-xg-canvas', { timeout: 30_000 })
  await tab.waitForFunction(() => (document.querySelector('.kb-xg-cellname')?.textContent ?? '').trim() === 'A1', null, { timeout: 10_000 })
  return performance.now() - started
}

async function main() {
  const size = makeWorkbook()
  if (size < TARGET_BYTES) {
    console.error(`✗ 夹具只有 ${(size / 1048576).toFixed(2)} MB，未达到 5 MB 门禁形状`)
    process.exit(1)
  }
  process.env.KB_SAMPLE_XLSX = BENCH
  const { server, base } = await startStaticServer()
  const baseline = processBaseline()
  const browser = await launch('chromium')
  const context = await browser.newContext(contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, 'chromium', { locale: 'zh-CN' }))
  await installFixture(context, SOLO_EDIT_FIXTURE)
  const tab = await context.newPage()
  await tab.goto('about:blank')
  const blankMemory = browserRssMb(baseline)
  const issues = []
  tab.on('pageerror', (error) => issues.push(`页面异常：${error.message}`))
  const resources = []
  tab.on('request', (request) => {
    if (/\.(?:js|css)(?:\?|$)/.test(request.url())) resources.push(request.url())
  })
  try {
    // 预热：第一次要下载 WASM + 初始化 Worker；验收说「热开」，所以先开一次再计时
    await openXlsx(tab, base)

    const opens = []
    for (let i = 0; i < 3; i += 1) opens.push(await openXlsx(tab, base))
    const openMs = Math.round(median(opens))

    const frames = await tab.evaluate(
      () =>
        new Promise((done) => {
          const scroller = document.querySelector('.kb-xg-scroll')
          if (!scroller) return done({ frames: 0, ms: 0 })
          const stamps = []
          const started = performance.now()
          const tick = (now) => {
            stamps.push(now)
            scroller.scrollTop += 36
            if (now - started < 2000) requestAnimationFrame(tick)
            else done({ frames: stamps.length, ms: now - started })
          }
          requestAnimationFrame(tick)
        }),
    )
    const fps = frames.ms > 0 ? (frames.frames / frames.ms) * 1000 : 0
    const memory = browserRssMb(baseline)
    const memoryDelta = memory.mb - blankMemory.mb

    const react = resources.filter((url) => /(?:xlsx-react|react-dom|\/react[-.])/i.test(url))
    if (openMs > OPEN_LIMIT_MS) issues.push(`热开 ${openMs} ms > ${OPEN_LIMIT_MS} ms`)
    if (fps < FPS_FLOOR) issues.push(`滚动 ${fps.toFixed(1)} fps < ${FPS_FLOOR}`)
    if (memoryDelta > MEMORY_LIMIT_MB) issues.push(`内存增量 ${memoryDelta} MB > ${MEMORY_LIMIT_MB} MB`)
    if (react.length) issues.push(`只读路径加载了 React：${react.map((url) => url.split('/').pop()).join(', ')}`)

    const sizeMb = (size / 1048576).toFixed(2)
    console.log(`fixture: ${sizeMb} MB / 50,000 格`)
    console.log(`open: ${opens.map((value) => Math.round(value)).join(' / ')} ms → median ${openMs} ms (limit ${OPEN_LIMIT_MS})`)
    console.log(`scroll: ${fps.toFixed(1)} fps / ${frames.frames} frames (floor ${FPS_FLOOR})`)
    console.log(`memory: ${blankMemory.mb} → ${memory.mb} MB → +${memoryDelta} MB / ${memory.processes} processes (limit ${MEMORY_LIMIT_MB})`)
    if (issues.length) {
      console.log(`\n${issues.length} 项未通过\n  ${issues.join('\n  ')}`)
      process.exitCode = 1
    } else {
      console.log('\n✓ xlsx 只读阶段门禁全部通过')
    }
  } finally {
    await browser.close()
    server.close()
    if (!process.env.KB_XLSX_BENCH_KEEP && existsSync(BENCH)) unlinkSync(BENCH)
  }
}

void main()
