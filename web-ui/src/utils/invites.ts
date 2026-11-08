// 邀请码管理的纯逻辑(页面见 components/InviteManager.vue,后端见 kb-cli/src/admin_registration.rs)。
import type { InviteCreateArgs, InviteRow, InviteState } from './adminApi'

export const EXPIRY_OPTIONS = [
  { value: 0, label: '不过期' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
]

export const STATE_LABELS: Record<InviteState, string> = {
  active: '可用',
  used_up: '已用完',
  expired: '已过期',
  revoked: '已撤销',
}

export function stateTone(state: InviteState): 'success' | 'neutral' | 'warning' | 'danger' {
  return state === 'active' ? 'success' : state === 'revoked' ? 'danger' : state === 'expired' ? 'warning' : 'neutral'
}

/** 「已用 / 总共」:单次码显示「未使用 / 已使用」更直白。 */
export function usageText(invite: Pick<InviteRow, 'used' | 'max_uses'>): string {
  if (invite.max_uses === 1) return invite.used >= 1 ? '已使用' : '未使用'
  return `${invite.used} / ${invite.max_uses} 次`
}

/** 有效期文案:不过期 / N 天后过期 / 已过期。 */
export function expiryText(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return '不过期'
  const left = expiresAt - now
  if (left <= 0) return '已过期'
  const days = Math.ceil(left / 86_400_000)
  return days <= 1 ? '1 天内过期' : `${days} 天后过期`
}

export interface InviteForm {
  note: string
  max_uses: string
  expires_days: number
  role_id: string
  /** 存储配额覆盖(GB);空 = 沿用角色 / 系统默认。 */
  storage_gb: string
  count: string
}

export function emptyInviteForm(): InviteForm {
  return { note: '', max_uses: '1', expires_days: 0, role_id: '', storage_gb: '', count: '1' }
}

function wholeNumber(text: string): number | null {
  const trimmed = text.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null
}

/** 表单 → `invite_create` 的参数;不合法返回错误文案(和后端的范围校验一致,让用户少碰一次 400)。 */
export function inviteArgs(form: InviteForm): { args: InviteCreateArgs } | { error: string } {
  const maxUses = wholeNumber(form.max_uses)
  if (maxUses === null || maxUses < 1 || maxUses > 10_000) return { error: '可用次数需要是 1–10000 的整数' }
  const count = wholeNumber(form.count)
  if (count === null || count < 1 || count > 100) return { error: '一次生成 1–100 个' }
  const args: InviteCreateArgs = { max_uses: maxUses, count }
  const note = form.note.trim()
  if (note) args.note = note
  if (form.expires_days > 0) args.expires_days = form.expires_days
  if (form.role_id) args.role_id = form.role_id
  if (form.storage_gb.trim() !== '') {
    const gb = wholeNumber(form.storage_gb)
    if (gb === null || gb < 1) return { error: '存储配额需要是不小于 1 的整数(GB)' }
    args.quota = { storage_gb: gb }
  }
  return { args }
}

/** 把刚生成的邀请码拼成可以一次复制的文本:一行一个。 */
export function codesText(codes: string[]): string {
  return codes.join('\n')
}

// 邀请码字母表:去掉容易看混的 0 O 1 I L(与后端 `kb_core::account` 一致)
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/**
 * 把用户输入规范成 `KB-XXXX-XXXX`;还不是完整的邀请码返回 `null`。
 *
 * 规则逐条对应后端 `normalize_invite_code`:忽略大小写、空格和横线,可省略 `KB` 前缀,
 * 剩下必须恰好 8 位且都在字母表里。注册页只在这里返回非空时才向服务端核对,
 * 否则用户还没输完的半截码会被服务端记成一次失败尝试(失败 5 次会被临时限速)。
 */
export function normalizeInviteCode(input: string): string | null {
  const letters = input.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const body = letters.startsWith('KB') ? letters.slice(2) : letters
  if (body.length !== 8 || ![...body].every((ch) => INVITE_ALPHABET.includes(ch))) return null
  return `KB-${body.slice(0, 4)}-${body.slice(4)}`
}
