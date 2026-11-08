// 访问申请:列表、同意(可改角色)、拒绝(要确认)、被别人先处理、四种状态、我发出的。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { AccessRequestRow } from '@/api/share'

const api = vi.hoisted(() => ({ accessRequests: vi.fn(), accessDecide: vi.fn() }))
vi.mock('@/api/share', () => api)
const confirmState = vi.hoisted(() => ({ answer: true, calls: [] as { title: string; message?: string; tone?: string }[] }))
vi.mock('@kb-ui/index', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirm: () => ({
    ask: async (options: { title: string }) => {
      confirmState.calls.push(options)
      return confirmState.answer
    },
  }),
}))
import { toasts } from '@kb-ui/components/useToast'
import AccessRequestList from './AccessRequestList.vue'

const bob = { id: 'usr_bob', username: 'bob', display_name: 'Bob', avatar: null }
const carol = { id: 'usr_carol', username: 'carol', display_name: 'Carol', avatar: null }
const row = (id: string, extra: Partial<AccessRequestRow> = {}): AccessRequestRow => ({
  id,
  key: `k${id}`,
  target: { kind: 'insight', space_id: 'sp_me', collection: '_global', id: 'ins_1' },
  title: '部署清单',
  requester: bob,
  role: 'editor',
  message: null,
  state: 'pending',
  created_at: Date.now() - 5 * 60_000,
  decided_at: null,
  ...extra,
})

async function mountList() {
  const wrapper = mount(AccessRequestList, { attachTo: document.body })
  await flushPromises()
  return wrapper
}
const selectOf = (wrapper: ReturnType<typeof mount>, id: string) => wrapper.find(`[data-testid="request-role-${id}"]`).findComponent({ name: 'KbSelect' })

beforeEach(() => {
  setActivePinia(createPinia())
  api.accessRequests.mockReset()
  api.accessDecide.mockReset()
  api.accessRequests.mockResolvedValue({ to_decide: [row('r1', { message: '想补充回滚步骤' }), row('r2', { requester: carol, role: 'viewer', target: { kind: 'dir', space_id: 'sp_me', collection: '_global', path: '运维' }, title: '运维' })], mine: [] })
  api.accessDecide.mockResolvedValue({ state: 'approved', role: 'editor' })
  confirmState.answer = true
  confirmState.calls = []
  toasts.splice(0)
  document.body.innerHTML = ''
})

describe('等我处理', () => {
  it('每条:谁、申请什么权限、什么内容(类型)、附言;并把数量报给上层', async () => {
    const wrapper = await mountList()
    const first = wrapper.find('[data-testid="request-r1"]')
    expect(first.text()).toContain('Bob')
    expect(first.text()).toContain('申请「可编辑」权限')
    expect(first.text()).toContain('部署清单')
    expect(first.text()).toContain('笔记')
    expect(first.find('[data-testid=request-message]').text()).toBe('「想补充回滚步骤」')
    expect(wrapper.find('[data-testid="request-r2"]').text()).toContain('文件夹')
    expect(wrapper.find('[data-testid="request-r2"] [data-testid=request-message]').exists()).toBe(false)
    expect(wrapper.emitted('count')![0]).toEqual([2])
  })

  it('同意:默认按对方申请的角色;可以改成别的角色再同意', async () => {
    const wrapper = await mountList()
    expect(selectOf(wrapper, 'r1').props('modelValue')).toBe('editor')
    expect(selectOf(wrapper, 'r2').props('modelValue')).toBe('viewer')
    await wrapper.find('[data-testid="request-approve-r2"]').trigger('click')
    await flushPromises()
    expect(api.accessDecide).toHaveBeenLastCalledWith('r2', true, 'viewer')
    selectOf(wrapper, 'r1').vm.$emit('update:modelValue', 'commenter')
    await flushPromises()
    await wrapper.find('[data-testid="request-approve-r1"]').trigger('click')
    await flushPromises()
    expect(api.accessDecide).toHaveBeenLastCalledWith('r1', true, 'commenter')
    expect(toasts[0]!.message).toContain('Bob现在是「可评论」')
    expect(api.accessRequests).toHaveBeenCalledTimes(3) // 开始 + 每次处理后重读
  })

  it('拒绝:先确认并写明 24 小时内不能再申请;确认后 approve:false(不带角色)', async () => {
    const wrapper = await mountList()
    await wrapper.find('[data-testid="request-reject-r1"]').trigger('click')
    await flushPromises()
    expect(confirmState.calls[0]).toMatchObject({ title: '拒绝 Bob 的申请?', tone: 'danger' })
    expect(confirmState.calls[0]!.message).toContain('24 小时')
    expect(api.accessDecide).toHaveBeenCalledWith('r1', false, undefined)
  })

  it('用户在确认框里取消:不拒绝', async () => {
    confirmState.answer = false
    const wrapper = await mountList()
    await wrapper.find('[data-testid="request-reject-r1"]').trigger('click')
    await flushPromises()
    expect(api.accessDecide).not.toHaveBeenCalled()
  })

  it('被别人先处理了(404):这一行写明原因,并重读列表;不吞掉错误', async () => {
    api.accessDecide.mockRejectedValueOnce({ status: 404, message: 'not found: 没有这条待处理的申请' })
    api.accessRequests.mockResolvedValueOnce({ to_decide: [row('r1'), row('r2')], mine: [] }).mockResolvedValueOnce({ to_decide: [row('r1')], mine: [] })
    const wrapper = await mountList()
    await wrapper.find('[data-testid="request-approve-r2"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="request-r2"]').exists()).toBe(false)
    expect(api.accessRequests).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('count')!.at(-1)).toEqual([1])
  })

  it('超过自己能授予的上限(403):写在这一行,留着重选', async () => {
    api.accessDecide.mockRejectedValueOnce({ status: 403, message: 'forbidden: 你最多只能授予「可编辑」' })
    const wrapper = await mountList()
    await wrapper.find('[data-testid="request-approve-r1"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="request-error-r1"]').text()).toBe('你最多只能授予「可编辑」')
    expect(wrapper.find('[data-testid="request-r1"]').exists()).toBe(true)
  })
})

describe('状态与我发出的', () => {
  it('加载中:骨架屏;报错:可重试;空:解释什么时候会有', async () => {
    api.accessRequests.mockReturnValueOnce(new Promise(() => undefined))
    const loading = mount(AccessRequestList)
    await flushPromises()
    expect(loading.find('[aria-busy=true]').exists()).toBe(true)

    api.accessRequests.mockRejectedValueOnce({ status: 500, message: 'internal: x' })
    const failed = await mountList()
    expect(failed.find('[data-testid=requests-error]').text()).toContain('没有加载出来')
    await failed.find('[data-testid=requests-error] button').trigger('click')
    await flushPromises()
    expect(failed.find('[data-testid="request-r1"]').exists()).toBe(true)

    api.accessRequests.mockResolvedValue({ to_decide: [], mine: [] })
    const empty = await mountList()
    expect(empty.find('[data-testid=requests-empty]').text()).toContain('现在没有等你处理的申请')
    expect(empty.find('[data-testid=requests-mine-empty]').text()).toContain('申请编辑')
    expect(empty.emitted('count')![0]).toEqual([0])
  })

  it('我发出的:三种状态各有文字(不只靠颜色),处理过的写明多久前处理', async () => {
    api.accessRequests.mockResolvedValue({
      to_decide: [],
      mine: [row('m1'), row('m2', { state: 'approved', decided_at: Date.now() - 60 * 60_000 }), row('m3', { state: 'rejected', decided_at: Date.now() - 2 * 60_000, role: 'viewer' })],
    })
    const wrapper = await mountList()
    expect(wrapper.find('[data-testid=mine-m1]').text()).toContain('等待处理')
    expect(wrapper.find('[data-testid=mine-m2]').text()).toContain('已通过')
    expect(wrapper.find('[data-testid=mine-m3]').text()).toContain('已拒绝')
    expect(wrapper.find('[data-testid=mine-m3]').text()).toContain('申请「可查看」')
    expect(wrapper.find('[data-testid=mine-m2]').text()).toContain('处理')
  })
})
