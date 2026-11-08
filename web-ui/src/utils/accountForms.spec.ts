import { describe, expect, it } from 'vitest'
import { MAX_DISPLAY_NAME, canCancelDeletion, checkDisplayName, checkPasswordChange, deletionCountdown, exportPercent, expiresIn, formatBytes } from './accountForms'

describe('checkDisplayName', () => {
  it('正常的名字通过,首尾空白不算', () => {
    for (const ok of ['林一', '  Alice  ', 'Émile', '山田太郎', 'Ana 🌸', "O'Brien", 'a'.repeat(MAX_DISPLAY_NAME)]) {
      expect(checkDisplayName(ok), ok).toBeNull()
    }
  })

  it('空、全空白、超长(按字符数,不是字节)被拒', () => {
    expect(checkDisplayName('')).toBe('昵称不能为空')
    expect(checkDisplayName('   ')).toBe('昵称不能为空')
    expect(checkDisplayName('字'.repeat(MAX_DISPLAY_NAME + 1))).toContain('最多 30')
    // 30 个 emoji 是 30 个字,不是 60 个
    expect(checkDisplayName('🌸'.repeat(MAX_DISPLAY_NAME))).toBeNull()
    expect(checkDisplayName('🌸'.repeat(MAX_DISPLAY_NAME + 1))).toContain('最多 30')
  })

  it('换行、控制字符、尖括号、可用来冒充的不可见字符被拒(与后端同一批)', () => {
    for (const bad of ['a\nb', 'a\tb', 'x\u0000y', '<b>x</b>', 'a>b', '\u202enimda', 'ad\u200bmin', '\ufeffadmin', 'a\u2066b', 'a\u00adb']) {
      expect(checkDisplayName(bad), JSON.stringify(bad)).toContain('不能包含')
    }
  })
})

describe('checkPasswordChange', () => {
  const good = { current: 'old password 1', next: 'Correct-Horse-9', confirm: 'Correct-Horse-9' }

  it('全部合格返回 null', () => {
    expect(checkPasswordChange(good, 'alice')).toBeNull()
  })

  it('按顺序给出第一个问题', () => {
    expect(checkPasswordChange({ ...good, current: '' }, 'alice')).toBe('请输入当前密码')
    expect(checkPasswordChange({ ...good, next: '', confirm: '' }, 'alice')).toBe('请输入新密码')
    expect(checkPasswordChange({ ...good, next: 'short', confirm: 'short' }, 'alice')).toBe('密码至少 8 位')
    expect(checkPasswordChange({ ...good, next: '12345678', confirm: '12345678' }, 'alice')).toContain('太常见')
    expect(checkPasswordChange({ ...good, next: 'Alice_Alice', confirm: 'Alice_Alice' }, 'alice_alice')).toContain('用户名相同')
    expect(checkPasswordChange({ ...good, current: good.next }, 'alice')).toBe('新密码不能和当前密码一样')
    expect(checkPasswordChange({ ...good, confirm: 'Correct-Horse-8' }, 'alice')).toBe('两次输入的新密码不一致')
  })

  it('用户名大小写不影响「密码不能和用户名相同」', () => {
    expect(checkPasswordChange({ current: 'x', next: 'LinYi_2024', confirm: 'LinYi_2024' }, 'LinYi_2024')).toContain('用户名相同')
  })
})

describe('account deletion countdown', () => {
  const H = 3_600_000
  const D = 24 * H
  const now = 1_800_000_000_000

  it('按剩余时间给出天 / 小时 / 不到一小时', () => {
    expect(deletionCountdown(now + 6 * D + 3 * H + 10, now)).toBe('还剩 6 天 3 小时')
    expect(deletionCountdown(now + 7 * D, now)).toBe('还剩 7 天')
    expect(deletionCountdown(now + 5 * H + 59 * 60_000, now)).toBe('还剩 5 小时')
    expect(deletionCountdown(now + 1 * H, now)).toBe('还剩 1 小时')
    expect(deletionCountdown(now + H - 1, now)).toBe('不到 1 小时')
    expect(deletionCountdown(now + 1, now)).toBe('不到 1 小时')
  })

  it('到期那一刻起文案不再暗示还能撤销', () => {
    expect(deletionCountdown(now, now)).toBe('即将被删除')
    expect(deletionCountdown(now - 5 * D, now)).toBe('即将被删除')
  })

  it('可撤销的边界与后端严格一致:到期的那一刻就不能撤销', () => {
    expect(canCancelDeletion(now + 1, now)).toBe(true)
    expect(canCancelDeletion(now, now)).toBe(false)
    expect(canCancelDeletion(now - 1, now)).toBe(false)
  })
})

describe('export helpers', () => {
  it('字节数用 1024 进制,三位有效数字', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10 * 1024)).toBe('10 KB')
    expect(formatBytes(300_000)).toBe('293 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3.5 * 1024 ** 3)).toBe('3.5 GB')
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.0 TB')
    expect(formatBytes(5000 * 1024 ** 4)).toBe('5000 TB')
  })

  it('异常的字节数显示破折号而不是 NaN', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatBytes(bad)).toBe('—')
  })

  it('进度百分比向下取整并限制在 0–100;没有文件时算完成', () => {
    expect(exportPercent(0, 100)).toBe(0)
    expect(exportPercent(1, 3)).toBe(33)
    expect(exportPercent(99, 100)).toBe(99)
    expect(exportPercent(100, 100)).toBe(100)
    expect(exportPercent(150, 100)).toBe(100)
    expect(exportPercent(-5, 100)).toBe(0)
    expect(exportPercent(0, 0)).toBe(100)
  })

  it('导出文件的剩余保留时间', () => {
    const now = 1_800_000_000_000
    expect(expiresIn(now + 23 * 3_600_000 + 5, now)).toBe('23 小时')
    expect(expiresIn(now + 45 * 60_000, now)).toBe('45 分钟')
    expect(expiresIn(now + 1, now)).toBe('1 分钟')
    expect(expiresIn(now, now)).toBe('已过期')
    expect(expiresIn(now - 1000, now)).toBe('已过期')
  })
})
