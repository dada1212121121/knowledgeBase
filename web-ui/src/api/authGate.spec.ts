// 站点强制开启两步验证时的全局拦截:识别 403 totp_setup_required、不吞业务响应、不误伤其它请求。
import { describe, expect, it, vi } from 'vitest'
import { installAuthGate, isTotpSetupRequired, totpGateRedirect } from './authGate'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const REQUIRED = { ok: false, error: { code: 'totp_setup_required', message: '站点要求管理员开启两步验证,请先到个人设置里开启' } }

/** 一个假的 window:带 fetch 和 location,每次测试各用各的(避免互相装过)。 */
function fakeWindow(reply: () => Response) {
  const base = vi.fn(async () => reply())
  const target = { fetch: base as unknown as typeof fetch, location: { origin: 'https://kb.example.com' } } as unknown as Pick<Window, 'fetch' | 'location'>
  return { target, base }
}

describe('isTotpSetupRequired', () => {
  it('403 且 code 对:是;并且原响应的内容还能被调用方读', async () => {
    const response = json(403, REQUIRED)
    await expect(isTotpSetupRequired(response)).resolves.toBe(true)
    await expect(response.json()).resolves.toEqual(REQUIRED)
  })

  it('别的 403(没有开通功能)不算', async () => {
    await expect(isTotpSetupRequired(json(403, { ok: false, error: { code: 'forbidden', message: '你的账号没有开通这个功能' } }))).resolves.toBe(false)
  })

  it('同样的 code 但状态码不是 403 不算;非 JSON 的 403(网关页面)也不会抛错', async () => {
    await expect(isTotpSetupRequired(json(200, REQUIRED))).resolves.toBe(false)
    await expect(isTotpSetupRequired(new Response('<html>Forbidden</html>', { status: 403 }))).resolves.toBe(false)
  })
})

describe('installAuthGate', () => {
  it('接口返回 totp_setup_required:通知上层一次,调用方照样拿到完整响应', async () => {
    const { target } = fakeWindow(() => json(403, REQUIRED))
    const onRequired = vi.fn()
    installAuthGate(onRequired, target)
    const response = await target.fetch('/api/v1/capabilities/stats_overview', { method: 'POST' })
    expect(onRequired).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('totp_setup_required')
  })

  it('覆盖 fetch 的各种入参:字符串、URL、Request', async () => {
    const { target } = fakeWindow(() => json(403, REQUIRED))
    const onRequired = vi.fn()
    installAuthGate(onRequired, target)
    await target.fetch('/api/v1/me/prefs')
    await target.fetch(new URL('https://kb.example.com/api/v1/me/sessions'))
    await target.fetch(new Request('https://kb.example.com/api/v1/auth/tokens'))
    expect(onRequired).toHaveBeenCalledTimes(3)
  })

  it('成功的请求、别的错误、非 API 地址、别的域名:都不触发', async () => {
    let reply = json(200, { ok: true })
    const { target } = fakeWindow(() => reply)
    const onRequired = vi.fn()
    installAuthGate(onRequired, target)
    await target.fetch('/api/v1/health')
    reply = json(403, { ok: false, error: { code: 'forbidden', message: 'x' } })
    await target.fetch('/api/v1/capabilities/x')
    reply = json(403, REQUIRED)
    await target.fetch('/version.json')
    await target.fetch('https://other.example.com/api/v1/x')
    expect(onRequired).not.toHaveBeenCalled()
  })

  it('上层处理抛错,业务请求照常返回', async () => {
    const { target } = fakeWindow(() => json(403, REQUIRED))
    installAuthGate(() => {
      throw new Error('boom')
    }, target)
    await expect(target.fetch('/api/v1/x')).resolves.toBeInstanceOf(Response)
  })

  it('重复安装不会叠加:只通知一次', async () => {
    const { target } = fakeWindow(() => json(403, REQUIRED))
    const onRequired = vi.fn()
    installAuthGate(onRequired, target)
    installAuthGate(onRequired, target)
    await target.fetch('/api/v1/x')
    expect(onRequired).toHaveBeenCalledTimes(1)
  })

  it('网络错误照常抛给调用方', async () => {
    const target = { fetch: vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch, location: { origin: 'https://kb.example.com' } } as unknown as Pick<Window, 'fetch' | 'location'>
    installAuthGate(vi.fn(), target)
    await expect(target.fetch('/api/v1/x')).rejects.toThrow('Failed to fetch')
  })
})

describe('totpGateRedirect', () => {
  it('标记没置位:一律放行', () => {
    expect(totpGateRedirect({ path: '/home' }, false)).toBe(true)
  })

  it('标记置位:其它页面改道去个人设置的两步验证区(replace,不留历史)', () => {
    expect(totpGateRedirect({ path: '/home' }, true)).toEqual({ path: '/me', query: { need: 'totp' }, replace: true })
    expect(totpGateRedirect({ path: '/admin/users' }, true)).toEqual({ path: '/me', query: { need: 'totp' }, replace: true })
    expect(totpGateRedirect({ path: '/me/appearance' }, true)).toMatchObject({ path: '/me' })
  })

  it('个人设置本身和公开页(登录等)放行,否则出现死循环或退不出登录', () => {
    expect(totpGateRedirect({ path: '/me' }, true)).toBe(true)
    expect(totpGateRedirect({ path: '/login', meta: { public: true } }, true)).toBe(true)
  })
})
