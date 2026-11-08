// 房间逻辑(假副本 + 假时钟):同步握手、转发、只读、在线状态、落地去抖、失败重试、关房间
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Room } from '../src/room.mjs'
import { decode, encodeSync, SYNC, AWARENESS, STEP1, STEP2, UPDATE } from '../src/ysync.mjs'
import { encodeAwarenessRemoval } from '../src/awareness.mjs'

function fakeTimers() {
  let now = 0
  let id = 0
  const pending = new Map()
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      pending.set(++id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (handle) => pending.delete(handle),
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        now = due[1].at
        due[1].fn()
        await new Promise((r) => setImmediate(r))
      }
      now = target
      await new Promise((r) => setImmediate(r))
    },
  }
}

function fakeReplica() {
  const applied = []
  return {
    applied,
    stateVector: () => Uint8Array.from([0xaa]),
    diff: (sv) => Uint8Array.from([0xdd, ...sv, 0, 0]),
    apply: (update) => applied.push([...update]),
    save: async () => Uint8Array.from([0x50, 0x4b]),
    dispose() { this.disposed = true },
  }
}

function setup({ landFails = 0, options = {} } = {}) {
  const timers = fakeTimers()
  const replica = fakeReplica()
  const out = { sent: [], broadcast: [], persisted: [], compacted: [], lands: 0, closed: 0 }
  let failures = landFails
  const room = new Room({
    key: 'k',
    replica,
    timers,
    host: {
      sendTo: (conn, bytes) => out.sent.push([conn, decode(bytes)]),
      broadcast: (except, bytes) => out.broadcast.push([except, decode(bytes)]),
      persist: (update, conn) => out.persisted.push([conn, [...update]]),
      compact: (merged) => out.compacted.push({ merged: [...merged], afterPersisted: out.persisted.length }),
      land: async () => {
        out.lands += 1
        if (failures > 0) {
          failures -= 1
          throw new Error('磁盘满了')
        }
      },
      closed: () => (out.closed += 1),
    },
    options,
  })
  return { room, replica, timers, out }
}

const update = (n) => encodeSync(UPDATE, Uint8Array.from([n, n, n]))

test('加入时先收到服务端的状态向量;它的 step1 只换来它缺的部分', () => {
  const { room, out } = setup()
  room.join(1, { writable: true })
  assert.equal(out.sent[0][0], 1)
  assert.deepEqual(out.sent[0][1].map((m) => [m.type, m.sub, [...m.payload]]), [[SYNC, STEP1, [0xaa]]])
  room.frame(1, encodeSync(STEP1, Uint8Array.from([0x11])))
  assert.deepEqual(out.sent[1][1].map((m) => [m.sub, [...m.payload]]), [[STEP2, [0xdd, 0x11, 0, 0]]])
})

test('修改:应用一次、转发给其他人、持久化;只读连接的修改被丢掉', () => {
  const { room, replica, out } = setup()
  room.join(1, { writable: true })
  room.join(2, { writable: false })
  room.frame(1, update(7))
  assert.deepEqual(replica.applied, [[7, 7, 7]])
  assert.deepEqual(out.broadcast.map(([except, messages]) => [except, messages[0].sub]), [[1, UPDATE]])
  assert.deepEqual(out.persisted, [[1, [7, 7, 7]]])
  assert.equal(room.frame(2, update(8)), 1, '只读连接的修改被拒绝')
  assert.equal(replica.applied.length, 1)
  assert.equal(out.broadcast.length, 1)
  // 只读连接仍然能同步(step1)
  room.frame(2, encodeSync(STEP1, Uint8Array.from([0x22])))
  assert.equal(out.sent.at(-1)[0], 2)
  // 权限升级后能改
  room.setWritable(2, true)
  room.frame(2, update(9))
  assert.equal(replica.applied.length, 2)
})

test('空增量和坏帧不应用、不转发', () => {
  const { room, replica, out } = setup()
  room.join(1, { writable: true })
  room.join(2, { writable: true })
  room.frame(1, encodeSync(UPDATE, Uint8Array.from([0, 0])))
  room.frame(1, Uint8Array.from([0, 2, 9]))
  assert.equal(replica.applied.length, 0)
  assert.equal(out.broadcast.length, 0)
  assert.equal(room.stats.rejected, 1)
})

test('在线状态:转发、新人加入时补发、有人断开替他广播离开', () => {
  const { room, out } = setup()
  room.join(1, { writable: true })
  // clientId 300 在线
  const presence = new Uint8Array([AWARENESS, ...(() => {
    const body = [1, 172, 2, 3, 2, 123, 125] // 1 条:clientId 300(varUint 172,2),clock 3,"{}"
    return [body.length, ...body]
  })()])
  room.frame(1, presence)
  room.join(2, { writable: true })
  const toNew = out.sent.filter(([conn]) => conn === 2).flatMap(([, messages]) => messages)
  assert.ok(toNew.some((m) => m.type === AWARENESS), '新人加入时补发已有的在线状态')
  room.leave(1)
  const [except, messages] = out.broadcast.at(-1)
  assert.equal(except, null)
  assert.deepEqual([...messages[0].payload], [...decode(encodeAwarenessRemoval([{ clientId: 300, clock: 3 }]))[0].payload])
})

test('落地去抖:停手 2 秒存一次;连续编辑最多 30 秒存一次', async () => {
  const { room, timers, out } = setup()
  room.join(1, { writable: true })
  room.frame(1, update(1))
  await timers.advance(1999)
  assert.equal(out.lands, 0)
  await timers.advance(1)
  assert.equal(out.lands, 1)
  assert.equal(room.dirty, false)
  // 每 1 秒改一次,持续 40 秒:不会每次都等,30 秒内必然落地一次
  for (let i = 0; i < 40; i++) {
    room.frame(1, update(i % 250))
    await timers.advance(1000)
  }
  assert.ok(out.lands >= 2 && out.lands <= 3, `连续编辑也定期落地:${out.lands}`)
})

test('补回持久化的增量后标脏并安排落地:恢复出来的内容不会停在底稿', async () => {
  // 守护进程重启 / 进程被回收后,房间按「底稿 + 持久化的增量」重开:增量早已写库,
  // 但文件还是底稿。这里只要证明 recover() 把「还没落地」记下来了,而且没有再写一遍库。
  const { room, replica, timers, out } = setup()
  room.replica.apply(update(7))
  room.recover()
  assert.equal(replica.applied.length, 1)
  assert.equal(room.dirty, true, '补回来的增量算没落地')
  assert.equal(out.persisted.length, 0, '这份增量早就持久化过,不再写一遍')
  assert.equal(out.broadcast.length, 0, '恢复时还没有连接,不用广播')
  assert.equal(out.lands, 0, '按落地去抖,不是马上落')
  await timers.advance(2000)
  assert.equal(out.lands, 1)
  assert.equal(room.dirty, false)
})

test('落地失败不丢内容:退避重试直到成功', async () => {
  const { room, timers, out } = setup({ landFails: 2 })
  room.join(1, { writable: true })
  room.frame(1, update(1))
  await timers.advance(2000)
  assert.equal(out.lands, 1)
  assert.equal(room.dirty, true)
  await timers.advance(1000)
  assert.equal(out.lands, 2)
  await timers.advance(2000)
  assert.equal(out.lands, 3)
  assert.equal(room.dirty, false)
})

test('最后一个人离开立刻落地,30 秒后关房间;期间有人回来就不关', async () => {
  const { room, replica, timers, out } = setup()
  room.join(1, { writable: true })
  room.frame(1, update(1))
  room.leave(1)
  await timers.advance(0)
  assert.equal(out.lands, 1, '不等去抖,马上落地')
  await timers.advance(20000)
  room.join(2, { writable: true })
  await timers.advance(60000)
  assert.equal(out.closed, 0, '有人回来了')
  room.leave(2)
  await timers.advance(30000)
  assert.equal(out.closed, 1)
  assert.equal(replica.disposed, true)
  assert.throws(() => room.join(3, { writable: true }), /关了/)
})

test('服务端自己改(AI):增量发给所有人、持久化、安排落地', async () => {
  const { room, timers, out } = setup()
  room.join(1, { writable: true })
  const delta = room.applyLocal(Uint8Array.from([0x01]))
  assert.deepEqual([...delta], [0xdd, 0x01, 0, 0])
  assert.deepEqual(out.broadcast.at(-1)[0], null)
  assert.deepEqual(out.persisted.at(-1), [null, [0xdd, 0x01, 0, 0]])
  await timers.advance(2000)
  assert.equal(out.lands, 1)
})

test('落地进行中又来了修改:这次落地不算把它存进去了,之后还会再落地一次', async () => {
  const timers = fakeTimers()
  const replica = fakeReplica()
  let release
  const lands = []
  const room = new Room({
    key: 'k',
    replica,
    timers,
    host: {
      sendTo() {},
      broadcast() {},
      persist() {},
      land: () => new Promise((resolve) => { lands.push(1); release = resolve }),
      closed() {},
    },
  })
  room.join(1, { writable: true })
  room.join(2, { writable: true })
  room.frame(1, update(1))
  await timers.advance(2000)
  assert.equal(lands.length, 1, '开始第一次落地')
  room.frame(2, update(2)) // 存盘期间又改了
  release()
  await timers.advance(0)
  assert.equal(room.dirty, true, '第二次修改还没存')
  await timers.advance(2000)
  assert.equal(lands.length, 2, '又落地了一次')
  release()
  await timers.advance(0)
  assert.equal(room.dirty, false)
})

test('增量攒够了就合并成一份(相对打开时的状态):恢复时补一份而不是几千条;合并在已经持久化的增量之后', () => {
  const { room, out } = setup({ options: { compactEvery: 3, compactBytes: 1 << 20 } })
  room.join(1, { writable: true, user: { id: 'u', name: 'u' } })
  for (let n = 1; n <= 7; n++) room.frame(1, update(n))
  // 第 3、6 条之后各合并一次;合并的是「相对打开时的状态向量」的差,和已经持久化的顺序一致
  assert.deepEqual(out.compacted.map((c) => c.afterPersisted), [3, 6])
  assert.deepEqual(out.compacted[0].merged, [0xdd, 0xaa, 0, 0])
  // 服务端自己的修改(AI)也算
  room.applyLocal(Uint8Array.from([0xaa]))
  room.applyLocal(Uint8Array.from([0xaa]))
  assert.equal(out.compacted.length, 3)
})

test('按字节数也会合并(大块粘贴不用等够条数)', () => {
  const { room, out } = setup({ options: { compactEvery: 1000, compactBytes: 10 } })
  room.join(1, { writable: true, user: { id: 'u', name: 'u' } })
  room.frame(1, encodeSync(UPDATE, Uint8Array.from(Array(12).fill(7))))
  assert.equal(out.compacted.length, 1)
})
