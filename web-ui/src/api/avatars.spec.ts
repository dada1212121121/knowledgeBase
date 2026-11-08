// 批量查头像:一次请求问清一批人、一分钟内走缓存、同时的请求合并、失败静默、游客不查、超过 50 个分批。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedAvatar, lookupAvatars, resetAvatarLookup } from './avatars'

const originalFetch = globalThis.fetch
const reply = (avatars: Record<string, string | null>) =>
  new Response(JSON.stringify({ ok: true, data: { avatars } }), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  resetAvatarLookup()
  vi.useFakeTimers()
})
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('lookupAvatars', () => {
  it('一次请求问清一批人;有头像的给文件名,没有的是 null', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => reply({ usr_a: 'a-1.png', usr_b: null }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const result = await lookupAvatars(['usr_a', 'usr_b'])
    expect(result).toEqual({ usr_a: 'a-1.png', usr_b: null })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v1/users/avatars?ids=usr_a%2Cusr_b')
  })

  it('一分钟内问过的走缓存,超过一分钟重新问(这期间对方可能换了头像)', async () => {
    const fetchMock = vi.fn(async () => reply({ usr_a: 'a-1.png' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await lookupAvatars(['usr_a'])
    await lookupAvatars(['usr_a'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_001)
    await lookupAvatars(['usr_a'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('同时来的相同请求合并成一次(头像堆和名单同时要同一个人)', async () => {
    const fetchMock = vi.fn(async () => reply({ usr_a: 'a-1.png' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const [first, second] = await Promise.all([lookupAvatars(['usr_a']), lookupAvatars(['usr_a'])])
    expect(first).toEqual(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('只问缓存里没有的:已知的人不重复问', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const ids = decodeURIComponent(String(input).split('ids=')[1] ?? '').split(',')
      return reply(Object.fromEntries(ids.map((id) => [id, `${id}.png`])))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await lookupAvatars(['usr_a'])
    await lookupAvatars(['usr_a', 'usr_b'])
    expect(decodeURIComponent(String(fetchMock.mock.calls[1]?.[0]))).toBe('/api/v1/users/avatars?ids=usr_b')
  })

  it('游客和空 id 不查;全是游客时一个请求都不发', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    expect(await lookupAvatars(['guest:访客1234#7', ''])).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('失败静默:网络断了 / 401 / 返回不是 JSON,都当作没有头像,不抛错,一分钟内不再重试', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('offline')
    }) as unknown as typeof fetch
    expect(await lookupAvatars(['usr_a'])).toEqual({ usr_a: null })

    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    expect(await lookupAvatars(['usr_b'])).toEqual({ usr_b: null })

    globalThis.fetch = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    expect(await lookupAvatars(['usr_c'])).toEqual({ usr_c: null })

    const again = vi.fn()
    globalThis.fetch = again as unknown as typeof fetch
    await lookupAvatars(['usr_a'])
    expect(again).not.toHaveBeenCalled()
  })

  it('超过 50 个自动分批(服务端一次最多 50 个)', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => reply({}))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const ids = Array.from({ length: 120 }, (_, index) => `usr_${index}`)
    await lookupAvatars(ids)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const sizes = fetchMock.mock.calls.map((call) => decodeURIComponent(String(call[0]).split('ids=')[1] ?? '').split(',').length)
    expect(sizes).toEqual([50, 50, 20])
  })

  it('cachedAvatar:没查过是 undefined,查过没有是 null,有是文件名', async () => {
    globalThis.fetch = vi.fn(async () => reply({ usr_a: 'a-1.png', usr_b: null })) as unknown as typeof fetch
    expect(cachedAvatar('usr_a')).toBeUndefined()
    await lookupAvatars(['usr_a', 'usr_b'])
    expect(cachedAvatar('usr_a')).toBe('a-1.png')
    expect(cachedAvatar('usr_b')).toBeNull()
  })
})
