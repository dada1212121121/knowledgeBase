// 谁刚刚在动(腾讯文档式:头像上亮一个小点,表示这个人此刻正在这篇文档里操作)。
// 协议里没有「正在输入」这个状态,也不需要加:打字和点选都会移动光标,光标位置是 awareness 的一部分,
// 所以「光标位置变了」就是最可靠的活动信号,不用改服务端也不用多发任何消息。
// 注意只看光标内容是否变化,不看 awareness 的 update 事件:心跳每 15 秒会续期一次(内容没变),那不算活动;
// 刚加入时第一次看到的光标也不算(否则一进房间所有人都亮一下)。

/** 光标最后一次移动之后,多久内还算「正在动」 */
export const ACTIVE_MS = 3000

export class ActivityTracker {
  /** 每个连接上一次看到的光标(序列化后比较) */
  private seen = new Map<number, string>()
  /** 每个用户最后一次移动光标的时刻 */
  private moved = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  /** 喂入当前全部 awareness 状态;返回是否有人的活跃状态可能变了(调用方据此刷新) */
  observe(states: Map<number, Record<string, unknown>>, myClientId: number): void {
    const present = new Set<number>()
    for (const [client, state] of states) {
      if (client === myClientId) continue
      const user = state.user as { id?: unknown } | undefined
      if (!user || typeof user.id !== 'string' || !user.id) continue
      present.add(client)
      const cursor = JSON.stringify(state.cursor ?? null)
      const before = this.seen.get(client)
      if (before !== undefined && before !== cursor) this.moved.set(user.id, this.now())
      this.seen.set(client, cursor)
    }
    // 走掉的连接不再占着记录
    for (const client of [...this.seen.keys()]) if (!present.has(client)) this.seen.delete(client)
  }

  isActive(userId: string): boolean {
    const at = this.moved.get(userId)
    return at !== undefined && this.now() - at < ACTIVE_MS
  }

  /** 距离最早一个「活跃 → 不活跃」还有多久(毫秒);没有活跃的人返回 null。调用方据此安排一次刷新,不用轮询。 */
  nextExpiry(): number | null {
    let soonest: number | null = null
    for (const at of this.moved.values()) {
      const left = ACTIVE_MS - (this.now() - at)
      if (left > 0 && (soonest === null || left < soonest)) soonest = left
    }
    return soonest
  }
}
