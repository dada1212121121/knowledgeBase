// 我的用量卡片:四种状态里的加载 / 报错 / 就绪,以及超额时的提示。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from '@/stores/session'
import type { MyUsage } from '@/api/usage'

const usageMine = vi.fn<() => Promise<MyUsage>>()
vi.mock('@/api/usage', () => ({ usageMine: () => usageMine() }))

import MyUsageCard from './MyUsageCard.vue'

const GB = 1024 ** 3
const usage = (storageGb: number, limitGb: number, tokens: number, tokenLimit: number): MyUsage => ({
  storage: { sources_bytes: storageGb * GB, uploads_bytes: 0, vectors_bytes: 0, meta_bytes: 0, workspace_bytes: 0, total_bytes: storageGb * GB, limit_bytes: limitGb * GB },
  ai: { day: '2026-10-20', tokens_today: tokens, limit: tokenLimit },
})

beforeEach(() => {
  setActivePinia(createPinia())
  usageMine.mockReset()
})

describe('MyUsageCard', () => {
  it('加载中是骨架屏', () => {
    usageMine.mockReturnValue(new Promise(() => undefined))
    expect(mount(MyUsageCard).find('[data-testid="my-usage-loading"]').exists()).toBe(true)
  })

  it('正常:存储和 AI 都写「已用 / 共」和百分比,并说明站点时区重置时间', async () => {
    usageMine.mockResolvedValue(usage(10, 100, 68_000, 200_000))
    const wrapper = mount(MyUsageCard)
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('10 GB / 100 GB')
    expect(text).toContain('已用 6.8 万 / 共 20 万')
    expect(text).toContain('每天 0 点重置')
    expect(wrapper.find('[data-testid="my-usage-storage-over"]').exists()).toBe(false)
  })

  it('AI 总开关关掉:今日 AI 额度整块不出现,页面任何位置没有「AI」字样;存储照常', async () => {
    useSessionStore().aiEnabled = false
    // 额度用完的状态也要隐藏:超额提示里写着「AI 额度用完了」
    usageMine.mockResolvedValue(usage(120, 100, 250_000, 200_000))
    const wrapper = mount(MyUsageCard)
    await flushPromises()
    expect(wrapper.find('[data-testid="my-usage-ai"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="my-usage-ai-over"]').exists()).toBe(false)
    expect(wrapper.html()).not.toMatch(/\bAI\b/i)
    expect(wrapper.text()).toContain('存储')
    expect(wrapper.find('[data-testid="my-usage-storage-over"]').exists()).toBe(true)
    // 存储明细里的「代理工作目录」换成「其它」:这块计入总量,整行删掉明细就对不上总数
    expect(wrapper.find('.kb-mu-parts').text()).toContain('其它')
    expect(wrapper.find('.kb-mu-parts').findAll('div')).toHaveLength(4)
  })

  it('AI 开着:存储明细里叫「代理工作目录」(术语表)', async () => {
    usageMine.mockResolvedValue(usage(1, 10, 1, 10))
    const wrapper = mount(MyUsageCard)
    await flushPromises()
    expect(wrapper.find('.kb-mu-parts').text()).toContain('代理工作目录')
    expect(wrapper.find('.kb-mu-parts').text()).not.toContain('其它')
  })

  it('不限额:写「不限」,不显示百分比和超额提示', async () => {
    usageMine.mockResolvedValue(usage(500, 0, 900_000, 0))
    const wrapper = mount(MyUsageCard)
    await flushPromises()
    expect(wrapper.text()).toContain('/ 不限')
    expect(wrapper.text()).toContain('· 不限')
    expect(wrapper.text()).not.toContain('已超额')
  })

  it('超额:说清后果和出路', async () => {
    usageMine.mockResolvedValue(usage(120, 100, 250_000, 200_000))
    const wrapper = mount(MyUsageCard)
    await flushPromises()
    expect(wrapper.find('[data-testid="my-usage-storage-over"]').text()).toContain('不能再上传')
    expect(wrapper.find('[data-testid="my-usage-ai-over"]').text()).toContain('明天')
    expect(wrapper.text()).toContain('已超额')
  })

  it('报错:给原因和重试,重试成功后显示数据', async () => {
    usageMine.mockRejectedValueOnce(Object.assign(new Error('服务暂时不可用'), { status: 503 })).mockResolvedValueOnce(usage(1, 10, 1, 10))
    const wrapper = mount(MyUsageCard)
    await flushPromises()
    expect(wrapper.find('[data-testid="my-usage-error"]').exists()).toBe(true)
    await wrapper.find('[data-testid="my-usage-error"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="my-usage-error"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('1.0 GB / 10 GB')
  })
})
