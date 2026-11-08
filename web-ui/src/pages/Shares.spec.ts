// 我的分享页:四种状态(含未开通)、两个页签、多选后的批量操作(协作者 / 合集链接 / 改角色 / 移除 / 关闭 / 删除链接)。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { LinkInfo, SharedByMeItem } from '@/api/share'

const api = vi.hoisted(() => ({ sharedByMe: vi.fn(), myLinks: vi.fn(), linkUpdate: vi.fn(), linkRevoke: vi.fn(), accessRequests: vi.fn(), accessDecide: vi.fn() }))
vi.mock('@/api/share', () => api)
const replace = vi.hoisted(() => vi.fn())
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/shares', query: {}, meta: {} }),
  useRouter: () => ({ replace }),
  RouterLink: { name: 'RouterLink', props: ['to'], template: '<a class="router-link" :href="to"><slot /></a>' },
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
const confirmState = vi.hoisted(() => ({ answer: true, calls: [] as { title: string; message?: string; confirmText?: string }[] }))
vi.mock('@kb-ui/index', async (original) => {
  const real = await original<Record<string, unknown>>()
  const { ref } = await import('vue')
  return {
    ...real,
    // 手机上表格会变卡片;这里固定成桌面表格
    useMedia: () => ref(false),
    useConfirm: () => ({
      ask: async (options: { title: string; action?: () => Promise<unknown> }) => {
        confirmState.calls.push(options)
        if (!confirmState.answer) return false
        await options.action?.()
        return true
      },
    }),
  }
})
// 面板和批量对话框是别的组件的事(各有单测),这里只看页面把什么交给了它们
vi.mock('@/components/share/SharePanel.vue', () => ({
  __esModule: true,
  default: { name: 'SharePanel', props: { targets: { type: Array, default: () => [] }, initialTab: { type: String, default: '' }, link: { type: Object, default: null } }, emits: ['close', 'changed'], template: '<div class="panel-stub" :data-tab="initialTab" :data-link="link?.id ?? \'\'">{{ targets.length }}</div>' },
}))
vi.mock('@/components/share/BatchPersonDialog.vue', () => ({
  __esModule: true,
  default: { name: 'BatchPersonDialog', props: { mode: { type: String, default: '' }, items: { type: Array, default: () => [] } }, emits: ['close', 'done'], template: '<div class="bpd-stub" :data-mode="mode">{{ items.length }}</div>' },
}))

import { toasts } from '@kb-ui/components/useToast'
import Shares from './Shares.vue'
import { useSessionStore } from '@/stores/session'

const bob = { id: 'usr_bob', username: 'bob', display_name: 'Bob', avatar: null }
const carol = { id: 'usr_carol', username: 'carol', display_name: 'Carol', avatar: null }
const item = (id: string, kind: 'dir' | 'insight', grantees: SharedByMeItem['grantees']): SharedByMeItem => ({
  target: kind === 'dir' ? { kind, space_id: 'sp_me', collection: '_global', path: id } : { kind, space_id: 'sp_me', collection: '_global', id },
  key: id,
  title: id,
  grantees,
  inherit_broken: false,
})
const ITEMS = [item('运维', 'dir', [{ user: bob, role: 'editor' }, { user: carol, role: 'viewer' }]), item('ins_9', 'insight', [{ user: bob, role: 'viewer' }]), item('发布', 'dir', [])]
const link = (id: string, extra: Partial<LinkInfo> = {}): LinkInfo => ({
  id, hint: 'Zp9a', title: '', bundle: false, roots: [ITEMS[0]!.target], audience: 'logged_in', role: 'viewer', has_password: false, expires_at: null,
  allow_download: true, watermark: false, allow_reshare: false, enabled: true, state: 'active', views: 5, last_view_at: Date.now() - 60_000, created_at: 1, guest_role: null, ...extra,
})
const LINKS = [link('l1'), link('l2', { bundle: true, title: '本周评审', roots: [ITEMS[0]!.target, ITEMS[1]!.target], has_password: true }), link('l3', { enabled: false, state: 'closed', audience: 'anyone' })]

const pendingRequest = (id: string) => ({ id, key: `k${id}`, target: null, title: '部署清单', requester: bob, role: 'editor', message: null, state: 'pending', created_at: Date.now(), decided_at: null })

function signIn(features = ['collab.share']) {
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'me', display_name: '我', email: null, role_id: 'r', space_id: 'sp_me', must_change_password: false }
  session.features = new Set(features)
  session.loaded = true
}
async function mountPage() {
  const wrapper = mount(Shares, { attachTo: document.body })
  await flushPromises()
  return wrapper
}
const rowOf = (wrapper: ReturnType<typeof mount>, pane: string, text: string) => wrapper.findAll(`[data-testid=${pane}] [data-testid=rt-row]`).find((row) => row.text().includes(text))!
const check = async (wrapper: ReturnType<typeof mount>, pane: string, text: string) => {
  await rowOf(wrapper, pane, text).find('input[type=checkbox]').setValue(true)
}

beforeEach(() => {
  setActivePinia(createPinia())
  signIn()
  Object.values(api).forEach((fn) => fn.mockReset())
  replace.mockReset()
  confirmState.answer = true
  confirmState.calls = []
  api.sharedByMe.mockResolvedValue({ items: ITEMS })
  api.myLinks.mockResolvedValue({ links: LINKS })
  api.linkUpdate.mockResolvedValue({ link: LINKS[0] })
  api.linkRevoke.mockResolvedValue({ revoked: true })
  api.accessRequests.mockResolvedValue({ to_decide: [pendingRequest('r1'), pendingRequest('r2')], mine: [] })
  toasts.splice(0)
  document.body.innerHTML = ''
})

describe('状态', () => {
  it('没有 collab.share:显示未开通,不去取数据', async () => {
    signIn([])
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid=feature-off]').text()).toContain('你的账号没有开通这个功能,请联系管理员')
    expect(api.sharedByMe).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid=shares-items]').exists()).toBe(false)
  })

  it('加载中:骨架屏', async () => {
    api.sharedByMe.mockReturnValue(new Promise(() => undefined))
    const wrapper = mount(Shares)
    await flushPromises()
    expect(wrapper.find('[data-testid=shares-items] [aria-busy=true]').exists()).toBe(true)
  })

  it('空:两个页签各给一个去知识库的下一步', async () => {
    api.sharedByMe.mockResolvedValue({ items: [] })
    api.myLinks.mockResolvedValue({ links: [] })
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid=shares-items-empty]').text()).toContain('你还没有分享过内容')
    expect(wrapper.find('[data-testid=shares-items-empty] a').attributes('href')).toBe('/kb')
    expect(wrapper.find('[data-testid=shares-links-empty]').text()).toContain('你还没有创建过分享链接')
  })

  it('报错:分页签说明、可重试,一个页签坏了不影响另一个', async () => {
    api.sharedByMe.mockRejectedValueOnce({ status: 500, message: 'internal: boom' })
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid=shares-items-error]').text()).toContain('没有加载出来')
    expect(wrapper.find('[data-testid=shares-items-error]').text()).not.toContain('boom')
    expect(wrapper.findAll('[data-testid=shares-links] [data-testid=rt-row]')).toHaveLength(3)
    await wrapper.find('[data-testid=shares-items-error] button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid=shares-items] [data-testid=rt-row]')).toHaveLength(3)
  })
})

describe('访问申请页签', () => {
  it('页签上显示等我处理的数量;?tab=requests 的深链不在这里测(路由由页面读取)', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('[role=tablist]').text()).toContain('访问申请')
    expect(wrapper.find('[role=tablist]').text()).toContain('2')
    expect(wrapper.find('[data-testid=shares-requests]').exists()).toBe(true)
  })

  it('没有待处理的申请时页签上不挂数字', async () => {
    api.accessRequests.mockResolvedValue({ to_decide: [], mine: [] })
    const wrapper = await mountPage()
    expect(wrapper.find('[role=tablist]').text()).toMatch(/访问申请\s*$/)
  })
})

describe('列表', () => {
  it('分享出去的:名称 / 类型 / 协作者摘要 / 继承;页签上有数量', async () => {
    const wrapper = await mountPage()
    const first = rowOf(wrapper, 'shares-items', '运维')
    expect(first.text()).toContain('文件夹')
    expect(first.text()).toContain('Bob、Carol')
    expect(first.text()).not.toContain('2 人')
    expect(first.text()).toContain('继承上级')
    expect(rowOf(wrapper, 'shares-items', '发布').text()).toContain('还没有协作者')
    expect(wrapper.find('[role=tablist]').text()).toContain('3')
  })

  it('分享链接:范围 + 角色、状态、有没有密码、访问量;合集标明几项;已撤销的不列', async () => {
    api.myLinks.mockResolvedValue({ links: [...LINKS, link('l4', { state: 'revoked' })] })
    const wrapper = await mountPage()
    const rows = wrapper.findAll('[data-testid=shares-links] [data-testid=rt-row]')
    expect(rows).toHaveLength(3)
    const bundle = rowOf(wrapper, 'shares-links', '本周评审')
    expect(bundle.text()).toContain('合集 · 2 项')
    expect(bundle.text()).toContain('有密码')
    expect(bundle.text()).toContain('5 次')
    expect(rowOf(wrapper, 'shares-links', '已关闭').text()).toContain('任何人(含游客) · 可查看')
    expect(wrapper.text()).toContain('完整的链接地址只在创建或重置时显示一次')
  })

  it('点「管理」打开分享面板:单个资源在协作者页,链接在链接页(带上这条链接)', async () => {
    const wrapper = await mountPage()
    await rowOf(wrapper, 'shares-items', 'ins_9').find('button[aria-label^="管理分享"]').trigger('click')
    expect(wrapper.find('.panel-stub').attributes('data-tab')).toBe('people')
    await wrapper.find('.panel-stub').trigger('click')
    wrapper.findComponent({ name: 'SharePanel' }).vm.$emit('close')
    await flushPromises()
    expect(wrapper.find('.panel-stub').exists()).toBe(false)
    await rowOf(wrapper, 'shares-links', '本周评审').find('button[aria-label^="管理链接"]').trigger('click')
    expect(wrapper.find('.panel-stub').attributes('data-tab')).toBe('link')
    expect(wrapper.find('.panel-stub').attributes('data-link')).toBe('l2')
    expect(wrapper.find('.panel-stub').text()).toBe('2')
  })

  it('关掉面板后重读两个列表(里面可能改了协作者 / 链接)', async () => {
    const wrapper = await mountPage()
    await rowOf(wrapper, 'shares-items', 'ins_9').find('button[aria-label^="管理分享"]').trigger('click')
    wrapper.findComponent({ name: 'SharePanel' }).vm.$emit('close')
    await flushPromises()
    expect(api.sharedByMe).toHaveBeenCalledTimes(2)
    expect(api.myLinks).toHaveBeenCalledTimes(2)
  })
})

describe('批量:分享出去的', () => {
  it('多选后出现批量条;添加协作者 → 面板带全部选中项(协作者页);合集链接要选 ≥2 项(链接页)', async () => {
    const wrapper = await mountPage()
    await check(wrapper, 'shares-items', '运维')
    expect(wrapper.find('[data-testid=batchbar]').text()).toContain('已选 1 项')
    expect(wrapper.find('[data-testid=shares-bundle]').exists()).toBe(false)
    await check(wrapper, 'shares-items', 'ins_9')
    await wrapper.find('[data-testid=shares-add]').trigger('click')
    expect(wrapper.find('.panel-stub').attributes('data-tab')).toBe('people')
    expect(wrapper.find('.panel-stub').text()).toBe('2')
    wrapper.findComponent({ name: 'SharePanel' }).vm.$emit('close')
    await flushPromises()
    await wrapper.find('[data-testid=shares-bundle]').trigger('click')
    expect(wrapper.find('.panel-stub').attributes('data-tab')).toBe('link')
  })

  it('改角色 / 移除协作者 → 批量对话框拿到选中的项;做完清空选择并重读', async () => {
    const wrapper = await mountPage()
    await check(wrapper, 'shares-items', '运维')
    await check(wrapper, 'shares-items', 'ins_9')
    await wrapper.find('[data-testid=shares-role]').trigger('click')
    expect(wrapper.find('.bpd-stub').attributes('data-mode')).toBe('role')
    expect(wrapper.find('.bpd-stub').text()).toBe('2')
    wrapper.findComponent({ name: 'BatchPersonDialog' }).vm.$emit('done')
    wrapper.findComponent({ name: 'BatchPersonDialog' }).vm.$emit('close')
    await flushPromises()
    expect(wrapper.find('[data-testid=batchbar]').exists()).toBe(false)
    expect(api.sharedByMe).toHaveBeenCalledTimes(2)
    await check(wrapper, 'shares-items', '运维')
    await wrapper.find('[data-testid=shares-remove]').trigger('click')
    expect(wrapper.find('.bpd-stub').attributes('data-mode')).toBe('remove')
  })
})

describe('批量:分享链接', () => {
  it('关闭链接:先确认并写明后果;只对还开着的发 link_update(enabled:false)', async () => {
    const wrapper = await mountPage()
    await check(wrapper, 'shares-links', '本周评审')
    await check(wrapper, 'shares-links', '已关闭')
    await wrapper.find('[data-testid=links-close]').trigger('click')
    await flushPromises()
    expect(confirmState.calls[0]).toMatchObject({ title: '关闭 1 条分享链接?', confirmText: '关闭链接' })
    expect(confirmState.calls[0]!.message).toContain('暂时打不开')
    expect(api.linkUpdate).toHaveBeenCalledTimes(1)
    expect(api.linkUpdate).toHaveBeenCalledWith({ id: 'l2', enabled: false })
    expect(api.myLinks).toHaveBeenCalledTimes(2)
  })

  it('选中的都已经关闭:直接告诉他,不弹确认也不发请求', async () => {
    const wrapper = await mountPage()
    await check(wrapper, 'shares-links', '已关闭')
    await wrapper.find('[data-testid=links-close]').trigger('click')
    await flushPromises()
    expect(confirmState.calls).toHaveLength(0)
    expect(api.linkUpdate).not.toHaveBeenCalled()
  })

  it('删除链接:红色确认写明永久失效、不影响已加入的协作者;逐条 link_revoke', async () => {
    const wrapper = await mountPage()
    await check(wrapper, 'shares-links', '本周评审')
    await check(wrapper, 'shares-links', '已关闭')
    await wrapper.find('[data-testid=links-delete]').trigger('click')
    await flushPromises()
    expect(confirmState.calls[0]).toMatchObject({ title: '删除 2 条分享链接?', confirmText: '删除链接' })
    expect(confirmState.calls[0]!.message).toContain('永久失效')
    expect(confirmState.calls[0]!.message).toContain('协作者不受影响')
    expect(api.linkRevoke.mock.calls.map(([id]) => id).sort()).toEqual(['l2', 'l3'])
  })

  it('用户取消:什么都不做', async () => {
    confirmState.answer = false
    const wrapper = await mountPage()
    await check(wrapper, 'shares-links', '本周评审')
    await wrapper.find('[data-testid=links-delete]').trigger('click')
    await flushPromises()
    expect(api.linkRevoke).not.toHaveBeenCalled()
  })

  it('部分失败:如实说成功几条、失败几条(含原因),不整体报成功', async () => {
    api.linkRevoke.mockResolvedValueOnce({ revoked: true }).mockRejectedValueOnce({ status: 403, message: 'forbidden: 你对这个内容的权限是「可编辑」,需要「可管理」' })
    const wrapper = await mountPage()
    await check(wrapper, 'shares-links', '本周评审')
    await check(wrapper, 'shares-links', '已关闭')
    await wrapper.find('[data-testid=links-delete]').trigger('click')
    await flushPromises()
    expect(api.linkRevoke).toHaveBeenCalledTimes(2)
    expect(toasts[0]).toMatchObject({ tone: 'danger', message: '1 条已处理,1 条没有成功:你对这个内容的权限是「可编辑」,需要「可管理」' })
  })
})
