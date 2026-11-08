import { afterEach, describe, expect, it, vi } from 'vitest'
import { bytesEqual, checkXlsxSaveable, looksLikeZip, sha256Hex } from './saveGuard'
import { createXlsxSaveTransport, saveXlsxBytes } from './xlsx'

/** 造一个结构上合法的空 ZIP（局部头 + 中央目录结束标记），足够让守卫放行 */
function fakeZip(size = 64): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 0x03, 0x04], 0)
  bytes.set([0x50, 0x4b, 0x05, 0x06], size - 4)
  return bytes
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('saveGuard', () => {
  it('完整的 ZIP 才放行，空 / 截断 / 非 ZIP 都拦住', () => {
    expect(looksLikeZip(fakeZip())).toBe(true)
    expect(looksLikeZip(new Uint8Array())).toBe(false)
    expect(looksLikeZip(fakeZip().slice(0, 20))).toBe(false)
    expect(looksLikeZip(new TextEncoder().encode('<html>error</html>'))).toBe(false)
    expect(checkXlsxSaveable(new Uint8Array()).ok).toBe(false)
    expect(checkXlsxSaveable(new TextEncoder().encode('nope'))).toMatchObject({ ok: false })
  })

  it('超过上限时给出可读的 MB 提示', () => {
    const result = checkXlsxSaveable(fakeZip(), { maxBytes: 10 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('上限')
  })

  it('哈希稳定且按字节比较', async () => {
    const bytes = fakeZip()
    const first = await sha256Hex(bytes)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await sha256Hex(bytes.slice())).toBe(first)
    expect(bytesEqual(bytes, bytes.slice())).toBe(true)
    const other = fakeZip()
    other[10] = 1
    expect(bytesEqual(bytes, other)).toBe(false)
  })
})

describe('xlsx 保存通道', () => {
  it('守卫失败时不发请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await saveXlsxBytes(new Uint8Array([1, 2, 3]), {
      collection: 'c',
      path: 'p.xlsx',
      expectedSha256: 'old',
    })
    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('成功时映射版本、哈希与未变标记', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: { version: 9, sha256: 'newhash', size: 64, embedded: 2, chunks: 1, unchanged: false, parts_removed: ['xl/calcChain.xml'] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const result = await saveXlsxBytes(fakeZip(), { collection: 'c', path: 'p.xlsx', expectedSha256: 'old' })
    expect(result).toMatchObject({ ok: true, revision: 9, sha256: 'newhash', partsRemoved: ['xl/calcChain.xml'] })
  })

  it('409 映射成冲突而不是普通失败', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: { code: 'conflict', message: '文件已被别人修改' } }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const result = await saveXlsxBytes(fakeZip(), { collection: 'c', path: 'p.xlsx', expectedSha256: 'old' })
    expect(result.ok).toBe(false)
    expect(result.conflict?.message).toContain('别人')
  })

  it('字节与打开时一致就不发请求（未改动）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const bytes = fakeZip()
    const transport = createXlsxSaveTransport({
      collection: 'c',
      path: 'p.xlsx',
      expectedSha256: await sha256Hex(bytes),
    })
    const result = await transport.save({
      fileId: 'f1',
      collection: 'c',
      revision: 3,
      source: { kind: 'bytes', name: 'p.xlsx', bytes },
    })
    expect(result).toMatchObject({ ok: true, unchanged: true, revision: 3 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('没有 bytes 的 source 直接拒绝，避免把空内容写成原件', async () => {
    const transport = createXlsxSaveTransport({ collection: 'c', path: 'p.xlsx', expectedSha256: 'old' })
    const result = await transport.save({
      fileId: 'f1',
      revision: 1,
      source: { kind: 'text', text: 'oops', name: 'p.txt' },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('字节')
  })
})
