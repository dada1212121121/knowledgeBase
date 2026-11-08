// `utils/preview.ts` 的单测:块位置标签、字幕可导出性、信息栏计数行。
// 这些逻辑原本写在 `Browser.vue` 里,只能靠像素比对,现在单独守。
import { describe, expect, it } from 'vitest'
import { blocksByPage, chunkPositionLabel, fileCountLabel, previewNotice, srtForFile } from './preview'

type Anchor = {
  kind: string
  page?: number
  slide?: number
  sheet?: string
  cell?: string
  start_ms?: number
  end_ms?: number
}
const page = (number: number): Anchor => ({ kind: 'page', page: number })
const slide = (number: number): Anchor => ({ kind: 'slide', slide: number })
const time = (start: number, end: number): Anchor => ({ kind: 'time', start_ms: start, end_ms: end })
const chunk = (text: string, anchor: Anchor | null, ordinal = 1) => ({ ordinal, anchor, text })

describe('chunkPositionLabel', () => {
  it('PDF 多块页给出 #p7 ¶2(按命中文本在页内的位置)', () => {
    const blocks = [
      { anchor: page(7), text: '3.2 混合检索与倒数排名融合' },
      { anchor: page(7), text: '倒数排名融合(RRF)以 1/(k+rank) 加权求和。' },
    ]
    expect(chunkPositionLabel(chunk('倒数排名融合(RRF)以 1/(k+rank) 加权求和。', page(7)), blocks)).toBe('#p7 ¶2')
  })

  it('该页只有一个块时不写 ¶(真实 PDF 每页一段)', () => {
    const blocks = [{ anchor: page(7), text: '整页的文字层。' }]
    expect(chunkPositionLabel(chunk('整页的文字层。', page(7)), blocks)).toBe('#p7')
  })

  it('非 page 锚点沿用 anchorText;没有锚点用序号', () => {
    const blocks = [{ anchor: { kind: 'cell', sheet: '评测汇总', cell: 'R2' } as Anchor, text: 'a' }]
    expect(chunkPositionLabel(chunk('a', { kind: 'cell', sheet: '评测汇总', cell: 'R2' }), blocks)).toBe('评测汇总!R2')
    expect(chunkPositionLabel(chunk('无锚点', null, 9), blocks)).toBe('#9')
  })

  it('预建的页索引与现算的结果一致', () => {
    const blocks = [
      { anchor: page(3), text: '甲' },
      { anchor: page(3), text: '乙' },
    ]
    const index = blocksByPage(blocks)
    expect(chunkPositionLabel(chunk('乙', page(3)), blocks, index)).toBe('#p3 ¶2')
  })
})

describe('srtForFile', () => {
  it('逐句时间戳的音视频可以导出', () => {
    const text = srtForFile('m4a', [
      { text: '第一句', anchor: time(31_000, 32_000) },
      { text: '第二句', anchor: time(32_000, 33_000) },
    ])
    expect(text).toContain('00:00:31,000 --> 00:00:32,000')
  })

  it('抽取器占位锚点(整篇 0–60 秒)不导出', () => {
    expect(srtForFile('m4a', [{ text: '整篇转写', anchor: time(0, 60_000) }])).toBe('')
  })

  it('非音视频格式一律不导出', () => {
    expect(srtForFile('pdf', [{ text: '甲', anchor: time(1000, 2000) }, { text: '乙', anchor: time(2000, 3000) }])).toBe('')
  })
})

describe('previewNotice', () => {
  it('读不到原件时给出原因', () => {
    expect(previewNotice({ read_error: '读不到原件: No such file' })).toBe('读不到原件: No such file')
  })

  it('正常预览不显示提示', () => {
    expect(previewNotice({ read_error: null })).toBe('')
    expect(previewNotice(null)).toBe('')
  })
})

describe('fileCountLabel', () => {
  it('PDF 取最大页码 + 落库块数', () => {
    const blocks = [{ anchor: page(5), text: 'a' }, { anchor: page(42), text: 'b' }]
    expect(fileCountLabel('pdf', blocks, 3)).toEqual({ label: '页数', value: '42 页 · 3 个内容片段' })
  })

  it('表格显示表数,不再错标成「行数」', () => {
    const blocks = [
      { anchor: { kind: 'cell', sheet: '评测汇总', cell: 'A1' }, text: 'a' },
      { anchor: { kind: 'cell', sheet: '原始数据', cell: 'A1' }, text: 'b' },
    ]
    expect(fileCountLabel('xlsx', blocks, 6)).toEqual({ label: '表', value: '2 张表 · 6 个内容片段' })
  })

  it('未转写的真实形状(空媒体块 + 0–0 提示)显示 0 段', () => {
    // 抽取器真实输出:媒体块文本为空、锚点占位 0–60000;再加一条 0–0 的提示段落
    const blocks = [
      { anchor: time(0, 60_000), text: '' },
      { anchor: time(0, 0), text: '音视频未做转写(开启 [extract] transcribe_enabled 可转写)' },
    ]
    expect(fileCountLabel('m4a', blocks, 2)).toEqual({ label: '转写', value: '0 段 · 2 个内容片段' })
  })

  it('转写成功但只有一个整篇块时显示「整篇」,不是「0 段」', () => {
    const blocks = [{ anchor: time(0, 60_000), text: '整篇转写文本' }]
    expect(fileCountLabel('m4a', blocks, 1)).toEqual({ label: '转写', value: '整篇 · 1 个内容片段' })
  })

  it('缺 end_ms 的逐句块仍算一段(与字幕导出口径一致)', () => {
    const blocks = [
      { anchor: { kind: 'time', start_ms: 31_000 }, text: '第一句' },
      { anchor: { kind: 'time', start_ms: 35_000 }, text: '第二句' },
    ]
    expect(fileCountLabel('m4a', blocks, 2)).toEqual({ label: '转写', value: '2 段 · 2 个内容片段' })
  })

  it('逐句锚点的音视频按段数计数', () => {
    const blocks = [
      { anchor: time(31_000, 32_000), text: '第一句' },
      { anchor: time(32_000, 33_000), text: '第二句' },
    ]
    expect(fileCountLabel('m4a', blocks, 2)).toEqual({ label: '转写', value: '2 段 · 2 个内容片段' })
  })

  it('幻灯片按页数算', () => {
    const blocks = [{ anchor: slide(3), text: 'a' }, { anchor: slide(26), text: 'b' }]
    expect(fileCountLabel('pptx', blocks, 2)).toEqual({ label: '页数', value: '26 页 · 2 个内容片段' })
  })

  it('没有锚点时只给块数,标签留空(前端不显示这一行)', () => {
    expect(fileCountLabel('png', [{ anchor: null, text: 'a' }], 1)).toEqual({ label: '', value: '1 个内容片段' })
  })
})
