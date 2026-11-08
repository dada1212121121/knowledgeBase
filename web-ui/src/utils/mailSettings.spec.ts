import { describe, expect, it } from 'vitest'
import type { MailAccountView, MailPreset } from './adminApi'
import {
  accountPatch,
  applyPreset,
  formFromAccount,
  logResult,
  mailKindLabel,
  passwordPlaceholder,
} from './mailSettings'

const PRESETS: MailPreset[] = [
  { id: 'qq', name: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, security: 'tls' },
  { id: '163', name: '163 邮箱', host: 'smtp.163.com', port: 465, security: 'tls' },
]

const ACCOUNT: MailAccountView = {
  preset: 'custom',
  host: '',
  port: 465,
  security: 'tls',
  username: '',
  configured: false,
  password_set: false,
}

describe('mail settings form', () => {
  it('选预设会套用服务器、端口、加密方式,但保留已填的登录名', () => {
    const form = { ...formFromAccount(ACCOUNT), username: 'noreply@qq.com' }
    const next = applyPreset(form, 'qq', PRESETS)
    expect(next).toMatchObject({ preset: 'qq', host: 'smtp.qq.com', port: '465', security: 'tls', username: 'noreply@qq.com' })
  })

  it('选「自定义」或未知预设不改任何已填的值', () => {
    const form = { preset: 'qq', host: 'smtp.qq.com', port: '587', security: 'starttls', username: 'a@b.cn' }
    expect(applyPreset(form, 'custom', PRESETS)).toEqual({ ...form, preset: 'custom' })
    expect(applyPreset(form, 'nope', PRESETS)).toEqual({ ...form, preset: 'custom' })
  })

  it('合法的表单生成补丁,端口转成数字,空白被裁掉', () => {
    const result = accountPatch({ preset: 'qq', host: ' smtp.qq.com ', port: '465', security: 'tls', username: ' a@qq.com ' })
    expect(result).toEqual({ patch: { preset: 'qq', host: 'smtp.qq.com', port: 465, security: 'tls', username: 'a@qq.com' } })
  })

  it('整个账号留空表示不用这个账号(备用账号可以不配)', () => {
    const result = accountPatch({ preset: 'custom', host: '', port: '465', security: 'tls', username: '' })
    expect(result).toEqual({ patch: { preset: 'custom', host: '', username: '', port: 465, security: 'tls' } })
  })

  it('不合法的输入给出具体的错误,而不是发给后端', () => {
    const base = { preset: 'custom', host: 'smtp.example.com', port: '465', security: 'tls', username: 'a@example.com' }
    const error = (patch: Partial<typeof base>) => (accountPatch({ ...base, ...patch }) as { error: string }).error
    expect(error({ host: '', username: 'a@example.com' })).toBe('请填写 SMTP 服务器')
    expect(error({ host: 'smtp example.com' })).toContain('SMTP 服务器')
    expect(error({ host: 'a.com; rm -rf' })).toContain('SMTP 服务器')
    expect(error({ port: '0' })).toContain('端口')
    expect(error({ port: '70000' })).toContain('端口')
    expect(error({ port: '46.5' })).toContain('端口')
    expect(error({ port: 'abc' })).toContain('端口')
    expect(error({ username: 'not-an-email' })).toContain('邮箱地址')
    expect(error({ security: 'ssl3' })).toContain('加密方式')
  })

  it('授权码占位提示随是否已设置变化,并明确不是登录密码', () => {
    expect(passwordPlaceholder(true)).toContain('已设置')
    expect(passwordPlaceholder(false)).toContain('不是登录密码')
  })

  it('发信记录:成功显示用了哪个账号,失败显示原因并截断过长的文字', () => {
    expect(logResult({ ok: true, via: 'backup', error: null })).toEqual({ text: '已发送 · 备用账号', full: '', tone: 'success' })
    expect(logResult({ ok: false, via: null, error: null }).text).toBe('未知原因')
    const long = 'x'.repeat(100)
    const result = logResult({ ok: false, via: 'primary', error: long })
    expect(result.text).toHaveLength(61)
    expect(result.full).toBe(long)
    expect(result.tone).toBe('danger')
    expect(mailKindLabel('register_code')).toBe('注册验证码')
    expect(mailKindLabel('whatever')).toBe('whatever')
  })
})
