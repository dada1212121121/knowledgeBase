// 个人设置页里表单的校验(页面见 pages/Me.vue)。规则与后端对齐,让用户在提交前就看到原因;后端才是权威。
import { checkPassword } from './passwordStrength'

/** 昵称最长字数,与后端 `profile::MAX_DISPLAY_NAME` 一致。 */
export const MAX_DISPLAY_NAME = 30

/** 与后端 `profile::is_invisible_format` 同一批:方向覆盖、零宽字符等不可见却会改变显示的字符。 */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u

/** 昵称校验,返回错误文案;合格返回 `null`。 */
export function checkDisplayName(raw: string): string | null {
  const name = raw.trim()
  const length = Array.from(name).length
  if (length === 0) return '昵称不能为空'
  if (length > MAX_DISPLAY_NAME) return `昵称最多 ${MAX_DISPLAY_NAME} 个字`
  // 不可见字符要对**原始输入**判断:JavaScript 的 trim 会把 BOM(U+FEFF)当空白吞掉,
  // 而后端(Rust 的 trim)不会——对 trim 之后的值判断,前端放行的名字后端可能拒绝
  if (/[\u0000-\u001F\u007F-\u009F<>]/u.test(name) || INVISIBLE.test(raw)) return '昵称不能包含换行、不可见字符或 < > 符号'
  return null
}

export interface PasswordForm {
  current: string
  next: string
  confirm: string
}

/** 改密码表单:返回第一个问题;都没问题返回 `null`。 */
export function checkPasswordChange(form: PasswordForm, username: string): string | null {
  if (form.current === '') return '请输入当前密码'
  const strength = checkPassword(form.next, username.toLowerCase())
  if (form.next === '') return '请输入新密码'
  if (!strength.ok) return strength.message
  if (form.next === form.current) return '新密码不能和当前密码一样'
  if (form.confirm !== form.next) return '两次输入的新密码不一致'
  return null
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** 注销冷静期还剩多久:`还剩 6 天 3 小时` / `还剩 5 小时` / `不到 1 小时`;已到期是 `即将被删除`。 */
export function deletionCountdown(deleteAfter: number, now = Date.now()): string {
  const left = deleteAfter - now
  if (left <= 0) return '即将被删除'
  if (left < HOUR) return '不到 1 小时'
  const days = Math.floor(left / DAY)
  const hours = Math.floor((left % DAY) / HOUR)
  if (days === 0) return `还剩 ${hours} 小时`
  return hours === 0 ? `还剩 ${days} 天` : `还剩 ${days} 天 ${hours} 小时`
}

/** 还能不能撤销。与后端严格一致:`delete_after` 那一刻起不能再撤销。 */
export function canCancelDeletion(deleteAfter: number, now = Date.now()): boolean {
  return now < deleteAfter
}

/** 字节数的人话:`1.5 MB`。用 1024 进制,和磁盘上看到的一致。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  // 三位有效数字以内:小于 10 留一位小数,否则取整
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** 导出进度百分比,0–100 的整数。总量为 0(没有文件)时按已完成算。 */
export function exportPercent(done: number, total: number): number {
  if (total <= 0) return 100
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)))
}

/** 导出文件还能保留多久:`23 小时` / `45 分钟`;已过期是 `已过期`。 */
export function expiresIn(expiresAt: number, now = Date.now()): string {
  const left = expiresAt - now
  if (left <= 0) return '已过期'
  const hours = Math.floor(left / 3_600_000)
  if (hours >= 1) return `${hours} 小时`
  return `${Math.max(1, Math.ceil(left / 60_000))} 分钟`
}
