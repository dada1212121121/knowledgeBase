import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FrameReader, encodeFrame } from '../src/ipc.mjs'

test('帧可以任意切块到达,也可以几帧粘在一起', () => {
  const a = encodeFrame({ t: 'frame', room: '甲', conn: 1 }, Uint8Array.from([1, 2, 3]))
  const b = encodeFrame({ t: 'leave', room: '甲', conn: 1 })
  const all = Buffer.concat([a, b])
  for (let cut = 1; cut < all.length; cut++) {
    const reader = new FrameReader()
    const frames = [...reader.push(all.subarray(0, cut)), ...reader.push(all.subarray(cut))]
    assert.equal(frames.length, 2, `切在 ${cut}`)
    assert.deepEqual(frames[0].meta, { t: 'frame', room: '甲', conn: 1 })
    assert.deepEqual([...frames[0].body], [1, 2, 3])
    assert.deepEqual(frames[1].meta, { t: 'leave', room: '甲', conn: 1 })
    assert.equal(frames[1].body.length, 0)
  }
})

test('超过上限的帧直接报错,不攒在内存里', () => {
  const reader = new FrameReader(16)
  assert.throws(() => reader.push(encodeFrame({ t: 'x', pad: 'y'.repeat(32) })), /帧太大/)
})

test('JSON 长度越界的坏帧报错', () => {
  const bad = Buffer.alloc(12)
  bad.writeUInt32BE(8, 0)
  bad.writeUInt32BE(100, 4)
  assert.throws(() => new FrameReader().push(bad), /越界/)
})
