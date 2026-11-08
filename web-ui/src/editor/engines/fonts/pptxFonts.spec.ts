// 幻灯片面的字体登记:只登记 Calibri;度量字体拉丁 / 中文分开按需取,只下载一次;下载失败不缓存。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

function respond() {
  return Promise.resolve(new Response(new Uint8Array(10), { status: 200 }))
}

beforeEach(() => {
  vi.resetModules()
  fetchMock.mockReset().mockImplementation(() => respond())
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('NATIVE_FONT_FAMILIES', () => {
  it('只登记 Calibri（Arial 等族名由引擎顶替，布局逐字相同）', async () => {
    const { NATIVE_FONT_FAMILIES } = await import('./pptxFonts')
    expect([...NATIVE_FONT_FAMILIES]).toEqual(['Calibri'])
  })
})

describe('幻灯片面给引擎排版用的度量字体', () => {
  it('拉丁度量（常规 + 粗体）与中文度量分开取：纯拉丁 deck 不会下载任何中文相关文件；各自只下载一次', async () => {
    const { loadLatinMetrics, loadCjkMetrics } = await import('./pptxFonts')
    const latin = await loadLatinMetrics()
    expect(Object.keys(latin).sort()).toEqual(['bold', 'regular'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map((call) => String(call[0])).every((url) => /metrics-latin/.test(url))).toBe(true)
    expect(await loadLatinMetrics()).toBe(latin)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const cjk = await loadCjkMetrics()
    expect(cjk).toBeInstanceOf(Uint8Array)
    expect(String(fetchMock.mock.calls.at(-1)![0])).toMatch(/metrics-cjk/)
    expect(await loadCjkMetrics()).toBe(cjk)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('下载失败不缓存，重试能成功', async () => {
    const { loadLatinMetrics } = await import('./pptxFonts')
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('', { status: 503 })))
    await expect(loadLatinMetrics()).rejects.toThrow(/503/)
    await expect(loadLatinMetrics()).resolves.toMatchObject({ bold: expect.any(Uint8Array) })
  })
})
