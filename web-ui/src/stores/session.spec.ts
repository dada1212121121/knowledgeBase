// 会话心跳(卡 A):页面可见时每 20 秒问一次登录状态,标签页在后台时不发。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from './session'

let visibility: DocumentVisibilityState = 'visible'
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { user: { id: 'u1', username: 'admin' }, features: [], ai_enabled: true } }), { status: 200 }))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  setActivePinia(createPinia())
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('会话心跳', () => {
  it('可见时每 20 秒一次;标签页在后台时不发', async () => {
    const session = useSessionStore()
    session.start()
    await vi.advanceTimersByTimeAsync(0)
    const first = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetchMock.mock.calls.length).toBe(first + 1)
    visibility = 'hidden'
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock.mock.calls.length).toBe(first + 1)
    visibility = 'visible'
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetchMock.mock.calls.length).toBe(first + 2)
  })
})
