// 波形计算(音频波形):分桶、多声道合并、归一化、时间文案。
import { describe, expect, it } from 'vitest'
import {
  clampPosition,
  clockText,
  computePeaks,
  mergeChannels,
  nextPosition,
  normalizePeaks,
} from './waveform'

const ramp = (count: number) => Float32Array.from({ length: count }, (_, index) => index / count)

describe('computePeaks', () => {
  it('每个桶取绝对值的峰值', () => {
    const samples = Float32Array.from([0, -1, 0.5, 0.25, -0.75, 0])
    // 6 个样本分 3 桶(每桶 2 个):[0, -1] / [0.5, 0.25] / [-0.75, 0]
    expect(computePeaks(samples, 3)).toEqual([1, 0.5, 0.75])
  })

  it('桶数比样本多时也能给出固定长度,不会越界', () => {
    const peaks = computePeaks(Float32Array.from([0.5]), 4)
    expect(peaks).toHaveLength(4)
    expect(peaks.every((value) => value >= 0 && value <= 0.5)).toBe(true)
    expect(peaks.some((value) => value === 0.5)).toBe(true)
  })

  it('空采样返回全 0 而不是空数组', () => {
    expect(computePeaks(new Float32Array(0), 5)).toEqual([0, 0, 0, 0, 0])
  })

  it('桶数非法时至少给一个桶', () => {
    expect(computePeaks(ramp(10), 0)).toHaveLength(1)
  })
})

describe('mergeChannels', () => {
  it('多声道取每桶最大值', () => {
    const left = Float32Array.from([1, 0, 0, 0])
    const right = Float32Array.from([0, 0, 0.5, 0])
    expect(mergeChannels([left, right], 2)).toEqual([1, 0.5])
  })

  it('没有声道时返回全 0', () => {
    expect(mergeChannels([], 3)).toEqual([0, 0, 0])
  })
})

describe('normalizePeaks', () => {
  it('按最大值缩放到 0..1', () => {
    expect(normalizePeaks([0.5, 1, 0.25])).toEqual([0.5, 1, 0.25])
    expect(normalizePeaks([2, 4])).toEqual([0.5, 1])
  })

  it('全静音时保持全 0(不把噪声放大成满格)', () => {
    expect(normalizePeaks([0, 0, 0])).toEqual([0, 0, 0])
  })
})

describe('clockText', () => {
  it('分:秒,超过一小时带小时', () => {
    expect(clockText(0)).toBe('00:00')
    expect(clockText(90_000)).toBe('01:30')
    expect(clockText(3_600_000)).toBe('1:00:00')
    // 负数(脏数据)按 0 处理
    expect(clockText(-5)).toBe('00:00')
  })
})

describe('nextPosition', () => {
  it('左右箭头各走 5%,并夹在 0..时长之间', () => {
    expect(nextPosition('ArrowRight', 0, 100_000)).toBe(5_000)
    expect(nextPosition('ArrowLeft', 5_000, 100_000)).toBe(0)
    expect(nextPosition('ArrowLeft', 0, 100_000)).toBe(0)
    expect(nextPosition('ArrowRight', 99_000, 100_000)).toBe(100_000)
  })

  it('Home / End 到两端,其它键不动', () => {
    expect(nextPosition('Home', 42_000, 100_000)).toBe(0)
    expect(nextPosition('End', 42_000, 100_000)).toBe(100_000)
    expect(nextPosition('a', 42_000, 100_000)).toBe(42_000)
  })

  it('时长未知时返回 0', () => {
    expect(nextPosition('ArrowRight', 5_000, 0)).toBe(0)
  })

  it('位置越界时先夹住再步进', () => {
    expect(nextPosition('ArrowRight', 200_000, 100_000)).toBe(100_000)
  })
})

describe('clampPosition', () => {
  it('夹在 0..时长之间', () => {
    expect(clampPosition(61_000, 60_000)).toBe(60_000)
    expect(clampPosition(-5, 60_000)).toBe(0)
    expect(clampPosition(1_500.6, 60_000)).toBe(1_501)
  })

  it('时长未知(0 / NaN)时归零,不产生越界的 aria 值', () => {
    expect(clampPosition(30_000, 0)).toBe(0)
    expect(clampPosition(30_000, Number.NaN)).toBe(0)
  })

  it('非有限位置归零', () => {
    expect(clampPosition(Number.NaN, 60_000)).toBe(0)
  })
})
