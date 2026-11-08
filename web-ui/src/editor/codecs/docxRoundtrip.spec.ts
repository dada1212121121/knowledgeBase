/**
 * Word 打开前无损判定的缓存与流程单测：命中不重跑、版本变了作废、坏数据 / 存储不可用不影响检查；
 * 完整流程用真实的合成 docx 包（JSZip）走一遍 探针 → 服务端比较 → 内容清点 → 三态结论。
 */
import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'
import type { RoundtripReport } from '../../api/officeEdit'
// 用 vite 的 ?raw 读已安装引擎的 package.json：不引入 Node 类型，版本取自 node_modules 里实际装的那份
import enginePackage from '../../../node_modules/@betteroffice/docx/package.json?raw'
import type { DocxEditVerdict } from './docxInventory'
import { DOCX_ENGINE_VERSION, PROBE_MARKER, readDocumentXml, RoundtripCache, roundtripCacheKey, roundtripVerdict, type RoundtripStorage } from './docxRoundtrip'

const verdict = (over: Partial<DocxEditVerdict> = {}): DocxEditVerdict => ({ editable: 'yes', losses: [], rewritten: [], valid: true, reason: null, ...over })

function memoryStorage(initial: Record<string, string> = {}): RoundtripStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) }
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
async function docx(text: string, extra = ''): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('word/document.xml', `<w:document ${NS}><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p>${extra}</w:body></w:document>`)
  zip.file('word/footer1.xml', '<w:ftr/>')
  return zip.generateAsync({ type: 'uint8array' })
}
const shape = (name: string) => `<w:p><w:r><w:drawing><wp:anchor><wp:docPr id="1" name="${name}"/></wp:anchor></w:drawing></w:r></w:p>`
const serverOk = (over: Partial<RoundtripReport> = {}): RoundtripReport =>
  ({ valid: true, reason: null, lossless: false, changed_parts: ['word/document.xml'], removed_parts: [], added_parts: [], text_equal: false, ...over }) as RoundtripReport

describe('引擎版本常量', () => {
  it('与 node_modules 里实际安装的 @betteroffice/docx 版本一致（升级引擎必须同步改常量，旧结论才会作废）', () => {
    expect(DOCX_ENGINE_VERSION).toBe((JSON.parse(enginePackage) as { version: string }).version)
  })
})

describe('RoundtripCache', () => {
  it('存取同一份文件的结论', () => {
    const cache = new RoundtripCache(memoryStorage())
    expect(cache.get('abc')).toBeNull()
    cache.set('abc', verdict({ editable: 'force', rewritten: ['word/footer1.xml'] }))
    expect(cache.get('abc')).toMatchObject({ editable: 'force', rewritten: ['word/footer1.xml'] })
  })

  it('键里带引擎版本：版本不同取不到', () => {
    const cache = new RoundtripCache(memoryStorage())
    cache.set('abc', verdict(), '0.5.1')
    expect(cache.get('abc', '0.5.1')).not.toBeNull()
    expect(cache.get('abc', '0.6.0')).toBeNull()
    expect(roundtripCacheKey('abc', '0.5.1')).not.toBe(roundtripCacheKey('abc', '0.6.0'))
  })

  it('超过上限淘汰最久没用的；命中会刷新时间', () => {
    let clock = 0
    const cache = new RoundtripCache(memoryStorage(), () => ++clock, 3)
    for (const key of ['a', 'b', 'c']) cache.set(key, verdict())
    expect(cache.get('a')).not.toBeNull()
    cache.set('d', verdict())
    expect(cache.get('b')).toBeNull()
    for (const key of ['a', 'c', 'd']) expect(cache.get(key)).not.toBeNull()
  })

  it('存储里的数据被改坏：当作没有，不抛错', () => {
    for (const bad of ['not json', '{"a":1}', '[1,2]', '[{"key":"x"}]', '[{"key":"k","at":1,"verdict":{"editable":"maybe"}}]']) {
      const cache = new RoundtripCache(memoryStorage({ 'kb.docx.roundtrip.v2': bad }))
      expect(cache.get('abc')).toBeNull()
      cache.set('abc', verdict())
      expect(cache.get('abc')).not.toBeNull()
    }
  })

  it('旧版本（v1，存的是服务端报告）写下的条目不会被当成判定', () => {
    const old = JSON.stringify([{ key: roundtripCacheKey('abc'), at: 1, report: { valid: true, lossless: true, text_equal: true, changed_parts: [], removed_parts: [] } }])
    expect(new RoundtripCache(memoryStorage({ 'kb.docx.roundtrip.v1': old })).get('abc')).toBeNull()
  })

  it('没有存储 / 写入抛错（配额满）：静默退化，不影响调用方', () => {
    const none = new RoundtripCache(null)
    none.set('abc', verdict())
    expect(none.get('abc')).toBeNull()
    expect(() => new RoundtripCache({ getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } }).set('abc', verdict())).not.toThrow()
  })

  it('空 sha 不缓存', () => {
    const storage = memoryStorage()
    new RoundtripCache(storage).set('', verdict())
    expect(Object.keys(storage.data)).toHaveLength(0)
  })
})

describe('roundtripVerdict（完整流程）', () => {
  it('只改正文：yes；写缓存，第二次直接命中，不再起探针也不上传', async () => {
    const cache = new RoundtripCache(memoryStorage())
    const original = await docx('你好')
    const probe = vi.fn(async () => docx(`${PROBE_MARKER}你好`))
    const check = vi.fn(async () => serverOk())
    const first = await roundtripVerdict({ sha256: 'sha-1', original, probe, check, cache })
    expect(first).toMatchObject({ cached: false, verdict: { editable: 'yes' } })
    expect(probe).toHaveBeenCalledTimes(1)
    const second = await roundtripVerdict({ sha256: 'sha-1', original, probe, check, cache })
    expect(second).toMatchObject({ cached: true, verdict: { editable: 'yes' } })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('探针保存后别的部件被改写、文字都在：force，原因里点名部件', async () => {
    const original = await docx('你好')
    const result = await roundtripVerdict({
      sha256: 's',
      original,
      cache: new RoundtripCache(memoryStorage()),
      probe: async () => docx(`${PROBE_MARKER}你好`),
      check: async () => serverOk({ changed_parts: ['word/document.xml', 'word/footer1.xml'] }),
    })
    expect(result.verdict).toMatchObject({ editable: 'force', rewritten: ['word/footer1.xml'] })
  })

  it('流程图那次的真实情形：探针保存后一个浮动形状不见了 → no，原因点名形状；结论也进缓存', async () => {
    const cache = new RoundtripCache(memoryStorage())
    const original = await docx('流程', shape('椭圆 32') + shape('椭圆 33'))
    const result = await roundtripVerdict({
      sha256: 's',
      original,
      cache,
      probe: async () => docx(`${PROBE_MARKER}流程`, shape('椭圆 33')),
      check: async () => serverOk(),
    })
    expect(result.verdict.editable).toBe('no')
    expect(result.verdict.losses.join()).toContain('椭圆 32')
    expect(cache.get('s')?.editable).toBe('no')
  })

  it('探针保存出来不是完整的包：no，带服务端的原因', async () => {
    const original = await docx('你好')
    const result = await roundtripVerdict({
      sha256: 's',
      original,
      cache: new RoundtripCache(memoryStorage()),
      probe: async () => docx(`${PROBE_MARKER}你好`),
      check: async () => serverOk({ valid: false, reason: '缺少 [Content_Types].xml' }),
    })
    expect(result.verdict).toMatchObject({ editable: 'no', valid: false, reason: '缺少 [Content_Types].xml' })
  })

  it('文件换了（sha 不同）重新检查', async () => {
    const cache = new RoundtripCache(memoryStorage())
    const probe = vi.fn(async () => docx(`${PROBE_MARKER}你好`))
    const original = await docx('你好')
    await roundtripVerdict({ sha256: 'a', original, probe, check: async () => serverOk(), cache })
    await roundtripVerdict({ sha256: 'b', original, probe, check: async () => serverOk(), cache })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('探针失败 / 服务端失败：错误抛给调用方，失败的结论不进缓存（下次重试）', async () => {
    const cache = new RoundtripCache(memoryStorage())
    const original = await docx('你好')
    await expect(roundtripVerdict({ sha256: 'a', original, probe: async () => { throw new Error('引擎拒绝') }, check: async () => serverOk(), cache })).rejects.toThrow('引擎拒绝')
    await expect(roundtripVerdict({ sha256: 'a', original, probe: async () => docx(`${PROBE_MARKER}你好`), check: async () => { throw new Error('502') }, cache })).rejects.toThrow('502')
    expect(cache.get('a')).toBeNull()
  })

  it('没有 sha：每次都检查，也不写缓存', async () => {
    const cache = new RoundtripCache(memoryStorage())
    const probe = vi.fn(async () => docx(`${PROBE_MARKER}你好`))
    const original = await docx('你好')
    await roundtripVerdict({ sha256: '', original, probe, check: async () => serverOk(), cache })
    await roundtripVerdict({ sha256: '', original, probe, check: async () => serverOk(), cache })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('原件里没有 word/document.xml：抛错（不能证明无损就不放行）', async () => {
    const zip = new JSZip()
    zip.file('a.txt', 'x')
    await expect(readDocumentXml(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('document.xml')
  })
})
