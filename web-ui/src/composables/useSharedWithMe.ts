// 「共享给我」的数据:列表、按分享人分组、把共享移出 / 放回我的列表。
// 接收分享不需要功能点(shared_with_me / hide_share 对所有账号开放),所以不看 collab.share。
import { computed, ref } from 'vue'
import { hideShare, sharedWithMe, type ShareTarget, type SharedWithMeItem } from '@/api/share'
import { groupByOwner, shareErrorText } from '@/utils/share'

export function useSharedWithMe() {
  const items = ref<SharedWithMeItem[]>([])
  const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const errorText = ref('')
  /** 显示被我移出列表的(带「放回」);默认不显示 */
  const showHidden = ref(false)

  const groups = computed(() => groupByOwner(items.value, showHidden.value))
  /** 没被移出的条数(切换开关上的数字) */
  const count = computed(() => items.value.filter((item) => !item.hidden).length)
  const hiddenCount = computed(() => items.value.filter((item) => item.hidden).length)

  async function load() {
    // 刷新时保留旧列表(不闪成骨架),首次加载才是 loading
    if (status.value !== 'ready') status.value = 'loading'
    try {
      // 总是连被移出的一起取回:切「显示已移出」不必再请求,也才数得出被移出了几条
      // 响应里没有 items(老后端 / 被代理改写)按「没有共享」处理,不能让整个知识库页因此崩掉
      items.value = (await sharedWithMe(true)).items ?? []
      status.value = 'ready'
    } catch (err) {
      errorText.value = shareErrorText(err, '共享给我的内容没有加载出来。检查网络后重试。')
      status.value = 'error'
    }
  }

  /**
   * 移出 / 放回。只影响我的列表显示,授权不变。逐项请求,返回失败了几项——
   * 部分失败要如实告诉用户,而不是整体报成功或整体报失败。
   */
  async function setHidden(targets: ShareTarget[], hidden: boolean): Promise<{ done: number; failed: number }> {
    const results = await Promise.allSettled(targets.map((target) => hideShare(target, hidden)))
    const failed = results.filter((result) => result.status === 'rejected').length
    await load()
    return { done: targets.length - failed, failed }
  }

  return { items, status, errorText, showHidden, groups, count, hiddenCount, load, setHidden }
}
