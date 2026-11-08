// 概览里的账号与存储:按功能点取数、取不到就不显示那一格。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const userList = vi.fn()
const storageOverview = vi.fn()
const features = new Set<string>()
vi.mock('@/utils/adminApi', () => ({ userList: (args: unknown) => userList(args) }))
vi.mock('@/api/usage', () => ({ storageOverview: (limit: number) => storageOverview(limit) }))
vi.mock('@/composables/useFeature', () => ({ useFeature: (id: string) => ({ value: features.has(id) }) }))
vi.mock('vue-router', () => ({ RouterLink: { name: 'RouterLink', props: ['to'], template: '<a class="router-link" :href="to"><slot /></a>' } }))

import OverviewAccounts from './OverviewAccounts.vue'

const GB = 1024 ** 3
const overview = (over = 0) => ({
  disk: { free_gb: 200, reserve_gb: 30, paused: false, warn: false },
  totals: { measured_spaces: 5, total_spaces: 6, total_bytes: 12 * GB, vectors_bytes: GB, oldest_measured_at: null },
  top: over ? [{ space_id: 'sp', owner_id: 'u', username: 'a', display_name: 'A', sources_bytes: 0, uploads_bytes: 0, vectors_bytes: 0, meta_bytes: 0, workspace_bytes: 0, total_bytes: 120 * GB, measured_at: 1, limit_bytes: 100 * GB }] : [],
})

beforeEach(() => {
  userList.mockReset()
  storageOverview.mockReset()
  features.clear()
})

describe('OverviewAccounts', () => {
  it('没有任何相关功能点:什么都不画,也不发请求', async () => {
    const wrapper = mount(OverviewAccounts)
    await flushPromises()
    expect(wrapper.find('[data-testid="overview-accounts"]').exists()).toBe(false)
    expect(userList).not.toHaveBeenCalled()
    expect(storageOverview).not.toHaveBeenCalled()
  })

  it('有用户管理和存储两个功能点:显示账号数、存储占用、磁盘剩余,和到详情的链接', async () => {
    features.add('sys.users').add('sys.ops')
    userList.mockImplementation(async (args: { status?: string }) => ({ users: [], total: args.status === 'disabled' ? 2 : 10, page: 1, page_size: 1 }))
    storageOverview.mockResolvedValue(overview(1))
    const wrapper = mount(OverviewAccounts)
    await flushPromises()
    const text = wrapper.text()
    // 指标卡的数字会从 0 滚到目标值(动画),所以这里只断言不会动的说明行
    expect(text).toContain('账号')
    expect(text).toContain('2 人已停用')
    expect(text).toContain('全站存储占用')
    expect(text).toContain('5 / 6 个知识库已统计')
    expect(text).toContain('1 人接近或超出存储配额')
    expect(userList).toHaveBeenCalledWith({ page_size: 1 })
    expect(userList).toHaveBeenCalledWith({ status: 'disabled', page_size: 1 })
    expect(wrapper.find('a.router-link').attributes('href')).toBe('/admin/usage')
  })

  it('只有存储功能点:没有「账号」那一格;存储取不到:那几格也不出现,不报错', async () => {
    features.add('sys.ops')
    storageOverview.mockRejectedValue(new Error('boom'))
    const wrapper = mount(OverviewAccounts)
    await flushPromises()
    expect(wrapper.find('[data-testid="overview-accounts"]').exists()).toBe(false)
    expect(userList).not.toHaveBeenCalled()
  })
})
