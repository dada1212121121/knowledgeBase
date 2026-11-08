// 环形仪表:比例 → 弧长、阈值着色、读屏文字、入场。
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import KbGauge from './KbGauge.vue'

const arc = (wrapper: ReturnType<typeof mount>) => Number((wrapper.find('.kb-gauge-arc').attributes('style') ?? '').match(/stroke-dasharray:\s*([\d.]+)/)?.[1])
const FULL = 0.75 * 2 * Math.PI * 44

describe('KbGauge', () => {
  it('弧长 = 比例 × 270°;超过 1 画满、小于 0 当 0', async () => {
    const half = mount(KbGauge, { props: { value: 0.5, label: '处理器使用率' } })
    await nextTick()
    expect(arc(half)).toBeCloseTo(FULL * 0.5, 1)
    const over = mount(KbGauge, { props: { value: 1.4, label: '磁盘' } })
    await nextTick()
    expect(arc(over)).toBeCloseTo(FULL, 1)
    const under = mount(KbGauge, { props: { value: -0.2, label: '磁盘' } })
    await nextTick()
    expect(arc(under)).toBe(0)
    expect(over.attributes('aria-label')).toBe('磁盘:140%,接近上限')
  })

  it('阈值:80% 警告、90% 危险,文字里也写明(不只靠颜色);warn 给 null 就不分级', () => {
    expect(mount(KbGauge, { props: { value: 0.79, label: '内存' } }).classes()).toContain('is-ok')
    const warn = mount(KbGauge, { props: { value: 0.8, label: '内存' } })
    expect(warn.classes()).toContain('is-warn')
    expect(warn.attributes('aria-label')).toBe('内存:80%,偏高')
    const danger = mount(KbGauge, { props: { value: 0.93, label: '磁盘' } })
    expect(danger.classes()).toContain('is-danger')
    expect(danger.attributes('aria-label')).toContain('接近上限')
    expect(mount(KbGauge, { props: { value: 0.99, label: '占比', warn: null, danger: null } }).classes()).toContain('is-ok')
  })

  it('读屏文字包含名字、中间的大字和小字;自定义大字不走数字滚动', () => {
    const wrapper = mount(KbGauge, { props: { value: 0.61, label: '内存使用率', text: '38 GB', caption: '共 62 GB' } })
    expect(wrapper.attributes('role')).toBe('img')
    expect(wrapper.attributes('aria-label')).toBe('内存使用率:38 GB(共 62 GB)')
    expect(wrapper.find('.kb-gauge-value').text()).toBe('38 GB')
    expect(wrapper.find('.kb-gauge-svg').attributes('aria-hidden')).toBe('true')
  })

  it('比例不是数(读不到)时画空弧,大字写 —', () => {
    const wrapper = mount(KbGauge, { props: { value: Number.NaN, label: '处理器' } })
    expect(wrapper.find('.kb-gauge-value').text()).toBe('—')
    expect(arc(wrapper)).toBe(0)
  })
})
