// 错误与状态页的纯逻辑。
import { describe, expect, it } from 'vitest'
import { UNAVAILABLE_COPY, UNAVAILABLE_KINDS, classifyUnavailable, retryDelayMs, safeNext } from './status'

describe('classifyUnavailable', () => {
  it('设备没网优先:不管状态码是什么,都说设备离线', () => {
    expect(classifyUnavailable(null, false)).toBe('offline')
    expect(classifyUnavailable(503, false)).toBe('offline')
  })
  it('503 = 服务明确说暂时不可用,按「维护中」', () => {
    expect(classifyUnavailable(503, true)).toBe('maintenance')
  })
  it('其它 4xx / 5xx = 服务出了问题', () => {
    expect([500, 502, 504, 404, 429].map((status) => classifyUnavailable(status, true))).toEqual(['server', 'server', 'server', 'server', 'server'])
  })
  it('没有状态码(fetch 直接失败)= 连不上服务器', () => {
    expect(classifyUnavailable(null, true)).toBe('network')
    expect(classifyUnavailable(undefined, true)).toBe('network')
  })
})

describe('文案', () => {
  it('四种原因都有标题和说明,说明里有下一步,没有英文原词或状态码', () => {
    for (const kind of UNAVAILABLE_KINDS) {
      const copy = UNAVAILABLE_COPY[kind]
      expect(copy.title.length, kind).toBeGreaterThan(3)
      expect(copy.text, kind).toMatch(/重试|稍后|联系管理员|通常几分钟/)
      expect(`${copy.title}${copy.text}`, kind).not.toMatch(/[A-Za-z]{4,}|\b50\d\b/)
    }
  })
  it('设备离线不自动重试(没网重试没有意义,等 online 事件),其它自动重试', () => {
    expect(UNAVAILABLE_KINDS.map((kind) => UNAVAILABLE_COPY[kind].autoRetry)).toEqual([false, true, true, true])
  })
})

describe('retryDelayMs', () => {
  it('先快后慢,封顶 30 秒,负数当 0', () => {
    expect([0, 1, 2, 3, 4, 10, -3].map(retryDelayMs)).toEqual([3000, 6000, 12000, 24000, 30000, 30000, 3000])
  })
})

describe('safeNext', () => {
  it('站内路径原样放行(带查询和锚点)', () => {
    expect(safeNext('/kb?collection=a&item=b#x')).toBe('/kb?collection=a&item=b#x')
    expect(safeNext('/home')).toBe('/home')
  })
  it('没有 / 空值回到默认', () => {
    expect(safeNext(null)).toBe('/home')
    expect(safeNext('')).toBe('/home')
    expect(safeNext(undefined, '/x')).toBe('/x')
  })
  it('防开放重定向:协议相对、反斜杠、带协议、不以 / 开头、控制字符都拒绝', () => {
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', 'evil.com', '/ok\n//evil', '/a\u0000b']) expect(safeNext(bad), bad).toBe('/home')
  })
})
