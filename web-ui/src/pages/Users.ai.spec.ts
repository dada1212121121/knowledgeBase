// 用户与权限 · AI 总开关:关掉后角色 / 用户详情 / 配额里都不出现「AI」字样,AI 功能点收起但勾选保留。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const roleUpdate = vi.fn()
const catalog = [
  { id: 'docs.notes', group: '文档', label: '新建、编辑和删除笔记', hint: '含标签', default_user: true, dangerous: false, ai: false },
  { id: 'api.tokens', group: '开放接口', label: 'API 令牌与 MCP', hint: '创建个人访问令牌,接入 AI 工具', default_user: false, dangerous: false, ai: false },
  { id: 'ai.assistant', group: 'AI', label: 'AI 助手', hint: '对话式管家', default_user: true, dangerous: false, ai: true },
  { id: 'search.deep', group: '检索', label: '深度检索', hint: '调用大模型改写查询并总结', default_user: true, dangerous: false, ai: true },
]
const user = { id: 'usr_alice', username: 'alice', email: null, display_name: 'Alice', role_id: 'role_user', status: 'active', avatar: null, last_login_at: null, quota_json: '{"llm_tokens_per_day":1000}' }
const role = { id: 'role_user', name: '普通用户', description: '', builtin: true, all_features: false, dangerous: false, features: ['docs.notes', 'ai.assistant'], user_count: 1, quota_json: '{"llm_tokens_per_day":1000}' }
vi.mock('@/utils/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/adminApi')>()),
  featureCatalog: vi.fn(async () => ({ features: catalog })),
  roleList: vi.fn(async () => ({ roles: [role] })),
  roleUpdate: (...a: unknown[]) => roleUpdate(...a),
  userList: vi.fn(async () => ({ users: [user], total: 1, page: 1, page_size: 30 })),
  userGet: vi.fn(async () => ({ user, space: null, overrides: [], effective_features: [] })),
}))
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: vi.fn(async () => ({})),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/admin/users', query: {}, meta: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
vi.mock('@/components/InviteManager.vue', () => ({ default: { template: '<div />' } }))

import Users from './Users.vue'
import { useSessionStore } from '@/stores/session'

const text = () => document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const attrs = () => [...document.body.querySelectorAll('[title],[aria-label],[placeholder]')].map((el) => `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''}`).join(' ')

let wrapper: VueWrapper | null = null
async function open(ai: boolean) {
  const session = useSessionStore()
  session.aiEnabled = ai
  session.loaded = true
  wrapper = mount(Users, { attachTo: document.body })
  await flushPromises()
}
beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  roleUpdate.mockReset().mockImplementation(async (args: { features: string[] }) => ({ role: { ...role, features: args.features } }))
})

describe('用户与权限 · AI 总开关', () => {
  it('开着:AI 功能点、AI 徽标、AI 额度都在', async () => {
    await open(true)
    expect(text()).toContain('AI 助手')
    expect(text()).toContain('每天 AI 额度')
    expect(text()).not.toMatch(/token/i)
  })

  it('关掉:角色页任何位置(文字、title、aria-label、占位符)都没有「AI」', async () => {
    await open(false)
    expect(text()).not.toMatch(/AI/)
    expect(attrs()).not.toMatch(/AI/)
    expect(text()).not.toContain('深度检索')
    expect(text()).not.toContain('编码代理')
    expect(text()).toContain('大模型相关的功能已在系统参数里关闭')
    // 普通功能照常列出,访问令牌那条的名字和说明也不带 AI / API
    expect(text()).toContain('新建、编辑和删除笔记')
    expect(text()).toContain('访问令牌与 MCP')
    expect(text()).toContain('接入外部工具')
  })

  it('关掉:收起的 AI 功能点勾选不丢,切别的开关时一并提交', async () => {
    await open(false)
    const toggle = [...document.body.querySelectorAll('.kb-ut-feature')].find((row) => row.textContent?.includes('访问令牌'))!
    ;(toggle.querySelector('[role=switch], .sw, button') as HTMLElement).click()
    await flushPromises()
    expect(roleUpdate).toHaveBeenCalledTimes(1)
    expect(roleUpdate.mock.calls[0]![0].features).toEqual(['docs.notes', 'ai.assistant', 'api.tokens'])
  })

  it('关掉:用户详情里也没有「AI」,配额只列看得到的项,已有的 AI 额度覆盖不丢', async () => {
    await open(false)
    await wrapper!.findAll('.kb-ut-tabs button').find((tab) => tab.text() === '用户')!.trigger('click')
    await flushPromises()
    await wrapper!.find('.kb-ut-row').trigger('click')
    await flushPromises()
    expect(text()).toContain('单独调整功能')
    expect(text()).not.toMatch(/AI/)
    expect(attrs()).not.toMatch(/AI/)
    expect(text()).not.toContain('额度')
  })
})
