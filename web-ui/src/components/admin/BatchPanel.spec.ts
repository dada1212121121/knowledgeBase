// 批次:读取状态;撤销是危险操作,确认框要写清范围和后果,结果如实说恢复了几项、跳过了几项;分页。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))

import BatchPanel from './BatchPanel.vue'
import KbConfirmHost from '@kb-ui/components/KbConfirmHost.vue'
import { cancelConfirm } from '@kb-ui/components/useConfirm'
import { toasts } from '@kb-ui/components/useToast'
import { CapabilityError } from '@/api/client'

const T0 = Date.UTC(2026, 9, 21, 0, 30)
const change = (seq: number, revertible = true) => ({ seq, target: `ins_${seq}`, op: 'insight.update', revertible })
const batch = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  actor: 'mcp:Claude Code',
  description: 'save_insight 调用',
  created_at: T0,
  reverted_at: null,
  changes: [change(1), change(2)],
  ...over,
})
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)
const text = () => document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const buttonByText = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)

let replies: Record<string, unknown> = {}
let wrapper: VueWrapper | null = null
let host: VueWrapper | null = null
async function open() {
  host = mount(KbConfirmHost, { attachTo: document.body })
  wrapper = mount(BatchPanel, { attachTo: document.body })
  await flushPromises()
}
afterEach(() => cancelConfirm())
beforeEach(() => {
  wrapper?.unmount()
  host?.unmount()
  wrapper = null
  host = null
  document.body.innerHTML = ''
  toasts.splice(0)
  setActivePinia(createPinia())
  replies = {
    batch_list: { batches: [batch('bat_1'), batch('bat_2', { reverted_at: T0 + 1000 }), batch('bat_3', { changes: [] })], total: 3 },
    revert_batch: { reverted: [{ target: 'ins_1', op: 'insight.update' }], skipped: [] },
  }
  callCapability.mockReset().mockImplementation(async (name: string) => {
    const value = replies[name]
    if (value instanceof Error) throw value
    return value
  })
})

describe('批次 · 读取状态', () => {
  it('读不到:写「读取批次失败」+ 重试,不是停在骨架屏;重试后出现', async () => {
    replies.batch_list = new CapabilityError('数据库繁忙', 'internal', 500)
    await open()
    const box = $('[data-testid=admin-error]')
    expect(box?.textContent).toContain('读取批次失败')
    replies.batch_list = { batches: [batch('bat_1')], total: 1 }
    box!.querySelector<HTMLButtonElement>('button')!.click()
    await flushPromises()
    expect(text()).toContain('保存笔记')
  })

  it('空:写说明', async () => {
    replies.batch_list = { batches: [], total: 0 }
    await open()
    expect(text()).toContain('还没有批次')
    expect(text()).toContain('出现后可以整批撤销')
  })
})

describe('批次 · 列表', () => {
  it('说明用中文(不露「save_insight 调用」),状态都有文字;只有可撤销的批次有「撤销整批」', async () => {
    await open()
    expect(text()).not.toContain('save_insight')
    expect(text()).toContain('可撤销')
    expect(text()).toContain('已撤销')
    expect(text()).toContain('只读')
    expect(document.body.querySelectorAll('[data-testid=batch-row]')).toHaveLength(3)
    expect(document.body.querySelectorAll('[data-testid=batch-revert]')).toHaveLength(1)
    expect($('[data-testid=batch-revert]')!.getAttribute('aria-label')).toBe('撤销批次「保存笔记」')
  })

  it('总数超过一页要能翻页(以前只列前 20 个却写「共 N 个」)', async () => {
    replies.batch_list = { batches: [batch('bat_1')], total: 45 }
    await open()
    expect(text()).toContain('45 条中第 1–20 条')
    expect(callCapability.mock.calls[0]![1]).toEqual({ page: 1, page_size: 20 })
  })
})

describe('批次 · 撤销', () => {
  it('先确认:写明谁、什么时候、几项改动、跳过、不能再次撤销、记入审计;确认之前不发请求', async () => {
    await open()
    $('[data-testid=batch-revert]')!.click()
    await flushPromises()
    const dialog = $('[role=alertdialog]')!.textContent!
    expect(dialog).toContain('撤销批次「保存笔记」?')
    expect(dialog).toContain('2 项改动会恢复')
    expect(dialog).toContain('MCP 客户端 Claude Code')
    expect(dialog).toContain('跳过')
    expect(dialog).toContain('不能再次撤销')
    expect(dialog).toContain('记入审计')
    expect(callCapability.mock.calls.some((c) => c[0] === 'revert_batch')).toBe(false)
  })

  it('取消不撤销', async () => {
    await open()
    $('[data-testid=batch-revert]')!.click()
    await flushPromises()
    buttonByText('先不撤销')!.click()
    await flushPromises()
    expect(callCapability.mock.calls.some((c) => c[0] === 'revert_batch')).toBe(false)
  })

  it('确认后按批次编号请求,提示条写恢复了几项;随后重读列表', async () => {
    await open()
    $('[data-testid=batch-revert]')!.click()
    await flushPromises()
    $('[role=alertdialog] .kb-confirm-btn.is-danger')!.click()
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 900))
    await flushPromises()
    expect(callCapability).toHaveBeenCalledWith('revert_batch', { batch_id: 'bat_1' })
    expect(toasts.at(-1)?.message).toBe('已恢复 1 项。')
    expect(callCapability.mock.calls.filter((c) => c[0] === 'batch_list').length).toBeGreaterThanOrEqual(2)
  })

  it('有跳过的:提示条用警告色并带上第一条原因,不说成全部成功', async () => {
    replies.revert_batch = { reverted: [{ target: 'a' }], skipped: [{ target: 'b', reason: '内容已被改动,无法恢复' }, { target: 'c', reason: 'x' }] }
    await open()
    $('[data-testid=batch-revert]')!.click()
    await flushPromises()
    $('[role=alertdialog] .kb-confirm-btn.is-danger')!.click()
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 900))
    await flushPromises()
    expect(toasts.at(-1)?.message).toBe('已恢复 1 项,另有 2 项无法恢复,已跳过(内容已被改动,无法恢复)。')
    expect(toasts.at(-1)?.tone).toBe('warning')
  })

  it('后端拒绝:确认框里写「撤销批次失败:原因」', async () => {
    replies.revert_batch = new CapabilityError('这个批次已经撤销过', 'exists', 409)
    await open()
    $('[data-testid=batch-revert]')!.click()
    await flushPromises()
    $('[role=alertdialog] .kb-confirm-btn.is-danger')!.click()
    await flushPromises()
    expect($('[role=alertdialog]')!.textContent).toContain('撤销批次失败:这个批次已经撤销过')
  })
})
