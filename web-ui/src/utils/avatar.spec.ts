import { describe, expect, it } from 'vitest'
import { AVATAR_MAX_BYTES, avatarUrl, checkAvatarFile, hueOf, initialOf, isGuestId } from './avatar'

describe('游客标识', () => {
  it('游客标识以 guest: 开头;普通用户 id、空值都不是游客', () => {
    expect(isGuestId('guest:访客1234#7')).toBe(true)
    expect(isGuestId('usr_1')).toBe(false)
    expect(isGuestId('')).toBe(false)
    expect(isGuestId(null)).toBe(false)
    expect(isGuestId(undefined)).toBe(false)
  })
})

describe('avatar helpers', () => {
  it('地址带上文件名作版本,没有头像时返回 null', () => {
    expect(avatarUrl('usr_1', 'usr_1-0123abcd.png')).toBe('/api/v1/users/usr_1/avatar?v=usr_1-0123abcd.png')
    expect(avatarUrl('usr_1', null)).toBeNull()
    expect(avatarUrl('usr_1', '')).toBeNull()
    expect(avatarUrl('usr_1', undefined)).toBeNull()
  })

  it('id 和文件名里的特殊字符会被转义,不会改变地址结构', () => {
    const url = avatarUrl('a/b?c', 'x&y=1#z')!
    expect(url).toBe('/api/v1/users/a%2Fb%3Fc/avatar?v=x%26y%3D1%23z')
    expect(new URL(url, 'http://x').searchParams.get('v')).toBe('x&y=1#z')
  })

  it('首字母:拉丁字母大写、中文原样、emoji 不被拆开、空白与空值用兜底', () => {
    expect(initialOf('alice')).toBe('A')
    expect(initialOf('  林一')).toBe('林')
    expect(initialOf('🌸 花')).toBe('🌸')
    expect(initialOf('𠮷野家')).toBe('𠮷')
    expect(initialOf('')).toBe('?')
    expect(initialOf('   ')).toBe('?')
    expect(initialOf(null)).toBe('?')
    expect(initialOf(undefined, '#')).toBe('#')
  })

  it('同一个 id 永远同一个色相,不同 id 大多不同,范围 0–359', () => {
    expect(hueOf('usr_abc')).toBe(hueOf('usr_abc'))
    for (const id of ['', 'a', 'usr_0190', '林一', '🌸']) {
      const hue = hueOf(id)
      expect(Number.isInteger(hue) && hue >= 0 && hue < 360, id).toBe(true)
    }
    const hues = new Set(Array.from({ length: 50 }, (_, i) => hueOf(`usr_${i}`)))
    expect(hues.size).toBeGreaterThan(30)
  })

  it('选文件时的预检:空文件、超大、非图片格式', () => {
    const ok = { size: 1000, type: 'image/png' }
    expect(checkAvatarFile(ok)).toBeNull()
    for (const type of ['image/jpeg', 'image/webp', 'image/gif']) expect(checkAvatarFile({ size: 5, type })).toBeNull()
    expect(checkAvatarFile({ size: 0, type: 'image/png' })).toContain('空')
    expect(checkAvatarFile({ size: AVATAR_MAX_BYTES + 1, type: 'image/png' })).toContain('8 MB')
    expect(checkAvatarFile({ size: AVATAR_MAX_BYTES, type: 'image/png' })).toBeNull()
    for (const type of ['image/svg+xml', 'application/pdf', 'text/html', 'image/tiff', 'image/bmp', '']) {
      expect(checkAvatarFile({ size: 10, type }), type).toContain('只支持')
    }
  })
})
