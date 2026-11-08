#!/usr/bin/env node
/**
 * 构建产物体积报告与预算
 *
 * 验收线：dist 总体积 ≤ 100 MB，其中 wasm ≤ 48 MB、字体 ≤ 12 MB、非 wasm ≤ 52 MB
 * （wasm 按需加载，但计入体积）。字体预算原为 8 MB，实测发现不够：界面 Noto Sans SC 4.5 + PPT 幻灯片字形 1.8 +
 * Word 中文 GB2312 子集 2.1 已经 8.4 MB，再加 Word 必须的拉丁字体就超了；经用户确认上调到 12 MB（其余三项不变）。这里只数原始文件，不数构建时生成的 .br / .gz 预压缩副本
 * （它们是同一份内容的另一种编码，部署时守护进程只内嵌 .br，见 crates/kb-web/src/ui.rs）。
 *
 * 字体超预算时列出最大的几个，便于判断是该裁剪还是该按需下载。
 *
 * 2026-11 补的两条：
 *   ① 首屏预算：index.html 里直接引用的 JS / CSS 按 brotli 后的体积算，JS ≤ 200 KB、CSS ≤ 100 KB。
 *      总量预算挡不住「首屏偷偷变大」——总量里 100 MB 的 wasm 是懒加载的，首屏多 30 KB 却每次都付。
 *      阈值取的是当前值的约 1.5 倍（129 / 67 KB），是棘轮不是目标：涨上来要写清原因再调。
 *   ② wasm 必须懒加载：任何 .wasm 的文件名都不许出现在 index.html 或首屏 JS 里。
 *      Office 的 docx_edit_bg 24 MB，一旦被静态 import 就会进首屏，用户打开首页就要下它。
 *
 * 用法：npm run build && node scripts/dist-report.mjs [--json] [--no-budget]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'

const DIST = resolve(import.meta.dirname, '..', 'dist')
const MB = 1024 * 1024
const BUDGET = { total: 100 * MB, wasm: 48 * MB, font: 12 * MB, nonWasm: 52 * MB }
const KB = 1024
/** 首屏预算：按 brotli 后体积算（有 .br 用 .br，没有就退回原文件并提示） */
const FIRST_PAINT = { js: 200 * KB, css: 100 * KB }
const asJson = process.argv.includes('--json')
const enforce = !process.argv.includes('--no-budget')

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (!/\.(br|gz)$/.test(entry.name)) files.push({ path: path.slice(DIST.length + 1), size: statSync(path).size })
  }
}
walk(DIST)

const kindOf = (path) => {
  const ext = extname(path).toLowerCase()
  if (ext === '.wasm') return 'wasm'
  if (['.woff', '.woff2', '.ttf', '.otf'].includes(ext)) return 'font'
  if (['.js', '.mjs'].includes(ext)) return 'js'
  if (ext === '.css') return 'css'
  if (['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.ico'].includes(ext)) return 'image'
  return 'other'
}
const sum = (list) => list.reduce((total, file) => total + file.size, 0)
const byKind = {}
for (const file of files) (byKind[kindOf(file.path)] ??= []).push(file)

const totals = {
  total: sum(files),
  wasm: sum(byKind.wasm ?? []),
  font: sum(byKind.font ?? []),
  nonWasm: sum(files) - sum(byKind.wasm ?? []),
}
const report = {
  files: files.length,
  totalsMB: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, +(value / MB).toFixed(1)])),
  byKindMB: Object.fromEntries(Object.entries(byKind).map(([key, list]) => [key, { files: list.length, mb: +(sum(list) / MB).toFixed(1) }])),
  largest: [...files].sort((a, b) => b.size - a.size).slice(0, 15).map((file) => ({ path: file.path, mb: +(file.size / MB).toFixed(2) })),
  largestFonts: [...(byKind.font ?? [])].sort((a, b) => b.size - a.size).slice(0, 10).map((file) => ({ path: file.path, mb: +(file.size / MB).toFixed(2) })),
}
// ① 首屏：只认 index.html 里直接引用的 js / css（含 modulepreload，将来有人加会一起算）
const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const firstPaintFiles = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((match) => match[1].slice(1))
const firstPaint = { js: 0, css: 0 }
const firstPaintDetail = []
for (const path of new Set(firstPaintFiles)) {
  const kind = path.endsWith('.css') ? 'css' : 'js'
  const compressed = join(DIST, `${path}.br`)
  let size
  let note = ''
  try {
    size = statSync(compressed).size
  } catch {
    size = statSync(join(DIST, path)).size
    note = '(无 .br，按原文件计)'
  }
  firstPaint[kind] += size
  firstPaintDetail.push({ path, kind, kb: +(size / KB).toFixed(1), note })
}
const firstPaintOver = Object.entries(FIRST_PAINT)
  .filter(([kind, limit]) => firstPaint[kind] > limit)
  .map(([kind, limit]) => `首屏 ${kind} ${(firstPaint[kind] / KB).toFixed(1)} KB > ${limit / KB} KB`)
if (!firstPaintDetail.length) firstPaintOver.push('index.html 里没找到任何 js / css 引用（构建产物不完整？）')

// ② wasm 懒加载：文件名不许出现在首屏 HTML 或首屏 JS 里
const entryJs = firstPaintDetail.filter((file) => file.kind === 'js').map((file) => file.path)
const entrySources = [html, ...entryJs.map((path) => readFileSync(join(DIST, path), 'utf8'))].join('\n')
const leakedWasm = (byKind.wasm ?? []).filter((file) => entrySources.includes(file.path.split('/').pop())).map((file) => file.path)
const wasmLazyOver = leakedWasm.map((path) => `${path} 被首屏引用（应改为按需加载）`)

report.firstPaint = {
  jsKB: +(firstPaint.js / KB).toFixed(1),
  cssKB: +(firstPaint.css / KB).toFixed(1),
  budgetKB: { js: FIRST_PAINT.js / KB, css: FIRST_PAINT.css / KB },
  files: firstPaintDetail,
}
const over = [
  ...Object.entries(BUDGET)
    .filter(([key, limit]) => totals[key] > limit)
    .map(([key, limit]) => `${key} ${(totals[key] / MB).toFixed(1)} MB > ${limit / MB} MB`),
  ...firstPaintOver,
  ...wasmLazyOver,
]

if (asJson) console.log(JSON.stringify({ ...report, budgetMB: Object.fromEntries(Object.entries(BUDGET).map(([key, value]) => [key, value / MB])), over }, null, 2))
else {
  console.log(`dist：${report.files} 个文件（不含 .br / .gz 预压缩副本）`)
  for (const [key, value] of Object.entries(report.totalsMB)) console.log(`  ${key.padEnd(8)} ${String(value).padStart(6)} MB  预算 ${BUDGET[key] / MB} MB`)
  console.log('按类型：')
  for (const [key, value] of Object.entries(report.byKindMB)) console.log(`  ${key.padEnd(8)} ${String(value.mb).padStart(6)} MB  ${value.files} 个`)
  console.log('首屏（index.html 直接引用，按 brotli 计）：')
  for (const file of firstPaintDetail) console.log(`  ${String(file.kb).padStart(6)} KB  ${file.kind.padEnd(3)} ${file.path} ${file.note}`)
  console.log(`  合计 js ${report.firstPaint.jsKB} KB / ${report.firstPaint.budgetKB.js} KB、css ${report.firstPaint.cssKB} KB / ${report.firstPaint.budgetKB.css} KB`)
  console.log('最大的文件：')
  for (const file of report.largest) console.log(`  ${String(file.mb).padStart(6)} MB  ${file.path}`)
}
if (over.length) {
  console.error(`\n${enforce ? '✗' : '⚠'} 超出预算：\n  ${over.join('\n  ')}`)
  if (enforce) process.exit(1)
} else if (!asJson) console.log('\n✓ dist 体积与首屏预算都在范围内，wasm 全是懒加载')
