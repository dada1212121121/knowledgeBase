/**
 * 「同一时刻只跑一份」的守卫（打印用）。
 *
 * 打印要先开窗口、再开临时 Worker 会话、光栅每一页，连点三下不该开三个窗口、起三个会话。
 * 为什么抽成独立函数而不是在 Surface 里写个布尔值：要点是「复位」——不论成功、失败还是抛错，
 * 进行中标记都必须清掉，否则一次失败后再也印不了；这个性质只有并发调用才测得出来，
 * 而 Playwright 逐次点击间隔几秒，根本制造不出真正的并发（实测三次点击间隔 2.7 s 和 27 s），所以放进单测。
 */
export type SingleFlightResult<T> = { ran: true; value: T } | { ran: false }

export function createSingleFlight() {
  let busy = false
  return {
    get busy() {
      return busy
    },
    /** 空闲时执行 `task` 并返回结果；进行中则不执行，返回 `{ ran: false }` */
    async run<T>(task: () => Promise<T>): Promise<SingleFlightResult<T>> {
      if (busy) return { ran: false }
      busy = true
      try {
        return { ran: true, value: await task() }
      } finally {
        busy = false
      }
    },
  }
}
