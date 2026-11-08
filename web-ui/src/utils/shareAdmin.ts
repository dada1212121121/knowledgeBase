// 分享治理(管理组)的纯逻辑:标签、筛选、能不能撤销。数据形状见 api/usage.ts 的 AdminLink。
import type { AdminLink, AdminLinkPerson } from '@/api/usage'
import { AUDIENCE_LABEL, linkStateOf, roleLabel, type LinkAudience } from '@/utils/share'

const KIND_LABEL: Record<string, string> = {
  insight: '笔记',
  file: '文件',
  dir: '文件夹',
  collection: '集合',
  space: '整个知识库',
  bundle: '多项合集',
}
export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? '其它'

/** 账号被删除时后端给 null。 */
export const personText = (person: AdminLinkPerson | null): string => (person ? person.display_name?.trim() || person.username : '已删除的账号')

export const audienceText = (audience: string): string => AUDIENCE_LABEL[audience as LinkAudience] ?? audience
export const roleText = (role: string): string => roleLabel(role)
export const stateText = (state: string): { text: string; tone: 'success' | 'neutral' | 'warning' | 'danger' } => linkStateOf(state)

/** 已撤销的不能再撤销;其余状态(含过期、被所有者关掉的)都可以彻底撤销。 */
export const canRevoke = (link: Pick<AdminLink, 'state'>): boolean => link.state !== 'revoked'

export type StateFilter = 'all' | 'active' | 'risky' | 'ended'

export const STATE_FILTERS: { value: StateFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '有效' },
  { value: 'risky', label: '有风险' },
  { value: 'ended', label: '已失效' },
]

/** 有风险 = 还有效,而且不登录的人也能打开、没有密码。管理员最该看的就是这些。 */
export const isRisky = (link: AdminLink): boolean => link.state === 'active' && link.audience === 'anyone' && !link.has_password

export interface LinkFilter {
  query: string
  state: StateFilter
}

/** 按所有者 / 创建者的用户名或昵称、链接尾号查找,再按状态筛。只在已经加载的这一页里找。 */
export function filterLinks(links: AdminLink[], filter: LinkFilter): AdminLink[] {
  const needle = filter.query.trim().toLowerCase()
  return links.filter((link) => {
    if (filter.state === 'active' && link.state !== 'active') return false
    if (filter.state === 'risky' && !isRisky(link)) return false
    if (filter.state === 'ended' && link.state === 'active') return false
    if (!needle) return true
    const hay = [link.owner?.username, link.owner?.display_name, link.creator?.username, link.creator?.display_name, link.hint]
    return hay.some((text) => (text ?? '').toLowerCase().includes(needle))
  })
}

export function linkCounts(links: AdminLink[]): { active: number; risky: number; passworded: number } {
  return {
    active: links.filter((link) => link.state === 'active').length,
    risky: links.filter(isRisky).length,
    passworded: links.filter((link) => link.has_password && link.state === 'active').length,
  }
}
