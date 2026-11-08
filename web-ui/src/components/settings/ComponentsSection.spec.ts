// 「组件」与「OCR 与转写」两个分区:四种状态、引擎列表上的操作(只出现后端真能做的)、一键采用推荐、
// 下载进度(自动刷新 / 失败说明)、操作失败的原因常驻、卸载要确认。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const confirmState = vi.hoisted(() => ({ answer: true, calls: [] as { title: string; message?: string }[] }))
vi.mock('@kb-ui/index', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirm: () => ({
    ask: async (options: { title: string; message?: string; action?: () => Promise<unknown> }) => {
      confirmState.calls.push(options)
      if (!confirmState.answer) return false
      await options.action?.()
      return true
    },
  }),
}))
import { toasts } from '@kb-ui/components/useToast'

import { CapabilityError } from '@/api/client'
import { toDraft } from '@/utils/settingsFields'
import ComponentsSection from './ComponentsSection.vue'
import OcrSection from './OcrSection.vue'

const provider = (extra: Record<string, unknown>) => ({ name: 'x', installed: false, ready: false, current: false, detail: null, model: null, install_command: null, removable: false, ...extra })
const PROVIDERS = [
  provider({ kind: 'ocr', id: 'rapidocr', installed: true, ready: true, current: true, detail: '就绪', install_command: 'rapidocr --install', removable: true }),
  provider({ kind: 'ocr', id: 'tesseract', detail: '找不到命令 tesseract', install_command: 'apt-get install tesseract-ocr' }),
  provider({ kind: 'transcribe', id: 'whisper-cli', current: true, detail: '找不到命令 whisper-cli', install_command: 'bash install-whisper.sh' }),
  provider({ kind: 'embed', id: 'bge-m3-int8', installed: true, ready: true, current: true, detail: '就绪', install_command: 'x' }),
  provider({ kind: 'rerank', id: 'http-rerank', installed: true, ready: true, current: true, detail: '就绪' }),
]
const ENV = { cpu_cores: 16, memory_mb: 64036, disk_free_gb: 412, has_nvidia: false, gpu: 'Intel 核显', has_intel_gpu: true, tools: ['git'] }
const RECS = [
  { kind: 'ocr', provider: 'tesseract', reason: '没有独显,CPU 推理', already_current: false },
  { kind: 'transcribe', provider: 'whisper-cli', reason: '转写保持关闭', already_current: false },
]
const CONFIG = {
  embed: { backend: 'fastembed', model: 'bge-m3-int8', max_tokens: 512, batch_size: 8, preload: true },
  extract: { ocr_enabled: false, ocr_model_size: 'small', ocr_language: 'chi_sim+eng', transcribe_enabled: false, max_media_seconds: 1800 },
}
const IDLE = { enabled: false, backend: 'rapidocr', model_size: 'small', model_dir: null, install_command: 'x', install: { state: 'idle', lines: 0, tail: [], error: null, command: '' } }

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  replies = {
    provider_list: () => ({ providers: structuredClone(PROVIDERS), env: ENV }),
    recommend_providers: { recommendations: RECS },
    ocr_status: IDLE,
    provider_install: { started: true },
    provider_set_default: { applied: true },
    provider_uninstall: { removed: 3 },
    ...overrides,
  }
  callCapability.mockImplementation(async (name: string, args?: unknown) => {
    const reply = replies[name]
    if (typeof reply === 'function') return (reply as (a: unknown) => unknown)(args)
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const rowOf = (id: string) => $(`[data-provider="${id}"]`)!
const buttons = (id: string) => [...rowOf(id).querySelectorAll<HTMLButtonElement>('button')].map((el) => el.textContent!.trim())

let wrapper: VueWrapper | null = null
async function open(component: typeof ComponentsSection | typeof OcrSection) {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  wrapper = mount(component, { attachTo: document.body, props: { aiOn: true, draft: toDraft(CONFIG), errors: {} } })
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  confirmState.answer = true
  confirmState.calls = []
  toasts.splice(0)
  backend()
})
afterEach(() => vi.useRealTimers())

describe('组件分区', () => {
  it('环境检测、嵌入(只读参数 + 引擎列表在同一张卡)、重排', async () => {
    await open(ComponentsSection)
    expect($('[data-testid=env-card]')!.textContent).toContain('16 核')
    expect($('[data-testid=env-card]')!.textContent).toContain('62.5 GB')
    expect($('[data-testid=env-card]')!.textContent).toContain('Intel 核显')
    const embed = $('[data-group="embed"]')!
    expect(embed.querySelector('[data-field="embed.model"] [data-testid=setting-value]')!.textContent).toBe('bge-m3-int8')
    expect(embed.querySelector('[data-provider="bge-m3-int8"]')).not.toBeNull()
    expect($$('[data-group="embed"]')).toHaveLength(1)
    expect($('[data-group="rerank"] [data-provider="http-rerank"]')).not.toBeNull()
  })

  it('嵌入和重排只读:没有「下载」「设为默认」「卸载」(后端不支持,点了只会报错)', async () => {
    await open(ComponentsSection)
    expect(buttons('bge-m3-int8')).toEqual([])
    expect(buttons('http-rerank')).toEqual([])
  })

  it('这个分区里没有 OCR / 转写的引擎(它们在「OCR 与转写」)', async () => {
    await open(ComponentsSection)
    expect($('[data-provider="rapidocr"]')).toBeNull()
    expect($('[data-provider="whisper-cli"]')).toBeNull()
  })

  it('加载中:骨架屏', async () => {
    backend({ provider_list: () => new Promise(() => undefined) })
    await open(ComponentsSection)
    expect($('[data-testid=admin-loading]')).not.toBeNull()
    expect($('[data-testid=env-card]')).toBeNull()
  })

  it('读取失败:说清原因 + 重试,点重试后恢复', async () => {
    let fail = true
    backend({
      provider_list: () => {
        if (fail) throw new CapabilityError('组件目录读不了', 'internal', 500)
        return { providers: structuredClone(PROVIDERS), env: ENV }
      },
    })
    await open(ComponentsSection)
    expect($('[data-testid=admin-error]')!.textContent).toContain('读取组件信息失败:组件目录读不了')
    fail = false
    $('[data-testid=admin-error] button')!.click()
    await flushPromises()
    expect($('[data-testid=env-card]')).not.toBeNull()
  })

  it('没有开通(403):只说没开通', async () => {
    backend({ provider_list: new CapabilityError('forbidden', 'forbidden', 403) })
    await open(ComponentsSection)
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect($('[data-testid=admin-forbidden] button')).toBeNull()
  })

  it('推荐读不到:单独说明,不拖垮组件目录', async () => {
    backend({ recommend_providers: new CapabilityError('boom', 'internal', 500) })
    await open(ComponentsSection)
    expect($('[data-testid=recommendations-failed]')!.textContent).toContain('推荐暂时读不到')
    expect($('[data-testid=env-card]')).not.toBeNull()
  })

  it('「重新检测」重新读一遍', async () => {
    await open(ComponentsSection)
    $<HTMLButtonElement>('[data-testid=env-recheck]')!.click()
    await flushPromises()
    expect(calls('provider_list')).toHaveLength(2)
  })

  it('没有任何内部术语:不出现 LLM / ACP 这类词', async () => {
    await open(ComponentsSection)
    // 配置键名(code)里可以有 max_tokens 这样的英文,界面文字里不行
    const clone = document.body.cloneNode(true) as HTMLElement
    clone.querySelectorAll('code').forEach((el) => el.remove())
    expect(clone.textContent).not.toMatch(/LLM|ACP|C6|token|sidecar/i)
  })
})

describe('OCR 与转写分区', () => {
  it('两张卡:各有开关和参数(带需要重启标记)+ 本机的引擎列表', async () => {
    await open(OcrSection)
    expect($$('[data-group]').map((el) => el.getAttribute('data-group'))).toEqual(['ocr', 'transcribe'])
    expect($('[data-field="extract.ocr_enabled"] [data-testid=setting-restart]')).not.toBeNull()
    expect($('[data-field="extract.transcribe_enabled"] [data-testid=setting-restart]')).not.toBeNull()
    expect($('[data-group="ocr"] [data-provider="rapidocr"]')).not.toBeNull()
    expect($('[data-group="transcribe"] [data-provider="whisper-cli"]')).not.toBeNull()
    expect($('[data-provider="bge-m3-int8"]')).toBeNull()
  })

  it('开关和参数的改动交给页面(update 事件),这里不碰网络', async () => {
    await open(OcrSection)
    $('[data-field="extract.ocr_enabled"] [role=switch]')!.click()
    await nextTick()
    expect(wrapper!.emitted('update')![0]).toEqual(['extract.ocr_enabled', true])
    expect(calls('update_config')).toHaveLength(0)
  })

  it('OCR 引擎上的操作:已就绪的默认引擎可卸载;没装的可下载、可设为默认(灰着,先下载)', async () => {
    await open(OcrSection)
    expect(buttons('rapidocr')).toEqual(['设为默认', '卸载'])
    expect(rowOf('rapidocr').querySelector<HTMLButtonElement>('[data-testid=provider-default]')!.disabled).toBe(true)
    expect(buttons('tesseract')).toEqual(['下载', '设为默认'])
    expect(rowOf('tesseract').querySelector<HTMLButtonElement>('[data-testid=provider-default]')!.disabled).toBe(true)
  })

  it('转写引擎:只有「下载」,没有「设为默认」(后端不支持)', async () => {
    await open(OcrSection)
    expect(buttons('whisper-cli')).toEqual(['下载'])
  })

  it('下载:发请求,提示,然后读下载进度', async () => {
    await open(OcrSection)
    rowOf('tesseract').querySelector<HTMLButtonElement>('[data-testid=provider-install]')!.click()
    await flushPromises()
    expect(calls('provider_install')[0]![1]).toEqual({ kind: 'ocr', id: 'tesseract' })
    expect(toasts[0]!.message).toBe('已开始下载 tesseract。')
    expect(calls('ocr_status').length).toBeGreaterThanOrEqual(2)
  })

  it('只有一个下载入口:不再有进度卡里那个重复的「下载模型 / 运行时」按钮', async () => {
    backend({ ocr_status: { ...IDLE, install: { state: 'failed', lines: 4, tail: ['curl: (6) Could not resolve host'], error: 'exit status 6', command: 'rapidocr --install' } } })
    await open(OcrSection)
    expect(document.body.textContent).not.toContain('下载模型 / 运行时')
    const card = $('[data-testid=install-card]')!
    expect([...card.querySelectorAll('button')].map((el) => el.textContent!.trim())).toEqual(['刷新'])
  })

  it('设为默认:提示里说清要重启服务后才生效', async () => {
    backend({
      provider_list: () => ({ providers: [provider({ kind: 'ocr', id: 'rapidocr', installed: true, ready: true }), provider({ kind: 'ocr', id: 'tesseract', installed: true, ready: true, current: true })], env: ENV }),
    })
    await open(OcrSection)
    rowOf('rapidocr').querySelector<HTMLButtonElement>('[data-testid=provider-default]')!.click()
    await flushPromises()
    expect(calls('provider_set_default')[0]![1]).toEqual({ kind: 'ocr', id: 'rapidocr' })
    expect(toasts[0]!.message).toBe('已把 rapidocr 设为默认文字识别(OCR)引擎。要重启服务后才生效。')
    expect(toasts[0]!.tone).toBe('warning')
  })

  it('卸载:先确认(说清删什么、不动什么),取消就不删', async () => {
    confirmState.answer = false
    await open(OcrSection)
    rowOf('rapidocr').querySelector<HTMLButtonElement>('[data-testid=provider-uninstall]')!.click()
    await flushPromises()
    expect(confirmState.calls[0]!.title).toBe('卸载 rapidocr 的模型文件?')
    expect(confirmState.calls[0]!.message).toContain('不动系统里装的运行时')
    expect(calls('provider_uninstall')).toHaveLength(0)
    confirmState.answer = true
    rowOf('rapidocr').querySelector<HTMLButtonElement>('[data-testid=provider-uninstall]')!.click()
    await flushPromises()
    expect(calls('provider_uninstall')[0]![1]).toEqual({ kind: 'ocr', id: 'rapidocr' })
    expect(toasts[0]!.message).toBe('已清理 3 个模型文件。')
  })

  it('操作失败:原因常驻在分区里(不自动消失),不露英文异常', async () => {
    backend({ provider_install: new CapabilityError('磁盘空间不够', 'internal', 500) })
    await open(OcrSection)
    rowOf('tesseract').querySelector<HTMLButtonElement>('[data-testid=provider-install]')!.click()
    await flushPromises()
    expect($('[data-testid=provider-error]')!.textContent).toBe('下载 tesseract 失败:磁盘空间不够。请稍后重试。')
  })

  it('一键采用:只对 OCR 的推荐生效;转写的推荐只给说明', async () => {
    await open(OcrSection)
    expect($('[data-testid=recommendations-transcribe]')!.textContent).toContain('转写保持关闭')
    expect($('[data-testid=adopt]')!.textContent).toBe('采用推荐的识别引擎')
    $<HTMLButtonElement>('[data-testid=adopt]')!.click()
    await flushPromises()
    expect(calls('provider_set_default').map((call) => call[1])).toEqual([{ kind: 'ocr', id: 'tesseract' }])
    expect(toasts[0]!.message).toBe('已采用推荐的识别引擎。要重启服务后才生效。')
  })

  it('推荐都采用过了:没有「采用」按钮', async () => {
    backend({ recommend_providers: { recommendations: [{ ...RECS[0]!, already_current: true }] } })
    await open(OcrSection)
    expect($('[data-testid=adopt]')).toBeNull()
  })

  it('下载进度:没下载过就不显示这张卡', async () => {
    await open(OcrSection)
    expect($('[data-testid=install-card]')).toBeNull()
  })

  it('下载失败:说明原因和怎么重试,日志尾部留着', async () => {
    backend({ ocr_status: { ...IDLE, install: { state: 'failed', lines: 4, tail: ['curl: (6) Could not resolve host'], error: 'exit status 6', command: 'rapidocr --install' } } })
    await open(OcrSection)
    expect($('[data-testid=install-state]')!.textContent).toBe('失败')
    expect($('[data-testid=install-failure]')!.textContent).toBe('下载没有成功:exit status 6。请检查网络和磁盘空间后,点上面对应组件的「下载」重试。')
    expect($('[data-testid=install-card]')!.textContent).toContain('Could not resolve host')
  })

  it('下载中每 2 秒自动刷新;结束后重新读组件目录,不用手点刷新', async () => {
    vi.useFakeTimers()
    let state = 'running'
    backend({ ocr_status: () => ({ ...IDLE, install: { state, lines: 7, tail: [], error: null, command: 'x' } }) })
    await open(OcrSection)
    expect($('[data-testid=install-state]')!.textContent).toBe('下载中')
    expect($('[data-testid=install-card]')!.textContent).toContain('每 2 秒自动刷新')
    const before = calls('ocr_status').length
    await vi.advanceTimersByTimeAsync(2100)
    expect(calls('ocr_status').length).toBe(before + 1)
    const listed = calls('provider_list').length
    state = 'done'
    await vi.advanceTimersByTimeAsync(2100)
    await flushPromises()
    expect($('[data-testid=install-state]')!.textContent).toBe('已完成')
    expect(calls('provider_list').length).toBe(listed + 1)
    // 结束后不再轮询
    const after = calls('ocr_status').length
    await vi.advanceTimersByTimeAsync(6000)
    expect(calls('ocr_status').length).toBe(after)
  })

  it('下载进度读不到:卡片里说明 + 重试', async () => {
    backend({ ocr_status: new CapabilityError('进度文件损坏', 'internal', 500) })
    await open(OcrSection)
    expect($('[data-testid=install-error]')!.textContent).toContain('读取下载进度失败:进度文件损坏')
    expect($('[data-testid=install-error] button')!.textContent).toBe('重试')
  })

  it('读取组件目录失败:引擎列表换成报错 + 重试,但开关和参数仍然可用', async () => {
    backend({ provider_list: new CapabilityError('组件目录读不了', 'internal', 500) })
    await open(OcrSection)
    expect($('[data-testid=admin-error]')).not.toBeNull()
    expect($('[data-field="extract.ocr_enabled"] [role=switch]')).not.toBeNull()
    expect($('[data-provider]')).toBeNull()
  })
})
