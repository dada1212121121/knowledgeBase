import { describe, expect, it, vi } from 'vitest'
import { useLoadState } from './useLoadState'

const apiError = (message: string, status: number) => Object.assign(new Error(message), { status })
/** 手动控制何时完成的请求,用来造「慢请求后到」。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('useLoadState', () => {
  it('成功:加载中 → 就绪,带上数据', async () => {
    const state = useLoadState(async () => ({ n: 1 }), '读取')
    expect(state.phase.value).toBe('loading')
    await state.reload()
    expect(state.phase.value).toBe('ready')
    expect(state.data.value).toEqual({ n: 1 })
  })

  it('403 是无权限、其它是报错,都带说明,数据清空', async () => {
    const forbidden = useLoadState(async () => Promise.reject(apiError('你的账号没有开通这个功能', 403)), '读取存储用量')
    await forbidden.reload()
    expect(forbidden.phase.value).toBe('forbidden')
    expect(forbidden.message.value).toContain('没有开通')

    const broken = useLoadState(async () => Promise.reject(apiError('存储统计没有启用', 503)), '读取存储用量')
    await broken.reload()
    expect(broken.phase.value).toBe('error')
    expect(broken.message.value).toContain('读取存储用量失败')
    expect(broken.data.value).toBeNull()
  })

  it('报错后重试成功,回到就绪并清掉错误文字', async () => {
    let fail = true
    const state = useLoadState(async () => (fail ? Promise.reject(apiError('服务忙', 500)) : { ok: true }), '读取')
    await state.reload()
    expect(state.phase.value).toBe('error')
    fail = false
    await state.reload()
    expect(state.phase.value).toBe('ready')
    expect(state.message.value).toBe('')
  })

  it('慢请求后到时不能盖掉更新的结果(切换日期的场景)', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const queue = [first, second]
    const state = useLoadState(() => queue.shift()!.promise, '读取')
    const a = state.reload()
    const b = state.reload()
    second.resolve('新日期')
    await b
    first.resolve('旧日期')
    await a
    expect(state.data.value).toBe('新日期')
  })

  it('普通 reload 先清掉旧数据:换了日期后失败,不能还显示上一天的数', async () => {
    let fail = false
    const state = useLoadState(async () => (fail ? Promise.reject(apiError('服务忙', 500)) : 'day1'), '读取')
    await state.reload()
    fail = true
    await state.reload()
    expect(state.phase.value).toBe('error')
    expect(state.data.value).toBeNull()
  })

  it('quiet 的后台刷新失败:保留旧数据,只通知调用方', async () => {
    let fail = false
    const soft = vi.fn()
    const state = useLoadState(async () => (fail ? Promise.reject(apiError('服务忙', 500)) : 'data'), '读取', soft)
    await state.reload()
    fail = true
    await state.reload({ quiet: true })
    expect(state.phase.value).toBe('ready')
    expect(state.data.value).toBe('data')
    expect(soft).toHaveBeenCalledOnce()
    expect(soft.mock.calls[0]![0]).toContain('读取失败')
  })

  it('quiet 刷新时被收回权限(403)要立刻换成无权限,而不是继续显示旧数据', async () => {
    let revoke = false
    const state = useLoadState(async () => (revoke ? Promise.reject(apiError('你的账号没有开通这个功能', 403)) : 'data'), '读取')
    await state.reload()
    revoke = true
    await state.reload({ quiet: true })
    expect(state.phase.value).toBe('forbidden')
    expect(state.data.value).toBeNull()
  })
})
