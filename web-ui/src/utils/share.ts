import { clockText, daysAgo, monthDayText, weekday } from './time'
// 分享与协作的纯逻辑:角色、资源(target)、链接设置、报错文案、合并多项授权。
// 不碰网络和组件,所以每条规则都能直接单测。后端口径见 kb-core/src/share.rs、kb-capability/src/{sharing,links}.rs。
import type { DocRole, GrantList, GrantRole, GrantRow, LinkInfo, PublicProfile, SharedByMeItem, SharedWithMeItem, ShareTarget } from '@/api/share'

export type { DocRole, GrantRole }

// ---------------------------------------------------------------- 角色

/** 角色顺序即高低(后面的包含前面的全部能力);「所有者」只会由「是知识库的主人」推出来。 */
const ROLE_ORDER: DocRole[] = ['viewer', 'commenter', 'editor', 'manager', 'owner']

/** 界面上的角色名(术语表:可查看 / 可评论 / 可编辑 / 管理)。 */
export const ROLE_LABEL: Record<DocRole, string> = {
  viewer: '可查看',
  commenter: '可评论',
  editor: '可编辑',
  manager: '可管理',
  owner: '所有者',
}

export const roleLabel = (role: string | null | undefined): string => ROLE_LABEL[role as DocRole] ?? '无权限'
export const roleRank = (role: string | null | undefined): number => ROLE_ORDER.indexOf(role as DocRole)
export const isGrantRole = (value: string): value is GrantRole => ['viewer', 'commenter', 'editor', 'manager'].includes(value)

/**
 * 我最多能授予哪些角色:最多授予与自己相同的角色,所有者也只能授予到「可管理」(后端 check_role_ceiling)。
 * 没有「可管理」就一个都不能授予(返回空)。
 */
export function grantableRoles(mine: string | null | undefined): GrantRole[] {
  const rank = roleRank(mine)
  if (rank < roleRank('manager')) return []
  const ceiling = Math.min(rank, roleRank('manager'))
  return ROLE_ORDER.slice(0, ceiling + 1) as GrantRole[]
}

/** 链接只能给查看 / 评论 / 编辑(后端 link_role)。 */
export const LINK_ROLES: GrantRole[] = ['viewer', 'commenter', 'editor']

export const roleOptions = (roles: readonly string[]) => roles.map((role) => ({ value: role, label: roleLabel(role) }))

// ---------------------------------------------------------------- 资源(target)

/** 同一个资源的稳定标识:去重、比较、做 v-for 的 key 都用它。 */
export function targetKey(target: ShareTarget): string {
  return [target.kind, target.space_id ?? '', target.collection ?? '', target.path ?? target.id ?? ''].join('|')
}

export const sameTarget = (left: ShareTarget, right: ShareTarget) => targetKey(left) === targetKey(right)

/** 去重并保持先后顺序(多选时同一项被选两次只算一次)。 */
export function uniqueTargets(targets: ShareTarget[]): ShareTarget[] {
  const seen = new Set<string>()
  return targets.filter((target) => {
    const key = targetKey(target)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const KIND_LABEL: Record<ShareTarget['kind'], string> = {
  space: '知识库',
  collection: '集合',
  dir: '文件夹',
  file: '文件',
  insight: '笔记',
}
export const targetKindLabel = (target: ShareTarget): string => KIND_LABEL[target.kind] ?? '文档'

/** 文件夹、集合、整个知识库:分享它以后,里面新建的文档对方自动可见。 */
export const isFolderLike = (target: ShareTarget): boolean => target.kind === 'space' || target.kind === 'collection' || target.kind === 'dir'

/** 能「停止继承」的:文件夹和文档(集合 / 知识库没有上一级可以不继承)。 */
export const canStopInherit = (target: ShareTarget): boolean => target.kind === 'dir' || target.kind === 'file' || target.kind === 'insight'

/** 资源的显示名:调用方给了标题(笔记)就用它,否则取路径最后一段 / 集合名。 */
export function targetName(target: ShareTarget, title?: string | null): string {
  if (title?.trim()) return title.trim()
  if (target.kind === 'space') return '整个知识库'
  if (target.kind === 'collection') return target.collection ?? '集合'
  if (target.kind === 'insight') return target.id ?? '笔记'
  const path = target.path ?? ''
  return path.split('/').filter(Boolean).pop() ?? path
}

// ---------------------------------------------------------------- 资源键(只用来给「继承自…」起名)

/** 资源键里每一段是 `%XX` 编码的 UTF-8(kb-core share.rs);解不开就原样返回。 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * 「继承自 …」标签的文字。`source` 是授权所在的那一层的资源键:
 *   space:<sid> / col:<sid>/<集合> / dir:<sid>/<集合>/<段>… / doc:<sid>/<集合>/i/<id> / doc:<sid>/<集合>/f/<段>…
 * 只取最后一段当名字;认不出的键退回「上级」,不把键原样露给用户。
 */
export function sourceLabel(key: string): string {
  const colon = key.indexOf(':')
  if (colon < 0) return '上级'
  const kind = key.slice(0, colon)
  const parts = key.slice(colon + 1).split('/')
  if (kind === 'space') return '整个知识库'
  if (kind === 'col' && parts[1]) return `集合「${decodeSegment(parts[1])}」`
  if (kind === 'dir' && parts.length >= 3) return `文件夹「${decodeSegment(parts[parts.length - 1]!)}」`
  if (kind === 'doc' && parts.length >= 4) return `文档「${decodeSegment(parts[parts.length - 1]!)}」`
  return '上级'
}

// ---------------------------------------------------------------- 人

/** 显示名:好友备注 > 昵称 > 用户名。 */
export function personName(profile: Pick<PublicProfile, 'username' | 'display_name'>, remark?: string | null): string {
  return remark?.trim() || profile.display_name?.trim() || profile.username
}

/** 在好友里按输入过滤(用户名、昵称、备注,不分大小写),最多返回 `limit` 个。 */
export function filterFriends<T extends PublicProfile & { remark?: string | null }>(friends: T[], query: string, limit = 8): T[] {
  const needle = query.trim().toLowerCase()
  const matched = needle
    ? friends.filter((friend) => [friend.username, friend.display_name, friend.remark ?? ''].some((text) => text.toLowerCase().includes(needle)))
    : friends
  return matched.slice(0, limit)
}

// ---------------------------------------------------------------- 链接

export type LinkAudience = 'collaborators' | 'logged_in' | 'anyone'

export const AUDIENCE_LABEL: Record<LinkAudience, string> = {
  collaborators: '仅协作者',
  logged_in: '登录用户',
  anyone: '任何人(含游客)',
}

const AUDIENCE_HINT: Record<LinkAudience, string> = {
  collaborators: '链接只是个地址,没有额外权限,只有被添加的协作者能打开',
  logged_in: '登录后拿到链接的人都能打开',
  anyone: '拿到链接的人不用登录就能打开',
}

/** 范围对应的功能点:没开通的选项不能选(后端创建 / 修改时同样检查)。 */
const AUDIENCE_FEATURE: Partial<Record<LinkAudience, string>> = {
  logged_in: 'collab.link_users',
  anyone: 'collab.link_guest',
}

export interface AudienceOption {
  value: LinkAudience
  label: string
  hint: string
  /** 账号没有开通这种链接 */
  disabled: boolean
}

export function audienceOptions(has: (feature: string) => boolean): AudienceOption[] {
  return (['collaborators', 'logged_in', 'anyone'] as LinkAudience[]).map((value) => {
    const feature = AUDIENCE_FEATURE[value]
    const disabled = feature ? !has(feature) : false
    return { value, label: AUDIENCE_LABEL[value], hint: disabled ? '你的账号没有开通这种链接' : AUDIENCE_HINT[value], disabled }
  })
}

/** 链接此刻的状态(后端 LinkState)。 */
export type LinkStateName = 'active' | 'closed' | 'expired' | 'revoked'
export const LINK_STATE: Record<LinkStateName, { text: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }> = {
  active: { text: '生效中', tone: 'success' },
  closed: { text: '已关闭', tone: 'neutral' },
  expired: { text: '已过期', tone: 'warning' },
  revoked: { text: '已撤销', tone: 'danger' },
}
export const linkStateOf = (state: string) => LINK_STATE[state as LinkStateName] ?? LINK_STATE.closed

/** 有效期的选项。`keep` 只在链接已有到期日时出现:表示「不改」。 */
export type ExpiryChoice = 'forever' | '1' | '7' | '30' | 'custom' | 'keep'

export const EXPIRY_OPTIONS: { value: ExpiryChoice; label: string }[] = [
  { value: 'forever', label: '永久' },
  { value: '1', label: '1 天' },
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: 'custom', label: '自定义天数' },
]

export const EXPIRY_MAX_DAYS = 3650

/** 自定义天数的校验(1–3650 的整数)。返回错误说明,合法返回 null。 */
export function validateExpiryDays(text: string): string | null {
  const value = text.trim()
  if (!/^\d+$/.test(value)) return '请填一个整数天数,例如 14。'
  const days = Number(value)
  if (days < 1 || days > EXPIRY_MAX_DAYS) return `有效期需要在 1–${EXPIRY_MAX_DAYS} 天之间。`
  return null
}

/**
 * 把「选了什么」翻译成 link_update / link_create 的有效期参数。
 * 后端的 `expires_days` 是「从现在起几天」,所以不改(keep)时什么都不带——重新按天数提交会把到期日往后推。
 */
export function expiryPatch(choice: ExpiryChoice, customDays = ''): { expires_days?: number; clear_expiry?: boolean } {
  if (choice === 'keep') return {}
  if (choice === 'forever') return { clear_expiry: true }
  const days = choice === 'custom' ? Number(customDays.trim()) : Number(choice)
  return { expires_days: days }
}

/** 创建链接时的有效期(创建没有 clear_expiry:永久就是不带)。 */
export function expiryForCreate(choice: ExpiryChoice, customDays = ''): { expires_days?: number } {
  const patch = expiryPatch(choice, customDays)
  return patch.expires_days === undefined ? {} : { expires_days: patch.expires_days }
}

/** 月-日,跨年带年份(术语表:`10-19` / `2025-10-19`),按站点时区。 */
export function dateText(at: number, now = Date.now()): string {
  return monthDayText(at, now)
}

/** 链接有效期的一句话:永久 / 有效期至 11-30 / 已过期。 */
export function expiryText(expiresAt: number | null | undefined, now = Date.now()): string {
  if (!expiresAt) return '永久有效'
  if (expiresAt <= now) return '已过期'
  return `有效期至 ${dateText(expiresAt, now)}`
}

/** 相对时间(术语表):刚刚 / 5 分钟前 / 今天 14:20 / 昨天 / 周一 / 10-19 / 2025-10-19。 */
export function relativeTime(at: number | null | undefined, now = Date.now()): string {
  if (!at) return ''
  const diff = now - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  // “今天/昨天”与星期都按站点时区判断,不是访问者浏览器的本地日历
  const days = daysAgo(at, now)
  if (days === 0) return `今天 ${clockText(at)}`
  if (days === 1) return '昨天'
  if (days > 1 && days < 7) return `周${'日一二三四五六'[weekday(at)]}`
  return dateText(at, now)
}

/** 访问密码 4–12 位,不含控制字符(后端 check_password_shape,按字符数不是字节数)。 */
export function validateLinkPassword(password: string): string | null {
  const chars = Array.from(password)
  if (chars.length < 4 || chars.length > 12) return '访问密码需要 4–12 位。'
  // 后端同样拒绝控制字符(换行、制表符等),这里提前挡掉,省一次往返
  if (/[\u0000-\u001f\u007f]/.test(password)) return '访问密码不能含换行等控制字符。'
  return null
}

/** 链接地址里的令牌(最后一段)。 */
export function tokenFromUrl(url: string): string {
  const at = url.lastIndexOf('/s/')
  return at < 0 ? '' : url.slice(at + 3).split(/[?#]/)[0]!
}

/** 没有完整地址时给所有者看的提示:只露出后四位,像 `…/s/••••••••xxxx`。 */
export const maskedLink = (hint: string) => `/s/••••••••••••••••••${hint}`

/** 游客现在实际能拿到的角色比链接设的低(管理员关了游客评论 / 编辑),给所有者一句话。 */
export function guestCeilingNote(link: Pick<LinkInfo, 'audience' | 'role' | 'guest_role'>): string {
  if (link.audience !== 'anyone') return ''
  if (!link.guest_role) return '管理员暂时关闭了游客访问,游客现在打不开这个链接,登录用户不受影响。'
  if (roleRank(link.guest_role) < roleRank(link.role)) {
    return `管理员目前只允许游客「${roleLabel(link.guest_role)}」,所以游客只有这个权限,登录用户仍按链接设置的「${roleLabel(link.role)}」。`
  }
  return ''
}

// ---------------------------------------------------------------- 协作者列表(多选时合并各项)

export interface MergedGrant {
  user: PublicProfile
  /** 所有被查的项上角色一致时就是它;不一致 / 只在部分项上有 = 'mixed' */
  role: GrantRole | 'mixed'
  /** 在多少项上有(直接授权,不含继承) */
  count: number
}

/**
 * 多选分享时,把每一项的协作者合并成一份名单:
 * 所有项上角色一样 → 显示这个角色;角色不同、或只在其中几项上 → 「各项不同」（设计规范）。
 * 只看直接授权:继承来的在这一层改不了,而且多选时一项一项标「继承自」只会把名单淹没。
 */
export function mergeGrants(lists: GrantList[]): MergedGrant[] {
  const byUser = new Map<string, { user: PublicProfile; roles: GrantRole[] }>()
  for (const list of lists) {
    for (const row of list.grants) {
      if (row.inherited) continue
      const entry = byUser.get(row.user.id) ?? { user: row.user, roles: [] }
      entry.roles.push(row.role)
      byUser.set(row.user.id, entry)
    }
  }
  return [...byUser.values()]
    .map(({ user, roles }) => ({
      user,
      count: roles.length,
      role: (roles.length === lists.length && roles.every((role) => role === roles[0]) ? roles[0]! : 'mixed') as GrantRole | 'mixed',
    }))
    .sort((left, right) => left.user.username.localeCompare(right.user.username))
}

/** 单个资源的授权行:继承来的放后面,每组内按名字排。 */
export function sortGrantRows(rows: GrantRow[]): GrantRow[] {
  return [...rows].sort((left, right) => {
    if (left.inherited !== right.inherited) return left.inherited ? 1 : -1
    return personName(left.user).localeCompare(personName(right.user))
  })
}

/** 授权是「通过链接加入」的(来源 `link:<id>`),所有者能单独移除。 */
export const joinedViaLink = (row: Pick<GrantRow, 'via'>): boolean => row.via.startsWith('link:')

// ---------------------------------------------------------------- 报错文案

/** 后端把错误类别写在 message 前面(`forbidden: …` / `not found: …`),给人看的话不需要它。 */
export function stripErrorPrefix(message: string): string {
  return message.replace(/^(invalid input|forbidden|not found|already exists|unavailable|upstream|internal):\s*/i, '').trim()
}

const HAS_CJK = /[\u3400-\u9fff]/

interface HttpLike {
  status?: number
  code?: string
  message?: string
}

/**
 * 分享相关操作失败时给用户看的话(术语表:发生了什么 + 怎么办)。
 * 服务端的中文 message 本来就是写给人看的(「你最多只能授予「可编辑」」),去掉前缀后原样用;
 * 英文 / 空的退回按状态码写的话。
 */
export function shareErrorText(error: unknown, fallback = '操作没有成功,请稍后再试。'): string {
  const info = (error ?? {}) as HttpLike
  const raw = stripErrorPrefix(String(info.message ?? ''))
  if (raw && HAS_CJK.test(raw)) return raw
  switch (info.status) {
    case 400:
      return '填写的内容不对,请检查后再试。'
    case 403:
      return '你没有权限做这个操作,请联系所有者或可管理的人。'
    case 404:
      return '没有找到这个内容,它可能已被删除或移走。'
    case 409:
      return '内容刚被别人改过,请刷新后再试。'
    case 429:
      return '操作太频繁了,请稍等一会儿再试。'
    case 503:
      return '这个功能暂时不可用,请稍后再试。'
    default:
      return fallback
  }
}

/** 这个错误是不是「没有权限 / 不存在」(后端对没权限的资源回 404,权限不够回 403):面板据此显示无权限状态。 */
export function isNoAccess(error: unknown): boolean {
  const status = (error as HttpLike | null)?.status
  return status === 403 || status === 404
}

// ---------------------------------------------------------------- 共享给我 / 我的分享

export interface OwnerGroup {
  owner: PublicProfile
  items: SharedWithMeItem[]
}

/**
 * 「共享给我」按分享人分组（设计规范）:最近分享给我东西的人排在前面,同一个人的内容也是新的在前;
 * 被我移出列表的(hidden)默认不显示。
 * 不按名字排:中英文混排时各浏览器的 localeCompare 结果不一样(有的英文在前、有的按拼音交错),列表顺序会因设备而异;
 * 「最近」对人也更有用——刚收到的分享就在最上面。时间相同时才按名字定先后。
 */
export function groupByOwner(items: SharedWithMeItem[], showHidden = false): OwnerGroup[] {
  const groups = new Map<string, OwnerGroup>()
  for (const item of items) {
    if (item.hidden && !showHidden) continue
    const group = groups.get(item.owner.id) ?? { owner: item.owner, items: [] }
    group.items.push(item)
    groups.set(item.owner.id, group)
  }
  const byName = (left: string, right: string) => left.localeCompare(right, 'zh-CN')
  const newest = (group: OwnerGroup) => Math.max(...group.items.map((item) => item.shared_at))
  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort((left, right) => right.shared_at - left.shared_at || byName(left.title, right.title)),
    }))
    .sort((left, right) => newest(right) - newest(left) || byName(personName(left.owner), personName(right.owner)))
}

/** 我能不能编辑这份共享内容(可编辑及以上)。 */
export const canEditRole = (role: string | null | undefined): boolean => roleRank(role) >= roleRank('editor')
export const canCommentRole = (role: string | null | undefined): boolean => roleRank(role) >= roleRank('commenter')

/** 申请权限时能选的角色:只列比我现有角色更高的(没有权限时三档都可以)。后端只接受查看 / 评论 / 编辑。 */
export function requestableRoles(current: string | null | undefined): GrantRole[] {
  const rank = current ? roleRank(current) : -1
  return (['viewer', 'commenter', 'editor'] as GrantRole[]).filter((role) => roleRank(role) > rank)
}

/** 「我的分享」一行里的协作者摘要:「张三、李四 等 5 人」。 */
export function granteeSummary(item: Pick<SharedByMeItem, 'grantees'>, max = 2): string {
  const names = item.grantees.map((row) => personName(row.user))
  if (names.length <= max) return names.join('、')
  return `${names.slice(0, max).join('、')} 等 ${names.length} 人`
}

/** 所有选中项上出现过的协作者(去重):批量改角色 / 移除时让用户选「改谁」。 */
export function granteesOf(items: Pick<SharedByMeItem, 'grantees'>[]): PublicProfile[] {
  const seen = new Map<string, PublicProfile>()
  for (const item of items) for (const row of item.grantees) if (!seen.has(row.user.id)) seen.set(row.user.id, row.user)
  return [...seen.values()].sort((left, right) => personName(left).localeCompare(personName(right), 'zh-CN'))
}

// ---------------------------------------------------------------- 评论

/**
 * 评论作者的显示名。后端 `author` 的形状(kb-web share_public / e2e_links.rs):
 *   游客         `guest:小王#3fa9c1`(可能带「(经链接 xxxx)」后缀,那是给所有者审计用的)
 *   登录用户     用户 id `usr_…`(后端没有给显示名,界面认不出是谁)
 *   本机/工具    `web`、`mcp · Claude Code` 之类
 * 游客显示成「访客 小王」(编号是内部标识,不展示);用户 id 显示成「协作者」,是自己写的显示「我」。
 */
export function annotationAuthor(author: string | null | undefined, myId?: string | null): string {
  const value = (author ?? '').trim()
  if (!value) return '匿名'
  if (value.startsWith('guest:')) {
    const name = value.slice('guest:'.length).replace(/\(经链接[^)]*\)\s*$/, '').replace(/#[0-9a-f]+$/i, '').trim()
    return name.startsWith('访客') ? name : `访客 ${name || ''}`.trim()
  }
  if (myId && value === myId) return '我'
  if (/^usr_/.test(value)) return '协作者'
  return value
}
