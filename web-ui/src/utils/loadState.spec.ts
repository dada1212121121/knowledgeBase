import { describe, expect, it } from 'vitest'
import { NO_ACCESS_TEXT, failureOf, friendly } from './loadState'

/** 模拟 client.ts 的 CapabilityError:带 status 的 Error。 */
const apiError = (message: string, status: number) => Object.assign(new Error(message), { status })

describe('failureOf', () => {
  it('403 是无权限,不是报错:用服务端的中文原因,没有就用统一说明', () => {
    expect(failureOf(apiError('你的账号没有开通这个功能', 403), '读取存储用量')).toEqual({
      phase: 'forbidden',
      message: '你的账号没有开通这个功能,请联系管理员。',
    })
    expect(failureOf(apiError('AI 功能已关闭', 403), '读取用量')).toMatchObject({ phase: 'forbidden', message: 'AI 功能已关闭,请联系管理员。' })
    expect(failureOf(apiError('HTTP 403', 403), '读取用量')).toEqual({ phase: 'forbidden', message: NO_ACCESS_TEXT })
  })

  it('其它失败是可重试的报错,带上「正在做什么」和下一步', () => {
    const failure = failureOf(apiError('存储统计没有启用', 503), '读取存储用量')
    expect(failure.phase).toBe('error')
    expect(failure.message).toContain('读取存储用量失败:存储统计没有启用')
    expect(failure.message).toContain('请稍后重试')
  })

  it('服务端原话的英文类别前缀不露出来,只留给人看的中文', () => {
    expect(failureOf(apiError('forbidden: 你的账号没有开通这个功能', 403), '读取')).toEqual({ phase: 'forbidden', message: '你的账号没有开通这个功能,请联系管理员。' })
    const failure = failureOf(apiError('internal: 磁盘空间不足', 500), '读取列表')
    expect(failure.message).toContain('读取列表失败:磁盘空间不足')
    expect(failure.message).not.toMatch(/internal/)
    expect(failureOf(apiError('not found: 没有找到这个内容', 404), '打开文档').message).not.toMatch(/not found/)
    // 纯英文的原话(没有中文可留)仍然走统一的兜底说法,不露英文
    expect(failureOf(apiError('internal: boom', 500), '读取').message).not.toMatch(/internal|boom/)
  })

  it('断网时不露英文异常', () => {
    const failure = failureOf(new TypeError('Failed to fetch'), '读取分享链接')
    expect(failure.message).toBe('读取分享链接失败:连不上服务器。请检查网络后重试。')
    expect(failureOf(new TypeError('Load failed'), '读取').message).toContain('连不上服务器')
  })

  it('不是网络问题的未知异常不能谎称「连不上服务器」', () => {
    const failure = failureOf(new TypeError("Cannot read properties of undefined (reading 'top')"), '读取存储用量')
    expect(failure.message).not.toContain('连不上服务器')
    expect(failure.message).not.toContain('Cannot read')
    expect(failure.phase).toBe('error')
  })

  it('401 提示重新登录', () => {
    expect(failureOf(apiError('未登录', 401), '读取').message).toContain('重新登录')
  })

  it('不是 Error 的东西也不会抛', () => {
    expect(failureOf(undefined, '读取').phase).toBe('error')
    expect(failureOf('boom', '读取').phase).toBe('error')
  })
})

describe('friendly', () => {
  it('成功原样返回', async () => {
    await expect(friendly(Promise.resolve(3), '删除角色')).resolves.toBe(3)
  })
  it('失败换成「做什么失败 + 怎么办」,保留中文原因,不露英文', async () => {
    await expect(friendly(Promise.reject(apiError('还有 2 个用户在使用这个角色,请先改成别的角色', 409)), '删除角色')).rejects.toThrow('删除角色失败:还有 2 个用户在使用这个角色,请先改成别的角色')
    await expect(friendly(Promise.reject(apiError('boom', 500)), '删除角色')).rejects.toThrow('出现了没有预料到的错误')
  })
})
