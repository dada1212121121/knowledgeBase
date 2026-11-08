// 来源详情 · AI 规范化:显示开关、提取要求、整理情况与暂停原因;改开关 / 要求调用 update_source 并把新行交给页面。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))

import { toasts } from '@kb-ui/components/useToast'
import { useSessionStore } from '@/stores/session'
import type { SourceRow } from '@/utils/importSources'
import SourceDetail from './SourceDetail.vue'

const row = (extra: Partial<SourceRow> = {}): SourceRow => ({
  id: 's1',
  kind: 'web',
  name: '商品站',
  uri: 'https://shop.example/',
  collection: '_global',
  tags: [],
  include: [],
  exclude: [],
  depth: 2,
  allow_hosts: [],
  refresh_minutes: null,
  status: 'idle',
  last_synced_at: 1,
  last_error: null,
  files: 4,
  created_at: 1,
  ai_extract: true,
  extract_prompt: '',
  ai_status: { done: 3, pending: 2, failed: 0, note: 'AI 规范化已暂停:今天的 AI 额度已用完', updated_at: 1 },
  ...extra,
})

let wrapper: VueWrapper | null = null
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
async function open(source: SourceRow) {
  wrapper = mount(SourceDetail, { props: { source, busy: false }, attachTo: document.body })
  await flushPromises()
}
async function typePrompt(value: string) {
  const input = $<HTMLTextAreaElement>('[data-testid=source-detail-prompt] textarea, textarea[data-testid=source-detail-prompt]')!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}
const save = () => $<HTMLButtonElement>('[data-testid=source-detail-save]')!

beforeEach(() => {
  setActivePinia(createPinia())
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  toasts.splice(0)
  callCapability.mockReset()
})

describe('来源详情 · AI 规范化', () => {
  it('显示提取要求(留空写「自动」)、整理情况和暂停原因', async () => {
    await open(row())
    const text = $('[data-testid=source-detail]')!.textContent ?? ''
    expect(text).toContain('自动(按页面类型尽量全面地整理)')
    expect(text).toContain('已整理 3 页 · 待整理 2 页')
    expect(text).toContain('今天的 AI 额度已用完')
    expect(text).toContain('AI 规范化')
  })

  it('改提取要求:调用 update_source,提示按新要求重新整理,把新行交给页面', async () => {
    const updated = row({ extract_prompt: '只要价格' })
    callCapability.mockResolvedValue({ source: updated })
    await open(row())
    expect(save().disabled).toBe(true)
    await typePrompt('  只要价格 ')
    expect($('[data-testid=source-detail-ai]')!.textContent).toContain('下次同步时每页都会按新要求重新整理')
    save().click()
    await flushPromises()
    expect(callCapability).toHaveBeenCalledWith('update_source', { id: 's1', ai_extract: true, extract_prompt: '只要价格' })
    expect(toasts.map((toast) => toast.message)).toContain('已保存。下次同步时按新要求重新整理')
    expect(wrapper!.emitted('updated')![0]).toEqual([updated])
  })

  it('关掉:只传开关,不动提取要求(再打开还是原来那份)', async () => {
    callCapability.mockResolvedValue({ source: row({ ai_extract: false }) })
    await open(row({ extract_prompt: '只要价格' }))
    $<HTMLElement>('[data-testid=source-detail-ai] [role=switch]')!.click()
    await flushPromises()
    save().click()
    await flushPromises()
    expect(callCapability).toHaveBeenCalledWith('update_source', { id: 's1', ai_extract: false })
  })

  it('非网页来源、或没有「自动提炼与审核」功能点:没有修改区', async () => {
    await open(row({ kind: 'note', ai_extract: false }))
    expect($('[data-testid=source-detail-ai]')).toBeNull()
    wrapper!.unmount()
    document.body.innerHTML = ''
    const session = useSessionStore()
    session.loaded = true
    session.features = new Set(['sources.web'])
    await open(row())
    expect($('[data-testid=source-detail-ai]')).toBeNull()
    // 只读信息照样显示
    expect($('[data-testid=source-detail]')!.textContent).toContain('已整理 3 页')
  })

  it('保存失败:提示原因,不发 updated', async () => {
    callCapability.mockRejectedValue(new Error('AI 规范化需要「自动提炼与审核」功能权限'))
    await open(row({ ai_extract: false, ai_status: null }))
    $<HTMLElement>('[data-testid=source-detail-ai] [role=switch]')!.click()
    await flushPromises()
    save().click()
    await flushPromises()
    expect(toasts.map((toast) => toast.message).join()).toContain('保存失败')
    expect(wrapper!.emitted('updated')).toBeUndefined()
  })
})
