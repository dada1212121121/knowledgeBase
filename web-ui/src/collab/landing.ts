// 落地调度:笔记的正文是 Yjs 结构,服务端不认识节点树,Markdown 由「落地者」这一条连接序列化后提交。
//   - 内容变化后安静 `quietMs` 才提交(别每敲一个字就序列化一次);
//   - 服务端说 `land_now`(库里有没落地的内容 / 太久没提交)就立刻提交;
//   - 连接即将销毁(关页面 / 退出编辑)时,落地者趁连接还在做最后一次提交;
//   - 只有当前是落地者、能编辑、连接在线才会真的发出去(provider.land 自己判断);
//   - `auto` 返回 false 时只记账不自动提交(一个人在房间里时,正文算草稿,点了「保存」才落地)。
import type { CollabProvider } from './provider'

export interface LandingOptions {
  /** 内容停止变化多久后提交 */
  quietMs?: number
  /** 拿此刻编辑器里的 Markdown;编辑器还没准备好返回 null */
  getMarkdown: () => string | null
  /** 允许自动落地吗(默认允许)。false = 安静后 / land_now / 关页面都先不交,正文算「草稿」;显式保存走 landAndWait */
  auto?: () => boolean
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export function startLanding(
  provider: Pick<CollabProvider, 'on' | 'land' | 'getState'> & { awareness?: CollabProvider['awareness'] },
  options: LandingOptions,
): () => void {
  const quiet = options.quietMs ?? 2500
  const set = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clear = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let timer: unknown = null
  const auto = options.auto ?? (() => true)
  // 有没有「变过但还没成功提交」的内容:成为落地者的那一刻要补交
  let dirty = false

  const land = () => {
    if (timer !== null) clear(timer)
    timer = null
    const markdown = options.getMarkdown()
    if (markdown === null) return
    if (provider.land(markdown)) dirty = false
  }
  const schedule = () => {
    dirty = true
    if (timer !== null) clear(timer)
    timer = null
    // 先不自动落地:内容仍留在房间里(别人看得到),只是先不进正文
    if (!auto()) return
    timer = set(land, quiet)
  }

  // 别的窗口（不是落地者）点了「保存」：它在在线状态里把 saveSeq 加一（见 provider.requestSave），
  // 落地者看到更大的序号就立刻提交。显式保存是明确的意图，不受 auto 限制
  const seenSave = new Map<number, number>()
  const awareness = provider.awareness
  const onAwareness = () => {
    if (!awareness) return
    let requested = false
    for (const [client, state] of awareness.getStates()) {
      if (client === awareness.clientID) continue
      const seq = (state as { saveSeq?: number } | null)?.saveSeq
      if (typeof seq === 'number' && seq > (seenSave.get(client) ?? 0)) {
        seenSave.set(client, seq)
        requested = true
      }
    }
    if (requested) land()
  }
  awareness?.on('update', onAwareness)

  const offs = [
    () => awareness?.off('update', onAwareness),
    provider.on('change', schedule),
    provider.on('land-now', () => {
      if (auto()) land()
    }),
    provider.on('closing', () => {
      if (auto()) land()
    }),
    // 刚被指定为落地者,而之前有变化没交出去(上一个落地者走了):补交
    provider.on('state', (state) => {
      if (state.lander && dirty && timer === null) schedule()
    }),
  ]
  return () => {
    if (timer !== null) clear(timer)
    timer = null
    for (const off of offs) off()
  }
}

/**
 * 退出编辑前把最后的内容落地,并等服务端确认(`saved`)。
 * 不等的话,退出后马上重新读笔记会读到落地之前的旧正文。
 * 当前连接不是落地者时没有什么可等的(落地是别人的事,也会在它那边安静后完成)。
 * 返回有没有确认落地;超时返回 false(调用方照常退出,内容仍在房间里,下次打开还在)。
 */
export function landAndWait(
  provider: Pick<CollabProvider, 'on' | 'land' | 'getState'>,
  getMarkdown: () => string | null,
  timeoutMs = 4000,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!provider.getState().lander) return resolve(true)
    const markdown = getMarkdown()
    if (markdown === null) return resolve(true)
    let done = false
    let off: () => void = () => {}
    const finish = (value: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      off()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    off = provider.on('saved', () => finish(true))
    if (!provider.land(markdown)) finish(false)
  })
}
