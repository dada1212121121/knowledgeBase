// 通知(后端已上线):顶栏角标与抽屉用同一份数据。
//
// 形状约定:
//   POST /capabilities/notification_list {unread_only?, before_id?, limit?}
//       → {notifications: [{id, kind, data, read_at, created_at}], unread, next_before_id}
//   POST /capabilities/notification_read {ids?: [...], all?: bool}
//   WebSocket 推送 {"type":"notify","data":{"notification":{...},"unread":N}}
// 角标是锦上添花:取未读数失败一律静默(角标保持上一次的值)。抽屉里的列表不一样——用户正盯着它看,
// 取不到要告诉他怎么回事(error,可重试),所以 load / loadMore 会记下失败原因,但仍然不抛错。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { CapabilityError, callCapability } from '@/api/client'
import { socialErrorText } from '@/utils/social'

export interface NotificationItem {
  id: string | number
  kind: string
  data: Record<string, unknown>
  read_at: number | null
  created_at: number
}

interface ListResponse {
  notifications: NotificationItem[]
  unread: number
  next_before_id: string | number | null
}

export const useNotificationsStore = defineStore('notifications', () => {
  const items = ref<NotificationItem[]>([])
  const unread = ref(0)
  const nextBeforeId = ref<string | number | null>(null)
  const loaded = ref(false)
  /** 正在取第一页(抽屉里显示骨架屏;已经有数据时重新打开抽屉只在后台刷新,不算)。 */
  const loading = ref(false)
  const loadingMore = ref(false)
  /** 上一次取列表失败的原因(给人看的话);成功后清空。 */
  const error = ref('')
  /** 后端说这个账号用不了通知(403)。 */
  const forbidden = ref(false)
  let loadSeq = 0

  /** 只刷新未读数(角标):limit 1,不拉整页。 */
  async function refreshUnread() {
    try {
      const response = await callCapability<ListResponse>('notification_list', { unread_only: true, limit: 1 })
      if (typeof response.unread === 'number') unread.value = response.unread
    } catch {
      /* 静默 */
    }
  }

  /** 拉第一页(打开抽屉时)。已经有数据时在后台刷新,不闪骨架屏。 */
  async function load(limit = 30) {
    const seq = ++loadSeq
    if (!loaded.value) loading.value = true
    try {
      const response = await callCapability<ListResponse>('notification_list', { limit })
      if (seq !== loadSeq) return
      items.value = response.notifications ?? []
      unread.value = response.unread ?? unread.value
      nextBeforeId.value = response.next_before_id ?? null
      loaded.value = true
      error.value = ''
      forbidden.value = false
    } catch (err) {
      if (seq !== loadSeq) return
      forbidden.value = err instanceof CapabilityError && err.status === 403
      error.value = socialErrorText(err, '没能加载通知。请检查网络后重试。')
    } finally {
      if (seq === loadSeq) loading.value = false
    }
  }

  /** 翻下一页(按上一页最后一条的 id 往前取),按 id 去重。 */
  async function loadMore(limit = 30) {
    const cursor = nextBeforeId.value
    if (cursor === null || loadingMore.value) return
    loadingMore.value = true
    try {
      const response = await callCapability<ListResponse>('notification_list', { limit, before_id: cursor })
      const have = new Set(items.value.map((item) => String(item.id)))
      items.value = [...items.value, ...(response.notifications ?? []).filter((item) => !have.has(String(item.id)))]
      nextBeforeId.value = response.next_before_id ?? null
      unread.value = response.unread ?? unread.value
      error.value = ''
    } catch (err) {
      error.value = socialErrorText(err, '没能加载更多通知。请检查网络后重试。')
    } finally {
      loadingMore.value = false
    }
  }

  /** 标记已读:传 ids 标记这几条,不传 ids 且 all=true 标记全部。 */
  async function markRead(options: { ids?: (string | number)[]; all?: boolean }) {
    try {
      await callCapability('notification_read', options)
      const now = Date.now()
      if (options.all) {
        items.value = items.value.map((item) => ({ ...item, read_at: item.read_at ?? now }))
        unread.value = 0
      } else if (options.ids?.length) {
        const wanted = new Set(options.ids.map(String))
        let cleared = 0
        items.value = items.value.map((item) => {
          if (!wanted.has(String(item.id)) || item.read_at) return item
          cleared += 1
          return { ...item, read_at: now }
        })
        unread.value = Math.max(0, unread.value - cleared)
      }
    } catch {
      /* 静默:下次刷新会和服务端对齐 */
    }
  }

  /** WebSocket 推来的新通知:未读数以服务端给的为准,通知本身插到最前(按 id 去重)。 */
  function onLive(event: { type: string; data: Record<string, unknown> }) {
    if (event.type !== 'notify') return
    const count = event.data.unread
    if (typeof count === 'number') unread.value = count
    const notification = event.data.notification as NotificationItem | undefined
    if (notification && notification.id !== undefined && !items.value.some((item) => String(item.id) === String(notification.id))) {
      items.value = [notification, ...items.value]
    }
  }

  return { items, unread, nextBeforeId, loaded, loading, loadingMore, error, forbidden, refreshUnread, load, loadMore, markRead, onLive }
})
