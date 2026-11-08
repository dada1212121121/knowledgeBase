// 通知 store:角标数字、已读、实时推送。接口形状见 stores/notifications.ts 顶部的约定。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
// 只换掉 callCapability;CapabilityError 等保持真实(store 用它判断 403、把失败写成人话)
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))

import { CapabilityError } from '@/api/client'
import { useNotificationsStore, type NotificationItem } from './notifications'

const note = (id: number, read = false): NotificationItem => ({ id, kind: 'share.added', data: {}, read_at: read ? 1 : null, created_at: 1000 + id })

beforeEach(() => {
  callCapability.mockReset()
  setActivePinia(createPinia())
})

describe('useNotificationsStore', () => {
  it('refreshUnread 只取未读数(unread_only + limit 1),不拉整页', async () => {
    callCapability.mockResolvedValue({ notifications: [], unread: 4, next_before_id: null })
    const store = useNotificationsStore()
    await store.refreshUnread()
    expect(callCapability).toHaveBeenCalledWith('notification_list', { unread_only: true, limit: 1 })
    expect(store.unread).toBe(4)
    expect(store.items).toEqual([])
  })

  it('load 拉第一页并带回分页游标', async () => {
    callCapability.mockResolvedValue({ notifications: [note(3), note(2, true)], unread: 1, next_before_id: 2 })
    const store = useNotificationsStore()
    await store.load()
    expect(store.items.map((item) => item.id)).toEqual([3, 2])
    expect(store.unread).toBe(1)
    expect(store.nextBeforeId).toBe(2)
    expect(store.loaded).toBe(true)
  })

  it('取数失败静默:角标保持上一次的值', async () => {
    callCapability.mockResolvedValueOnce({ notifications: [], unread: 3, next_before_id: null })
    const store = useNotificationsStore()
    await store.refreshUnread()
    callCapability.mockRejectedValue(new Error('boom'))
    await expect(store.refreshUnread()).resolves.toBeUndefined()
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.unread).toBe(3)
  })

  it('全部已读:请求 {all:true},本地清零', async () => {
    callCapability.mockResolvedValueOnce({ notifications: [note(2), note(1)], unread: 2, next_before_id: null })
    const store = useNotificationsStore()
    await store.load()
    callCapability.mockResolvedValue({})
    await store.markRead({ all: true })
    expect(callCapability).toHaveBeenLastCalledWith('notification_read', { all: true })
    expect(store.unread).toBe(0)
    expect(store.items.every((item) => item.read_at)).toBe(true)
  })

  it('按 id 标已读:只减去真正从未读变已读的那几条', async () => {
    callCapability.mockResolvedValueOnce({ notifications: [note(3), note(2), note(1, true)], unread: 2, next_before_id: null })
    const store = useNotificationsStore()
    await store.load()
    callCapability.mockResolvedValue({})
    await store.markRead({ ids: [3, 1] }) // 1 本来就已读,不该多减
    expect(store.unread).toBe(1)
    expect(store.items.find((item) => item.id === 3)?.read_at).toBeTruthy()
    expect(store.items.find((item) => item.id === 2)?.read_at).toBeNull()
  })

  it('标已读失败时不改本地状态', async () => {
    callCapability.mockResolvedValueOnce({ notifications: [note(1)], unread: 1, next_before_id: null })
    const store = useNotificationsStore()
    await store.load()
    callCapability.mockRejectedValue(new Error('403'))
    await store.markRead({ all: true })
    expect(store.unread).toBe(1)
  })

  it('WebSocket 推来 notify:未读数以服务端为准,通知插到最前并按 id 去重', () => {
    const store = useNotificationsStore()
    store.items = [note(1)]
    store.onLive({ type: 'notify', data: { notification: note(2), unread: 5 } })
    expect(store.unread).toBe(5)
    expect(store.items.map((item) => item.id)).toEqual([2, 1])
    store.onLive({ type: 'notify', data: { notification: note(2), unread: 6 } })
    expect(store.items).toHaveLength(2)
    expect(store.unread).toBe(6)
  })

  it('只认 notify 事件;没带 unread 数字时不乱改角标', () => {
    const store = useNotificationsStore()
    store.unread = 2
    store.onLive({ type: 'job.done', data: { unread: 99 } })
    expect(store.unread).toBe(2)
    store.onLive({ type: 'notify', data: { notification: note(7) } })
    expect(store.unread).toBe(2)
    expect(store.items).toHaveLength(1)
  })

  it('load 失败:不抛错,但记下原因(给抽屉显示);之后成功就清掉', async () => {
    callCapability.mockRejectedValueOnce(new CapabilityError('internal: x', 'internal', 500))
    const store = useNotificationsStore()
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.error).toBe('没能加载通知。请检查网络后重试。')
    expect(store.forbidden).toBe(false)
    expect(store.loaded).toBe(false)
    expect(store.loading).toBe(false)
    callCapability.mockResolvedValueOnce({ notifications: [note(1)], unread: 1, next_before_id: null })
    await store.load()
    expect(store.error).toBe('')
    expect(store.items).toHaveLength(1)
  })

  it('load 遇到 403:标记 forbidden', async () => {
    callCapability.mockRejectedValueOnce(new CapabilityError('forbidden', 'forbidden', 403))
    const store = useNotificationsStore()
    await store.load()
    expect(store.forbidden).toBe(true)
  })

  it('第一次 load 期间 loading 为真(骨架屏);已经有数据时重新 load 不再算 loading(后台刷新)', async () => {
    const store = useNotificationsStore()
    const seen: boolean[] = []
    callCapability.mockImplementationOnce(async () => {
      seen.push(store.loading)
      return { notifications: [note(1)], unread: 1, next_before_id: null }
    })
    await store.load()
    callCapability.mockImplementationOnce(async () => {
      seen.push(store.loading)
      return { notifications: [note(2), note(1)], unread: 2, next_before_id: null }
    })
    await store.load()
    expect(seen).toEqual([true, false])
    expect(store.loading).toBe(false)
  })

  it('loadMore:按 nextBeforeId 往前翻,追加在后面并按 id 去重;没有下一页时什么都不做', async () => {
    callCapability.mockResolvedValueOnce({ notifications: [note(5), note(4)], unread: 2, next_before_id: 4 })
    const store = useNotificationsStore()
    await store.load(2)
    callCapability.mockResolvedValueOnce({ notifications: [note(4), note(3)], unread: 2, next_before_id: null })
    await store.loadMore(2)
    expect(callCapability).toHaveBeenLastCalledWith('notification_list', { limit: 2, before_id: 4 })
    expect(store.items.map((item) => item.id)).toEqual([5, 4, 3])
    expect(store.nextBeforeId).toBeNull()
    callCapability.mockClear()
    await store.loadMore(2)
    expect(callCapability).not.toHaveBeenCalled()
  })

  it('loadMore 失败:记下原因,已有的列表不动,游标保留(可以重试)', async () => {
    callCapability.mockResolvedValueOnce({ notifications: [note(5)], unread: 1, next_before_id: 5 })
    const store = useNotificationsStore()
    await store.load(1)
    callCapability.mockRejectedValueOnce(new CapabilityError('internal: x', 'internal', 500))
    await store.loadMore(1)
    expect(store.error).toBe('没能加载更多通知。请检查网络后重试。')
    expect(store.items).toHaveLength(1)
    expect(store.nextBeforeId).toBe(5)
    expect(store.loadingMore).toBe(false)
  })
})
