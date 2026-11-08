import { describe, expect, it, vi } from 'vitest'
import { landAndWait, startLanding } from './landing'

/** 最小的假 provider:能触发事件、记录提交。 */
function fakeProvider(options: { lander?: boolean } = {}) {
  const handlers = new Map<string, ((payload: unknown) => void)[]>()
  const landed: string[] = []
  const state = { lander: options.lander ?? true }
  return {
    landed,
    state,
    emit: (event: string, payload?: unknown) => (handlers.get(event) ?? []).forEach((handler) => handler(payload)),
    provider: {
      on: (event: string, handler: (payload: never) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler as (payload: unknown) => void])
        return () => handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== handler))
      },
      land: (markdown: string) => {
        if (!state.lander) return false
        landed.push(markdown)
        return true
      },
      getState: () => state,
    },
  }
}

function manualTimers() {
  let pending: { fn: () => void; at: number; id: number } | null = null
  let nextId = 1
  let clock = 0
  return {
    setTimeout: (fn: () => void, ms: number) => {
      pending = { fn, at: clock + ms, id: nextId }
      return nextId++
    },
    clearTimeout: (handle: unknown) => {
      if (pending?.id === handle) pending = null
    },
    advance: (ms: number) => {
      clock += ms
      if (pending && pending.at <= clock) {
        const { fn } = pending
        pending = null
        fn()
      }
    },
  }
}

describe('落地调度', () => {
  it('内容变化后安静一会儿才提交,连续变化只提交最后一次', () => {
    const { provider, emit, landed } = fakeProvider()
    const timers = manualTimers()
    let text = 'v1'
    startLanding(provider as never, { getMarkdown: () => text, quietMs: 1000, ...timers })
    emit('change')
    timers.advance(600)
    text = 'v2'
    emit('change')
    timers.advance(600)
    expect(landed).toEqual([])
    timers.advance(500)
    expect(landed).toEqual(['v2'])
  })

  it('land_now 立刻提交;销毁前(closing)提交最后一次', () => {
    const { provider, emit, landed } = fakeProvider()
    startLanding(provider as never, { getMarkdown: () => '正文' })
    emit('land-now')
    emit('closing')
    expect(landed).toEqual(['正文', '正文'])
  })

  it('不是落地者就什么也不提交;编辑器还没准备好(null)也不提交', () => {
    const notLander = fakeProvider({ lander: false })
    startLanding(notLander.provider as never, { getMarkdown: () => '正文' })
    notLander.emit('land-now')
    expect(notLander.landed).toEqual([])
    const notReady = fakeProvider()
    startLanding(notReady.provider as never, { getMarkdown: () => null })
    notReady.emit('land-now')
    expect(notReady.landed).toEqual([])
  })

  it('变过但没交出去的内容,在这条连接成为落地者的那一刻补交', () => {
    const { provider, emit, landed, state } = fakeProvider({ lander: false })
    const timers = manualTimers()
    startLanding(provider as never, { getMarkdown: () => '补交的内容', quietMs: 100, ...timers })
    emit('change')
    timers.advance(150)
    expect(landed).toEqual([])
    state.lander = true
    emit('state', { lander: true })
    timers.advance(150)
    expect(landed).toEqual(['补交的内容'])
  })

  it('auto() 为 false:内容变化、land_now、关页面都先不落地(正文算草稿),还是落地者', () => {
    const { provider, emit, landed } = fakeProvider()
    const timers = manualTimers()
    startLanding(provider as never, { getMarkdown: () => '草稿正文', quietMs: 100, auto: () => false, ...timers })
    emit('change')
    timers.advance(200)
    emit('land-now')
    emit('closing')
    expect(landed).toEqual([])
  })

  it('auto() 变 true(房间里来了别人)后,下一次安静就照常落地', () => {
    const { provider, emit, landed } = fakeProvider()
    const timers = manualTimers()
    let allow = false
    startLanding(provider as never, { getMarkdown: () => '正文', quietMs: 100, auto: () => allow, ...timers })
    emit('change')
    timers.advance(200)
    expect(landed).toEqual([])
    allow = true
    emit('change')
    timers.advance(200)
    expect(landed).toEqual(['正文'])
  })

  it('停止后不再响应事件', () => {
    const { provider, emit, landed } = fakeProvider()
    const stop = startLanding(provider as never, { getMarkdown: () => 'x' })
    stop()
    emit('land-now')
    expect(landed).toEqual([])
    expect(vi.isMockFunction(stop)).toBe(false)
  })
})

describe('别的窗口点了保存（saveSeq）', () => {
  /** 带在线状态的假 provider：能模拟别的连接把 saveSeq 加一 */
  function withAwareness() {
    const fake = fakeProvider({ lander: true })
    const states = new Map<number, Record<string, unknown>>([[1, {}]])
    const listeners: (() => void)[] = []
    const awareness = {
      clientID: 1,
      getStates: () => states,
      on: (_event: string, handler: () => void) => listeners.push(handler),
      off: (_event: string, handler: () => void) => listeners.splice(listeners.indexOf(handler), 1),
    }
    const setRemote = (client: number, state: Record<string, unknown>) => {
      states.set(client, state)
      listeners.slice().forEach((handler) => handler())
    }
    return { ...fake, provider: { ...fake.provider, awareness: awareness as never }, setRemote }
  }

  it('auto() 为 false（只有「我」在，同账号的另一个窗口也算）时，别的窗口的保存请求照样立刻提交', () => {
    const { provider, landed, setRemote } = withAwareness()
    startLanding(provider as never, { getMarkdown: () => '新正文', auto: () => false })
    setRemote(2, { user: { id: 'me' } })
    expect(landed).toEqual([])
    setRemote(2, { user: { id: 'me' }, saveSeq: 1 })
    expect(landed).toEqual(['新正文'])
  })

  it('同一个序号不重复提交；序号变大（再点一次保存）才再提交；自己的序号不算', () => {
    const { provider, landed, setRemote } = withAwareness()
    startLanding(provider as never, { getMarkdown: () => '正文', auto: () => false })
    setRemote(2, { saveSeq: 1 })
    setRemote(2, { saveSeq: 1, cursor: 3 })
    expect(landed).toHaveLength(1)
    setRemote(2, { saveSeq: 2 })
    expect(landed).toHaveLength(2)
    setRemote(1, { saveSeq: 9 })
    expect(landed).toHaveLength(2)
  })

  it('停止后不再响应', () => {
    const { provider, landed, setRemote } = withAwareness()
    const stop = startLanding(provider as never, { getMarkdown: () => '正文', auto: () => false })
    stop()
    setRemote(2, { saveSeq: 1 })
    expect(landed).toEqual([])
  })
})

describe('landAndWait', () => {
  it('落地者提交后等到服务端 saved 才返回 true', async () => {
    const { provider, emit, landed } = fakeProvider()
    const result = landAndWait(provider as never, () => '最终正文', 1000)
    expect(landed).toEqual(['最终正文'])
    emit('saved', { savepoint: false })
    await expect(result).resolves.toBe(true)
  })
  it('不是落地者:没什么可等的,直接返回 true 且不提交', async () => {
    const { provider, landed } = fakeProvider({ lander: false })
    await expect(landAndWait(provider as never, () => 'x', 1000)).resolves.toBe(true)
    expect(landed).toEqual([])
  })
  it('等不到确认就超时返回 false,不无限等', async () => {
    const { provider } = fakeProvider()
    await expect(landAndWait(provider as never, () => 'x', 20)).resolves.toBe(false)
  })
  it('发不出去(离线)直接返回 false', async () => {
    const { provider } = fakeProvider()
    provider.land = () => false
    await expect(landAndWait(provider as never, () => 'x', 1000)).resolves.toBe(false)
  })
})
