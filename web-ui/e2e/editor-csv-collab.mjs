// CSV 原生网格 + 协同冒烟：两个独立浏览器上下文接同一个假房间，验证单元格补丁互相到达。
// 房间协议来自 e2e/collab-room.mjs（按 core.rs 写的状态机），页面和 Yjs 都是真的。
import { chromium } from '@playwright/test'
import { FILES, installFixture } from './fixture.mjs'
import { startStaticServer } from './serve.mjs'
import { FakeRoom } from './collab-room.mjs'

const ME = { id: 'usr_admin', name: '管理员' }
const SOURCE = FILES.file_csv.preview.content
const { server, base } = await startStaticServer()
const browser = await chromium.launch({ headless: true })
const room = new FakeRoom({ kind: 'text', text: SOURCE })
const failures = []

async function openTab() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  await context.routeWebSocket(/\/api\/v1\/collab\/ws/, (ws) => {
    const conn = room.join(ME, true, {
      send: (bytes) => ws.send(Buffer.from(bytes)),
      close: (code, reason) => ws.close({ code, reason }),
    })
    ws.onMessage((message) => room.receive(conn, typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message)))
    ws.onClose(() => room.leave(conn))
  })
  await installFixture(context)
  const tab = await context.newPage()
  tab.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`))
  // 统一外壳的网格是唯一实现（旧的 CsvCollabEditor 与 ?editor=legacy 已删除）
  await tab.goto(`${base}/kb?collection=knowledgeBase%2Finsights&item=file_csv`, { waitUntil: 'domcontentloaded' })
  await tab.waitForSelector('.kb-fv', { timeout: 20_000 })
  await tab.click('[data-testid="csv-edit-open"]')
  await tab.waitForSelector('[data-testid="editor-host"][data-surface-kind="grid"] .kb-gs', { timeout: 20_000 })
  // 原生网格必须已经接管，旧 CSV 表格/源码编辑器不能再出现
  await tab.waitForFunction(() => !document.querySelector('[data-testid="csv-collab-editor"]') && !document.querySelector('.cm-editor'))
  await tab.waitForTimeout(500)
  return { context, tab }
}

/** 选中单元格后用 F2 输入，Enter 提交；先点画布拿到键盘焦点 */
async function editCell(tab, row, col, value) {
  await tab.click('.kb-gs-canvas')
  await tab.keyboard.press('Control+Home')
  for (let i = 0; i < row; i += 1) await tab.keyboard.press('ArrowDown')
  for (let i = 0; i < col; i += 1) await tab.keyboard.press('ArrowRight')
  await tab.keyboard.press('F2')
  await tab.fill('.kb-gs-editor', value)
  await tab.keyboard.press('Enter')
  await tab.waitForTimeout(300)
}

async function selectedFormula(tab) {
  return tab.$eval('.kb-gs-formula-input', (input) => input.value)
}

/** 点第 `row` 行（视口顶部算起，0 基）的行号：整行选中。行号列 44 宽、列标行 24 高、行高 24（geometry.ts） */
async function selectRowHeader(tab, row) {
  await tab.click('.kb-gs-canvas', { position: { x: 20, y: 24 + row * 24 + 12 } })
}

/** 回到 A1 再走到第 row 行第 col 列，读公式栏 */
async function formulaAt(tab, row, col = 0) {
  await tab.click('.kb-gs-canvas')
  await tab.keyboard.press('Control+Home')
  for (let i = 0; i < row; i += 1) await tab.keyboard.press('ArrowDown')
  for (let i = 0; i < col; i += 1) await tab.keyboard.press('ArrowRight')
  await tab.waitForTimeout(150)
  return selectedFormula(tab)
}

try {
  const a = await openTab()
  const b = await openTab()

  await editCell(a.tab, 0, 0, '甲')
  await editCell(b.tab, 1, 1, '乙')
  await a.tab.waitForTimeout(800)

  const text = room.doc.getText('text').toString()
  const checks = [
    ['房间收到 A1', text.startsWith('甲,查询,命中名次,耗时(ms)')],
    ['房间收到 B2', text.includes('\nq001,"乙",1,40')],
    ['A 页面看到 B2', (await a.tab.keyboard.press('Control+Home'), await a.tab.keyboard.press('ArrowDown'), await a.tab.keyboard.press('ArrowRight'), await a.tab.waitForTimeout(200), (await selectedFormula(a.tab)) === '乙')],
    ['B 页面看到 A1', (await b.tab.keyboard.press('Control+Home'), await b.tab.waitForTimeout(200), (await selectedFormula(b.tab)) === '甲')],
    // 房间负责落地：状态栏显示同步状态，不是「已保存」
    ['状态栏显示「已同步」而不是「已保存」', ((await a.tab.textContent('[data-testid="editor-status-text"]')) ?? '').includes('已同步')],
  ]
  // ---- 行操作：插入 / 删除行走房间的文本补丁，对端互见 ----
  const rowChecks = []
  // A 在第 4 行（q003）上方插入一行并填内容
  await selectRowHeader(a.tab, 3)
  await a.tab.click('[data-action="row.insertAbove"]')
  await a.tab.keyboard.press('F2')
  await a.tab.fill('.kb-gs-editor', '新增行')
  await a.tab.keyboard.press('Enter')
  await a.tab.waitForTimeout(800)
  rowChecks.push(['房间收到 A 插入的行（在 q003 之前）', room.doc.getText('text').toString().includes('\n新增行\nq003,')])
  rowChecks.push(['B 在同一位置看到新增行', (await formulaAt(b.tab, 3)) === '新增行'])
  rowChecks.push(['B 那边 q003 顺延到下一行', (await formulaAt(b.tab, 4)) === 'q003'])

  // B 只插入一个空行、不填内容：不进房间，A 的行数不变
  const beforeBlank = room.doc.getText('text').toString()
  await selectRowHeader(b.tab, 1)
  await b.tab.click('[data-action="row.insertBelow"]')
  await b.tab.waitForTimeout(500)
  rowChecks.push(['B 的空行没有写进房间', room.doc.getText('text').toString() === beforeBlank])
  rowChecks.push(['A 那边行数没变（第 3 行仍是 q002）', (await formulaAt(a.tab, 2)) === 'q002'])

  // B 删除第 2 行（q001 那一行）：房间里少一行，A 立即看到
  await selectRowHeader(b.tab, 1)
  await b.tab.click('[data-action="row.delete"]')
  await b.tab.waitForTimeout(800)
  rowChecks.push(['房间里 q001 那一行没了', !room.doc.getText('text').toString().includes('q001,')])
  rowChecks.push(['A 的第 2 行变成 q002', (await formulaAt(a.tab, 1)) === 'q002'])
  // 两边的房间文本一致、表头没被动过
  rowChecks.push(['表头仍在第 1 行', room.doc.getText('text').toString().startsWith('甲,查询,命中名次,耗时(ms)\n')])
  checks.push(...rowChecks)

  for (const [name, ok] of checks) {
    if (ok) console.log(`✓ ${name}`)
    else {
      failures.push(name)
      console.log(`✗ ${name}`)
    }
  }
  for (const { context } of [a, b]) await context.close()
} finally {
  await browser.close()
  server.close()
}

if (failures.length) {
  console.error(`CSV 协同门禁失败：${failures.join('；')}`)
  process.exit(1)
}
console.log('✓ CSV 原生网格协同门禁通过')
