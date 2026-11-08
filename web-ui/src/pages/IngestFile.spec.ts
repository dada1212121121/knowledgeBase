// 文件时间线页(设计稿):读取中(骨架屏)/ 出错(说清楚 + 重试)/ 找不到 / 无权限 / 动作后刷新失败保留旧数据,
// 失败阶段的「重试此阶段 / 跳过 / 移入隔离」,以及动作失败的提示写法。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
vi.mock('vue-router', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    useRoute: () => ({ params: { id: 'ing_7' } }),
    RouterLink: defineComponent({ props: { to: { type: String, default: '' } }, setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }),
  }
})
vi.mock('@/layouts/AppShell.vue', () => ({
  default: { template: '<div class="app-shell"><slot name="breadcrumb" /><slot /></div>' },
}))
import { toasts } from '@kb-ui/components/useToast'

import { CapabilityError } from '@/api/client'
import IngestFile from './IngestFile.vue'

const MB = 1024 * 1024
const stages = (failed: boolean) => [
  { stage: 'upload', label: '上传', status: 'ok', duration_ms: 400, chunks: 0, vectors: 0, error: null },
  { stage: 'extract', label: '解析 / 抽取', status: failed ? 'failed' : 'ok', duration_ms: 11800, chunks: 0, vectors: 0, error: failed ? '42 页中 3 页无文字层 → OCR 失败' : null },
  { stage: 'chunk', label: '分块', status: 'pending', duration_ms: null, chunks: 0, vectors: 0, error: null },
]
const TIMELINE = (failed = true) => ({
  file: {
    id: 'ing_7', batch_id: 'bat_0c71-6d1e-7f3a-92b4-5a8c1e07d3aa', collection: '_global', rel_path: '扫描件-合同-2019.pdf', size: 18.6 * MB,
    sha256: '8a5d8b28d66ae90b5876fe0337b963d9f66ab1047f8c866ff4646b73a8a3aa41', state: failed ? 'failed' : 'done', error: failed ? 'OCR 模型未下载' : null, chunks: 0, vectors: 0, elapsed_ms: 12200,
  },
  total_ms: 12200,
  stages: stages(failed),
})

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  replies = { get_file_timeline: TIMELINE(), retry_file_stage: {}, skip_file: {}, quarantine_file: {}, ...overrides }
  callCapability.mockImplementation(async (name: string) => {
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')
const toastTexts = () => toasts.map((entry) => entry.message).join('|')
const button = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent!.includes(label))!

let wrapper: VueWrapper | null = null
async function open() {
  wrapper = mount(IngestFile, { attachTo: document.body })
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  toasts.splice(0)
  setActivePinia(createPinia())
  backend()
})

describe('IngestFile · 状态', () => {
  it('第一次取回之前是骨架屏,不是一行「读取中…」', async () => {
    callCapability.mockImplementation(() => new Promise(() => undefined))
    wrapper = mount(IngestFile, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid=admin-loading]')).not.toBeNull()
    expect(text()).not.toContain('读取中')
  })

  it('读取失败:说清楚并给「重试」,点了恢复;不显示英文异常', async () => {
    backend({ get_file_timeline: new CapabilityError('internal: boom', 'internal', 500) })
    await open()
    const failure = $('[data-testid=admin-error]')!
    expect(failure.getAttribute('role')).toBe('alert')
    expect(failure.textContent).toContain('读取文件时间线失败')
    expect(failure.textContent).not.toContain('boom')
    backend()
    button('重试').click()
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
    expect(text()).toContain('扫描件-合同-2019.pdf')
  })

  it('点「重试」后,结果回来之前显示骨架屏', async () => {
    backend({ get_file_timeline: new CapabilityError('boom', 'internal', 500) })
    await open()
    let release: (value: unknown) => void = () => undefined
    callCapability.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    button('重试').click()
    await flushPromises()
    expect($('[data-testid=admin-loading]')).not.toBeNull()
    expect($('[data-testid=admin-error]')).toBeNull()
    release(TIMELINE())
    await flushPromises()
    expect($('[data-testid=admin-loading]')).toBeNull()
  })

  it('找不到这个文件:写明并指向「导入记录」', async () => {
    backend({ get_file_timeline: { stages: [] } })
    await open()
    expect($('[data-testid=admin-error]')!.textContent).toContain('没有找到这个文件')
    expect($('[data-testid=admin-error]')!.textContent).toContain('导入记录')
  })

  it('403:写「没有开通」,不给没用的重试', async () => {
    backend({ get_file_timeline: new CapabilityError('你的账号没有开通这个功能', 'forbidden', 403) })
    await open()
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect($('[data-testid=admin-error]')).toBeNull()
  })
})

describe('IngestFile · 失败阶段的操作', () => {
  it('失败的阶段有「重试此阶段 / 跳过 / 移入隔离」,没失败的文件没有', async () => {
    await open()
    expect(button('重试此阶段')).toBeTruthy()
    expect(button('跳过')).toBeTruthy()
    expect(button('移入隔离')).toBeTruthy()
    wrapper!.unmount()
    document.body.innerHTML = ''
    backend({ get_file_timeline: TIMELINE(false) })
    await open()
    expect(document.body.querySelectorAll('.kb-tl-actions')).toHaveLength(0)
  })

  it('重试此阶段:带着阶段名发 retry_file_stage,成功后提示并重新读取', async () => {
    await open()
    button('重试此阶段').click()
    await flushPromises()
    expect(calls('retry_file_stage')[0]![1]).toEqual({ id: 'ing_7', stage: 'extract' })
    expect(toastTexts()).toContain('已从该阶段重跑')
    expect(calls('get_file_timeline').length).toBe(2)
  })

  it('跳过失败:写「跳过失败:原因」,不是「已跳过失败」', async () => {
    backend({ skip_file: new CapabilityError('文件正在被处理', 'conflict', 409) })
    await open()
    button('跳过').click()
    await flushPromises()
    expect(toastTexts()).toContain('跳过失败:文件正在被处理')
    expect(toastTexts()).not.toContain('已跳过失败')
  })

  it('移入隔离失败、重试阶段失败:各写自己的动作名,不露英文异常', async () => {
    backend({ quarantine_file: new CapabilityError('boom', 'internal', 500), retry_file_stage: new CapabilityError('boom', 'internal', 500) })
    await open()
    button('移入隔离').click()
    await flushPromises()
    button('重试此阶段').click()
    await flushPromises()
    const all = toastTexts()
    expect(all).toContain('移入隔离失败')
    expect(all).toContain('重试这个阶段失败')
    expect(all).not.toContain('boom')
    expect(all).not.toContain('已移入隔离失败')
  })

  it('动作成功但之后重新读取失败:保留旧数据,提示一句', async () => {
    await open()
    backend({ get_file_timeline: new CapabilityError('boom', 'internal', 500) })
    button('跳过').click()
    await flushPromises()
    expect($('[data-testid=file-stale]')!.textContent).toContain('之前的数据')
    expect($('[data-testid=admin-error]')).toBeNull()
    expect(text()).toContain('扫描件-合同-2019.pdf')
  })
})
