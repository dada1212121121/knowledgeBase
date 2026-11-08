// 「编码代理」分区:四种状态、立即生效的权限 / 沙箱 / 默认后端(带确认)、代理表上按状态给的操作、
// 配置对话框(密钥不回显)、添加自定义代理的就近校验与确认。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const confirmState = vi.hoisted(() => ({ answer: true, calls: [] as { title: string; message?: string; tone?: string; confirmText?: string }[] }))
vi.mock('@kb-ui/index', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirm: () => ({
    ask: async (options: { title: string; message?: string; tone?: string; confirmText?: string; action?: () => Promise<unknown> }) => {
      confirmState.calls.push(options)
      if (!confirmState.answer) return false
      await options.action?.()
      return true
    },
  }),
}))
import { toasts } from '@kb-ui/components/useToast'

import { CapabilityError } from '@/api/client'
import AcpSection from './AcpSection.vue'

const agent = (extra: Record<string, unknown>) => ({ name: 'x', command: 'x', args: [], env: {}, npm: '', docs: '', env_hint: null, builtin: true, available: false, ...extra })
const AGENTS = [
  agent({ id: 'claude', name: 'Claude Code', command: 'claude-code-acp', npm: '@zed-industries/claude-code-acp@latest', available: true, env: { ANTHROPIC_API_KEY: '••••' }, env_hint: { base: 'ANTHROPIC_BASE_URL', key: 'ANTHROPIC_API_KEY', model: 'ANTHROPIC_MODEL' } }),
  agent({ id: 'codex', name: 'Codex', command: 'codex-acp', npm: '@openai/codex-acp@latest', available: false }),
  agent({ id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'], docs: 'https://example.com/gemini', available: false }),
  agent({ id: 'mine', name: '我的代理', command: '/opt/mine', args: ['--acp'], builtin: false, available: true }),
]
let settings: Record<string, unknown> = {}
let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}, tweak: Record<string, unknown> = {}) {
  settings = { permission: 'none', default: '', sandbox: true, tool_groups: ['knowledge'], agents: structuredClone(AGENTS), ...tweak }
  replies = {
    acp_agents: () => structuredClone(settings),
    acp_set_permission: (args: { permission: string }) => ((settings.permission = args.permission), { permission: args.permission }),
    acp_set_sandbox: (args: { sandbox: boolean }) => ((settings.sandbox = args.sandbox), { sandbox: args.sandbox }),
    acp_set_default: (args: { id: string }) => ((settings.default = args.id), { default: args.id }),
    acp_test: { name: 'claude-code', version: '1.2.3' },
    acp_install: { ok: true },
    acp_uninstall: { ok: true },
    acp_remove_agent: { removed: true },
    acp_save_agent: { saved: true },
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
const rowOf = (name: string) => $$('[data-testid=rt-row]').find((el) => el.textContent!.includes(name))!
const actionsOf = (name: string) => [...rowOf(name).querySelectorAll('[data-testid=acp-actions] button')].map((el) => el.textContent!.trim())
async function type(selector: string, value: string) {
  const el = $<HTMLInputElement>(selector)!
  el.value = value
  el.dispatchEvent(new Event('input'))
  await nextTick()
}
async function pick(field: string, label: string) {
  $<HTMLButtonElement>(`[data-field="${field}"] button`)!.click()
  await nextTick()
  $$('.kb-pop-item').find((el) => el.textContent!.includes(label))!.click()
  await flushPromises()
}

let wrapper: VueWrapper | null = null
async function open() {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  wrapper = mount(AcpSection, { attachTo: document.body })
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

describe('编码代理 · 四种状态', () => {
  it('加载中:骨架屏', async () => {
    backend({ acp_agents: () => new Promise(() => undefined) })
    await open()
    expect($('[data-testid=admin-loading]')).not.toBeNull()
    expect($('[data-testid=acp-settings]')).toBeNull()
  })

  it('读取失败:原因 + 重试', async () => {
    let fail = true
    backend({
      acp_agents: () => {
        if (fail) throw new CapabilityError('acp.toml 读不了', 'internal', 500)
        return structuredClone(settings)
      },
    })
    await open()
    expect($('[data-testid=admin-error]')!.textContent).toContain('读取编码代理失败:acp.toml 读不了')
    fail = false
    $('[data-testid=admin-error] button')!.click()
    await flushPromises()
    expect($('[data-testid=acp-settings]')).not.toBeNull()
  })

  it('没有开通(403):只说没开通', async () => {
    backend({ acp_agents: new CapabilityError('forbidden', 'forbidden', 403) })
    await open()
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect($('[data-testid=acp-agents]')).toBeNull()
  })

  it('空:没有代理时给说明', async () => {
    backend({}, { agents: [] })
    await open()
    expect($('[data-testid=acp-agents]')!.textContent).toContain('还没有可用的代理')
  })
})

describe('编码代理 · 运行与权限(立即生效)', () => {
  it('四项设置各自说明,并写明「改了立即生效」', async () => {
    await open()
    const card = $('[data-testid=acp-settings]')!.textContent!
    expect(card).toContain('改了立即生效,不需要点「保存」')
    for (const label of ['工具权限', '沙箱运行', '默认后端', '代理能用的工具组']) expect(card).toContain(label)
    expect($('[data-testid=acp-tool-groups]')!.textContent).toBe('knowledge')
  })

  it('改成「全部自动放行」:先确认(红色,说清能做什么),确认后才发请求', async () => {
    confirmState.answer = false
    await open()
    await pick('acp.permission', '全部自动放行')
    expect(confirmState.calls[0]).toMatchObject({ title: '全部自动放行?', tone: 'danger', confirmText: '全部放行' })
    expect(confirmState.calls[0]!.message).toContain('写文件')
    expect(calls('acp_set_permission')).toHaveLength(0)
    confirmState.answer = true
    await pick('acp.permission', '全部自动放行')
    expect(calls('acp_set_permission')[0]![1]).toEqual({ permission: 'all', confirm: true })
    expect(toasts[0]!.message).toBe('工具权限已更新。')
    expect($('[data-field="acp.permission"] button')!.textContent).toContain('全部自动放行')
  })

  it('选当前已经是的权限:什么都不发生', async () => {
    await open()
    await pick('acp.permission', '全部要确认')
    expect(confirmState.calls).toHaveLength(0)
  })

  it('关闭沙箱:红色确认,关掉后行内写明风险;重新开启后风险消失', async () => {
    await open()
    expect($('[data-testid=acp-sandbox-risk]')).toBeNull()
    $('[data-field="acp.sandbox"] [role=switch]')!.click()
    await flushPromises()
    expect(confirmState.calls[0]).toMatchObject({ title: '关闭沙箱?', tone: 'danger' })
    expect(calls('acp_set_sandbox')[0]![1]).toEqual({ sandbox: false, confirm: true })
    expect($('[data-testid=acp-sandbox-risk]')!.textContent).toContain('同权')
    $('[data-field="acp.sandbox"] [role=switch]')!.click()
    await flushPromises()
    expect(calls('acp_set_sandbox')[1]![1]).toEqual({ sandbox: true, confirm: true })
    expect($('[data-testid=acp-sandbox-risk]')).toBeNull()
  })

  it('取消确认:沙箱开关不变', async () => {
    confirmState.answer = false
    await open()
    $('[data-field="acp.sandbox"] [role=switch]')!.click()
    await flushPromises()
    expect(calls('acp_set_sandbox')).toHaveLength(0)
    expect($('[data-field="acp.sandbox"] [role=switch]')!.getAttribute('aria-checked')).toBe('true')
  })

  it('默认后端:选项是内置模型 + 已安装的代理;选了就生效,表格里标「默认」', async () => {
    await open()
    $<HTMLButtonElement>('[data-field="acp.default"] button')!.click()
    await nextTick()
    // 每个下拉的选项层都常驻在 body 上,只看当前展开的这一个
    const opened = () => $$('.kb-pop-layer[data-open="true"] .kb-pop-item')
    expect(opened().map((el) => el.textContent!.trim())).toEqual(['内置模型', 'Claude Code', '我的代理'])
    opened().find((el) => el.textContent!.includes('Claude Code'))!.click()
    await flushPromises()
    expect(calls('acp_set_default')[0]![1]).toEqual({ id: 'claude' })
    expect(toasts[0]!.message).toBe('默认后端:Claude Code。')
    expect(rowOf('Claude Code').querySelector('[data-testid=acp-default-badge]')).not.toBeNull()
  })

  it('操作失败:原因常驻在卡片里,不自动消失', async () => {
    backend({ acp_set_default: new CapabilityError('写 acp.toml 失败: 权限不够', 'internal', 500) })
    await open()
    await pick('acp.default', '我的代理')
    expect($('[data-testid=acp-error]')!.textContent).toBe('设置默认后端失败:写 acp.toml 失败: 权限不够。请稍后重试。')
  })

  it('确认文案里没有 none / all 这类配置值', async () => {
    await open()
    await pick('acp.permission', '全部自动放行')
    expect(`${confirmState.calls[0]!.title}${confirmState.calls[0]!.message}`).not.toMatch(/\b(none|all)\b/)
  })
})

describe('编码代理 · 代理表', () => {
  it('操作按状态给:已安装给「测试」「卸载」,没装的有 npm 包给「安装」,自定义的才有「删除」', async () => {
    await open()
    expect(actionsOf('Claude Code')).toEqual(['测试', '配置', '卸载'])
    expect(actionsOf('Codex')).toEqual(['安装', '配置'])
    expect(actionsOf('Gemini CLI')).toEqual(['配置'])
    expect(actionsOf('我的代理')).toEqual(['测试', '配置', '删除'])
  })

  it('没有 npm 包的内置代理:给「安装说明」链接;状态徽标区分已安装 / 未安装', async () => {
    await open()
    expect(rowOf('Gemini CLI').querySelector('a')!.getAttribute('href')).toBe('https://example.com/gemini')
    expect(rowOf('Claude Code').textContent).toContain('已安装')
    expect(rowOf('Codex').textContent).toContain('未安装')
    expect(rowOf('我的代理').textContent).toContain('自定义')
  })

  it('被选为默认却没装好的代理标红提醒', async () => {
    backend({}, { default: 'codex' })
    await open()
    expect(rowOf('Codex').textContent).toContain('未安装 · 已选为默认')
  })

  it('安装:确认框里执行(进度和失败原因都在框里),装完刷新', async () => {
    await open()
    rowOf('Codex').querySelector<HTMLButtonElement>('[data-testid=acp-install]')!.click()
    await flushPromises()
    expect(confirmState.calls[0]!.title).toBe('安装「Codex」?')
    expect(confirmState.calls[0]!.message).toContain('acp-tools')
    expect(calls('acp_install')[0]![1]).toEqual({ id: 'codex', confirm: true })
    expect(calls('acp_agents')).toHaveLength(2)
  })

  it('卸载:红色确认,说清只动 acp-tools,不是系统全局', async () => {
    await open()
    rowOf('Claude Code').querySelector<HTMLButtonElement>('[data-testid=acp-uninstall]')!.click()
    await flushPromises()
    expect(confirmState.calls[0]).toMatchObject({ title: '卸载「Claude Code」?', tone: 'danger' })
    expect(confirmState.calls[0]!.message).toContain('@zed-industries/claude-code-acp')
    expect(confirmState.calls[0]!.message).not.toContain('全局')
    expect(calls('acp_uninstall')[0]![1]).toEqual({ id: 'claude', confirm: true })
  })

  it('删除自定义代理:红色确认', async () => {
    await open()
    rowOf('我的代理').querySelector<HTMLButtonElement>('[data-testid=acp-remove]')!.click()
    await flushPromises()
    expect(confirmState.calls[0]).toMatchObject({ title: '删除代理「我的代理」?', tone: 'danger' })
    expect(calls('acp_remove_agent')[0]![1]).toEqual({ id: 'mine', confirm: true })
  })

  it('测试成功:提示;失败:原因常驻 + 怎么办', async () => {
    await open()
    rowOf('Claude Code').querySelector<HTMLButtonElement>('[data-testid=acp-test]')!.click()
    await flushPromises()
    expect(toasts[0]!.message).toBe('连接成功:claude-code 1.2.3')
    backend({ acp_test: new CapabilityError('initialize 超时', 'unavailable', 503) })
    wrapper!.unmount()
    document.body.innerHTML = ''
    await open()
    rowOf('Claude Code').querySelector<HTMLButtonElement>('[data-testid=acp-test]')!.click()
    await flushPromises()
    expect($('[data-testid=acp-error]')!.textContent).toBe('测试 Claude Code 失败:initialize 超时。请检查命令是否装好、登录态是否可用。')
  })
})

describe('编码代理 · 配置对话框', () => {
  it('打开:内置代理约定的变量先放好空行;密钥显示为 ••••(遮住)', async () => {
    await open()
    rowOf('Claude Code').querySelector<HTMLButtonElement>('[data-testid=acp-config]')!.click()
    await nextTick()
    const dialog = $('[data-testid=acp-config-dialog]')!
    expect(dialog.textContent).toContain('ANTHROPIC_BASE_URL')
    const inputs = [...dialog.querySelectorAll<HTMLInputElement>('input')]
    expect(inputs.map((el) => el.value)).toEqual(['ANTHROPIC_API_KEY', '••••', 'ANTHROPIC_BASE_URL', '', 'ANTHROPIC_MODEL', ''])
    expect(inputs[1]!.type).toBe('password')
    expect(inputs[3]!.type).toBe('text')
  })

  it('保存:••••(保持原值)原样发给后端,空串是删除,没名字的行丢掉', async () => {
    await open()
    rowOf('Claude Code').querySelector<HTMLButtonElement>('[data-testid=acp-config]')!.click()
    await nextTick()
    $('[data-testid=acp-env-add]')!.click()
    await nextTick()
    $<HTMLButtonElement>('[data-testid=acp-env-save]')!.click()
    await flushPromises()
    expect(calls('acp_save_agent')[0]![1]).toEqual({
      id: 'claude',
      name: 'Claude Code',
      command: 'claude-code-acp',
      args: [],
      env: { ANTHROPIC_API_KEY: '••••', ANTHROPIC_BASE_URL: '', ANTHROPIC_MODEL: '' },
      confirm: true,
    })
    expect($('[data-testid=acp-config-dialog]')).toBeNull()
    expect(toasts[0]!.message).toBe('代理配置已保存。')
  })

  it('保存失败:原因留在对话框里,对话框不关', async () => {
    backend({ acp_save_agent: new CapabilityError('命令不存在或不可执行: /opt/x', 'invalid_input', 400) })
    await open()
    rowOf('我的代理').querySelector<HTMLButtonElement>('[data-testid=acp-config]')!.click()
    await nextTick()
    $<HTMLButtonElement>('[data-testid=acp-env-save]')!.click()
    await flushPromises()
    expect($('[data-testid=acp-env-failure]')!.textContent).toBe('保存配置失败:命令不存在或不可执行: /opt/x。请稍后重试。')
    expect($('[data-testid=acp-config-dialog]')).not.toBeNull()
  })

  it('取消:关闭,不发请求', async () => {
    await open()
    rowOf('我的代理').querySelector<HTMLButtonElement>('[data-testid=acp-config]')!.click()
    await nextTick()
    $$('[data-testid=acp-config-dialog] button').find((el) => el.textContent!.trim() === '取消')!.click()
    await nextTick()
    expect($('[data-testid=acp-config-dialog]')).toBeNull()
    expect(calls('acp_save_agent')).toHaveLength(0)
  })
})

describe('编码代理 · 添加自定义代理', () => {
  const submit = async () => {
    $<HTMLButtonElement>('[data-testid=acp-form-submit]')!.click()
    await flushPromises()
  }

  it('没填就提交:标识和启动命令就近报错,不弹确认也不发请求', async () => {
    await open()
    await submit()
    const text = $('[data-testid=acp-add]')!.textContent!
    expect(text).toContain('请填一个标识')
    expect(text).toContain('请填启动命令')
    expect(confirmState.calls).toHaveLength(0)
    expect(calls('acp_save_agent')).toHaveLength(0)
  })

  it('填之前不提前标红(提交过一次才显示报错)', async () => {
    await open()
    await type('[data-testid=acp-form-id]', 'bad id')
    expect($('[data-testid=acp-add]')!.textContent).not.toContain('只能用字母')
    await submit()
    expect($('[data-testid=acp-add]')!.textContent).toContain('只能用字母、数字、-、_、.')
  })

  it('命令是解释器 / 标识已存在:报错', async () => {
    await open()
    await type('[data-testid=acp-form-id]', 'claude')
    await type('[data-testid=acp-form-command]', 'bash')
    await submit()
    const text = $('[data-testid=acp-add]')!.textContent!
    expect(text).toContain('已经有了')
    expect(text).toContain('不能直接用 sh / bash / env')
  })

  it('合法:先确认(说清它会被守护进程拉起、在不在沙箱里),再保存;参数按空格拆;表单清空', async () => {
    await open()
    await type('[data-testid=acp-form-id]', 'tool')
    await type('[data-testid=acp-form-command]', '/opt/tool')
    await type('[data-testid=acp-form-args]', '--acp  --verbose')
    await submit()
    expect(confirmState.calls[0]!.title).toBe('添加代理「tool」?')
    expect(confirmState.calls[0]!.message).toContain('在沙箱里')
    expect(calls('acp_save_agent')[0]![1]).toEqual({ id: 'tool', name: 'tool', command: '/opt/tool', args: ['--acp', '--verbose'], env: {}, confirm: true })
    expect($<HTMLInputElement>('[data-testid=acp-form-id]')!.value).toBe('')
    expect(calls('acp_agents')).toHaveLength(2)
  })

  it('沙箱已关闭时,确认文案点明它会和守护进程同权', async () => {
    backend({}, { sandbox: false })
    await open()
    await type('[data-testid=acp-form-id]', 'tool')
    await type('[data-testid=acp-form-command]', '/opt/tool')
    await submit()
    expect(confirmState.calls[0]!.message).toContain('同权')
  })

  it('取消确认:表单保留,什么都没保存', async () => {
    confirmState.answer = false
    await open()
    await type('[data-testid=acp-form-id]', 'tool')
    await type('[data-testid=acp-form-command]', '/opt/tool')
    await submit()
    expect(calls('acp_save_agent')).toHaveLength(0)
    expect($<HTMLInputElement>('[data-testid=acp-form-id]')!.value).toBe('tool')
  })
})
