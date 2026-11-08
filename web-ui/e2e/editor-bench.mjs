#!/usr/bin/env node
// 编辑器性能闸门(计划 / 闸门 )。
//
// 分两段量,各管一件事:
//   A. 静态体积(确定值,不受机器忙闲影响):从构建 manifest 算「读一篇笔记比应用壳多下多少 JS」,
//      并检查阅读路径的静态依赖里没有编辑器内核(Milkdown / ProseMirror / Office 引擎 / katex / mermaid);
//   B. 真实耗时(浏览器里量):4G(9 Mbps / 70 ms)+ 4× CPU 降速,先看列表页,再点开笔记,
//      分别量「整页冷开增量」与「应用内点开的耗时」。
//
// 用法(先 npm run build):
// node e2e/editor-bench.mjs # 不带 --surface: 五样本基线(见 editor-samples-bench.mjs)
//   node e2e/editor-bench.mjs --surface=samples        # 同上,显式写法
// node e2e/editor-bench.mjs --network=plan # 五样本按的口径量(20 Mbps / 70 ms;默认仍是更严的 9 Mbps)
//   node e2e/editor-bench.mjs --surface=text           # 闸门模式,超预算退出码 1
//   node e2e/editor-bench.mjs --surface=text --runs=5  # 多跑几次取中位数(机器越忙越该多跑)
//   KB_BENCH_KEEP=1 node e2e/editor-bench.mjs          # 保留浏览器窗口,肉眼看一下
import { existsSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { installFixture } from './fixture.mjs'
import { startStaticServer } from './serve.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const MANIFEST = join(DIST, '.vite/manifest.json')
const COLLECTION = 'knowledgeBase%2Finsights'
const LIST_ROUTE = `/kb?collection=${COLLECTION}`

const args = process.argv.slice(2)
const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
// 计划 的验收命令是不带参数的 `node e2e/editor-bench.mjs`:默认跑五样本基线;各内容面闸门要显式 --surface
const surface = flag('surface', 'samples')
if (surface === 'samples') {
  // 基线脚本自己解析 --runs / --report / --enforce,并决定退出码
  await import('./editor-samples-bench.mjs')
  process.exit(process.exitCode ?? 0)
}
const RUNS = Number(flag('runs', process.env.KB_BENCH_RUNS ?? '3'))

/**
 * 每个内容面的闸门。数值来自设计规范的阶段验收,
 * 改数值必须同时改计划,不能只为了让检查变绿。
 */
const GATES = {
  text: {
    name: '笔记阅读(Text / Markdown)',
    note: `/kb?collection=${COLLECTION}&item=ins_8f21`,
    baseline: LIST_ROUTE,
    ready: '.kb-md-read-body h2',
    baselineReady: '[data-testid="list-row-ins_8f21"]',
    // 阅读路径的静态依赖(相对应用壳)
    readEntry: 'src/components/DocPage.vue',
    shellEntry: 'src/pages/Browser.vue',
    // :阅读增量 JS ≤ 150 KB gzip;冷开增量 ≤ 1.2 s;应用内点开 ≤ 500 ms
    jsBytes: 150 * 1024,
    coldMs: 1200,
    hotMs: 500,
  },
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('没有 dist/index.html:先 npm run build')
  process.exit(2)
}
if (!existsSync(MANIFEST)) {
  console.error('没有 dist/.vite/manifest.json:vite.config.ts 里的 build.manifest 被关掉了?')
  process.exit(2)
}
const gate = GATES[surface]
if (!gate) {
  console.error(`--surface=${surface} 还没有闸门;已接入:${Object.keys(GATES).join(' / ')}`)
  console.error('(Grid / Page / Slide / Code / PDF 的闸门随对应阶段一起加)')
  process.exit(2)
}

const issues = []
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`

// ---------------- A. 静态体积 ----------------
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const gzipOf = (file) => {
  const path = join(DIST, file)
  return existsSync(path) ? gzipSync(readFileSync(path), { level: 9 }).length : 0
}
/** 静态 import 闭包(不含 dynamicImports:那些是点编辑 / 换格式时才加载的) */
function staticClosure(entries) {
  const seen = new Set()
  const walk = (key) => {
    if (!key || key === 'index.html' || seen.has(key)) return
    const item = manifest[key]
    if (!item) return
    seen.add(key)
    for (const next of item.imports ?? []) walk(next)
  }
  entries.forEach(walk)
  return seen
}
const readKeys = staticClosure([gate.readEntry])
const shellKeys = staticClosure([gate.shellEntry])
const extraKeys = [...readKeys].filter((key) => !shellKeys.has(key) && key !== 'index.html')
const extraJs = extraKeys.reduce((sum, key) => sum + gzipOf(manifest[key].file), 0)
const extraCss = extraKeys.reduce((sum, key) => sum + (manifest[key].css ?? []).reduce((s, f) => s + gzipOf(f), 0), 0)

console.log(`阅读路径相对应用壳新增的静态资源(${extraKeys.length} 个):`)
if (!extraKeys.length) console.log('  (无)')
for (const key of extraKeys.sort((a, b) => gzipOf(manifest[b].file) - gzipOf(manifest[a].file))) {
  console.log(`  ${kb(gzipOf(manifest[key].file)).padStart(9)}  ${manifest[key].file}`)
}
console.log(`  合计 JS ${kb(extraJs)} gzip / CSS ${kb(extraCss)} gzip`)
if (extraJs > gate.jsBytes) issues.push(`阅读增量 JS ${kb(extraJs)} 超预算 ${kb(gate.jsBytes)}`)

// 阅读路径的静态图里不能出现编辑器内核 / 公式 / 流程图:它们只能挂在动态 import 上
const FORBIDDEN = /(DocEditor|milkdown|prosemirror|betteroffice|katex|mermaid)/i
for (const key of readKeys) {
  const file = manifest[key].file
  if (FORBIDDEN.test(key) || FORBIDDEN.test(file)) issues.push(`阅读路径静态依赖里出现了编辑器内核:${file}`)
}
// 反过来:DocEditor 必须还在动态 import 里(编辑时按需加载),不能被悄悄删掉
const readDynamic = (manifest[gate.readEntry]?.dynamicImports ?? []).map((key) => manifest[key]?.file ?? key)
if (!readDynamic.some((file) => /DocEditor/i.test(file))) issues.push('DocEditor 不在动态 import 里(编辑态会打不开)')
console.log(`编辑态按需加载:${readDynamic.map((file) => file.replace(/^assets\//, '')).join(', ') || '(无)'}`)

// ---------------- B. 真实耗时 ----------------
async function loadPage(tab, url, ready, base) {
  const started = Date.now()
  await tab.goto(base + url, { waitUntil: 'commit' })
  await tab.waitForSelector(ready, { state: 'visible', timeout: 30_000 })
  await tab.waitForTimeout(120)
  return Date.now() - started
}

async function clickNote(tab) {
  const started = Date.now()
  await tab.click('[data-testid="list-row-ins_8f21"]')
  await tab.waitForSelector(gate.ready, { state: 'visible', timeout: 30_000 })
  return Date.now() - started
}

/** 页面里出现的问题(正文没渲染 / 混进了旧编辑器) */
async function assertSurface(tab) {
  const info = await tab.evaluate(() => ({
    body: document.querySelector('.kb-md-read-body')?.textContent?.slice(0, 40) ?? '',
    prose: !!document.querySelector('.kb-dp .ProseMirror'),
    mdEditor: !!document.querySelector('.md-editor-preview'),
    katex: !!document.querySelector('.katex'),
  }))
  if (!info.body) issues.push('正文没有渲染')
  if (info.prose) issues.push('阅读态出现了 ProseMirror(编辑器内核被拖回首屏)')
  if (info.mdEditor) issues.push('阅读态出现了 md-editor-v3 预览')
  if (info.katex) issues.push('普通笔记里出现了公式渲染(没有公式不该加载 katex)')
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const coldDeltas = []
const hotDeltas = []
const coldAbsolutes = []

const { server, base } = await startStaticServer()
const browser = await chromium.launch({ chromiumSandbox: false, headless: !process.env.KB_BENCH_KEEP })
try {
  for (let run = 0; run < RUNS; run += 1) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      serviceWorkers: 'block',
    })
    await installFixture(context)
    // 关掉首屏之后的空闲预取(它会顺手把别的页面 chunk 拉下来,让「打开笔记要下多少」量不准),
    // 也不要装 tab.clock:假时钟会把 requestIdleCallback 一起换掉。
    await context.addInitScript(() => {
      window.requestIdleCallback = () => 0
    })
    const tab = await context.newPage()
    const client = await context.newCDPSession(tab)
    await client.send('Network.enable')
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 70,
      downloadThroughput: (9 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    })
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })

    const coldBase = await loadPage(tab, gate.baseline, gate.baselineReady, base)
    const coldNote = await loadPage(tab, gate.note, gate.ready, base)
    coldDeltas.push(Math.max(0, coldNote - coldBase))
    coldAbsolutes.push(`${coldBase}/${coldNote}`)
    if (run === 0) await assertSurface(tab)

    // 热:回列表再点开同一条(chunk 已在缓存,量的是打开这条路径本身)
    await tab.goto(base + gate.baseline, { waitUntil: 'commit' })
    await tab.waitForSelector(gate.baselineReady, { state: 'visible', timeout: 30_000 })
    hotDeltas.push(await clickNote(tab))
    if (run === 0) await assertSurface(tab)
    await context.close()
  }
} finally {
  await browser.close()
  server.close()
}

const cold = median(coldDeltas)
const hot = median(hotDeltas)
console.log(`\n${gate.name}(${RUNS} 次取中位数;4G + 4× CPU)`)
// 增量两边都是整页冷开(同一个路由),差值只反映正文那部分;整站首屏的绝对值另见 e2e/perf-budget.mjs
console.log(`  冷开增量 ${cold} ms(闸门 ≤ ${gate.coldMs} ms)  样本 ${coldDeltas.join('/')}  绝对值(列表/笔记) ${coldAbsolutes.join(' ')}`)
console.log(`  应用内点开 ${hot} ms(闸门 ≤ ${gate.hotMs} ms)  样本 ${hotDeltas.join('/')}`)
if (cold > gate.coldMs) issues.push(`冷开增量 ${cold} ms 超预算 ${gate.coldMs} ms`)
if (hot > gate.hotMs) issues.push(`应用内点开 ${hot} ms 超预算 ${gate.hotMs} ms`)

if (issues.length) {
  console.error(`\n✗ ${issues.length} 个问题:`)
  for (const issue of issues) console.error(`  - ${issue}`)
  process.exit(1)
}
console.log('\n✓ 全部达标')
