// 堆叠柱图的无障碍结构(axe aria-prohibited-attr):每根柱的热区能聚焦、带名字,就必须有角色;
// 根节点不能是 role=img(img 的子孙在无障碍树里都是装饰,里面可聚焦的热区读屏读不到)。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KbBarChart from './KbBarChart.vue'

const props = {
  labels: ['10-23', '10-24', '10-25'],
  series: [
    { name: 'kb', color: 'red', values: [1, 2, 0] },
    { name: 'web', color: 'blue', values: [3, 0, 0] },
  ],
}

describe('KbBarChart(堆叠)', () => {
  it('根节点是 group 而不是 img,而且有名字', () => {
    const svg = mount(KbBarChart, { props }).find('svg')
    expect(svg.attributes('role')).toBe('group')
    expect(svg.attributes('aria-label')).toBeTruthy()
  })

  it('每列一个热区:可聚焦、有名字「日期 共 N 条」、有角色(没有角色的元素上不能放 aria-label)', () => {
    const hits = mount(KbBarChart, { props }).findAll('.kb-chart-hit')
    expect(hits.map((hit) => hit.attributes('aria-label'))).toEqual(['10-23 共 4 条', '10-24 共 2 条', '10-25 共 0 条'])
    for (const hit of hits) {
      expect(hit.attributes('role')).toBe('graphics-symbol')
      expect(hit.attributes('tabindex')).toBe('0')
    }
  })

  it('聚焦热区切换提示(键盘用户也看得到当天明细)', async () => {
    const wrapper = mount(KbBarChart, { props })
    await wrapper.findAll('.kb-chart-hit')[1]!.trigger('focus')
    expect(wrapper.find('.kb-chart-tip').text()).toContain('10-24')
  })
})
