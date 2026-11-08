// 注册 / 改密码时的即时密码强度提示。
//
// 规则逐条对应后端 `kb_core::account::check_password_strength`(至少 8 位、最多 128 位、不是常见弱口令、
// 不等于用户名、不全是同一个字符),这样前端说「可以」的密码后端不会再拒绝。
// 后端才是权威:这里只负责让用户在提交前就看到原因,评分条纯展示用。

const COMMON = new Set([
  '12345678',
  '123456789',
  '1234567890',
  'password',
  'password1',
  'qwertyui',
  'qwerty123',
  '11111111',
  '00000000',
  '88888888',
  'abcd1234',
  'iloveyou',
  'admin123',
  '12341234',
  '1q2w3e4r',
  'asdfghjk',
  'zxcvbnm1',
  'a1234567',
  'aa123456',
  '123123123',
  '987654321',
])

export interface PasswordCheck {
  /** 能不能提交。 */
  ok: boolean
  /** 不能提交的原因;`ok` 时为空。 */
  message: string
  /** 0 = 还没输入,1–4 = 提示条点亮的格数。 */
  score: 0 | 1 | 2 | 3 | 4
  /** 强度文字。 */
  label: string
}

const LABELS = ['', '弱', '一般', '较强', '很强'] as const

export function checkPassword(password: string, username = ''): PasswordCheck {
  if (password === '') return { ok: false, message: '', score: 0, label: '' }
  // 按字符(码点)数,和后端的 chars.count 一致:一个汉字或 emoji 算一位
  const chars = Array.from(password)
  const lower = password.toLowerCase()
  const reject = (message: string): PasswordCheck => ({ ok: false, message, score: 1, label: LABELS[1] })
  if (chars.length < 8) return reject('密码至少 8 位')
  if (chars.length > 128) return reject('密码最多 128 位')
  if (COMMON.has(lower)) return reject('这个密码太常见了,换一个')
  if (username !== '' && lower === username.toLowerCase()) return reject('密码不能和用户名相同')
  if (chars.every((ch) => ch === chars[0])) return reject('密码不能全是同一个字符')

  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length
  let score = 2
  if (chars.length >= 12) score += 1
  if (kinds >= 3) score += 1
  const capped = Math.min(score, 4) as 2 | 3 | 4
  return { ok: true, message: '', score: capped, label: LABELS[capped] }
}
