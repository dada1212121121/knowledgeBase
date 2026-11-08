// 管理页的取数状态机:加载中 → 就绪 / 报错 / 无权限。
//
// - 每次 reload 带一个序号,慢请求回来时如果已经发起了更新的请求就丢掉结果
//   (切换日期、连点刷新时,旧日期的数据不能盖掉新日期的);
// - 普通 reload 先清掉旧数据(换了日期 / 筛选,旧数据已经不是用户要看的了);
//   `quiet` 的后台刷新才保留旧数据,失败时不把整页换成报错,由调用方提示(`onSoftError`);
// - 无权限(403)和报错分开:前者重试没有意义。
import { ref, type Ref } from 'vue'
import { failureOf, type LoadPhase } from '@/utils/loadState'

export interface LoadState<T> {
  phase: Ref<LoadPhase>
  data: Ref<T | null>
  /** 报错 / 无权限时给用户看的两句话。 */
  message: Ref<string>
  reload: (options?: { quiet?: boolean }) => Promise<void>
}

export function useLoadState<T>(
  load: () => Promise<T>,
  doing: string,
  onSoftError?: (message: string) => void,
): LoadState<T> {
  const phase = ref<LoadPhase>('loading')
  const data = ref(null) as Ref<T | null>
  const message = ref('')
  let sequence = 0

  async function reload(options: { quiet?: boolean } = {}) {
    const mine = ++sequence
    if (!options.quiet) data.value = null
    if (data.value === null) phase.value = 'loading'
    try {
      const result = await load()
      if (mine !== sequence) return
      data.value = result
      message.value = ''
      phase.value = 'ready'
    } catch (err) {
      if (mine !== sequence) return
      const failure = failureOf(err, doing)
      if (data.value !== null && failure.phase === 'error') {
        onSoftError?.(failure.message)
        return
      }
      data.value = null
      message.value = failure.message
      phase.value = failure.phase
    }
  }

  return { phase, data, message, reload }
}
