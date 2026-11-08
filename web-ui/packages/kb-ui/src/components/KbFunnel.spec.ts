// 漏斗:条长按占最大段的比例、主线段之间的转化率、旁路段不参与转化率、空状态。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KbFunnel from './KbFunnel.vue'

const stages = [
  { name: '排队', value: 200 },
  { name: '解析', value: 160 },
  { name: '向量化', value: 80 },
  { name: '失败', value: 20, tone: 'danger' as const },
]
const widths = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('.kb-funnel-track i').map((bar) => bar.attributes('style') ?? '')

describe('KbFunnel', () => {
  it('条长 = 这一段 ÷ 最大的一段;每段写名字和数量', () => {
    const wrapper = mount(KbFunnel, { props: { stages, label: '导入流水线' } })
    expect(widths(wrapper)[0]).toContain('width: 100%')
    expect(widths(wrapper)[1]).toContain('width: 80%')
    expect(widths(wrapper)[2]).toContain('width: 40%')
    expect(widths(wrapper)[3]).toContain('width: 10%')
    expect(wrapper.findAll('.kb-funnel-head').map((head) => head.text())).toEqual(['排队200', '解析160', '向量化80', '失败20'])
  })

  it('转化率只在主线段之间算(这一段 ÷ 上一个主线段);第一段和旁路段没有', () => {
    const wrapper = mount(KbFunnel, { props: { stages, label: '导入流水线' } })
    const rates = wrapper.findAll('.kb-funnel-row').map((row) => row.find('.kb-funnel-rate').exists() ? row.find('.kb-funnel-rate').text() : '')
    expect(rates).toEqual(['', '进入这一步的占 80%', '进入这一步的占 50%', ''])
  })

  it('失败段是危险色并带 is-danger;有数量的段至少画 1.5% 宽,看得见', () => {
    const wrapper = mount(KbFunnel, { props: { stages: [{ name: '完成', value: 100000 }, { name: '失败', value: 1, tone: 'danger' }], label: '流水线' } })
    expect(wrapper.findAll('.kb-funnel-row')[1]!.classes()).toContain('is-danger')
    expect(widths(wrapper)[1]).toContain('width: 1.5%')
    expect(widths(wrapper)[1]).toContain('var(--viz-6)')
  })

  it('全是 0 写空状态,读屏文字也说明', () => {
    const wrapper = mount(KbFunnel, { props: { stages: stages.map((stage) => ({ ...stage, value: 0 })), label: '导入流水线', emptyText: '队列是空的' } })
    expect(wrapper.find('.kb-funnel-list').exists()).toBe(false)
    expect(wrapper.text()).toContain('队列是空的')
    expect(wrapper.attributes('aria-label')).toBe('导入流水线:队列是空的')
  })
})
