// 协作者页:列表(继承来源、通过链接加入)、添加(好友优先 / 精确查找)、改角色、移除、停止继承、多选合并,以及四种状态。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { GrantList, GrantRow, PublicProfile, ShareTarget } from '@/api/share'

const api = vi.hoisted(() => ({
  grantList: vi.fn(),
  grantSet: vi.fn(),
  grantRemove: vi.fn(),
  grantBatch: vi.fn(),
  setInherit: vi.fn(),
  friendList: vi.fn(),
  friendSearch: vi.fn(),
}))
vi.mock('@/api/share', () => api)
const ask = vi.hoisted(() => vi.fn(async (_options: { confirmText?: string; tone?: string }) => true))
vi.mock('@kb-ui/index', async (original) => ({ ...(await original<Record<string, unknown>>()), useConfirm: () => ({ ask }) }))

import ShareCollaborators from './ShareCollaborators.vue'
import { useSessionStore } from '@/stores/session'

const person = (id: string, name = id): PublicProfile => ({ id, username: id, display_name: name, avatar: null })
const note: ShareTarget = { kind: 'insight', space_id: 'sp_me', collection: '_global', id: 'ins_1' }
const dirA: ShareTarget = { kind: 'dir', space_id: 'sp_me', collection: '_global', path: 'a' }
const dirB: ShareTarget = { kind: 'dir', space_id: 'sp_me', collection: '_global', path: 'b' }
const row = (user: PublicProfile, role: GrantRow['role'], extra: Partial<GrantRow> = {}): GrantRow => ({
  user, role, inherited: false, source: 'insight', via: 'direct', expires_at: null, ...extra,
})
const list = (target: ShareTarget, grants: GrantRow[], extra: Partial<GrantList> = {}): GrantList => ({
  target, key: 'k', my_role: 'owner', owner: person('usr_me', '我'), inherit_broken: false, grants, ...extra,
})

function signIn() {
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'me', display_name: '我', email: null, role_id: 'r', space_id: 'sp_me', must_change_password: false }
  session.loaded = true
}

async function mountPanel(targets: ShareTarget[] = [note]) {
  const wrapper = mount(ShareCollaborators, { props: { targets }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
const text = (wrapper: ReturnType<typeof mount>) => wrapper.text()

beforeEach(() => {
  setActivePinia(createPinia())
  signIn()
  for (const fn of Object.values(api)) fn.mockReset()
  ask.mockReset()
  ask.mockResolvedValue(true)
  api.friendList.mockResolvedValue({ friends: [{ ...person('zhangsan', '张三'), remark: null, group_name: null, since: 1 }, { ...person('lisi', '李四'), remark: '老李', group_name: null, since: 1 }] })
  api.grantList.mockResolvedValue(list(note, []))
  api.grantSet.mockResolvedValue({ grant: {}, previous: null })
  api.grantRemove.mockResolvedValue({ removed: 'viewer' })
  api.grantBatch.mockResolvedValue({ changed: 1, unchanged: 0, removed: 0 })
  api.setInherit.mockResolvedValue({ inherit: false })
  document.body.innerHTML = ''
})

describe('四种状态', () => {
  it('加载中显示骨架屏', async () => {
    api.grantList.mockReturnValue(new Promise(() => undefined))
    const wrapper = mount(ShareCollaborators, { props: { targets: [note] } })
    await flushPromises()
    expect(wrapper.find('[role=status][aria-busy=true]').exists()).toBe(true)
  })

  it('没有协作者:空状态给下一步', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid=share-empty]').text()).toContain('还没有协作者')
    expect(wrapper.find('[data-testid=share-empty]').text()).toContain('用户名或邮箱')
  })

  it('加载失败:说清楚发生了什么,点重试再取一次', async () => {
    api.grantList.mockRejectedValueOnce({ status: 500, message: 'internal: boom' })
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid=share-error]').text()).toContain('没有加载出来')
    expect(text(wrapper)).not.toContain('boom')
    await wrapper.find('[data-testid=share-error] button').trigger('click')
    await flushPromises()
    expect(api.grantList).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid=share-error]').exists()).toBe(false)
  })

  it('没有权限(后端对看不见的资源回 404,权限不够回 403):显示无权限而不是报错', async () => {
    for (const status of [404, 403]) {
      api.grantList.mockRejectedValueOnce({ status, message: 'forbidden: 需要「可管理」' })
      const wrapper = await mountPanel()
      expect(wrapper.find('[data-testid=share-denied]').exists()).toBe(true)
      expect(wrapper.find('[data-testid=share-add-input]').exists()).toBe(false)
      wrapper.unmount()
    }
  })
})

describe('列表', () => {
  it('所有者、直接协作者、继承来的(标明来自哪个文件夹且不能改)、通过链接加入的', async () => {
    api.grantList.mockResolvedValue(
      list(note, [
        row(person('bob', 'Bob'), 'editor'),
        row(person('carol', 'Carol'), 'viewer', { inherited: true, source: 'dir:sp_me/_global/%E8%BF%90%E7%BB%B4' }),
        row(person('dave', 'Dave'), 'commenter', { via: 'link:lnk_1' }),
      ]),
    )
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid=share-owner]').text()).toContain('我(你)')
    expect(wrapper.find('[data-testid=share-owner]').text()).toContain('所有者')
    const carol = wrapper.find('[data-testid=share-row-carol]')
    expect(carol.find('[data-testid=share-inherited]').text()).toBe('继承自 文件夹「运维」')
    // 继承来的:角色只读、没有移除按钮
    expect(carol.find('.kb-select').exists()).toBe(false)
    expect(carol.text()).toContain('可查看')
    expect(carol.find('button').exists()).toBe(false)
    expect(wrapper.find('[data-testid=share-row-dave]').text()).toContain('通过链接加入')
    // 直接授权的:有角色下拉和移除
    const bob = wrapper.find('[data-testid=share-row-bob]')
    expect(bob.find('.kb-select').exists()).toBe(true)
    expect(bob.find('button[aria-label="移除 Bob"]').exists()).toBe(true)
    expect(text(wrapper)).toContain('来自上级文件夹的权限在这里不能单独降低')
  })

  it('改角色 → grant_set;移除 → grant_remove;之后重读列表', async () => {
    api.grantList.mockResolvedValue(list(note, [row(person('bob', 'Bob'), 'editor')]))
    const wrapper = await mountPanel()
    const select = wrapper.find('[data-testid=share-row-bob]').findComponent({ name: 'KbSelect' })
    select.vm.$emit('update:modelValue', 'viewer')
    await flushPromises()
    expect(api.grantSet).toHaveBeenCalledWith(note, 'bob', 'viewer')
    await wrapper.find('button[aria-label="移除 Bob"]').trigger('click')
    await flushPromises()
    expect(api.grantRemove).toHaveBeenCalledWith(note, 'bob')
    expect(api.grantList.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('改角色失败:提示原因,列表重读回服务器上的真实状态', async () => {
    api.grantList.mockResolvedValue(list(note, [row(person('bob', 'Bob'), 'editor')]))
    api.grantSet.mockRejectedValueOnce({ status: 403, message: 'forbidden: 你最多只能授予「可编辑」' })
    const wrapper = await mountPanel()
    wrapper.find('[data-testid=share-row-bob]').findComponent({ name: 'KbSelect' }).vm.$emit('update:modelValue', 'manager')
    await flushPromises()
    expect(api.grantList).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid=share-row-bob]').text()).toContain('可编辑')
  })
})

describe('角色上限:最多授予与自己相同的角色,所有者也只到「可管理」', () => {
  it('所有者 / 可管理:四档;下拉里没有「所有者」', async () => {
    api.grantList.mockResolvedValue(list(note, [], { my_role: 'owner' }))
    const wrapper = await mountPanel()
    const select = wrapper.findAllComponents({ name: 'KbSelect' })[0]!
    expect((select.props('options') as { value: string }[]).map((o) => o.value)).toEqual(['viewer', 'commenter', 'editor', 'manager'])
  })

  it('(防御)我的角色不到「可管理」却拿到了名单:不渲染添加表单,只留说明——不能出现空的角色下拉', async () => {
    api.grantList.mockResolvedValue(list(note, [], { my_role: 'editor' }))
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid=share-no-grant]').text()).toContain('需要「可管理」')
    expect(wrapper.find('[data-testid=share-lookup]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=share-add-input]').exists()).toBe(false)
    expect(wrapper.findAllComponents({ name: 'KbSelect' })).toHaveLength(0)
  })

  it('后端回 403(可编辑不能管理协作者):无权限状态里写明服务端给的原因;404 则用统一说明', async () => {
    api.grantList.mockRejectedValueOnce({ status: 403, message: 'forbidden: 你对这个内容的权限是「可编辑」,需要「可管理」' })
    const forbidden = await mountPanel()
    expect(forbidden.find('[data-testid=share-denied]').text()).toContain('你对这个内容的权限是「可编辑」,需要「可管理」')
    api.grantList.mockRejectedValueOnce({ status: 404, message: 'not found: 没有找到这个内容' })
    const hidden = await mountPanel()
    expect(hidden.find('[data-testid=share-denied]').text()).toContain('只有所有者和「可管理」的人能添加或移除协作者')
    expect(hidden.find('[data-testid=share-denied]').text()).not.toContain('没有找到这个内容')
  })
})

describe('添加协作者', () => {
  it('好友捷径:点一位好友 → 选中 → 添加;已经是协作者的人不再出现在捷径里', async () => {
    api.grantList.mockResolvedValue(list(note, [row(person('zhangsan', '张三'), 'viewer')]))
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid=share-friend-zhangsan]').exists()).toBe(false)
    await wrapper.find('[data-testid=share-friend-lisi]').trigger('click')
    expect(wrapper.find('[data-testid=share-picked]').text()).toContain('老李')
    await wrapper.find('[data-testid=share-add-submit]').trigger('click')
    await flushPromises()
    expect(api.grantSet).toHaveBeenCalledWith(note, 'lisi', 'viewer')
    expect(wrapper.find('[data-testid=share-picked]').exists()).toBe(false)
  })

  it('输入完整用户名:服务端找到就选中;找不到给人话,不泄露对方存不存在', async () => {
    api.friendSearch.mockResolvedValueOnce({ user: person('carol', 'Carol'), relation: 'none' })
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid=share-add-input]').setValue('carol')
    await wrapper.find('[data-testid=share-lookup]').trigger('click')
    await flushPromises()
    expect(api.friendSearch).toHaveBeenCalledWith('carol')
    expect(wrapper.find('[data-testid=share-picked]').text()).toContain('Carol')

    api.friendSearch.mockResolvedValueOnce({ user: null, relation: 'none' })
    await wrapper.find('.kb-share-link').trigger('click') // 换一个人
    await wrapper.find('[data-testid=share-add-input]').setValue('nobody')
    await wrapper.find('[data-testid=share-lookup]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=share-add-error]').text()).toContain('没有找到这个用户')
    expect(wrapper.find('[data-testid=share-add-error]').text()).toContain('完整的用户名或邮箱')
  })

  it('输入的正好是好友的用户名:不去服务端搜(省一次限频的搜索)', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid=share-add-input]').setValue('ZhangSan')
    await wrapper.find('[data-testid=share-lookup]').trigger('click')
    await flushPromises()
    expect(api.friendSearch).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid=share-picked]').text()).toContain('张三')
  })

  it('不能分享给自己', async () => {
    api.friendSearch.mockResolvedValueOnce({ user: person('usr_me', '我'), relation: 'none' })
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid=share-add-input]').setValue('me')
    await wrapper.find('[data-testid=share-lookup]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=share-add-error]').text()).toContain('不能分享给自己')
    expect(wrapper.find('[data-testid=share-picked]').exists()).toBe(false)
  })

  it('添加失败:就近显示服务端的话(去掉英文前缀),不关面板', async () => {
    api.grantSet.mockRejectedValueOnce({ status: 404, message: 'not found: 没有找到这个用户' })
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid=share-friend-lisi]').trigger('click')
    await wrapper.find('[data-testid=share-add-submit]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=share-add-error]').text()).toBe('没有找到这个用户')
    expect(wrapper.find('[data-testid=share-picked]').exists()).toBe(true)
  })
})

describe('停止继承', () => {
  it('文件夹和文档有开关,打开 = set_inherit(inherit:false);集合没有这一项', async () => {
    api.grantList.mockResolvedValue(list(note, []))
    const wrapper = await mountPanel()
    const sw = wrapper.find('[data-testid=share-inherit] [role=switch]')
    expect(sw.attributes('aria-checked')).toBe('false')
    await sw.trigger('click')
    await flushPromises()
    expect(api.setInherit).toHaveBeenCalledWith(note, false)
    wrapper.unmount()

    const collection: ShareTarget = { kind: 'collection', collection: 'c' }
    api.grantList.mockResolvedValue(list(collection, []))
    const other = await mountPanel([collection])
    expect(other.find('[data-testid=share-inherit]').exists()).toBe(false)
  })

  it('已经停止继承:开关是开的;再点一下恢复继承', async () => {
    api.grantList.mockResolvedValue(list(dirA, [], { inherit_broken: true }))
    const wrapper = await mountPanel([dirA])
    const sw = wrapper.find('[data-testid=share-inherit] [role=switch]')
    expect(sw.attributes('aria-checked')).toBe('true')
    await sw.trigger('click')
    await flushPromises()
    expect(api.setInherit).toHaveBeenCalledWith(dirA, true)
  })
})

describe('多选分享', () => {
  beforeEach(() => {
    api.grantList.mockImplementation(async (target: ShareTarget) =>
      target.path === 'a'
        ? list(dirA, [row(person('bob', 'Bob'), 'editor'), row(person('carol', 'Carol'), 'viewer')])
        : list(dirB, [row(person('bob', 'Bob'), 'editor')]),
    )
  })

  it('列出选了什么;各项角色一致显示该角色,不一致 / 只在部分项上显示「各项不同」', async () => {
    const wrapper = await mountPanel([dirA, dirB])
    expect(wrapper.find('[data-testid=share-selected]').text()).toContain('已选 2 项')
    expect(wrapper.find('[data-testid=share-selected]').text()).toContain('2 个文件夹')
    expect(wrapper.find('[data-testid=share-row-bob]').text()).toContain('可编辑')
    expect(wrapper.find('[data-testid=share-row-carol]').text()).toContain('各项不同')
    // 多选不显示单个的「所有者」行和停止继承开关
    expect(wrapper.find('[data-testid=share-owner]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=share-inherit]').exists()).toBe(false)
  })

  it('添加 / 改角色 / 移除都走 grant_batch,写到每一项;移除要先确认并写明后果', async () => {
    const wrapper = await mountPanel([dirA, dirB])
    await wrapper.find('[data-testid=share-friend-lisi]').trigger('click')
    await wrapper.find('[data-testid=share-add-submit]').trigger('click')
    await flushPromises()
    expect(api.grantBatch).toHaveBeenLastCalledWith([dirA, dirB], [{ user_id: 'lisi', role: 'viewer' }])
    wrapper.find('[data-testid=share-row-carol]').findComponent({ name: 'KbSelect' }).vm.$emit('update:modelValue', 'editor')
    await flushPromises()
    expect(api.grantBatch).toHaveBeenLastCalledWith([dirA, dirB], [{ user_id: 'carol', role: 'editor' }])
    await wrapper.find('button[aria-label="移除 Carol"]').trigger('click')
    await flushPromises()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]![0]).toMatchObject({ confirmText: '移除', tone: 'danger' })
    expect(api.grantBatch).toHaveBeenLastCalledWith([dirA, dirB], [{ user_id: 'carol' }])
    expect(api.grantSet).not.toHaveBeenCalled()
  })

  it('用户在确认框里选了取消:不移除', async () => {
    ask.mockResolvedValueOnce(false)
    const wrapper = await mountPanel([dirA, dirB])
    await wrapper.find('button[aria-label="移除 Carol"]').trigger('click')
    await flushPromises()
    expect(api.grantBatch).not.toHaveBeenCalled()
  })

  it('文件夹和文件混选:把「分享文件夹 = 以后新增的也可见」说清楚', async () => {
    const file: ShareTarget = { kind: 'file', space_id: 'sp_me', collection: '_global', path: 'x.md' }
    api.grantList.mockImplementation(async (target: ShareTarget) => list(target, []))
    const mixed = await mountPanel([dirA, file])
    expect(mixed.find('[data-testid=share-folder-note]').text()).toContain('以后在里面新建的文档对方自动可见')
    expect(mixed.find('[data-testid=share-folder-note]').text()).toContain('只分享其中的文件')
  })

  it('选得太多(超过逐项查询的上限):只查前 30 项,并明说,角色上限交给后端把关', async () => {
    const many = Array.from({ length: 45 }, (_, index): ShareTarget => ({ kind: 'file', space_id: 'sp_me', collection: '_global', path: `f${index}.md` }))
    api.grantList.mockImplementation(async (target: ShareTarget) => list(target, []))
    const wrapper = await mountPanel(many)
    expect(api.grantList).toHaveBeenCalledTimes(30)
    expect(wrapper.find('[data-testid=share-unlisted]').text()).toContain('前 30 项')
    expect(wrapper.find('[data-testid=share-unlisted]').text()).toContain('全部 45 项')
  })
})
