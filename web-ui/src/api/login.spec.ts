// 登录与两步验证请求的契约:挑战只在返回值里、错误码带出来、密码 / 验证码错误不会触发整页跳转。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountError, login, loginTotp } from './client'
import { totpConfirm, totpDisable, totpSetup, totpStatus } from './totp'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }))
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

describe('login', () => {
  it('普通登录成功:kind=ok', async () => {
    respond(200, { ok: true, data: { logged_in: true, user: {} } })
    await expect(login('pw', 'alice')).resolves.toEqual({ kind: 'ok' })
  })

  it('开着两步验证:返回挑战,不当成登录成功', async () => {
    respond(200, { ok: true, data: { logged_in: false, totp_required: true, challenge: 'chal-abc' } })
    await expect(login('pw', 'alice')).resolves.toEqual({ kind: 'totp', challenge: 'chal-abc' })
  })

  it('要验证码却没给挑战:报错而不是停在一个提交不了的页面', async () => {
    respond(200, { ok: true, data: { logged_in: false, totp_required: true } })
    await expect(login('pw', 'alice')).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('既没登录也没要验证码:报错,不能当成成功', async () => {
    respond(200, { ok: true, data: { logged_in: false } })
    await expect(login('pw', 'alice')).rejects.toBeInstanceOf(AccountError)
  })

  it('失败抛 AccountError,带状态码、错误码和后端的话', async () => {
    respond(401, { ok: false, error: { code: 'unauthorized', message: '用户名或密码不对' } })
    const error = (await login('pw', 'alice').catch((e: unknown) => e)) as AccountError
    expect(error).toBeInstanceOf(AccountError)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('用户名或密码不对')
    expect(error.status).toBe(401)
  })

  it('请求体里只有 login 和 password', async () => {
    const spy = respond(200, { ok: true, data: { logged_in: true } })
    await login('pw', ' alice ')
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/auth/login')
    expect(JSON.parse(String(init.body))).toEqual({ login: 'alice', password: 'pw' })
  })
})

describe('loginTotp', () => {
  it('成功什么都不返回,请求体是挑战 + 验证码', async () => {
    const spy = respond(200, { ok: true, data: { logged_in: true } })
    await expect(loginTotp('chal', '481039')).resolves.toBeUndefined()
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/auth/login/totp')
    expect(JSON.parse(String(init.body))).toEqual({ challenge: 'chal', code: '481039' })
    // 验证码和挑战只在请求体里:地址上不能带
    expect(url).not.toContain('481039')
    expect(url).not.toContain('chal')
  })

  it('401 验证码不对 / 挑战过期:靠 code 区分', async () => {
    respond(401, { ok: false, error: { code: 'bad_code', message: '验证码不正确或已经用过' } })
    await expect(loginTotp('chal', '000000')).rejects.toMatchObject({ status: 401, code: 'bad_code' })
    respond(401, { ok: false, error: { code: 'challenge_expired', message: '登录已超时,请重新输入密码' } })
    await expect(loginTotp('chal', '000000')).rejects.toMatchObject({ status: 401, code: 'challenge_expired' })
  })

  it('429:带出状态码', async () => {
    respond(429, { ok: false, error: { code: 'rate_limited', message: '验证码输错次数过多' } })
    await expect(loginTotp('chal', '000000')).rejects.toMatchObject({ status: 429, code: 'rate_limited' })
  })

  it('响应不是 JSON 也不崩,给通用话术', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch
    await expect(loginTotp('chal', '000000')).rejects.toMatchObject({ status: 502, message: '验证失败' })
  })
})

describe('totp(已登录)接口', () => {
  const location = { href: '/me', pathname: '/me', search: '' }

  it('密码错 / 验证码错的 401 不会把人踢去登录页', async () => {
    // 代码读的是 window.location,所以要换掉 window(只换 location 全局的话,跳转发生了这条断言也看不见)
    vi.stubGlobal('window', { location })
    respond(401, { ok: false, error: { code: 'bad_password', message: '密码不正确' } })
    await expect(totpSetup('wrong')).rejects.toMatchObject({ code: 'bad_password' })
    respond(401, { ok: false, error: { code: 'bad_code', message: '验证码不正确' } })
    await expect(totpConfirm('000000')).rejects.toMatchObject({ code: 'bad_code' })
    expect(location.href).toBe('/me')
  })

  it('会话真的过期了(code=unauthorized):跳登录页并带上回来的路径', async () => {
    const here = { href: '/me', pathname: '/me', search: '?x=1' }
    vi.stubGlobal('window', { location: here })
    respond(401, { ok: false, error: { code: 'unauthorized', message: '请先登录' } })
    await expect(totpStatus()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(here.href).toBe('/login?next=%2Fme%3Fx%3D1')
  })

  it('各接口的路径、方法和请求体', async () => {
    const spy = respond(200, { ok: true, data: {} })
    await totpStatus()
    await totpSetup('pw')
    await totpConfirm('123456')
    await totpDisable('pw', '123456')
    const calls = spy.mock.calls as unknown as [string, RequestInit][]
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'GET /api/v1/auth/totp',
      'POST /api/v1/auth/totp/setup',
      'POST /api/v1/auth/totp/confirm',
      'POST /api/v1/auth/totp/disable',
    ])
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ password: 'pw' })
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ code: '123456' })
    expect(JSON.parse(String(calls[3]![1].body))).toEqual({ password: 'pw', code: '123456' })
    // 带 CSRF 头
    expect((calls[1]![1].headers as Record<string, string>)['x-kb-csrf']).toBe('1')
  })
})
