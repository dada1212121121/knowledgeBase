/**
 * `settleSelection` 单测：回执（ack）与"含新选区的几何帧装好"（presented）是两个先后到达的事件，
 * `shown` 必须等后者。查找 / 评论 / 修订 / 大纲跳转都靠它避免读到上一个选区的位置。
 */
import { describe, expect, it } from 'vitest'
import type { PeerlessAdmissionResult } from '../../../engines/docx/vendor/inputAdmission'
import { settleAdmission, settleSelection } from './settle'

type Outcome = { status: 'applied' | 'noop' | 'refused' | 'cancelled'; seq?: number; reason?: string }

/** 手动控制回执和"帧装好"两个时刻的假提交 */
function fakeSubmit() {
  let ack!: (outcome: Outcome) => void
  let present!: (status: 'presented' | 'dropped') => void
  const ticket = {
    id: 1,
    seq: 7,
    ack: new Promise<Outcome>((resolve) => (ack = resolve)),
    presented: new Promise<'presented' | 'dropped'>((resolve) => (present = resolve)),
  }
  const admission = { status: 'submitted', echoEnabled: false, ticket } as unknown as PeerlessAdmissionResult
  return { admission, ack, present }
}

/** 让已排队的微任务都跑完 */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('settleSelection', () => {
  it('回执先到、帧后到：result 在回执时就有，shown 要等帧装好才落定', async () => {
    const { admission, ack, present } = fakeSubmit()
    const pending = settleSelection(admission)
    ack({ status: 'applied', seq: 7 })
    const { result, shown } = await pending
    expect(result).toEqual({ ok: true, data: { seq: 7 } })

    let shownDone = false
    void shown.then(() => (shownDone = true))
    await flush()
    // 回执已经到了，但带新选区的帧还没装好：此时读几何会读到上一个选区，所以 shown 不能落定
    expect(shownDone).toBe(false)

    present('presented')
    await flush()
    expect(shownDone).toBe(true)
  })

  it('帧被丢弃（dropped）也落定：不能让调用方永远等下去，照常读当前几何', async () => {
    const { admission, ack, present } = fakeSubmit()
    const pending = settleSelection(admission)
    ack({ status: 'applied', seq: 7 })
    const { shown } = await pending
    present('dropped')
    await expect(shown).resolves.toBeUndefined()
  })

  it('noop 也要等帧：选区命令不改文档，回执几乎总是 noop，但新选区照样随后一帧才到', async () => {
    // 实测（查找连按 30 次下一个）：35 个回执里 33 个是 noop，且每个 noop 之后约 20~40 ms 才有带新选区的帧
    const { admission, ack, present } = fakeSubmit()
    const pending = settleSelection(admission)
    ack({ status: 'noop', seq: 7 })
    const { result, shown } = await pending
    expect(result).toEqual({ ok: true, data: { seq: 7, noop: true } })
    let shownDone = false
    void shown.then(() => (shownDone = true))
    await flush()
    expect(shownDone).toBe(false)
    present('presented')
    await flush()
    expect(shownDone).toBe(true)
  })

  it('被引擎拒绝 / 被忽略：result 不 ok，shown 立即落定（不等帧）', async () => {
    const refused = fakeSubmit()
    const pending = settleSelection(refused.admission)
    refused.ack({ status: 'refused', reason: 'stale-version' })
    const first = await pending
    expect(first.result).toEqual({ ok: false, reason: '文档在你操作期间被改动了，请重试' })
    await expect(first.shown).resolves.toBeUndefined()

    const ignored = await settleSelection({ status: 'ignored', reason: 'read-only' } as PeerlessAdmissionResult)
    expect(ignored.result).toEqual({ ok: false, reason: '文档当前是只读的' })
    await expect(ignored.shown).resolves.toBeUndefined()
  })

  it('输入法组合期间被挂起的提交：放行之后照样等帧', async () => {
    const { admission, ack, present } = fakeSubmit()
    const held = { status: 'held', slot: 1, echoEnabled: false, released: Promise.resolve(admission) } as unknown as PeerlessAdmissionResult
    const pending = settleSelection(held)
    ack({ status: 'applied', seq: 7 })
    const { result, shown } = await pending
    expect(result.ok).toBe(true)
    let shownDone = false
    void shown.then(() => (shownDone = true))
    await flush()
    expect(shownDone).toBe(false)
    present('presented')
    await flush()
    expect(shownDone).toBe(true)
  })
})

describe('settleAdmission（行为不变）', () => {
  it('applied / noop / refused 的结果形状与之前一致', async () => {
    const applied = fakeSubmit()
    const first = settleAdmission(applied.admission)
    applied.ack({ status: 'applied', seq: 3 })
    expect(await first).toEqual({ ok: true, data: { seq: 3 } })

    const noop = fakeSubmit()
    const second = settleAdmission(noop.admission)
    noop.ack({ status: 'noop', seq: 4 })
    expect(await second).toEqual({ ok: true, data: { seq: 4, noop: true } })

    const refused = fakeSubmit()
    const third = settleAdmission(refused.admission)
    refused.ack({ status: 'refused', reason: 'read-only' })
    expect(await third).toEqual({ ok: false, reason: '文档当前是只读的' })
  })
})
