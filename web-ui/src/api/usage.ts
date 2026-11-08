// 存储与用量相关的接口类型和调用。
// 形状以后端为准:crates/kb-cli/src/admin_backend.rs 的 storage_overview / llm_usage_overview / usage_mine,
// 以及 crates/kb-cli/tests/e2e_multiuser.rs 里的断言。管理员的统计只有数字,没有任何人的笔记或文件内容。
import { callCapability } from '@/api/client'

/** 一个知识库(= 一个人)的占用明细;字节数都是统计任务最近一次量出来的。 */
// 用 type 而不是 interface:响应式表格的行类型要求有字符串索引签名,interface 过不了
export type StorageRow = {
  space_id: string
  owner_id: string
  /** 账号已被删除时为 null。 */
  username: string | null
  display_name: string | null
  /** 上传后落在 sources/ 的原始文件。 */
  sources_bytes: number
  /** 还没处理完的上传分片。 */
  uploads_bytes: number
  /** 向量与全文索引。用户看不见,但计入配额。 */
  vectors_bytes: number
  /** 元数据库(笔记、批注、文档元数据都在里面)。 */
  meta_bytes: number
  /** 外部编码代理的工作目录。 */
  workspace_bytes: number
  total_bytes: number
  /** 统计时间(毫秒)。 */
  measured_at: number
  /** 这个人的存储上限(字节);0 = 不限。 */
  limit_bytes: number
}

export interface StorageOverview {
  disk: {
    free_gb: number
    /** 全站保留空间(GB);0 = 没有开启保护。 */
    reserve_gb: number
    /** 剩余低于保留值:全站已经停止上传。 */
    paused: boolean
    /** 剩余低于保留值的 2 倍:提前告警。 */
    warn: boolean
  }
  totals: {
    measured_spaces: number
    total_spaces: number
    total_bytes: number
    vectors_bytes: number
    oldest_measured_at: number | null
  }
  top: StorageRow[]
}

export type LlmUsageRow = {
  user_id: string
  username: string | null
  display_name: string | null
  calls: number
  input_tokens: number
  output_tokens: number
  /** 输入 + 输出。 */
  tokens: number
  /** 他每天的额度;0 = 不限。 */
  limit: number
}

export interface LlmUsageOverview {
  /** UTC 日期,`YYYY-MM-DD`。 */
  day: string
  /** 只是榜内这些人的合计(榜最多 100 人),不是全站总数。 */
  total_tokens: number
  ranking: LlmUsageRow[]
}

/** 我自己的用量(任何登录用户都能调,只看得到自己的)。 */
export interface MyUsage {
  storage: {
    sources_bytes: number
    uploads_bytes: number
    vectors_bytes: number
    meta_bytes: number
    workspace_bytes: number
    total_bytes: number
    /** 0 = 不限。 */
    limit_bytes: number
  }
  ai: { day: string; tokens_today: number; limit: number }
}

/** 排行最多 100 个(后端上限),没有翻页参数。 */
export const STORAGE_TOP_LIMIT = 100

export const storageOverview = (limit = STORAGE_TOP_LIMIT) => callCapability<StorageOverview>('storage_overview', { limit })
export const llmUsageOverview = (day?: string, limit = STORAGE_TOP_LIMIT) =>
  callCapability<LlmUsageOverview>('llm_usage_overview', { ...(day ? { day } : {}), limit })
export const usageMine = () => callCapability<MyUsage>('usage_mine', {})

// ---------------------------------------------------------------- 分享治理(sys.ops)

/** 全站分享链接的一行:只有元数据,没有链接令牌和被分享的内容。 */
export type AdminLink = {
  id: string
  /** 令牌末几位,只用来在列表里认出是哪条。 */
  hint: string
  /** space / collection / dir / file / insight,多份内容合在一起的链接是 bundle。 */
  kind: string
  audience: 'collaborators' | 'logged_in' | 'anyone'
  role: string
  has_password: boolean
  /** active / closed / expired / revoked */
  state: string
  views: number
  last_view_at: number | null
  created_at: number
  creator: AdminLinkPerson | null
  /** 被分享内容所在知识库的主人;账号已删除时为 null。 */
  owner: AdminLinkPerson | null
}
export type AdminLinkPerson = { id: string; username: string; display_name: string | null; avatar: string | null }
export interface AdminLinkPage {
  links: AdminLink[]
  total: number
  page: number
  page_size: number
}

export const SHARE_ADMIN_PAGE_SIZE = 50
export const shareAdminList = (page = 1, pageSize = SHARE_ADMIN_PAGE_SIZE) =>
  callCapability<AdminLinkPage>('share_admin_list', { page, page_size: pageSize })
export const shareAdminRevoke = (id: string) => callCapability<{ revoked: boolean }>('share_admin_revoke', { id })
