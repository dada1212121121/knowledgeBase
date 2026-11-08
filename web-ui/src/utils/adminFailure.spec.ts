import { describe, expect, it } from 'vitest'
import { adminFailure } from './adminFailure'

const apiError = (message: string, status: number) => Object.assign(new Error(message), { status })

describe('adminFailure', () => {
  it('去掉后端的英文类别前缀,只留给人看的中文原因', () => {
    const failure = adminFailure(apiError('invalid input: 读取黄金集 eval/x.toml 失败: 文件不存在', 400), '运行评测')
    expect(failure.phase).toBe('error')
    expect(failure.message).toBe('运行评测失败:读取黄金集 eval/x.toml 失败: 文件不存在。请稍后重试,仍然不行请联系管理员。')
    expect(failure.message).not.toMatch(/invalid input/i)
  })

  it('「怎么办」可以按页面换掉:系统状态页不能叫人去系统状态页', () => {
    const failure = adminFailure(apiError('服务暂时不可用', 503), '读取系统状态', { next: '请点「重试」;一直不行就在服务器上看守护进程的日志。' })
    expect(failure.message).toBe('读取系统状态失败:服务暂时不可用。请点「重试」;一直不行就在服务器上看守护进程的日志。')
  })

  it('403 是无权限,不是可重试的报错', () => {
    expect(adminFailure(apiError('你的账号没有开通这个功能', 403), '读取系统状态')).toEqual({
      phase: 'forbidden',
      message: '你的账号没有开通这个功能,请联系管理员。',
    })
  })

  it('断网不露英文异常,不是网络问题的未知异常不能谎称连不上服务器', () => {
    expect(adminFailure(new TypeError('Failed to fetch'), '读取评测记录').message).toBe('读取评测记录失败:连不上服务器。请检查网络后重试。')
    const unknown = adminFailure(new Error('boom'), '读取评测记录')
    expect(unknown.message).toContain('出现了没有预料到的错误')
    expect(unknown.message).not.toContain('连不上服务器')
    expect(unknown.message).not.toContain('boom')
  })

  it('401 提示重新登录', () => {
    expect(adminFailure(apiError('unauthorized', 401), '读取').message).toContain('重新登录')
  })
})
