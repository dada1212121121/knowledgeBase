import { describe, expect, it } from 'vitest'
import { AccountError } from '@/api/client'
import { OFFLINE_TEXT, accountErrorText } from './accountError'

const FALLBACK = '注册没有成功。请稍后再试;仍然不行请联系管理员。'

describe('accountErrorText', () => {
  it('断网时 fetch 抛的英文 TypeError 换成一句人话(Chrome / Safari / Firefox 三种写法)', () => {
    for (const message of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) {
      expect(accountErrorText(new TypeError(message), FALLBACK)).toBe(OFFLINE_TEXT)
    }
  })

  it('服务端给的中文原因原样用(它本来就写给人看)', () => {
    expect(accountErrorText(new AccountError('验证码不对,或者已经用过了。', 401), FALLBACK)).toBe('验证码不对,或者已经用过了。')
  })

  it('服务端没给原因时 api/client 拼的「请求失败(502)」不能露给用户:换成带下一步的说明', () => {
    expect(accountErrorText(new AccountError('请求失败(502)', 502), FALLBACK)).toBe(FALLBACK)
    expect(accountErrorText(new AccountError('请求失败(500)', 500), FALLBACK)).toBe(FALLBACK)
    // 登录 / 验证码接口自己的兜底也是空话
    expect(accountErrorText(new AccountError('登录失败', 502), FALLBACK)).toBe(FALLBACK)
    expect(accountErrorText(new AccountError('验证失败', 502), FALLBACK)).toBe(FALLBACK)
  })

  it('英文 / 空的 message、不是 Error 的东西一律用调用方给的两句话', () => {
    expect(accountErrorText(new Error('internal error'), FALLBACK)).toBe(FALLBACK)
    expect(accountErrorText(new Error(''), FALLBACK)).toBe(FALLBACK)
    expect(accountErrorText('boom', FALLBACK)).toBe(FALLBACK)
    expect(accountErrorText(undefined, FALLBACK)).toBe(FALLBACK)
  })

  it('不是网络问题的 TypeError(代码写错了)也不把英文给用户', () => {
    expect(accountErrorText(new TypeError("Cannot read properties of undefined (reading 'x')"), FALLBACK)).toBe(FALLBACK)
  })
})
