import { describe, expect, it } from 'vitest'
import { AccountError } from '@/api/client'
import {
  anyCodeReady,
  codeReady,
  explainTotpError,
  groupSecret,
  looksLikeRecovery,
  normalizeCode,
  normalizeRecovery,
  recoveryFileName,
  recoveryFileText,
  recoveryLevel,
  totpResetSummary,
} from './totp'

describe('normalizeCode', () => {
  it('只留数字,最多 6 位', () => {
    expect(normalizeCode('481039')).toBe('481039')
    expect(normalizeCode('48 10 39')).toBe('481039')
    expect(normalizeCode('481-039')).toBe('481039')
    expect(normalizeCode('4810399999')).toBe('481039')
    expect(normalizeCode('abc12x')).toBe('12')
    expect(normalizeCode('')).toBe('')
  })

  it('中文输入法打出的全角数字也认', () => {
    expect(normalizeCode('４８１０３９')).toBe('481039')
  })

  it('粘贴带前后空白和换行的验证码', () => {
    expect(normalizeCode('  481039\n')).toBe('481039')
  })
})

describe('恢复码', () => {
  it('输入框内容:去空白、转大写、保留连字符,最多 14 个字符', () => {
    expect(normalizeRecovery(' abcd-efgh-jkmn ')).toBe('ABCD-EFGH-JKMN')
    expect(normalizeRecovery('abcd efgh jkmn')).toBe('ABCDEFGHJKMN')
    expect(normalizeRecovery('ABCD-EFGH-JKMN-EXTRA')).toBe('ABCD-EFGH-JKMN')
  })

  it('形状:12 个合法字符,连字符和大小写不影响', () => {
    expect(looksLikeRecovery('ABCD-EFGH-JKMN')).toBe(true)
    expect(looksLikeRecovery('abcd efgh jkmn')).toBe(true)
    expect(looksLikeRecovery('ABCDEFGHJKMN')).toBe(true)
    expect(looksLikeRecovery('ABCD-EFGH-JKM')).toBe(false)
    // 字母表里没有 0 / O / 1 / I / L:抄错这些字符的恢复码不可能是真的
    expect(looksLikeRecovery('ABCD-EFGH-JK0N')).toBe(false)
    expect(looksLikeRecovery('ABCD-EFGH-JKLN')).toBe(false)
    expect(looksLikeRecovery('481039')).toBe(false)
  })

  it('codeReady:验证码要 6 位,恢复码要 12 个合法字符', () => {
    expect(codeReady('48103', 'code')).toBe(false)
    expect(codeReady('481039', 'code')).toBe(true)
    expect(codeReady('481039', 'recovery')).toBe(false)
    expect(codeReady('ABCD-EFGH-JKMN', 'recovery')).toBe(true)
  })

  it('anyCodeReady:关闭 / 重新生成时 6 位码或恢复码都行', () => {
    expect(anyCodeReady('481039')).toBe(true)
    expect(anyCodeReady('481 039')).toBe(true)
    expect(anyCodeReady('ABCD-EFGH-JKMN')).toBe(true)
    expect(anyCodeReady('48103')).toBe(false)
    expect(anyCodeReady('')).toBe(false)
  })

  it('剩余数量的提醒级别', () => {
    expect(recoveryLevel(8)).toBe('ok')
    expect(recoveryLevel(3)).toBe('ok')
    expect(recoveryLevel(2)).toBe('low')
    expect(recoveryLevel(1)).toBe('low')
    expect(recoveryLevel(0)).toBe('none')
  })
})

describe('groupSecret', () => {
  it('四个一组,方便手输', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP')
    expect(groupSecret('JBSWY3DPEH')).toBe('JBSW Y3DP EH')
    expect(groupSecret('')).toBe('')
  })
})

describe('恢复码文件', () => {
  const codes = Array.from({ length: 8 }, (_, i) => `ABCD-EFGH-JK${i + 2}N`)

  it('文件名只留安全字符', () => {
    expect(recoveryFileName('alice')).toBe('recovery-codes-alice.txt')
    expect(recoveryFileName('../../etc/passwd')).toBe('recovery-codes-etcpasswd.txt')
    expect(recoveryFileName('')).toBe('recovery-codes.txt')
    expect(recoveryFileName('用户')).toBe('recovery-codes.txt')
  })

  it('内容含站点、账号、日期、用法,以及编号的全部恢复码', () => {
    const text = recoveryFileText(codes, { site: '知识库', account: 'alice', day: '2026-10-28' })
    expect(text).toContain('知识库 两步验证恢复码')
    expect(text).toContain('账号:alice')
    expect(text).toContain('生成日期:2026-10-28')
    expect(text).toContain('每个恢复码只能用一次')
    codes.forEach((code, i) => expect(text).toContain(`${String(i + 1).padStart(2, '0')}. ${code}`))
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('explainTotpError', () => {
  const err = (status: number, code: string, message = '后端的话') => new AccountError(message, status, 0, code)

  it('同样是 401,靠 code 区分:验证码不对 / 密码不对 / 挑战过期 / 会话过期', () => {
    expect(explainTotpError(err(401, 'bad_code'), 'login-code').kind).toBe('bad_code')
    expect(explainTotpError(err(401, 'bad_password'), 'setup').kind).toBe('bad_password')
    expect(explainTotpError(err(401, 'challenge_expired'), 'login-code').kind).toBe('challenge_expired')
    expect(explainTotpError(err(401, 'unauthorized'), 'setup').kind).toBe('session')
  })

  it('验证码不对:登录、恢复码、首次确认各有各的建议', () => {
    expect(explainTotpError(err(401, 'bad_code'), 'login-code').message).toContain('验证码不对')
    expect(explainTotpError(err(401, 'bad_code'), 'login-recovery').message).toContain('恢复码不对')
    expect(explainTotpError(err(401, 'bad_code'), 'confirm').message).toContain('手机时间')
  })

  it('429 只说等 15 分钟,不建议换恢复码(后端对恢复码也限速)', () => {
    const view = explainTotpError(err(429, 'rate_limited', '验证码输错次数过多,请 15 分钟后再试'), 'login-code')
    expect(view.kind).toBe('rate_limited')
    expect(view.message).toContain('15 分钟')
    expect(view.message).not.toContain('恢复码')
  })

  it('挑战过期要引导回到密码那一步', () => {
    expect(explainTotpError(err(401, 'challenge_expired'), 'login-code').message).toContain('重新输入密码')
  })

  it('站点强制:关闭时说明原因', () => {
    const view = explainTotpError(err(403, 'totp_required'), 'disable')
    expect(view.kind).toBe('required')
    expect(view.message).toContain('必须开启')
  })

  it('409:已经开启', () => {
    expect(explainTotpError(err(409, 'conflict'), 'setup').kind).toBe('conflict')
  })

  it('网络错误不把英文异常给用户', () => {
    const view = explainTotpError(new TypeError('Failed to fetch'), 'login-code')
    expect(view.kind).toBe('offline')
    expect(view.message).not.toMatch(/fetch/i)
  })

  it('其它错误带上后端的话,并补一句怎么办', () => {
    const view = explainTotpError(err(500, 'internal', '数据库忙。'), 'disable')
    expect(view.kind).toBe('other')
    expect(view.message).toBe('数据库忙。请稍后再试。')
  })
})

describe('totpResetSummary', () => {
  it('原来开着:说明已关掉、设备退出数、之后怎么办', () => {
    const text = totpResetSummary({ was_enabled: true, sessions_revoked: 3 })
    expect(text).toContain('已关掉他的两步验证')
    expect(text).toContain('3 台设备')
    expect(text).toContain('重新开启')
  })

  it('原来就没开:如实说,不假装关掉了什么', () => {
    const text = totpResetSummary({ was_enabled: false, sessions_revoked: 1 })
    expect(text).toContain('本来就没有开启')
    expect(text).not.toContain('已关掉')
  })

  it('没有登录着的设备', () => {
    expect(totpResetSummary({ was_enabled: true, sessions_revoked: 0 })).toContain('没有登录着的设备')
  })
})
