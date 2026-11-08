import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { peekDeckHasCjk, peekDeckText, readEntries } from './pptxPeek'

const slideXml = (text: string, extra = '') => `<p:sld><p:cSld ${extra}><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:cSld></p:sld>`

async function deck(slides: string[], options: { compression?: 'DEFLATE' | 'STORE' } = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  const flat = { createFolders: false }
  zip.file('[Content_Types].xml', '<Types/>', flat)
  slides.forEach((xml, i) => zip.file(`ppt/slides/slide${i + 1}.xml`, xml, flat))
  return zip.generateAsync({ type: 'uint8array', compression: options.compression ?? 'DEFLATE' })
}

describe('pptx 预读中文（冷开优化）', () => {
  it('读出中央目录里的条目名', async () => {
    const entries = readEntries(await deck([slideXml('a'), slideXml('b')]))
    expect(entries.map((entry) => entry.name)).toEqual(['[Content_Types].xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'])
  })

  it('前几页的文字节点里有汉字 → true（压缩与不压缩两种存法）', async () => {
    expect(await peekDeckHasCjk(await deck([slideXml('产品路线图')]))).toBe(true)
    expect(await peekDeckHasCjk(await deck([slideXml('产品路线图')], { compression: 'STORE' }))).toBe(true)
  })

  it('纯拉丁文字 → false；属性里的中文（形状名 / 字体名）不算', async () => {
    expect(await peekDeckHasCjk(await deck([slideXml('Quarterly review')]))).toBe(false)
    expect(await peekDeckHasCjk(await deck([slideXml('Quarterly review', 'name="微软雅黑"')]))).toBe(false)
  })

  it('只看前三页；第四页才出现的中文留给引擎解析后再判断（预测漏报不出错）', async () => {
    const slides = [slideXml('one'), slideXml('two'), slideXml('three'), slideXml('第四页')]
    expect(await peekDeckHasCjk(await deck(slides))).toBe(false)
    expect(await peekDeckHasCjk(await deck([slideXml('one'), slideXml('two'), slideXml('第三页')]))).toBe(true)
  })

  it('页序按数字排而不是字符串：slide10 排在 slide2 后面', async () => {
    const zip = new JSZip()
    zip.file('ppt/slides/slide10.xml', slideXml('第十页'), { createFolders: false })
    for (let i = 1; i <= 3; i += 1) zip.file(`ppt/slides/slide${i}.xml`, slideXml('latin'), { createFolders: false })
    expect(await peekDeckHasCjk(await zip.generateAsync({ type: 'uint8array' }))).toBe(false)
  })

  it('不是 zip / 空 / 截断：返回 false 而不是抛错', async () => {
    expect(await peekDeckHasCjk(new Uint8Array())).toBe(false)
    expect(await peekDeckHasCjk(new TextEncoder().encode('这不是 zip'))).toBe(false)
    const good = await deck([slideXml('产品')])
    expect(await peekDeckHasCjk(good.subarray(0, good.byteLength - 30))).toBe(false)
  })
  it('peekDeckText 返回前三页文字节点里的全部文字（属性值里的字不算），第四页起不读', async () => {
    const text = await peekDeckText(await deck([slideXml('第一页', 'name="微软雅黑"'), slideXml('Second'), slideXml('第三页'), slideXml('第四页不读')]))
    expect(text).toBe('第一页Second第三页')
  })

  it('peekDeckText 在读不出来时返回已读到的部分或空串，不抛错', async () => {
    expect(await peekDeckText(new Uint8Array())).toBe('')
    expect(await peekDeckText(new TextEncoder().encode('这不是 zip'))).toBe('')
  })
})
