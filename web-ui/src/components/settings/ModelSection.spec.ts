// 「模型」分区:服务商下拉(来自后端目录)、换服务商时接口地址跟着换、密钥(保存 / 二次确认清除)、连接测试、目录读取的三种非正常状态。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const confirmState = vi.hoisted(() => ({ answer: true, calls: [] as { title: string; message?: string; confirmText?: string }[] }))
vi.mock('@kb-ui/index', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirm: () => ({
    ask: async (options: { title: string; message?: string; confirmText?: string; action?: () => Promise<unknown> }) => {
      confirmState.calls.push(options)
      if (!confirmState.answer) return false
      await options.action?.()
      return true
    },
  }),
}))
import { toasts } from '@kb-ui/components/useToast'

import { CapabilityError } from '@/api/client'
import { toDraft, type Draft } from '@/utils/settingsFields'
import type { LlmCatalog } from '@/utils/settingsModel'
import ModelSection from './ModelSection.vue'

const CATALOG: LlmCatalog = {
  current: 'deepseek',
  secret_present: true,
  providers: [
    { id: 'deepseek', name: 'DeepSeek', env_var: 'DEEPSEEK_API_KEY', base_url: 'https://api.deepseek.com', configured: true, current: true, model: 'deepseek-chat', note: null, supported: true },
    { id: 'openai', name: 'OpenAI', env_var: 'OPENAI_API_KEY', base_url: 'https://api.openai.com/v1', configured: false, current: false, model: null, note: null, supported: true },
    { id: 'anthropic', name: 'Anthropic', env_var: 'ANTHROPIC_API_KEY', base_url: 'https://api.anthropic.com', configured: false, current: false, model: null, note: '不支持直连', supported: false },
  ],
}
const CONFIG = {
  llm: { provider: 'deepseek', base_url: 'https://api.deepseek.com', extract_model: 'm1', review_model: 'm2', agent_model: 'm3', daily_token_budget: 2000000, max_calls_per_hour: 60 },
  evolution: { extract_enabled_default: false, dedup_similarity: 0.92 },
}

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  replies = { llm_providers: () => structuredClone(CATALOG), set_llm_key: { secret_present: true }, test_llm: { reply: '你好!' }, ...overrides }
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
const byId = (id: string) => $<HTMLButtonElement>(`[data-testid=${id}]`)!
async function typeKey(value: string) {
  const el = byId('llm-key-input') as unknown as HTMLInputElement
  el.value = value
  el.dispatchEvent(new Event('input'))
  await nextTick()
}
async function remount(options: Parameters<typeof open>[0] = {}) {
  wrapper?.unmount()
  document.body.innerHTML = ''
  await open(options)
}

let wrapper: VueWrapper | null = null
let updates: [string, string | boolean][] = []
async function open(options: { unsaved?: boolean; draft?: Draft } = {}) {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  updates = []
  wrapper = mount(ModelSection, {
    attachTo: document.body,
    props: {
      draft: options.draft ?? toDraft(CONFIG),
      errors: {},
      unsaved: options.unsaved ?? false,
      onUpdate: (path: string, value: string | boolean) => updates.push([path, value]),
    },
  })
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

describe('模型分区 · 字段', () => {
  it('内置模型 / 密钥与连接测试 / 费用保护 / 网页 AI 规范化 / 自动提炼五张卡,按这个顺序', async () => {
    await open()
    expect($$('[data-group]').map((el) => el.getAttribute('data-group'))).toEqual(['llm', 'llm-key', 'cost', 'web_extract', 'evolution'])
  })

  it('服务商是下拉,选项来自后端目录(不支持直连的不列)', async () => {
    await open()
    $<HTMLButtonElement>('[data-field="llm.provider"] button')!.click()
    await nextTick()
    expect($$('.kb-pop-item').map((el) => el.textContent!.trim())).toEqual(['DeepSeek', 'OpenAI'])
  })

  it('换服务商:接口地址还是旧服务商的默认地址,就一起换成新服务商的默认地址', async () => {
    await open()
    $<HTMLButtonElement>('[data-field="llm.provider"] button')!.click()
    await nextTick()
    $$('.kb-pop-item').find((el) => el.textContent!.includes('OpenAI'))!.click()
    await nextTick()
    expect(updates).toEqual([
      ['llm.provider', 'openai'],
      ['llm.base_url', 'https://api.openai.com/v1'],
    ])
  })

  it('换服务商:接口地址是用户自己填的(代理 / 私有部署),不动它', async () => {
    const draft = toDraft({ ...CONFIG, llm: { ...CONFIG.llm, base_url: 'https://proxy.example.com/v1' } })
    await open({ draft })
    $<HTMLButtonElement>('[data-field="llm.provider"] button')!.click()
    await nextTick()
    $$('.kb-pop-item').find((el) => el.textContent!.includes('OpenAI'))!.click()
    await nextTick()
    expect(updates).toEqual([['llm.provider', 'openai']])
  })

  it('目录读不到时,服务商退回文本框,字段仍可编辑', async () => {
    backend({ llm_providers: new CapabilityError('boom', 'internal', 500) })
    await open()
    expect($('[data-field="llm.provider"] input')).not.toBeNull()
  })
})

describe('模型分区 · 密钥', () => {
  it('已保存 / 未保存的状态;环境变量的说明', async () => {
    await open()
    expect(byId('llm-key-state').textContent).toBe('已保存密钥')
    expect($('[data-testid=llm-key-card]')!.textContent).toContain('会读环境变量 DEEPSEEK_API_KEY')
    backend({ llm_providers: () => ({ ...CATALOG, secret_present: false }) })
    await remount()
    expect(byId('llm-key-state').textContent).toBe('还没有保存密钥')
    expect($('[data-testid=llm-key-clear]')).toBeNull()
  })

  it('输入框是空的时候「保存密钥」置灰(以前留空点保存会静默清掉密钥)', async () => {
    await open()
    expect(byId('llm-key-save').disabled).toBe(true)
    await typeKey('   ')
    expect(byId('llm-key-save').disabled).toBe(true)
    byId('llm-key-save').click()
    await flushPromises()
    expect(calls('set_llm_key')).toHaveLength(0)
  })

  it('保存密钥:发去掉首尾空白的密钥,清空输入框,提示,并重新读状态', async () => {
    await open()
    await typeKey('  sk-test  ')
    byId('llm-key-save').click()
    await flushPromises()
    expect(calls('set_llm_key')[0]![1]).toEqual({ api_key: 'sk-test', confirm: true })
    expect((byId('llm-key-input') as unknown as HTMLInputElement).value).toBe('')
    expect(toasts[0]!.message).toBe('密钥已保存。')
    expect(calls('llm_providers')).toHaveLength(2)
  })

  it('保存密钥失败:原因常驻在卡片里,输入的内容保留', async () => {
    backend({ set_llm_key: new CapabilityError('写入 secrets.toml 失败: 权限不够', 'internal', 500) })
    await open()
    await typeKey('sk-test')
    byId('llm-key-save').click()
    await flushPromises()
    expect(byId('llm-key-failure').textContent).toBe('保存密钥失败:写入 secrets.toml 失败: 权限不够。请稍后重试。')
    expect((byId('llm-key-input') as unknown as HTMLInputElement).value).toBe('sk-test')
  })

  it('清除密钥要二次确认,说清后果;取消就什么都不做', async () => {
    confirmState.answer = false
    await open()
    byId('llm-key-clear').click()
    await flushPromises()
    expect(confirmState.calls[0]!.title).toBe('清除已保存的密钥?')
    expect(confirmState.calls[0]!.message).toContain('无法调用模型')
    expect(calls('set_llm_key')).toHaveLength(0)
    confirmState.answer = true
    byId('llm-key-clear').click()
    await flushPromises()
    expect(calls('set_llm_key')[0]![1]).toEqual({ api_key: '', confirm: true })
  })
})

describe('模型分区 · 连接测试', () => {
  it('成功:结果就近显示,带上模型的回复', async () => {
    await open()
    byId('llm-test').click()
    await flushPromises()
    expect(byId('llm-test-result').textContent).toBe('连接成功,模型回复:你好!')
    expect(byId('llm-test-result').getAttribute('role')).toBe('status')
  })

  it('失败:两句话(原因 + 怎么办),role=alert,不自动消失', async () => {
    backend({ test_llm: new CapabilityError('当前服务商没有 API key:先保存密钥,或设置对应的环境变量', 'invalid_input', 400) })
    await open()
    byId('llm-test').click()
    await flushPromises()
    expect(byId('llm-test-result').textContent).toBe('测试连接失败:当前服务商没有 API key:先保存密钥,或设置对应的环境变量。请检查密钥、接口地址和模型名后重试。')
    expect(byId('llm-test-result').getAttribute('role')).toBe('alert')
  })

  it('页面上有没保存的模型改动:说明测试用的是已保存的设置', async () => {
    await open({ unsaved: true })
    expect($('[data-testid=llm-test-unsaved]')!.textContent).toContain('测试用的是已保存的设置')
    await remount({ unsaved: false })
    expect($('[data-testid=llm-test-unsaved]')).toBeNull()
  })
})

describe('模型分区 · 服务商目录的三种非正常状态', () => {
  it('加载中:骨架屏', async () => {
    backend({ llm_providers: () => new Promise(() => undefined) })
    await open()
    expect($('[data-testid=llm-key-card] [role=status][aria-busy=true]')).not.toBeNull()
    expect($('[data-testid=llm-key-state]')).toBeNull()
  })

  it('读取失败:卡片里说清出了什么事 + 重试;上面的字段不受影响', async () => {
    let fail = true
    backend({
      llm_providers: () => {
        if (fail) throw new CapabilityError('目录文件损坏', 'internal', 500)
        return structuredClone(CATALOG)
      },
    })
    await open()
    expect(byId('llm-catalog-error').textContent).toContain('读取服务商信息失败:目录文件损坏')
    expect($('[data-field="llm.extract_model"] input')).not.toBeNull()
    fail = false
    byId('llm-catalog-error').querySelector('button')!.click()
    await flushPromises()
    expect($('[data-testid=llm-catalog-error]')).toBeNull()
    expect(byId('llm-key-state').textContent).toBe('已保存密钥')
  })

  it('没有开通:只说没开通,没有密钥表单', async () => {
    backend({ llm_providers: new CapabilityError('forbidden', 'forbidden', 403) })
    await open()
    expect(byId('llm-catalog-forbidden').textContent).toContain('请联系管理员')
    expect($('[data-testid=llm-key-input]')).toBeNull()
  })
})
