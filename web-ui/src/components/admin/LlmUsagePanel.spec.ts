// AI 用量排行:四种状态、按日期取数、超额标红、日期选择的边界。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { setSiteTimezone } from '@/utils/time'
import type { LlmUsageOverview, LlmUsageRow } from '@/api/usage'

const llmUsageOverview = vi.fn<(day?: string) => Promise<LlmUsageOverview>>()
vi.mock('@/api/usage', () => ({ llmUsageOverview: (day?: string) => llmUsageOverview(day), STORAGE_TOP_LIMIT: 100 }))

import LlmUsagePanel from './LlmUsagePanel.vue'

const row = (id: string, name: string | null, tokens: number, limit: number): LlmUsageRow => ({
  user_id: `usr_${id}`,
  username: name ? id : null,
  display_name: name,
  calls: 3,
  input_tokens: Math.round(tokens * 0.8),
  output_tokens: Math.round(tokens * 0.2),
  tokens,
  limit,
})
const overview = (ranking: LlmUsageRow[], day = '2026-10-20'): LlmUsageOverview => ({ day, total_tokens: ranking.reduce((sum, item) => sum + item.tokens, 0), ranking })
const apiError = (message: string, status: number) => Object.assign(new Error(message), { status })

beforeEach(() => {
  llmUsageOverview.mockReset()
})

describe('LlmUsagePanel', () => {
  it('加载中是骨架屏', () => {
    llmUsageOverview.mockReturnValue(new Promise(() => undefined))
    const wrapper = mount(LlmUsagePanel)
    expect(wrapper.find('[data-testid="admin-loading"]').exists()).toBe(true)
  })

  it('列出每个人,超额的标「已超额」、接近上限的标「接近上限」,并汇总需要关注的人数', async () => {
    llmUsageOverview.mockResolvedValue(overview([row('zs', '张三', 230_000, 200_000), row('ly', '林一', 190_000, 200_000), row('al', 'Alice', 20_000, 200_000), row('ww', '王五', 900_000, 0)]))
    const wrapper = mount(LlmUsagePanel)
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('张三')
    expect(text).toContain('已超额')
    expect(text).toContain('接近上限')
    expect(text).toContain('1 人超额 · 1 人接近上限')
    // 不限额的人:文案是「不限」,不显示超额
    const rows = wrapper.findAll('[data-testid="rt-row"]')
    const wang = rows.find((item) => item.text().includes('王五'))!
    expect(wang.text()).toContain('不限')
    expect(wang.text()).not.toContain('已超额')
    expect(wrapper.find('[data-testid="llm-alert"]').exists()).toBe(true)
  })

  it('账号已被删除的人显示「已删除的账号」,不显示空白', async () => {
    llmUsageOverview.mockResolvedValue(overview([row('gone', null, 1_500, 200_000)]))
    const wrapper = mount(LlmUsagePanel)
    await flushPromises()
    expect(wrapper.text()).toContain('已删除的账号')
  })

  it('空:这一天没有人用过,说明原因并给「回到今天」', async () => {
    llmUsageOverview.mockResolvedValue(overview([]))
    const wrapper = mount(LlmUsagePanel)
    await flushPromises()
    expect(wrapper.find('[data-testid="llm-empty"]').text()).toContain('没有人用过内置模型')
    expect(wrapper.text()).not.toContain('暂无数据')
  })

  it('报错:说明 + 重试;无权限:不给重试', async () => {
    llmUsageOverview.mockRejectedValueOnce(apiError('统计没有启用', 503)).mockResolvedValueOnce(overview([row('al', 'Alice', 10, 100)]))
    const wrapper = mount(LlmUsagePanel)
    await flushPromises()
    expect(wrapper.find('[data-testid="admin-error"]').exists()).toBe(true)
    await wrapper.find('[data-testid="admin-error"] button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Alice')

    llmUsageOverview.mockReset()
    llmUsageOverview.mockRejectedValue(apiError('没有权限', 403))
    const denied = mount(LlmUsagePanel)
    await flushPromises()
    expect(denied.find('[data-testid="admin-forbidden"]').exists()).toBe(true)
    expect(denied.find('[data-testid="admin-forbidden"] button').exists()).toBe(false)
  })

  it('选日期:带着那天的 UTC 日期重新取数;「前一天」「后一天」按日历挪;不合法的日期不发请求', async () => {
    llmUsageOverview.mockResolvedValue(overview([row('al', 'Alice', 10, 100)]))
    const wrapper = mount(LlmUsagePanel)
    await flushPromises()
    expect(llmUsageOverview).toHaveBeenLastCalledWith(undefined)
    await wrapper.find('[data-testid="llm-prev"]').trigger('click')
    await flushPromises()
    expect(llmUsageOverview).toHaveBeenLastCalledWith('2026-10-19')

    const calls = llmUsageOverview.mock.calls.length
    const input = wrapper.find('[data-testid="llm-day"]')
    ;(input.element as HTMLInputElement).value = '2026-02-30'
    await input.trigger('change')
    await flushPromises()
    expect(llmUsageOverview.mock.calls.length).toBe(calls)
    expect(wrapper.find('[data-testid="llm-day-error"]').exists()).toBe(true)
  })

  it('日期提示说明按站点时区计、每天 0 点重置', async () => {
    llmUsageOverview.mockResolvedValue(overview([]))
    const wrapper = mount(LlmUsagePanel)
    await flushPromises()
    const hint = wrapper.find('[data-testid="llm-day-hint"]').text()
    expect(hint).toContain('站点时区')
    expect(hint).toContain('每天 0 点重置')
  })

  it('界面上不写 token,额度的说法按术语表', async () => {
    llmUsageOverview.mockResolvedValue(overview([row('zs', '张三', 20_000, 200_000)]))
    const wrapper = mount(LlmUsagePanel)
    await flushPromises()
    expect(wrapper.text()).not.toMatch(/token/i)
    expect(wrapper.text()).toContain('今日额度')
    expect(wrapper.text()).toContain('榜内合计用量')
    expect(wrapper.text()).toContain('两者之和就是已用额度')
  })

  it('站点时区改了,提示跟着变,不受访问者电脑时区影响', async () => {
    llmUsageOverview.mockResolvedValue(overview([]))
    const wrapper = mount(LlmUsagePanel)
    await flushPromises()
    expect(wrapper.find('[data-testid="llm-day-hint"]').text()).toContain('北京时间')
    setSiteTimezone('America/New_York')
    const second = mount(LlmUsagePanel)
    await flushPromises()
    expect(second.find('[data-testid="llm-day-hint"]').text()).toContain('America/New_York')
    setSiteTimezone('Asia/Shanghai')
  })
})
