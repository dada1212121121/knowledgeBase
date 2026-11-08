#!/usr/bin/env node
/**
 * PPTX 原生编辑 e2e
 *
 * 在真实构建上用真实引擎（Worker + WASM）验证：打开即编辑、文字输入（含输入法）、拖动 / 缩放、插入形状 / 图片、
 * 层级 / 对齐、撤销重做、备注、保存请求的字节（改一处只有目标 slide XML 变）、冲突 / 只读 / 不无损 / 回退旧岛、
 * 10+ 份 deck「不改保存」每个部件逐字节相同、30 页切页 < 100 ms。
 *
 * 用法：
 *   npm run build && node e2e/editor-pptx-edit.mjs [--only=id1,id2]
 * 服务端替身在 e2e/fixture.mjs（files/lock、files/replace、files/roundtrip-check），不需要守护进程。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import JSZip from 'jszip'
import { contextOptions, launch } from './devices.mjs'
import { FILES, installFixture } from './fixture.mjs'
import { SOLO_EDIT_FIXTURE } from './editor-helpers.mjs'
import { startStaticServer } from './serve.mjs'
import { axeIssues } from './axe-helpers.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const COLLECTION = 'knowledgeBase%2Finsights'
const DECK = join(ROOT, 'e2e/fixtures/editor/deck-30p.pptx')
const LATIN = join(ROOT, 'e2e/fixtures/editor/deck-latin-8p.pptx')
const PNG = join(ROOT, 'e2e/fixtures/editor/doc-image.png')
const ONLY = (process.argv.find((arg) => arg.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await wait(50)
  }
  return false
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

/** 部件级对照：两个 zip 里哪些部件内容变了 / 新增 / 删除 */
async function diffParts(before, after) {
  const read = async (buffer) => {
    const zip = await JSZip.loadAsync(buffer)
    const parts = new Map()
    for (const [name, file] of Object.entries(zip.files)) if (!file.dir) parts.set(name, Buffer.from(await file.async('uint8array')))
    return parts
  }
  const [a, b] = await Promise.all([read(before), read(after)])
  const changed = []
  const removed = []
  const added = []
  for (const [name, bytes] of a) {
    if (!b.has(name)) removed.push(name)
    else if (!bytes.equals(b.get(name))) changed.push(name)
  }
  for (const name of b.keys()) if (!a.has(name)) added.push(name)
  return { changed: changed.sort(), removed: removed.sort(), added: added.sort() }
}
const partText = async (buffer, name) => (await JSZip.loadAsync(buffer)).file(name)?.async('string')

/** zip 里每个条目压缩数据所在的字节区间（用来确认两份包的字节差异只在头部元数据里，不在内容里） */
function dataRanges(buffer) {
  let eocd = -1
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new Error('不是 zip')
  const count = buffer.readUInt16LE(eocd + 10)
  let at = buffer.readUInt32LE(eocd + 16)
  const ranges = []
  for (let i = 0; i < count; i += 1) {
    const compressed = buffer.readUInt32LE(at + 20)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const local = buffer.readUInt32LE(at + 42)
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    ranges.push([start, start + compressed])
    at += 46 + nameLength + extraLength + commentLength
  }
  return ranges
}

const asUpload = () => {
  FILES.file_pptx.item.origin = 'upload'
  FILES.file_pptx.preview.origin = 'upload'
}

let engineBase = ''

/** 打开编辑：点页面上的「在线编辑」，等引擎起来、第一页画出来 */
async function openEdit(tab, extra = '', deck = DECK, expect = 'true') {
  process.env.KB_SAMPLE_PPTX = deck
  await tab.goto(`${engineBase}/kb?collection=${COLLECTION}&item=file_pptx${extra}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="office-edit-open"]', { timeout: 30_000 })
  await tab.click('[data-testid="office-edit-open"]')
  await tab.waitForSelector('[data-testid="office-native-host"] [data-testid="slide-surface"][data-state="ready"]', { timeout: 60_000 })
  await tab.waitForFunction(() => Number(document.querySelector('[data-testid="slide-surface"]')?.dataset.painted) >= 1, null, { timeout: 20_000 })
  // 画面先出来、无损预检在后台做：检查通过才放开编辑，所以要等到编辑标志到位
  if (expect) await tab.waitForFunction((want) => document.querySelector('[data-testid="slide-surface"]')?.dataset.editing === want, expect, { timeout: 30_000 })
}

/** 幻灯片坐标 → 页面坐标 */
async function toPage(tab, x, y) {
  const box = await tab.locator('.kb-sl-sheet').boundingBox()
  const k = box.width / 1280
  return { x: box.x + x * k, y: box.y + y * k, k }
}
async function clickSlide(tab, x, y, options = {}) {
  const at = await toPage(tab, x, y)
  await tab.mouse.click(at.x, at.y, options)
}
async function dragSlide(tab, from, to, steps = 8) {
  const a = await toPage(tab, from.x, from.y)
  const b = await toPage(tab, to.x, to.y)
  await tab.mouse.move(a.x, a.y)
  await tab.mouse.down()
  await tab.mouse.move(b.x, b.y, { steps })
  await tab.mouse.up()
}
const slideNow = (tab) => tab.evaluate(() => Number(document.querySelector('[data-testid="slide-surface"]').dataset.slide))
const srText = (tab) => tab.evaluate(() => document.querySelector('[data-testid="slide-sr"]')?.textContent ?? '')
const inputReady = (tab) => tab.waitForSelector('[data-testid="slide-input"]', { timeout: 5000 })
const savedCount = (office) => office.replaces?.length ?? 0

/** 点保存，等服务端替身收到 replace；返回最后一次保存的字节 */
async function save(tab, office) {
  const before = savedCount(office)
  await tab.click('[data-testid="editor-save"]')
  if (!(await waitFor(() => savedCount(office) > before, 20_000))) throw new Error('点保存后没有发出 replace 请求')
  return office.replaces.at(-1)
}

const original = (path = DECK) => readFileSync(path)

const SCENARIOS = {
  'open-native': {
    title: '打开即原生编辑：幻灯片编辑面 + 编辑工具栏；先做了一次不改保存的无损预检',
    async run(tab, { office }) {
      const resources = []
      tab.on('request', (request) => resources.push(request.url()))
      await openEdit(tab)
      const info = await tab.evaluate(() => ({
        editing: document.querySelector('[data-testid="slide-surface"]')?.dataset.editing,
        bar: !!document.querySelector('[data-testid="slide-editbar"]'),
        layer: !!document.querySelector('[data-testid="slide-edit-layer"]'),
        legacy: !!document.querySelector('.kb-office-host:not(.kb-office-native)'),
        save: !!document.querySelector('[data-testid="editor-save"]'),
        readonlyTag: !!document.querySelector('[data-testid="office-readonly"]'),
      }))
      const issues = []
      if (info.editing !== 'true') issues.push(`不是可编辑态：${info.editing}`)
      if (!info.bar || !info.layer) issues.push('缺编辑工具栏或编辑层')
      if (info.legacy) issues.push('外壳之外还挂着别的编辑容器')
      if (!info.save) issues.push('缺外壳的保存按钮')
      if (info.readonlyTag) issues.push('不该是只读')
      if ((office.roundtrips?.length ?? 0) !== 1) issues.push(`无损预检应恰好一次：${office.roundtrips?.length}`)
      const names = resources.map((url) => basename(new URL(url).pathname))
      if (names.some((name) => /react-dom|PptxEditor|pptx-react/i.test(name))) issues.push(`加载了 React 相关资源：${names.filter((n) => /react-dom|PptxEditor|pptx-react/i.test(n)).join(',')}`)
      if (!names.some((name) => /pptxSessionWorker/.test(name))) issues.push('没有起引擎 Worker 会话')
      return issues
    },
  },

  'check-in-background': {
    title: '无损预检在后台做：预检回应之前画面已经出来但只读；回应后放开编辑；预检失败（网络）保持只读并说明',
    async run(tab, { office }) {
      // 把预检的回应拖住：用 context 路由截获，手动放行
      let release = () => undefined
      const gate = new Promise((resolve) => (release = resolve))
      await tab.context().route('**/api/v1/files/roundtrip-check*', async (route) => {
        await gate
        await route.fallback()
      })
      await openEdit(tab, '', DECK, 'readonly')
      const issues = []
      if (!(await tab.locator('[data-testid="office-checking"]').count())) issues.push('预检进行中应显示"正在检查…"')
      if (await tab.locator('[data-testid="slide-edit-layer"]').count()) issues.push('预检没回应前不该能编辑')
      if (!(await tab.locator('[data-testid="slide-canvas"]').count())) issues.push('预检没回应前画面应已经出来')
      release()
      await waitFor(async () => (await tab.locator('[data-testid="slide-surface"]').getAttribute('data-editing')) === 'true', 20_000).then((ok) => ok || issues.push('预检回应后没有放开编辑'))
      if ((office.roundtrips?.length ?? 0) !== 1) issues.push(`预检应恰好一次：${office.roundtrips?.length}`)
      return issues
    },
  },

  'check-fails': {
    // 请求被我们主动掐断，浏览器会在控制台记一条网络错误
    allowConsole: /ERR_FAILED/,
    title: '无损预检请求失败（网络 / 服务端）：保持只读并说清楚，不会在没验证的情况下放开编辑',
    async run(tab) {
      await tab.context().route('**/api/v1/files/roundtrip-check*', (route) => route.abort())
      await openEdit(tab, '', DECK, 'readonly')
      const issues = []
      const error = await tab.waitForSelector('[data-testid="office-error"]', { timeout: 20_000 }).then((el) => el.textContent(), () => '')
      if (!error?.includes('只读')) issues.push(`没有说明保持只读：${error}`)
      await wait(500)
      if ((await tab.locator('[data-testid="slide-surface"]').getAttribute('data-editing')) !== 'readonly') issues.push('检查失败后不该放开编辑')
      return issues
    },
  },

  'text-save': {
    title: '点标题键入 → 保存：replace 请求带原哈希与 session；只有 slide1.xml 变，里面有新字',
    async run(tab, { office }) {
      await openEdit(tab)
      await clickSlide(tab, 520, 90)
      await inputReady(tab)
      await tab.keyboard.type('ABC')
      await waitFor(async () => (await srText(tab)).includes('ABC'))
      const issues = []
      if (!(await tab.locator('[data-testid="office-dirty"]').count())) issues.push('有改动但外层没有未保存提示')
      const request = await save(tab, office)
      if (request.expected !== 'sha-fixture-original') issues.push(`保存没带原始哈希：${request.expected}`)
      if (!request.session) issues.push('保存没带编辑权 session')
      if (!request.zip) issues.push('保存的字节不是 ZIP')
      const diff = await diffParts(original(), request.body)
      if (diff.changed.join() !== 'ppt/slides/slide1.xml' || diff.removed.length || diff.added.length) issues.push(`被改动的部件不止目标页：${JSON.stringify(diff)}`)
      const xml = (await partText(request.body, 'ppt/slides/slide1.xml')) ?? ''
      if (!xml.includes('ABC')) issues.push('slide1.xml 里没有新键入的字')
      // 新字要沿用相邻文字的颜色（深色背景上不能敲出黑字）
      if (!/E7E8F0/i.test(xml.slice(xml.indexOf('ABC') - 400, xml.indexOf('ABC')))) issues.push('新键入的文字没有沿用相邻文字的颜色')
      await waitFor(async () => !(await tab.locator('[data-testid="office-dirty"]').count()), 5000).then((ok) => ok || issues.push('保存后仍显示未保存'))
      return issues
    },
  },

  'move-save': {
    title: '拖动正文框 → 保存：只有 slide1.xml 变，位置是 +100px / +40px 对应的 EMU',
    async run(tab, { office }) {
      await openEdit(tab)
      // 正文框在 (0.9in, 2.2in) = (86.4px, 211.2px)，11.5in × 3.4in；抓它左边框内侧 3px 处
      await clickSlide(tab, 88, 300)
      // 间隔超过双击时间（400 ms），否则第二次按下会被当成双击进入文字编辑（PowerPoint 也是这样）
      await wait(600)
      // 按住 Alt 拖动不吸附：位移才是精确的 +100px / +40px（吸附本身在单测和 snap 场景里验）
      await tab.keyboard.down('Alt')
      await dragSlide(tab, { x: 88, y: 300 }, { x: 188, y: 340 })
      await tab.keyboard.up('Alt')
      const issues = []
      const request = await save(tab, office)
      const diff = await diffParts(original(), request.body)
      if (diff.changed.join() !== 'ppt/slides/slide1.xml' || diff.removed.length || diff.added.length) issues.push(`被改动的部件不止目标页：${JSON.stringify(diff)}`)
      const xml = (await partText(request.body, 'ppt/slides/slide1.xml')) ?? ''
      // 822960 + 100px*9525 = 1775460；2011680 + 40px*9525 = 2392680
      if (!xml.includes('<a:off x="1775460" y="2392680"/>')) issues.push(`正文框位置不对：${(xml.match(/<a:off [^>]*>/g) ?? []).join(' ')}`)
      return issues
    },
  },

  'resize-save': {
    title: '拖东南角缩放正文框 → 保存：宽高按拖动量改变，起点不动',
    async run(tab, { office }) {
      await openEdit(tab)
      await clickSlide(tab, 88, 300)
      const handle = tab.locator('[data-handle="se"]')
      const hb = await handle.boundingBox()
      await tab.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
      await tab.mouse.down()
      const k = (await toPage(tab, 0, 0)).k
      await tab.mouse.move(hb.x + hb.width / 2 - 100 * k, hb.y + hb.height / 2 - 50 * k, { steps: 6 })
      await tab.mouse.up()
      const issues = []
      const request = await save(tab, office)
      const xml = (await partText(request.body, 'ppt/slides/slide1.xml')) ?? ''
      // 11.5in = 10515600，3.4in = 3108960；各缩 100px / 50px = 952500 / 476250
      if (!xml.includes('<a:ext cx="9563100" cy="2632710"/>')) issues.push(`缩放后尺寸不对：${(xml.match(/<a:ext [^>]*>/g) ?? []).join(' ')}`)
      const diff = await diffParts(original(), request.body)
      if (diff.changed.join() !== 'ppt/slides/slide1.xml') issues.push(`被改动的部件不止目标页：${JSON.stringify(diff)}`)
      return issues
    },
  },

  'ime': {
    title: '输入法（CDP imeSetComposition）：组字期间只显示预编辑文字、文档不变；上屏后文字正确；取消组字不留痕；保存里是汉字',
    async run(tab, { office }) {
      await openEdit(tab)
      await clickSlide(tab, 520, 90)
      await inputReady(tab)
      const cdp = await tab.context().newCDPSession(tab)
      const issues = []
      const before = await srText(tab)
      await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
      await cdp.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 })
      await tab.waitForSelector('[data-testid="slide-preedit"]', { timeout: 3000 }).catch(() => issues.push('组字时没有显示预编辑文字'))
      if ((await srText(tab)) !== before) issues.push('组字期间文档被改了')
      await cdp.send('Input.insertText', { text: '中文' })
      await waitFor(async () => (await srText(tab)).includes('中文'))
      if (!(await srText(tab)).includes('中文')) issues.push('上屏后文档里没有「中文」')
      if (await tab.$('[data-testid="slide-preedit"]')) issues.push('上屏后预编辑文字没有消失')
      if (/zhong/.test(await srText(tab))) issues.push('拼音字母残留在文档里')
      // 取消组字:开始组字再结束(空文本)
      const after = await srText(tab)
      await cdp.send('Input.imeSetComposition', { text: 'abc', selectionStart: 3, selectionEnd: 3 })
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
      await wait(200)
      if ((await srText(tab)) !== after) issues.push('取消组字后文档变了')
      // 英文键入照常
      await tab.keyboard.type('Q')
      await waitFor(async () => (await srText(tab)).includes('Q'))
      const request = await save(tab, office)
      const xml = (await partText(request.body, 'ppt/slides/slide1.xml')) ?? ''
      if (!xml.includes('中文')) issues.push('保存的 slide1.xml 里没有「中文」')
      if (/zhong/.test(xml)) issues.push('保存的 XML 里有拼音残留')
      const diff = await diffParts(original(), request.body)
      if (diff.changed.join() !== 'ppt/slides/slide1.xml') issues.push(`被改动的部件不止目标页：${JSON.stringify(diff)}`)
      return issues
    },
  },

  'undo-redo': {
    title: '撤销 / 重做：外壳按钮与 Ctrl+Z / Ctrl+Shift+Z；键入 → 撤销 → 重做',
    async run(tab) {
      await openEdit(tab)
      await clickSlide(tab, 520, 90)
      await inputReady(tab)
      await tab.keyboard.type('XYZ')
      await waitFor(async () => (await srText(tab)).includes('XYZ'))
      const issues = []
      await tab.click('[data-testid="editor-undo"]')
      await waitFor(async () => !(await srText(tab)).includes('XYZ'))
      if ((await srText(tab)).includes('XYZ')) issues.push('点撤销后文字还在')
      await tab.click('[data-testid="editor-redo"]')
      await waitFor(async () => (await srText(tab)).includes('XYZ'))
      if (!(await srText(tab)).includes('XYZ')) issues.push('点重做后文字没有回来')
      await tab.focus('[data-testid="slide-input"]').catch(() => undefined)
      await tab.keyboard.press('Control+z')
      await waitFor(async () => !(await srText(tab)).includes('XYZ'))
      if ((await srText(tab)).includes('XYZ')) issues.push('Ctrl+Z 没有撤销')
      return issues
    },
  },

  'insert-shapes': {
    title: '插入文本框 / 形状 / 图片，调层级与对齐，替换与删除 → 保存：只有第 1 页相关部件变，XML 里有新元素与媒体',
    async run(tab, { office }) {
      await openEdit(tab)
      const issues = []
      await tab.click('[data-testid="slide-add-textbox"]')
      await inputReady(tab)
      await tab.keyboard.type('New box')
      await waitFor(async () => (await srText(tab)).includes('New box'))
      await tab.keyboard.press('Escape')
      await tab.click('[data-testid="slide-add-shape"]')
      await tab.click('[data-preset="ellipse"]')
      await tab.setInputFiles('[data-testid="slide-picture-input"]', PNG)
      await waitFor(async () => (await tab.locator('[data-handle="se"]').count()) > 0)
      await tab.click('[data-testid="slide-z-back"]')
      await tab.click('[data-testid="slide-z-front"]')
      // 全选后左对齐
      await tab.focus('[data-testid="slide-stage"]')
      await tab.keyboard.press('Control+a')
      await tab.click('[data-testid="slide-align"]')
      await tab.click('[data-align="left"]')
      const request = await save(tab, office)
      const diff = await diffParts(original(), request.body)
      const allowed = new Set(['ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels', '[Content_Types].xml'])
      const stray = diff.changed.filter((name) => !allowed.has(name))
      if (stray.length || diff.removed.length) issues.push(`被改动的部件超出第 1 页相关：${JSON.stringify(diff)}`)
      if (!diff.added.some((name) => /^ppt\/media\/.+\.png$/i.test(name))) issues.push(`保存里没有新增的图片媒体：${JSON.stringify(diff.added)}`)
      const xml = (await partText(request.body, 'ppt/slides/slide1.xml')) ?? ''
      if (!xml.includes('New box')) issues.push('XML 里没有新文本框的文字')
      if (!/prst="ellipse"/.test(xml)) issues.push('XML 里没有椭圆')
      if (!/<p:pic>/.test(xml)) issues.push('XML 里没有图片')
      return issues
    },
  },

  'replace-picture': {
    title: '替换图片：位置、大小、叠放层级不变；新媒体写入包，旧图被移除的关系不影响其他页',
    async run(tab, { office }) {
      await openEdit(tab)
      // 第 6 页有图片（右下角 8.4in,4.4in，宽 3.6in）
      await tab.fill('[data-testid="slide-page"]', '6')
      await tab.press('[data-testid="slide-page"]', 'Enter')
      await tab.waitForFunction(() => document.querySelector('[data-testid="slide-surface"]').dataset.slide === '5', null, { timeout: 5000 })
      await wait(500)
      const issues = []
      const beforeXml = (await partText(original(), 'ppt/slides/slide6.xml')) ?? ''
      const picOff = /<p:pic>[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(beforeXml)
      await clickSlide(tab, 8.4 * 96 + 20, 4.4 * 96 + 20)
      if (!(await waitFor(async () => !(await tab.locator('[data-testid="slide-replace-picture"]').isDisabled()), 3000))) return ['点图片后「替换图片」没有放开']
      // 经过「替换图片」按钮打开选择框（它决定这次选图是替换而不是插入）
      const [chooser] = await Promise.all([tab.waitForEvent('filechooser'), tab.click('[data-testid="slide-replace-picture"]')])
      await chooser.setFiles(PNG)
      await wait(600)
      const request = await save(tab, office)
      const xml = (await partText(request.body, 'ppt/slides/slide6.xml')) ?? ''
      const after = /<p:pic>[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml)
      if (!picOff || !after) issues.push('找不到图片的位置信息')
      else if (picOff.slice(1).join() !== after.slice(1).join()) issues.push(`替换后位置 / 大小变了：${picOff.slice(1)} → ${after.slice(1)}`)
      if ((xml.match(/<p:pic>/g) ?? []).length !== (beforeXml.match(/<p:pic>/g) ?? []).length) issues.push(`替换后图片个数变了：${(beforeXml.match(/<p:pic>/g) ?? []).length} → ${(xml.match(/<p:pic>/g) ?? []).length}`)
      const diff = await diffParts(original(), request.body)
      const others = diff.changed.filter((name) => /ppt\/slides\/slide\d+\.xml$/.test(name) && name !== 'ppt/slides/slide6.xml')
      if (others.length) issues.push(`别的页也被改了：${others}`)
      return issues
    },
  },

  'notes-slides': {
    title: '备注可编辑；新建 / 复制 / 删除页；保存里反映出来',
    async run(tab, { office }) {
      await openEdit(tab)
      const issues = []
      const area = tab.locator('[data-testid="slide-notes-edit"]')
      await area.click()
      await area.fill('改过的备注 ABC')
      await tab.click('[data-testid="slide-total"]')
      await wait(400)
      await tab.click('[data-testid="slide-new"]')
      await tab.waitForFunction(() => document.querySelector('[data-testid="slide-total"]').textContent.includes('31'), null, { timeout: 5000 }).catch(() => issues.push('新建页后总页数不是 31'))
      if ((await slideNow(tab)) !== 1) issues.push(`新建页后应切到第 2 页：${await slideNow(tab)}`)
      await tab.click('[data-testid="slide-dup"]')
      await tab.waitForFunction(() => document.querySelector('[data-testid="slide-total"]').textContent.includes('32'), null, { timeout: 5000 }).catch(() => issues.push('复制页后总页数不是 32'))
      await tab.click('[data-testid="slide-del"]')
      await tab.waitForFunction(() => document.querySelector('[data-testid="slide-total"]').textContent.includes('31'), null, { timeout: 5000 }).catch(() => issues.push('删除页后总页数不是 31'))
      const request = await save(tab, office)
      const zip = await JSZip.loadAsync(request.body)
      const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      if (slides.length !== 31) issues.push(`保存的包里幻灯片数不是 31：${slides.length}`)
      const notes = (await zip.file('ppt/notesSlides/notesSlide1.xml')?.async('string')) ?? ''
      if (!notes.includes('改过的备注 ABC')) issues.push('第 1 页备注没有写进 notesSlide1.xml')
      return issues
    },
  },

  'limits': {
    title: '引擎不支持的能力（表格 / 连接线 / 组合 / 取消组合）：按钮置灰带说明，点了有提示，不静默',
    async run(tab) {
      await openEdit(tab)
      const issues = []
      const buttons = tab.locator('.kb-sl-limited')
      if ((await buttons.count()) !== 4) issues.push(`受限按钮个数不对：${await buttons.count()}`)
      for (let i = 0; i < (await buttons.count()); i += 1) {
        const button = buttons.nth(i)
        if ((await button.getAttribute('aria-disabled')) !== 'true') issues.push('受限按钮没有标 aria-disabled')
        if (!(await button.getAttribute('title'))?.includes('PowerPoint')) issues.push('受限按钮没有「在 PowerPoint 中编辑」说明')
      }
      // aria-disabled 的按钮 Playwright 认为不可点；真实用户（尤其触屏）照样能点到，这里强制点
      await buttons.first().click({ force: true })
      const note = await tab.waitForSelector('[data-testid="slide-editnote"]', { timeout: 3000 }).catch(() => null)
      if (!note || !(await note.textContent()).includes('PowerPoint')) issues.push('点受限按钮没有提示')
      return issues
    },
  },

  'conflict': {
    // 409 本身就是这个场景要触发的响应，浏览器会为它在控制台记一条网络错误
    allowConsole: /409/,
    title: '保存遇到 409 版本冲突：给出明确提示，已经做的修改不丢（文字还在画面里）',
    async run(tab, { office }) {
      await openEdit(tab)
      await clickSlide(tab, 520, 90)
      await inputReady(tab)
      await tab.keyboard.type('KEEP')
      await waitFor(async () => (await srText(tab)).includes('KEEP'))
      office.conflict = true
      await tab.click('[data-testid="editor-save"]')
      const issues = []
      await waitFor(() => savedCount(office) > 0)
      await wait(600)
      const status = ((await tab.textContent('[data-testid="editor-status"]')) ?? '').replace(/\s+/g, ' ')
      if (!/冲突|别人|修改/.test(status + ((await tab.textContent('[data-testid="office-error"]').catch(() => '')) ?? ''))) issues.push(`冲突没有明确提示：${status}`)
      if (!(await srText(tab)).includes('KEEP')) issues.push('冲突后用户的修改丢了')
      if (!(await tab.locator('[data-testid="office-dirty"]').count())) issues.push('冲突后应仍然标记为未保存')
      return issues
    },
  },

  'locked': {
    title: '编辑权在别人手里：只读查看，不挂编辑层，工具栏全灰',
    async run(tab, { office }) {
      office.held = false
      await tab.goto(`${engineBase}/kb?collection=${COLLECTION}&item=file_pptx`, { waitUntil: 'domcontentloaded' })
      process.env.KB_SAMPLE_PPTX = DECK
      await tab.waitForSelector('[data-testid="office-edit-open"]', { timeout: 30_000 })
      await tab.click('[data-testid="office-edit-open"]')
      await tab.waitForSelector('[data-testid="slide-surface"][data-state="ready"]', { timeout: 60_000 })
      const issues = []
      const info = await tab.evaluate(() => ({
        editing: document.querySelector('[data-testid="slide-surface"]')?.dataset.editing,
        layer: !!document.querySelector('[data-testid="slide-edit-layer"]'),
        locked: !!document.querySelector('[data-testid="office-locked"]'),
        addDisabled: document.querySelector('[data-testid="slide-add-textbox"]')?.disabled,
      }))
      if (info.editing !== 'readonly') issues.push(`应是只读：${info.editing}`)
      if (info.layer) issues.push('只读不该挂编辑层')
      if (!info.locked) issues.push('没有说明谁在编辑')
      if (!info.addDisabled) issues.push('只读时插入按钮没有置灰')
      if ((office.roundtrips?.length ?? 0) !== 0) issues.push('只读查看不该做无损预检')
      return issues
    },
  },

  'lossy': {
    title: '无损预检不通过：先只读并说明会变的部件；点「仍然编辑」放开后可编辑、可保存',
    async run(tab, { office }) {
      office.roundtripReport = { lossless: false, valid: true, text_equal: true, changed_parts: ['docProps/app.xml'], removed_parts: [], reason: null }
      await openEdit(tab, '', DECK, 'readonly')
      await tab.waitForSelector('[data-testid="office-concern"]', { timeout: 20_000 })
      const issues = []
      if ((await tab.locator('[data-testid="slide-surface"]').getAttribute('data-editing')) !== 'readonly') issues.push('不无损应先只读')
      const concern = await tab.textContent('[data-testid="office-concern"]').catch(() => '')
      if (!concern?.includes('docProps/app.xml')) issues.push(`没有说明会变的部件：${concern}`)
      if (!(await tab.locator('[data-testid="office-force"]').count())) return [...issues, `没有「仍然编辑」按钮；界面上有：${await tab.evaluate(() => [...document.querySelectorAll('[data-testid^=office]')].map((e) => e.dataset.testid).join(','))}`]
      await tab.click('[data-testid="office-force"]')
      await tab.waitForSelector('[data-testid="slide-edit-layer"]', { timeout: 5000 }).catch(() => issues.push('点仍然编辑后编辑层没有出现'))
      await clickSlide(tab, 520, 90)
      await inputReady(tab).catch(() => issues.push('放开后点文字没有进入文字编辑'))
      await tab.keyboard.type('OK')
      await waitFor(async () => (await srText(tab)).includes('OK'))
      const request = await save(tab, office)
      if (!((await partText(request.body, 'ppt/slides/slide1.xml')) ?? '').includes('OK')) issues.push('放开后保存的内容里没有新字')
      return issues
    },
  },

  'crash-recovery': {
    title: '引擎会话崩溃：给出恢复副本下载（里面有崩溃前已经输入的字），之后编辑被拒绝而不是静默丢字',
    async run(tab) {
      // 记下引擎 Worker 实例，方便在页面里向它派一个 error 事件（会话把它当成 Worker 崩溃）
      await tab.context().addInitScript(() => {
        const Original = window.Worker
        window.__workers = []
        window.Worker = class extends Original {
          constructor(...args) {
            super(...args)
            window.__workers.push(this)
          }
        }
      })
      await openEdit(tab)
      await clickSlide(tab, 520, 90)
      await inputReady(tab)
      await tab.keyboard.type('before')
      await waitFor(async () => (await srText(tab)).includes('before'))
      await wait(400)
      await tab.evaluate(() => window.__workers.forEach((worker) => worker.dispatchEvent(new ErrorEvent('error', { message: 'boom' }))))
      const issues = []
      const banner = await tab.waitForSelector('[data-testid="office-recovery"]', { timeout: 15_000 }).catch(() => null)
      if (!banner) return ['引擎崩溃后没有出现恢复副本入口']
      const error = (await tab.textContent('[data-testid="office-error"]').catch(() => '')) ?? ''
      if (!error.includes('恢复副本')) issues.push(`错误提示没有指引恢复副本：${error}`)
      // 真点下载链接（页面的 CSP 不让脚本 fetch blob:，但用户点链接下载不受限）
      const [download] = await Promise.all([tab.waitForEvent('download'), tab.click('[data-testid="office-recovery-download"]')])
      if (!/恢复副本.*\.pptx$/.test(download.suggestedFilename())) issues.push(`下载文件名不对：${download.suggestedFilename()}`)
      const rescued = readFileSync(await download.path())
      const xml = (await partText(rescued, 'ppt/slides/slide1.xml')) ?? ''
      if (!xml.includes('before')) issues.push('恢复副本里没有崩溃前输入的字')
      // 崩溃后继续打字：不能静默吞掉，应该有提示
      await tab.keyboard.type('after')
      await wait(500)
      if ((await srText(tab)).includes('after')) issues.push('引擎崩溃后居然还能把字写进文档')
      return issues
    },
  },

  'editor-param-ignored': {
    title: '旧链接里的 ?editor=legacy 被忽略：照样是原生幻灯片编辑面（它不再是回退开关）',
    async run(tab) {
      process.env.KB_SAMPLE_PPTX = DECK
      await tab.goto(`${engineBase}/kb?collection=${COLLECTION}&item=file_pptx&editor=legacy`, { waitUntil: 'domcontentloaded' })
      await tab.waitForSelector('[data-testid="office-edit-open"]', { timeout: 30_000 })
      await tab.click('[data-testid="office-edit-open"]')
      await tab.waitForSelector('[data-testid="slide-surface"]', { timeout: 60_000 })
      const issues = []
      if (!(await tab.$('[data-testid="office-native-host"]'))) issues.push('带 ?editor=legacy 应仍挂原生宿主')
      return issues
    },
  },

  'switch-speed': {
    title: '编辑态 30 页切页 < 100 ms（相邻页与跳页各取中位数）',
    async run(tab) {
      await openEdit(tab)
      await wait(1500)
      const flip = (action) =>
        tab.evaluate(async (code) => {
          const root = document.querySelector('[data-testid="slide-surface"]')
          const before = Number(root.dataset.painted)
          const start = performance.now()
          new Function(`return (${code})()`)()
          while (Number(root.dataset.painted) === before) await new Promise((resolve) => requestAnimationFrame(resolve))
          return performance.now() - start
        }, action)
      const next = []
      for (let i = 0; i < 6; i += 1) {
        next.push(await flip("() => document.querySelector('[data-testid=\"slide-next\"]').click()"))
        await wait(250)
      }
      const jumps = []
      for (const target of [22, 8, 27, 14, 19]) {
        jumps.push(await flip(`() => { const i = document.querySelector('[data-testid="slide-page"]'); i.value = '${target}'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })) }`))
        await wait(250)
      }
      console.log(`    切页耗时（ms）：相邻 ${next.map(Math.round).join('/')}，跳页 ${jumps.map(Math.round).join('/')}`)
      const issues = []
      if (median(next) >= 100) issues.push(`相邻页中位数 ${Math.round(median(next))} ms ≥ 100`)
      if (median(jumps) >= 100) issues.push(`跳页中位数 ${Math.round(median(jumps))} ms ≥ 100`)
      return issues
    },
  },

  'axe': {
    title: 'axe：编辑工具栏 + 编辑层 + 文字编辑态无 critical / serious',
    async run(tab) {
      await openEdit(tab)
      await clickSlide(tab, 520, 90)
      await inputReady(tab)
      await wait(800)
      return (await axeIssues(tab, { scope: '[data-testid="office-native-host"]' })).map((item) => `axe ${item}`)
    },
  },

  'phone': {
    title: '390×844 触屏：能进编辑、工具栏可横向滚动、点形状选中、编辑层不撑出横向滚动',
    async run(_tab, { browser }) {
      const context = await browser.newContext(contextOptions({ width: 390, height: 844, dpr: 2, touch: true, mobile: true }, 'chromium', { locale: 'zh-CN' }))
      try {
        const office = {}
        await installFixture(context, { ...SOLO_EDIT_FIXTURE, __officeEdit: office, file_info: UPLOAD_INFO })
        const phone = await context.newPage()
        await openEdit(phone)
        const issues = []
        const info = await phone.evaluate(() => {
          const bar = document.querySelector('[data-testid="slide-editbar"]')
          const stage = document.querySelector('[data-testid="slide-stage"]')
          return { barScrolls: bar.scrollWidth > bar.clientWidth, overflowX: stage.scrollWidth - stage.clientWidth, doc: document.documentElement.scrollWidth - innerWidth }
        })
        if (!info.barScrolls) issues.push('工具栏在手机宽度下应可横向滚动')
        if (info.overflowX > 2 || info.doc > 2) issues.push(`横向溢出：stage ${info.overflowX}，页面 ${info.doc}`)
        const box = await phone.locator('.kb-sl-sheet').boundingBox()
        await phone.touchscreen.tap(box.x + box.width * 0.3, box.y + box.height * 0.45)
        await phone.waitForSelector('[data-testid="slide-input"], .kb-sl-box', { timeout: 5000 }).catch(() => issues.push('触摸点形状没有选中'))
        return issues
      } finally {
        await context.close()
      }
    },
  },
}

const UPLOAD_INFO = () => ({ sha256: 'sha-fixture-original', origin: 'upload', max_replace_bytes: 64 * 1024 * 1024 })

/** 语料：每份 deck「打开 → 不改」的无损预检字节与原件逐部件相同（zip 容器元数据除外） */
async function corpus(browser) {
  const dirs = [join(ROOT, 'e2e/fixtures/editor'), join(ROOT, 'e2e/fixtures'), join(ROOT, '..', 'scratch/decks')]
  const decks = [...new Set(dirs.flatMap((dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.pptx')).map((name) => join(dir, name)) : [])))]
  const seen = new Set()
  const unique = decks.filter((path) => {
    const key = readFileSync(path).length + ':' + basename(path).replace(/^sample/, 'deck')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const rows = []
  for (const path of unique) {
    const context = await browser.newContext(contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, 'chromium', { locale: 'zh-CN' }))
    const office = {}
    await installFixture(context, { ...SOLO_EDIT_FIXTURE, __officeEdit: office, file_info: UPLOAD_INFO })
    const tab = await context.newPage()
    const errors = []
    tab.on('pageerror', (error) => errors.push(error.message))
    const row = { deck: basename(path) }
    try {
      const started = Date.now()
      await openEdit(tab, '', path)
      row.openMs = Date.now() - started
      const sent = office.roundtrips?.[0]?.body
      row.sentBytes = sent?.length ?? 0
      if (!sent) row.problem = '没有收到预检字节'
      else {
        const diff = await diffParts(readFileSync(path), sent)
        row.partsChanged = diff.changed.length
        row.partsRemoved = diff.removed.length
        row.partsAdded = diff.added.length
        row.identicalParts = !diff.changed.length && !diff.removed.length && !diff.added.length
        row.sameSize = sent.length === readFileSync(path).length
        // zip 容器本身的字节差异（中央目录 / 本地头里的时间戳等元数据）：数出来，并确认没有一个落在压缩数据里
        const orig = readFileSync(path)
        const ranges = orig.length === sent.length ? dataRanges(orig) : []
        let headerDiff = 0
        let dataDiff = 0
        if (orig.length === sent.length) {
          for (let i = 0; i < orig.length; i += 1) {
            if (orig[i] === sent[i]) continue
            if (ranges.some(([from, to]) => i >= from && i < to)) dataDiff += 1
            else headerDiff += 1
          }
        }
        row.entries = ranges.length
        row.containerHeaderDiffBytes = headerDiff
        row.dataDiffBytes = dataDiff
        if (orig.length !== sent.length) row.problem = `大小变了：${orig.length} → ${sent.length}`
        else if (dataDiff) row.problem = `压缩数据里有 ${dataDiff} 个字节不同`
        if (!row.identicalParts) row.problem = JSON.stringify(diff)
      }
    } catch (error) {
      row.problem = String(error.message).split('\n')[0].slice(0, 120)
    }
    if (errors.length) row.problem = `${row.problem ?? ''} 页面异常：${errors[0]}`.trim()
    rows.push(row)
    await context.close()
  }
  return rows
}

async function main() {
  asUpload()
  const { server, base } = await startStaticServer()
  engineBase = base
  const browser = await launch('chromium')
  let failed = 0
  try {
    if (ONLY.includes('corpus') || !ONLY.length) {
      const rows = await corpus(browser)
      for (const row of rows) console.log(JSON.stringify(row))
      const bad = rows.filter((row) => row.problem || !row.identicalParts)
      if (bad.length) {
        failed += 1
        console.log(`✗ corpus ${bad.length}/${rows.length} 份「不改保存」与原件的部件不一致`)
      } else console.log(`✓ corpus ${rows.length} 份 deck：不改保存后每个部件与原件逐字节相同（部件集合也相同）`)
    }
    for (const [id, scenario] of Object.entries(SCENARIOS)) {
      if (ONLY.length && !ONLY.includes(id)) continue
      const context = await browser.newContext(contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, 'chromium', { locale: 'zh-CN' }))
      const office = {}
      await installFixture(context, { ...SOLO_EDIT_FIXTURE, __officeEdit: office, file_info: UPLOAD_INFO })
      const tab = await context.newPage()
      const errors = []
      tab.on('pageerror', (error) => errors.push(error.message))
      tab.on('console', (message) => message.type() === 'error' && !/WebSocket|502/.test(message.text()) && !scenario.allowConsole?.test(message.text()) && errors.push(`console: ${message.text().slice(0, 160)}`))
      const issues = (await scenario.run(tab, { office, browser }).catch((error) => [`异常：${String(error.message).split('\n')[0]}`])).concat(errors.map((e) => `页面异常：${e}`))
      if (issues.length) {
        failed += 1
        console.log(`✗ ${id} ${scenario.title}\n  ${issues.join('\n  ')}`)
      } else console.log(`✓ ${id}`)
      await context.close()
    }
  } finally {
    await browser.close()
    server.close()
  }
  if (failed) {
    console.log(`\n${failed} 项未通过`)
    process.exit(1)
  }
  console.log('\n✓ pptx 编辑 e2e 全部通过')
}

void main()
