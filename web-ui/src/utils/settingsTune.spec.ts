import { describe, expect, it } from 'vitest'
import { applyOutcome, deltaText, mrrText, percent, tuneSummary, weightText, type TuneResult } from './settingsTune'

const base: TuneResult = { feedback: 128, matched: 121, overall_rate: 0.71, groups: [], suggestions: [], skipped: [] }

describe('数字文案', () => {
  it('百分比不带小数', () => {
    expect(percent(0.881)).toBe('88%')
    expect(percent(0)).toBe('0%')
    expect(percent(1)).toBe('100%')
  })

  it('得分三位小数;没有就写「—」', () => {
    expect(mrrText({ mrr: 0.9274 })).toBe('0.927')
    expect(mrrText({})).toBe('—')
    expect(mrrText(null)).toBe('—')
    expect(mrrText({ mrr: 0 })).toBe('0.000')
  })

  it('权重变化与调整幅度', () => {
    expect(weightText({ current: 1, suggested: 1.2 })).toBe('1.00 → 1.20')
    expect(deltaText(0.2)).toBe('+0.20')
    expect(deltaText(-0.05)).toBe('-0.05')
    expect(deltaText(0)).toBe('0.00')
  })

  it('概况一句话', () => {
    expect(tuneSummary(base)).toBe('反馈 128 条 · 能对上记录 121 条 · 全局有用率 71%')
  })
})

describe('applyOutcome', () => {
  it('预演(还没应用过):没有结果卡', () => {
    expect(applyOutcome(base)).toBeNull()
  })

  it('回滚:红色,明说是得分下降自动撤回,并带前后得分', () => {
    const outcome = applyOutcome({ ...base, applied: false, rolled_back: true, eval: { before: { mrr: 0.93 }, after: { mrr: 0.9 } } })!
    expect(outcome).toMatchObject({ tone: 'danger', label: '已回滚' })
    expect(outcome.detail).toBe('应用后评测得分下降,已自动撤回。评测得分 0.930 → 0.900')
  })

  it('已应用:绿色', () => {
    const outcome = applyOutcome({ ...base, applied: true, eval: { before: { mrr: 0.9 }, after: { mrr: 0.92 } } })!
    expect(outcome).toMatchObject({ tone: 'success', label: '已应用' })
    expect(outcome.detail).toContain('0.900 → 0.920')
  })

  it('没有变化:灰色', () => {
    expect(applyOutcome({ ...base, applied: false })).toMatchObject({ tone: 'neutral', label: '没有变化' })
  })

  it('评测没跑出得分(不编数):写「—」', () => {
    expect(applyOutcome({ ...base, applied: true, eval: { before: null, after: null } })!.detail).toContain('— → —')
  })
})
