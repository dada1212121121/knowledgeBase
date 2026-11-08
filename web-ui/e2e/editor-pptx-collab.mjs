#!/usr/bin/env node
/**
 * PPTX 原生协同 e2e
 *
 * 两个浏览器上下文经**真房间**（`e2e/office-room.mjs`：office-worker 的 `Room` + `openReplica('pptx')`）
 * 打开同一份 deck，验证：
 *   1. 各改不同页，对方实时看到（读对方画布旁的无障碍文本，不看自己写进去的）；
 *   2. 在线状态：对方选中的形状在我的画布上画出带名字的框；缩略图标出谁在哪一页；
 *   3. 同一个文本框里同时敲字（一个在开头、一个在结尾）：两边收敛到同一份文字，一个字符都不丢；
 *   4. AI 的 `doc_edit`（服务端副本改 + 广播）实时到达，落地字节里同时有 AI 和两个人的改动；
 *   5. 只读参与者：能实时看到别人的修改和光标，但没有编辑层、改不了；
 *   6. 房间关闭 / 权限被收回（4403）：界面提示，不崩。
 * 真实的 AI 能力接口链路由 `office-worker/test/e2e-ai.mjs`（守护进程级）覆盖；这里重点是幻灯片编辑面与房间的接线。
 *
 * 用法：npm run build（或 KB_PRECOMPRESS=0 npx vite build）后 node e2e/editor-pptx-collab.mjs
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { contextOptions, launch } from './devices.mjs'
import { ALL_FEATURES, FILES, adminMe, installFixture } from './fixture.mjs'
import { startOfficeRoom } from './office-room.mjs'
import { startStaticServer } from './serve.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DECK = join(ROOT, 'e2e/fixtures/editor/deck-latin-8p.pptx')
const COLLECTION = 'knowledgeBase%2Finsights'
const PAGE = `/kb?collection=${COLLECTION}&item=file_pptx`
const SESSION = { mode: 'collab', base_sha: 'sha-fixture-original', format: 'pptx', writable: true, room_writable: true, lossless: true, participants: 0, size: 4096 }
/** 夹具里的文件信息:上传的文件才能在线编辑(项目目录里的归代码仓库管) */
const UPLOAD_INFO = () => ({ sha256: 'sha-fixture-original', origin: 'upload', max_replace_bytes: 64 * 1024 * 1024 })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await wait(80)
  }
  return false
}

const srText = (tab) => tab.evaluate(() => document.querySelector('[data-testid="slide-sr"]')?.textContent ?? '')
const slideNow = (tab) => tab.evaluate(() => Number(document.querySelector('[data-testid="slide-surface"]').dataset.slide))
const collabStatus = async (tab) => (await tab.locator('[data-testid="office-collab-status"]').textContent().catch(() => '')) ?? ''

/** 打开一个浏览器上下文并进入协同 */
async function openTab(browser, base, room, failures, { writable = true, user = { id: 'usr_admin', name: '管理员' }, label = '' } = {}) {
  const context = await browser.newContext(contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, 'chromium', { locale: 'zh-CN' }))
  await context.routeWebSocket(/\/api\/v1\/office\/collab\?/, (ws) => room.attach(ws, { writable, user }))
  await installFixture(context, {
    __officeSession: { ...SESSION, writable, room_writable: writable },
    file_info: UPLOAD_INFO,
    // 每个浏览器是不同的人:协同里的名字取自登录身份
    __me: { local: false, user: { ...adminMe(ALL_FEATURES, true), display_name: user.name } },
  })
  const tab = await context.newPage()
  tab.on('pageerror', (error) => failures.push(`${label}页面异常：${error.message}`))
  tab.on('console', (message) => {
    if (message.type() === 'error' && !/WebSocket|502/.test(message.text())) failures.push(`${label}控制台：${message.text().slice(0, 160)}`)
  })
  await tab.goto(`${base}${PAGE}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="office-edit-open"]', { timeout: 30_000 })
  await tab.click('[data-testid="office-edit-open"]')
  await tab.waitForSelector('[data-testid="office-native-host"] [data-testid="slide-surface"][data-state="ready"]', { timeout: 60_000 })
  await tab.waitForFunction(() => Number(document.querySelector('[data-testid="slide-surface"]')?.dataset.painted) >= 1, null, { timeout: 20_000 })
  return { context, tab }
}

/** 幻灯片坐标 → 页面坐标（画布宽 1280 逻辑像素） */
async function toPage(tab, x, y) {
  const box = await tab.locator('.kb-sl-sheet').boundingBox()
  const k = box.width / 1280
  return { x: box.x + x * k, y: box.y + y * k }
}
async function clickSlide(tab, x, y) {
  const at = await toPage(tab, x, y)
  await tab.mouse.click(at.x, at.y)
}
async function goTo(tab, index) {
  await tab.locator('[data-testid="slide-thumb"]').nth(index).click()
  await tab.waitForFunction((want) => Number(document.querySelector('[data-testid="slide-surface"]')?.dataset.slide) === want, index, { timeout: 5000 })
}
/** 点进某个文本框、把光标放在行首 / 行尾，等输入层出来 */
async function caretAt(tab, x, y, edge) {
  await clickSlide(tab, x, y)
  await tab.waitForSelector('[data-testid="slide-input"]', { timeout: 5000 })
  await tab.keyboard.press(edge === 'start' ? 'Home' : 'End')
}

async function main() {
  process.env.KB_SAMPLE_PPTX = DECK
  FILES.file_pptx.item.origin = 'upload'
  FILES.file_pptx.preview.origin = 'upload'
  const deck = readFileSync(DECK)
  const { server, base } = await startStaticServer()
  const browser = await launch('chromium')
  const room = await startOfficeRoom({ bytes: deck, format: 'pptx' })
  const failures = []
  const contexts = []
  const results = []
  const check = (name, ok, detail = '') => {
    results.push([name, ok])
    if (!ok) failures.push(`${name}${detail ? `：${detail}` : ''}`)
  }
  try {
    const a = await openTab(browser, base, room, failures, { label: 'A ', user: { id: 'usr_a', name: '甲' } })
    contexts.push(a)
    check('A 进入已同步', await waitFor(async () => (await collabStatus(a.tab)).includes('已同步'), 20_000), await collabStatus(a.tab))
    const b = await openTab(browser, base, room, failures, { label: 'B ', user: { id: 'usr_b', name: '乙' } })
    contexts.push(b)
    check('B 进入已同步', await waitFor(async () => (await collabStatus(b.tab)).includes('已同步'), 20_000), await collabStatus(b.tab))
    check('协同时界面是可编辑态', (await a.tab.locator('[data-testid="slide-surface"]').getAttribute('data-editing')) === 'true')
    const bar = async (tab) => (await tab.locator('[data-testid="editor-status-bar"]').textContent()) ?? ''
    check('状态栏写「已同步」，没有卡在「正在连接协同」', (await bar(a.tab)).includes('已同步') && !(await bar(a.tab)).includes('正在连接协同') && !(await bar(a.tab)).includes('已保存'), await bar(a.tab))
    check('协同时没有本地保存脏标记', !(await a.tab.locator('[data-testid="office-dirty"]').count()))

    // 1. 各改不同页：A 改第 2 页标题末尾，B 改第 5 页标题末尾
    await goTo(a.tab, 1)
    await caretAt(a.tab, 520, 90, 'end')
    await a.tab.keyboard.type('-by-A')
    await goTo(b.tab, 4)
    await caretAt(b.tab, 520, 90, 'end')
    await b.tab.keyboard.type('-by-B')
    // 对方看：切到那一页读无障碍文本（不是读自己输入的页）
    await goTo(b.tab, 1)
    check('B 实时看到 A 在第 2 页的修改', await waitFor(async () => (await srText(b.tab)).includes('review 2-by-A')), (await srText(b.tab)).slice(0, 80))
    await goTo(a.tab, 4)
    check('A 实时看到 B 在第 5 页的修改', await waitFor(async () => (await srText(a.tab)).includes('review 5-by-B')), (await srText(a.tab)).slice(0, 80))

    // 2. 在线状态：A 回到第 2 页选中标题；B 在同一页应看到带名字的框；B 在别的页时缩略图上有 A 的标记
    await goTo(a.tab, 1)
    await clickSlide(a.tab, 520, 90)
    await goTo(b.tab, 0)
    check('缩略图标出 A 在第 2 页', await waitFor(async () => (await b.tab.locator('[data-testid="slide-thumb"]').nth(1).locator('.kb-sl-peerdot').count()) > 0), '')
    await goTo(b.tab, 1)
    check('同页时画出 A 选中的形状框和名字', await waitFor(async () => (await b.tab.locator('[data-testid="slide-peer-box"]').allTextContents()).some((t) => t.includes('甲'))), JSON.stringify(await b.tab.locator('[data-testid="slide-peer-box"]').allTextContents()))
    // A 换页后框应消失（不留幽灵光标）
    await goTo(a.tab, 6)
    check('A 换页后 B 画布上的框消失', await waitFor(async () => !(await b.tab.locator('[data-testid="slide-peer-box"]').count())), '')

    // 3. 同一个文本框同时敲字：A 在第 3 页标题开头，B 在同一标题末尾，同时敲
    await Promise.all([goTo(a.tab, 2), goTo(b.tab, 2)])
    await Promise.all([caretAt(a.tab, 520, 90, 'start'), caretAt(b.tab, 520, 90, 'end')])
    await Promise.all([a.tab.keyboard.type('AAAAAAAAAA', { delay: 25 }), b.tab.keyboard.type('BBBBBBBBBB', { delay: 25 })])
    await wait(1500)
    const textA = await srText(a.tab)
    const textB = await srText(b.tab)
    const title = (text) => /(A*Quarterly review 3B*)/.exec(text)?.[1] ?? ''
    check('同框并发：两边一致', !!title(textA) && title(textA) === title(textB), `A「${title(textA)}」/ B「${title(textB)}」`)
    check('同框并发：一个字符都不丢', title(textA).split('A').length - 1 === 10 && title(textA).split('B').length - 1 === 10, title(textA))

    // 3b. 撤销只撤自己的：A 在第 7 页标题末尾敲 X，B 随后在 X 后面敲 Y；A 撤销 → X 没了、Y 还在，两边一致
    await Promise.all([goTo(a.tab, 6), goTo(b.tab, 6)])
    await caretAt(a.tab, 520, 90, 'end')
    await a.tab.keyboard.type('X')
    check('撤销前：B 收到 A 的 X', await waitFor(async () => (await srText(b.tab)).includes('review 7X')), (await srText(b.tab)).slice(0, 60))
    await caretAt(b.tab, 520, 90, 'end')
    await b.tab.keyboard.type('Y')
    check('撤销前：A 收到 B 的 Y', await waitFor(async () => (await srText(a.tab)).includes('review 7XY')), (await srText(a.tab)).slice(0, 60))
    await a.tab.click('[data-testid="editor-undo"]')
    const undone = async () => (await srText(a.tab)).includes('review 7Y') && (await srText(b.tab)).includes('review 7Y')
    check('A 撤销只撤自己的字：X 没了、B 的 Y 还在，两边一致', await waitFor(undone), `A「${(await srText(a.tab)).slice(0, 40)}」/ B「${(await srText(b.tab)).slice(0, 40)}」`)

    // 3c. 实时性：A 在第 8 页逐字敲 8 个字，量每个字从按键到 B 的画面文字里出现的时间（同一台机器上 Date.now 可比）
    await Promise.all([goTo(a.tab, 7), goTo(b.tab, 7)])
    await caretAt(a.tab, 520, 90, 'end')
    const latencies = []
    for (let i = 1; i <= 8; i += 1) {
      const want = `review 8${'12345678'.slice(0, i)}`
      const seen = b.tab.waitForFunction((text) => (document.querySelector('[data-testid="slide-sr"]')?.textContent ?? '').includes(text), want, { timeout: 5000, polling: 'raf' }).then(() => Date.now())
      const t0 = await a.tab.evaluate(() => Date.now())
      await a.tab.keyboard.type(String(i))
      latencies.push((await seen) - t0)
    }
    const sorted = [...latencies].sort((x, y) => x - y)
    console.log(`协同单字延迟（A 按键 → B 画面）：中位 ${sorted[4]} ms，最大 ${sorted[7]} ms，逐个 ${latencies.join(' / ')}`)
    check('协同单字延迟不超过 1.5 s（本机回环，含 B 重画）', sorted[7] <= 1500, `最大 ${sorted[7]} ms`)

    // 4. AI：服务端副本上替换，B 在第 4 页实时收到；落地字节里有 AI + A + B 的改动
    await goTo(b.tab, 3)
    const landingsBefore = room.landed.length
    await room.agentEdit([{ old: 'Quarterly review 4', new: 'Quarterly review FOUR' }])
    check('AI 的修改实时到达（不刷新）', await waitFor(async () => (await srText(b.tab)).includes('review FOUR')), (await srText(b.tab)).slice(0, 80))
    check('AI 到达时没把人踢出去', (await b.tab.locator('[data-testid="slide-edit-layer"]').count()) > 0 && (await slideNow(b.tab)) === 3)
    check('房间按去抖落地', await waitFor(() => room.landed.length > landingsBefore, 20_000))
    const zip = await JSZip.loadAsync(Buffer.from(room.landed.at(-1) ?? new Uint8Array()))
    const slides = await Promise.all([1, 2, 3, 4, 5].map((n) => zip.file(`ppt/slides/slide${n}.xml`).async('string')))
    const flat = (xml) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')
    check('落地字节：A 在第 2 页的字', flat(slides[1]).includes('review 2-by-A'), flat(slides[1]).slice(0, 60))
    check('落地字节：B 在第 5 页的字', flat(slides[4]).includes('review 5-by-B'), flat(slides[4]).slice(0, 60))
    check('落地字节：同框并发双方的字', /A{10}Quarterly review 3B{10}/.test(flat(slides[2])), flat(slides[2]).slice(0, 80))
    check('落地字节：AI 的字', flat(slides[3]).includes('review FOUR'), flat(slides[3]).slice(0, 60))

    // 5. 只读参与者
    const viewer = await openTab(browser, base, room, failures, { writable: false, label: 'C ', user: { id: 'usr_c', name: '丙' } })
    contexts.push(viewer)
    check('只读参与者进入已同步', await waitFor(async () => (await collabStatus(viewer.tab)).includes('已同步'), 20_000), await collabStatus(viewer.tab))
    check('只读参与者没有编辑层', (await viewer.tab.locator('[data-testid="slide-edit-layer"]').count()) === 0 && (await viewer.tab.locator('[data-testid="slide-surface"]').getAttribute('data-editing')) !== 'true')
    await goTo(viewer.tab, 1)
    check('只读参与者看到别人的修改', (await srText(viewer.tab)).includes('review 2-by-A'))
    await goTo(a.tab, 1)
    await clickSlide(a.tab, 520, 90)
    check('只读参与者看到 A 的光标框', await waitFor(async () => (await viewer.tab.locator('[data-testid="slide-peer-box"]').allTextContents()).some((t) => t.includes('甲'))), '')
    await caretAt(a.tab, 520, 90, 'end')
    await a.tab.keyboard.type('!')
    check('A 之后的修改只读者也实时收到', await waitFor(async () => (await srText(viewer.tab)).includes('review 2-by-A!')), (await srText(viewer.tab)).slice(0, 80))

    // 6. 权限被收回：服务端关连接（4403），界面提示原因，且之后不再重连刷屏
    room.kickAll(4403, '你对这份文档的权限已被收回')
    check('权限被收回：界面提示原因', await waitFor(async () => ((await a.tab.locator('[data-testid="office-collab-closed"]').textContent().catch(() => '')) ?? '').includes('权限已被收回'), 10_000), '')
    check('权限被收回：状态栏写「协同已结束」', await waitFor(async () => (await bar(a.tab)).includes('协同已结束'), 10_000), await bar(a.tab))
  } finally {
    for (const { context } of contexts) await context.close().catch(() => undefined)
    await browser.close()
    room.close()
    server.close()
  }
  for (const [name, ok] of results) console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (failures.length) {
    console.error(`PPTX 协同门禁失败：\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('✓ PPTX 原生协同门禁通过')
}

await main()
