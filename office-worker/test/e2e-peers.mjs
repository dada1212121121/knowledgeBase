// 守护进程级端到端(由 crates/kb-cli/tests/e2e_office_collab.rs 启动):
// 三个「浏览器」——alice 的两个窗口 + 只有查看权限的 bob——用和浏览器同一个 npm 包的无界面副本,
// 走真实的 HTTP 鉴权、真实的 WebSocket(/api/v1/office/collab)和真实的 office-worker 协同同一份 xlsx。
// 结果以一行 JSON 打到标准输出,由 Rust 那边断言。
import { readFileSync } from 'node:fs'
import { initWasm, openWorkbook } from '@betteroffice/xlsx'
import { attachXlsx } from '@betteroffice/agents'
import { decode, encodeSync, SYNC, STEP1, STEP2, UPDATE } from '../src/ysync.mjs'

const { PORT, DOC, SHA, ALICE, BOB } = process.env
const base = `http://127.0.0.1:${PORT}`
await initWasm(readFileSync(new URL(import.meta.resolve('@betteroffice/xlsx')).pathname.replace(/index\.js$/, 'generated/xlsx_wasm_bg.wasm')))

async function fetchBase(cookie) {
  const response = await fetch(`${base}/api/v1/office/base?doc=${encodeURIComponent(DOC)}&sha=${SHA}`, { headers: { cookie: `kb_session=${cookie}` } })
  if (!response.ok) throw new Error(`底稿 HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** 一个「浏览器」:从底稿打开副本,连上房间,完成同步握手。 */
async function browser(name, cookie, clientId) {
  const bytes = await fetchBase(cookie)
  const replica = openWorkbook(bytes, { collaborative: true, clientId })
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/office/collab?doc=${encodeURIComponent(DOC)}`, {
    headers: { cookie: `kb_session=${cookie}`, origin: base },
  })
  socket.binaryType = 'arraybuffer'
  const peer = { name, replica, socket, received: 0, closed: null }
  let synced
  peer.synced = new Promise((resolve) => (synced = resolve))
  socket.onmessage = (event) => {
    const frame = new Uint8Array(event.data)
    for (const message of decode(frame)) {
      if (message.type !== SYNC) continue
      if (message.sub === STEP1) {
        socket.send(encodeSync(STEP2, replica.encodeStateAsUpdate(message.payload)))
        socket.send(encodeSync(STEP1, replica.encodeStateVector()))
      } else {
        if (message.sub === STEP2) synced()
        replica.applyUpdate(message.payload)
        if (message.sub === UPDATE) peer.received += 1
      }
    }
  }
  socket.onclose = (event) => (peer.closed = { code: event.code, reason: event.reason })
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error(`${name} 连不上`))
  })
  await Promise.race([peer.synced, new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} 同步超时`)), 15000))])
  return peer
}

async function edit(peer, cell, text) {
  const before = peer.replica.encodeStateVector()
  const agent = attachXlsx(peer.replica, { name: 'x.xlsx' })
  const sheet = agent.catalog()[0].name
  const handle = agent.readCells({ sheet, range: cell }).cells[0].cell
  await agent.accept(agent.proposeCells({ author: peer.name, edits: [{ cell: handle, input: text }] }).id)
  peer.socket.send(encodeSync(UPDATE, peer.replica.encodeStateAsUpdate(before)))
}

function read(peer, cell) {
  const agent = attachXlsx(peer.replica, { name: 'x.xlsx' })
  const sheet = agent.catalog()[0].name
  return agent.readCells({ sheet, range: cell }).cells[0].value?.value ?? null
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, ms = 10000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await wait(50)
  }
  return false
}

const result = {}
const started = performance.now()
const a1 = await browser('alice-1', ALICE, 1001)
result.joinMs = Math.round(performance.now() - started)
const a2 = await browser('alice-2', ALICE, 1002)
const b = await browser('bob', BOB, 2001)

// alice 的第一个窗口改一格:第二个窗口和 bob(只读)都实时看到
let t = performance.now()
await edit(a1, 'C4', 'alice 改的')
result.a2Sees = await until(() => read(a2, 'C4') === 'alice 改的')
result.relayMs = Math.round(performance.now() - t)
result.bobSees = await until(() => read(b, 'C4') === 'alice 改的')

// bob 只有查看权限:他的修改不会传给别人
await edit(b, 'C5', 'bob 想改')
await wait(800)
result.bobEditReachedAlice = read(a1, 'C5') === 'bob 想改'

// 第二个窗口也改一格,第一个窗口看到
await edit(a2, 'C6', '第二个窗口改的')
result.a1Sees = await until(() => read(a1, 'C6') === '第二个窗口改的')

// 等落地(停手约 2 秒):守护进程把文件写回;用 file_info 的哈希判断
const before = SHA
result.landed = await until(() => false, 0)
for (let i = 0; i < 60; i++) {
  const info = await (await fetch(`${base}/api/v1/capabilities/file_info`, {
    method: 'POST',
    headers: { cookie: `kb_session=${ALICE}`, 'x-kb-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ collection: '_global', path: 'sheet.xlsx' }),
  })).json()
  if (info.data?.sha256 && info.data.sha256 !== before) {
    result.landed = true
    result.landedSha = info.data.sha256
    break
  }
  await wait(250)
}
// 房间开着时,房间外的整文件替换被拒绝
const replace = await fetch(`${base}/api/v1/files/replace?collection=_global&path=sheet.xlsx`, {
  method: 'PUT',
  headers: { cookie: `kb_session=${ALICE}`, 'x-kb-csrf': '1' },
  body: new Uint8Array([0x50, 0x4b, 3, 4]),
})
result.replaceStatus = replace.status
for (const peer of [a1, a2, b]) peer.socket.close()
await wait(300)
console.log(JSON.stringify(result))
process.exit(0)
