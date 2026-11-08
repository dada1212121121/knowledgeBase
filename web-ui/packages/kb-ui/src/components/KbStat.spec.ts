// 指标卡:说明文字按状态着色,用对比度安全的「文字版」令牌(浅色主题下原始状态色看不清)。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KbStat from './KbStat.vue'

const deltaStyle = (tone: 'neutral' | 'success' | 'warning' | 'danger') =>
  mount(KbStat, { props: { label: '待处理', value: 2, delta: '有事等你处理', tone } }).get('.s').attributes('style') ?? ''

describe('KbStat 说明文字颜色', () => {
  it('警告 / 成功 / 危险各用自己的文字令牌', () => {
    expect(deltaStyle('warning')).toContain('--status-warning-text')
    expect(deltaStyle('success')).toContain('--status-success-text')
    expect(deltaStyle('danger')).toContain('--status-danger-text')
  })

  it('中性不着色(沿用次要文字色)', () => {
    expect(deltaStyle('neutral')).toBe('')
  })
})
