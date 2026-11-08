import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchOriginal, OriginalError } from './fetchOriginal'

const stream = (chunks: number[][]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk))
      controller.close()
    },
  })
const reply = (body: ReadableStream<Uint8Array> | null, init: ResponseInit = { status: 200 }) =>
  vi.stubGlobal('fetch', vi.fn(async () => Object.assign(new Response(body, init), {})))

afterEach(() => vi.unstubAllGlobals())

describe('fetchOriginal', () => {
  it('concatenates chunks and reports progress', async () => {
    reply(stream([[1, 2], [3]]), { status: 200, headers: { 'content-length': '3' } })
    const seen: number[] = []
    const buffer = await fetchOriginal('/api/v1/raw?x=1', { onProgress: (loaded) => seen.push(loaded) })
    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3])
    expect(seen).toEqual([2, 3])
  })
  it('sends the session cookie', async () => {
    reply(stream([[1]]))
    await fetchOriginal('/api/v1/raw')
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin' })
  })
  it.each([
    [404, /找不到原件/],
    [413, /64 MB/],
    [401, /权限/],
    [500, /HTTP 500/],
  ])('maps HTTP %i to a readable message', async (status, message) => {
    reply(null, { status })
    await expect(fetchOriginal('/x')).rejects.toMatchObject({ name: 'OriginalError', status, message: expect.stringMatching(message) })
  })
  it('refuses a declared size over the limit before reading', async () => {
    reply(stream([[1]]), { status: 200, headers: { 'content-length': '999' } })
    await expect(fetchOriginal('/x', { maxBytes: 10 })).rejects.toBeInstanceOf(OriginalError)
  })
  it('stops reading once the streamed size passes the limit', async () => {
    reply(stream([[1, 2, 3, 4], [5, 6, 7, 8]]))
    await expect(fetchOriginal('/x', { maxBytes: 6 })).rejects.toMatchObject({ status: 413 })
  })
  it('turns a network failure into a readable error but lets aborts through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('boom'))))
    await expect(fetchOriginal('/x')).rejects.toMatchObject({ message: expect.stringMatching(/网络/) })
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(Object.assign(new Error('a'), { name: 'AbortError' }))))
    await expect(fetchOriginal('/x')).rejects.toMatchObject({ name: 'AbortError' })
  })
})
