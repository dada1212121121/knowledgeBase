/** 逐页取位图的纯逻辑单测：画布是否画过、等待条件的成立 / 超时 / 取消。 */
import { describe, expect, it } from 'vitest'
import { CaptureAborted, CaptureTimeout, DEFAULT_CANVAS, isPagePainted, waitUntil } from './pageCapture'

/** 用手动时钟，不真等：每次 sleep 推进时间 */
function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => void (t += ms) }
}

describe('isPagePainted', () => {
  it('浏览器默认尺寸 = 还没画', () => {
    expect(isPagePainted({ ...DEFAULT_CANVAS })).toBe(false)
  })
  it('宽或高任一被改 = 画过', () => {
    expect(isPagePainted({ width: 816, height: 1056 })).toBe(true)
    expect(isPagePainted({ width: 300, height: 1056 })).toBe(true)
    expect(isPagePainted({ width: 816, height: 150 })).toBe(true)
  })
  it('被清到 0×0（释放内存后）也不算"没画"——调用方释放前已取走位图', () => {
    expect(isPagePainted({ width: 0, height: 0 })).toBe(true)
  })
})

describe('waitUntil', () => {
  it('条件一开始就成立：不睡眠，立即返回', async () => {
    let slept = 0
    await waitUntil(() => true, { what: 'x', timeoutMs: 1000, sleep: async () => void (slept += 1) })
    expect(slept).toBe(0)
  })

  it('条件在几次轮询后成立', async () => {
    const c = clock()
    let calls = 0
    await waitUntil(() => ++calls >= 4, { what: 'x', timeoutMs: 1000, intervalMs: 10, ...c })
    expect(calls).toBe(4)
    expect(c.now()).toBe(30)
  })

  it('超时：抛 CaptureTimeout，消息写明在等什么和多少秒', async () => {
    const c = clock()
    const error = await waitUntil(() => false, { what: '第 7 页的位图', timeoutMs: 3000, intervalMs: 100, ...c }).catch((e) => e)
    expect(error).toBeInstanceOf(CaptureTimeout)
    expect(error.message).toBe('第 7 页的位图在 3 秒内没有完成')
  })

  it('信号已中止：抛 CaptureAborted，不再检查条件', async () => {
    const controller = new AbortController()
    controller.abort()
    let checked = false
    const error = await waitUntil(() => (checked = true), { what: 'x', timeoutMs: 1000, signal: controller.signal }).catch((e) => e)
    expect(error).toBeInstanceOf(CaptureAborted)
    expect(checked).toBe(false)
  })

  it('等待途中中止：下一次轮询就退出', async () => {
    const controller = new AbortController()
    const c = clock()
    let calls = 0
    const error = await waitUntil(
      () => {
        if (++calls === 3) controller.abort()
        return false
      },
      { what: 'x', timeoutMs: 10_000, intervalMs: 5, signal: controller.signal, ...c },
    ).catch((e) => e)
    expect(error).toBeInstanceOf(CaptureAborted)
    expect(calls).toBe(3)
  })

  it('条件在截止时刻恰好成立也算成立（先检查条件再检查超时）', async () => {
    const c = clock()
    let calls = 0
    await waitUntil(() => ++calls >= 11, { what: 'x', timeoutMs: 100, intervalMs: 10, ...c })
    expect(calls).toBe(11)
  })
})
