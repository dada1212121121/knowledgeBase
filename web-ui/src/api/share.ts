import { setSiteTimezone } from '@/utils/time'
// 分享与协作的接口封装:协作者、链接、共享给我、访问申请(都是能力调用),以及公开分享页用的 `/api/v1/share/{token}`。
// 请求 / 响应的形状以后端为准:
//   能力参数 crates/kb-capability/src/{sharing,links}.rs;响应 JSON 见 kb-cli/src/{share,link}_backend.rs 与 tests/e2e_{share,links}.rs;
//   公开接口 crates/kb-web/src/share_public.rs。
import { callCapability } from './client'
import { roleRank } from '@/utils/share'

/** 能授予 / 能放在链接上的角色,顺序即高低(后面的包含前面的全部能力)。 */
export type GrantRole = 'viewer' | 'commenter' | 'editor' | 'manager'
/** 有效角色:比授予的角色多一个「所有者」(所有权只能转移,不能当协作者授予)。 */
export type DocRole = GrantRole | 'owner'

// ---------------------------------------------------------------- 资源

/** 接口里「指哪个资源」的结构化写法(kb-core ShareTarget);客户端不用自己拼百分号编码的键。 */
export interface ShareTarget {
  kind: 'space' | 'collection' | 'dir' | 'file' | 'insight'
  /** 知识库 id;不写 = 我自己的知识库 */
  space_id?: string | null
  collection?: string | null
  /** dir / file 的路径(`a/b`) */
  path?: string | null
  /** insight 的笔记 id */
  id?: string | null
}

/** 别人能看到的一个人的资料(搜索结果、好友、协作者名单)。 */
export interface PublicProfile {
  id: string
  username: string
  display_name: string
  avatar: string | null
}

// ---------------------------------------------------------------- 协作者

export interface GrantRow {
  user: PublicProfile
  role: GrantRole
  /** 从上级(文件夹 / 集合 / 知识库)继承来的,在这一层改不了 */
  inherited: boolean
  /** 授权挂在哪个资源上(资源键,用 sourceLabel 转成「文件夹「运维」」) */
  source: string
  /** `direct` / `link:<链接 id>` / `request:<申请 id>` */
  via: string
  expires_at: number | null
}

export interface GrantList {
  target: ShareTarget
  key: string
  /** 我对它的角色(能进这个接口的至少是「可管理」) */
  my_role: DocRole
  owner: PublicProfile | null
  /** 停止了继承:只认这一层自己的授权 */
  inherit_broken: boolean
  grants: GrantRow[]
}

export interface EffectiveRole {
  /** null = 没有任何权限(不是 403,后端不暴露存在) */
  role: DocRole | null
  label?: string
  can: null | {
    view: boolean
    download: boolean
    comment: boolean
    edit: boolean
    create: boolean
    history: boolean
    restore: boolean
    manage_grants: boolean
    manage_links: boolean
    delete: boolean
    transfer_owner: boolean
  }
  source?: unknown
}

export const grantList = (target: ShareTarget) => callCapability<GrantList>('grant_list', { target })
export const grantSet = (target: ShareTarget, user_id: string, role: GrantRole, expires_days?: number) =>
  callCapability<{ grant: unknown; previous: GrantRole | null }>('grant_set', { target, user_id, role, ...(expires_days ? { expires_days } : {}) })
export const grantRemove = (target: ShareTarget, user_id: string) =>
  callCapability<{ removed: GrantRole | null }>('grant_remove', { target, user_id })
/** 多选分享:`role` 缺省 = 移除这个人在这些资源上的授权。整批原子。 */
export const grantBatch = (targets: ShareTarget[], people: { user_id: string; role?: GrantRole | null }[], expires_days?: number) =>
  callCapability<{ changed: number; unchanged: number; removed: number }>('grant_batch', {
    targets,
    people: people.map((person) => (person.role ? { user_id: person.user_id, role: person.role } : { user_id: person.user_id })),
    ...(expires_days ? { expires_days } : {}),
  })
export const setInherit = (target: ShareTarget, inherit: boolean) => callCapability<{ inherit: boolean }>('set_inherit', { target, inherit })
/** 账号级能力:对象由 target 里的 space_id 指明,不需要 X-KB-Space。 */
export const effectiveRole = (target: ShareTarget) => callCapability<EffectiveRole>('effective_role', { target })

// ---------------------------------------------------------------- 好友(只读,分享面板里「好友优先」要用)

export interface FriendRow extends PublicProfile {
  remark: string | null
  group_name: string | null
  since: number
}
export const friendList = () => callCapability<{ friends: FriendRow[] }>('friend_list', {})
/** 按**完整**用户名或邮箱找人;找不到 `user` 为 null。 */
export const friendSearch = (query: string) =>
  callCapability<{ user: PublicProfile | null; relation: 'none' | 'friend' | 'pending_out' | 'pending_in' }>('friend_search', { query })

// ---------------------------------------------------------------- 分享链接

export interface LinkInfo {
  id: string
  /** 令牌的最后 4 位:只让所有者认得出是哪条,不足以还原 */
  hint: string
  title: string
  /** 合集链接(多选生成) */
  bundle: boolean
  roots: ShareTarget[]
  audience: 'collaborators' | 'logged_in' | 'anyone'
  role: GrantRole
  has_password: boolean
  expires_at: number | null
  allow_download: boolean
  watermark: boolean
  allow_reshare: boolean
  enabled: boolean
  state: 'active' | 'closed' | 'expired' | 'revoked'
  views: number
  last_view_at: number | null
  created_at: number
  /** 游客现在实际能拿到的最高角色(管理员关掉游客评论 / 编辑后会低于 role);null = 游客已完全不能用 */
  guest_role: GrantRole | null
}

export interface LinkCreateArgs {
  target?: ShareTarget
  targets?: ShareTarget[]
  title?: string
  audience: LinkInfo['audience']
  role: GrantRole
  password?: string
  expires_days?: number
  allow_download?: boolean
  watermark?: boolean
}

export interface LinkUpdateArgs {
  id: string
  audience?: LinkInfo['audience']
  role?: GrantRole
  password?: string
  clear_password?: boolean
  expires_days?: number
  clear_expiry?: boolean
  allow_download?: boolean
  watermark?: boolean
  enabled?: boolean
  title?: string
}

export interface LinkStats {
  views: number
  last_view_at: number | null
  visitors: { user: PublicProfile | null; first_at: number; last_at: number; visits: number }[]
  anonymous_note: string
}

/** 链接地址(含令牌)只在创建 / 重置时返回这一次,之后只有 `hint`。 */
export const linkCreate = (args: LinkCreateArgs) => callCapability<{ link: LinkInfo; url: string }>('link_create', { ...args })
export const linkGet = (target: ShareTarget) => callCapability<{ target: ShareTarget; links: LinkInfo[] }>('link_get', { target })
export const linkUpdate = (args: LinkUpdateArgs) => callCapability<{ link: LinkInfo }>('link_update', { ...args })
export const linkReset = (id: string) => callCapability<{ link: LinkInfo; url: string }>('link_reset', { id })
export const linkRevoke = (id: string) => callCapability<{ revoked: boolean }>('link_revoke', { id })
export const linkStats = (id: string) => callCapability<LinkStats>('link_stats', { id })
export const myLinks = () => callCapability<{ links: LinkInfo[] }>('my_links', {})

// ---------------------------------------------------------------- 共享给我 / 我的分享

export interface SharedWithMeItem {
  target: ShareTarget
  key: string
  title: string
  role: GrantRole
  owner: PublicProfile
  shared_at: number
  expires_at: number | null
  hidden: boolean
}
export const sharedWithMe = (includeHidden = false) =>
  callCapability<{ items: SharedWithMeItem[] }>('shared_with_me', includeHidden ? { include_hidden: true } : {})
export const hideShare = (target: ShareTarget, hidden: boolean) => callCapability<{ hidden: boolean }>('hide_share', { target, hidden })

export interface SharedByMeItem {
  target: ShareTarget
  key: string
  title: string
  grantees: { user: PublicProfile; role: GrantRole }[]
  inherit_broken: boolean
}
export const sharedByMe = () => callCapability<{ items: SharedByMeItem[] }>('shared_by_me', {})

// ---------------------------------------------------------------- 访问申请

export interface AccessRequestRow {
  id: string
  key: string
  target: ShareTarget | null
  title: string
  requester: PublicProfile | null
  /** 申请的角色 */
  role: GrantRole
  message: string | null
  state: 'pending' | 'approved' | 'rejected'
  created_at: number
  decided_at: number | null
}
export const accessRequest = (target: ShareTarget, role: GrantRole, message?: string) =>
  callCapability<{ status: 'requested'; id?: string }>('access_request', { target, role, ...(message?.trim() ? { message: message.trim() } : {}) })
export const accessRequests = () => callCapability<{ to_decide: AccessRequestRow[]; mine: AccessRequestRow[] }>('access_requests', {})
export const accessDecide = (id: string, approve: boolean, role?: GrantRole) =>
  callCapability<{ state: AccessRequestRow['state']; role: GrantRole }>('access_decide', { id, approve, ...(approve && role ? { role } : {}) })

// ---------------------------------------------------------------- 公开分享页

/** 公开接口失败:带 HTTP 状态和后端的错误码(link_not_found / link_expired / wrong_password / locked …)。 */
export class ShareHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'ShareHttpError'
  }
}

export interface PublicVisitor {
  kind: 'user' | 'guest'
  id?: string
  username?: string
  display_name?: string
  /** 登录访客的头像文件名;没设头像是 null / 缺省 */
  avatar?: string | null
  nickname?: string
}

export interface PublicCan {
  view: boolean
  comment: boolean
  edit: boolean
  download: boolean
}

export interface PublicLocked {
  state: 'locked'
  requires_password: true
  site: { name: string; timezone?: string }
}

export interface PublicActive {
  state: 'active'
  requires_password: false
  site: { name: string; timezone?: string }
  space_id: string
  bundle: boolean
  title: string | null
  roots: ShareTarget[]
  role: DocRole
  can: PublicCan
  allow_download: boolean
  /** 水印文字(访问者名 · 时间);没开水印是 null */
  watermark: string | null
  visitor: PublicVisitor
  owner: { id: string; display_name: string; avatar: string | null } | null
  audience: LinkInfo['audience']
}

export type PublicInfo = PublicLocked | PublicActive

/** 分享人的头像地址:按链接校验(游客没登录也能看),`file` 是头像文件名,拼进 `v` 让缓存跟着换头像失效。没有头像返回 null。 */
export function ownerAvatarUrl(token: string, file: string | null | undefined): string | null {
  if (!file) return null
  return `/api/v1/share/${encodeURIComponent(token)}/owner-avatar?v=${encodeURIComponent(file)}`
}

const shareBase = (token: string) => `/api/v1/share/${encodeURIComponent(token)}`

/**
 * 公开接口的统一请求:带 CSRF 头,不跳登录页(401 在这里是「要输密码 / 要登录」的正常回答,不是会话过期)。
 * 成功返回 `data`;失败抛 ShareHttpError,message 是服务端写给人看的那句话。
 */
async function publicRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-kb-csrf': '1' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(path, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new ShareHttpError('连不上服务器。检查网络后重试。', 0, 'network')
  }
  const parsed = (await response.json().catch(() => null)) as { data?: T; error?: { code?: string; message?: string } } | null
  if (!response.ok) {
    throw new ShareHttpError(parsed?.error?.message ?? `请求失败(${response.status})`, response.status, parsed?.error?.code ?? 'unknown')
  }
  return (parsed?.data ?? ({} as T)) as T
}

/** 每调用一次算一次「打开」,所以页面只在进入 / 解锁后各取一次。 */
export async function publicInfo(token: string): Promise<PublicInfo> {
  const info = await publicRequest<PublicInfo>('GET', shareBase(token))
  // 游客没有登录态,拿不到 /auth/status;分享信息里的站点时区就是他们唯一的时间口径
  setSiteTimezone(info.site.timezone)
  return info
}
export const publicUnlock = (token: string, password: string) => publicRequest<{ unlocked: boolean }>('POST', `${shareBase(token)}/unlock`, { password })
export const publicRename = (token: string, nickname: string) => publicRequest<{ nickname: string }>('POST', `${shareBase(token)}/guest`, { nickname })
/** 通过链接调用白名单里的能力(读、评论、编辑)。 */
export const publicCall = <T>(token: string, capability: string, args: Record<string, unknown> = {}) =>
  publicRequest<T>('POST', `${shareBase(token)}/call/${capability}`, args)
/** 原件(图片、下载)的地址:同源,带着链接 cookie。 */
export const publicRawUrl = (token: string, collection: string, path: string) =>
  `${shareBase(token)}/raw?${new URLSearchParams({ collection, path }).toString()}`
/** 流式下载地址:和原件分开,不受 `/raw` 的 64 MB 预览上限限制。 */
export const publicDownloadUrl = (token: string, collection: string, path: string) =>
  `${shareBase(token)}/download?${new URLSearchParams({ collection, path }).toString()}`

// ---------------------------------------------------------------- 打开别人的内容:共享给我 / 公开链接用同一套查看器

/**
 * 查看 / 评论 / 编辑别人的内容所需要的一切:怎么调能力、原件地址怎么拼、我能做什么。
 * 查看器(SharedDoc / SharedFolder / DocComments)只认这个,不关心内容是「共享给我」还是「公开链接」来的。
 */
export interface ShareAccess {
  call: <T>(capability: string, args?: Record<string, unknown>) => Promise<T>
  rawUrl: (collection: string, path: string) => string
  /** 流式下载;没有时下载入口退回 `rawUrl`(旧入口 / 测试桩)。 */
  downloadUrl?: (collection: string, path: string) => string
  can: { edit: boolean; comment: boolean; download: boolean }
  /**
   * 访问者是没登录的游客(只有公开链接会是)。游客没有会话:头像接口会回 401,评论里不请求头像图片,只画首字母。
   * 缺省 = 登录用户。
   */
  guest?: boolean
  /**
   * 经公开链接访问(游客或登录用户都算)。链接能调的能力只有后端白名单里那几个(share_public.rs 的 LINK_CAPABILITIES),
   * 其余一律 403:页面不该去请求白名单之外的能力(例如 AI 的修改建议 doc_proposals),否则每次打开都白挨一个 403,
   * 浏览器控制台里留一条红色错误。缺省 = 不是链接入口。
   */
  viaLink?: boolean
  /**
   * 在线协作编辑要的连接信息:文档所在知识库,以及(公开链接)链接令牌。
   * 缺省 = 这个入口不支持协作,编辑退回到「改完整篇再保存」。
   */
  collab?: { spaceId: string; linkToken?: string }
}

/**
 * 我自己的知识库:不带 X-KB-Space。知识库页的评论栏和「共享给我 / 公开链接」的评论共用一个组件,
 * 所以自己的文档也包成 ShareAccess;`comment` 由功能点 docs.annotate 决定(没开通就只能看)。
 */
export function ownAccess(canComment: boolean): ShareAccess {
  return {
    call: (capability, args = {}) => callCapability(capability, args),
    rawUrl: (collection, path) => `/api/v1/raw?${new URLSearchParams({ collection, path }).toString()}`,
    downloadUrl: (collection, path) => `/api/v1/download?${new URLSearchParams({ collection, path }).toString()}`,
    can: { edit: true, comment: canComment, download: true },
  }
}

/** 共享给我:每次调用都显式带 X-KB-Space(对方的知识库 id),不是全局状态。角色决定能做什么(后端照样逐次检查)。 */
export function spaceAccess(space: string, role: string): ShareAccess {
  return {
    call: (capability, args = {}) => callCapability(capability, args, { space }),
    rawUrl: (collection, path) => `/api/v1/raw?${new URLSearchParams({ collection, path, space }).toString()}`,
    downloadUrl: (collection, path) => `/api/v1/download?${new URLSearchParams({ collection, path, space }).toString()}`,
    can: { edit: roleRank(role) >= roleRank('editor'), comment: roleRank(role) >= roleRank('commenter'), download: true },
    ...(space ? { collab: { spaceId: space } } : {}),
  }
}

/** 公开链接:能力走 /share/{token}/call/…(只开放白名单),原件走 /share/{token}/raw。 */
export function linkAccess(token: string, can: PublicCan, options: { guest?: boolean; spaceId?: string | null } = {}): ShareAccess {
  return {
    call: (capability, args = {}) => publicCall(token, capability, args),
    rawUrl: (collection, path) => publicRawUrl(token, collection, path),
    downloadUrl: (collection, path) => publicDownloadUrl(token, collection, path),
    can: { edit: can.edit, comment: can.comment, download: can.download },
    viaLink: true,
    ...(options.guest ? { guest: true } : {}),
    ...(options.spaceId ? { collab: { spaceId: options.spaceId, linkToken: token } } : {}),
  }
}
