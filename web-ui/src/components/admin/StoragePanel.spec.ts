// 存储用量面板:四种状态(加载 / 空 / 报错 / 无权限)、告警、排序筛选。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { StorageOverview, StorageRow } from '@/api/usage'

const storageOverview = vi.fn<() => Promise<StorageOverview>>()
vi.mock('@/api/usage', () => ({ storageOverview: () => storageOverview(), STORAGE_TOP_LIMIT: 100 }))
vi.mock('vue-router', () => ({ RouterLink: { name: 'RouterLink', props: ['to'], template: '<a class="router-link" :href="to"><slot /></a>' } }))

import StoragePanel from './StoragePanel.vue'
import { KbSelect } from '@kb-ui/index'

const GB = 1024 ** 3
const row = (id: string, name: string, totalGb: number, limitGb: number, extra: Partial<StorageRow> = {}): StorageRow => ({
  space_id: `sp_${id}`,
  owner_id: `usr_${id}`,
  username: id,
  display_name: name,
  sources_bytes: totalGb * GB,
  uploads_bytes: 0,
  vectors_bytes: 0,
  meta_bytes: 0,
  workspace_bytes: 0,
  total_bytes: totalGb * GB,
  measured_at: 1_000,
  limit_bytes: limitGb * GB,
  ...extra,
})
const overview = (top: StorageRow[], extra: Partial<StorageOverview> = {}): StorageOverview => ({
  disk: { free_gb: 200, reserve_gb: 30, paused: false, warn: false },
  totals: { measured_spaces: top.length, total_spaces: top.length, total_bytes: top.reduce((sum, item) => sum + item.total_bytes, 0), vectors_bytes: 0, oldest_measured_at: null },
  top,
  ...extra,
})
const apiError = (message: string, status: number) => Object.assign(new Error(message), { status })

const TOP = [row('amy', '艾米', 10, 100), row('bob', 'Bob', 95, 100), row('cat', 'Cat', 120, 100), row('dan', 'Dan', 400, 0)]
const names = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('[data-testid="rt-row"] .kb-su-owner b').map((el) => el.text())

// 注意要写成语句块:`mockReset` 返回的是 mock 函数本身,箭头函数表达式体会把它当成 beforeEach 的返回值,
// vitest 会把它当清理函数在用例结束后调用并 await —— 用例 1 里那个永不 resolve 的 Promise 因此把整个文件卡死,
// 「无权限」用例里被 reject 的 Promise 则让用例以那个错误失败。
beforeEach(() => {
  storageOverview.mockReset()
})

describe('StoragePanel · 四种状态', () => {
  it('加载中是骨架屏,不是「加载中…」文字', async () => {
    storageOverview.mockReturnValue(new Promise(() => undefined))
    const wrapper = mount(StoragePanel)
    expect(wrapper.find('[data-testid="admin-loading"]').exists()).toBe(true)
    expect(wrapper.find('.kb-skel').exists()).toBe(true)
  })

  it('有数据:按总占用倒序列出每个人', async () => {
    storageOverview.mockResolvedValue(overview(TOP))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    expect(names(wrapper)).toEqual(['Dan', 'Cat', 'Bob', '艾米'])
    expect(wrapper.find('[data-testid="admin-loading"]').exists()).toBe(false)
  })

  it('空:没有任何统计结果时说明原因并给「刷新」', async () => {
    storageOverview.mockResolvedValue(overview([]))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    expect(wrapper.text()).toContain('还没有统计到任何知识库的占用')
    expect(wrapper.text()).toContain('第一轮统计')
    expect(wrapper.text()).not.toContain('暂无数据')
    const refresh = wrapper.findAll('button').find((button) => button.text() === '刷新')
    expect(refresh).toBeTruthy()
  })

  it('报错:两句话 + 重试,重试成功后显示数据', async () => {
    storageOverview.mockRejectedValueOnce(apiError('存储统计没有启用', 503)).mockResolvedValueOnce(overview(TOP))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    const error = wrapper.find('[data-testid="admin-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('读取存储用量失败:存储统计没有启用')
    await error.find('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="admin-error"]').exists()).toBe(false)
    expect(names(wrapper)).toHaveLength(4)
    expect(storageOverview).toHaveBeenCalledTimes(2)
  })

  it('无权限:服务端 403 显示未开通的说明,没有重试按钮', async () => {
    storageOverview.mockRejectedValue(apiError('你的账号没有开通这个功能', 403))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    const box = wrapper.find('[data-testid="admin-forbidden"]')
    expect(box.text()).toContain('你的账号没有开通这个功能')
    expect(box.text()).toContain('请联系管理员')
    expect(box.find('button').exists()).toBe(false)
    expect(wrapper.find('[data-testid="admin-error"]').exists()).toBe(false)
  })
})

describe('StoragePanel · 告警', () => {
  it('超额和接近上限的人数写在提示里,不限额的人不算', async () => {
    storageOverview.mockResolvedValue(overview(TOP))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    const alert = wrapper.find('[data-testid="quota-alert"]')
    expect(alert.text()).toContain('1 位用户已超出存储配额')
    expect(alert.text()).toContain('1 位用户用了 90% 以上')
  })

  it('「只看这些人」只留下告警的人,再点回到全部', async () => {
    storageOverview.mockResolvedValue(overview(TOP))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    const toggle = () => wrapper.find('[data-testid="quota-alert"] button')
    await toggle().trigger('click')
    expect(names(wrapper)).toEqual(['Cat', 'Bob'])
    expect(toggle().text()).toBe('看全部')
    await toggle().trigger('click')
    expect(names(wrapper)).toHaveLength(4)
  })

  it('没有人接近上限时不出现告警条', async () => {
    storageOverview.mockResolvedValue(overview([row('amy', '艾米', 10, 100)]))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-alert"]').exists()).toBe(false)
  })

  it('磁盘剩余低于保留空间:红色告警,说明哪些操作不受影响', async () => {
    storageOverview.mockResolvedValue(overview(TOP, { disk: { free_gb: 12, reserve_gb: 30, paused: true, warn: true } }))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    const alert = wrapper.find('[data-testid="disk-alert"]')
    expect(alert.classes()).toContain('is-danger')
    expect(alert.text()).toContain('全站已经暂停上传')
    expect(alert.text()).toContain('剩余 12 GB')
    expect(alert.text()).toContain('不受影响')
  })

  it('只是预警(低于 2 倍保留空间):黄色告警,不说已暂停', async () => {
    storageOverview.mockResolvedValue(overview(TOP, { disk: { free_gb: 50, reserve_gb: 30, paused: false, warn: true } }))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    const alert = wrapper.find('[data-testid="disk-alert"]')
    expect(alert.classes()).toContain('is-warn')
    expect(alert.text()).not.toContain('暂停')
    expect(alert.text()).toContain('的 2 倍')
  })

  it('磁盘正常:没有磁盘告警', async () => {
    storageOverview.mockResolvedValue(overview(TOP))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    expect(wrapper.find('[data-testid="disk-alert"]').exists()).toBe(false)
  })
})

describe('StoragePanel · 筛选与排序', () => {
  it('按用户名或昵称搜索;没有结果时给「清除筛选」', async () => {
    storageOverview.mockResolvedValue(overview(TOP))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    await wrapper.find('input[aria-label="按用户名或昵称查找"]').setValue('bob')
    expect(names(wrapper)).toEqual(['Bob'])
    await wrapper.find('input[aria-label="按用户名或昵称查找"]').setValue('没有这个人')
    expect(wrapper.text()).toContain('没有符合条件的用户')
    const clear = wrapper.findAll('button').find((button) => button.text() === '清除筛选')!
    await clear.trigger('click')
    expect(names(wrapper)).toHaveLength(4)
  })

  it('换排序方式和方向', async () => {
    storageOverview.mockResolvedValue(overview(TOP))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    wrapper.findComponent(KbSelect).vm.$emit('update:modelValue', 'ratio')
    await flushPromises()
    // 使用率倒序:Cat 120% > Bob 95% > 艾米 10%,不限额的 Dan 最后
    expect(names(wrapper)).toEqual(['Cat', 'Bob', '艾米', 'Dan'])
    const direction = wrapper.findAll('button').find((button) => button.text() === '倒序')!
    await direction.trigger('click')
    expect(names(wrapper)).toEqual(['Dan', '艾米', 'Bob', 'Cat'])
  })

  it('榜单被截断时说明只列了多少个', async () => {
    storageOverview.mockResolvedValue(overview(TOP, { totals: { measured_spaces: 4, total_spaces: 128, total_bytes: 1, vectors_bytes: 0, oldest_measured_at: null } }))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    expect(wrapper.find('[data-testid="storage-truncated"]').text()).toBe('只列出占用最多的 4 个知识库,全站共 128 个。')
  })

  it('账号被删除的知识库有个说法,不显示空白或 null', async () => {
    storageOverview.mockResolvedValue(overview([row('gone', 'x', 1, 100, { username: null, display_name: null })]))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    expect(names(wrapper)).toEqual(['已删除的账号'])
    expect(wrapper.text()).not.toContain('null')
  })
})

describe('StoragePanel · 图表', () => {
  it('有数据时出现占用构成(环形图)和每人占用(横向条),环中间是合计', async () => {
    storageOverview.mockResolvedValue(overview(TOP))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    const charts = wrapper.find('[data-testid="storage-charts"]')
    expect(charts.exists()).toBe(true)
    expect(charts.find('.kb-donut').exists()).toBe(true)
    // 10 + 95 + 120 + 400 = 625 GB
    expect(charts.find('.kb-donut-value').text()).toBe('625 GB')
    expect(charts.findAll('.kb-donut-row')).toHaveLength(4)
    expect(charts.findAll('.kb-hbars-row')).toHaveLength(4)
  })

  it('横向条按占用倒序,超额的行标红,不限额的没有配额线', async () => {
    storageOverview.mockResolvedValue(overview(TOP))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    const rows = wrapper.findAll('[data-testid="storage-charts"] .kb-hbars-row')
    expect(rows.map((item) => item.find('.kb-hbars-label').text())).toEqual(['Dan@dan', 'Cat@cat', 'Bob@bob', '艾米@amy'])
    expect(rows.map((item) => item.classes().includes('is-over'))).toEqual([false, true, false, false])
    expect(rows.map((item) => item.find('.kb-hbars-limit').exists())).toEqual([false, true, true, true])
  })

  it('图不受下面的筛选影响:搜不到人时图仍在,表格才显示「没有符合条件」', async () => {
    storageOverview.mockResolvedValue(overview(TOP))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    await wrapper.find('input[aria-label="按用户名或昵称查找"]').setValue('查无此人')
    await flushPromises()
    expect(names(wrapper)).toEqual([])
    expect(wrapper.findAll('[data-testid="storage-charts"] .kb-hbars-row')).toHaveLength(4)
  })

  it('榜单被截断时,横向条下面说明还有多少没列出', async () => {
    storageOverview.mockResolvedValue(overview(TOP, { totals: { measured_spaces: 4, total_spaces: 128, total_bytes: 1, vectors_bytes: 0, oldest_measured_at: null } }))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    expect(wrapper.find('[data-testid="storage-charts"] .kb-hbars-note').text()).toContain('还有 124 个知识库没有列出')
  })

  it('没有任何统计结果时不画空图,只显示原来的空状态', async () => {
    storageOverview.mockResolvedValue(overview([]))
    const wrapper = mount(StoragePanel)
    await flushPromises()
    expect(wrapper.find('[data-testid="storage-charts"]').exists()).toBe(false)
  })
})
