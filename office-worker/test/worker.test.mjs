// 真实进程 + 真实引擎:守护进程那一侧用帧驱动 office-worker;两个「浏览器」用同一个 npm 包的无界面副本
// 通过它协同。验证:同步、转发、落地出来的文件包含两边的修改、关房间、空闲退出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FrameReader, encodeFrame } from '../src/ipc.mjs'
import { decode, encodeSync, SYNC, STEP1, STEP2, UPDATE } from '../src/ysync.mjs'
import { initWasm, openWorkbook } from '@betteroffice/xlsx'
import { initWasm as initPptx, openPresentation } from '@betteroffice/pptx'
import { createYrsSession, saveYrsDocx } from '@betteroffice/docx/yrs'
import { attachDocx, attachPptx, attachXlsx, openDocx, openPptx, openXlsx } from '@betteroffice/agents'

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
await initWasm(readFileSync(new URL(import.meta.resolve('@betteroffice/xlsx')).pathname.replace(/index\.js$/, 'generated/xlsx_wasm_bg.wasm')))
await initPptx(readFileSync(new URL(import.meta.resolve('@betteroffice/pptx')).pathname.replace(/index\.js$/, 'generated/pptx_wasm_bg.wasm')))

function startWorker(env = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url))], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const reader = new FrameReader()
  const inbox = []
  const waiters = []
  child.stdout.on('data', (chunk) => {
    for (const frame of reader.push(chunk)) {
      inbox.push(frame)
      for (const waiter of [...waiters]) if (waiter.match(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(frame)
      }
    }
  })
  return {
    child,
    inbox,
    send: (meta, body) => child.stdin.write(encodeFrame(meta, body)),
    wait(match, ms = 20000) {
      const found = inbox.find(match)
      if (found) {
        inbox.splice(inbox.indexOf(found), 1)
        return Promise.resolve(found)
      }
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve: (frame) => { inbox.splice(inbox.indexOf(frame), 1); resolve(frame) } }
        waiters.push(waiter)
        setTimeout(() => reject(new Error('等不到 ' + match.toString())), ms)
      })
    },
  }
}

/** 一个「浏览器」:无界面副本 + 把收到的帧应用上 */
function peer(open) {
  const replica = open()
  return {
    replica,
    receive(frame) {
      for (const message of decode(frame.body)) {
        if (message.type !== SYNC) continue
        if (message.sub === STEP1) return encodeSync(STEP2, replica.encodeStateAsUpdate(message.payload))
        replica.applyUpdate(message.payload)
      }
      return null
    },
  }
}

async function scenario(format, file, openPeer, edit, check) {
  const worker = startWorker({ KB_OFFICE_IDLE_EXIT_MS: '1500' })
  await worker.wait((f) => f.meta.t === 'ready')
  const room = `doc:${format}`
  worker.send({ t: 'open', room, format, base: fixture(file) })
  const opened = await worker.wait((f) => f.meta.t === 'opened')
  assert.equal(opened.meta.ok, true, opened.meta.error)
  const bytes = new Uint8Array(readFileSync(fixture(file)))
  const a = peer(() => openPeer(bytes, 101))
  const b = peer(() => openPeer(bytes, 202))
  for (const [conn, who] of [[1, a], [2, b]]) {
    worker.send({ t: 'join', room, conn, writable: true, user: { id: `u${conn}`, name: `用户${conn}` } })
    const hello = await worker.wait((f) => f.meta.t === 'send' && f.meta.conn === conn)
    const reply = who.receive(hello)
    if (reply) worker.send({ t: 'frame', room, conn }, reply)
    worker.send({ t: 'frame', room, conn }, encodeSync(STEP1, who.replica.encodeStateVector()))
    const step2 = await worker.wait((f) => f.meta.t === 'send' && f.meta.conn === conn)
    who.receive(step2)
  }
  // a 改,经服务端转发给 b
  const before = a.replica.encodeStateVector()
  await edit(a.replica, 'A 写的')
  const delta = a.replica.encodeStateAsUpdate(before)
  worker.send({ t: 'frame', room, conn: 1 }, encodeSync(UPDATE, delta))
  const relayed = await worker.wait((f) => f.meta.t === 'broadcast' && f.meta.except === 1)
  b.receive(relayed)
  const persisted = await worker.wait((f) => f.meta.t === 'persist')
  assert.equal(persisted.meta.conn, 1)
  assert.ok(persisted.body.length > 2)
  assert.deepEqual([...b.replica.encodeStateVector()], [...a.replica.encodeStateVector()], '两端汇合')
  // 落地:停手约 2 秒后守护进程收到文件
  const land = await worker.wait((f) => f.meta.t === 'land', 10000)
  await check(land.body)
  worker.send({ t: 'landed', seq: land.meta.seq, ok: true })
  // 都离开 → 30 秒后关房间(这里不等那么久:直接要求关)→ 空闲 1.5 秒后进程自己退出
  worker.send({ t: 'leave', room, conn: 1 })
  worker.send({ t: 'leave', room, conn: 2 })
  worker.send({ t: 'close', room })
  await worker.wait((f) => f.meta.t === 'closed')
  const exit = await new Promise((resolve) => worker.child.on('exit', resolve))
  assert.equal(exit, 0, '没有房间后自己退出')
}

test('xlsx:两个副本经 office-worker 协同,落地的文件里有修改,随后空闲退出', async () => {
  await scenario(
    'xlsx',
    'sheet.xlsx',
    (bytes, clientId) => openWorkbook(bytes, { collaborative: true, clientId }),
    async (replica, text) => {
      const agent = attachXlsx(replica, { name: 'a.xlsx' })
      const sheet = agent.catalog()[0].name
      const cell = agent.readCells({ sheet, range: 'C4' }).cells[0].cell
      await agent.accept(agent.proposeCells({ author: 'A', edits: [{ cell, input: text }] }).id)
    },
    async (file) => {
      const reopened = await openXlsx(file, { name: 'saved.xlsx' })
      const sheet = reopened.catalog()[0].name
      assert.equal(reopened.readCells({ sheet, range: 'C4' }).cells[0].value.value, 'A 写的')
    },
  )
})

test('pptx:同样的流程', async () => {
  await scenario(
    'pptx',
    'deck.pptx',
    (bytes, clientId) => openPresentation(bytes, { clientId }),
    async (replica, text) => {
      const agent = attachPptx(replica, { name: 'a.pptx' })
      const hit = agent.grep({ query: '路线图', limit: 1 }).matches[0]
      await agent.accept(agent.propose({ author: 'A', edits: [{ match: hit.match, newText: text }] }).id)
    },
    async (file) => {
      const reopened = await openPptx(file, { name: 'saved.pptx' })
      assert.equal(reopened.grep({ query: 'A 写的', limit: 1 }).matches.length, 1)
    },
  )
})

test('打开失败(文件不存在)回报错误,进程不退出', async () => {
  const worker = startWorker({ KB_OFFICE_IDLE_EXIT_MS: '800' })
  await worker.wait((f) => f.meta.t === 'ready')
  worker.send({ t: 'open', room: 'x', format: 'xlsx', base: '/nonexistent.xlsx' })
  const opened = await worker.wait((f) => f.meta.t === 'opened')
  assert.equal(opened.meta.ok, false)
  assert.match(opened.meta.error, /ENOENT/)
  worker.send({ t: 'open', room: 'y', format: 'xlsx', base: fixture('sheet.xlsx'), sha: 'deadbeef' })
  const mismatch = await worker.wait((f) => f.meta.t === 'opened')
  assert.equal(mismatch.meta.ok, false)
  assert.match(mismatch.meta.error, /哈希对不上/)
  const exit = await new Promise((resolve) => worker.child.on('exit', resolve))
  assert.equal(exit, 0)
})

test('docx:浏览器拿服务端的初始状态加入,修改汇合,落地的文件只动正文', async () => {
  const worker = startWorker({ KB_OFFICE_IDLE_EXIT_MS: '1500' })
  await worker.wait((f) => f.meta.t === 'ready')
  const room = 'doc:docx'
  worker.send({ t: 'open', room, format: 'docx', base: fixture('small.docx') })
  const opened = await worker.wait((f) => f.meta.t === 'opened')
  assert.equal(opened.meta.ok, true, opened.meta.error)
  worker.send({ t: 'seed', room, id: 1 })
  const seed = await worker.wait((f) => f.meta.t === 'seed')
  assert.equal(seed.meta.ok, true)
  assert.ok(seed.body.length > 100 && seed.body.length < 200_000, `初始状态 ${seed.body.length} 字节`)
  const peers = []
  for (const conn of [1, 2]) {
    const session = await createYrsSession({ clientId: 100 + conn })
    session.loadState(seed.body)
    worker.send({ t: 'join', room, conn, writable: true, user: { id: `u${conn}`, name: `用户${conn}` } })
    const hello = await worker.wait((f) => f.meta.t === 'send' && f.meta.conn === conn)
    const [step1] = decode(hello.body)
    // 服务端已经有初始状态里的全部内容(状态向量相同;多出来的只是几字节的删除集)
    assert.deepEqual([...session.encodeStateVector()], [...step1.payload])
    peers.push(session)
  }
  const [a, b] = peers
  const agent = attachDocx(a, { name: 'a.docx' })
  const hit = agent.grep({ query: '的', limit: 1 }).matches[0]
  const before = a.encodeStateVector()
  await agent.accept(agent.propose({ author: 'A', edits: [{ match: hit.match, newText: '的(A 改)' }] }).id)
  worker.send({ t: 'frame', room, conn: 1 }, encodeSync(UPDATE, a.encodeStateAsUpdate(before)))
  const relayed = await worker.wait((f) => f.meta.t === 'broadcast' && f.meta.except === 1)
  for (const message of decode(relayed.body)) b.applyUpdate(message.payload)
  assert.deepEqual([...b.encodeStateVector()], [...a.encodeStateVector()])
  const land = await worker.wait((f) => f.meta.t === 'land', 10000)
  const saved = await openDocx(land.body, { name: 'saved.docx' })
  assert.equal(saved.grep({ query: '的(A 改)', limit: 1 }).matches.length, 1, '落地的文件里有修改')
  worker.send({ t: 'landed', seq: land.meta.seq, ok: true })
  worker.send({ t: 'shutdown' })
  const bye = await worker.wait((f) => f.meta.t === 'bye')
  assert.equal(bye.meta.reason, 'shutdown')
})

test('落地失败(守护进程回 ok:false)时内容还在,下一次重试', async () => {
  const worker = startWorker({ KB_OFFICE_IDLE_EXIT_MS: '60000' })
  await worker.wait((f) => f.meta.t === 'ready')
  const room = 'doc:retry'
  worker.send({ t: 'open', room, format: 'xlsx', base: fixture('sheet.xlsx') })
  await worker.wait((f) => f.meta.t === 'opened')
  const bytes = new Uint8Array(readFileSync(fixture('sheet.xlsx')))
  const a = openWorkbook(bytes, { collaborative: true, clientId: 333 })
  worker.send({ t: 'join', room, conn: 1, writable: true, user: { id: 'u', name: 'u' } })
  await worker.wait((f) => f.meta.t === 'send' && f.meta.conn === 1)
  const sv = a.encodeStateVector()
  const agent = attachXlsx(a, { name: 'a.xlsx' })
  const sheet = agent.catalog()[0].name
  await agent.accept(agent.proposeCells({ author: 'A', edits: [{ cell: agent.readCells({ sheet, range: 'B2' }).cells[0].cell, input: '要重试的' }] }).id)
  worker.send({ t: 'frame', room, conn: 1 }, encodeSync(UPDATE, a.encodeStateAsUpdate(sv)))
  const first = await worker.wait((f) => f.meta.t === 'land', 10000)
  worker.send({ t: 'landed', seq: first.meta.seq, ok: false, error: '磁盘满了' })
  const second = await worker.wait((f) => f.meta.t === 'land', 10000)
  assert.notEqual(second.meta.seq, first.meta.seq)
  assert.ok(second.body.length > 1000)
  // 之前攒下的状态消息(加入时的「不脏」)不算:只认这次落地之后的
  for (const frame of worker.inbox.filter((f) => f.meta.t === 'status')) worker.inbox.splice(worker.inbox.indexOf(frame), 1)
  worker.send({ t: 'landed', seq: second.meta.seq, ok: true })
  await worker.wait((f) => f.meta.t === 'status' && f.meta.dirty === false && f.meta.landing === false)
  worker.send({ t: 'stats', id: 9 })
  const stats = await worker.wait((f) => f.meta.t === 'stats')
  assert.equal(stats.meta.rooms[0].landFailures, 1)
  assert.equal(stats.meta.rooms[0].dirty, false)
  assert.deepEqual(stats.meta.formats, ['xlsx'], '只加载了用到的格式')
  worker.child.kill()
})

test('AI 的修改:在服务端副本上替换,广播给在线的人,随后落地;原文不唯一 / 找不到整批不改', async () => {
  for (const [format, file, old, replacement, check] of [
    ['xlsx', 'sheet.xlsx', 'DEMO2026010044', 'DEMO2026010044-AI', async (bytes) => (await openXlsx(bytes, { name: 'x.xlsx' })).grep({ query: 'DEMO2026010044-AI', limit: 1 }).matches.length === 1],
    ['pptx', 'deck.pptx', '路线图', '路线图(AI)', async (bytes) => (await openPptx(bytes, { name: 'x.pptx' })).grep({ query: '路线图(AI)', limit: 1 }).matches.length === 1],
    ['docx', 'small.docx', '六、维护命令', '六、维护命令(AI)', async (bytes) => (await openDocx(bytes, { name: 'x.docx' })).grep({ query: '维护命令(AI)', limit: 1 }).matches.length === 1],
  ]) {
    const worker = startWorker({ KB_OFFICE_IDLE_EXIT_MS: '60000' })
    await worker.wait((f) => f.meta.t === 'ready')
    const room = `doc:ai-${format}`
    worker.send({ t: 'open', room, format, base: fixture(file) })
    assert.equal((await worker.wait((f) => f.meta.t === 'opened')).meta.ok, true)
    worker.send({ t: 'join', room, conn: 7, writable: true, user: { id: 'u', name: 'u' } })
    await worker.wait((f) => f.meta.t === 'send' && f.meta.conn === 7)
    // 不唯一 / 找不到:不改、不广播
    worker.send({ t: 'agent_edit', room, id: 1, edits: [{ old, new: replacement }, { old: format === 'xlsx' ? '示例项目04' : '绝对不存在的原文', new: 'y' }], author: 'AI' })
    const refused = await worker.wait((f) => f.meta.t === 'agent_edit' && f.meta.id === 1)
    assert.equal(refused.meta.ok, false, `${format} 应拒绝`)
    worker.send({ t: 'agent_edit', room, id: 2, edits: [{ old, new: replacement }], author: 'AI' })
    const done = await worker.wait((f) => f.meta.t === 'agent_edit' && f.meta.id === 2)
    assert.equal(done.meta.ok, true, `${format}:${done.meta.error}`)
    assert.equal(done.meta.changed, 1)
    const relayed = await worker.wait((f) => f.meta.t === 'broadcast' && f.meta.except === null)
    assert.ok(relayed.body.length > 3, `${format} 的修改广播给了在线的人`)
    const persisted = await worker.wait((f) => f.meta.t === 'persist' && f.meta.conn === null)
    assert.ok(persisted.body.length > 2)
    const land = await worker.wait((f) => f.meta.t === 'land', 10000)
    assert.equal(await check(land.body), true, `${format} 落地的文件里有 AI 的修改`)
    // 读出来的纯文本就是房间里现在的内容(含 AI 刚改的)
    worker.send({ t: 'agent_read', room, id: 3 })
    const read = await worker.wait((f) => f.meta.t === 'agent_read' && f.meta.id === 3)
    assert.equal(read.meta.ok, true)
    assert.ok(new TextDecoder().decode(read.body).includes(replacement), `${format} 读到了修改后的内容`)
    worker.send({ t: 'landed', seq: land.meta.seq, ok: true })
    worker.child.kill()
  }
})

test('增量合并:攒够条数后发出一份合并状态;新进程从底稿 + 合并状态 + 之后的增量恢复出同样的内容', async () => {
  const worker = startWorker({ KB_OFFICE_IDLE_EXIT_MS: '60000', KB_OFFICE_COMPACT_EVERY: '3' })
  await worker.wait((f) => f.meta.t === 'ready')
  const room = 'doc:compact'
  worker.send({ t: 'open', room, format: 'xlsx', base: fixture('sheet.xlsx') })
  assert.equal((await worker.wait((f) => f.meta.t === 'opened')).meta.ok, true)
  const persisted = []
  let merged = null
  for (let n = 42; n <= 45; n++) {
    worker.send({ t: 'agent_edit', room, id: n, edits: [{ old: `DEMO20260100${n}`, new: `已改-${n}` }], author: 'AI' })
    assert.equal((await worker.wait((f) => f.meta.t === 'agent_edit' && f.meta.id === n)).meta.ok, true)
    persisted.push((await worker.wait((f) => f.meta.t === 'persist')).body)
    if (n === 44) merged = (await worker.wait((f) => f.meta.t === 'compact' && f.meta.room === room)).body
  }
  assert.ok(merged && merged.length > 2, '第 3 条之后合并了一次')
  assert.equal(worker.inbox.filter((f) => f.meta.t === 'compact').length, 0, '第 4 条之后还不够,不再合并')
  worker.child.kill()

  // 「崩溃」后的新进程:底稿 + 合并状态 + 合并之后的那 1 条
  const next = startWorker({ KB_OFFICE_IDLE_EXIT_MS: '60000' })
  await next.wait((f) => f.meta.t === 'ready')
  next.send({ t: 'open', room, format: 'xlsx', base: fixture('sheet.xlsx') })
  assert.equal((await next.wait((f) => f.meta.t === 'opened')).meta.ok, true)
  next.send({ t: 'restore', room }, merged)
  next.send({ t: 'restore', room }, persisted[3])
  next.send({ t: 'agent_read', room, id: 1 })
  const read = new TextDecoder().decode((await next.wait((f) => f.meta.t === 'agent_read')).body)
  for (let n = 42; n <= 45; n++) assert.ok(read.includes(`已改-${n}`), `恢复出了第 ${n} 行的修改`)
  next.child.kill()
})
