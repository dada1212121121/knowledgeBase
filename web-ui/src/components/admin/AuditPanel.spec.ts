// 审计日志:读不到要写原因并可重试(以前请求失败被吞掉,页面停在骨架屏);操作、操作者、详情都显示中文。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const userList = vi.fn()
vi.mock('@/utils/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/adminApi')>()),
  userList: (...a: unknown[]) => userList(...a),
}))

import AuditPanel from './AuditPanel.vue'
import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'

const T0 = Date.UTC(2026, 9, 21, 0, 30)
const entry = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  at: T0 - id * 60_000,
  actor: 'usr_0123456789abcdef',
  capability: 'save_insight',
  args_json: '{"id":"ins_1","embedder":"bge-m3"}',
  ok: true,
  error: null,
  batch_id: null,
  dry_run: false,
  ...over,
})
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)
const text = () => document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''

let reply: unknown = { entries: [entry(1)], total: 1 }
let wrapper: VueWrapper | null = null
async function open(features: string[] = ['sys.ops']) {
  const session = useSessionStore()
  session.features = new Set(features)
  session.loaded = true
  wrapper = mount(AuditPanel, { attachTo: document.body })
  await flushPromises()
}
beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  reply = { entries: [entry(1)], total: 1 }
  callCapability.mockReset().mockImplementation(async () => {
    if (reply instanceof Error) throw reply
    return reply
  })
  userList.mockReset().mockResolvedValue({ users: [{ id: 'usr_0123456789abcdef', username: 'zs', display_name: '张三' }], total: 1 })
})

describe('审计日志 · 读取状态', () => {
  it('读不到:写「读取审计日志失败」+ 重试(不是停在骨架屏);重试后出现记录', async () => {
    reply = new CapabilityError('数据库繁忙', 'internal', 500)
    await open()
    const box = $('[data-testid=admin-error]')
    expect(box?.textContent).toContain('读取审计日志失败')
    expect($('[data-testid=admin-loading]')).toBeNull()
    reply = { entries: [entry(1)], total: 1 }
    box!.querySelector<HTMLButtonElement>('button')!.click()
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
    expect(text()).toContain('保存笔记')
  })

  it('没有开通:说明没有开通,不给重试', async () => {
    reply = new CapabilityError('forbidden', 'forbidden', 403)
    await open()
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect($('[data-testid=admin-forbidden]')!.querySelector('button')).toBeNull()
  })

  it('空:写下一步;筛选后没有记录:给「看全部操作」', async () => {
    reply = { entries: [], total: 0 }
    await open()
    expect($('[data-testid=audit-empty]')!.textContent).toContain('还没有调用记录')
    expect($('[data-testid=audit-empty]')!.textContent).toContain('方便事后追查')
  })
})

describe('审计日志 · 中文显示', () => {
  it('能力名、操作者、参数都翻成中文;原始标识只在 title 里', async () => {
    await open(['sys.ops', 'sys.users'])
    const page = text()
    expect(page).toContain('保存笔记')
    expect(page).toContain('张三')
    expect(page).toContain('编号 ins_1')
    expect(page).not.toMatch(/save_insight|usr_0123|embedder|bge-m3|"id"/)
    expect($('[title="save_insight"]')).not.toBeNull()
    expect($('[title="usr_0123456789abcdef"]')).not.toBeNull()
  })

  it('没有「用户」功能查不到名字:只露用户 id 的末六位', async () => {
    await open(['sys.ops'])
    expect(userList).not.toHaveBeenCalled()
    expect(text()).toContain('用户 …abcdef')
  })

  it('失败的记录写后端给的原因;认不得的能力写「其它操作」', async () => {
    reply = { entries: [entry(1, { ok: false, error: '磁盘空间不足', capability: 'brand_new_thing' })], total: 1 }
    await open()
    expect(text()).toContain('失败')
    expect(text()).toContain('磁盘空间不足')
    expect(text()).toContain('其它操作')
    expect(text()).not.toContain('brand_new_thing')
  })

  it('筛选是下拉(中文操作名),选了以后回到第 1 页并按能力名请求;没有「例如 search」这样的英文占位符', async () => {
    await open()
    expect(document.body.querySelector('input[placeholder*="search"]')).toBeNull()
    expect(callCapability.mock.calls[0]![1]).toEqual({ page: 1, page_size: 24 })
    document.body.querySelector<HTMLButtonElement>('.kb-ap-bar .kb-select > button')!.click()
    await flushPromises()
    const option = [...document.body.querySelectorAll<HTMLElement>('[role=option]')].find((el) => el.textContent?.trim() === '保存笔记')!
    option.click()
    await flushPromises()
    expect(callCapability.mock.calls.at(-1)![1]).toEqual({ page: 1, page_size: 24, capability: 'save_insight' })
  })

  it('选了筛选但没有记录:写「这个操作还没有记录」并给「看全部操作」', async () => {
    await open()
    reply = { entries: [], total: 0 }
    document.body.querySelector<HTMLButtonElement>('.kb-ap-bar .kb-select > button')!.click()
    await flushPromises()
    ;[...document.body.querySelectorAll<HTMLElement>('[role=option]')].find((el) => el.textContent?.trim() === '修改内容')!.click()
    await flushPromises()
    expect($('[data-testid=audit-empty]')!.textContent).toContain('这个操作还没有记录')
    expect($('[data-testid=audit-empty]')!.querySelector('button')?.textContent).toContain('看全部操作')
  })

  it('翻到第 2 页以后换筛选,回到第 1 页(不会停在一个不存在的页上)', async () => {
    reply = { entries: [entry(1)], total: 100 }
    await open()
    ;[...document.body.querySelectorAll<HTMLButtonElement>('.kb-pager button')].find((b) => b.textContent?.trim() === '2')!.click()
    await flushPromises()
    expect(callCapability.mock.calls.at(-1)![1]).toMatchObject({ page: 2 })
    document.body.querySelector<HTMLButtonElement>('.kb-ap-bar .kb-select > button')!.click()
    await flushPromises()
    ;[...document.body.querySelectorAll<HTMLElement>('[role=option]')].find((el) => el.textContent?.trim() === '修改内容')!.click()
    await flushPromises()
    expect(callCapability.mock.calls.at(-1)![1]).toEqual({ page: 1, page_size: 24, capability: 'edit_item' })
  })
})
