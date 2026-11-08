// DocViewer(预览 文件预览)的组件测试。
//
// 覆盖质量检查点名的几处:命中 × {标题 / 表格 / 段落 / 跨段}、缩略图窗口、缩放循环、
// 幻灯片标题 / 要点 / 备注(含抽取器同形的「一页一个段落」)、以及真实抽取器形状下不丢内容。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DocViewer from './DocViewer.vue'

type Block = { anchor: Record<string, unknown> | null; kind: string; text: string }
type Chunk = {
  id: string
  ordinal: number
  anchor: Record<string, unknown> | null
  start_line: number | null
  end_line: number | null
  title: string | null
  text: string
}

const block = (kind: string, text: string, anchor: Record<string, unknown> | null): Block => ({ kind, text, anchor })
const chunk = (id: string, anchor: Record<string, unknown> | null, text: string): Chunk => ({
  id,
  ordinal: 1,
  anchor,
  start_line: null,
  end_line: null,
  title: null,
  text,
})
const page = (number: number) => ({ kind: 'page', page: number })
const slide = (number: number) => ({ kind: 'slide', slide: number })
const time = (start: number, end: number) => ({ kind: 'time', start_ms: start, end_ms: end })

function mountViewer(props: Record<string, unknown>) {
  return mount(DocViewer, { props: { format: 'pdf', blocks: [], chunks: [], highlight: null, ...props } })
}

describe('DocViewer · PDF 命中高亮', () => {
  const blocks = [
    block('heading', '3.2 混合检索与倒数排名融合', page(7)),
    block('paragraph', '稠密向量检索擅长语义近似,但对专有名词与代码标识符的召回不稳定。', page(7)),
    block('table', 'k | 20 | 60 | 100\nnDCG | 0.412 | 0.438 | 0.431', page(7)),
  ]

  it('命中标题时标题有高亮(回归:重写版曾丢掉标题 / 表格的高亮)', () => {
    const wrapper = mountViewer({
      blocks,
      chunks: [chunk('c1', page(7), '3.2 混合检索与倒数排名融合')],
      highlight: 'c1',
    })
    expect(wrapper.find('h3.kb-dv-h.kb-dv-hl').exists()).toBe(true)
  })

  it('命中表格时表格有高亮', () => {
    const wrapper = mountViewer({
      blocks,
      chunks: [chunk('c2', page(7), 'k | 20 | 60 | 100\nnDCG | 0.412 | 0.438 | 0.431')],
      highlight: 'c2',
    })
    expect(wrapper.find('table.kb-dv-tbl.kb-dv-hl').exists()).toBe(true)
  })

  it('命中段落时只框住那一句', () => {
    const sentence = '但对专有名词与代码标识符的召回不稳定。'
    const wrapper = mountViewer({
      blocks,
      chunks: [chunk('c3', page(7), sentence)],
      highlight: 'c3',
    })
    const spans = wrapper.findAll('p.kb-dv-p span')
    expect(spans.length).toBe(2)
    expect(spans[0]!.text()).toBe('稠密向量检索擅长语义近似,')
    expect(spans[1]!.classes()).toContain('kb-dv-hl')
    expect(spans[1]!.text()).toBe(sentence)
  })

  it('命中块以很短的块开头(前缀跨块)时,反方向匹配仍能亮', () => {
    const wrapper = mountViewer({
      blocks: [block('heading', '概述', page(1)), block('paragraph', '这一段讲 RRF 与重排。', page(1))],
      chunks: [chunk('c5', page(1), '概述这一段讲 RRF 与重排。')],
      highlight: 'c5',
    })
    expect(wrapper.findAll('.kb-dv-hl').length).toBeGreaterThan(0)
  })

  it('块跨两段、切不开时整段高亮(退化方向不丢高亮)', () => {
    const wrapper = mountViewer({
      blocks: [block('paragraph', '第一段讲 RRF。', page(7)), block('paragraph', '第二段讲重排。', page(7))],
      chunks: [chunk('c4', page(7), '第一段讲 RRF。第二段讲重排。')],
      highlight: 'c4',
    })
    expect(wrapper.findAll('.kb-dv-hl').length).toBeGreaterThan(0)
  })
})

describe('DocViewer · PDF 缩略图与缩放', () => {
  // 1…20 页全给:±3 与 ±5 才区分得出来
  const blocks = Array.from({ length: 20 }, (_, at) => block('paragraph', `第 ${at + 1} 页的正文`, page(at + 1)))

  it('缩略图只显示当前页前后各 3 页(按页码,不按出现顺序)', () => {
    const wrapper = mountViewer({
      blocks,
      chunks: [chunk('c', page(10), '第 10 页的正文')],
      highlight: 'c',
    })
    const labels = wrapper.findAll('.kb-dv-thumb-no').map((node) => node.text())
    expect(labels).toEqual(['7', '8', '9', '10', '11', '12', '13'])
  })

  it('缩放按 110 → 125 → 150 → 90 → 100 循环,纸面宽度跟着变', async () => {
    const wrapper = mountViewer({ blocks, chunks: [chunk('c', page(7), '第 7 页的正文')], highlight: 'c' })
    const paper = () => wrapper.find('.kb-dv-paper').attributes('style') ?? ''
    expect(paper()).toContain('width: 470px')
    for (const [zoom, width] of [
      [125, 534],
      [150, 641],
      [90, 384],
      [100, 427],
      [110, 470],
    ] as const) {
      await wrapper.find('.kb-dv-zoom').trigger('click')
      expect(wrapper.find('.kb-dv-zoom').text()).toBe(`${zoom}%`)
      expect(paper()).toContain(`width: ${width}px`)
    }
  })

  it('缩放按钮的无障碍名字带当前值', () => {
    const wrapper = mountViewer({ blocks, chunks: [], highlight: null })
    expect(wrapper.find('.kb-dv-zoom').attributes('aria-label')).toContain('110')
  })
})

describe('DocViewer · 幻灯片', () => {
  it('有标题块时:标题之外的块(含其余标题)都进要点,备注单独成卡', () => {
    const blocks = [
      block('heading', '多格式解析与编辑', slide(3)),
      block('heading', 'Q4 目标', slide(3)),
      block('paragraph', '批次 1 · PDF / Office', slide(3)),
      block('paragraph', '备注:先讲批次 1 的收益。', slide(3)),
      block('paragraph', '备注:再讲 OCR。', slide(3)),
    ]
    const wrapper = mountViewer({ format: 'pptx', blocks, chunks: [], highlight: null })
    expect(wrapper.find('.kb-dv-slide-title').text()).toBe('多格式解析与编辑')
    const points = wrapper.findAll('.kb-dv-slide-cell').map((node) => node.text())
    expect(points).toEqual(['Q4 目标', '批次 1 · PDF / Office'])
    expect(wrapper.find('.kb-dv-remark').text()).toBe('先讲批次 1 的收益。\n再讲 OCR。')
  })

  it('一页 9 行(真实 deck 常态)时 8 张要点卡都在,没有被丢掉', () => {
    const lines = ['标题', '要点 1', '要点 2', '要点 3', '要点 4', '要点 5', '要点 6', '要点 7', '要点 8']
    const wrapper = mountViewer({
      format: 'pptx',
      blocks: [block('paragraph', lines.join('\n'), slide(3))],
      chunks: [],
      highlight: null,
    })
    expect(wrapper.find('.kb-dv-slide-title').text()).toBe('标题')
    expect(wrapper.findAll('.kb-dv-slide-cell')).toHaveLength(8)
  })

  it('首块多行时,后续多行块也按行拆', () => {
    const wrapper = mountViewer({
      format: 'pptx',
      blocks: [
        block('paragraph', '标题甲\n要点1\n要点2', slide(3)),
        block('paragraph', '第二块\n要点3', slide(3)),
      ],
      chunks: [],
      highlight: null,
    })
    expect(wrapper.find('.kb-dv-slide-title').text()).toBe('标题甲')
    expect(wrapper.findAll('.kb-dv-slide-cell').map((node) => node.text())).toEqual([
      '要点1',
      '要点2',
      '第二块',
      '要点3',
    ])
  })

  it('抽取器同形(一页只有一个段落块):按行拆成标题 + 要点', () => {
    const wrapper = mountViewer({
      format: 'pptx',
      blocks: [block('paragraph', '多格式解析与编辑\n批次 1 · PDF / Office\n批次 2 · OCR', slide(3))],
      chunks: [],
      highlight: null,
    })
    expect(wrapper.find('.kb-dv-slide-title').text()).toBe('多格式解析与编辑')
    expect(wrapper.findAll('.kb-dv-slide-cell').map((node) => node.text())).toEqual([
      '批次 1 · PDF / Office',
      '批次 2 · OCR',
    ])
  })
})

describe('DocViewer · 音视频', () => {
  it('逐段转写:每段一行、时间可点;占位锚点(0–60 秒)不显示成一段字幕', () => {
    const wrapper = mountViewer({
      format: 'm4a',
      blocks: [block('paragraph', '第一句', time(31_000, 32_000)), block('paragraph', '第二句', time(32_000, 33_000))],
      chunks: [],
      highlight: null,
    })
    expect(wrapper.findAll('.kb-dv-trow')).toHaveLength(2)
    expect(wrapper.find('.kb-dv-time').text()).toBe('00:31')
  })

  it('抽取器同形(整篇一个块 + 占位锚点):仍按一段显示,不崩', () => {
    const wrapper = mountViewer({
      format: 'm4a',
      blocks: [block('paragraph', '整篇转写文本', time(0, 60_000))],
      chunks: [],
      highlight: null,
    })
    expect(wrapper.findAll('.kb-dv-trow')).toHaveLength(1)
  })
})

describe('DocViewer · 表格', () => {
  it('多工作表按页签切,命中行按锚点 R2 高亮', () => {
    const blocks = [
      block('table', '模型 | nDCG\nbge-m3 | 0.438\ne5-large | 0.401', { kind: 'cell', sheet: '评测汇总', cell: 'A1:B3' }),
      block('table', 'query | hit\n混合检索 | 1', { kind: 'cell', sheet: '原始数据', cell: 'A1:B2' }),
    ]
    const wrapper = mountViewer({
      format: 'xlsx',
      blocks,
      chunks: [chunk('c', { kind: 'cell', sheet: '评测汇总', cell: 'R2' }, '模型=bge-m3; nDCG=0.438')],
      highlight: 'c',
    })
    expect(wrapper.findAll('.kb-dv-tab').map((node) => node.text())).toEqual(['评测汇总', '原始数据'])
    expect(wrapper.find('tr.is-hit').exists()).toBe(true)
  })
})
