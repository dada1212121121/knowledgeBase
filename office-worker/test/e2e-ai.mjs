// 守护进程级端到端(由 crates/kb-cli/tests/e2e_office_collab.rs 启动):alice 用一个「浏览器」打开表格,
// AI(带 X-KB-Client 的同一账号)经能力接口 doc_read / doc_edit 改同一份表格;
// alice 的副本实时看到修改、连接不断。结果以一行 JSON 打到标准输出,由 Rust 那边断言。
import { readFileSync } from 'node:fs'
import { initWasm, openWorkbook } from '@betteroffice/xlsx'
import { attachXlsx } from '@betteroffice/agents'
import { decode, encodeSync, SYNC, STEP1, STEP2, UPDATE } from '../src/ysync.mjs'

const { PORT, DOC, SHA, ALICE, PATH_IN_KB } = process.env
const base = `http://127.0.0.1:${PORT}`
await initWasm(readFileSync(new URL(import.meta.resolve('@betteroffice/xlsx')).pathname.replace(/index\.js$/, 'generated/xlsx_wasm_bg.wasm')))

const bytes = new Uint8Array(await (await fetch(`${base}/api/v1/office/base?doc=${encodeURIComponent(DOC)}&sha=${SHA}`, { headers: { cookie: `kb_session=${ALICE}` } })).arrayBuffer())
const replica = openWorkbook(bytes, { collaborative: true, clientId: 3001 })
const socket = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/office/collab?doc=${encodeURIComponent(DOC)}`, { headers: { cookie: `kb_session=${ALICE}`, origin: base } })
socket.binaryType = 'arraybuffer'
let closed = null
let synced
const ready = new Promise((resolve) => (synced = resolve))
socket.onmessage = (event) => {
  for (const message of decode(new Uint8Array(event.data))) {
    if (message.type !== SYNC) continue
    if (message.sub === STEP1) {
      socket.send(encodeSync(STEP2, replica.encodeStateAsUpdate(message.payload)))
      socket.send(encodeSync(STEP1, replica.encodeStateVector()))
    } else {
      if (message.sub === STEP2) synced()
      replica.applyUpdate(message.payload)
    }
  }
}
socket.onclose = (event) => (closed = { code: event.code, reason: event.reason })
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = () => reject(new Error('连不上'))
})
await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('同步超时')), 15000))])

const read = (cell) => {
  const agent = attachXlsx(replica, { name: 'x.xlsx' })
  return agent.readCells({ sheet: agent.catalog()[0].name, range: cell }).cells[0].value?.value ?? null
}
const ai = async (capability, args) =>
  (await fetch(`${base}/api/v1/capabilities/${capability}`, {
    method: 'POST',
    headers: { cookie: `kb_session=${ALICE}`, 'x-kb-csrf': '1', 'x-kb-client': 'claude', 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })).json()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const result = {}
const target = { collection: '_global', path: PATH_IN_KB }
const readBack = await ai('doc_read', target)
result.readLive = readBack.data?.live
result.readHasCell = String(readBack.data?.text ?? '').includes('B4=DEMO2026010044')
const started = performance.now()
const edited = await ai('doc_edit', { ...target, edits: [{ old: 'DEMO2026010044', new: 'PRJ-AI-44' }] })
result.applied = edited.data?.applied
result.editLive = edited.data?.live
result.callMs = Math.round(performance.now() - started)
for (let i = 0; i < 200 && read('B4') !== 'PRJ-AI-44'; i++) await wait(25)
result.browserSees = read('B4') === 'PRJ-AI-44'
result.relayMs = Math.round(performance.now() - started)
result.closed = closed
console.log(JSON.stringify(result))
socket.close()
await wait(100)
process.exit(0)
