#!/usr/bin/env node
/**
 * 代码 / 文本文件多人编辑走新外壳
 *
 * 进代码文件编辑就是统一外壳里的 CodeEditor（旧的 CodeMirror 外壳已删除，`?editor=` 参数被忽略）；
 * 两个窗口接同一个纯文本房间（e2e/collab-room.mjs，按 crates/kb-collab 状态机写的），页面与 Yjs 都是真的：
 *   1. 挂的是统一外壳里的代码面，并显示协同名单与「已同步」；
 *   2. 一个窗口写的字另一个窗口看得到，反过来也一样，房间文本里两处都有；
 *   3. 外壳里没有「保存」（房间由服务端落地），撤销只撤自己写的。
 *
 * 用法（先 npm run build）：node e2e/editor-code-collab.mjs
 */
import { chromium } from '@playwright/test'
import { FILES, installFixture } from './fixture.mjs'
import { startStaticServer } from './serve.mjs'
import { FakeRoom } from './collab-room.mjs'

const COLLECTION = 'knowledgeBase%2Finsights'
const ME = { id: 'usr_admin', name: '管理员' }
const PEER = { id: 'usr_green_2', name: 'Green' }
const SOURCE = FILES.file_rs.preview.content
const { server, base } = await startStaticServer()
const browser = await chromium.launch({ chromiumSandbox: false })
const room = new FakeRoom({ kind: 'text', text: SOURCE })
const failures = []

function check(name, ok, detail = '') {
  if (ok) console.log(`✓ ${name}`)
  else {
    failures.push(`${name}${detail ? `：${detail}` : ''}`)
    console.log(`✗ ${name}${detail ? `：${detail}` : ''}`)
  }
}

async function openEditor(who, extra) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  await context.routeWebSocket(/\/api\/v1\/collab\/ws/, (ws) => {
    const conn = room.join(who, true, {
      send: (bytes) => ws.send(Buffer.from(bytes)),
      close: (code, reason) => ws.close({ code, reason }),
    })
    ws.onMessage((message) => room.receive(conn, typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message)))
    ws.onClose(() => room.leave(conn))
  })
  await installFixture(context)
  const tab = await context.newPage()
  tab.on('pageerror', (error) => failures.push(`页面异常：${error.message}`))
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=file_rs${extra}`, { waitUntil: 'domcontentloaded' })
  await tab.getByRole('button', { name: /^编辑$/ }).first().click({ timeout: 20_000 })
  await tab.waitForSelector('.kb-ce .cm-content[contenteditable="true"]', { timeout: 20_000 })
  await tab.waitForTimeout(400)
  return { context, tab }
}

/** 在第 n 行末尾敲字（CodeMirror 的行就是 .cm-line） */
async function typeAtLine(tab, line, text) {
  await tab.click(`.kb-ce .cm-line >> nth=${line}`)
  await tab.keyboard.press('End')
  await tab.keyboard.type(text, { delay: 15 })
}

const contentOf = (tab) => tab.$eval('.kb-ce .cm-content', (el) => el.textContent ?? '')
const waitText = (tab, needle) =>
  tab
    .waitForFunction((value) => (document.querySelector('.kb-ce .cm-content')?.textContent ?? '').includes(value), needle, { timeout: 8000 })
    .then(() => true)
    .catch(() => false)

try {
  const native = await openEditor(ME, '')
  const info = await native.tab.evaluate(() => ({
    host: !!document.querySelector('[data-testid="editor-host"][data-surface-kind="code"]'),
    collabBar: !!document.querySelector('[data-testid="collab-bar"]'),
    save: !!document.querySelector('[data-testid="editor-save"]'),
    status: document.querySelector('[data-testid="editor-status-text"]')?.textContent?.trim() ?? '',
  }))
  check('进的是统一外壳里的代码面', info.host)
  check('外壳显示协同名单', info.collabBar)
  check('房间里外壳不给「保存」', !info.save)
  check('状态栏显示同步状态', /已同步|正在同步/.test(info.status), info.status)

  // 带着旧的 ?editor=legacy 链接进来的另一个人：参数被忽略，照样是同一个外壳
  const peer = await openEditor(PEER, '&editor=legacy')
  check('另一个窗口（带旧的 ?editor=legacy 链接）也是统一外壳', !!(await peer.tab.$('[data-testid="editor-host"]')))

  await typeAtLine(native.tab, 0, ' // 窗口甲写的')
  check('窗口乙看到窗口甲写的字', await waitText(peer.tab, '窗口甲写的'))
  await typeAtLine(peer.tab, 1, ' // 窗口乙写的')
  check('窗口甲看到窗口乙写的字', await waitText(native.tab, '窗口乙写的'))
  const text = room.doc.getText('text').toString()
  check('房间文本里两处都有', text.includes('窗口甲写的') && text.includes('窗口乙写的'))

  // 撤销只撤自己的：窗口甲撤一次，窗口乙写的还在
  await native.tab.click('[data-testid="editor-undo"]')
  await native.tab.waitForTimeout(500)
  const afterUndo = await contentOf(native.tab)
  check('撤销只撤自己写的', !afterUndo.includes('窗口甲写的') && afterUndo.includes('窗口乙写的'), afterUndo.slice(0, 120))

  await native.context.close()
  await peer.context.close()
} finally {
  await browser.close()
  server.close()
}

if (failures.length) {
  console.error(`\n代码文件协同门禁失败：\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\n✓ 代码文件协同门禁通过')
