import { describe, expect, it } from 'vitest'
import { checkPassword } from './passwordStrength'

describe('checkPassword', () => {
  it('空密码还没开始输入,不提示原因', () => {
    expect(checkPassword('')).toEqual({ ok: false, message: '', score: 0, label: '' })
  })

  it('和后端一样的拒绝规则与文案', () => {
    expect(checkPassword('short').message).toBe('密码至少 8 位')
    expect(checkPassword('x'.repeat(129)).message).toBe('密码最多 128 位')
    expect(checkPassword('Password1').message).toBe('这个密码太常见了,换一个')
    expect(checkPassword('12345678').message).toBe('这个密码太常见了,换一个')
    expect(checkPassword('aaaaaaaa').message).toBe('密码不能全是同一个字符')
    expect(checkPassword('User_Yi_01', 'user_yi_01').message).toBe('密码不能和用户名相同')
    for (const bad of ['short', 'Password1', 'aaaaaaaa']) expect(checkPassword(bad).ok).toBe(false)
  })

  it('长度按字符而不是字节算:8 个汉字够,7 个不够', () => {
    expect(checkPassword('密码密码密码密码').ok).toBe(true)
    expect(checkPassword('密码密码密码密').message).toBe('密码至少 8 位')
    // emoji 是一个码点,不是两个 UTF-16 单元
    expect(checkPassword('😀😁😂🤣😃😄😅').message).toBe('密码至少 8 位')
  })

  it('长度和字符种类越多评分越高,最高 4 格', () => {
    expect(checkPassword('correcthorse').score).toBe(3)
    expect(checkPassword('mypassw0rd').score).toBe(2)
    expect(checkPassword('Tr0ub4dor&3').score).toBe(3)
    expect(checkPassword('Correct-Horse-Battery-9').score).toBe(4)
    expect(checkPassword('Correct-Horse-Battery-9').label).toBe('很强')
  })

  it('不能提交的密码评分最低一格,可提交的至少两格', () => {
    expect(checkPassword('abc').score).toBe(1)
    expect(checkPassword('mypassw0rd').ok).toBe(true)
    expect(checkPassword('mypassw0rd').score).toBeGreaterThanOrEqual(2)
  })
})
