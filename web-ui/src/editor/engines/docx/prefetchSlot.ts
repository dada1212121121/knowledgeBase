/**
 * 悬停预取的"槽"：同一时刻最多放一份预热好的资源，被认领、被放弃或失败后清空。
 *
 * 预取是押注：用户把鼠标放到「编辑」上，多半马上点，此时把 Worker 建起来、wasm 下载编译好，点击后少等几秒。
 * 押错了不能留副作用，所以状态机必须讲清楚：
 * - 重复悬停复用同一份，不会堆出多个 Worker；
 * - 鼠标移开：给一段宽限期，期间没人认领才销毁；宽限期内再次悬停取消销毁；
 * - 点击认领：槽清空，资源从此归认领方管；
 * - 预热失败：销毁并清槽（下次悬停可重试），不向上抛——预取只是优化，真正打开时的错误由那条路径如实报告。
 * 抽成可注入的模块是因为 Worker 在 jsdom 里造不出来，而这套状态转换正是最容易写错的部分。
 */
export interface PrefetchResource {
  /** 预热完成（失败则 reject） */
  ready: Promise<void>
  /** 释放资源（销毁 Worker） */
  destroy(): void
}

export interface PrefetchSlot<T extends PrefetchResource> {
  /** 悬停：没有就创建，有就复用并取消待销毁；返回是否新建 */
  start(): boolean
  /** 移开：宽限期后没被认领就销毁 */
  release(): void
  /** 认领：返回预热好的资源；没有或预热失败返回 undefined */
  take(): Promise<T | undefined>
  has(): boolean
}

export function createPrefetchSlot<T extends PrefetchResource>(
  create: () => T,
  idleMs: number,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): PrefetchSlot<T> {
  interface Entry {
    resource: T
    timer: unknown
  }
  let entry: Entry | null = null

  const dropIfCurrent = (target: Entry) => {
    if (entry !== target) return
    entry = null
    target.resource.destroy()
  }

  return {
    start() {
      if (entry) {
        if (entry.timer !== null) {
          timers.clear(entry.timer)
          entry.timer = null
        }
        return false
      }
      const created: Entry = { resource: create(), timer: null }
      entry = created
      created.resource.ready.catch(() => dropIfCurrent(created))
      return true
    },
    release() {
      const current = entry
      if (!current || current.timer !== null) return
      current.timer = timers.set(() => dropIfCurrent(current), idleMs)
    },
    async take() {
      const current = entry
      if (!current) return undefined
      entry = null
      if (current.timer !== null) timers.clear(current.timer)
      try {
        await current.resource.ready
        return current.resource
      } catch {
        // 预热失败：start 里的 catch 已经因为 entry !== target 而没有重复销毁，这里补上销毁
        current.resource.destroy()
        return undefined
      }
    },
    has: () => entry !== null,
  }
}
