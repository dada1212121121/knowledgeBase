import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decode, encodeSync, stripFingerprint, carriesEdits, SYNC, AWARENESS, QUERY_AWARENESS, STEP1, STEP2, UPDATE } from '../src/ysync.mjs'
import { parseAwareness, encodeAwarenessRemoval } from '../src/awareness.mjs'

test('一帧里的多条消息都能拆出来,编出来的能原样拆回', () => {
  const frame = Uint8Array.from([...encodeSync(STEP1, Uint8Array.from([5, 6])), ...encodeSync(UPDATE, Uint8Array.from([7])), QUERY_AWARENESS])
  const messages = decode(frame)
  assert.deepEqual(messages.map((m) => [m.type, m.sub]), [[SYNC, STEP1], [SYNC, UPDATE], [QUERY_AWARENESS, undefined]])
  assert.deepEqual([...messages[0].payload], [5, 6])
  assert.equal(carriesEdits(messages), true)
  assert.equal(carriesEdits(decode(encodeSync(STEP1, Uint8Array.from([1])))), false)
  assert.equal(carriesEdits(decode(encodeSync(STEP2, Uint8Array.from([1])))), true)
})

test('长载荷的 varUint 长度正确', () => {
  const payload = new Uint8Array(70000).fill(9)
  const [message] = decode(encodeSync(STEP2, payload))
  assert.equal(message.payload.length, 70000)
})

test('截断的帧、未知类型都报错', () => {
  assert.throws(() => decode(Uint8Array.from([SYNC, STEP1, 5, 1])), /截断/)
  assert.throws(() => decode(Uint8Array.from([9])), /未知/)
  assert.throws(() => decode(Uint8Array.from([SYNC, 7, 0])), /未知/)
})

test('文档指纹只在完整标签 + 32 字节时剥掉', () => {
  const tag = new TextEncoder().encode('\0betteroffice-document-fingerprint-v1\0')
  const payload = Uint8Array.from([1, 2, 3, ...tag, ...new Uint8Array(32).fill(7)])
  assert.deepEqual([...stripFingerprint(payload)], [1, 2, 3])
  const plain = Uint8Array.from([1, 2, 3, 4])
  assert.equal(stripFingerprint(plain), plain)
})

test('在线状态:解析出每个 clientId,替离开的人编出「离开」', () => {
  const removal = encodeAwarenessRemoval([{ clientId: 300, clock: 4 }])
  const [message] = decode(removal)
  assert.equal(message.type, AWARENESS)
  assert.deepEqual(parseAwareness(message.payload), [{ clientId: 300, clock: 5, state: 'null' }])
})
