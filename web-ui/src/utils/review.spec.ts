// 审核收件箱纯逻辑。
import { describe, expect, it } from 'vitest'
import { batchSummary, decisionText, isActionable, isLongBody, kindText, remaining, scoreText, scoreTone, stateText, stateTone } from './review'

describe('文案', () => {
  it('类型和状态用中文;不认识的原样显示,不丢信息', () => {
    expect(['decision', 'pitfall', 'howto', 'convention'].map(kindText)).toEqual(['决策', '坑', '做法', '约定'])
    expect(kindText('pattern')).toBe('pattern')
    expect(['pending', 'approved', 'revised', 'rejected', 'duplicate'].map(stateText)).toEqual(['待审', '已通过', '修订通过', '已驳回', '重复'])
    expect(stateText('weird')).toBe('weird')
  })
  it('状态颜色:待审黄、通过绿、驳回红、重复灰', () => {
    expect(['pending', 'approved', 'revised', 'rejected', 'duplicate'].map(stateTone)).toEqual(['warning', 'success', 'success', 'danger', 'neutral'])
  })
  it('AI 评分四舍五入成整数分;没有结论直说,不写 0 分', () => {
    expect(scoreText(0.864)).toBe('AI 86 分')
    expect(scoreText(0.865)).toBe('AI 87 分')
    expect(scoreText(null)).toBe('没有 AI 审核结论')
    expect(scoreText(0)).toBe('AI 0 分')
  })
  it('70 分是分界:以上有把握,以下和没有结论都提醒多看一眼', () => {
    expect([0.7, 0.69, 1, null].map(scoreTone)).toEqual(['success', 'warning', 'success', 'warning'])
  })
  it('AI 建议', () => {
    expect(['approve', 'revise', 'reject', null, 'x'].map(decisionText)).toEqual(['AI 建议通过', 'AI 建议修订', 'AI 建议驳回', '', ''])
  })
})

describe('isActionable / isLongBody', () => {
  it('待审和重复能审,其它只读', () => {
    expect(['pending', 'duplicate', 'approved', 'revised', 'rejected'].map(isActionable)).toEqual([true, true, false, false, false])
  })
  it('正文折叠:超过 180 字或 4 行', () => {
    expect(isLongBody('短')).toBe(false)
    expect(isLongBody('x'.repeat(180))).toBe(false)
    expect(isLongBody('x'.repeat(181))).toBe(true)
    expect(isLongBody('a\nb\nc\nd')).toBe(false)
    expect(isLongBody('a\nb\nc\nd\ne')).toBe(true)
  })
})

describe('batchSummary', () => {
  it('全部成功', () => {
    expect(batchSummary('通过', 3, 0)).toEqual({ text: '已通过 3 条', tone: 'success' })
  })
  it('部分成功:失败的条数和第一个原因都要说,不能只报成功', () => {
    expect(batchSummary('通过', 2, 1, '草稿已被处理')).toEqual({ text: '已通过 2 条,另有 1 条没成功(第一个失败原因:草稿已被处理)', tone: 'warning' })
    expect(batchSummary('驳回', 2, 1).text).toBe('已驳回 2 条,另有 1 条没成功')
  })
  it('全部失败', () => {
    expect(batchSummary('通过', 0, 3, 'x')).toEqual({ text: '3 条都没能通过(第一个失败原因:x)', tone: 'danger' })
  })
})

describe('remaining', () => {
  it('还有多少没显示', () => {
    expect(remaining(50, 20)).toBe(30)
    expect(remaining(20, 20)).toBe(0)
    expect(remaining(10, 20)).toBe(0)
  })
})
