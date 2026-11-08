// 共享给我的工作区:来源与角色、只读 + 申请编辑、已申请状态、文件夹里逐级打开、离开前确认、继续分享。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ShareAccess, SharedWithMeItem, ShareTarget } from '@/api/share'

const api = vi.hoisted(() => ({ accessRequests: vi.fn() }))
vi.mock('@/api/share', async (original) => ({ ...(await original<Record<string, unknown>>()), accessRequests: api.accessRequests }))
const ask = vi.hoisted(() => vi.fn(async (_options: { title: string }) => true))
vi.mock('@kb-ui/index', async (original) => ({ ...(await original<Record<string, unknown>>()), useConfirm: () => ({ ask }) }))

// 子组件换成桩:这里只测编排
const docState = vi.hoisted(() => ({ dirty: false }))
vi.mock('./SharedDoc.vue', async () => {
  const { defineComponent, h } = await import('vue')
  type PropType<T> = import('vue').PropType<T>
  return {
    __esModule: true,
    default: defineComponent({
      props: { target: { type: Object as PropType<ShareTarget>, required: true }, access: { type: Object as PropType<ShareAccess>, required: true }, myId: { type: String, default: '' } },
      setup(props, { expose }) {
        expose({ get dirty() { return docState.dirty } })
        return () => h('div', { class: 'doc-stub', 'data-space': props.access.rawUrl('c', 'p') }, `${props.target.kind}:${props.target.id ?? props.target.path}`)
      },
    }),
  }
})
vi.mock('./SharedFolder.vue', () => ({
  __esModule: true,
  default: { props: ['target'], emits: ['open'], template: `<div class="folder-stub"><button class="open-note" @click="$emit('open', { kind: 'insight', space_id: 'sp_a', collection: '_global', id: 'n9' }, '子笔记')">打开子笔记</button>{{ target.kind }}</div>` },
}))
vi.mock('./RequestAccessDialog.vue', () => ({ __esModule: true, default: { props: ['target', 'title', 'currentRole'], emits: ['close', 'sent'], template: `<div class="req-stub" :data-title="title" :data-role="currentRole"><button class="req-send" @click="$emit('sent', 'editor')">发</button></div>` } }))
vi.mock('./SharePanel.vue', () => ({ __esModule: true, default: { props: ['targets'], emits: ['close'], template: '<div class="share-stub">{{ targets.length }}</div>' } }))

import SharedWorkspace from './SharedWorkspace.vue'
import { useSessionStore } from '@/stores/session'

const alice = { id: 'usr_a', username: 'alice', display_name: 'Alice', avatar: null }
const note: SharedWithMeItem = {
  target: { kind: 'insight', space_id: 'sp_alice', collection: '_global', id: 'ins_1' },
  key: 'doc:sp_alice/_global/i/ins_1',
  title: '部署清单',
  role: 'viewer',
  owner: alice,
  shared_at: 1,
  expires_at: null,
  hidden: false,
}
const folder: SharedWithMeItem = { ...note, target: { kind: 'dir', space_id: 'sp_alice', collection: '_global', path: 'docs' }, key: 'dir:sp_alice/_global/docs', title: 'docs', role: 'editor' }

function signIn(features = ['collab.share']) {
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'me', display_name: '我', email: null, role_id: 'r', space_id: 'sp_me', must_change_password: false }
  session.features = new Set(features)
  session.loaded = true
}
async function mountWs(item: SharedWithMeItem, props: Record<string, unknown> = {}) {
  const wrapper = mount(SharedWorkspace, { props: { item, ...props }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  signIn()
  api.accessRequests.mockReset()
  api.accessRequests.mockResolvedValue({ to_decide: [], mine: [] })
  ask.mockReset()
  ask.mockResolvedValue(true)
  docState.dirty = false
  document.body.innerHTML = ''
})

describe('来源与角色', () => {
  it('写明是谁分享的和我的权限;文档走对方的知识库(原件地址带 space)', async () => {
    const wrapper = await mountWs(note)
    expect(wrapper.find('.kb-sws-from').text()).toBe('来自 Alice')
    expect(wrapper.find('[data-testid=shared-role]').text()).toBe('可查看')
    expect(wrapper.find('.doc-stub').text()).toBe('insight:ins_1')
    expect(wrapper.find('.doc-stub').attributes('data-space')).toContain('space=sp_alice')
  })

  it('只读:显示「只读」和「申请编辑」,点它打开申请对话框(带我现在的角色);可编辑:都不显示', async () => {
    const wrapper = await mountWs(note)
    expect(wrapper.find('[data-testid=shared-readonly]').text()).toBe('只读')
    await wrapper.find('[data-testid=shared-request]').trigger('click')
    expect(wrapper.find('.req-stub').attributes('data-role')).toBe('viewer')
    expect(wrapper.find('.req-stub').attributes('data-title')).toBe('部署清单')
    const editable = await mountWs({ ...note, role: 'editor' })
    expect(editable.find('[data-testid=shared-readonly]').exists()).toBe(false)
    expect(editable.find('[data-testid=shared-request]').exists()).toBe(false)
  })

  it('已经发出过申请:按钮变成「已申请,等待处理」且不能再点;发送成功后立刻变', async () => {
    api.accessRequests.mockResolvedValue({ to_decide: [], mine: [{ id: 'r1', state: 'pending', target: note.target }] })
    const pending = await mountWs(note)
    expect(pending.find('[data-testid=shared-requested]').attributes('disabled')).toBeDefined()
    expect(pending.find('[data-testid=shared-request]').exists()).toBe(false)

    api.accessRequests.mockResolvedValue({ to_decide: [], mine: [{ id: 'r0', state: 'rejected', target: note.target }] })
    const wrapper = await mountWs(note)
    await wrapper.find('[data-testid=shared-request]').trigger('click')
    await wrapper.find('.req-send').trigger('click')
    expect(wrapper.find('[data-testid=shared-requested]').exists()).toBe(true)
  })

  it('取不到申请记录:照常允许申请(后端会拦住 24 小时内的重复申请)', async () => {
    api.accessRequests.mockRejectedValue({ status: 500 })
    const wrapper = await mountWs(note)
    expect(wrapper.find('[data-testid=shared-request]').exists()).toBe(true)
  })

  it('「移出列表」交给上层;只有最外层有', async () => {
    const wrapper = await mountWs(note)
    await wrapper.find('[data-testid=shared-hide-one]').trigger('click')
    expect(wrapper.emitted('hide')![0]![0]).toMatchObject({ key: note.key })
  })

  it('可管理且有分享功能才能继续分享;没有功能点不显示', async () => {
    const manager = { ...note, role: 'manager' as const }
    const wrapper = await mountWs(manager)
    await wrapper.find('[data-testid=shared-share]').trigger('click')
    expect(wrapper.find('.share-stub').exists()).toBe(true)
    expect((await mountWs({ ...note, role: 'editor' })).find('[data-testid=shared-share]').exists()).toBe(false)
    signIn([])
    expect((await mountWs(manager)).find('[data-testid=shared-share]').exists()).toBe(false)
  })
})

describe('文件夹里逐级打开', () => {
  it('文件夹显示列表;点一篇进入它,面包屑和「上一级」都能回来', async () => {
    const wrapper = await mountWs(folder)
    expect(wrapper.find('.folder-stub').exists()).toBe(true)
    await wrapper.find('.open-note').trigger('click')
    await flushPromises()
    expect(wrapper.find('.doc-stub').text()).toBe('insight:n9')
    expect(wrapper.find('.kb-sws-crumb').text()).toContain('docs')
    expect(wrapper.find('.kb-sws-crumb').text()).toContain('子笔记')
    // 进了子文档:不再出现「移出列表」(那是对整份共享的操作)
    expect(wrapper.find('[data-testid=shared-hide-one]').exists()).toBe(false)
    await wrapper.find('[data-testid=shared-back]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.folder-stub').exists()).toBe(true)
  })

  it('子文档里的权限沿用这份共享的角色:可编辑的文件夹里不出现「只读」', async () => {
    const wrapper = await mountWs(folder)
    await wrapper.find('.open-note').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=shared-readonly]').exists()).toBe(false)
  })

  it('有未保存的修改时离开要确认;选「继续编辑」就留下', async () => {
    const wrapper = await mountWs(folder)
    await wrapper.find('.open-note').trigger('click')
    await flushPromises()
    docState.dirty = true
    ask.mockResolvedValueOnce(false)
    await wrapper.find('[data-testid=shared-back]').trigger('click')
    await flushPromises()
    expect(ask.mock.calls[0]![0].title).toBe('放弃未保存的修改?')
    expect(wrapper.find('.doc-stub').exists()).toBe(true)
    await wrapper.find('[data-testid=shared-back]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.folder-stub').exists()).toBe(true)
  })

  it('窄屏:最外层有「列表」返回键,点它回到侧栏列表', async () => {
    const wrapper = await mountWs(note, { narrow: true })
    expect(wrapper.find('[data-testid=shared-back]').text()).toContain('列表')
    await wrapper.find('[data-testid=shared-back]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('back')).toHaveLength(1)
    expect((await mountWs(note)).find('[data-testid=shared-back]').exists()).toBe(false)
  })

  it('换一份共享:回到它的最外层', async () => {
    const wrapper = await mountWs(folder)
    await wrapper.find('.open-note').trigger('click')
    await flushPromises()
    await wrapper.setProps({ item: note })
    await flushPromises()
    expect(wrapper.find('.doc-stub').text()).toBe('insight:ins_1')
    expect(wrapper.find('.kb-sws-crumb').exists()).toBe(false)
  })
})
