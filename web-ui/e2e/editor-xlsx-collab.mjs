#!/usr/bin/env node
/**
 * XLSX 原生协同 e2e
 *
 * 两个浏览器上下文经**真房间**（`e2e/office-room.mjs`，直接跑 office-worker 的
 * `Room` + `openReplica`）打开同一份 sample.xlsx：改不同格实时互见；同格并发按引擎
 * 策略收敛；再用与 `agent_edit` 相同的路径（服务端副本上改 + 广播）模拟 AI 的
 * `doc_edit`，验证网格实时收到、服务端自己落地的字节里也包含 AI 与浏览器的改动。
 *
 * 状态栏：xlsx 协同的状态栏要跟着房间走（已同步 / 离线 / 协同已结束），连上之后不能再出现「正在连接协同…」；
 * 用页面里的 MutationObserver 记下状态栏每一次变化，才不会因为轮询错过一闪而过的状态。
 *
 * 真实的 AI 能力接口链路由 `office-worker/test/e2e-ai.mjs`（守护进程级）覆盖；
 * 这里不启动守护进程，重点是新 Grid Surface 与房间的接线。
 *
 * 用法：npm run build && node e2e/editor-xlsx-collab.mjs
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { initWasm, openWorkbook } from '@betteroffice/xlsx'
import { contextOptions, launch } from './devices.mjs'
import { installFixture } from './fixture.mjs'
import { startOfficeRoom } from './office-room.mjs'
import { startStaticServer } from './serve.mjs'

const COLLECTION = 'knowledgeBase%2Finsights'
const PAGE = `/kb?collection=${COLLECTION}&item=file_xlsx`
const SESSION = {
  mode: 'collab',
  base_sha: 'sha-fixture-original',
  writable: true,
  room_writable: true,
  lossless: true,
  participants: 0,
  size: 4096,
}
const ME = { id: 'usr_admin', name: '管理员' }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** 模拟掉线的关闭码：不是 4403 / 4404 / 4410（服务端说「别再连了」），所以传输层会按退避重连 */
const DROP_CODE = 1012

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await wait(80)
  }
  return false
}

async function openTab(browser, base, room, failures) {
  const context = await browser.newContext(
    contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, 'chromium', { locale: 'zh-CN' }),
  )
  // 每条浏览器连接都是房间里的一条 conn，共享同一份服务端副本
  // net 用来模拟断网：blocked 期间新来的（重连）连接一进来就被关掉；current 是眼下这条连接，测试里可以主动关它
  const net = { blocked: false, current: null }
  await context.routeWebSocket(/\/api\/v1\/office\/collab\?/, (ws) => {
    if (net.blocked) {
      ws.close({ code: DROP_CODE, reason: '测试：模拟断网' })
      return
    }
    net.current = ws
    room.attach(ws, { writable: true, user: ME })
  })
  // 状态栏每变一次就记一条（文字、右侧协同文案、颜色）：MutationObserver 不会像轮询那样漏掉一闪而过的状态
  await context.addInitScript(() => {
    window.__statusLog = []
    let last = ''
    const snapshot = () => {
      const text = document.querySelector('[data-testid="editor-status-text"]')?.textContent?.trim() ?? ''
      const right = document.querySelector('[data-testid="editor-status-collab"]')?.textContent?.trim() ?? ''
      const tone = document.querySelector('[data-testid="editor-status-bar"]')?.getAttribute('data-tone') ?? ''
      const key = `${text}|${right}|${tone}`
      if (!text && !right) return
      if (key !== last) {
        last = key
        window.__statusLog.push({ text, right, tone })
      }
    }
    new MutationObserver(snapshot).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
  })
  await installFixture(context, { __officeSession: SESSION })
  const tab = await context.newPage()
  tab.on('pageerror', (error) => failures.push(`页面异常：${error.message}`))
  tab.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') console.log('CONSOLE', message.type(), message.text()) })
  await tab.goto(`${base}${PAGE}`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('[data-testid="office-edit-open"]', { timeout: 20_000 })
  await tab.click('[data-testid="office-edit-open"]')
  await tab.waitForSelector('[data-testid="office-native-host"] .kb-xg .kb-xg-canvas', { timeout: 30_000 })
  await waitFor(async () => !(await tab.locator('.kb-xg-loading').count()), 20_000)
  return { context, tab, net }
}

/** 状态栏现在写的主文案 */
async function barText(tab) {
  return ((await tab.locator('[data-testid="editor-status-text"]').textContent().catch(() => '')) ?? '').trim()
}
/** 状态栏从页面打开起的全部变化 */
async function barLog(tab) {
  return tab.evaluate(() => window.__statusLog ?? [])
}

async function collabStatus(tab) {
  return (await tab.locator('[data-testid="office-collab-status"]').textContent().catch(() => '')) ?? ''
}

/** 选中单元格：先聚焦网格，再 Ctrl+Home + 方向键（和 editor-xlsx-edit.mjs 一致） */
async function selectCell(tab, row, col) {
  await tab.locator('.kb-xg').focus()
  await tab.keyboard.press('Control+Home')
  for (let i = 0; i < row; i += 1) await tab.keyboard.press('ArrowDown')
  for (let i = 0; i < col; i += 1) await tab.keyboard.press('ArrowRight')
  await wait(120)
}

async function formulaValue(tab) {
  return tab.locator('.kb-xg-formula-input').inputValue()
}

/** 输入整格内容并回车；先选中目标格，避免焦点留在页面别处 */
async function typeCell(tab, row, col, value) {
  await selectCell(tab, row, col)
  await tab.keyboard.type(value)
  await tab.waitForSelector('[data-testid="xlsx-cell-editor"]', { timeout: 3000 })
  await tab.keyboard.press('Enter')
  await wait(220)
}

/** 选中并读公式栏，作为「另一个浏览器看到了什么」的断言口径 */
async function readCell(tab, row, col) {
  await selectCell(tab, row, col)
  return formulaValue(tab)
}

const savedCell = (handle, a1) => {
  const sheet = handle.sheetInfo().sheetNames[0]
  const cells = handle.rangeCells(0, a1).flat()
  return cells.find((cell) => cell.a1 === a1)?.input ?? ''
}

async function main() {
  const sample = readFileSync(new URL('./fixtures/sample.xlsx', import.meta.url))
  // 这一版 initWasm 是异步的：不 await 的话 openWorkbook 会报「wasm 没初始化」
  await initWasm(await readFile(new URL('generated/xlsx_wasm_bg.wasm', import.meta.resolve('@betteroffice/xlsx'))))

  const { server, base } = await startStaticServer()
  const browser = await launch('chromium')
  // 房间从同一份底稿打开：服务端副本 + 浏览器副本初始状态天然相同，谁先连都能对上
  const room = await startOfficeRoom({ bytes: sample })
  const failures = []
  const contexts = []
  try {
    const a = await openTab(browser, base, room, failures)
    contexts.push(a)
    if (!(await waitFor(async () => (await collabStatus(a.tab)).includes('已同步'), 20_000))) {
      failures.push(`A 没有进入已同步：${await collabStatus(a.tab)}`)
    }
    // 状态栏接房间状态：连上就写「已同步」，右侧不再有写死的「正在连接协同…」
    if (!(await waitFor(async () => (await barText(a.tab)) === '已同步', 20_000))) {
      failures.push(`状态栏没有进入已同步：${await barText(a.tab)}`)
    }
    if (await a.tab.locator('[data-testid="editor-status-collab"]').count()) failures.push('状态栏右侧仍有协同文案（应由房间状态统一写在主文案里）')
    const syncedMark = (await barLog(a.tab)).length
    const b = await openTab(browser, base, room, failures)
    contexts.push(b)
    if (!(await waitFor(async () => (await collabStatus(b.tab)).includes('已同步'), 20_000))) {
      failures.push(`B 没有进入已同步：${await collabStatus(b.tab)}`)
    }

    // 1. 不同格：双方各自改一处，两边都能看到对方
    await typeCell(a.tab, 0, 0, 'ALPHA')
    await typeCell(b.tab, 2, 2, 'BETA')
    if (!(await waitFor(async () => (await readCell(b.tab, 0, 0)) === 'ALPHA', 15_000))) {
      failures.push(`B 没看到 A 的 A1：${await formulaValue(b.tab)}`)
    }
    if (!(await waitFor(async () => (await readCell(a.tab, 2, 2)) === 'BETA', 15_000))) {
      failures.push(`A 没看到 B 的 C3：${await formulaValue(a.tab)}`)
    }

    // 2. 同格同时写：引擎按自己的合并策略收敛；两边必须一致，且不能悄悄变空
    await Promise.all([selectCell(a.tab, 3, 3), selectCell(b.tab, 3, 3)])
    await Promise.all([
      a.tab.keyboard.type('SAME-A').then(() => a.tab.keyboard.press('Enter')),
      b.tab.keyboard.type('SAME-B').then(() => b.tab.keyboard.press('Enter')),
    ])
    await wait(1800)
    const sameA = await readCell(a.tab, 3, 3)
    const sameB = await readCell(b.tab, 3, 3)
    if (!sameA || !sameB || sameA !== sameB) failures.push(`同格并发没有收敛：A「${sameA}」/ B「${sameB}」`)

    // 3. AI：服务端副本上做替换（office-worker 的 agent_edit 路径），网格实时到达
    const landingsBefore = room.landed.length
    await room.agentEdit([{ old: '查询', new: '查询项' }])
    if (!(await waitFor(async () => (await readCell(b.tab, 0, 1)) === '查询项', 15_000))) {
      failures.push(`B 没实时收到 AI 的 B1：${await formulaValue(b.tab)}`)
    }

    // 4. 落地：房间按去抖自己 save 出整份文件，字节里必须同时有 AI 和浏览器的改动
    if (!(await waitFor(() => room.landed.length > landingsBefore, 20_000))) failures.push('房间没有落地')
    const saved = room.landed.at(-1) ?? new Uint8Array()
    const verify = openWorkbook(new Uint8Array(saved))
    if (savedCell(verify, 'B1') !== '查询项') failures.push(`落地字节 B1 是「${savedCell(verify, 'B1')}」`)
    if (savedCell(verify, 'A1') !== 'ALPHA') failures.push(`落地字节 A1 是「${savedCell(verify, 'A1')}」`)
    if (savedCell(verify, 'C3') !== 'BETA') failures.push(`落地字节 C3 是「${savedCell(verify, 'C3')}」`)
    verify.dispose()

    // 4b. 连上之后，改了这么多、收了对方这么多改动，状态栏始终没有退回「正在连接协同…」，也没变回「已保存」
    const sinceSynced = (await barLog(a.tab)).slice(syncedMark)
    const regressed = sinceSynced.filter((entry) => `${entry.text}${entry.right}`.includes('正在连接') || entry.text.includes('已保存'))
    if (regressed.length) failures.push(`状态栏连上之后又出现：${regressed.map((entry) => entry.text || entry.right).join(' / ')}`)
    if ((await barText(a.tab)) !== '已同步') failures.push(`状态栏在协作之后不是已同步：${await barText(a.tab)}`)

    // 4c. 掉线：状态栏写「离线」（黄色），不是停在「已同步」；网络恢复后传输层重连，回到「已同步」，改动照常互通
    const dropMark = (await barLog(a.tab)).length
    a.net.blocked = true
    a.net.current.close({ code: DROP_CODE, reason: '测试：服务重启' })
    const sinceDrop = async () => (await barLog(a.tab)).slice(dropMark)
    const sawOffline = await waitFor(async () => (await sinceDrop()).some((entry) => entry.text.includes('离线')), 10_000)
    const dropLog = await sinceDrop()
    if (!sawOffline) failures.push(`掉线后状态栏没有写离线：${dropLog.map((entry) => entry.text).join(' / ')}`)
    else {
      const from = dropLog.findIndex((entry) => entry.text.includes('离线'))
      if (dropLog[from].tone !== 'warning') failures.push(`离线状态的颜色应为 warning：${dropLog[from].tone}`)
      // 断网期间重连都被拒了，状态栏在写出「离线」之后不能又写「已同步」
      if (dropLog.slice(from).some((entry) => entry.text === '已同步')) failures.push('还没重连上，状态栏就又写了已同步')
    }
    a.net.blocked = false
    if (!(await waitFor(async () => (await barText(a.tab)) === '已同步', 30_000))) {
      failures.push(`重连后状态栏没有回到已同步：${await barText(a.tab)}`)
    }
    await typeCell(a.tab, 5, 1, 'AFTER-DROP')
    if (!(await waitFor(async () => (await readCell(b.tab, 5, 1)) === 'AFTER-DROP', 15_000))) {
      failures.push(`重连后 B 未收到 A 的新改动：${await formulaValue(b.tab)}`)
    }

    // 4d. 服务端主动结束（权限收回）：状态栏写「协同已结束」，不再重连，页面提示原因
    a.net.current.close({ code: 4403, reason: '你对这份文档的权限已被收回' })
    if (!(await waitFor(async () => (await barText(a.tab)) === '协同已结束', 10_000))) {
      failures.push(`被服务端结束后状态栏没有写协同已结束：${await barText(a.tab)}`)
    }
    const closedNote = (await a.tab.locator('[data-testid="office-collab-closed"]').textContent().catch(() => '')) ?? ''
    if (!closedNote.includes('权限已被收回')) failures.push(`被服务端结束后页面没有提示原因：${closedNote}`)
    await wait(1500)
    if ((await barText(a.tab)) !== '协同已结束') failures.push(`协同已结束之后状态栏又变了：${await barText(a.tab)}`)

    // 5. 1.5 MB 边界：服务端还说 collab，文件却超过上限 → 客户端自己挡回单人编辑：
    //    提示准确、一条协同连接都不建、单人编辑照常能开（不崩）
    const large = await browser.newContext(
      contextOptions({ width: 1440, height: 900, dpr: 1, touch: false, mobile: false }, 'chromium', { locale: 'zh-CN' }),
    )
    let collabRoutes = 0
    await large.routeWebSocket(/\/api\/v1\/office\/collab\?/, (ws) => {
      collabRoutes += 1
      ws.close({ code: 4410, reason: '不该走到这里' })
    })
    await installFixture(large, {
      __officeSession: {
        mode: 'collab',
        size: 2 * 1024 * 1024,
        base_sha: 'sha-fixture-original',
        format: 'xlsx',
        writable: true,
        room_writable: true,
        lossless: true,
      },
    })
    const largeTab = await large.newPage()
    largeTab.on('pageerror', (error) => failures.push(`边界页面异常：${error.message}`))
    await largeTab.goto(`${base}${PAGE}`, { waitUntil: 'domcontentloaded' })
    await largeTab.waitForSelector('[data-testid="office-edit-open"]', { timeout: 20_000 })
    await largeTab.click('[data-testid="office-edit-open"]')
    const reason = await largeTab.locator('[data-testid="office-single-reason"]').textContent({ timeout: 20_000 })
    if (!reason?.includes('2.0 MB') || !reason.includes('1.5 MB')) failures.push(`边界提示不准确：${reason}`)
    if (collabRoutes) failures.push(`超过上限仍然连了协同房间（${collabRoutes} 条连接）`)
    if (!(await largeTab.waitForSelector('[data-testid="office-native-host"] canvas', { timeout: 30_000 }).catch(() => null))) {
      failures.push('超过上限时单人编辑打不开')
    }
    await large.close()

    for (const [name, ok] of [
      ['两个浏览器改不同格实时互见', !failures.some((item) => item.includes('没看到'))],
      ['同格并发按引擎策略收敛', !failures.some((item) => item.includes('同格并发'))],
      ['AI 改动实时到达并进入落地字节', !failures.some((item) => item.includes('AI') || item.includes('落地字节'))],
      ['状态栏跟房间走：已同步，之后不再出现「正在连接」', !failures.some((item) => item.includes('状态栏没有进入已同步') || item.includes('状态栏右侧') || item.includes('连上之后又出现') || item.includes('协作之后'))],
      ['掉线显示离线，重连回到已同步且改动互通', !failures.some((item) => item.includes('离线') || item.includes('重连') || item.includes('还没重连上'))],
      ['服务端结束协同显示「协同已结束」', !failures.some((item) => item.includes('协同已结束') || item.includes('被服务端结束'))],
      ['1.5 MB 边界提示准确且不崩', !failures.some((item) => item.includes('边界') || item.includes('超过上限'))],
    ]) {
      console.log(`${ok ? '✓' : '✗'} ${name}`)
    }
  } finally {
    for (const { context } of contexts) await context.close()
    await browser.close()
    room.close()
    server.close()
  }

  if (failures.length) {
    console.error(`XLSX 协同门禁失败：${failures.join('；')}`)
    process.exit(1)
  }
  console.log('✓ XLSX 原生协同门禁通过')
}

await main()
