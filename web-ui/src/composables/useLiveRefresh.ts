// 页面的刷新节奏(卡 A):任务页、系统概览、外壳、导入记录共用这一份,不各写各的 setInterval。
//
// 以前每个页面自己 setInterval,收到一个推送事件就立刻整页重取:索引高峰每分钟有 39 个任务完成,
// 任务页每分钟就重取 39 次(每次 4 MB);标签页切到后台也照发。这里统一成:
//   - 只在页面可见时轮询;切回前台立刻刷新一次(隐藏期间的推送事件不处理,这一次刷新都包含了);
//   - 推送事件合并:最后一个事件之后等 debounceMs 再刷新,事件一直来时最多等 maxWaitMs 必刷一次;
//   - 同一时刻最多一个在途请求;在途时又要刷新,就在这次结束后补一次(不并发、不丢更新);
//   - 轮询间隔可以是函数:有任务在跑时短、空闲时长。
import { onMounted, onUnmounted } from 'vue'
import { subscribeLive, type LiveEvent } from './useLiveEvents'

/** 这一次为什么刷新:调用方可以按原因少取一些(例如推送事件只刷计数,不重读别的) */
export type RefreshReason = 'mount' | 'poll' | 'event' | 'visible' | 'manual'

export interface LiveRefreshOptions {
  /** 取数。错误由调用方自己处理(显示旧数据 / 报错),这里吞掉只为不打断节奏 */
  load: (reason: RefreshReason) => Promise<unknown>
  /** 轮询间隔(毫秒);0 = 不轮询,只靠事件和切回前台 */
  interval: number | (() => number)
  /** 哪些推送事件要刷新:事件类型列表,或自己判断 */
  events?: string[] | ((event: LiveEvent) => boolean)
  /** 最后一个事件之后等多久再刷新 */
  debounceMs?: number
  /** 事件连续不断时,从第一个事件起最多等多久必刷一次 */
  maxWaitMs?: number
  /** 挂载时立刻取一次 */
  immediate?: boolean
}

export const LIVE_DEBOUNCE_MS = 1_500
export const LIVE_MAX_WAIT_MS = 5_000

export function useLiveRefresh(options: LiveRefreshOptions) {
  const debounceMs = options.debounceMs ?? LIVE_DEBOUNCE_MS
  const maxWaitMs = options.maxWaitMs ?? LIVE_MAX_WAIT_MS
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

  let active = false
  let inflight: Promise<void> | null = null
  /** 在途时又被要求刷新:这次结束后补一次,用最后一个原因 */
  let again: RefreshReason | null = null
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let maxTimer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined

  const intervalMs = () => (typeof options.interval === 'function' ? options.interval() : options.interval)

  function clearEventTimers() {
    if (debounceTimer) clearTimeout(debounceTimer)
    if (maxTimer) clearTimeout(maxTimer)
    debounceTimer = undefined
    maxTimer = undefined
  }

  function arm() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = undefined
    const wait = intervalMs()
    if (!active || hidden() || !wait || wait <= 0) return
    pollTimer = setTimeout(() => {
      pollTimer = undefined
      void refresh('poll')
    }, wait)
  }

  async function run(reason: RefreshReason) {
    let current: RefreshReason | null = reason
    while (current && active) {
      again = null
      try {
        await options.load(current)
      } catch {
        // 取数失败由 load 自己展示;这里只保证节奏不断
      }
      current = again
    }
  }

  /** 立刻刷新(在途时排在这次之后)。返回的 Promise 在这一轮(含补的那次)结束后完成 */
  function refresh(reason: RefreshReason = 'manual'): Promise<void> {
    clearEventTimers()
    if (inflight) {
      again = reason
      return inflight
    }
    inflight = run(reason).finally(() => {
      inflight = null
      arm()
    })
    return inflight
  }

  /** 有变化,合并后刷新(推送事件走这里;调用方也可以手动调)。页面隐藏时不处理:回到前台会整体刷新一次 */
  function nudge() {
    if (!active || hidden()) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void refresh('event'), debounceMs)
    if (!maxTimer) maxTimer = setTimeout(() => void refresh('event'), maxWaitMs)
  }

  function wants(event: LiveEvent) {
    const filter = options.events
    if (!filter) return false
    return typeof filter === 'function' ? filter(event) : filter.includes(event.type)
  }

  function onVisibility() {
    if (!active) return
    if (hidden()) {
      // 切到后台:停掉轮询和还没到点的合并刷新;隐藏期间的事件不处理,回到前台时刷新一次就都包含了
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = undefined
      clearEventTimers()
      return
    }
    void refresh('visible')
  }

  function start() {
    if (active) return
    active = true
    document.addEventListener('visibilitychange', onVisibility)
    if (options.events) unsubscribe = subscribeLive((event) => (wants(event) ? nudge() : undefined))
    if (options.immediate === false) arm()
    else void refresh('mount')
  }

  function stop() {
    active = false
    document.removeEventListener('visibilitychange', onVisibility)
    unsubscribe?.()
    unsubscribe = undefined
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = undefined
    clearEventTimers()
  }

  onMounted(start)
  onUnmounted(stop)

  return {
    refresh,
    nudge,
    /** 轮询间隔变了(例如任务跑完变空闲):按新间隔重新计时 */
    rearm: () => (inflight ? undefined : arm()),
  }
}
