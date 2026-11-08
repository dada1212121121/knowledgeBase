// 分享治理面板:四种状态、筛选、强制撤销(二次确认、撤销后刷新、失败提示)、分页。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { AdminLink, AdminLinkPage } from '@/api/usage'

const shareAdminList = vi.fn<(page: number, size: number) => Promise<AdminLinkPage>>()
const shareAdminRevoke = vi.fn<(id: string) => Promise<{ revoked: boolean }>>()
vi.mock('@/api/usage', () => ({
  SHARE_ADMIN_PAGE_SIZE: 50,
  shareAdminList: (page: number, size: number) => shareAdminList(page, size),
  shareAdminRevoke: (id: string) => shareAdminRevoke(id),
}))
const ask = vi.fn<(options: { title: string; message?: string }) => Promise<boolean>>()
vi.mock('@kb-ui/index', async (importOriginal) => ({ ...(await importOriginal<typeof import('@kb-ui/index')>()), useConfirm: () => ({ ask }) }))

import ShareAdminPanel from './ShareAdminPanel.vue'

const person = (username: string, name: string | null) => ({ id: `usr_${username}`, username, display_name: name, avatar: null })
const link = (id: string, extra: Partial<AdminLink> = {}): AdminLink => ({
  id: `lnk_${id}`,
  hint: id,
  kind: 'insight',
  audience: 'anyone',
  role: 'viewer',
  has_password: false,
  state: 'active',
  views: 5,
  last_view_at: Date.now() - 3_600_000,
  created_at: Date.now() - 86_400_000,
  creator: person('alice', 'Alice'),
  owner: person('alice', 'Alice'),
  ...extra,
})
const page = (links: AdminLink[], total = links.length): AdminLinkPage => ({ links, total, page: 1, page_size: 50 })
const apiError = (message: string, status: number) => Object.assign(new Error(message), { status })
const owners = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('[data-testid="rt-row"] .kb-su-owner b').map((el) => el.text())

const LINKS = [link('aa11'), link('bb22', { owner: person('zhangsan', '张三'), creator: person('zhangsan', '张三'), has_password: true }), link('cc33', { owner: null, creator: null, state: 'revoked' })]

beforeEach(() => {
  shareAdminList.mockReset()
  shareAdminRevoke.mockReset()
  ask.mockReset()
})

describe('ShareAdminPanel', () => {
  it('加载中是骨架屏;报错有重试;无权限不给重试', async () => {
    shareAdminList.mockReturnValue(new Promise(() => undefined))
    expect(mount(ShareAdminPanel).find('[data-testid="admin-loading"]').exists()).toBe(true)

    shareAdminList.mockReset()
    shareAdminList.mockRejectedValueOnce(apiError('出错了', 500)).mockResolvedValueOnce(page(LINKS))
    const wrapper = mount(ShareAdminPanel)
    await flushPromises()
    await wrapper.find('[data-testid="admin-error"] button').trigger('click')
    await flushPromises()
    expect(owners(wrapper)).toContain('张三')

    shareAdminList.mockReset()
    shareAdminList.mockRejectedValue(apiError('没有权限', 403))
    const denied = mount(ShareAdminPanel)
    await flushPromises()
    expect(denied.find('[data-testid="admin-forbidden"] button').exists()).toBe(false)
  })

  it('空:还没有人创建链接,说明下一步', async () => {
    shareAdminList.mockResolvedValue(page([]))
    const wrapper = mount(ShareAdminPanel)
    await flushPromises()
    expect(wrapper.find('[data-testid="share-admin-empty"]').text()).toContain('还没有人创建过分享链接')
  })

  it('列表:账号已删除显示「已删除的账号」;有密码标「有密码」,无密码且任何人能开标「无密码」;已撤销的没有撤销按钮', async () => {
    shareAdminList.mockResolvedValue(page(LINKS))
    const wrapper = mount(ShareAdminPanel)
    await flushPromises()
    const rows = wrapper.findAll('[data-testid="rt-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.text()).toContain('无密码')
    expect(rows[1]!.text()).toContain('有密码')
    expect(rows[2]!.text()).toContain('已删除的账号')
    expect(rows[2]!.find('[data-testid="share-admin-revoke"]').exists()).toBe(false)
    expect(rows[0]!.find('[data-testid="share-admin-revoke"]').exists()).toBe(true)
  })

  it('撤销要先确认:点「先不撤销」不发请求;确认后发请求并刷新', async () => {
    shareAdminList.mockResolvedValue(page(LINKS))
    shareAdminRevoke.mockResolvedValue({ revoked: true })
    const wrapper = mount(ShareAdminPanel)
    await flushPromises()
    const button = wrapper.findAll('[data-testid="rt-row"]')[0]!.find('[data-testid="share-admin-revoke"]')

    ask.mockResolvedValueOnce(false)
    await button.trigger('click')
    await flushPromises()
    expect(shareAdminRevoke).not.toHaveBeenCalled()
    expect(ask.mock.calls[0]![0].message).toContain('审计')

    ask.mockResolvedValueOnce(true)
    const calls = shareAdminList.mock.calls.length
    await button.trigger('click')
    await flushPromises()
    expect(shareAdminRevoke).toHaveBeenCalledWith('lnk_aa11')
    expect(shareAdminList.mock.calls.length).toBe(calls + 1)
  })

  it('撤销失败:提示原因,列表不动', async () => {
    shareAdminList.mockResolvedValue(page(LINKS))
    shareAdminRevoke.mockRejectedValue(apiError('没有这个链接', 404))
    ask.mockResolvedValue(true)
    const wrapper = mount(ShareAdminPanel)
    await flushPromises()
    const calls = shareAdminList.mock.calls.length
    await wrapper.findAll('[data-testid="rt-row"]')[0]!.find('[data-testid="share-admin-revoke"]').trigger('click')
    await flushPromises()
    expect(shareAdminList.mock.calls.length).toBe(calls)
    expect(owners(wrapper)).toHaveLength(3)
  })

  it('按所有者筛选,筛完没有结果时给「清除筛选」', async () => {
    shareAdminList.mockResolvedValue(page(LINKS))
    const wrapper = mount(ShareAdminPanel)
    await flushPromises()
    await wrapper.find('input.kb-input').setValue('张三')
    expect(owners(wrapper)).toEqual(['张三'])
    await wrapper.find('input.kb-input').setValue('不存在的人')
    expect(wrapper.text()).toContain('没有符合条件的链接')
    expect(wrapper.text()).toContain('筛选只在当前这一页里查找')
  })

  it('链接多于一页时有分页条,翻页按页码取数', async () => {
    shareAdminList.mockResolvedValue(page(LINKS, 120))
    const wrapper = mount(ShareAdminPanel)
    await flushPromises()
    expect(wrapper.find('.kb-pager').exists()).toBe(true)
    wrapper.findComponent({ name: 'KbPager' }).vm.$emit('update:page', 2)
    await flushPromises()
    expect(shareAdminList).toHaveBeenLastCalledWith(2, 50)
  })
})
