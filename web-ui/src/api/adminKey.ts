// 用户自己的 admin key 与「AI 接入指南」(后端 crates/kb-web/src/admin_key.rs)。
// 都是浏览器会话接口:key 只给本人看,所以不走能力调用。
import { accountRequest } from './client'

export interface AdminKeyInfo {
  /** `kb_ak_…` 明文。 */
  admin_key: string
  created_at: number
  /** 最近一次轮换;从没轮换过是 null。 */
  rotated_at: number | null
}

export const adminKeyGet = () => accountRequest<AdminKeyInfo>('GET', '/api/v1/me/admin-key', { signedIn: true })

/** 轮换:旧 key 立刻失效,已经下载的指南和配好的脚本都要换成新的。 */
export const adminKeyRotate = () => accountRequest<AdminKeyInfo>('POST', '/api/v1/me/admin-key/rotate', { signedIn: true })

/** 指南的地址。带上页面自己的 origin:浏览器知道用户实际是从哪个地址打开的,比服务端猜得准。 */
export function aiGuideUrl(download: boolean, origin = window.location.origin): string {
  const query = new URLSearchParams({ base: origin })
  if (download) query.set('download', '1')
  return `/api/v1/me/ai-guide?${query.toString()}`
}

/** 取指南正文(给「复制全文」用)。 */
export async function aiGuideText(): Promise<string> {
  const response = await fetch(aiGuideUrl(false), { credentials: 'same-origin' })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? `读取失败(${response.status})`)
  }
  return response.text()
}
