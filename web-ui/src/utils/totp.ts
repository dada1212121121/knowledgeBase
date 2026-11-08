import { dayKey } from './time'
// 两步验证(TOTP)的纯逻辑:输入规整、恢复码文件、错误话术。页面见 Login.vue / components/TotpCard.vue。
// 都是不碰网络和 DOM 的函数,好测;后端才是权威,这里只让用户在提交前少犯错、出错时知道怎么办。
import { AccountError } from '@/api/client'
import { accountErrorText } from '@/utils/accountError'

/** 验证码位数,与后端 `totp::DIGITS` 一致。 */
export const CODE_DIGITS = 6
/** 一批恢复码的个数,与后端 `totp::RECOVERY_CODES` 一致。 */
export const RECOVERY_COUNT = 8

/**
 * 6 位验证码输入框的内容规整:只留数字、最多 6 位。
 * 先做 NFKC 把中文输入法打出的全角数字(１２３)变成半角;粘贴 `123 456` / `123-456` 也能用。
 */
export function normalizeCode(raw: string): string {
  return raw.normalize('NFKC').replace(/\D/g, '').slice(0, CODE_DIGITS)
}

/** 恢复码字母表:去掉容易看错的 0/O、1/I/L,与后端 `RECOVERY_ALPHABET` 一致。 */
const RECOVERY_CHARS = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{12}$/

/** 恢复码输入框的内容规整:去空白、转大写,连字符保留给用户看(后端会去掉)。最多 14 个字符(12 + 2 个连字符)。 */
export function normalizeRecovery(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, '').toUpperCase().slice(0, 14)
}

/** 是不是恢复码的形状(12 个合法字符,连字符不计)。 */
export function looksLikeRecovery(raw: string): boolean {
  return RECOVERY_CHARS.test(raw.normalize('NFKC').replace(/[\s-]/g, '').toUpperCase())
}

/** 验证码输入够不够提交:验证码要 6 位;恢复码要 12 个合法字符。 */
export function codeReady(raw: string, mode: 'code' | 'recovery'): boolean {
  return mode === 'code' ? raw.length === CODE_DIGITS : looksLikeRecovery(raw)
}

/** 关闭 / 重新生成这类动作里,验证码框接受 6 位码或恢复码,按输入形状判断够不够。 */
export function anyCodeReady(raw: string): boolean {
  return /^\d{6}$/.test(raw.replace(/\s+/g, '')) || looksLikeRecovery(raw)
}

/** 手动输入用的密钥:四个一组,好认也好抄(`JBSW Y3DP EHPK 3PXP`)。复制时给原始密钥,不带空格。 */
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim()
}

/** 剩余恢复码的提醒级别:够用 / 快用完 / 没有了。 */
export function recoveryLevel(left: number): 'ok' | 'low' | 'none' {
  if (left <= 0) return 'none'
  return left <= 2 ? 'low' : 'ok'
}

// ---------------------------------------------------------------- 恢复码文件

/** 下载的文件名;用户名只留安全字符,避免奇怪的路径或扩展名。 */
export function recoveryFileName(username: string): string {
  const safe = username.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30)
  return safe ? `recovery-codes-${safe}.txt` : 'recovery-codes.txt'
}

/** 下载的文件内容:说明用途和注意事项,再列出恢复码。 */
export function recoveryFileText(codes: string[], info: { site: string; account: string; day: string }): string {
  return [
    `${info.site} 两步验证恢复码`,
    `账号:${info.account}`,
    `生成日期:${info.day}`,
    '',
    '手机丢了或验证器用不了时,可以用下面任意一个恢复码代替验证码登录。',
    '每个恢复码只能用一次;请保存在密码管理器或别人拿不到的地方,不要和密码放在一起。',
    '重新生成恢复码后,这一批会全部作废。',
    '',
    ...codes.map((code, index) => `${String(index + 1).padStart(2, '0')}. ${code}`),
    '',
  ].join('\n')
}

// ---------------------------------------------------------------- 错误话术

/** 出错的场景:决定同一个错误码该怎么说。 */
export type TotpContext = 'login-code' | 'login-recovery' | 'setup' | 'confirm' | 'disable' | 'regenerate'

export type TotpErrorKind =
  | 'bad_password'
  | 'bad_code'
  | 'rate_limited'
  | 'challenge_expired'
  | 'conflict'
  | 'required'
  | 'session'
  | 'offline'
  | 'forbidden'
  | 'other'

export interface TotpErrorView {
  kind: TotpErrorKind
  /** 给用户看的话:发生了什么 + 可以怎么做。 */
  message: string
}

/**
 * 把请求失败翻译成用户能照着做的话(GLOSSARY:不直接显示状态码和英文异常)。
 *
 * 关键是同一个 401 有四种意思,只能靠后端的 `error.code` 区分:
 *   `bad_code` 验证码不对 / `bad_password` 密码不对 / `challenge_expired` 登录挑战过期 / `unauthorized` 会话过期。
 * 429 的话术**不采用**后端那句「或用恢复码登录」:后端的限速是按账号算的,恢复码的尝试也计入同一个额度,
 * 锁定期间恢复码同样不能用,照那句话做只会让人再失败一次。
 */
export function explainTotpError(err: unknown, context: TotpContext): TotpErrorView {
  if (!(err instanceof AccountError)) {
    // 网络断了 fetch 会抛 TypeError('Failed to fetch');其它未知异常也不要把英文原样给用户
    return { kind: 'offline', message: '连不上服务器。检查网络后再试一次。' }
  }
  if (err.status === 429) {
    return { kind: 'rate_limited', message: '输错的次数太多了,暂时不能再验证。请过 15 分钟再试。' }
  }
  switch (err.code) {
    case 'challenge_expired':
      return { kind: 'challenge_expired', message: '这次登录已经超时,或者验证码输错太多次。请回到上一步,重新输入密码。' }
    case 'bad_password':
      return { kind: 'bad_password', message: '密码不对,请再试一次。忘了密码的话,先退出登录,在登录页用「忘记密码」找回。' }
    case 'bad_code':
      if (context === 'login-recovery') {
        return { kind: 'bad_code', message: '恢复码不对,或者已经用过了。每个恢复码只能用一次,请换一个没用过的再试。' }
      }
      if (context === 'confirm') {
        return { kind: 'bad_code', message: '验证码不对。请确认扫的是这个二维码,并把手机时间设成自动,等屏幕上出现新的数字后再试。' }
      }
      return { kind: 'bad_code', message: '验证码不对,或者已经用过了。请等验证器里出现新的数字后再试。' }
    case 'totp_required':
      return { kind: 'required', message: '站点要求管理员必须开启两步验证,不能关闭。如需关闭,请联系站点负责人调整设置。' }
    case 'unauthorized':
      return { kind: 'session', message: '登录已过期,请重新登录。' }
  }
  if (err.status === 409) {
    return { kind: 'conflict', message: '两步验证已经开启了,可能是在另一个窗口里完成的。刷新页面可以看到最新状态。' }
  }
  if (err.status === 403) {
    return { kind: 'forbidden', message: err.message || '你的账号现在不能做这件事,请联系管理员。' }
  }
  if (context === 'confirm' && err.status === 400) {
    return { kind: 'other', message: '这次设置已经失效(可能在另一个窗口里重新开始了)。请关闭这个窗口,重新点「开启两步验证」。' }
  }
  // 服务端没给原因时 message 只是「请求失败(502)」之类的空话:交给 accountErrorText 过滤,落到通用话术
  const detail = accountErrorText(err, '').trim().replace(/[。.!!]+$/, '')
  return { kind: 'other', message: detail ? `${detail}。请稍后再试。` : '操作没有成功,请稍后再试。' }
}

/** 管理员重置完两步验证之后给他看的结果(提示条)。 */
export function totpResetSummary(result: { was_enabled: boolean; sessions_revoked: number }): string {
  const devices = result.sessions_revoked > 0 ? `并让他的 ${result.sessions_revoked} 台设备退出登录` : '他当前没有登录着的设备'
  if (result.was_enabled) return `已关掉他的两步验证,${devices}。他下次只用密码登录,需要自己重新开启。`
  return `他本来就没有开启两步验证;${devices}。`
}
