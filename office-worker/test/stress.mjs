// 办公文档协同压测:真实守护进程 + 真实 office-worker,N 个「浏览器」(和浏览器同一个 npm 包的无界面副本)
// 同时编辑同一份 xlsx,每人每隔 INTERVAL 毫秒改一个自己的格子,格子的值里带着改的时刻。
// 「浏览器」分散在 THREADS 个线程里(每个线程有自己的引擎实例),免得压测端自己成为瓶颈:
// 单线程里 20 个副本每条更新都要各应用一遍,测出来的是压测端排队,不是服务端。
//
// 统计:一次修改到达其他人的延迟分位数(每人观察前 OBSERVERS 个人的格子)、没收到的修改、被断开的连接、
// office-worker 的常驻内存(开始 / 峰值 / 结束)、所有人离开后多久落地、版本数。
//
// 先起守护进程(scratch/office-e2e/setup.sh,37879,admin / pw-12345),再在 office-worker 目录里:
//   PEERS=20 EDITS=10 INTERVAL=200 THREADS=4 node test/stress.mjs
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { initWasm, openWorkbook } from '@betteroffice/xlsx'
import { attachXlsx } from '@betteroffice/agents'
import { decode, encodeSync, SYNC, STEP1, STEP2, UPDATE } from '../src/ysync.mjs'

const now = () => performance.timeOrigin + performance.now()
const avg = (list) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const COLUMNS = ['A', 'B', 'C', 'D']
const cellOf = (peer, round) => `${COLUMNS[round % COLUMNS.length]}${10 + peer}`

if (isMainThread) {
  const W = new URL('../', import.meta.url).pathname
  const PEERS = Number(process.env.PEERS ?? 20)
  const EDITS = Number(process.env.EDITS ?? 10)
  const INTERVAL = Number(process.env.INTERVAL ?? 200)
  const OBSERVERS = Math.min(Number(process.env.OBSERVERS ?? 3), PEERS - 1)
  const THREADS = Math.min(Number(process.env.THREADS ?? 4), PEERS)
  const PORT = process.env.PORT ?? '37879'
  const base = `http://127.0.0.1:${PORT}`

  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kb-csrf': '1' }, body: JSON.stringify({ login: 'admin', password: 'pw-12345' }) })
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error(`登录失败 ${login.status}`)
  const headers = { cookie, 'x-kb-csrf': '1' }
  const call = async (name, args) => (await fetch(`${base}/api/v1/capabilities/${name}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(args) })).json()

  // 每次用新名字上传,免得撞上上次没关的房间
  const path = `stress-${Date.now()}.xlsx`
  const bytes = readFileSync(W + 'test/fixtures/sheet.xlsx')
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const start = await (await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: path, size: bytes.length, sha256: sha, collection: '_global', rel_path: path }) })).json()
  await fetch(`${base}/api/v1/uploads/${start.data.upload_id}/parts/0`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes })
  await fetch(`${base}/api/v1/uploads/${start.data.upload_id}/complete`, { method: 'POST', headers })
  for (let i = 0; i < 60; i++) {
    const preview = await call('file_preview', { collection: '_global', path })
    if (preview.ok && preview.data?.chunks?.length) break
    await wait(250)
  }
  const space = (await (await fetch(`${base}/api/v1/auth/me`, { headers })).json()).data?.user?.space_id
  const doc = `doc:${space}/_global/f/${path}`
  const session = await (await fetch(`${base}/api/v1/office/session`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })).json()
  if (session.data?.mode !== 'collab') throw new Error(`不能协同:${JSON.stringify(session)}`)
  const baseBytes = new Uint8Array(await (await fetch(`${base}/api/v1/office/base?doc=${encodeURIComponent(doc)}&sha=${session.data.base_sha}`, { headers })).arrayBuffer())

  function workerPid() {
    for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
      try {
        // 守护进程按约定位置找到的路径可能带 `../`,按文件身份比
        const script = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').find((arg) => arg.endsWith('office-worker/src/index.mjs'))
        if (script && realpathSync(script) === realpathSync(W + 'src/index.mjs')) return pid
      } catch {}
    }
    return null
  }
  const rssMb = (pid) => {
    try {
      const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((l) => l.startsWith('VmRSS:'))
      return Math.round(Number(line.split(/\s+/)[1]) / 1024)
    } catch {
      return null
    }
  }
  const pid0 = workerPid()
  const rss = { start: pid0 ? rssMb(pid0) : null, peak: 0, end: null }
  const sampler = setInterval(() => {
    const pid = workerPid()
    const value = pid ? rssMb(pid) : null
    if (value && value > rss.peak) rss.peak = value
  }, 100)

  // 按线程分 peer;所有线程都连好、同步完才一起开始改
  const threads = []
  const ready = []
  const done = []
  for (let t = 0; t < THREADS; t++) {
    const mine = Array.from({ length: PEERS }, (_, i) => i).filter((i) => i % THREADS === t)
    const thread = new Worker(new URL(import.meta.url), { workerData: { mine, PEERS, EDITS, INTERVAL, OBSERVERS, PORT, doc, cookie, baseBytes } })
    threads.push(thread)
    ready.push(new Promise((resolve, reject) => {
      thread.once('message', resolve)
      thread.once('error', reject)
    }))
  }
  const joinStarted = now()
  const joined = await Promise.all(ready)
  const joinAllMs = Math.round(now() - joinStarted)
  const editsStarted = now()
  for (const thread of threads) {
    done.push(new Promise((resolve) => thread.once('message', resolve)))
    thread.postMessage('go')
  }
  const reports = await Promise.all(done)
  const editSecs = (now() - editsStarted) / 1000
  clearInterval(sampler)
  const latencies = reports.flatMap((report) => report.latencies).sort((a, b) => a - b)
  const q = (p) => (latencies.length ? Math.round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]) : null)
  const result = {
    peers: PEERS,
    threads: THREADS,
    edits: PEERS * EDITS,
    editsPerSec: Math.round((PEERS * EDITS) / editSecs),
    joinAllMs,
    joinSlowestMs: Math.max(...joined.map((report) => report.joinMs)),
    relayMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: latencies.length ? Math.round(latencies.at(-1)) : null, samples: latencies.length },
    clientEditMs: avg(reports.flatMap((report) => report.editCosts)),
    clientApplyMs: avg(reports.flatMap((report) => report.applyCosts)),
    missing: reports.reduce((sum, report) => sum + report.missing, 0),
    kicked: reports.reduce((sum, report) => sum + report.kicked, 0),
    workerRssMb: rss,
  }
  for (const thread of threads) thread.postMessage('leave')
  await Promise.all(threads.map((thread) => new Promise((resolve) => thread.once('exit', resolve))))
  const left = now()
  result.landAfterLeaveMs = null
  for (let i = 0; i < 200; i++) {
    const info = await call('file_info', { collection: '_global', path })
    if (info.data?.sha256 && info.data.sha256 !== sha) {
      result.landAfterLeaveMs = Math.round(now() - left)
      break
    }
    await wait(50)
  }
  const pid = workerPid()
  rss.end = pid ? rssMb(pid) : null
  result.versions = (await call('file_versions', { collection: '_global', path })).data?.versions?.length
  console.log(JSON.stringify(result))
  process.exit(0)
} else {
  const { mine, PEERS, EDITS, INTERVAL, OBSERVERS, PORT, doc, cookie, baseBytes } = workerData
  await initWasm(readFileSync(new URL(import.meta.resolve('@betteroffice/xlsx')).pathname.replace(/index\.js$/, 'generated/xlsx_wasm_bg.wasm')))
  const latencies = []
  // 压测端自己的开销:改格子(引擎里提议 + 接受 + 编码)、收到后应用。延迟里减掉它们才是服务端的转发时间
  const editCosts = []
  const applyCosts = []
  let kicked = 0
  let leaving = false

  function makePeer(index) {
    const replica = openWorkbook(baseBytes, { collaborative: true, clientId: 5000 + index })
    const agent = attachXlsx(replica, { name: 'x.xlsx' })
    const sheet = agent.catalog()[0].name
    // 观察前 OBSERVERS 个人:每人每轮改一格,值里带着时刻;第一次看到新值就记一次延迟
    const watched = Array.from({ length: OBSERVERS }, (_, k) => (index - 1 - k + PEERS) % PEERS)
    const seen = new Map(watched.map((other) => [other, -1]))
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/office/collab?doc=${encodeURIComponent(doc)}`, { headers: { cookie, origin: `http://127.0.0.1:${PORT}` } })
    socket.binaryType = 'arraybuffer'
    const peer = { index, replica, agent, sheet, socket, watched, seen }
    let synced
    peer.synced = new Promise((resolve) => (synced = resolve))
    socket.onmessage = (event) => {
      for (const message of decode(new Uint8Array(event.data))) {
        if (message.type !== SYNC) continue
        if (message.sub === STEP1) {
          socket.send(encodeSync(STEP2, replica.encodeStateAsUpdate(message.payload)))
          socket.send(encodeSync(STEP1, replica.encodeStateVector()))
          continue
        }
        if (message.sub === STEP2) synced()
        const received = now()
        replica.applyUpdate(message.payload)
        if (message.sub !== UPDATE) continue
        const arrived = now()
        applyCosts.push(arrived - received)
        for (const other of watched) {
          const round = seen.get(other) + 1
          if (round >= EDITS) continue
          const value = agent.readCells({ sheet, range: cellOf(other, round) }).cells[0].value?.value
          const match = typeof value === 'string' && /^p(\d+)-r(\d+)-t([\d.]+)$/.exec(value)
          if (match && Number(match[1]) === other && Number(match[2]) === round) {
            latencies.push(arrived - Number(match[3]))
            seen.set(other, round)
          }
        }
      }
    }
    socket.onclose = () => {
      if (!leaving) kicked += 1
    }
    peer.opened = new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = () => reject(new Error(`peer ${index} 连不上`))
    })
    return peer
  }

  const started = now()
  const peers = mine.map(makePeer)
  await Promise.all(peers.map((peer) => peer.opened))
  await Promise.all(peers.map((peer) => Promise.race([peer.synced, wait(30000).then(() => Promise.reject(new Error('同步超时')))])))
  parentPort.postMessage({ joinMs: Math.round(now() - started) })
  await new Promise((resolve) => parentPort.once('message', resolve))

  async function edit(peer, round) {
    const before = peer.replica.encodeStateVector()
    const handle = peer.agent.readCells({ sheet: peer.sheet, range: cellOf(peer.index, round) }).cells[0].cell
    const stamp = now()
    const proposal = peer.agent.proposeCells({ author: `p${peer.index}`, edits: [{ cell: handle, input: `p${peer.index}-r${round}-t${stamp.toFixed(1)}` }] })
    await peer.agent.accept(proposal.id)
    peer.socket.send(encodeSync(UPDATE, peer.replica.encodeStateAsUpdate(before)))
    editCosts.push(now() - stamp)
  }
  // 每人每轮一次,同一轮里的人错开(像真实的人不会同一毫秒按键)
  for (let round = 0; round < EDITS; round++) {
    await Promise.all(peers.map((peer) => wait((peer.index * INTERVAL) / PEERS).then(() => edit(peer, round))))
    await wait(INTERVAL - ((PEERS - 1) * INTERVAL) / PEERS)
  }
  // 等最后几条到达
  for (let i = 0; i < 200 && peers.some((peer) => [...peer.seen.values()].some((round) => round < EDITS - 1)); i++) await wait(50)
  const missing = peers.reduce((sum, peer) => sum + [...peer.seen.values()].reduce((s, round) => s + (EDITS - 1 - round), 0), 0)
  parentPort.postMessage({ latencies, missing, kicked, editCosts, applyCosts })
  await new Promise((resolve) => parentPort.once('message', resolve))
  leaving = true
  for (const peer of peers) peer.socket.close()
  await wait(200)
  process.exit(0)
}
