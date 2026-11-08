// 通知抽屉:四种状态、分类筛选、点击跳转并标已读、单条已读、全部已读、加载更多、实时新通知。
// 抽屉被 Teleport 到 body,所以都从 document 里找。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

import { CapabilityError } from '@/api/client'
import { useNotificationsStore, type NotificationItem } from '@/stores/notifications'
import { useSessionStore } from '@/stores/session'
import NotificationDrawer from './NotificationDrawer.vue'

const zhao = { id: 'usr_zhao', username: 'zhaoliu', display_name: '赵六', avatar: null }
const note = (id: number, kind: string, data: Record<string, unknown>, read = false): NotificationItem => ({ id, kind, data, read_at: read ? 1 : null, created_at: Date.now() - id * 60_000 })
const FRIEND = note(6, 'friend_request', { request_id: 'frq_1', from: zhao, message: '我是同事' })
const SHARE = note(5, 'share_received', { title: '部署清单', count: 1, role_label: '可编辑', from: zhao, target: { kind: 'insight', space_id: 'sp_other', collection: '_global', id: 'ins_1' } })
const REMOVED = note(4, 'collaborator_removed', { title: '旧文档', from: zhao, target: { kind: 'insight', space_id: 'sp_other', collection: '_global', id: 'ins_2' } })
const NOTICE = note(3, 'announcement', { title: '今晚维护', body: '23:00 起停机 10 分钟' }, true)
const MENTION = note(2, 'mention', { title: '周报', from: zhao, target: { kind: 'insight', space_id: 'sp_other', collection: '_global', id: 'ins_3' } }, true)

const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const titles = () => $$('[data-testid="notification-item"] .kb-nr-title').map((el) => el.textContent)
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
const pickFilter = async (label: string) => {
  $$('[data-testid="notification-filter"] [role="tab"]').find((tab) => tab.textContent!.trim() === label)!.click()
  await flushPromises()
}

let wrapper: VueWrapper | null = null
async function open(reply: { notifications: NotificationItem[]; unread?: number; next_before_id?: number | null } | Error, features = ['collab.friends']) {
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'me', display_name: '我', email: null, role_id: 'r', space_id: 'sp_me', must_change_password: false }
  session.features = new Set(features)
  session.loaded = true
  if (reply instanceof Error) callCapability.mockRejectedValueOnce(reply)
  else callCapability.mockResolvedValueOnce({ unread: reply.notifications.filter((item) => !item.read_at).length, next_before_id: null, ...reply })
  wrapper = mount(NotificationDrawer, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  push.mockReset()
  setActivePinia(createPinia())
})

describe('四种状态', () => {
  it('加载中:骨架屏', async () => {
    callCapability.mockReturnValueOnce(new Promise(() => undefined))
    wrapper = mount(NotificationDrawer, { attachTo: document.body })
    await flushPromises()
    expect($('.kb-skel')).not.toBeNull()
    expect($('[data-testid="notification-empty"]')).toBeNull()
  })

  it('空:说明 + 「去看看好友」(有好友功能时);点它去好友页并关闭抽屉', async () => {
    const wrap = await open({ notifications: [] })
    expect($('[data-testid="notification-empty"]')!.textContent).toContain('还没有通知')
    $$('[data-testid="notification-empty"] button').find((button) => button.textContent!.includes('去看看好友'))!.click()
    expect(push).toHaveBeenCalledWith('/friends')
    expect(wrap.emitted('close')).toHaveLength(1)
  })

  it('空 + 没有好友功能:只有说明,不引导去用不了的页面', async () => {
    await open({ notifications: [] }, [])
    expect($('[data-testid="notification-empty"]')!.textContent).not.toContain('好友页')
    expect($$('[data-testid="notification-empty"] button')).toHaveLength(0)
  })

  it('出错:原因 + 重新加载,点了再请求一次', async () => {
    await open(new CapabilityError('internal: x', 'internal', 500))
    expect($('[data-testid="notification-error"]')!.textContent).toContain('没能加载通知')
    callCapability.mockResolvedValueOnce({ notifications: [FRIEND], unread: 1, next_before_id: null })
    $$('[data-testid="notification-error"] button').find((button) => button.textContent!.includes('重新加载'))!.click()
    await flushPromises()
    expect($('[data-testid="notification-error"]')).toBeNull()
    expect(titles()).toHaveLength(1)
  })

  it('没有权限(403):写明白,不是笼统的报错', async () => {
    await open(new CapabilityError('forbidden', 'forbidden', 403))
    expect($('[data-testid="notification-forbidden"]')!.textContent).toContain('没有开通')
    expect($('[data-testid="notification-error"]')).toBeNull()
  })

  it('已经有列表时刷新失败:错误显示在列表上方,列表还在', async () => {
    await open({ notifications: [FRIEND] })
    useNotificationsStore().error = '没能加载更多通知。请检查网络后重试。'
    await flushPromises()
    expect($('[data-testid="notification-inline-error"]')!.textContent).toContain('没能加载更多通知')
    expect(titles()).toHaveLength(1)
  })
})

describe('列表与筛选', () => {
  const all = { notifications: [FRIEND, SHARE, REMOVED, NOTICE, MENTION] }

  it('每条一句人话;未读数和「全部标为已读」', async () => {
    await open(all)
    expect(titles()).toEqual([
      '赵六(@zhaoliu) 请求加你为好友',
      '赵六 向你分享了「部署清单」',
      '赵六 把你从「旧文档」的协作者中移除了',
      '今晚维护',
      '赵六 在「周报」里提到了你',
    ])
    expect($('[data-testid="notification-unread"]')!.textContent).toBe('3 条未读')
    expect($$('[data-testid="notification-item"]')[0]!.textContent).toContain('“我是同事”')
  })

  it('按类型筛选:好友 / 分享 / 评论 / 系统;「全部」回到全部', async () => {
    await open(all)
    await pickFilter('好友')
    expect(titles()).toEqual(['赵六(@zhaoliu) 请求加你为好友'])
    await pickFilter('分享')
    expect(titles()).toEqual(['赵六 向你分享了「部署清单」', '赵六 把你从「旧文档」的协作者中移除了'])
    await pickFilter('评论')
    expect(titles()).toEqual(['赵六 在「周报」里提到了你'])
    await pickFilter('系统')
    expect(titles()).toEqual(['今晚维护'])
    await pickFilter('全部')
    expect(titles()).toHaveLength(5)
  })

  it('这一类没有:说明 + 「查看全部」', async () => {
    await open({ notifications: [FRIEND] })
    await pickFilter('评论')
    expect($('[data-testid="notification-empty-filter"]')!.textContent).toContain('评论类通知:目前没有')
    $$('[data-testid="notification-empty-filter"] button').find((button) => button.textContent!.includes('查看全部'))!.click()
    await flushPromises()
    expect(titles()).toHaveLength(1)
  })

  it('这一类没有、但后面还有更早的通知:提示加载更多,不引导「查看全部」', async () => {
    await open({ notifications: [FRIEND], next_before_id: 6 })
    await pickFilter('评论')
    expect($('[data-testid="notification-empty-filter"]')!.textContent).toContain('更早的通知里可能还有')
    expect($$('[data-testid="notification-empty-filter"] button')).toHaveLength(0)
    expect($('[data-testid="notification-more"]')).not.toBeNull()
  })

  it('加载更多:带上翻页游标,追加在后面;没有下一页时没有这个按钮', async () => {
    await open({ notifications: [FRIEND, SHARE], next_before_id: 5 })
    callCapability.mockResolvedValueOnce({ notifications: [NOTICE], unread: 2, next_before_id: null })
    $('[data-testid="notification-more"]')!.click()
    await flushPromises()
    expect(calls('notification_list')[1]).toEqual(['notification_list', { limit: 30, before_id: 5 }])
    expect(titles()).toHaveLength(3)
    expect($('[data-testid="notification-more"]')).toBeNull()
  })
})

describe('点击与已读', () => {
  it('点好友申请:标为已读、关闭抽屉、跳到好友页的申请页签', async () => {
    const wrap = await open({ notifications: [FRIEND, NOTICE] })
    callCapability.mockResolvedValue({ unread: 0, changed: 1 })
    $$('[data-testid="notification-item"] .kb-nr-main')[0]!.click()
    await flushPromises()
    expect(calls('notification_read')).toEqual([['notification_read', { ids: [6] }]])
    expect(push).toHaveBeenCalledWith({ path: '/friends', query: { tab: 'requests' } })
    expect(wrap.emitted('close')).toHaveLength(1)
  })

  it('点收到的分享:跳到知识库里对应的笔记(别人的知识库带 space)', async () => {
    await open({ notifications: [SHARE] })
    callCapability.mockResolvedValue({ unread: 0 })
    $('[data-testid="notification-item"] .kb-nr-main')!.click()
    await flushPromises()
    // scope=shared 让知识库页切到「共享给我」并按 space + 位置找授权;没有它会当成我自己的文档去找
    expect(push).toHaveBeenCalledWith({ path: '/kb', query: { collection: '_global', item: 'ins_1', space: 'sp_other', scope: 'shared' } })
  })

  it('已读的通知再点:只跳转,不再发已读请求', async () => {
    await open({ notifications: [MENTION] })
    $('[data-testid="notification-item"] .kb-nr-main')!.click()
    await flushPromises()
    expect(calls('notification_read')).toHaveLength(0)
    expect(push).toHaveBeenCalled()
  })

  it('没有去处的通知(被移出协作者、公告)不是按钮,点了不跳转;未读的可以单独标为已读', async () => {
    await open({ notifications: [REMOVED, NOTICE] })
    const rows = $$('[data-testid="notification-item"]')
    expect(rows[0]!.querySelector('button.kb-nr-main')).toBeNull()
    expect(rows[1]!.querySelector('button.kb-nr-main')).toBeNull()
    rows[0]!.querySelector<HTMLElement>('.kb-nr-main')!.click()
    expect(push).not.toHaveBeenCalled()
    callCapability.mockResolvedValue({ unread: 0 })
    rows[0]!.querySelector<HTMLElement>('[data-testid="notification-read"]')!.click()
    await flushPromises()
    expect(calls('notification_read')).toEqual([['notification_read', { ids: [4] }]])
    expect(push).not.toHaveBeenCalled()
    expect(useNotificationsStore().unread).toBe(0)
  })

  it('已读的通知没有「标为已读」按钮;未读的有,并且读屏名字带上内容', async () => {
    await open({ notifications: [FRIEND, NOTICE] })
    const rows = $$('[data-testid="notification-item"]')
    expect(rows[1]!.querySelector('[data-testid="notification-read"]')).toBeNull()
    expect(rows[0]!.querySelector('[data-testid="notification-read"]')!.getAttribute('aria-label')).toBe('标为已读:赵六(@zhaoliu) 请求加你为好友')
  })

  it('未读不只靠颜色:读屏文字「未读」+ 小圆点;已读的没有', async () => {
    await open({ notifications: [FRIEND, NOTICE] })
    const rows = $$('[data-testid="notification-item"]')
    expect(rows[0]!.textContent).toContain('未读')
    expect(rows[0]!.querySelector('.kb-nr-dot')).not.toBeNull()
    expect(rows[1]!.textContent).not.toContain('未读')
    expect(rows[1]!.querySelector('.kb-nr-dot')).toBeNull()
  })

  it('全部标为已读:发 {all:true},未读数清零,按钮变灰', async () => {
    await open({ notifications: [FRIEND, SHARE] })
    callCapability.mockResolvedValue({ unread: 0 })
    const button = () => $$('button').find((item) => item.textContent!.includes('全部标为已读')) as HTMLButtonElement
    expect(button().disabled).toBe(false)
    button().click()
    await flushPromises()
    expect(calls('notification_read')).toEqual([['notification_read', { all: true }]])
    expect($('[data-testid="notification-unread"]')!.textContent).toBe('没有未读通知')
    expect(button().disabled).toBe(true)
  })
})

describe('实时', () => {
  it('抽屉开着时 WebSocket 推来新通知:出现在最上面,未读数以服务端为准', async () => {
    await open({ notifications: [NOTICE] })
    useNotificationsStore().onLive({ type: 'notify', data: { notification: FRIEND, unread: 1 } })
    await flushPromises()
    expect(titles()[0]).toBe('赵六(@zhaoliu) 请求加你为好友')
    expect($('[data-testid="notification-unread"]')!.textContent).toBe('1 条未读')
  })

  it('筛选「好友」时来了一条分享:不出现在当前列表里,换回「全部」就有', async () => {
    await open({ notifications: [FRIEND] })
    await pickFilter('好友')
    useNotificationsStore().onLive({ type: 'notify', data: { notification: SHARE, unread: 2 } })
    await flushPromises()
    expect(titles()).toHaveLength(1)
    await pickFilter('全部')
    expect(titles()).toHaveLength(2)
  })
})
