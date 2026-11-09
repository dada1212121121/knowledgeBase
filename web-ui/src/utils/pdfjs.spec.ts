import { describe, expect, it } from 'vitest'
import { documentParams } from './pdfjs'

describe('documentParams', () => {
  it('把原件地址交给 pdf.js,由它按 Range 分段取字节', () => {
    const params = documentParams('/api/v1/download?collection=_global&path=a.pdf')
    expect(params.url).toBe('/api/v1/download?collection=_global&path=a.pdf')
    expect('data' in params).toBe(false)
    expect(params.withCredentials).toBe(true)
    expect(params.disableAutoFetch).toBe(true)
  })

  it('保留不执行脚本 / 不用 wasm / 静态资源路径这些安全与兼容配置', () => {
    const params = documentParams('/x.pdf')
    expect(params.isEvalSupported).toBe(false)
    expect(params.enableScripting).toBe(false)
    expect(params.useWasm).toBe(false)
    expect(params.cMapUrl).toBe('/pdfjs/cmaps/')
    expect(params.standardFontDataUrl).toBe('/pdfjs/standard_fonts/')
  })
})
