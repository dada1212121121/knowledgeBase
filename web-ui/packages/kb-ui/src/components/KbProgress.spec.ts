// 进度条的可访问名称(axe aria-progressbar-name):role=progressbar 必须有名字。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KbProgress from './KbProgress.vue'

describe('KbProgress 的可访问名称', () => {
  it('调用方传 label,名称就是它', () => {
    const bar = mount(KbProgress, { props: { value: 40, label: '总体进度' } }).find('[role=progressbar]')
    expect(bar.attributes('aria-label')).toBe('总体进度')
    expect(bar.attributes('aria-valuenow')).toBe('40')
  })

  it('没传 label 也有名字(兜底「进度」),不会出现没有名字的进度条', () => {
    const bar = mount(KbProgress, { props: { value: 0 } }).find('[role=progressbar]')
    expect(bar.attributes('aria-label')).toBe('进度')
  })

  it('宽度仍按 value 夹在 0–100 之间(名称改动没带坏渲染)', () => {
    expect(mount(KbProgress, { props: { value: 150 } }).find('i').attributes('style')).toContain('width: 100%')
    expect(mount(KbProgress, { props: { value: -5 } }).find('i').attributes('style')).toContain('width: 0%')
  })
})
