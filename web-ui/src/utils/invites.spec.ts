import { describe, expect, it } from 'vitest'
import { codesText, emptyInviteForm, expiryText, inviteArgs, normalizeInviteCode, stateTone, usageText } from './invites'

describe('invite helpers', () => {
  it('单次码显示未使用 / 已使用,多次码显示 已用 / 总数', () => {
    expect(usageText({ used: 0, max_uses: 1 })).toBe('未使用')
    expect(usageText({ used: 1, max_uses: 1 })).toBe('已使用')
    expect(usageText({ used: 3, max_uses: 50 })).toBe('3 / 50 次')
  })

  it('有效期文案', () => {
    const now = 1_000_000_000_000
    expect(expiryText(null, now)).toBe('不过期')
    expect(expiryText(now - 1, now)).toBe('已过期')
    expect(expiryText(now + 3_600_000, now)).toBe('1 天内过期')
    expect(expiryText(now + 6.2 * 86_400_000, now)).toBe('7 天后过期')
  })

  it('状态颜色:可用绿、撤销红、过期黄、用完灰', () => {
    expect(stateTone('active')).toBe('success')
    expect(stateTone('revoked')).toBe('danger')
    expect(stateTone('expired')).toBe('warning')
    expect(stateTone('used_up')).toBe('neutral')
  })

  it('默认表单就是一个单次、不过期、沿用默认角色的邀请码', () => {
    expect(inviteArgs(emptyInviteForm())).toEqual({ args: { max_uses: 1, count: 1 } })
  })

  it('填了的项才进参数,空白被裁掉', () => {
    const form = { note: ' 内测第一批 ', max_uses: '5', expires_days: 30, role_id: 'role_x', storage_gb: '3', count: '10' }
    expect(inviteArgs(form)).toEqual({
      args: { max_uses: 5, count: 10, note: '内测第一批', expires_days: 30, role_id: 'role_x', quota: { storage_gb: 3 } },
    })
  })

  it('范围和后端一致,越界当场提示', () => {
    const bad = (patch: Partial<ReturnType<typeof emptyInviteForm>>) =>
      (inviteArgs({ ...emptyInviteForm(), ...patch }) as { error: string }).error
    expect(bad({ max_uses: '0' })).toContain('可用次数')
    expect(bad({ max_uses: '10001' })).toContain('可用次数')
    expect(bad({ max_uses: '1.5' })).toContain('可用次数')
    expect(bad({ max_uses: '-1' })).toContain('可用次数')
    expect(bad({ count: '0' })).toContain('1–100')
    expect(bad({ count: '101' })).toContain('1–100')
    expect(bad({ storage_gb: '0' })).toContain('存储配额')
    expect(bad({ storage_gb: 'abc' })).toContain('存储配额')
  })

  it('批量生成的邀请码一行一个', () => {
    expect(codesText(['KB-AAAA-BBBB', 'KB-CCCC-DDDD'])).toBe('KB-AAAA-BBBB\nKB-CCCC-DDDD')
  })

  it('只有完整的邀请码才会被规范化,半截输入不触发核对', () => {
    expect(normalizeInviteCode('KB-7H2K-M4QX')).toBe('KB-7H2K-M4QX')
    // 大小写、空格、横线、省略前缀都认(和后端一致)
    expect(normalizeInviteCode('kb 7h2k m4qx')).toBe('KB-7H2K-M4QX')
    expect(normalizeInviteCode('7h2km4qx')).toBe('KB-7H2K-M4QX')
    expect(normalizeInviteCode(' KB7H2KM4QX ')).toBe('KB-7H2K-M4QX')
    // 还没输完 / 输多了 / 含字母表之外的字符(0 O 1 I L)
    for (const partial of ['', 'K', 'KB-', 'KB-7H2K', 'KB-7H2K-', 'KB-7H2K-M4Q', 'KB-7H2K-M4QXZ', 'KB-0H2K-M4QX', 'KB-IH2K-M4QX']) {
      expect(normalizeInviteCode(partial), partial).toBeNull()
    }
  })
})
