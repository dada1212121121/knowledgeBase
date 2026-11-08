// 批量问「这些人有没有头像」(多人编辑的在线名单只有用户 id,没有头像文件名)。
//
// 为什么不直接按 id 去取图:没有头像的人,`/users/{id}/avatar` 回 404,浏览器会把每一个都打到控制台上,
// 还白白多了请求。先用 `GET /api/v1/users/avatars?ids=…` 问清楚,只给**有头像**的人发图片请求。
// 失败一律静默:头像只是装饰,查不到就画首字母,不弹错、不跳登录页。
import { isGuestId } from '@/utils/avatar'

/** 记多久:别人换了头像,一分钟内就会跟上(图片地址带着文件名当版本,换头像后是新地址,不会读到旧图) */
const TTL_MS = 60_000
/** 与服务端 `MAX_AVATAR_LOOKUP` 一致 */
const MAX_IDS = 50

interface Entry {
  file: string | null
  at: number
}
const cache = new Map<string, Entry>()
/** 正在查的 id:同一时刻多处要同一个人的头像(头像堆 + 名单),只发一次请求 */
const pending = new Map<string, Promise<void>>()

const fresh = (id: string, now: number) => {
  const entry = cache.get(id)
  return !!entry && now - entry.at < TTL_MS
}

/** 缓存里已知的头像文件名;`undefined` 表示还没查过 */
export function cachedAvatar(id: string): string | null | undefined {
  return cache.get(id)?.file
}

/** 测试用:清空缓存和在途请求。 */
export function resetAvatarLookup(): void {
  cache.clear()
  pending.clear()
}

async function fetchChunk(chunk: string[]): Promise<void> {
  let found: Record<string, string | null> = {}
  try {
    const response = await fetch(`/api/v1/users/avatars?ids=${encodeURIComponent(chunk.join(','))}`, { credentials: 'same-origin' })
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { data?: { avatars?: Record<string, string | null> } } | null
      found = body?.data?.avatars ?? {}
    }
  } catch {
    // 网络问题:当作都没有,下面照常写缓存,一分钟内不再重试(免得断网时每次渲染都打一遍)
  }
  const at = Date.now()
  for (const id of chunk) {
    const file = found[id]
    cache.set(id, { file: typeof file === 'string' && file ? file : null, at })
  }
}

/**
 * 查这些人的头像文件名,返回 `{ id: 文件名 | null }`。游客没有头像,不查。
 * 一分钟内问过的直接用缓存;超过 50 个自动分批。
 */
export async function lookupAvatars(ids: string[]): Promise<Record<string, string | null>> {
  const wanted = [...new Set(ids)].filter((id) => id && !isGuestId(id))
  const now = Date.now()
  const need = wanted.filter((id) => !fresh(id, now) && !pending.has(id))
  for (let at = 0; at < need.length; at += MAX_IDS) {
    const chunk = need.slice(at, at + MAX_IDS)
    // fetchChunk 自己吞掉所有错误,不会 reject;finally 里摘掉在途标记
    const run = fetchChunk(chunk).finally(() => {
      for (const id of chunk) pending.delete(id)
    })
    for (const id of chunk) pending.set(id, run)
  }
  await Promise.all(wanted.map((id) => pending.get(id)))
  return Object.fromEntries(wanted.map((id) => [id, cache.get(id)?.file ?? null]))
}
