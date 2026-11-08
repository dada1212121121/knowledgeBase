// 首页的数据:最近编辑、共享给我、待处理(好友申请 / 访问申请 / 草稿)、我的用量。
//
// 每一块各有自己的加载状态:共享列表取失败不能让「最近编辑」也变成报错,
// 没有开通的功能(没有 collab.friends / collab.share / ai.extract)直接不请求,也不显示那一块。
import { computed, ref } from 'vue'
import { callCapability, type ItemList, type ItemSummary } from '@/api/client'
import { accessRequests, sharedWithMe, type AccessRequestRow, type SharedWithMeItem } from '@/api/share'
import { friendRequests, type IncomingRequest } from '@/api/social'
import { activitySeries, type ActivitySeries } from '@/api/metrics'
import { usageMine, type MyUsage } from '@/api/usage'
import { useLoadState } from '@/composables/useLoadState'
import { mergeRecent } from '@/utils/home'

/** 「继续编辑」「共享动态」各显示几条:首页是入口不是列表页,多了去知识库页看。 */
export const RECENT_LIMIT = 6
export const SHARED_LIMIT = 5
/**
 * 最多问几个集合要「最近更新」。每个集合一个请求(list_items 没有跨集合的形式),
 * 一个用户的笔记集合通常只有几个;代码类集合没有笔记,请求是廉价的空结果。封顶是防止集合特别多时首页一次发出一大串请求。
 */
export const RECENT_COLLECTIONS = 10
/** 活动热力覆盖多少天:约 13 周,和热力格的列数对得上 */
export const ACTIVITY_DAYS = 91

async function loadRecent(): Promise<ItemSummary[]> {
  const catalog = await callCapability<{ collections?: { name: string }[] }>('list_collections')
  const names = (catalog.collections ?? []).slice(0, RECENT_COLLECTIONS).map((collection) => collection.name)
  if (!names.length) return []
  const settled = await Promise.allSettled(
    names.map((collection) => callCapability<ItemList>('list_items', { collection, kind: 'insight', status: 'active', sort: 'updated_at', order: 'desc', page: 1, page_size: RECENT_LIMIT })),
  )
  const lists = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value.items ?? []] : []))
  // 全部失败才算失败;个别集合取不到时照样显示其余的(少了几条比整块报错有用)
  if (!lists.length) throw (settled[0] as PromiseRejectedResult).reason
  return mergeRecent(lists, RECENT_LIMIT)
}

export interface PendingInput {
  friends: IncomingRequest[]
  access: AccessRequestRow[]
}

export function useHomeFeed(has: (feature: string) => boolean) {
  const recent = useLoadState(loadRecent, '读取最近编辑')
  const shared = useLoadState<SharedWithMeItem[]>(async () => (await sharedWithMe(false)).items ?? [], '读取共享给你的内容')
  // 好友申请和访问申请各有各的功能点,各自取;一个没开通不影响另一个
  const pending = useLoadState<PendingInput>(async () => {
    const [friends, access] = await Promise.all([
      has('collab.friends') ? friendRequests().then((reply) => reply.incoming ?? []) : Promise.resolve([] as IncomingRequest[]),
      has('collab.share') ? accessRequests().then((reply) => reply.to_decide ?? []) : Promise.resolve([] as AccessRequestRow[]),
    ])
    return { friends, access }
  }, '读取待处理事项')
  const usage = useLoadState<MyUsage>(() => usageMine(), '读取我的用量')
  // 近 90 天每天的活动(迷你线、活动热力);读不到只影响这一块
  const activity = useLoadState<ActivitySeries>(() => activitySeries(ACTIVITY_DAYS), '读取近期活动')

  const loading = ref(false)
  /** 刷新全部;各块并行,互不等待。 */
  async function reloadAll(options: { quiet?: boolean } = {}) {
    loading.value = true
    try {
      await Promise.all([recent.reload(options), shared.reload(options), pending.reload(options), usage.reload(options), activity.reload(options)])
    } finally {
      loading.value = false
    }
  }

  const sharedCount = computed(() => shared.data.value?.filter((item) => !item.hidden).length ?? 0)

  return { recent, shared, pending, usage, activity, sharedCount, loading, reloadAll }
}
