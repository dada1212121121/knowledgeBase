// 邮件设置的表单逻辑(页面见 components/MailSettings.vue,后端见 kb-cli/src/admin_registration.rs)。
//
// 授权码只写不读:表单里的授权码输入框永远是空的,后端只告诉「有没有设置」。
// 这里的函数都是纯函数,便于单测:预设怎么套用、账号表单怎么变成配置补丁、发信记录怎么显示。
import type { MailAccountView, MailLogRow, MailPreset, MailSlot } from './adminApi'

export interface AccountForm {
  preset: string
  host: string
  /** 输入框里是字符串,提交前才转数字。 */
  port: string
  security: string
  username: string
}

export const CUSTOM_PRESET = 'custom'

export function formFromAccount(account: MailAccountView): AccountForm {
  return {
    preset: account.preset || CUSTOM_PRESET,
    host: account.host,
    port: String(account.port),
    security: account.security,
    username: account.username,
  }
}

/** 选了预设就套用它的服务器 / 端口 / 加密方式,保留已经填好的登录名;「自定义」不改任何值。 */
export function applyPreset(form: AccountForm, presetId: string, presets: MailPreset[]): AccountForm {
  const preset = presets.find((item) => item.id === presetId)
  if (!preset) return { ...form, preset: CUSTOM_PRESET }
  return { ...form, preset: preset.id, host: preset.host, port: String(preset.port), security: preset.security }
}

/** 表单 → `update_config` 的补丁。不合法返回错误文案。 */
export function accountPatch(form: AccountForm): { patch: Record<string, unknown> } | { error: string } {
  const host = form.host.trim()
  const username = form.username.trim()
  const port = Number(form.port)
  // 整个账号留空 = 不使用这个账号(备用账号可以不配)
  if (host === '' && username === '') {
    return { patch: { preset: CUSTOM_PRESET, host: '', username: '', port: 465, security: 'tls' } }
  }
  if (host === '') return { error: '请填写 SMTP 服务器' }
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return { error: 'SMTP 服务器只能包含字母、数字、点和横线' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: '端口需要是 1–65535 的整数' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) return { error: '登录名需要是完整的邮箱地址' }
  if (!['tls', 'starttls', 'none'].includes(form.security)) return { error: '加密方式不正确' }
  return { patch: { preset: form.preset, host, port, security: form.security, username } }
}

/** 授权码输入框的占位提示。 */
export function passwordPlaceholder(passwordSet: boolean): string {
  return passwordSet ? '已设置,留空表示不修改' : '邮箱网页版里生成的「授权码」,不是登录密码'
}

const KIND_LABELS: Record<string, string> = {
  register_code: '注册验证码',
  reset_code: '找回密码验证码',
  already_registered: '重复注册提醒',
  test: '测试邮件',
}

export function mailKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

export function slotLabel(slot: MailSlot | null): string {
  if (slot === 'primary') return '主账号'
  if (slot === 'backup') return '备用账号'
  return '—'
}

/** 发信记录一行的结果:成功显示用了哪个账号,失败显示原因(过长截断,完整原因放 title)。 */
export function logResult(row: Pick<MailLogRow, 'ok' | 'via' | 'error'>): { text: string; full: string; tone: 'success' | 'danger' } {
  if (row.ok) return { text: `已发送 · ${slotLabel(row.via)}`, full: '', tone: 'success' }
  const full = row.error ?? '未知原因'
  return { text: full.length > 60 ? `${full.slice(0, 60)}…` : full, full, tone: 'danger' }
}
