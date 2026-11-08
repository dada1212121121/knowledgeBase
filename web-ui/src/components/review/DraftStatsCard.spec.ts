// 审核结果:通过率只算有结论的,待审不算;没有候选笔记写说明。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DraftStatsCard from './DraftStatsCard.vue'

describe('DraftStatsCard', () => {
  it('通过率 = 已通过 /(已通过 + 驳回 + 重复),待审不算', () => {
    const wrapper = mount(DraftStatsCard, { props: { counts: { pending: 4, approved: 6, rejected: 2, duplicate: 2 } } })
    const text = wrapper.text()
    expect(text).toContain('共 14 条候选笔记')
    expect(text).toContain('4 条待审')
    expect(text).toContain('通过率 60%')
    expect(text).toContain('已通过')
    expect(text).toContain('已驳回')
  })

  it('还没有人审过时不写通过率的数字', () => {
    const text = mount(DraftStatsCard, { props: { counts: { pending: 3 } } }).text()
    expect(text).toContain('还没有审过的')
    expect(text).not.toContain('通过率')
  })

  it('没有候选笔记写说明;加载中不写说明', () => {
    expect(mount(DraftStatsCard, { props: { counts: {} } }).text()).toContain('还没有候选笔记')
    expect(mount(DraftStatsCard, { props: { counts: {}, loading: true } }).text()).not.toContain('还没有候选笔记')
  })
})
