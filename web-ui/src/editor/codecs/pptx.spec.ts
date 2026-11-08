/**
 * PPTX 保存通道测试：和 xlsx 同一套整包链路，这里核对 pptx 自己的提示与关键保护
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkOfficeSaveable, sha256Hex } from './saveGuard'
import { createPptxSaveTransport, savePptxBytes } from './pptx'

function fakeZip(size = 64): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 0x03, 0x04], 0)
  bytes.set([0x50, 0x4b, 0x05, 0x06], size - 4)
  return bytes
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('pptx 保存守卫', () => {
  it('提示里是 pptx 和"演示文稿"，不是 xlsx / 表格', () => {
    const empty = checkOfficeSaveable(new Uint8Array(), { kind: 'pptx', defaultLabel: '演示文稿' })
    expect(empty).toMatchObject({ ok: false })
    if (!empty.ok) expect(empty.reason).toContain('演示文稿')
    const broken = checkOfficeSaveable(new TextEncoder().encode('nope'), { kind: 'pptx', defaultLabel: '演示文稿' })
    if (!broken.ok) expect(broken.reason).toContain('pptx')
    const tooBig = checkOfficeSaveable(fakeZip(), { kind: 'pptx', defaultLabel: '演示文稿', maxBytes: 10 })
    if (!tooBig.ok) expect(tooBig.reason).toContain('上限')
  })
})

describe('pptx 保存通道', () => {
  it('守卫失败（截断 / 非 zip）时不发请求，也不会覆盖原件', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await savePptxBytes(new Uint8Array([1, 2, 3]), { collection: 'c', path: 'a.pptx', expectedSha256: 'old' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('pptx')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('成功：映射版本 / 哈希 / 被清理的部件；带上原哈希（乐观锁）和编辑权 session', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, data: { version: 4, sha256: 'new', size: 64, embedded: 3, chunks: 2, unchanged: false, parts_removed: ['ppt/media/x.png'] } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await savePptxBytes(fakeZip(), { collection: 'c', path: 'a.pptx', expectedSha256: 'orig', sessionId: 's-1' })
    expect(result).toMatchObject({ ok: true, revision: 4, sha256: 'new', embedded: 3, partsRemoved: ['ppt/media/x.png'] })
    const url = String((fetchMock.mock.calls[0] as unknown as [string])[0])
    expect(url).toContain('expected_sha256=orig')
    expect(url).toContain('session=s-1')
  })

  it('服务端整包检查不通过（原文件不动）→ 失败并带原因；409 → 冲突', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, error: { code: 'invalid_office', message: '新文件不是完整的 PowerPoint 包：缺少 ppt/presentation.xml' } }, 422)))
    const invalid = await savePptxBytes(fakeZip(), { collection: 'c', path: 'a.pptx', expectedSha256: 'orig' })
    expect(invalid.ok).toBe(false)
    expect(invalid.reason).toContain('不是完整')
    expect(invalid.conflict).toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, error: { code: 'conflict', message: '文件已被别人修改' } }, 409)))
    const conflict = await savePptxBytes(fakeZip(), { collection: 'c', path: 'a.pptx', expectedSha256: 'orig' })
    expect(conflict.conflict?.message).toContain('别人')
  })

  it('网络异常变成可读的失败，不抛出', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    const result = await savePptxBytes(fakeZip(), { collection: 'c', path: 'a.pptx', expectedSha256: 'orig' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  it('字节与打开时完全一致 → 不发请求、不推进版本', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const bytes = fakeZip()
    const transport = createPptxSaveTransport({ collection: 'c', path: 'a.pptx', expectedSha256: await sha256Hex(bytes) })
    const result = await transport.save({ fileId: 'f', revision: 7, source: { kind: 'bytes', name: 'a.pptx', bytes } })
    expect(result).toMatchObject({ ok: true, unchanged: true, revision: 7 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('基线哈希可以是函数：保存成功更新基线后，下一次保存用新的', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(new URL(url, 'http://x').searchParams.get('expected_sha256') ?? '')
      return json({ ok: true, data: { version: 2, sha256: 'h2', size: 1, embedded: 0, chunks: 0, unchanged: false, parts_removed: [] } })
    }))
    let base = 'h1'
    const transport = createPptxSaveTransport({ collection: 'c', path: 'a.pptx', expectedSha256: () => base })
    await transport.save({ fileId: 'f', revision: 1, source: { kind: 'bytes', name: 'a.pptx', bytes: fakeZip(70) } })
    base = 'h2'
    await transport.save({ fileId: 'f', revision: 2, source: { kind: 'bytes', name: 'a.pptx', bytes: fakeZip(80) } })
    expect(seen).toEqual(['h1', 'h2'])
  })

  it('不是字节的 source 直接拒绝', async () => {
    const transport = createPptxSaveTransport({ collection: 'c', path: 'a.pptx', expectedSha256: 'old' })
    const result = await transport.save({ fileId: 'f', revision: 1, source: { kind: 'text', text: 'oops', name: 'a.txt' } })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('演示文稿')
  })
})
