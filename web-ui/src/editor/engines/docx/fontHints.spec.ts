import { describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { hintsFromParts, prefetchHintedFonts, scanDocxFontHints, type HintFontProvider } from './fontHints'

const theme = `<a:theme><a:fontScheme><a:majorFont><a:latin typeface="Cambria"/><a:ea typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/></a:minorFont></a:fontScheme></a:theme>`
const para = (text: string, rpr = '') => `<w:p><w:r>${rpr}<w:t>${text}</w:t></w:r></w:p>`

describe('hintsFromParts', () => {
  it('正文直接写明的拉丁族名与主题里的拉丁字体都算', () => {
    const hints = hintsFromParts({
      body: [`<w:document>${para('Hello', '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr>')}</w:document>`],
      styles: '<w:styles/>',
      theme,
    })
    expect(hints.families.sort()).toEqual(['Arial', 'Calibri', 'Cambria'])
    expect(hints.cjk).toBe(false)
    expect(hints.bold).toBe(false)
  })

  it('主题占位名不是真字体', () => {
    const hints = hintsFromParts({ body: ['<w:rFonts w:ascii="+mn-lt"/>'], styles: '', theme: '' })
    expect(hints.families).toEqual([])
  })

  it('只有正文文字里的中日文字才算需要中文字体，属性值里的 eastAsia="宋体" 不算', () => {
    const attrOnly = hintsFromParts({ body: [`<w:rFonts w:eastAsia="宋体"/>${para('English only')}`], styles: '', theme: '' })
    expect(attrOnly.cjk).toBe(false)
    expect(hintsFromParts({ body: [para('你好 world')], styles: '', theme: '' }).cjk).toBe(true)
    expect(hintsFromParts({ body: [para('こんにちは')], styles: '', theme: '' }).cjk).toBe(true)
  })

  it('粗体：样式或正文里有 <w:b/> 才算，<w:bCs/> 与 w:val="0" 不算', () => {
    expect(hintsFromParts({ body: [], styles: '<w:rPr><w:b/></w:rPr>', theme: '' }).bold).toBe(true)
    expect(hintsFromParts({ body: [para('x', '<w:rPr><w:b w:val="1"/></w:rPr>')], styles: '', theme: '' }).bold).toBe(true)
    expect(hintsFromParts({ body: [], styles: '<w:rPr><w:bCs/></w:rPr>', theme: '' }).bold).toBe(false)
    expect(hintsFromParts({ body: [], styles: '<w:rPr><w:b w:val="0"/></w:rPr>', theme: '' }).bold).toBe(false)
  })
})

describe('hintsFromParts：文档用到的码位', () => {
  it('收集正文 / 删除文字 / 公式 / 项目符号里 ≥ 0x80 的码位，ASCII 不记；数字实体按码位解码', () => {
    const hints = hintsFromParts({
      body: [
        `<w:p><w:r><w:t>Hi 你好 é</w:t></w:r><w:r><w:delText>删</w:delText></w:r></w:p><m:t>α</m:t>`,
        `<w:lvlText w:val="•"/><w:sym w:font="Symbol" w:char="F0B7"/><w:t>&#x4e2d;&#25991;</w:t>`,
      ],
      styles: '',
      theme: '',
    })
    expect([...hints.chars].map((cp) => String.fromCodePoint(cp)).sort()).toEqual(['•', '你', '好', '删', 'é', 'α', '\uF0B7', '中', '文'].sort())
  })
})

describe('scanDocxFontHints', () => {
  it('从真实 zip 包里读出线索；包坏了返回 null 而不是抛错', async () => {
    const zip = new JSZip()
    zip.file('word/document.xml', `<w:document>${para('中文', '<w:rPr><w:rFonts w:ascii="Times New Roman"/><w:b/></w:rPr>')}</w:document>`)
    zip.file('word/styles.xml', '<w:styles/>')
    zip.file('word/theme/theme1.xml', theme)
    zip.file('word/header1.xml', `<w:hdr>${para('Header')}</w:hdr>`)
    const hints = await scanDocxFontHints(await zip.generateAsync({ type: 'uint8array' }))
    expect(hints?.cjk).toBe(true)
    expect(hints?.bold).toBe(true)
    expect(hints?.families).toContain('Times New Roman')
    expect(await scanDocxFontHints(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

describe('prefetchHintedFonts', () => {
  const makeProvider = () => {
    const loads: string[] = []
    const loader = (name: string) => () => {
      loads.push(name)
      return Promise.resolve(new ArrayBuffer(1))
    }
    const provider: HintFontProvider = {
      resolve: (family, bold) => (family === 'Unknown' ? undefined : loader(`${family}${bold ? ' bold' : ''}`)),
      resolveLastResort: (family, bold) => loader(`lastResort(${family}${bold ? ' bold' : ''})`),
      resolveScriptFallback: (script) => loader(`script:${script}`),
    }
    return { provider, loads }
  }

  it('有粗体就粗体、正体各取一份，没有就只取正体；未知族名退到兜底字体', () => {
    const plain = makeProvider()
    expect(prefetchHintedFonts(plain.provider, { families: ['Calibri', 'Unknown'], bold: false, cjk: false, chars: new Set() })).toBe(2)
    expect(plain.loads).toEqual(['Calibri', 'lastResort(Unknown)'])
    const bold = makeProvider()
    prefetchHintedFonts(bold.provider, { families: ['Calibri'], bold: true, cjk: false, chars: new Set() })
    expect(bold.loads).toEqual(['Calibri', 'Calibri bold'])
  })

  it('正文有中文才取中文字体', () => {
    const none = makeProvider()
    prefetchHintedFonts(none.provider, { families: [], bold: false, cjk: false, chars: new Set() })
    expect(none.loads).toEqual([])
    const some = makeProvider()
    prefetchHintedFonts(some.provider, { families: [], bold: false, cjk: true, chars: new Set() })
    expect(some.loads).toEqual(['script:cjk-sc'])
  })

  it('下载失败不抛未处理的拒绝（预取只是优化）：每个加载函数返回的 Promise 都挂了 catch', () => {
    const catches = [vi.fn(), vi.fn()]
    let n = 0
    const provider: HintFontProvider = {
      resolve: () => () => ({ catch: catches[n++]! }) as unknown as Promise<ArrayBuffer>,
      resolveLastResort: () => undefined,
      resolveScriptFallback: () => undefined,
    }
    prefetchHintedFonts(provider, { families: ['Calibri', 'Arial'], bold: false, cjk: false, chars: new Set() })
    expect(catches[0]).toHaveBeenCalledTimes(1)
    expect(catches[1]).toHaveBeenCalledTimes(1)
  })
})
