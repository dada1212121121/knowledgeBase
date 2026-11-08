import { describe, expect, it } from 'vitest'
import { registeredText } from './userText'

describe('registeredText', () => {
  it('已知的注册方式翻成中文,邀请码注册不露邀请码 id', () => {
    expect(registeredText('admin')).toBe('管理员创建')
    expect(registeredText('cli')).toBe('命令行创建')
    expect(registeredText('migrated')).toBe('从单用户版升级')
    expect(registeredText('email')).toBe('邮箱注册')
    expect(registeredText('invite:inv_8f21')).toBe('邀请码注册')
    expect(registeredText('invite:inv_8f21')).not.toContain('inv_')
  })
  it('认不得的和空值不露内部标识', () => {
    expect(registeredText('sso:github')).toBe('其它方式')
    expect(registeredText(null)).toBe('其它方式')
  })
})
