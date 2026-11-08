// 本机资源卡:有几个数画几个仪表,全读不到写一句话;链接指向系统状态的资源页签。
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-router', () => ({ RouterLink: { props: ['to'], template: '<a class="router-link" :data-to="JSON.stringify(to)"><slot /></a>' } }))

import ResourceGaugesCard from './ResourceGaugesCard.vue'

describe('ResourceGaugesCard', () => {
  it('三个仪表各带自己的小字,链接去系统状态的资源页签', () => {
    const wrapper = mount(ResourceGaugesCard, { props: { cpu: 0.3, memory: 0.85, disk: 0.93, cores: 16, diskFreeGb: 41 } })
    const labels = wrapper.findAll('[role=img]').map((item) => item.attributes('aria-label'))
    expect(labels).toEqual(['处理器使用率:30%(16 核)', '内存使用率:85%(内存),偏高', '磁盘使用率:93%(剩 41 GB),接近上限'])
    expect(JSON.parse(wrapper.find('.router-link').attributes('data-to')!)).toMatchObject({ query: { tab: 'resources' } })
  })

  it('读不到的那个不画;全读不到写一句话', () => {
    expect(mount(ResourceGaugesCard, { props: { cpu: 0.3, memory: null } }).findAll('[role=img]')).toHaveLength(1)
    const none = mount(ResourceGaugesCard, { props: {} })
    expect(none.findAll('[role=img]')).toHaveLength(0)
    expect(none.text()).toContain('没能读到本机资源')
  })
})
