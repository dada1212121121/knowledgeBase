// 两步验证接口(后端 crates/kb-web/src/auth/totp.rs,请求 / 响应形状见 crates/kb-cli/tests/e2e_totp.rs)。
// 登录那一步(`/auth/login/totp`)在 client.ts 的 `loginTotp`,因为它发生在有会话之前。
import { AccountError, accountRequest } from './client'

export interface TotpState {
  enabled: boolean
  /** 剩余的恢复码个数(没开启时恒为 0)。 */
  recovery_codes_left: number
  /** 站点要求管理员开启两步验证,而当前账号是管理级:开启后不能关闭。 */
  required: boolean
}

export interface TotpSetup {
  /** base32 密钥,用户手动输入验证器时用。 */
  secret: string
  /** `otpauth://totp/…`,二维码的内容。 */
  otpauth_uri: string
  issuer: string
}

/**
 * 这组接口用 401 表示「密码不对 / 验证码不对」,所以**不能**用 `signedIn: true`
 * (它会把任何 401 当成会话过期、整页跳去登录页,用户输错一次密码就被踢出去了)。
 * 真正的会话过期后端返回 `code: unauthorized`,在这里单独处理成跳转。
 */
async function call<T>(method: 'GET' | 'POST', path: string, json?: unknown): Promise<T> {
  try {
    return await accountRequest<T>(method, path, json === undefined ? {} : { json })
  } catch (err) {
    if (err instanceof AccountError && err.status === 401 && err.code === 'unauthorized') {
      const { pathname = '/', search = '' } = window.location
      if (pathname !== '/login') window.location.href = `/login?next=${encodeURIComponent(pathname + search)}`
    }
    throw err
  }
}

/** 当前状态:是否开启、剩余恢复码、站点是否强制。 */
export const totpStatus = () => call<TotpState>('GET', '/api/v1/auth/totp')

/** 第一步:重新输入密码,换来密钥和二维码内容(此时还没开启,输对第一个码才算)。 */
export const totpSetup = (password: string) => call<TotpSetup>('POST', '/api/v1/auth/totp/setup', { password })

/** 第二步:输入验证器里的第一个码,正式开启,同时拿到恢复码(**只返回这一次**)。 */
export const totpConfirm = (code: string) =>
  call<{ enabled: boolean; recovery_codes: string[] }>('POST', '/api/v1/auth/totp/confirm', { code })

/** 关闭:要密码和一次验证(6 位码或恢复码)。 */
export const totpDisable = (password: string, code: string) =>
  call<{ enabled: boolean }>('POST', '/api/v1/auth/totp/disable', { password, code })

/** 重新生成恢复码:要密码和一次验证;旧的全部作废,新的**只返回这一次**。 */
export const totpRegenerate = (password: string, code: string) =>
  call<{ recovery_codes: string[] }>('POST', '/api/v1/auth/totp/recovery', { password, code })
