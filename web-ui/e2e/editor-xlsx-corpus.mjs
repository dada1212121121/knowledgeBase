#!/usr/bin/env node
/**
 * 真实 XLSX 语料巡检
 *
 * 34 份文件来自 RELEASE_NOTES.md 记录的 office 兼容语料清单（本机路径，
 * 不进仓库）。每份都走同一条生产路径：fixture 详情页 → NativeSheetViewer →
 * EditorHost → xlsx 只读 Surface → 同源 Worker + WASM。
 * 起这是不带参数的默认预览，所以路由里没有任何 editor 参数：量的就是用户真实看到的那条路。
 *
 * 校验：页面无异常、网格出现、页签数量/顺序与 @e965/xlsx 独立解析一致；
 * 前 10 份落截图，便于人工和 Excel 对照。截图目录 e2e/shots/ 已 gitignore。
 *
 * 用法：
 *   npm run build && node e2e/editor-xlsx-corpus.mjs
 *   KB_XLSX_CORPUS=/path/to/list.txt node e2e/editor-xlsx-corpus.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import * as XLSX from '@e965/xlsx'
import { contextOptions, launch } from './devices.mjs'
import { installFixture } from './fixture.mjs'
import { SOLO_EDIT_FIXTURE } from './editor-helpers.mjs'
import { startStaticServer } from './serve.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const COLLECTION = 'knowledgeBase%2Finsights'
const DEFAULT_LIST = resolve(ROOT, '..', 'scratch', 'office-e2e', 'compat-files.txt')
const SHOT_DIR = join(ROOT, 'e2e', 'shots', 'xlsx-corpus')
const SHOT_LIMIT = 10

function readCorpus() {
  const list = process.env.KB_XLSX_CORPUS ?? DEFAULT_LIST
  if (!existsSync(list)) throw new Error(`找不到语料清单 ${list}；用 KB_XLSX_CORPUS 指定`)
  return readFileSync(list, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => existsSync(file))
}

/** 独立解析页签，避免只信渲染结果 */
function sheetNamesOf(file) {
  const workbook = XLSX.read(readFileSync(file), { type: 'buffer' })
  return workbook.SheetNames
}

async function openFile(tab, base) {
  const started = performance.now()
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_xlsx`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="grid"] .kb-xg .kb-xg-canvas', { timeout: 30_000 })
  await tab.waitForFunction(() => document.querySelectorAll('.kb-xg-tab').length > 0, null, { timeout: 10_000 })
  return Math.round(performance.now() - started)
}

async function main() {
  const files = readCorpus()
  const { server, base } = await startStaticServer()
  const browser = await launch('chromium')
  const context = await browser.newContext(contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, 'chromium', { locale: 'zh-CN' }))
  await installFixture(context, SOLO_EDIT_FIXTURE)
  mkdirSync(SHOT_DIR, { recursive: true })

  // fixture 的下载 URL 对同一个 mock 条目是固定的；用 route 直接回当前文件，避免浏览器缓存串档
  let current = files[0]
  await context.route('**/api/v1/download**', (route) =>
    route.fulfill({
      status: 200,
      path: current,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  )

  const tab = await context.newPage()
  const failures = []
  let pageErrors = []
  tab.on('pageerror', (error) => pageErrors.push(error.message))
  const rows = []
  try {
    for (const [index, file] of files.entries()) {
      current = file
      pageErrors = []
      const expected = sheetNamesOf(file)
      try {
        const openMs = await openFile(tab, base)
        const actual = await tab.$$eval('.kb-xg-tab', (nodes) => nodes.map((node) => (node.textContent ?? '').trim()))
        const cell = (await tab.inputValue('.kb-xg-formula-input')).trim()
        if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) {
          throw new Error(`页签不一致：渲染 ${JSON.stringify(actual)} vs 解析 ${JSON.stringify(expected)}`)
        }
        if (pageErrors.length) throw new Error(`页面异常：${pageErrors[0]}`)
        if (index < SHOT_LIMIT) {
          const shot = join(SHOT_DIR, `${String(index + 1).padStart(2, '0')}-${basename(file).replace(/[^\w.-]+/g, '_')}.png`)
          await tab.screenshot({ path: shot, fullPage: false })
        }
        rows.push({ file, size: execFileSync('stat', ['-c', '%s', file], { encoding: 'utf8' }).trim(), sheets: expected.length, openMs, cell })
      } catch (error) {
        failures.push(`${basename(file)}：${error.message}`)
        rows.push({ file, size: '-', sheets: expected.length, openMs: '-', error: error.message })
      }
    }

    for (const row of rows) {
      const state = row.error ? `✗ ${row.error}` : `✓ ${row.sheets} sheets / ${row.openMs} ms / A1=${JSON.stringify(row.cell)}`
      console.log(`${basename(row.file)} (${row.size} B) ${state}`)
    }
    console.log(`\n${files.length - failures.length}/${files.length} 份通过；截图 ${Math.min(SHOT_LIMIT, files.length)} 张 → ${SHOT_DIR}`)
    if (failures.length) {
      console.log(`\n${failures.length} 份失败\n  ${failures.join('\n  ')}`)
      process.exitCode = 1
    } else {
      console.log('✓ xlsx 真实语料巡检全部通过')
    }
  } finally {
    await browser.close()
    server.close()
  }
}

void main()
