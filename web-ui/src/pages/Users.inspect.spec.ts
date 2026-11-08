// 「查看知识库」入口:独立功能点 + 部署开关双门控;自己的行不给入口;点开的是只读查看弹窗。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const alice = { id: 'usr_alice', username: 'alice', email: null, display_name: 'Alice', role_id: 'role_user', status: 'active', avatar: null, last_login_at: null }
const me = { ...alice, id: 'usr_me', username: 'me', display_name: '我' }

vi.mock('@/utils/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/adminApi')>()),
  featureCatalog: vi.fn(async () => ({ features: [] })),
  roleList: vi.fn(async () => ({ roles: [] })),
  userList: vi.fn(async () => ({ users: [me, alice], total: 2, page: 1, page_size: 30 })),
  userGet: vi.fn(async () => ({ user: alice, space: null, overrides: [], effective_features: [] })),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/admin/users', query: {}, meta: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div><slot /></div>' } }))
vi.mock('@/components/InviteManager.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/admin/AdminSpaceViewer.vue', () => ({
  default: {
    props: ['userId', 'name'],
    emits: ['close'],
    template: '<div data-testid="viewer">{{ userId }}|{{ name }}</div>',
  },
}))

import Users from './Users.vue'
import { useSessionStore } from '@/stores/session'

const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)

async function openUsers() {
  const wrapper = mount(Users, { attachTo: document.body })
  await flushPromises()
  await wrapper.findAll('.kb-ut-tabs button').find((tab) => tab.text() === '用户')!.trigger('click')
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'me', display_name: '我', email: null, role_id: 'role_admin', space_id: 'sp_primary', must_change_password: false } as never
  session.loaded = true
})

describe('Users:查看他人知识库', () => {
  it('有 sys.inspect 才显示;点开传给弹窗的是目标用户,不打开详情', async () => {
    const session = useSessionStore()
    session.features = new Set(['sys.inspect'])
    const wrapper = await openUsers()

    expect($('[data-testid=user-inspect-usr_me]')).toBeNull()
    const button = $('[data-testid=user-inspect-usr_alice]')
    expect(button).not.toBeNull()
    button!.click()
    await nextTick()
    await flushPromises()
    expect($('[data-testid=viewer]')?.textContent).toContain('usr_alice|Alice')
    // 行本身还是打开详情,「查看」不应把详情也带出来
    expect(document.body.textContent).not.toContain('单独调整功能')
    wrapper.unmount()
  })

  it('没有功能点或部署开关关掉时不显示入口', async () => {
    const session = useSessionStore()
    session.features = new Set(['sys.users'])
    const wrapper = await openUsers()
    expect($('[data-testid=user-inspect-usr_alice]')).toBeNull()
    wrapper.unmount()

    session.features = new Set(['sys.inspect'])
    session.inspectEnabled = false
    const second = await openUsers()
    expect($('[data-testid=user-inspect-usr_alice]')).toBeNull()
    second.unmount()
  })
})
