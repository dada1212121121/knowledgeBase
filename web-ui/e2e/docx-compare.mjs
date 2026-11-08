#!/usr/bin/env node
/**
 * DOCX 渲染对照：轻只读（docx-preview，DOM，应用默认的只读预览）vs 画布（引擎整页位图，= 「打印」用的那条路径）
 *
 * 用法（先 npm run build 或 KB_PRECOMPRESS=0 npx vite build）：
 *   node e2e/docx-compare.mjs                              # 默认清单，等间隔抽 10 份（强制含最难的「流程图」）
 *   node e2e/docx-compare.mjs --count=3 --max=2 --out=/tmp/docx-cmp
 *   node e2e/docx-compare.mjs --list=/path/files.txt       # 清单每行一个 docx 路径
 *   node e2e/docx-compare.mjs --self-test                  # 只验证选样规则与丢字计数，不启浏览器
 *
 * 为什么这么选样：不能只挑好看的。按文件大小排序后等间隔取，覆盖几 KB 到几 MB；再强制加上之前唯一被判只读的那份
 * （它是最容易出问题的形状：锚定在空段落里的浮动形状）。规则会打印出来，换一批样本结果可复现。
 *
 * 判据分两类，别混：
 *  - 硬指标（能判对错，退出码依赖它们）：画布打得出来、轻只读没有丢字（对照 docx 原文）、画布每页有内容；
 *  - 软指标（只当线索，不判对错）：页数、两边「有墨」占比之比、像素差异图。
 *    页数为什么不是硬指标：轻只读（docx-preview）只按文档里**显式的**分页符 / 分节符分页，自动分页（内容满一页自动换）它不做，
 *    一份 3 MB、Word 里 14 页的手册，轻只读渲染成「1 页」长条——这是它的设计（整篇分页要引擎排版，正是画布后端存在的理由），
 *    不是故障。我最初把「页数相差悬殊」当硬指标，3 份样本里 2 份误报，才发现两边对「页」的定义不同。
 *    所以只读侧给出「等效页数」（长条高度 ÷ 页高）与画布页数对照，当作线索。
 *    两边用的字体不同（系统字体 vs Carlito / Noto Sans SC 子集），
 *    像素差异永远不会小——要判断谁对，看拼图里的形状 / 表格 / 图片有没有缺、中文有没有叠字。
 * 画布侧的文字是位图，自动化读不出来，「中文不叠字 / 不乱码」只能靠拼图人眼复核（输出目录里有 .png）；这里不假装能自动判。
 *
 * 「疑似缺图」是第三类（警告，不影响退出码）：某页画布的墨量不到轻只读对应段的一半、而轻只读那段有明显内容。
 * 它存在的原因：实测编辑画布不显示文件里的内嵌图片（新插入的也不显示，上游 docx-react 旧岛同样，不是我们的回归；
 * 图片在保存时是保留的），而硬指标只拦「整页几乎空白」，一页里文字都在、只缺了一张图是拦不住的——
 * 第一版全部"通过"，其实 10 份里 4 份手册的图都没画出来。
 * 不做成硬判据，因为两边分页不同会让同一段文字错位，墨量比对不上（第 2 页就是这样，没有图也报了 0.08）；
 * 所以只列出来，并给出「该文档原文有多少张图」，两者同时偏高才值得人去看拼图。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import JSZip from 'jszip'
import { adminMe, ALL_FEATURES, FILES, installFixture } from './fixture.mjs'
import { startStaticServer } from './serve.mjs'
import { COLLECTION } from './editor-helpers.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback
const LIST = flag('list', process.env.KB_DOCX_LIST ?? '/srv/kb/scratch/office-e2e/compat-docx-files.txt')
const COUNT = Number(flag('count', '10'))
const MAX_PAGES = Number(flag('max', '3'))
const OUT = resolve(flag('out', 'e2e/out/docx-compare'))
/** 必含的样本（按文件名子串匹配）：已知最难的一份 */
const MUST_INCLUDE = '营养系统流程图'

mkdirSync(OUT, { recursive: true })

/** 选样规则：按大小升序，等间隔取 COUNT 份；必含项不在其中就替换掉最接近的一份 */
export function pickSamples(files, count, mustInclude) {
  const sized = files.map((file) => ({ file, size: statSync(file).size })).sort((a, b) => a.size - b.size || a.file.localeCompare(b.file))
  if (count >= sized.length) return sized.map((item) => item.file)
  const picked = new Set()
  for (let i = 0; i < count; i += 1) picked.add(sized[Math.round((i * (sized.length - 1)) / (count - 1))].file)
  const must = sized.find((item) => item.file.includes(mustInclude))
  if (must && !picked.has(must.file)) {
    // 替换离它最近（按大小）的那份，保持总数不变
    let closest = null
    for (const file of picked) {
      const gap = Math.abs(statSync(file).size - must.size)
      if (!closest || gap < closest.gap) closest = { file, gap }
    }
    picked.delete(closest.file)
    picked.add(must.file)
  }
  return sized.map((item) => item.file).filter((file) => picked.has(file))
}

/** docx 原文的"真值"：正文所有 w:t 文字（去掉空白后比较，免得段落分隔符造成差异）、图片 / 表格 / 形状个数 */
async function truthOf(bytes) {
  const zip = await JSZip.loadAsync(bytes)
  const raw = await zip.file('word/document.xml').async('string')
  // mc:AlternateContent 把同一个形状写两份：mc:Choice（新格式）和 mc:Fallback（旧格式降级），文字各有一遍。
  // Word 渲染时只用 Choice，不支持才退到 Fallback——所以"真值"只能数一份。第一版两份都数了，
  // 流程图的 64 个字被算成 128，轻只读"丢字 50%"其实是我度量重复计数造成的虚数（真实情况是整张图都没渲染，见拼图）
  const xml = raw.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '')
  const text = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  return {
    text: decode(text).replace(/\s+/g, ''),
    tables: (xml.match(/<w:tbl>/g) ?? []).length,
    drawings: (xml.match(/<w:drawing>/g) ?? []).length + (xml.match(/<w:pict>/g) ?? []).length,
  }
}

/** 计数：轻只读文字里每个字符出现多少次；缺失 = 原文有而轻只读没有的字符数（多出来的不算丢，docx-preview 会生成页码等） */
function missingChars(truth, shown) {
  const have = new Map()
  for (const ch of shown) have.set(ch, (have.get(ch) ?? 0) + 1)
  let missing = 0
  const lost = new Map()
  for (const ch of truth) {
    const n = have.get(ch) ?? 0
    if (n > 0) have.set(ch, n - 1)
    else {
      missing += 1
      lost.set(ch, (lost.get(ch) ?? 0) + 1)
    }
  }
  return { missing, lost: [...lost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([ch, n]) => `${ch}×${n}`) }
}

/** 拼图 + 度量放在页面里做（没有 Node 图像库可用，package.json 也不能动；与 pptx-compare 同一做法） */
const COMPOSE = async ({ light, canvas }) => {
  const load = (src) =>
    new Promise((resolveImage, reject) => {
      const image = new Image()
      image.onload = () => resolveImage(image)
      image.onerror = () => reject(new Error('图片解码失败'))
      image.src = src
    })
  const [a, b] = await Promise.all([load(light), load(canvas)])
  const W = 700
  const H = Math.round((b.naturalHeight * W) / b.naturalWidth)
  const draw = (image) => {
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const x = c.getContext('2d', { willReadFrequently: true })
    x.fillStyle = '#fff'
    x.fillRect(0, 0, W, H)
    x.drawImage(image, 0, 0, W, Math.round((image.naturalHeight * W) / image.naturalWidth))
    return { c, x }
  }
  const A = draw(a)
  const B = draw(b)
  // 轻只读那块可能不到一整页高（容器可见高度有限）：有墨占比只在两边都有内容的高度范围内统计，否则两边分母不同、没法比
  const compareH = Math.max(1, Math.min(H, Math.round((a.naturalHeight * W) / a.naturalWidth)))
  const da = A.x.getImageData(0, 0, W, compareH).data
  const db = B.x.getImageData(0, 0, W, compareH).data
  const diff = document.createElement('canvas')
  diff.width = W
  diff.height = H
  const dx = diff.getContext('2d')
  const out = dx.createImageData(W, compareH)
  let inkA = 0
  let inkB = 0
  let differing = 0
  for (let i = 0; i < da.length; i += 4) {
    const ia = da[i] < 160 || da[i + 1] < 160 || da[i + 2] < 160
    const ib = db[i] < 160 || db[i + 1] < 160 || db[i + 2] < 160
    if (ia) inkA += 1
    if (ib) inkB += 1
    if (ia !== ib) differing += 1
    // 两边都有墨：灰；只有轻只读有：红；只有画布有：蓝；都没有：白
    const [r, g, bl] = ia && ib ? [150, 150, 150] : ia ? [230, 60, 60] : ib ? [60, 90, 230] : [255, 255, 255]
    out.data[i] = r
    out.data[i + 1] = g
    out.data[i + 2] = bl
    out.data[i + 3] = 255
  }
  dx.putImageData(out, 0, 0)
  // 超出比较范围的部分涂浅灰，一眼能看出"这一段没参与比较"（必须在拼进 sheet 之前涂，先前顺序放反了没生效）
  dx.fillStyle = '#e4e4e4'
  dx.fillRect(0, compareH, W, H - compareH)
  const sheet = document.createElement('canvas')
  sheet.width = W * 3 + 20
  sheet.height = H
  const sx = sheet.getContext('2d')
  sx.fillStyle = '#888'
  sx.fillRect(0, 0, sheet.width, H)
  sx.drawImage(A.c, 0, 0)
  sx.drawImage(B.c, W + 10, 0)
  sx.drawImage(diff, W * 2 + 20, 0)
  const total = W * compareH
  return { sheet: sheet.toDataURL('image/png'), inkLight: inkA / total, inkCanvas: inkB / total, diffRatio: differing / total }
}

if (args.includes('--self-test')) {
  // 只验证选样规则与丢字计数，不启浏览器：规则错了，后面"10 份"的结论就不可信
  const { mkdtempSync, writeFileSync: write } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(resolve(tmpdir(), 'docx-cmp-'))
  const make = (name, size) => {
    const path = resolve(dir, name)
    write(path, Buffer.alloc(size))
    return path
  }
  const all = [make('a.docx', 10), make('b.docx', 20), make('营养系统流程图.docx', 30), make('d.docx', 40), make('e.docx', 50), make('f.docx', 60), make('g.docx', 70)]
  const check = (ok, what) => {
    if (!ok) {
      console.error(`✗ 自检失败：${what}`)
      process.exit(1)
    }
  }
  const three = pickSamples(all, 3, MUST_INCLUDE)
  check(three.length === 3, `抽 3 份应得 3 份，实际 ${three.length}`)
  check(three.some((file) => file.includes(MUST_INCLUDE)), '必含项没有被选上')
  check(JSON.stringify(pickSamples(all, 3, MUST_INCLUDE)) === JSON.stringify(three), '同样的输入应得同样的结果（可复现）')
  const sizes = three.map((file) => statSync(file).size)
  check(sizes.every((size, i) => i === 0 || size >= sizes[i - 1]), '结果应按大小升序')
  check(pickSamples(all, 99, MUST_INCLUDE).length === all.length, '要的比有的多时，全取')
  const noMust = pickSamples(all.filter((file) => !file.includes(MUST_INCLUDE)), 3, MUST_INCLUDE)
  check(noMust.length === 3, '清单里没有必含项时不该多塞或报错')
  const lost = missingChars('你好世界ab', '你好ab')
  check(lost.missing === 2 && lost.lost.join() === '世×1,界×1', `丢字计数错：${JSON.stringify(lost)}`)
  check(missingChars('aab', 'aaab').missing === 0, '轻只读多出来的字符（页码等）不算丢')
  check(missingChars('aab', 'ab').missing === 1, '同一字符出现次数少了要算丢')
  console.log('✓ docx-compare 自检通过（选样规则、必含项、可复现、丢字计数）')
  process.exit(0)
}

const files = readFileSync(LIST, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
const samples = pickSamples(files, COUNT, MUST_INCLUDE)
console.log(`清单 ${files.length} 份，按大小升序等间隔抽 ${samples.length} 份（必含「${MUST_INCLUDE}」）：`)
for (const file of samples) console.log(`  ${String(statSync(file).size).padStart(8)} B  ${basename(file)}`)

FILES.file_docx.item.origin = 'upload'
FILES.file_docx.preview.origin = 'upload'
const { server, base } = await startStaticServer()
const browser = await chromium.launch({ chromiumSandbox: false })
const rows = []

/** 处理一份样本；中途失败用 return 提前结束（finally 负责关上下文），日志由调用方统一打印 */
async function runOne(file, index) {
    const bytes = readFileSync(file)
    const row = { index: index + 1, name: basename(file), size: bytes.length, hard: [], note: '' }
    rows.push(row)
    const tag = `${String(index + 1).padStart(2, '0')}`
    process.env.KB_SAMPLE_DOCX = file
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', serviceWorkers: 'block' })
    try {
      await installFixture(context, {
        __me: { local: false, user: adminMe(ALL_FEATURES.filter((id) => id !== 'collab.edit'), true) },
        file_info: () => ({ sha256: 'cmp', origin: 'upload', max_replace_bytes: 256 * 1024 * 1024 }),
      })
      const tab = await context.newPage()
      const errors = []
      tab.on('pageerror', (error) => errors.push(error.message.slice(0, 160)))
      // 打印窗口：包装 window.open，把开出的窗口记下来；print 换成假实现（headless 下真调会阻塞）
      await tab.addInitScript(() => {
        window.__printWins = []
        const open = window.open.bind(window)
        window.open = (...a) => {
          const win = open(...a)
          if (win) {
            win.__printCalls = 0
            win.print = () => (win.__printCalls += 1)
            window.__printWins.push(win)
          }
          return win
        }
      })

      // ---- 真值 ----
      const truth = await truthOf(bytes)
      row.truth = { chars: truth.text.length, tables: truth.tables, drawings: truth.drawings }

      // ---- 轻只读（默认路由，不点编辑）----
      const t0 = Date.now()
      await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_docx`, { waitUntil: 'domcontentloaded' })
      await tab.waitForSelector('.kbdocx-wrapper section.kbdocx', { timeout: 90_000 })
      await tab.waitForTimeout(1500)
      row.lightMs = Date.now() - t0
      const light = await tab.evaluate(() => {
        const sections = [...document.querySelectorAll('.kbdocx-wrapper > section.kbdocx')]
        return {
          pages: sections.length,
          text: sections.map((s) => s.textContent ?? '').join('').replace(/\s+/g, ''),
          tables: document.querySelectorAll('.kbdocx-wrapper table').length,
          images: document.querySelectorAll('.kbdocx-wrapper img, .kbdocx-wrapper svg image').length,
        }
      })
      row.light = { pages: light.pages, tables: light.tables, images: light.images }
      // 轻只读的"页"是整篇长条：用画布页的宽高比把它切成等效页（第 k 页 = 长条里 [k·r·w, (k+1)·r·w) 这一段）
      const strip = await tab.evaluate(() => {
        const first = document.querySelector('.kbdocx-wrapper > section.kbdocx')
        const rect = first.getBoundingClientRect()
        const all = [...document.querySelectorAll('.kbdocx-wrapper > section.kbdocx')].map((s) => s.getBoundingClientRect().height)
        return { width: rect.width, heights: all }
      })
      row.light.stripHeights = strip.heights.map((h) => Math.round(h))
      const lost = missingChars(truth.text, light.text)
      row.lightMissing = lost.missing
      row.lightMissingRate = truth.text.length ? lost.missing / truth.text.length : 0
      row.lightLost = lost.lost
      // ---- 画布：点「在线编辑」→「打印」，读弹窗里的整页位图 ----
      const t1 = Date.now()
      await tab.click('[data-testid="office-edit-open"]', { timeout: 30_000 })
      // 只读判定（blocked）的文档也会进只读画布；等画布出现或出错
      const opened = await Promise.race([
        tab.waitForSelector('.kb-office-host canvas', { state: 'visible', timeout: 150_000 }).then(() => 'ok'),
        tab.waitForSelector('[data-testid="office-error"]', { state: 'visible', timeout: 150_000 }).then(() => 'error'),
      ]).catch(() => 'timeout')
      if (opened !== 'ok') {
        row.hard.push(`画布没有打开（${opened}）`)
        row.note = opened === 'error' ? (await tab.locator('[data-testid="office-error"]').innerText()).slice(0, 160) : ''
        return row
      }
      while (await tab.locator('[data-testid="office-veil"]').count()) await tab.waitForTimeout(50)
      await tab.waitForTimeout(1500)
      row.canvasOpenMs = Date.now() - t1
      const printButton = tab.locator('[data-testid="editor-toolbar-slot"] [data-action="docx.print"]')
      if (await printButton.count()) await printButton.first().click()
      else {
        await tab.click('[data-testid="editor-toolbar-more"]')
        await tab.click('[data-testid="editor-toolbar-more-menu"] [data-action="docx.print"]')
      }
      const t2 = Date.now()
      const printed = await (async () => {
        const deadline = Date.now() + 180_000
        while (Date.now() < deadline) {
          if (await tab.evaluate(() => window.__printWins.length >= 1 && window.__printWins[0].__printCalls >= 1)) return true
          if (await tab.locator('[data-testid="editor-command-notice"]').count()) return false
          await tab.waitForTimeout(300)
        }
        return false
      })()
      row.printMs = Date.now() - t2
      if (!printed) {
        row.hard.push('画布打不出整页位图（打印没有完成）')
        row.note = ((await tab.locator('[data-testid="editor-command-notice"]').first().textContent().catch(() => '')) ?? '').slice(0, 160)
        return row
      }
      const canvasShots = await tab.evaluate(() => [...window.__printWins[0].document.querySelectorAll('img')].map((image) => image.src))
      row.canvas = { pages: canvasShots.length }

      // ---- 轻只读逐段截图（要画布页的宽高比才知道每段多高，所以放在画布出图之后）----
      // 文档在 .kb-pgs-scroll 这个滚动容器里（可见高度只有七百多像素，内容上万像素）。第一版用 fullPage + 文档坐标 clip，
      // 浏览器只渲染容器可见的那一段，超出部分截到的是外壳和状态栏——拼图里一条黑条横在页面中间才发现。
      // 所以必须：把容器滚到每页的起点，只截容器里文档那一块。
      const canvasRatio = await tab.evaluate((src) => new Promise((resolveRatio) => { const i = new Image(); i.onload = () => resolveRatio(i.naturalHeight / i.naturalWidth); i.src = src }), canvasShots[0])
      await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_docx`, { waitUntil: 'domcontentloaded' })
      await tab.waitForSelector('.kbdocx-wrapper section.kbdocx', { timeout: 90_000 })
      await tab.waitForTimeout(1500)
      const lightShots = []
      const wantPages = Math.min(MAX_PAGES, canvasShots.length)
      for (let page = 0; page < wantPages; page += 1) {
        const view = await tab.evaluate(
          ({ ratio, page }) => {
            const scroller = document.querySelector('.kb-pgs-scroll')
            const section = document.querySelector('.kbdocx-wrapper > section.kbdocx')
            const sectionTop = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
            const width = section.getBoundingClientRect().width
            const sliceHeight = ratio * width
            // 一屏装不下一整页时只截可见高度那一块（等效页的上半部分）：软指标只是线索，不值得为它调整视口
            scroller.scrollTop = sectionTop + page * sliceHeight
            const box = scroller.getBoundingClientRect()
            const sectionBox = section.getBoundingClientRect()
            return { x: sectionBox.left, y: box.top, width, height: Math.min(sliceHeight, box.height), sliceHeight, past: sectionBox.bottom < box.top + 4 }
          },
          { ratio: canvasRatio, page },
        )
        if (view.past) break
        await tab.waitForTimeout(250)
        const shot = await tab.screenshot({ clip: { x: view.x, y: view.y, width: view.width, height: view.height } })
        lightShots.push({ dataUrl: 'data:image/png;base64,' + shot.toString('base64'), coverage: view.height / view.sliceHeight })
      }
      row.lightShotCoverage = lightShots.map((shot) => Number(shot.coverage.toFixed(2)))

      // ---- 硬指标 ----
      if (row.lightMissingRate > 0.02) row.hard.push(`轻只读丢字 ${(row.lightMissingRate * 100).toFixed(1)}%（${lost.missing}/${truth.text.length}）`)
      if (errors.length) row.hard.push(`页面异常：${errors[0]}`)

      // ---- 拼图（前 MAX_PAGES 页）+ 软指标 ----
      const sheetCount = Math.min(lightShots.length, canvasShots.length)
      const composes = []
      for (let page = 0; page < sheetCount; page += 1) {
        const composed = await tab.evaluate(COMPOSE, { light: lightShots[page].dataUrl, canvas: canvasShots[page] })
        composes.push({ inkLight: composed.inkLight, inkCanvas: composed.inkCanvas, diffRatio: composed.diffRatio })
        writeFileSync(resolve(OUT, `${tag}-p${page + 1}.png`), Buffer.from(composed.sheet.split(',')[1], 'base64'))
        // 画布每页必须有内容；整页没墨（空白页）是硬伤——但文档本身的空白页（只有分页符）也会如此，所以只在轻只读对应段有墨时才算
        if (composed.inkCanvas < composed.inkLight * 0.5 && composed.inkLight > 0.01) row.suspects = [...(row.suspects ?? []), page + 1]
        if (composed.inkCanvas < 0.0005 && composed.inkLight > 0.002) row.hard.push(`第 ${page + 1} 页画布几乎空白而轻只读有内容（墨 ${(composed.inkCanvas * 100).toFixed(2)}% vs ${(composed.inkLight * 100).toFixed(2)}%）`)
      }
      // 等效页数：长条高度 ÷（画布页高宽比 × 长条宽度）。轻只读没有自动分页，所以这是它「如果分页会是几页」的估计，仅作线索
      row.light.equivalentPages = Number((strip.heights.reduce((a, b) => a + b, 0) / (canvasRatio * strip.width)).toFixed(1))
      row.pages = composes.map((item, page) => ({
        page: page + 1,
        inkLight: Number((item.inkLight * 100).toFixed(2)),
        inkCanvas: Number((item.inkCanvas * 100).toFixed(2)),
        inkRatio: item.inkLight > 0 ? Number((item.inkCanvas / item.inkLight).toFixed(2)) : null,
        diffPct: Number((item.diffRatio * 100).toFixed(1)),
      }))
    } catch (error) {
      row.hard.push(`脚本异常：${String(error.message ?? error).slice(0, 200)}`)
    } finally {
      delete process.env.KB_SAMPLE_DOCX
      await context.close()
    }
    return row
}

try {
  for (const [index, file] of samples.entries()) {
    const row = await runOne(file, index)
    console.log(
      `${row.hard.length ? '✗' : '✓'} ${String(row.index).padStart(2)} ${row.name.slice(0, 28).padEnd(28)} 轻只读 ${row.light?.pages ?? '-'} 段（等效 ${row.light?.equivalentPages ?? '-'} 页）/ 画布 ${row.canvas?.pages ?? '-'} 页` +
        `，丢字 ${row.lightMissing ?? '-'}/${row.truth?.chars ?? '-'}，轻只读 ${row.lightMs ?? '-'} ms，画布打开 ${row.canvasOpenMs ?? '-'} ms + 出图 ${row.printMs ?? '-'} ms` +
        (row.hard.length ? `\n     ${row.hard.join('\n     ')}` : '') +
        (row.note ? `\n     原因：${row.note}` : '') +
        (row.suspects?.length ? `\n     ⚠ 疑似缺图的页：${row.suspects.join('、')}（画布墨量不到轻只读的一半；原文有 ${row.truth?.drawings ?? '?'} 个图片 / 形状）` : ''),
    )
  }
} finally {
  await browser.close()
  server.close()
}

const failed = rows.filter((row) => row.hard.length)
const suspectsRows = rows.filter((row) => row.suspects?.length)
writeFileSync(resolve(OUT, 'summary.json'), JSON.stringify({ list: LIST, count: samples.length, rows }, null, 2))
const md = [
  '# DOCX 渲染对照：轻只读（docx-preview）vs 画布（引擎整页位图）',
  '',
  `抽样 ${samples.length} 份（按大小等间隔 + 必含「${MUST_INCLUDE}」），每份前 ${MAX_PAGES} 页拼图在同目录：左 轻只读 | 中 画布 | 右 差异（灰=两边都有，红=仅轻只读，蓝=仅画布）。`,
  '像素差异只是线索：两边字体不同，永远有差；要判断谁对，看拼图里形状 / 表格 / 图片有没有缺、中文有没有叠字。',
  '',
  '| # | 文档 | 大小 | 原文图片 | 轻只读等效页 | 画布页 | 轻只读丢字 | 墨比(画布/轻只读) | 疑似缺图页 | 轻只读 ms | 画布打开 ms | 出图 ms | 结论 |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((row) => {
    const ink = row.pages?.length ? row.pages.map((item) => item.inkRatio ?? '-').join('/') : '-'
    return `| ${row.index} | ${row.name} | ${(row.size / 1024).toFixed(0)} KB | ${row.truth?.drawings ?? '-'} | ${row.light?.equivalentPages ?? '-'} | ${row.canvas?.pages ?? '-'} | ${row.lightMissing ?? '-'}/${row.truth?.chars ?? '-'} | ${ink} | ${row.suspects?.join('、') ?? '-'} | ${row.lightMs ?? '-'} | ${row.canvasOpenMs ?? '-'} | ${row.printMs ?? '-'} | ${row.hard.length ? '✗ ' + row.hard.join('；') : '✓'} |`
  }),
  '',
  failed.length ? `**${failed.length} 份有硬伤**` : '**全部通过硬指标**（画布打得出来、轻只读不丢字、画布没有整页空白）。',
  suspectsRows.length
    ? `\n**⚠ ${suspectsRows.length} 份有疑似缺图的页**（见上表「疑似缺图页」）：硬指标拦不住「文字在、只缺图」，这些请看拼图确认。已知原因：编辑画布不显示文件里的内嵌图片，保存时图片是保留的。`
    : '',
  '\n中文叠字 / 乱码请人眼看拼图，自动化读不出画布上的字。',
].join('\n')
writeFileSync(resolve(OUT, 'summary.md'), md)
console.log(`\n${failed.length ? `✗ ${failed.length}/${rows.length} 份有硬伤` : `✓ ${rows.length}/${rows.length} 份通过硬指标`}${suspectsRows.length ? `，⚠ ${suspectsRows.length} 份有疑似缺图的页（硬指标拦不住这类）` : ''}；拼图与报告：${OUT}`)
process.exit(failed.length ? 1 : 0)
