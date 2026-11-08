// `toSrt` / `srtStamp` / `isPlaceholderAnchor` 的单测:
// 除了格式本身,重点是「抽取器真实形状」的两种输入必须导出空串(不能生成假字幕)。
import { describe, expect, it } from 'vitest'
import { isPlaceholderAnchor, srtStamp, toSrt } from './srt'

describe('srtStamp', () => {
  it('按 SRT 规范补零到 HH:MM:SS,mmm', () => {
    expect(srtStamp(0)).toBe('00:00:00,000')
    expect(srtStamp(1500)).toBe('00:00:01,500')
    expect(srtStamp(3_723_004)).toBe('01:02:03,004')
  })

  it('负数按 0 处理', () => {
    expect(srtStamp(-20)).toBe('00:00:00,000')
  })
})

describe('isPlaceholderAnchor', () => {
  it('整篇 0–60 秒与 0–0 的提示块都算占位', () => {
    expect(isPlaceholderAnchor({ kind: 'time', start_ms: 0, end_ms: 60_000 })).toBe(true)
    expect(isPlaceholderAnchor({ kind: 'time', start_ms: 0, end_ms: 0 })).toBe(true)
    expect(isPlaceholderAnchor({ kind: 'time', start_ms: 5000, end_ms: 4000 })).toBe(true)
  })

  it('真实分段不算占位', () => {
    expect(isPlaceholderAnchor({ kind: 'time', start_ms: 31_000, end_ms: 32_000 })).toBe(false)
    expect(isPlaceholderAnchor({ kind: 'time', start_ms: 0, end_ms: 3000 })).toBe(false)
  })

  it('没有时间锚点的一律算占位', () => {
    expect(isPlaceholderAnchor(null)).toBe(true)
    expect(isPlaceholderAnchor({ kind: 'line' })).toBe(true)
  })
})

describe('toSrt', () => {
  it('只导出带时间锚点的段,序号从 1 开始', () => {
    const text = toSrt([
      { text: '第一句', anchor: { kind: 'time', start_ms: 31_000, end_ms: 32_000 } },
      { text: '没有锚点', anchor: null },
      { text: '第二句', anchor: { kind: 'time', start_ms: 32_000, end_ms: 33_500 } },
    ])
    expect(text).toBe(
      '1\n00:00:31,000 --> 00:00:32,000\n第一句\n\n2\n00:00:32,000 --> 00:00:33,500\n第二句\n',
    )
  })

  it('缺 end_ms 时用下一段的开始时间兜底', () => {
    const text = toSrt([
      { text: '甲', anchor: { kind: 'time', start_ms: 1000 } },
      { text: '乙', anchor: { kind: 'time', start_ms: 4000, end_ms: 5000 } },
    ])
    expect(text.split('\n')[1]).toBe('00:00:01,000 --> 00:00:04,000')
  })

  it('最后一段缺 end_ms 时跳过,不推测时长', () => {
    const text = toSrt([
      { text: '甲', anchor: { kind: 'time', start_ms: 1000, end_ms: 2000 } },
      { text: '乙', anchor: { kind: 'time', start_ms: 3000 } },
    ])
    expect(text).not.toContain('乙')
    expect(text.trim().split('\n').slice(-1)[0]).toBe('甲')
  })

  it('乱序的块按开始时间排序', () => {
    const text = toSrt([
      { text: '后', anchor: { kind: 'time', start_ms: 9000, end_ms: 10_000 } },
      { text: '先', anchor: { kind: 'time', start_ms: 1000, end_ms: 2000 } },
    ])
    expect(text.indexOf('先')).toBeLessThan(text.indexOf('后'))
    expect(text.startsWith('1\n00:00:01,000')).toBe(true)
  })

  it('cue 文本里的空行折叠,不会把一条字幕截成两条', () => {
    const text = toSrt([
      { text: '甲\n\n乙', anchor: { kind: 'time', start_ms: 1000, end_ms: 2000 } },
      { text: '丙', anchor: { kind: 'time', start_ms: 2000, end_ms: 3000 } },
    ])
    expect(text).toContain('1\n00:00:01,000 --> 00:00:02,000\n甲\n乙\n')
    expect(text).toContain('\n2\n00:00:02,000 --> 00:00:03,000\n丙')
  })

  it('多段时第一段正好 0–60000 不算占位(只是一分钟长)', () => {
    const text = toSrt([
      { text: '第一分钟', anchor: { kind: 'time', start_ms: 0, end_ms: 60_000 } },
      { text: '第二分钟', anchor: { kind: 'time', start_ms: 60_000, end_ms: 120_000 } },
    ])
    expect(text).toContain('第一分钟')
    expect(text).toContain('第二分钟')
  })

  it('没有可导出的段时返回空串', () => {
    expect(toSrt([])).toBe('')
    expect(toSrt([{ text: '无锚点', anchor: { kind: 'line' } }])).toBe('')
    expect(toSrt([{ text: '   ', anchor: { kind: 'time', start_ms: 10, end_ms: 20 } }])).toBe('')
  })

  it('抽取器真实形状(已转写):整篇一个块 + 占位锚点 → 空串', () => {
    expect(
      toSrt([{ text: '这是一整段 52 分钟录音的完整转写文本……', anchor: { kind: 'time', start_ms: 0, end_ms: 60_000 } }]),
    ).toBe('')
  })

  it('抽取器真实形状(未转写):0–0 的提示段落 → 空串', () => {
    expect(
      toSrt([
        { text: '', anchor: { kind: 'time', start_ms: 0, end_ms: 0 } },
        { text: '音视频未做转写(开启 [extract] transcribe_enabled 可转写)', anchor: { kind: 'time', start_ms: 0, end_ms: 0 } },
      ]),
    ).toBe('')
  })
})
