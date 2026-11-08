// 监控图表的格式化:字节、速率、时长、百分比、时间刻度、环比、阈值。
import { describe, expect, it } from 'vitest'
import { deltaRatio, deltaText, formatBytes, formatDuration, formatPercent, formatRate, levelOf, timeGrain, timeLabel, timeLabels } from './chartFormat'

describe('formatBytes / formatRate', () => {
  it('按 1024 进位;10 以下留一位小数,其余取整;整数不写 .0', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB')
    expect(formatBytes(3.2 * 1024 ** 3)).toBe('3.2 GB')
    expect(formatBytes(5 * 1024 ** 5)).toBe('5120 TB')
  })
  it('负数和非数写 —', () => {
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatRate(2 * 1024 * 1024)).toBe('2 MB/s')
    expect(formatRate(-5)).toBe('—')
  })
})

describe('formatPercent', () => {
  it('比例写成百分数,超过 100% 不截断', () => {
    expect(formatPercent(0.634)).toBe('63%')
    expect(formatPercent(0.6347, 1)).toBe('63.5%')
    expect(formatPercent(1.2)).toBe('120%')
    expect(formatPercent(Number.NaN)).toBe('—')
  })
})

describe('formatDuration', () => {
  it('毫秒 / 秒 / 分 / 时 / 天', () => {
    expect(formatDuration(850)).toBe('850ms')
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(200_000)).toBe('3m 20s')
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m')
    expect(formatDuration(50 * 3_600_000)).toBe('2d 2h')
    expect(formatDuration(-1)).toBe('—')
  })
})

describe('时间刻度', () => {
  const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime()
  it('按跨度选粒度:3 小时内分钟、3 天内小时、更长按天', () => {
    expect(timeGrain(3_600_000)).toBe('minute')
    expect(timeGrain(24 * 3_600_000)).toBe('hour')
    expect(timeGrain(30 * 86_400_000)).toBe('day')
  })
  it('标签写法', () => {
    expect(timeLabel(at(11, 1, 14, 5), 'minute')).toBe('14:05')
    expect(timeLabel(at(11, 1, 14, 5), 'hour')).toBe('11-01 14:00')
    expect(timeLabel(at(11, 1, 14, 5), 'day')).toBe('11-01')
  })
  it('一组时间戳按首尾跨度统一粒度;空数组给空', () => {
    expect(timeLabels([at(11, 1, 14, 0), at(11, 1, 14, 10), at(11, 1, 14, 20)])).toEqual(['14:00', '14:10', '14:20'])
    expect(timeLabels([at(10, 1, 0), at(11, 1, 0)])).toEqual(['10-01', '11-01'])
    expect(timeLabels([])).toEqual([])
  })
})

describe('deltaRatio / deltaText / levelOf', () => {
  it('环比:上期为 0 或缺失给 null,不写无穷大', () => {
    expect(deltaRatio(120, 100)).toBeCloseTo(0.2)
    expect(deltaRatio(80, 100)).toBeCloseTo(-0.2)
    expect(deltaRatio(5, 0)).toBeNull()
    expect(deltaRatio(5, undefined)).toBeNull()
    expect(deltaRatio(5, null)).toBeNull()
  })
  it('文字:涨跌带箭头,不到 0.5% 算持平,null 不写', () => {
    expect(deltaText(0.2)).toBe('↑ 20%')
    expect(deltaText(-0.034)).toBe('↓ 3%')
    expect(deltaText(0.004)).toBe('持平')
    expect(deltaText(null)).toBe('')
  })
  it('阈值:80% 警告、90% 危险(含边界)', () => {
    expect(levelOf(0.79)).toBe('ok')
    expect(levelOf(0.8)).toBe('warn')
    expect(levelOf(0.9)).toBe('danger')
    expect(levelOf(Number.NaN)).toBe('ok')
  })
})
