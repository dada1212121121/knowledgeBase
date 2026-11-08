// 系统参数:AI 总开关关着时整页没有「AI」字样但还能把它打开;默认角色从角色里选;读取状态。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const roleList = vi.fn()
vi.mock('@/utils/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/adminApi')>()),
  roleList: (...a: unknown[]) => roleList(...a),
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
vi.mock('@/components/MailSettings.vue', () => ({ default: { template: '<div class="mail-stub" />' } }))

import SystemParams from './SystemParams.vue'
import KbConfirmHost from '@kb-ui/components/KbConfirmHost.vue'
import { cancelConfirm } from '@kb-ui/components/useConfirm'
import { toasts } from '@kb-ui/components/useToast'
import { CapabilityError } from '@/api/client'

const config = (ai: boolean) => ({
  ai: { enabled: ai, extract: true, deep_search: true, organize: true, assistant: true, acp: true, chunk_context: false },
  quota: { storage_gb: 100, max_upload_mb: 200, disk_reserve_gb: 30, llm_tokens_per_day: 200000, acp_concurrency_total: 4, acp_concurrency_per_user: 1, acp_minutes: 30, links_per_user: 1000, friends_per_user: 1000 },
  accounts: { registration_open: true, require_invite: false, default_role: 'role_user', email_domain_allowlist: [], block_disposable_email: false, deletion_cooling_off_days: 30, invites_per_user: 0, require_admin_totp: false },
  index: { parallel_slices: 0, parallel_files: 1 },
  network: { crawl_allow_private: false },
  share: { allow_guest_view: true, allow_guest_comment: false, allow_guest_edit: false, guest_link_gb_per_day: 5, room_max_users: 10 },
  site: { name: 'knowledgeBase', tagline: '个人与团队知识库', public_url: 'https://kb.example.com', timezone: 'Asia/Shanghai' },
})
const roles = [
  { id: 'role_user', name: '普通用户', description: '', builtin: true, all_features: false, dangerous: false, features: [], user_count: 1, quota_json: '{}' },
  { id: 'role_team', name: '编辑组', description: '', builtin: false, all_features: false, dangerous: false, features: [], user_count: 0, quota_json: '{}' },
]

let current = config(true)
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)
const text = () => document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const attrs = () => [...document.body.querySelectorAll('[title],[aria-label],[placeholder]')].map((el) => `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''}`).join(' ')

let wrapper: VueWrapper | null = null
async function open() {
  wrapper = mount(SystemParams, { attachTo: document.body })
  await flushPromises()
}
// 确认框的状态是模块级单例:没关的确认框会漏到下一个用例
afterEach(() => cancelConfirm())
beforeEach(() => {
  toasts.splice(0)
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  current = config(true)
  callCapability.mockReset().mockImplementation(async (name: string) => {
    if (name === 'get_config') {
      if (current instanceof Error) throw current
      return current
    }
    if (name === 'update_config') return { applied: true, restart_required: false, notes: [] }
    return {}
  })
  roleList.mockReset().mockResolvedValue({ roles })
})

describe('系统参数 · AI 总开关', () => {
  it('开着:完整的 AI 分区(子开关、额度)都在,额度不写 token;后端没有读取的编码代理三项不在界面上', async () => {
    await open()
    expect(text()).toContain('每人每天 AI 额度')
    expect(text()).toContain('自动提炼与审核')
    // 这三项后端能存但没有代码读取(真正限流的是 acp.toml),放在界面上会让管理员以为改了就生效
    expect(text()).not.toContain('编码代理:全站同时会话数')
    expect(text()).not.toContain('编码代理:每人同时会话数')
    expect(text()).not.toContain('编码代理:单次最长')
    expect(text()).not.toMatch(/token|LLM/i)
  })

  it('关着:整页的文字、title、aria-label、占位符都没有「AI」;只留总开关一行', async () => {
    current = config(false)
    await open()
    expect(text()).not.toMatch(/AI/)
    expect(attrs()).not.toMatch(/AI/)
    expect(text()).toContain('启用大模型功能(总开关)')
    expect(text()).not.toContain('自动提炼与审核')
    expect(text()).not.toContain('编码代理:')
    expect(text()).not.toContain('每人每天')
    expect([...document.body.querySelectorAll('.kb-sp-nav button')].map((b) => b.textContent!.trim())).toContain('大模型功能')
  })

  it('关着时能把它重新打开:提示保存之后其余设置才出现;保存只提交 ai.enabled', async () => {
    current = config(false)
    await open()
    expect($('[data-testid=ai-turning-on]')).toBeNull()
    const row = [...document.body.querySelectorAll('.kb-sp-row')].find((el) => el.textContent?.includes('启用大模型功能'))!
    ;(row.querySelector('[role=switch], .sw') as HTMLElement).click()
    await flushPromises()
    expect($('[data-testid=ai-turning-on]')?.textContent).toContain('保存之后')
    ;(document.body.querySelector('.kb-sp-save .kb-btn.is-primary') as HTMLButtonElement).click()
    await flushPromises()
    const call = callCapability.mock.calls.find((c) => c[0] === 'update_config')!
    expect(call[1]).toEqual({ patch: { ai: { enabled: true } }, confirm: true })
  })
})

describe('系统参数 · 新用户的默认角色', () => {
  it('从角色里选,显示角色名而不是 role_user;选了以后提交角色编号', async () => {
    await open()
    const select = $('select[aria-label="新用户的默认角色"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect([...select.options].map((o) => o.textContent)).toEqual(['普通用户', '编辑组'])
    expect(text()).not.toContain('role_user')
    select.value = 'role_team'
    select.dispatchEvent(new Event('change'))
    await flushPromises()
    ;(document.body.querySelector('.kb-sp-save .kb-btn.is-primary') as HTMLButtonElement).click()
    await flushPromises()
    expect(callCapability.mock.calls.find((c) => c[0] === 'update_config')![1].patch).toEqual({ accounts: { default_role: 'role_team' } })
  })

  it('读不到角色(没有「用户」功能):退回手填,页面照常打开', async () => {
    roleList.mockRejectedValue(new CapabilityError('forbidden', 'forbidden', 403))
    await open()
    expect($('select[aria-label="新用户的默认角色"]')).toBeNull()
    expect(text()).toContain('新用户的默认角色')
  })
})

describe('系统参数 · 读取状态', () => {
  it('读不到:整页写原因 + 重试,恢复后出现参数', async () => {
    current = new CapabilityError('数据库繁忙', 'internal', 500) as never
    await open()
    expect($('[data-testid=admin-error]')?.textContent).toContain('读取系统参数失败')
    current = config(true)
    $('[data-testid=admin-error]')!.querySelector<HTMLButtonElement>('button')!.click()
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
    expect(text()).toContain('开放注册')
  })
})

describe('系统参数 · 保存', () => {
  let host: VueWrapper | null = null
  afterEach(() => host?.unmount())
  const switchOf = (label: string) => (([...document.body.querySelectorAll('.kb-sp-row')].find((el) => el.textContent?.includes(label))!).querySelector('[role=switch], .sw') as HTMLElement)
  const save = () => (document.body.querySelector('.kb-sp-save .kb-btn.is-primary') as HTMLButtonElement).click()
  const confirmButton = () => $('[role=alertdialog] .kb-confirm-btn.is-danger')!
  const updateCalls = () => callCapability.mock.calls.filter((c) => c[0] === 'update_config')

  it('打开有风险的设置(允许游客编辑):先确认并写明风险;取消不保存', async () => {
    host = mount(KbConfirmHost, { attachTo: document.body })
    await open()
    switchOf('允许游客编辑').click()
    await flushPromises()
    save()
    await flushPromises()
    expect($('[role=alertdialog]')!.textContent).toContain('确认保存这些有风险的设置?')
    expect($('[role=alertdialog]')!.textContent).toContain('所有修改记在「访客」名下')
    expect(updateCalls()).toHaveLength(0)
    ;[...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === '先不保存')!.click()
    await flushPromises()
    expect(updateCalls()).toHaveLength(0)
    // 再点保存并确认:才真正提交
    save()
    await flushPromises()
    confirmButton().click()
    await flushPromises()
    expect(updateCalls()[0]![1].patch).toEqual({ share: { allow_guest_edit: true } })
  })

  it('改的是普通设置(存储配额):不弹确认,直接保存', async () => {
    host = mount(KbConfirmHost, { attachTo: document.body })
    await open()
    const input = $('input[aria-label="每人存储配额"]') as HTMLInputElement
    input.value = '500'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    save()
    await flushPromises()
    expect($('[role=alertdialog]')).toBeNull()
    expect(updateCalls()[0]![1].patch).toEqual({ quota: { storage_gb: 500 } })
  })

  it('把大模型总开关从开改成关:先确认并写明后果', async () => {
    host = mount(KbConfirmHost, { attachTo: document.body })
    await open()
    switchOf('启用 AI 功能').click()
    await flushPromises()
    save()
    await flushPromises()
    expect($('[role=alertdialog]')!.textContent).toContain('确认关闭大模型功能?')
    expect($('[role=alertdialog]')!.textContent).toContain('所有人的相关入口立刻消失')
    expect(updateCalls()).toHaveLength(0)
  })

  it('保存失败:提示条写「保存系统参数失败:原因」,不露英文', async () => {
    host = mount(KbConfirmHost, { attachTo: document.body })
    await open()
    const input = $('input[aria-label="每人存储配额"]') as HTMLInputElement
    input.value = '500'
    input.dispatchEvent(new Event('input'))
    callCapability.mockImplementation(async (name: string) => {
      if (name === 'update_config') throw new CapabilityError('配置文件被占用', 'internal', 500)
      return name === 'get_config' ? current : {}
    })
    await flushPromises()
    save()
    await flushPromises()
    expect(toasts.at(-1)?.message).toContain('保存系统参数失败:配置文件被占用')
    expect(toasts.at(-1)?.tone).toBe('danger')
  })

  it('每个输入框和开关都有名字(读屏能读出是哪一项),数字框在手机上弹数字键盘', async () => {
    await open()
    const unnamed = [...document.body.querySelectorAll('.kb-sp-row input, .kb-sp-row [role=switch]')].filter((el) => !el.getAttribute('aria-label'))
    expect(unnamed).toHaveLength(0)
    expect(($('input[aria-label="每人存储配额"]') as HTMLInputElement).getAttribute('inputmode')).toBe('numeric')
    expect(($('input[aria-label="站点名称"]') as HTMLInputElement).getAttribute('inputmode')).toBeNull()
  })
})
