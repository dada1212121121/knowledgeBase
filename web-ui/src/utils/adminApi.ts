// 账号与角色管理接口的类型和调用(后端见 kb-capability/src/admin.rs)。
import { callCapability } from '@/api/client'

export interface FeatureDef {
  id: string
  group: string
  label: string
  hint: string
  default_user: boolean
  dangerous: boolean
  ai: boolean
}

export interface RoleRow {
  id: string
  name: string
  description: string
  builtin: boolean
  all_features: boolean
  dangerous: boolean
  quota_json: string
  features: string[]
  user_count: number
}

export interface UserRow {
  id: string
  username: string
  email: string | null
  display_name: string
  /** 头像文件名;没有头像是 null。 */
  avatar?: string | null
  role_id: string
  status: 'active' | 'pending_email' | 'disabled' | 'deleting'
  registered_via: string
  created_at: number
  last_login_at: number | null
  /** 这个用户自己的配额覆盖(JSON 对象原文);没有覆盖是 `{}` 或空 */
  quota_json?: string
}

export interface UserDetail {
  user: UserRow
  space: { id: string; storage_bytes: number } | null
  overrides: { feature: string; effect: 'allow' | 'deny' }[]
  effective_features: string[]
}

export const featureCatalog = () => callCapability<{ features: FeatureDef[] }>('feature_catalog', {})
export const roleList = () => callCapability<{ roles: RoleRow[] }>('role_list', {})
export const roleCreate = (args: { name: string; description?: string; features: string[]; dangerous?: boolean }) =>
  callCapability<{ role: RoleRow }>('role_create', args)
export const roleUpdate = (args: {
  id: string
  name?: string
  description?: string
  features?: string[]
  dangerous?: boolean
  quota?: Record<string, number>
}) => callCapability<{ role: RoleRow }>('role_update', args)
export const roleDelete = (id: string) => callCapability('role_delete', { id })

export const userList = (args: { q?: string; role_id?: string; status?: string; page?: number; page_size?: number }) =>
  callCapability<{ users: UserRow[]; total: number; page: number; page_size: number }>('user_list', args)
export const userGet = (id: string) => callCapability<UserDetail>('user_get', { id })
export const userCreate = (args: {
  username: string
  password: string
  email?: string
  display_name?: string
  role_id?: string
  must_change_password?: boolean
}) => callCapability<{ user: UserRow }>('user_create', args)
export const userUpdate = (args: {
  id: string
  role_id?: string
  status?: 'active' | 'disabled'
  display_name?: string
  quota?: Record<string, number>
}) => callCapability<{ user: UserRow }>('user_update', args)
export const userSetPassword = (id: string, password: string, mustChange = false) =>
  callCapability('user_set_password', { id, password, must_change_password: mustChange })
export const userFeature = (id: string, feature: string, effect: 'allow' | 'deny' | null) =>
  callCapability<UserDetail>('user_feature', { id, feature, effect })

/**
 * 替用户关掉两步验证(他丢了手机和恢复码)。后端**无论他开没开**都会让他所有设备上的登录失效,
 * 所以界面的确认话术不能只说「关掉两步验证」。参数名是 `user_id`(不是别的用户能力用的 `id`)。
 */
export const userTotpReset = (userId: string) =>
  callCapability<{ id: string; was_enabled: boolean; sessions_revoked: number }>('user_totp_reset', { user_id: userId })

/** 功能点按分组归类,保持目录里的顺序。 */
export function groupFeatures(list: FeatureDef[]): { group: string; items: FeatureDef[] }[] {
  const groups: { group: string; items: FeatureDef[] }[] = []
  for (const item of list) {
    let bucket = groups.find((entry) => entry.group === item.group)
    if (!bucket) {
      bucket = { group: item.group, items: [] }
      groups.push(bucket)
    }
    bucket.items.push(item)
  }
  return groups
}

// ---------------------------------------------------------------- 邀请码

export type InviteState = 'active' | 'used_up' | 'expired' | 'revoked'

export interface InviteRow {
  id: string
  /** 形如 `KB-7H2K`,管理员认人用;明文只在创建时出现一次。 */
  prefix: string
  note: string
  max_uses: number
  used: number
  expires_at: number | null
  role_id: string | null
  quota_json: string
  revoked_at: number | null
  created_at: number
}

export type InviteCreateArgs = {
  note?: string
  max_uses?: number
  expires_days?: number
  role_id?: string
  quota?: Record<string, number>
  count?: number
}

export const inviteCreate = (args: InviteCreateArgs) =>
  callCapability<{ invites: { invite: InviteRow; code: string }[] }>('invite_create', args)
export const inviteList = () =>
  callCapability<{ invites: { invite: InviteRow; state: InviteState }[]; now: number }>('invite_list', {})
export const inviteRevoke = (id: string) => callCapability('invite_revoke', { id })
export const inviteUses = (id: string) =>
  callCapability<{ uses: { user_id: string; username: string | null; ip: string | null; at: number }[] }>(
    'invite_uses',
    { id },
  )

// ---------------------------------------------------------------- 邮件设置

export type MailSlot = 'primary' | 'backup'

export interface MailAccountView {
  preset: string
  host: string
  port: number
  security: 'tls' | 'starttls' | 'none'
  username: string
  configured: boolean
  /** 授权码是否已设置;授权码本身任何接口都不返回。 */
  password_set: boolean
}

export interface MailPreset {
  id: string
  name: string
  host: string
  port: number
  security: string
}

export interface MailStatus {
  enabled: boolean
  ready: boolean
  from_name: string
  per_minute: number
  primary: MailAccountView
  backup: MailAccountView
  presets: MailPreset[]
  sent_last_hour: number
}

export interface MailLogRow {
  id: number
  at: number
  to_addr: string
  kind: string
  ok: boolean
  via: 'primary' | 'backup' | null
  error: string | null
}

export const mailStatus = () => callCapability<MailStatus>('mail_status', {})
export const mailPassword = (slot: MailSlot, password: string) =>
  // 管理级能力:请求体必须显式带 confirm
  callCapability<{ slot: MailSlot; password_set: boolean }>('mail_password', { slot, password, confirm: true })
export const mailTest = (slot: MailSlot, to?: string) =>
  callCapability<{ ok: boolean; slot: MailSlot; to: string; error: string | null }>('mail_test', { slot, to })
export const mailLog = (limit = 50) => callCapability<{ log: MailLogRow[] }>('mail_log', { limit })
