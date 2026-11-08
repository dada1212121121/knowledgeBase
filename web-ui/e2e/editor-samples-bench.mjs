#!/usr/bin/env node
// :五个固定样本的真实基线(笔记 / CSV / XLSX / DOCX / PPTX)。
//
// 与 editor-bench.mjs --surface=text 的分工:
// - --surface=text 守「文本阅读路径相对应用壳的增量」(闸门);
//   - 本脚本用 e2e/fixtures/editor/ 的固定样本量「用户点开一份文档」的绝对耗时、增量传输、
//     主线程长任务与 JS 堆,并把结果写成 JSON + Markdown。
//
// 口径(写死,改了要同步 实测报告):
//   - 走**默认路由**(不带 ?editor=):量的是用户今天真实打开的那条路;
//   - 传输量 = 「基线页(列表 + 小二进制文件) → 文档页」新增的静态资源(编辑器代码 + WASM + 字体),按服务器真实下发的编码字节算;
//     /api/ 下的一切(文档原件、file_preview 的正文 JSON)都不算编辑器传输;
//   - 静态资源必须是构建期预压缩过的(npm run build 的 postbuild),否则量到的是原始字节,脚本直接退出;
// - CSV 5 MB 样本运行时生成(固定内容,不进仓库）;与生产一致,>512 KB 的文本文件正文随 file_preview 下发、不可编辑。
// - 主线程长任务(取严):笔记阅读打开期间不得有 > 50 ms 的长任务,其余样本打开期间不得有 > 100 ms 的;
//     一条都不许有(以前允许 1 条超标)。观测窗口从路由跳转开始,**一直持续到样本给出的「完成信号」(done)再加 1 s 余量**:
//     渐进渲染 / 空闲时才做的后台工作也算打开成本,不能因为「就绪」之后才发生就看不见。
//     给了 done 的样本(笔记 / CSV / DOCX 阅读)窗口内 requestIdleCallback 照常工作(其余时候被桩掉,免得路由预取的空闲任务污染基线)。
//
// 用法(先 npm run build):
//   node e2e/editor-bench.mjs                      # 等价于本脚本
//   node e2e/editor-samples-bench.mjs [--runs=3] [--only=xlsx,docx] [--enforce] [--network=plan]
// --network=plan:按表头的定义量(20 Mbps / 70 ms,CPU 仍 4× 降速,对所有样本生效);
//                  不带则是 4G 9 Mbps / 70 ms(更严,留作回归基线)。预算数字两种网络下都不改。
//   结果:e2e/out/editor-samples.{json,md}
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { FILES, installFixture } from './fixture.mjs'
import { startStaticServer } from './serve.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const FIXTURE = join(ROOT, 'e2e', 'fixtures', 'editor')
const OUT_DIR = join(ROOT, 'e2e', 'out')
const BUDGET = JSON.parse(readFileSync(join(ROOT, 'e2e', 'editor-budget.json'), 'utf8'))
const COLLECTION = 'knowledgeBase%2Finsights'
const LIST = `/kb?collection=${COLLECTION}`
/**
 * 基线页:列表 + 一个十六进制查看的小二进制文件。不能用裸列表页——桌面宽度下它会自动打开第一条笔记,
 * 笔记阅读路径就被算进了基线(以前量出「笔记 0 KB」就是这个原因)。
 */
const BASELINE = `${LIST}&item=file_dat`
const args = process.argv.slice(2)
const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const RUNS = Math.max(1, Number(flag('runs', process.env.KB_BENCH_RUNS ?? '3')))
const ONLY = (flag('only', '') ?? '').split(',').filter(Boolean)
// 网络档位:default 是历史基线(9 Mbps,更严);plan 是对「冷」的定义(20 Mbps,无缓存)。
// 吞吐沿用基线原来的写法(Mbps × 1024 × 1024 / 8),两档换算口径一致;上行不论哪档都是 750 Kbps。
const NETWORKS = {
  default: { label: '4G 9Mbps/70ms', mbps: 9, latency: 70 },
  plan: { label: '计划口径 20Mbps/70ms', mbps: 20, latency: 70 },
}
const NETWORK_KEY = flag('network', 'default')
const NETWORK = NETWORKS[NETWORK_KEY]
if (!NETWORK) {
  console.error(`--network 只认 ${Object.keys(NETWORKS).join(' / ')},收到 ${NETWORK_KEY}`)
  process.exit(2)
}
const OUT_JSON = resolve(ROOT, flag('out', 'e2e/out/editor-samples.json'))
const OUT_MD = resolve(ROOT, flag('report', 'e2e/out/editor-samples.md'))

/** 5 MB CSV:固定内容(和以前的 Python 生成器同一规则),第一次运行生成到 e2e/out/ */
function csvSample() {
  const file = join(OUT_DIR, 'sheet-5m.csv')
  if (existsSync(file)) return readFileSync(file, 'utf8')
  const target = 5 * 1024 * 1024
  const rows = ['编号,查询,命中名次,耗时(ms),备注']
  let bytes = Buffer.byteLength(rows[0]) + 2
  for (let i = 1; bytes < target; i += 1) {
    // 引号 / 逗号 / 中文 / CRLF 都覆盖;每 97 行一个带引号的字段
    const note = i % 97 === 0 ? '"含逗号,引号""与换行"' : i % 3 ? '中文备注 · 混合检索' : 'plain note'
    const row = `q${String(i).padStart(6, '0')},UDS 断线怎么降级 ${i},${(i % 7) + 1},${40 + ((i * 13) % 90)},${note}`
    rows.push(row)
    bytes += Buffer.byteLength(row) + 2
  }
  const text = `${rows.join('\r\n')}\r\n`
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(file, text)
  return text
}

const S = BUDGET.samples
/** 原生网格首帧之后 loading 才消失;等到能读格子再算「打开完成」 */
const xlsxReady = () => !!document.querySelector('.kb-xg .kb-xg-canvas') && !document.querySelector('.kb-xg-loading') && (document.querySelector('.kb-xg-cellname')?.textContent ?? '').trim() !== ''
const SAMPLES = [
  {
    key: 'note', name: '笔记 200 KB（阅读）', budget: S.note,
    env: { KB_NOTE_200K: '1' },
    route: `${LIST}&item=ins_8f21`,
    ready: () => document.querySelectorAll('.kb-md-read-body h2').length >= 60,
    // 渐进渲染全部落到 DOM 才算完;旧实现没有这个属性(同步渲染),按已完成处理,新旧构建用同一份脚本测
    done: () => {
      const state = document.querySelector('.kb-md-read')?.getAttribute('data-render')
      return state == null || state === 'done'
    },
  },
  {
    key: 'csv', name: 'CSV 5 MB / 7.9 万行（预览）', budget: S.csv,
    // 与生产一致:>512 KB 的文本正文随 file_preview 下发(上限 8 MB),但不可编辑
    prepare: () => {
      FILES.file_csv.preview.content = csvSample()
      FILES.file_csv.preview.editable = false
    },
    route: `${LIST}&item=file_csv`,
    // SheetViewer 整份解析完才渲染行,出现数据行即可读
    ready: () => document.querySelectorAll('.kb-sg-row').length > 5,
    done: () => document.querySelector('.kb-sg')?.getAttribute('data-state') !== 'loading',
  },
  {
    key: 'xlsx', name: 'XLSX 5 万格（只读，原生网格）', budget: S.xlsx,
    env: { KB_SAMPLE_XLSX: join(FIXTURE, 'sheet-50k.xlsx') },
    route: `${LIST}&item=file_xlsx`,
    ready: xlsxReady,
  },
  {
    key: 'docx', name: 'DOCX 20 页（只读，docx-preview）', budget: S.docx,
    env: { KB_SAMPLE_DOCX: join(FIXTURE, 'doc-20p.docx') },
    route: `${LIST}&item=file_docx`,
    // docx-preview 一次性把整篇渲染进 DOM,出现第一个分节即整篇可读
    ready: () => !!document.querySelector('.kb-dx-host section'),
    // 批注 / 大纲等元信息是首屏之后空闲时才读的,缩略图也是后台排队画的:都等做完(新旧构建都有缩略图槽;元信息属性只有新构建有)
    done: () => {
      const meta = document.querySelector('.kb-pgs')?.getAttribute('data-meta')
      const slots = document.querySelectorAll('.kb-pgt-slot')
      return (meta == null || meta === 'done') && slots.length > 0 && ![...slots].some((slot) => slot.getAttribute('data-state') === 'pending')
    },
  },
  {
    key: 'pptx', name: 'PPTX 30 页（只读，引擎画布渲染）', budget: S.pptx,
    // KB_BENCH_PPTX_DECK 换样本(例如纯拉丁的 deck-latin-8p.pptx,验证不下载中文字体时的冷开)
    env: { KB_SAMPLE_PPTX: process.env.KB_BENCH_PPTX_DECK ?? join(FIXTURE, 'deck-30p.pptx') },
    route: `${LIST}&item=file_pptx`,
    // 打开后默认进幻灯片面:首页画到画布上才算可读(缩略图是后台任务,不算首屏)
    ready: () => document.querySelector('[data-testid="slide-surface"]')?.getAttribute('data-state') === 'ready' && Number(document.querySelector('[data-testid="slide-surface"]')?.getAttribute('data-painted')) >= 1,
  },
  // 编辑态:从点「在线编辑」到可编辑。XLSX 是原生网格,DOCX 是 Vue 原生编辑面(起旧 React 岛已删除)
  {
    key: 'xlsxEdit', name: 'XLSX 5 万格（在线编辑，原生网格）', budget: S.xlsxEdit,
    env: { KB_SAMPLE_XLSX: join(FIXTURE, 'sheet-50k.xlsx') },
    upload: 'file_xlsx',
    route: `${LIST}&item=file_xlsx`,
    click: '[data-testid="office-edit-open"]',
    ready: () =>
      !!document.querySelector('[data-testid="office-native-host"] .kb-xg .kb-xg-canvas') &&
      !document.querySelector('.kb-xg-loading') &&
      !document.querySelector('[data-testid="office-veil"]'),
  },
  {
    // Vue 原生编辑面(默认入口),预算沿用旧岛基线定下的那一份
    key: 'docxEdit', name: 'DOCX 20 页（在线编辑，Vue 原生面）', budget: S.docxEdit,
    env: { KB_SAMPLE_DOCX: join(FIXTURE, 'doc-20p.docx') },
    upload: 'file_docx',
    route: `${LIST}&item=file_docx`,
    click: '[data-testid="office-edit-open"]',
    ready: () => !!document.querySelector('.kb-office-host .kb-dex canvas') && !document.querySelector('[data-testid="office-veil"]'),
  },
  {
    key: 'pptxEdit', name: 'PPTX 30 页（在线编辑，原生幻灯片编辑面）', budget: S.pptxEdit,
    env: { KB_SAMPLE_PPTX: join(FIXTURE, 'deck-30p.pptx') },
    upload: 'file_pptx',
    route: `${LIST}&item=file_pptx`,
    click: '[data-testid="office-edit-open"]',
    // 打开后默认进原生编辑：首页画到画布上、引擎会话已就绪、遮罩消失才算可编辑
    ready: () => document.querySelector('[data-testid="office-native-host"] [data-testid="slide-surface"]')?.getAttribute('data-state') === 'ready' && Number(document.querySelector('[data-testid="slide-surface"]')?.getAttribute('data-painted')) >= 1 && !document.querySelector('[data-testid="office-veil"]'),
  },
].filter((sample) => !ONLY.length || ONLY.some((only) => sample.key === only))

/** 在线编辑只给「上传的文件」:夹具默认是项目目录里的文件,编辑态样本要改成上传来源 */
const UPLOAD_FIXTURE = {
  file_info: () => ({ sha256: 'sha-fixture-original', origin: 'upload', max_replace_bytes: 64 * 1024 * 1024 }),
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
const kb = (bytes) => bytes / 1024
const mb = (bytes) => bytes / (1024 * 1024)

/** 页面与所有 Worker 的资源条目(Worker 拉取的 WASM 不在页面 performance 里)。 */
async function resourcesOf(tab) {
  const read = () =>
    performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name,
      encodedBodySize: entry.encodedBodySize ?? 0,
      duration: entry.duration ?? 0,
    }))
  const page = await tab.evaluate(read)
  const workers = []
  for (const worker of tab.workers()) {
    try {
      workers.push(...(await worker.evaluate(read)))
    } catch {
      // Worker 可能在测量期间退出;少一条资源比整轮失败好
    }
  }
  const seen = new Set()
  return [...page, ...workers].filter((entry) => {
    if (seen.has(entry.name)) return false
    seen.add(entry.name)
    return true
  })
}
/** /api/ 下的都不是编辑器的钱:原件、file_preview 正文、能力调用 */
const isApi = (name) => new URL(name).pathname.startsWith('/api/')

/** 应用内跳转(走 vue-router,与用户在列表里点开一致);生产构建里 `#app.__vue_app__` 照样存在 */
async function routeTo(tab, route) {
  await tab.evaluate((target) => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(target), route)
}

/**
 * 打开文档(应用内路由);编辑态样本再点「在线编辑」。返回开始计时的时刻:
 * 阅读样本从路由跳转算,编辑态样本从点按钮算(预览本身的耗时不算进编辑器打开)。
 */
async function openSample(tab, sample) {
  const started = Date.now()
  await routeTo(tab, sample.route)
  if (!sample.click) return started
  await tab.waitForSelector(sample.click, { state: 'visible', timeout: 60_000 })
  const clicked = Date.now()
  await tab.click(sample.click)
  return clicked
}

async function readyWithin(tab, sample) {
  try {
    await tab.waitForFunction(sample.ready, null, { timeout: 120_000, polling: 50 })
    return true
  } catch {
    return false
  }
}

/** 完成信号之后再多看的时间:渐进渲染的最后一块、空闲任务的尾巴都落在这段里 */
const SETTLE_MARGIN_MS = 1000

/** 等样本给出的完成信号(没有就不等),再留余量;超时记问题但不中断,让已有数据照常出 */
async function settleWindow(tab, sample, problems, label) {
  if (!sample.done) return
  try {
    await tab.waitForFunction(sample.done, null, { timeout: 60_000, polling: 50 })
  } catch {
    problems.push(`${sample.key}: ${label}后 60 s 内没有给出完成信号(done),长任务窗口可能不完整`)
  }
  await tab.waitForTimeout(SETTLE_MARGIN_MS)
}

async function runSurface(browser, sample) {
  for (const [key, value] of Object.entries(sample.env ?? {})) process.env[key] = value
  const original = { content: FILES.file_csv.preview.content, editable: FILES.file_csv.preview.editable }
  const origin = sample.upload ? { item: FILES[sample.upload].item.origin, preview: FILES[sample.upload].preview.origin } : null
  if (sample.upload) {
    FILES[sample.upload].item.origin = 'upload'
    FILES[sample.upload].preview.origin = 'upload'
  }
  sample.prepare?.()
  const cold = []
  const hot = []
  const page = []
  const transfer = []
  const wasm = []
  const fonts = []
  const heap = []
  const longTasks = []
  const hotLongTasks = []
  /** 每一轮(冷开 + 热开)里最长的那条长任务:报告里给「每轮最长的中位数 / 最大值」 */
  const runMax = []
  const problems = []
  const files = []
  for (let run = 0; run < RUNS; run += 1) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      serviceWorkers: 'block',
    })
    await installFixture(context, sample.upload ? UPLOAD_FIXTURE : {})
    await context.addInitScript(() => {
      // 基线页和路由预取期间的空闲回调一律不跑(预取全部路由块会污染「新增传输」的口径);
      // 样本窗口里(__kbIdleLive = true)才放行真正的空闲回调:组件把重活推到空闲时做(Word 的批注 / 大纲、缩略图队列)
      // 也是打开这份文档的成本,桩成 no-op 就看不见这些长任务了
      const nativeIdle = window.requestIdleCallback?.bind(window)
      window.__kbIdleLive = false
      window.requestIdleCallback = (callback, options) => (window.__kbIdleLive && nativeIdle ? nativeIdle(callback, options) : 0)
      window.__kbLong = []
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) window.__kbLong.push({ start: entry.startTime, duration: entry.duration })
        }).observe({ entryTypes: ['longtask'] })
      } catch {
        // 老浏览器没有 longtask;按空数组记录,不阻断
      }
    })
    const tab = await context.newPage()
    const client = await context.newCDPSession(tab)
    // 这条 CDP 会话只用来限速，从不读响应体：不让它缓存响应体。默认的 Network.enable 会在主线程把每个响应体按文本再解码一份存起来，
    // 5 MB 的 CSV 预览（file_preview 把正文放在 JSON 里）光这一步就是 ~65 ms 的长任务（trace：ResponseBodyLoader::DidFinishLoadingBody → TextResourceDecoder::Decode），
    // 那是量具自己的开销，不是页面的
    await client.send('Network.enable', { maxTotalBufferSize: 1, maxResourceBufferSize: 1 })
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: NETWORK.latency,
      downloadThroughput: (NETWORK.mbps * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    })
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    tab.on('pageerror', (error) => problems.push(`${sample.key}: ${error.message}`))
    tab.on('console', (message) => {
      if (message.type() === 'error' && !/WebSocket|502/.test(message.text())) problems.push(`${sample.key}: ${message.text()}`)
    })

    // 基线:列表页。之后的资源差才是这条文档新增的编辑器代码 / WASM / 字体。
    await tab.goto(`${base}${BASELINE}`, { waitUntil: 'commit' })
    await tab.waitForSelector('[data-testid="list-row-ins_8f21"]', { state: 'visible', timeout: 30_000 })
    // 十六进制视图要先嗅探再懒加载,等它真的渲染出来,否则它的 chunk 会被算到第一个样本头上
    await tab.waitForSelector('.kb-bv-dump', { timeout: 30_000 })
    await tab.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
    const baseNames = new Set((await resourcesOf(tab)).map((entry) => entry.name))
    await client.send('Performance.enable')
    const before = await client.send('Performance.getMetrics')
    const heapBefore = before.metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0

    // 冷:应用壳已就绪,在应用里点开这份文档(这份文档相关的代码 / WASM / 字体都还没下过)。
    // 用路由跳转而不是整页 goto:整页重开会把应用壳启动(鉴权、列表等十几个接口 × 70 ms 延迟)算到编辑器头上,
    // 那部分由 perf-budget.mjs 单独管。
    // 长任务只算打开这份文档期间的,基线页启动时的不算
    await tab.evaluate((live) => {
      window.__kbLong = []
      window.__kbIdleLive = live
    }, !!sample.done)
    const started = await openSample(tab, sample)
    const coldReady = await readyWithin(tab, sample)
    cold.push(Date.now() - started)
    if (!coldReady) problems.push(`${sample.key}: 冷开 120 s 内没有就绪`)
    // 长任务观测窗口覆盖全部延后的渲染:等样本的完成信号,再留 1 s 余量(见文件头口径)
    if (coldReady) await settleWindow(tab, sample, problems, '冷开')
    // 首帧之后还在后台加载的东西(缩略图、预取的引擎 chunk)也算这条文档的成本,等网络安静再统计
    await tab.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
    await tab.waitForTimeout(300)
    const after = await client.send('Performance.getMetrics')
    const heapAfter = after.metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0
    heap.push(Math.max(0, heapAfter - heapBefore))
    const fresh = (await resourcesOf(tab)).filter((entry) => !baseNames.has(entry.name) && !isApi(entry.name))
    files.push(fresh.map((entry) => ({ name: new URL(entry.name).pathname.split('/').pop(), kb: kb(entry.encodedBodySize) })))
    transfer.push(fresh.reduce((sum, entry) => sum + entry.encodedBodySize, 0))
    wasm.push(fresh.filter((entry) => /\.wasm(?:\?|$)/i.test(entry.name)).reduce((sum, entry) => sum + entry.encodedBodySize, 0))
    fonts.push(fresh.filter((entry) => /\.(?:woff2?|ttf|otf)(?:\?|$)/i.test(entry.name)).reduce((sum, entry) => sum + entry.encodedBodySize, 0))
    const pageLong = await tab.evaluate(() => window.__kbLong ?? [])
    longTasks.push(...pageLong.map((entry) => entry.duration))
    let thisRunMax = Math.max(0, ...pageLong.map((entry) => entry.duration))

    if (coldReady) {
      // 热:回到基线页再点开同一份——代码与 WASM 已缓存、模块已编译(「打开第二份同类文件」)
      await routeTo(tab, BASELINE)
      await tab.waitForSelector('.kb-bv-dump', { timeout: 30_000 }).catch(() => undefined)
      await tab.waitForFunction(sample.ready, null, { timeout: 5000, polling: 50 }).then(
        () => problems.push(`${sample.key}: 回到基线页后旧文档还在,热开数字不可信`),
        () => undefined,
      )
      await tab.evaluate(() => {
        window.__kbLong = []
      })
      const hotStarted = await openSample(tab, sample)
      const hotReady = await readyWithin(tab, sample)
      if (!hotReady) problems.push(`${sample.key}: 热开 120 s 内没有就绪`)
      hot.push(Date.now() - hotStarted)
      if (hotReady) await settleWindow(tab, sample, problems, '热开')
      const hotDurations = await tab.evaluate(() => (window.__kbLong ?? []).map((entry) => entry.duration))
      hotLongTasks.push(...hotDurations)
      thisRunMax = Math.max(thisRunMax, ...hotDurations)
      // 整页:直接打开文档链接(应用壳 + 文档都走 HTTP 缓存),给一个用户感知的绝对数,不进预算比较
      const pageStarted = Date.now()
      await tab.goto(`${base}${sample.route}`, { waitUntil: 'commit' })
      if (sample.click) {
        await tab.waitForSelector(sample.click, { state: 'visible', timeout: 60_000 })
        await tab.click(sample.click)
      }
      if (await readyWithin(tab, sample)) page.push(Date.now() - pageStarted)
    }
    runMax.push(thisRunMax)
    await context.close()
  }
  for (const key of Object.keys(sample.env ?? {})) delete process.env[key]
  Object.assign(FILES.file_csv.preview, original)
  if (origin) {
    FILES[sample.upload].item.origin = origin.item
    FILES[sample.upload].preview.origin = origin.preview
  }
  return {
    key: sample.key,
    name: sample.name,
    budget: sample.budget,
    coldMs: median(cold),
    hotMs: median(hot),
    pageMs: median(page),
    transferKb: kb(median(transfer)),
    wasmKb: kb(median(wasm)),
    fontKb: kb(median(fonts)),
    heapMb: mb(median(heap)),
    longTasksMs: longTasks,
    hotLongTasksMs: hotLongTasks,
    maxLongTaskMs: Math.max(0, ...longTasks, ...hotLongTasks),
    medianRunMaxLongTaskMs: median(runMax),
    samples: { cold, hot, page, transfer, heap, runMax },
    // 第一次冷开新增的文件(看清楚钱花在哪)
    files: (files[0] ?? []).sort((a, b) => b.kb - a.kb).slice(0, 12),
    problems,
  }
}

if (!S) {
  console.error('e2e/editor-budget.json 缺少 samples:先补预算再跑 基线')
  process.exit(2)
}
// 没有预压缩文件时量到的是原始字节,和生产差 3~4 倍,宁可不出数
const assetsDir = join(process.env.KB_DIST ? resolve(process.env.KB_DIST) : join(ROOT, 'dist'), 'assets')
if (!existsSync(assetsDir) || !readdirSync(assetsDir).some((name) => name.endsWith('.wasm.br'))) {
  console.error('dist 里没有预压缩的 .wasm.br:先 npm run build(postbuild 会跑 scripts/precompress.mjs)')
  process.exit(2)
}
const machine = { cpus: cpus().length, model: cpus()[0]?.model ?? '', loadBefore: loadavg().map((v) => +v.toFixed(2)) }
const { server, base } = await startStaticServer()
const browser = await chromium.launch({ chromiumSandbox: false, headless: !process.env.KB_BENCH_KEEP })
const results = []
try {
  for (const sample of SAMPLES) {
    process.stdout.write(`  ${sample.name} ... `)
    const result = await runSurface(browser, sample)
    results.push(result)
    console.log(`冷 ${result.coldMs} ms / 热 ${result.hotMs} ms / 整页 ${result.pageMs} ms / 传输 ${result.transferKb.toFixed(1)} KB / 堆 ${result.heapMb.toFixed(1)} MB / 长任务最长 ${result.maxLongTaskMs.toFixed(0)} ms（冷 ${result.longTasksMs.length} 条 + 热 ${result.hotLongTasksMs.length} 条）`)
  }
} finally {
  await browser.close()
  server.close()
}

const issues = []
const checks = []
for (const result of results) {
  const b = result.budget
  const check = (label, value, limit, unit = '') => {
    const ok = value <= limit
    checks.push({ sample: result.key, label, value, limit, unit, ok })
    if (!ok) issues.push(`${result.key} ${label} ${value.toFixed(1)}${unit} 超预算 ${limit}${unit}`)
  }
  check('冷开', result.coldMs, b.coldMs, ' ms')
  check('热开', result.hotMs, b.hotMs, ' ms')
  check('传输', result.transferKb, b.transferKb, ' KB')
  check('WASM', result.wasmKb, b.wasmKb, ' KB')
  check('内存', result.heapMb, b.heapMb, ' MB')
  // 长任务(「打开 / 保存无 > 100 ms 长任务」与设计规范逐场景预算取严):
  // 上限 = min(100, 场景预算),**一条都不许有**(以前按设计规范的「≤1×N ms」放过 1 条,也只看冷开)。
  // 冷开、热开两次打开的窗口都算(窗口含完成信号后 1 s 余量,见文件头)。
  const limit = Math.min(100, b.longTaskMs)
  const over = [...result.longTasksMs, ...result.hotLongTasksMs].filter((value) => value > limit)
  checks.push({ sample: result.key, label: '长任务', value: Math.max(0, ...result.longTasksMs, ...result.hotLongTasksMs), limit, unit: ' ms', ok: over.length === 0 })
  if (over.length) issues.push(`${result.key} 打开期间有 ${over.length} 条长任务超过 ${limit} ms（最长 ${Math.max(...over).toFixed(0)} ms）`)
}
for (const result of results) issues.push(...result.problems)

const generated = new Date().toISOString()
const payload = {
  schema: 1,
  generatedAt: generated,
  method: { runs: RUNS, network: NETWORK.label, cpu: '4× throttle', transfer: '基线页(列表 + 小二进制文件) → 文档页新增静态资源(构建期预压缩后的编码字节);不含 /api/', memory: 'CDP JSHeapUsedSize 差值(仅主线程)', route: '默认路由(不带 ?editor=)' },
  machine: { ...machine, loadAfter: loadavg().map((v) => +v.toFixed(2)) },
  results,
  checks,
  issues,
}
mkdirSync(dirname(OUT_JSON), { recursive: true })
writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`)

const md = [
  '# 编辑器性能基线（2026-11）',
  '',
  `> 生成于 ${generated}；\`node e2e/editor-bench.mjs --runs=${RUNS}\`；${NETWORK.label} + 4× CPU；每项 ${RUNS} 次取中位数。`,
  `> 机器：${machine.cpus} 核 ${machine.model}；负载（1/5/15 分钟）开始 ${machine.loadBefore.join(' / ')}，结束 ${loadavg().map((v) => v.toFixed(2)).join(' / ')}。`,
  '> 传输量 = 基线页（列表 + 一个小二进制文件）→ 文档页新增的静态资源（服务器实际下发的预压缩字节），不含 /api/ 下的文档正文与原件；内存仅主线程 JS 堆，不含 Canvas / WASM / GPU / Worker。',
  '',
  '| 样本 | 冷开（应用内首次） | 热开（应用内二次） | 整页直开 | 增量传输 | 其中 WASM | 字体 | JS 堆 | 长任务：每轮最长的中位数 / 全部最长 |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...results.map(
    (r) =>
      `| ${r.name} | ${r.coldMs} ms | ${r.hotMs} ms | ${r.pageMs} ms | ${r.transferKb.toFixed(1)} KB | ${r.wasmKb.toFixed(1)} KB | ${r.fontKb.toFixed(1)} KB | ${r.heapMb.toFixed(1)} MB | ${r.medianRunMaxLongTaskMs.toFixed(0)} / ${r.maxLongTaskMs.toFixed(0)} ms |`,
  ),
  '',
  '## 与预算对照',
  '',
  '| 样本 | 冷开 | 热开 | 传输 | WASM | 内存 | 长任务（最长 / 上限，0 条超限才达标） | 结论 |',
  '|---|---|---|---|---|---|---|---|',
  ...results.map((r) => {
    const own = checks.filter((c) => c.sample === r.key)
    const ok = own.every((c) => c.ok)
    const fmt = (label) => {
      const c = own.find((item) => item.label === label)
      return c ? `${c.value.toFixed(1)} / ${c.limit}${c.unit}` : '—'
    }
    return `| ${r.name} | ${fmt('冷开')} | ${fmt('热开')} | ${fmt('传输')} | ${fmt('WASM')} | ${fmt('内存')} | ${fmt('长任务')} | ${ok ? '达标' : '超预算'} |`
  }),
  '',
  '## 备注',
  '',
  '- 全部走默认路由：XLSX 是原生只读网格（默认），CSV / DOCX / PPTX 是旧查看器（SheetViewer / docx-preview / pptx-preview）；对应阶段切换后必须用本脚本复跑。',
  '- 长任务只统计主线程；Worker 内的解析 / WASM 编译不在其中，但会体现在冷开耗时里。',
  '- 长任务口径：冷开、热开两次打开都统计；窗口从路由跳转起，到样本的完成信号（渐进渲染全部落地 / 后台元信息读完）后再多 1 s；判定上限 = min(100 ms, 场景预算)，一条都不许超（笔记 50 ms）。没有完成信号的样本窗口仍是「就绪 + 网络安静 + 300 ms」。',
  '',
  '## 冷开新增文件（第 1 次，前 12 个）',
  '',
  ...results.flatMap((r) => [`- **${r.name}**：${r.files.map((f) => `${f.name} ${f.kb.toFixed(1)} KB`).join('；') || '（无）'}`]),
  ...(issues.length ? ['', '## 未达标', '', ...issues.map((issue) => `- ${issue}`)] : []),
  '',
].join('\n')
mkdirSync(dirname(OUT_MD), { recursive: true })
writeFileSync(OUT_MD, md)

console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} 项达标；结果 ${OUT_JSON}`)
if (issues.length) {
  console.error(`\n⚠ ${issues.length} 个问题（基线阶段只记录；加 --enforce 才让退出码非 0）:`)
  for (const issue of issues) console.error(`  - ${issue}`)
  if (args.includes('--enforce')) process.exit(1)
} else {
  console.log('✓ 全部样本达标')
}
