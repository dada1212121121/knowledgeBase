#!/usr/bin/env node
/**
 * 笔记多人编辑：两个文本面客户端进同一个房间（旧 Milkdown 编辑器已删除，不再有「新旧混用」的另一端）
 *
 * 房间协议来自 e2e/collab-room.mjs（按 crates/kb-collab 的状态机写的），页面、Yjs、y-prosemirror 都是真的。
 * 两个独立浏览器上下文接同一个假房间：
 *   1. 甲客户端初始化空房间，乙客户端加入后看到同样的正文；两边各写一句，互相看到；
 *   2. 甲客户端初始化一份覆盖全部语法的正文（脚注 / 公式 / 颜色 / HTML / 表格 / 任务列表），
 *      乙客户端加入后房间里一个元素都不少（y-prosemirror 遇到不认识的节点会删掉它，这里守的就是这个）；
 *   3. 甲客户端当落地者：服务端收到的 Markdown 带着两边写的内容。
 * 与历史上 Milkdown 写的房间的兼容由 src/editor/surfaces/text/roomSchema.spec.ts 对着冻结的快照守住（单测，不需要浏览器）。
 *
 * 用法（先 npm run build）：node e2e/editor-text-collab.mjs
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { installFixture } from './fixture.mjs'
import { startStaticServer } from './serve.mjs'
import { FakeRoom } from './collab-room.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SAMPLE = readFileSync(join(ROOT, 'src', 'editor', 'surfaces', 'text', 'fixtures', 'room-sample.md'), 'utf8')
const COLLECTION = 'knowledgeBase%2Finsights'
const ME = { id: 'usr_admin', name: '管理员' }
const PEER = { id: 'usr_green_2', name: 'Green' }

const { server, base } = await startStaticServer()
const browser = await chromium.launch({ chromiumSandbox: false })
const failures = []

/** 打开笔记并进入编辑；返回页面与正文选择器 */
async function openEditor(room, who, body) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  await context.routeWebSocket(/\/api\/v1\/collab\/ws/, (ws) => {
    const conn = room.join(who, true, {
      send: (bytes) => ws.send(Buffer.from(bytes)),
      close: (code, reason) => ws.close({ code, reason }),
    })
    ws.onMessage((message) => room.receive(conn, typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message)))
    ws.onClose(() => room.leave(conn))
  })
  await installFixture(context, {
    get_item: () => ({
      item: { id: 'ins_8f21', collection: 'knowledgeBase/insights', kind: 'insight', insight_kind: 'note', title: '多人编辑', header: '多人编辑', text: body, tags: [], source: 'insight:ins_8f21', updated_at: 1793000000, version: 3, status: 'active' },
      context: null,
    }),
  })
  const tab = await context.newPage()
  tab.on('pageerror', (error) => failures.push(`${who.name}: 页面异常 ${error.message}`))
  await tab.goto(`${base}/kb?collection=${COLLECTION}&item=ins_8f21`, { waitUntil: 'domcontentloaded' })
  await tab.getByRole('button', { name: '编辑', exact: true }).first().click({ timeout: 20_000 })
  await tab.waitForSelector('[data-testid=collab-bar]', { timeout: 15_000 })
  const prose = '[data-testid="editor-host"] .kb-text-prose'
  await tab.waitForSelector(prose, { timeout: 20_000 })
  // 房间同步好之前编辑器是锁着的
  await tab.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('contenteditable') === 'true', prose, { timeout: 15_000 })
  return { context, tab, prose }
}

const textOf = (client) => client.tab.$eval(client.prose, (el) => el.textContent ?? '')

/** 在正文最后一段的末尾敲字 */
async function typeAtEnd(client, text) {
  await client.tab.evaluate((selector) => {
    const root = document.querySelector(selector)
    const blocks = [...root.querySelectorAll('p, h1, h2, h3, li')].filter((el) => el.textContent.trim())
    const last = blocks[blocks.length - 1]
    const range = document.createRange()
    range.selectNodeContents(last)
    range.collapse(false)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    root.focus()
  }, client.prose)
  await client.tab.keyboard.type(text, { delay: 20 })
}

async function waitText(client, needle, timeout = 8000) {
  return client.tab
    .waitForFunction(([selector, value]) => (document.querySelector(selector)?.textContent ?? '').includes(value), [client.prose, needle], { timeout })
    .then(() => true)
    .catch(() => false)
}

/** 房间里每种元素的个数：y-prosemirror 删掉不认识的元素时，这个计数会变 */
function elementCounts(room) {
  const counts = {}
  const walk = (node) => {
    if (node.nodeName) counts[node.nodeName] = (counts[node.nodeName] ?? 0) + 1
    if (typeof node.toArray === 'function') for (const child of node.toArray()) walk(child)
  }
  for (const child of room.doc.getXmlFragment('prosemirror').toArray()) walk(child)
  return counts
}

function check(name, ok, detail = '') {
  if (ok) console.log(`✓ ${name}`)
  else {
    failures.push(`${name}${detail ? `：${detail}` : ''}`)
    console.log(`✗ ${name}${detail ? `：${detail}` : ''}`)
  }
}

try {
  // ---- 1. 甲客户端初始化，乙客户端加入；两边互写
  {
    const body = '# 部署手册\n\n先停服,再升级。\n'
    const room = new FakeRoom({ kind: 'rich', markdown: body })
    const native = await openEditor(room, ME, body)
    check('甲客户端把正文放进空房间', (await waitText(native, '先停服,再升级。')) && room.doc.getXmlFragment('prosemirror').length > 0)
    const peer = await openEditor(room, PEER, body)
    check('乙客户端加入后看到甲客户端放进去的正文', await waitText(peer, '先停服,再升级。'))
    await typeAtEnd(native, '甲客户端写的')
    check('乙客户端看到甲客户端写的字', await waitText(peer, '甲客户端写的'))
    await typeAtEnd(peer, '乙客户端写的')
    check('甲客户端看到乙客户端写的字', await waitText(native, '乙客户端写的'))
    // 甲客户端先加入，是落地者：让它马上提交
    room.landNow()
    await native.tab.waitForTimeout(800)
    const landed = room.landed[room.landed.length - 1]?.markdown ?? ''
    check('甲客户端落地的 Markdown 带着两边写的内容', landed.includes('甲客户端写的') && landed.includes('乙客户端写的') && landed.startsWith('# 部署手册'), JSON.stringify(landed.slice(0, 120)))
    await native.context.close()
    await peer.context.close()
  }

  // ---- 2. 甲客户端初始化全部语法，乙客户端加入后一个元素都不少
  {
    const room = new FakeRoom({ kind: 'rich', markdown: SAMPLE })
    const first = await openEditor(room, PEER, SAMPLE)
    await first.tab.waitForTimeout(1200)
    const before = elementCounts(room)
    const native = await openEditor(room, ME, SAMPLE)
    await native.tab.waitForTimeout(1500)
    const after = elementCounts(room)
    check('乙客户端加入后房间里的元素一个不少', JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
    for (const name of ['footnote_reference', 'footnote_definition', 'math_inline', 'html', 'table_header_row']) {
      check(`房间里仍有 ${name}`, (after[name] ?? 0) > 0)
    }
    const [firstText, nativeText] = await Promise.all([textOf(first), textOf(native)])
    check('两边正文文字一致', firstText.replace(/\s+/g, '').includes('第一个脚注') && nativeText.includes('第一个脚注') && nativeText.includes('E=mc^2'))
    // 乙客户端改一处，甲客户端那边的特殊节点也不能被连带删掉
    await typeAtEnd(native, '补一句')
    check('甲客户端看到乙客户端的修改', await waitText(first, '补一句'))
    await first.tab.waitForTimeout(800)
    const edited = elementCounts(room)
    check('编辑之后特殊节点仍然在', ['footnote_definition', 'math_inline', 'html'].every((name) => (edited[name] ?? 0) === (before[name] ?? 0)), JSON.stringify(edited))
    await native.context.close()
    await first.context.close()
  }
} finally {
  await browser.close()
  server.close()
}

if (failures.length) {
  console.error(`\n笔记协同门禁失败：\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\n✓ 笔记协同门禁通过')
