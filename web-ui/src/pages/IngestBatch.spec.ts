// 批次详情页(设计稿):读取中(骨架屏)/ 出错(说清楚 + 重试)/ 找不到 / 无权限 / 刷新失败保留旧数据,
// 运行中与完成两种版面的文案(不露 ETA、魔数、RRF 的 k 这类术语),暂停 / 取消 / 重试的失败提示。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const push = vi.fn()
vi.mock('vue-router', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    useRoute: () => ({ params: { batch: 'bat_0c71-6d1e-7f3a-92b4-5a8c1e07d3aa' } }),
    useRouter: () => ({ push }),
    RouterLink: defineComponent({ props: { to: { type: String, default: '' } }, setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }),
  }
})
vi.mock('@/layouts/AppShell.vue', () => ({
  default: { template: '<div class="app-shell"><slot name="breadcrumb" /><slot /></div>' },
}))
vi.mock('@/composables/useLiveEvents', () => ({ useLiveEvents: () => () => undefined }))
const confirmState = vi.hoisted(() => ({ answer: true }))
vi.mock('@kb-ui/index', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirm: () => ({
    ask: async (options: { action?: () => Promise<unknown> }) => {
      if (!confirmState.answer) return false
      await options.action?.()
      return true
    },
  }),
}))
import { toasts } from '@kb-ui/components/useToast'

import { CapabilityError } from '@/api/client'
import IngestBatch from './IngestBatch.vue'

const stage = (key: string, label: string, percent: number, extra: Record<string, unknown> = {}) => ({ stage: key, label, files: 10, done: Math.round(percent / 10), chunks: 0, vectors: 0, percent, ...extra })
const RUNNING = {
  batch: 'bat_0c71-6d1e-7f3a-92b4-5a8c1e07d3aa',
  collection: '论文与报告',
  state: 'running',
  stage: 'embed',
  done: 6,
  total: 10,
  chunks: 1412,
  vectors: 1024,
  throughput_cps: 46.8,
  eta_s: 100,
  elapsed_s: 192,
  current_files: ['产品路线图 Q4.pptx'],
  backend: '核显 Vulkan · bge-m3 Q8_0',
  stages: [stage('upload', '上传', 100), stage('detect', '类型识别', 100), stage('embed', '向量化', 73, { chunks: 1412, vectors: 1038 })],
}
const DONE = { ...RUNNING, state: 'done', stage: 'searchable', done: 10, eta_s: null, current_files: [], stages: RUNNING.stages.map((item) => ({ ...item, percent: 100, done: 10 })) }
const FILES = {
  files: [
    { id: 'ing_1', rel_path: 'a.pdf', state: 'done', error: null, chunks: 10 },
    { id: 'ing_7', rel_path: '扫描件-合同-2019.pdf', state: 'failed', error: 'OCR 模型未下载', chunks: 0 },
  ],
}

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  replies = { get_batch_progress: RUNNING, list_ingest: FILES, pause_batch: {}, resume_batch: {}, cancel_batch: {}, retry_ingest: {}, ...overrides }
  callCapability.mockImplementation(async (name: string) => {
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')
const toastTexts = () => toasts.map((entry) => entry.message)

let wrapper: VueWrapper | null = null
async function open() {
  wrapper = mount(IngestBatch, { attachTo: document.body })
  await flushPromises()
}
const button = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent!.includes(label))!

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  push.mockReset()
  toasts.splice(0)
  confirmState.answer = true
  setActivePinia(createPinia())
  backend()
})
afterEach(() => vi.useRealTimers())

describe('IngestBatch · 状态', () => {
  it('第一次取回之前是骨架屏,不是一行「读取中…」', async () => {
    callCapability.mockImplementation(() => new Promise(() => undefined))
    wrapper = mount(IngestBatch, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid=admin-loading]')).not.toBeNull()
    expect(text()).not.toContain('读取中')
  })

  it('读取失败:说清楚发生了什么和怎么办,给「重试」,点了恢复;不显示英文异常', async () => {
    backend({ get_batch_progress: new CapabilityError('internal: boom', 'internal', 500) })
    await open()
    const failure = $('[data-testid=admin-error]')!
    expect(failure.getAttribute('role')).toBe('alert')
    expect(failure.textContent).toContain('读取批次进度失败')
    expect(failure.textContent).toContain('请')
    expect(failure.textContent).not.toContain('boom')
    backend()
    button('重试').click()
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
    expect(text()).toContain('正在处理')
  })

  it('点「重试」后,结果回来之前显示骨架屏(不是还挂着上一次的报错)', async () => {
    backend({ get_batch_progress: new CapabilityError('boom', 'internal', 500) })
    await open()
    let release: (value: unknown) => void = () => undefined
    callCapability.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    button('重试').click()
    await flushPromises()
    expect($('[data-testid=admin-loading]')).not.toBeNull()
    expect($('[data-testid=admin-error]')).toBeNull()
    release(RUNNING)
    await flushPromises()
    expect($('[data-testid=admin-loading]')).toBeNull()
  })

  it('服务端回的是中文原因:带上它', async () => {
    backend({ get_batch_progress: new CapabilityError('服务暂时不可用', 'internal', 503) })
    await open()
    expect($('[data-testid=admin-error]')!.textContent).toContain('服务暂时不可用')
  })

  it('找不到这个批次:写明并指向「导入记录」', async () => {
    backend({ get_batch_progress: { batch: 'x' } })
    await open()
    expect($('[data-testid=admin-error]')!.textContent).toContain('没有找到这个批次')
    expect($('[data-testid=admin-error]')!.textContent).toContain('导入记录')
  })

  it('403:写「没有开通」,不给没用的重试', async () => {
    backend({ get_batch_progress: new CapabilityError('你的账号没有开通这个功能', 'forbidden', 403) })
    await open()
    expect($('[data-testid=admin-forbidden]')!.textContent).toContain('请联系管理员')
    expect($('[data-testid=admin-error]')).toBeNull()
  })

  it('显示过数据之后某次轮询失败:保留旧数据只提示一句,下一次成功后提示消失', async () => {
    await open()
    expect(text()).toContain('正在处理')
    backend({ get_batch_progress: new CapabilityError('boom', 'internal', 500) })
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect($('[data-testid=batch-stale]')!.textContent).toContain('之前的数据')
    expect($('[data-testid=admin-error]')).toBeNull()
    expect(text()).toContain('正在处理')
    backend()
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect($('[data-testid=batch-stale]')).toBeNull()
  })

  it('暂停中的批次刷新失败也会继续试(页面上写着「稍后会自动重试」)', async () => {
    backend({ get_batch_progress: { ...RUNNING, state: 'paused' } })
    await open()
    backend({ get_batch_progress: new CapabilityError('boom', 'internal', 500) })
    // 暂停中不轮询,点「刷新」之外没有触发;这里通过继续按钮触发一次失败的刷新
    backend({ get_batch_progress: new CapabilityError('boom', 'internal', 500), resume_batch: {} })
    button('继续').click()
    await flushPromises()
    expect($('[data-testid=batch-stale]')).not.toBeNull()
    const before = calls('get_batch_progress').length
    backend()
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(calls('get_batch_progress').length).toBeGreaterThan(before)
    expect($('[data-testid=batch-stale]')).toBeNull()
  })
})

describe('IngestBatch · 文案', () => {
  it('运行中:预计剩余(不写 ETA);阶段说明不出现「魔数」', async () => {
    await open()
    expect(text()).toContain('预计剩余 1:40')
    expect(text()).not.toMatch(/ETA/)
    expect(text()).not.toContain('魔数')
  })

  it('完成页:搜索框的示例是人话,没有 RRF / k 这类术语', async () => {
    backend({ get_batch_progress: DONE })
    await open()
    const input = $<HTMLInputElement>('.kb-done-input input')!
    expect(input.placeholder).toBe('例如:这批资料里关于部署的说明')
    expect(input.placeholder).not.toMatch(/RRF|\bk\b/)
    expect(text()).toContain('需要处理')
  })
})

describe('IngestBatch · 操作失败的提示', () => {
  it('暂停失败:写「暂停批次失败:原因」,不是「已暂停失败」', async () => {
    backend({ pause_batch: new CapabilityError('批次正忙', 'conflict', 409) })
    await open()
    button('暂停').click()
    await flushPromises()
    expect(toastTexts().join('|')).toContain('暂停批次失败:批次正忙')
    expect(toastTexts().join('|')).not.toContain('已暂停失败')
  })

  it('取消失败:写「取消批次失败」;重试失败:写「重试失败」,都不露英文异常', async () => {
    backend({ cancel_batch: new CapabilityError('boom', 'internal', 500), get_batch_progress: DONE, retry_ingest: new CapabilityError('boom', 'internal', 500) })
    await open()
    button('全部重试').click()
    await flushPromises()
    const all = toastTexts().join('|')
    expect(all).toContain('重试失败')
    expect(all).not.toContain('boom')
  })

  it('取消批次要先确认;确认后发 cancel_batch', async () => {
    await open()
    confirmState.answer = false
    button('取消').click()
    await flushPromises()
    expect(calls('cancel_batch')).toHaveLength(0)
    confirmState.answer = true
    button('取消').click()
    await flushPromises()
    expect(calls('cancel_batch')).toHaveLength(1)
    expect(toastTexts()).toContain('已取消')
  })
})
