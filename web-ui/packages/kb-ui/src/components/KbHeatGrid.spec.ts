// 行 × 列热力矩阵:分档、悬停文字、读屏摘要、空状态。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KbHeatGrid from './KbHeatGrid.vue'

const rows = ['周一', '周二']
const cols = ['0', '1', '2', '3']
const values = [
  [0, 4, 8, 1],
  [2, 0, 16, null],
]

describe('KbHeatGrid', () => {
  it('按表里的最大值分五档:0 单独一档,其余按占比 ≤25% / 50% / 75% / 以上', () => {
    const wrapper = mount(KbHeatGrid, { props: { rows, cols, values, label: '调用热力' } })
    const levels = wrapper.findAll('.kb-heatgrid-plot > i').map((cell) => Number(cell.attributes('data-level')))
    // 最大 16:0→0,4→1(25%),8→2(50%),1→1,2→1,0→0,16→4,null→0
    expect(levels).toEqual([0, 1, 2, 1, 1, 0, 4, 0])
  })

  it('悬停提示写「行 列:数量单位」,没有数据的格子没有提示', () => {
    const wrapper = mount(KbHeatGrid, { props: { rows, cols, values, label: '调用热力', unit: '次' } })
    const cells = wrapper.findAll('.kb-heatgrid-plot > i')
    expect(cells[2]!.attributes('title')).toBe('周一 2:8次')
    expect(cells[0]!.attributes('title')).toBeUndefined()
  })

  it('读屏摘要:总数和最忙的三个格子', () => {
    const wrapper = mount(KbHeatGrid, { props: { rows, cols, values, label: '调用热力' } })
    expect(wrapper.attributes('aria-label')).toBe('调用热力:共 31次,最多的是 周二 2(16次)、周一 2(8次)、周一 1(4次)')
    expect(wrapper.find('.kb-sr').text()).toBe(wrapper.attributes('aria-label'))
  })

  it('列标签超过 12 列时隔 3 列写一个', () => {
    const many = Array.from({ length: 24 }, (_, hour) => String(hour))
    const wrapper = mount(KbHeatGrid, { props: { rows: ['周一'], cols: many, values: [many.map(() => 1)], label: '调用热力' } })
    const shown = wrapper.findAll('.kb-heatgrid-col').map((cell) => cell.text()).filter(Boolean)
    expect(shown).toEqual(['0', '3', '6', '9', '12', '15', '18', '21'])
  })

  it('全是 0:写空状态,不画一片灰格子', () => {
    const wrapper = mount(KbHeatGrid, { props: { rows, cols, values: [[0, 0], [0, 0]], label: '调用热力', emptyText: '近 7 天没有调用' } })
    expect(wrapper.find('.kb-heatgrid-plot').exists()).toBe(false)
    expect(wrapper.text()).toContain('近 7 天没有调用')
    expect(wrapper.attributes('aria-label')).toBe('调用热力:近 7 天没有调用')
  })
})
