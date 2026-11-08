import { setSiteTimezone } from '@/utils/time'
import { readJsonBody } from './jsonBody'

// 能力调用的统一封装(§):自动带 CSRF 头,401 跳登录页。
export interface CallOptions {
  dryRun?: boolean
  cwd?: string
  project?: string
  /**
   * 对方的知识库 id:访问别人分享给我的内容时带上(请求头 `X-KB-Space`)。
   * 不带 = 我自己的知识库。每次调用显式传,不做全局状态:否则「共享给我」打开着的时候,
   * 通知、会话这些后台请求也会被误发到对方的知识库里。
   */
  space?: string
  /**
   * 管理员只读查看别人的知识库:目标用户 id(请求头 `X-KB-Admin-View`)。
   * 与 `space` 互斥。只在该查看子树里由 `useViewCall` 显式带上,不放进全局状态。
   */
  adminView?: string
}

export interface CapabilityResponse<T = unknown> {
  ok: boolean
  data: T
  meta?: Record<string, unknown>
  error?: { code: string; message: string }
}

/** 能力调用失败时抛出的错误(带设计规范的错误码)。 */
export class CapabilityError extends Error {
  code: string
  status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'CapabilityError'
    this.code = code
    this.status = status
  }

  /** 是否是乐观锁冲突(409)。 */
  get isConflict() {
    return this.status === 409
  }
}

/** 返回的不是能力响应(不是 JSON)时给人看的话。502/503/504/524 是网关层说"后面没回话"。 */
function gatewayText(status: number): string {
  if ([502, 503, 504, 524].includes(status)) {
    return `服务暂时没有响应(HTTP ${status}),可能正在重启,或这次请求花的时间太长被中断了`
  }
  return `服务返回了无法识别的内容(HTTP ${status})`
}

/** 调一个能力;失败抛错(带 code)。 */
export async function callCapability<T = unknown>(
  name: string,
  args: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<T> {
  const query = options.dryRun ? '?dry_run=true' : ''
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-kb-csrf': '1',
  }
  if (options.cwd) headers['x-kb-cwd'] = encodeURIComponent(options.cwd)
  if (options.project) headers['x-kb-project'] = encodeURIComponent(options.project)
  if (options.space) headers['x-kb-space'] = options.space
  if (options.adminView) headers['x-kb-admin-view'] = options.adminView
  const response = await fetch(`/api/v1/capabilities/${name}${query}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify(args),
  })
  if (response.status === 401) {
    // 已经在登录页就不要再跳(整页刷新会形成无限循环);其余页面带上当前位置,登录后回到原处
    const { pathname = '/', search = '' } = window.location
    if (pathname !== '/login') {
      const next = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`
      window.location.href = `/login${next}`
    }
    throw new CapabilityError('未登录', 'unauthorized', 401)
  }
  let body: CapabilityResponse<T>
  try {
    // 大响应体（几 MB 的文件预览正文）的解码 + 解析不放在主线程，见 jsonBody.ts
    body = (await readJsonBody(response)) as CapabilityResponse<T>
  } catch {
    // 守护进程重启、网关超时时,前面那层返回的是纯文本或 HTML,不是 JSON;
    // 直接解析会抛 SyntaxError,界面只能显示"没有预料到的错误",还会让人去查不相干的东西
    throw new CapabilityError(gatewayText(response.status), 'bad_gateway', response.status)
  }
  if (!response.ok || !body.ok) {
    const message = body.error?.message ?? `HTTP ${response.status}`
    throw new CapabilityError(message, body.error?.code ?? 'internal', response.status)
  }
  return body.data
}

// --- 各能力的返回形状(只声明页面用到的字段) ---

export interface Health {
  status: string
  version: string
}

export async function health(): Promise<Health> {
  const response = await fetch('/api/v1/health', { credentials: 'same-origin' })
  const body = (await response.json()) as { data: Health }
  return body.data
}

export interface JobSummary {
  id: string
  kind: string
  collection: string | null
  state: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'canceled'
  progress_done: number
  progress_total: number | null
  rate: number | null
  error: string | null
  /** 一句话详情(例如「bge-m3 · 912 块」);后端暂未提供,没有就回退到 error */
  detail?: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

export interface CollectionStats {
  name: string
  kind: string
  project_id: string | null
  /** 向量库行数(块数),存储和仪表盘用 */
  rows: number
  /** 可浏览的条目数(文件 + 笔记);界面上写“多少条”都用它 */
  items: number
  embedder_id: string
  dim: number
  last_indexed_at: number | null
}

export interface StatsOverview {
  collections: CollectionStats[]
  totals: { rows: number; insights: number; projects: number }
  jobs: {
    queued: number
    running: number
    paused: number
    done: number
    failed: number
    canceled: number
  }
  drafts_pending: number
  embedder: { id: string; dim: number; state: string; error: string | null }
  reranker: { mode: string; available: boolean }
  /** 趋势类指标;后端暂未提供,没有就不画迷你折线 / 不显示对应副标题 */
  trends?: {
    rows?: { delta?: string; series?: number[] }
    insights?: { delta?: string; series?: number[] }
    drafts?: { stale_24h?: number }
    search_p95?: { ms: number; delta_ms?: number; series?: number[] }
  }
  recent_events: {
    id: string
    kind: string
    project_id: string | null
    payload_json: string
    received_at: number
    processed_at: number | null
    result: string | null
  }[]
  activity_7d: { day: string; collection: string; insights: number }[]
}

/** `list_projects` 的一项:`{ project, collection, rows }`(不是拍平的 Project)。 */
export interface ProjectInfo {
  project: Project
  collection: string
  rows: number
}

/** 项目本体。 */
export interface Project {
  id: string
  name: string
  slug: string
  root_path: string
  include: string[]
  exclude: string[]
  is_git: boolean
  last_commit: string | null
  last_indexed_at: number | null
  allow_cloud_llm: boolean
  extract_enabled: boolean
  hooks_installed: boolean
  created_at: number
}

export interface ItemSummary {
  id: string
  collection: string
  kind: 'code' | 'doc' | 'insight' | 'external' | 'summary'
  lang: string | null
  source: string
  start_line: number | null
  end_line: number | null
  symbol: string | null
  title: string | null
  status: 'active' | 'superseded' | 'deprecated'
  tags: string[]
  updated_at: number
  version: number | null
  /** 按文件列(`group_by_file`)时:这个文件被切成了多少块。块是检索的单位,人看到的永远是整份文件 */
  chunks?: number
  /** 后端暂未提供;有就显示(置信度 0–1),没有就显示版本 */
  confidence?: number | null
  /** insight 的子类型 decision / pitfall / howto …;后端暂未提供,没有就显示 kind */
  insight_kind?: string | null
}

export interface ItemList {
  items: ItemSummary[]
  total: number
  page: number
  page_size: number
}

export interface RecordRow {
  id: string
  collection: string
  kind: ItemSummary['kind']
  lang: string | null
  source: string
  start_line: number | null
  end_line: number | null
  symbol: string | null
  title: string | null
  text: string
  header: string
  tags: string[]
  status: ItemSummary['status']
  updated_at: number
  /** 以下三个字段后端暂未提供;有就显示(详情元数据里),没有就整行隐藏 */
  confidence?: number | null
  insight_kind?: string | null
  origin?: string | null
  embedded_at?: number | null
}

export interface ItemDetail {
  item: RecordRow
  /** insight 的乐观锁版本(保存时要带回去);文件详情没有这个字段 */
  version?: number | null
  context: string | null
}

/** 一条检索命中:设计规范的 Hit 契约(字段是拍平的,没有 `row` 包装)。 */
export interface SearchHit {
  id: string
  collection: string
  kind: ItemSummary['kind']
  source: string
  start_line: number | null
  end_line: number | null
  symbol: string | null
  title: string | null
  snippet: string
  score: number
  related: { id: string; title: string | null }[]
  explain: {
    store_rank: number | null
    fused_rank: number | null
    fts_rank: number | null
    /** 全文阶段的原始分数(BM25)。 */
    fts_score?: number | null
    /** 向量阶段的原始分数(1 - 距离)。 */
    vector_rank?: number | null
    vector_score?: number | null
    /** 融合分数(RRF)。 */
    fused_score?: number
    /** 该 collection 在融合时的权重。 */
    fused_weight?: number | null
    /** 重排后的名次(没有重排时为 null)。 */
    rerank_rank?: number | null
    window?: { path: string; start_line: number; end_line: number } | null
  } | null
  /** 当前阶段:块在原文里的位置(PDF 页码 / 表格单元格 / 幻灯片 / 时间戳)。 */
  anchor?: {
    kind: 'line' | 'page' | 'cell' | 'slide' | 'time'
    start?: number
    end?: number
    page?: number
    sheet?: string
    cell?: string
    slide?: number
    start_ms?: number
    end_ms?: number
  } | null
}

export interface SearchResponse {
  hits: SearchHit[]
  scope: string[]
  query_parsed: Record<string, unknown>
  degraded: string | null
  /** 重排真的参与了这次排序(没装重排模型 / 超时 / 关掉都是 false) */
  reranked?: boolean
  /** 各阶段耗时(毫秒;explain 打开时后端才采集)。 */
  timings?: {
    parse_ms: number
    embed_ms: number
    store_ms: number
    fts_ms: number
    vector_ms: number
    fuse_ms: number
    rerank_ms: number
    total_ms: number
  } | null
}

export interface AuditEntry {
  id: number
  at: number
  actor: string
  capability: string
  args_json: string
  ok: boolean
  error: string | null
  batch_id: string | null
  dry_run: boolean
}

export interface ChangeView {
  seq: number
  target: string
  op: string | null
  revertible: boolean
}

export interface BatchView {
  id: string
  actor: string
  description: string
  created_at: number
  reverted_at: number | null
  changes: ChangeView[]
  /** MCP 协议版本;后端暂未提供,没有就显示「—」 */
  protocol?: string | null
}

export interface EvalReport {
  hit_at_1: number
  hit_at_5: number
  mrr: number
  total: number
  degraded: string | null
  per_query: { query: string; rank: number | null }[]
}

/** `kb auth token list` 的网页版。 */
export interface ApiToken {
  id: string
  name: string
  scopes: string
  /** 后端的原字段:`mcp` 或 `api`(`scopes` 是 listTokens 为旧页面补的别名)。 */
  scope?: string
  /** 远程 MCP 令牌是否也搜别人分享给我的内容(只有 mcp 令牌可能为真)。 */
  include_shared?: boolean
  created_at: number
  last_used: number | null
  revoked_at: number | null
}

export async function listTokens(): Promise<ApiToken[]> {
  const response = await fetch('/api/v1/auth/tokens', {
    credentials: 'same-origin',
    headers: { 'x-kb-csrf': '1' },
  })
  if (response.status === 401) {
    // 已经在登录页就不要再跳(整页刷新会形成无限循环);其余页面带上当前位置,登录后回到原处
    const { pathname = '/', search = '' } = window.location
    if (pathname !== '/login') {
      const next = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`
      window.location.href = `/login${next}`
    }
    throw new CapabilityError('未登录', 'unauthorized', 401)
  }
  const body = (await response.json()) as { data?: { tokens?: ApiToken[] } }
  return (body.data?.tokens ?? []).map((token) => ({
    ...token,
    // 后端字段叫 scope,页面按 scopes 用
    scopes: token.scopes ?? (token as unknown as { scope?: string }).scope ?? '',
  }))
}

/** 登录 / 注册页要知道的站点状态(都是公开信息,不含服务器内部细节)。 */
export interface AuthStatus {
  password_set: boolean
  logged_in: boolean
  /** 能不能注册:管理员开了注册,并且邮件已配置好。 */
  registration_open: boolean
  /** 注册是否需要邀请码。 */
  require_invite: boolean
  /** 邮件是否可用(找回密码依赖它)。 */
  mail_ready: boolean
  site: { name: string; tagline: string; timezone?: string }
}

/**
 * 登录状态(响应是设计规范的 `{ok, data}` 信封,要解出 data)。
 *
 * 请求失败时**抛错**而不是返回 `password_set: false`——否则守护进程没起来会被误判成
 * “首次使用”,登录页会渲染成首次使用引导页(截图串页的根因)。
 */
export async function authStatus(): Promise<AuthStatus> {
  const response = await fetch('/api/v1/auth/status', { credentials: 'same-origin' })
  if (!response.ok) throw new CapabilityError(`auth/status ${response.status}`, 'unavailable', response.status)
  const body = (await response.json()) as { data?: Partial<AuthStatus> }
  const data = body.data ?? {}
  // 全站时间显示 / “今天”都以站点时区为准;登录页拿到的这个公开字段就是唯一来源
  setSiteTimezone(data.site?.timezone)
  return {
    password_set: data.password_set === true,
    logged_in: data.logged_in === true,
    registration_open: data.registration_open === true,
    require_invite: data.require_invite === true,
    mail_ready: data.mail_ready === true,
    site: { name: data.site?.name || '知识库', tagline: data.site?.tagline ?? '', timezone: data.site?.timezone },
  }
}

/**
 * 调一个公开的账号接口(要验证码 / 注册 / 找回密码 / 查邀请码)。
 * 失败时抛 `Error`,消息就是服务端给用户看的那句话;限频时带上 `retryAfter` 秒数。
 */
export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter = 0,
    /** 后端 `error.code`(如 `bad_code`、`challenge_expired`):同一个状态码下要靠它区分是哪一种错。 */
    readonly code = '',
  ) {
    super(message)
  }
}

/**
 * 账号类接口的通用请求:带 CSRF 头,失败时抛 `AccountError`(消息就是服务端给用户看的那句话)。
 *
 * `signedIn: true` 的接口(个人资料、登录设备)遇到 401 说明会话过期了,和能力调用一样整页回登录页;
 * 注册、找回密码这类公开接口的 401 不会出现,也不该跳转。
 */
export async function accountRequest<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'GET',
  path: string,
  options: { json?: unknown; bytes?: Blob; signedIn?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'x-kb-csrf': '1' }
  let body: BodyInit | undefined
  if (options.bytes) {
    headers['content-type'] = 'application/octet-stream'
    body = options.bytes
  } else if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  const response = await fetch(path, { method, credentials: 'same-origin', headers, body })
  if (response.status === 401 && options.signedIn) {
    const { pathname = '/', search = '' } = window.location
    if (pathname !== '/login') {
      window.location.href = `/login?next=${encodeURIComponent(pathname + search)}`
    }
    throw new AccountError('登录已过期,请重新登录', 401)
  }
  const parsed = (await response.json().catch(() => null)) as {
    data?: T
    error?: { message?: string; code?: string }
  } | null
  if (!response.ok) {
    // 413 来自框架(请求体超过上限),没有我们的提示语
    const fallback = response.status === 413 ? '文件太大了' : `请求失败(${response.status})`
    // 服务端的错误文案前面带一个「invalid input: 」之类的前缀,给人看的话不需要它
    const message = (parsed?.error?.message ?? fallback).replace(/^invalid input:\s*/i, '')
    throw new AccountError(message, response.status, Number(response.headers.get('retry-after') ?? 0) || 0, parsed?.error?.code ?? '')
  }
  return (parsed?.data ?? ({} as T)) as T
}

const accountPost = <T>(path: string, payload: unknown) => accountRequest<T>('POST', path, { json: payload })

/** 给邮箱发验证码(注册或找回密码)。不论邮箱是否注册过,回答都一样。 */
export const requestEmailCode = (email: string, purpose: 'register' | 'reset') =>
  accountPost<{ sent: boolean; wait_secs: number; ttl_minutes: number }>('/api/v1/auth/email-code', {
    email,
    purpose,
  })

/** 注册。成功后服务端已设置登录 cookie。 */
export const registerAccount = (form: {
  email: string
  code: string
  username: string
  password: string
  display_name?: string
  invite?: string
}) => accountPost<{ registered: boolean; username: string }>('/api/v1/auth/register', form)

/** 邮箱验证码 + 新密码。成功后这个账号在所有设备上的登录都失效。 */
export const resetPassword = (form: { email: string; code: string; new_password: string }) =>
  accountPost<{ reset: boolean }>('/api/v1/auth/password/reset', form)

/** 注册页填完邀请码后即时检查有没有效(不占用次数)。 */
export const checkInvite = (invite: string) =>
  accountPost<{ valid: boolean; code?: string; reason?: string }>('/api/v1/auth/invite-check', { invite })

/** 已登录用户改密码;其它设备上的登录会失效,当前设备保留。 */
export const changePassword = (old_password: string, new_password: string) =>
  accountRequest<{ changed: boolean }>('POST', '/api/v1/auth/change-password', {
    json: { old_password, new_password },
    signedIn: true,
  })

/** 退出登录(会话 cookie 由服务端清掉)。 */
export async function logout(): Promise<void> {
  const response = await fetch('/api/v1/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-kb-csrf': '1' },
  })
  if (!response.ok && response.status !== 401) {
    throw new CapabilityError(`logout ${response.status}`, 'unavailable', response.status)
  }
}

/** 登录结果:直接登录成功,或者密码对了但账号开着两步验证、还要再输验证码。 */
export type LoginResult = { kind: 'ok' } | { kind: 'totp'; challenge: string }

/**
 * 登录。开着两步验证的账号,密码对了不会发会话,只返回一个挑战(`challenge`),
 * 页面拿它加验证码去 `loginTotp` 换会话。挑战只放在调用方的内存里,不要写进地址栏或本地存储。
 */
export async function login(password: string, username = ''): Promise<LoginResult> {
  const response = await fetch('/api/v1/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    // 多用户:用户名或邮箱 + 密码。旧部署只有一个账号时,后端不带用户名也认
    body: JSON.stringify({ login: username.trim() || undefined, password }),
  })
  const body = (await response.json().catch(() => null)) as {
    data?: { logged_in?: boolean; totp_required?: boolean; challenge?: string }
    error?: { message?: string; code?: string }
  } | null
  if (!response.ok) {
    throw new AccountError(body?.error?.message ?? '登录失败', response.status, Number(response.headers.get('retry-after') ?? 0) || 0, body?.error?.code ?? '')
  }
  if (body?.data?.totp_required === true) {
    // 没有挑战就没法继续验证:宁可报错也不要让页面停在一个永远提交不了的验证码步骤
    if (!body.data.challenge) throw new AccountError('登录服务返回的结果不完整,请稍后再试', 502, 0, 'bad_response')
    return { kind: 'totp', challenge: body.data.challenge }
  }
  // 没拿到会话就不能当成登录成功去跳页面
  if (body?.data?.logged_in === false) throw new AccountError('登录没有完成,请重试', 502, 0, 'bad_response')
  return { kind: 'ok' }
}

/** 两步验证那一步:挑战 + 6 位验证码(或恢复码)换会话。失败抛 `AccountError`,靠 `code` 区分原因。 */
export async function loginTotp(challenge: string, code: string): Promise<void> {
  const response = await fetch('/api/v1/auth/login/totp', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-kb-csrf': '1' },
    body: JSON.stringify({ challenge, code }),
  })
  if (response.ok) return
  const body = (await response.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null
  throw new AccountError(body?.error?.message ?? '验证失败', response.status, Number(response.headers.get('retry-after') ?? 0) || 0, body?.error?.code ?? '')
}

// ---------------------------------------------------------------- 个人资料(已登录)

export interface LoginSession {
  id: string
  current: boolean
  device: string
  ip: string | null
  created_at: number
  last_seen: number
  expires_at: number
}

/** 改显示名。 */
export const updateDisplayName = (display_name: string) =>
  accountRequest<{ display_name: string }>('PATCH', '/api/v1/me/profile', { json: { display_name }, signedIn: true })

/** 上传头像:请求体就是图片本身。成功返回新的头像文件名。 */
export const uploadAvatar = (image: Blob) =>
  accountRequest<{ avatar: string }>('PUT', '/api/v1/me/avatar', { bytes: image, signedIn: true })

/** 移除头像(恢复成首字母)。 */
export const removeAvatar = () => accountRequest<{ avatar: null }>('DELETE', '/api/v1/me/avatar', { signedIn: true })

/** 我的登录设备。 */
export const listSessions = () =>
  accountRequest<{ sessions: LoginSession[] }>('GET', '/api/v1/me/sessions', { signedIn: true })

/** 退出某个设备;`current` 为真说明退出的是当前设备,页面应回登录页。 */
export const revokeSession = (id: string) =>
  accountRequest<{ revoked: boolean; current: boolean }>('DELETE', `/api/v1/me/sessions/${encodeURIComponent(id)}`, {
    signedIn: true,
  })

/** 退出除当前设备外的所有设备。 */
export const revokeOtherSessions = () =>
  accountRequest<{ revoked: number }>('POST', '/api/v1/me/sessions/revoke-others', { signedIn: true })

/** 申请注销账号:要再输一次当前密码。成功返回冷静期结束的时间(毫秒时间戳)。 */
export const requestAccountDeletion = (password: string) =>
  accountRequest<{ delete_after: number }>('POST', '/api/v1/me/deletion', { json: { password }, signedIn: true })

/** 撤销注销申请。 */
export const cancelAccountDeletion = () =>
  accountRequest<{ cancelled: boolean }>('DELETE', '/api/v1/me/deletion', { signedIn: true })

/** 更换邮箱第一步:要当前密码,验证码发到**新**邮箱。不论新邮箱是否被占用,回答都一样。 */
export const requestEmailChangeCode = (new_email: string, password: string) =>
  accountRequest<{ sent: boolean; wait_secs: number; ttl_minutes: number }>('POST', '/api/v1/me/email-code', {
    json: { new_email, password },
    signedIn: true,
  })

/** 更换邮箱第二步:新邮箱收到的验证码。成功后旧邮箱会收到通知。 */
export const confirmEmailChange = (new_email: string, code: string) =>
  accountRequest<{ email: string }>('POST', '/api/v1/me/email', { json: { new_email, code }, signedIn: true })

/** 个人数据导出的状态(与后端 `ExportStatus` 一一对应)。 */
export type ExportState =
  | { state: 'idle'; today_left: number }
  | { state: 'running'; bytes_done: number; bytes_total: number; files: number; notes: number }
  | { state: 'ready'; size: number; files: number; notes: number; skipped: string[]; expires_at: number }
  | { state: 'failed'; reason: string }

/** 现在的导出状态。 */
export const exportStatus = () => accountRequest<ExportState>('GET', '/api/v1/me/export', { signedIn: true })

/** 开始导出。 */
export const startExport = () => accountRequest<ExportState>('POST', '/api/v1/me/export', { signedIn: true })

/** 删除已生成的导出文件。 */
export const discardExport = () => accountRequest<{ discarded: boolean }>('DELETE', '/api/v1/me/export', { signedIn: true })

/** 下载地址:普通链接就行,浏览器自带 cookie;文件是流式发送的。 */
export const EXPORT_DOWNLOAD_URL = '/api/v1/me/export/download'
