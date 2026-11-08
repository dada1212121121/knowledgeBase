// 图表卡骨架:标题与结论、范围切换、三种非正常状态、重试。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KbChartCard from './KbChartCard.vue'

const ranges = [
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
]
const slots = { default: '<div class="plot">图</div>', footer: '<span class="note">每 10 分钟一个点</span>' }

describe('KbChartCard', () => {
  it('正常:标题、结论、图、脚注都在;标题关联了卡片(读屏念得出名字)', () => {
    const wrapper = mount(KbChartCard, { props: { title: '任务吞吐', headline: '近 24 小时完成 4,224 个,失败 0' }, slots })
    expect(wrapper.find('.ch').text()).toBe('任务吞吐')
    expect(wrapper.find('[data-testid=chart-headline]').text()).toBe('近 24 小时完成 4,224 个,失败 0')
    expect(wrapper.find('.plot').exists()).toBe(true)
    expect(wrapper.find('.note').exists()).toBe(true)
    const labelledby = wrapper.find('section').attributes('aria-labelledby')!
    expect(wrapper.find(`#${labelledby}`).text()).toBe('任务吞吐')
  })

  it('范围切换:换段时发 update:range', async () => {
    const wrapper = mount(KbChartCard, { props: { title: '任务吞吐', range: '24h', ranges }, slots })
    const tabs = wrapper.findAll('[role=tab]')
    expect(tabs.map((tab) => tab.text())).toEqual(['24 小时', '7 天'])
    await tabs[1]!.trigger('click')
    expect(wrapper.emitted('update:range')?.[0]).toEqual(['7d'])
  })

  it('加载中:骨架屏,没有图、没有结论、没有脚注,卡片标成忙碌', () => {
    const wrapper = mount(KbChartCard, { props: { title: '任务吞吐', headline: '不该出现', state: 'loading' }, slots })
    expect(wrapper.find('[role=status][aria-busy=true]').exists()).toBe(true)
    expect(wrapper.find('.plot').exists()).toBe(false)
    expect(wrapper.find('[data-testid=chart-headline]').exists()).toBe(false)
    expect(wrapper.find('.note').exists()).toBe(false)
    expect(wrapper.find('section').attributes('aria-busy')).toBe('true')
  })

  it('空:写那一句说明,不画图', () => {
    const wrapper = mount(KbChartCard, { props: { title: '任务吞吐', state: 'empty', emptyText: '还没有任务,有了之后这里会显示吞吐' }, slots })
    expect(wrapper.text()).toContain('还没有任务,有了之后这里会显示吞吐')
    expect(wrapper.find('.plot').exists()).toBe(false)
  })

  it('出错:一行原因加重试,点重试发 retry', async () => {
    const wrapper = mount(KbChartCard, { props: { title: '任务吞吐', state: 'error', errorText: '读取任务统计失败' }, slots })
    expect(wrapper.find('[role=alert]').text()).toContain('读取任务统计失败')
    await wrapper.find('[role=alert] button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('三种状态下图区高度不跳:都有同一个最小高度', () => {
    const heights = (['ready', 'loading', 'empty', 'error'] as const).map((state) => mount(KbChartCard, { props: { title: 't', state, minHeight: 200 }, slots }).find('.kb-ccard-body').attributes('style'))
    expect(new Set(heights).size).toBe(1)
    expect(heights[0]).toContain('min-height: 200px')
  })
})
