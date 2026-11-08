// 审计概况:热力图 7 行 × 24 列、排行用中文能力名、失败单独着色、切范围重新取数、没有记录写说明。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), callCapability: (...args: unknown[]) => callCapability(...args) }))
vi.mock('@/composables/useLiveEvents', () => ({ useLiveEvents: () => () => undefined, subscribeLive: () => () => undefined }))

import AuditStatsCards from './AuditStatsCards.vue'

const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
heat[1]![14] = 30
heat[0]![9] = 8
const reply = { days: 30, heat, top: [{ capability: 'save_insight', count: 40, failed: 5 }, { capability: 'search_knowledge', count: 12, failed: 0 }], total: 52, failed: 5 }
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  document.body.innerHTML = ''
  callCapability.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('AuditStatsCards', () => {
  it('结论写总数和最忙的钟点;排行用中文名,失败数写在结论里', async () => {
    callCapability.mockResolvedValue(reply)
    mount(AuditStatsCards, { attachTo: document.body })
    await flushPromises()
    expect(callCapability).toHaveBeenCalledWith('audit_stats', { days: 30 })
    const text = $('[data-testid=audit-stats]')!.textContent!
    expect(text).toContain('近 30 天共 52 次操作')
    expect(text).toContain('最忙的是周二 14 点')
    expect(text).toContain('保存笔记')
    expect(text).toContain('其中 5 次失败')
    // 热力图的七个行名都在
    for (const day of ['周一', '周二', '周三', '周四', '周五', '周六', '周日']) expect(text).toContain(day)
  })

  it('切到 7 天会按新范围重新取数', async () => {
    callCapability.mockResolvedValue(reply)
    mount(AuditStatsCards, { attachTo: document.body })
    await flushPromises()
    const seven = [...document.body.querySelectorAll<HTMLElement>('[data-testid=audit-stats] button, [data-testid=audit-stats] [role=radio], [data-testid=audit-stats] [role=tab]')].find((node) => node.textContent?.trim() === '7 天')
    expect(seven).toBeTruthy()
    seven!.click()
    await flushPromises()
    expect(callCapability).toHaveBeenLastCalledWith('audit_stats', { days: 7 })
  })

  it('一条记录都没有时写说明,缺字段的回答不报错', async () => {
    callCapability.mockResolvedValue({})
    mount(AuditStatsCards, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid=audit-stats]')!.textContent).toContain('这段时间还没有操作记录')
  })

  it('读取失败写原因并给重试', async () => {
    callCapability.mockRejectedValue(new Error('网络断了'))
    mount(AuditStatsCards, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid=audit-stats]')!.textContent).toContain('重试')
  })
})
