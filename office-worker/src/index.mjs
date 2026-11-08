#!/usr/bin/env node
// office-worker 主循环:从标准输入读帧,按房间分发;写标准输出回帧;日志写标准错误。
// 守护进程按需启动它;没有房间 `KB_OFFICE_IDLE_EXIT_MS`(默认 5 分钟)就自己退出,内存归零。
import { readFile } from 'node:fs/promises'
import { randomInt, createHash } from 'node:crypto'
import { FrameReader, encodeFrame } from './ipc.mjs'
import { openReplica, loadedFormats } from './engines.mjs'
import { Room } from './room.mjs'
import { agentEdit, agentRead } from './agent.mjs'

const IDLE_EXIT_MS = +(process.env.KB_OFFICE_IDLE_EXIT_MS ?? 5 * 60 * 1000)
/** 测试用:多少条增量合并一次(默认见 room.mjs 的 DEFAULTS.compactEvery) */
const COMPACT_EVERY = +(process.env.KB_OFFICE_COMPACT_EVERY ?? 0)
const rooms = new Map()
const opening = new Map()
const pendingLands = new Map()
let nextLand = 1
let idleTimer = null

function write(meta, body) {
  process.stdout.write(encodeFrame(meta, body))
}

function log(level, message) {
  process.stderr.write(`[office-worker] ${level}: ${message}\n`)
}

function armIdleExit() {
  clearTimeout(idleTimer)
  if (rooms.size || opening.size) return
  idleTimer = setTimeout(() => {
    if (!rooms.size && !opening.size) {
      write({ t: 'bye', reason: 'idle' })
      process.exit(0)
    }
  }, IDLE_EXIT_MS)
}

/** 服务端副本的 clientId:每次打开随机一个(浏览器也是随机的,冲突概率可以忽略;不能复用旧的,时钟会撞) */
const freshClientId = () => randomInt(1, 2 ** 31 - 1)

async function openRoom(meta, body) {
  const { room: key, format, base, sha } = meta
  if (rooms.has(key)) return { ok: true, already: true }
  if (opening.has(key)) return opening.get(key)
  const task = (async () => {
    const started = performance.now()
    const bytes = body.length ? body : new Uint8Array(await readFile(base))
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (sha && digest !== sha) throw new Error('底稿的内容哈希对不上')
    const replica = await openReplica(format, bytes, { clientId: freshClientId(), generation: `kb:${digest}` })
    const openMs = Math.round(performance.now() - started)
    const room = new Room({
      key,
      replica,
      options: COMPACT_EVERY ? { compactEvery: COMPACT_EVERY } : {},
      host: {
        sendTo: (conn, frame) => write({ t: 'send', room: key, conn }, frame),
        broadcast: (except, frame) => write({ t: 'broadcast', room: key, except }, frame),
        persist: (update, conn) => write({ t: 'persist', room: key, conn }, update),
        compact: (merged) => write({ t: 'compact', room: key }, merged),
        land: (fileBytes) =>
          new Promise((resolve, reject) => {
            const seq = nextLand++
            pendingLands.set(seq, { resolve, reject })
            write({ t: 'land', room: key, seq }, fileBytes)
          }),
        closed: () => {
          rooms.delete(key)
          write({ t: 'closed', room: key })
          armIdleExit()
        },
        status: (status) => write({ t: 'status', room: key, ...status }),
        log,
      },
    })
    rooms.set(key, room)
    // 无损检查要的「不改直接保存」:只在守护进程要求时做(同一份底稿只检查一次)
    let resaved = null
    if (meta.check) resaved = await replica.save()
    return { ok: true, openMs, resaved, seed: format === 'docx' }
  })()
  opening.set(key, task)
  try {
    return await task
  } finally {
    opening.delete(key)
  }
}

async function handle({ meta, body }) {
  switch (meta.t) {
    case 'open': {
      clearTimeout(idleTimer)
      try {
        const result = await openRoom(meta, body)
        write({ t: 'opened', room: meta.room, ok: true, openMs: result.openMs, already: !!result.already }, result.resaved ?? undefined)
      } catch (error) {
        write({ t: 'opened', room: meta.room, ok: false, error: String(error?.message ?? error) })
        armIdleExit()
      }
      return
    }
    case 'restore': {
      // 守护进程重启 / 进程被回收后重开房间:把持久化的增量补回副本
      const room = rooms.get(meta.room)
      if (room && body.length) {
        room.replica.apply(body)
        // 补回来的增量还没落地:标脏并安排落地,否则文件永远停在底稿
        room.recover()
      }
      return
    }
    case 'join': {
      const room = rooms.get(meta.room)
      if (!room) return write({ t: 'kick', room: meta.room, conn: meta.conn, reason: '房间不存在' })
      room.join(meta.conn, { writable: !!meta.writable, user: meta.user })
      return
    }
    case 'writable':
      rooms.get(meta.room)?.setWritable(meta.conn, !!meta.writable)
      return
    case 'frame': {
      const room = rooms.get(meta.room)
      if (!room) return
      try {
        room.frame(meta.conn, body)
      } catch (error) {
        // 引擎拒绝了这条更新:让这条连接重连重新同步,别的连接不受影响
        log('warn', `更新被拒绝(${meta.room}):${String(error?.message ?? error)}`)
        write({ t: 'kick', room: meta.room, conn: meta.conn, reason: '这次修改没能同步,正在重新连接' })
      }
      return
    }
    case 'leave':
      rooms.get(meta.room)?.leave(meta.conn)
      return
    case 'landed': {
      const pending = pendingLands.get(meta.seq)
      pendingLands.delete(meta.seq)
      if (!pending) return
      if (meta.ok) pending.resolve()
      else pending.reject(new Error(meta.error ?? '写回失败'))
      return
    }
    case 'land': {
      const room = rooms.get(meta.room)
      if (!room) return write({ t: 'land_done', room: meta.room, id: meta.id, ok: true })
      void room.land().then((ok) => write({ t: 'land_done', room: meta.room, id: meta.id, ok }))
      return
    }
    case 'seed': {
      const room = rooms.get(meta.room)
      const seed = room?.replica.seed()
      write({ t: 'seed', room: meta.room, id: meta.id, ok: !!seed }, seed ?? undefined)
      return
    }
    case 'close': {
      const room = rooms.get(meta.room)
      if (room) void room.land().then(() => room.close())
      return
    }
    case 'agent_edit': {
      // AI 的修改:在副本上改完,作为服务端的一笔更新广播给所有人、持久化、安排落地
      const room = rooms.get(meta.room)
      if (!room) return write({ t: 'agent_edit', id: meta.id, ok: false, error: '房间没有打开' })
      try {
        const before = room.replica.stateVector()
        const changed = await agentEdit(room.replica, meta.edits, meta.author, { dry: !!meta.dry })
        if (meta.dry) room.idle()
        else room.applyLocal(before)
        write({ t: 'agent_edit', id: meta.id, ok: true, changed })
      } catch (error) {
        write({ t: 'agent_edit', id: meta.id, ok: false, error: String(error?.message ?? error) })
      }
      return
    }
    case 'agent_read': {
      // 给 AI 看的纯文本(房间开着时就是大家正在改的内容)
      const room = rooms.get(meta.room)
      if (!room) return write({ t: 'agent_read', id: meta.id, ok: false, error: '房间没有打开' })
      try {
        const text = agentRead(room.replica)
        room.idle()
        write({ t: 'agent_read', id: meta.id, ok: true }, new TextEncoder().encode(text))
      } catch (error) {
        write({ t: 'agent_read', id: meta.id, ok: false, error: String(error?.message ?? error) })
      }
      return
    }
    case 'stats':
      write({
        t: 'stats',
        id: meta.id,
        rooms: [...rooms.values()].map((room) => ({ room: room.key, conns: room.conns.size, dirty: room.dirty, ...room.stats })),
        formats: loadedFormats(),
        rssMB: Math.round(process.memoryUsage().rss / 1048576),
      })
      return
    case 'shutdown': {
      // 守护进程要退出:先把所有房间落地
      await Promise.allSettled([...rooms.values()].map((room) => room.land()))
      write({ t: 'bye', reason: 'shutdown' })
      process.exit(0)
    }
    default:
      log('warn', `未知的消息 ${meta.t}`)
  }
}

const reader = new FrameReader()
// 同一个房间的消息按到达顺序处理(加入、更新、离开不能乱序);不同房间互不等待:
// 一份大文档打开 / 存盘要几百毫秒,不能让别的房间的人跟着卡。
// 守护进程对落地的回复(landed)不排队:落地本身就在房间的队列里等它。
const queues = new Map()
function enqueue(frame) {
  const key = frame.meta.room ?? ''
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(() => handle(frame)).catch((error) => log('error', String(error?.stack ?? error)))
  queues.set(key, next)
  next.then(() => {
    if (queues.get(key) === next) queues.delete(key)
  })
}
process.stdin.on('data', (chunk) => {
  let frames
  try {
    frames = reader.push(chunk)
  } catch (error) {
    log('error', `读帧失败:${String(error)}`)
    process.exit(2)
  }
  for (const frame of frames) {
    if (frame.meta.t === 'landed' || frame.meta.t === 'stats') void handle(frame)
    else enqueue(frame)
  }
})
process.stdin.on('end', async () => {
  // 守护进程没了:能落地的都落地不了(没人接),直接退出
  process.exit(0)
})
write({ t: 'ready', pid: process.pid, node: process.version })
armIdleExit()
