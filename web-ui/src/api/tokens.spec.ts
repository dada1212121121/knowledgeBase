// 令牌接口的契约:路径、请求体(include_shared 只对 mcp 为真)、CSRF、明文只在创建响应里。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tokenCreate, tokenRevoke, tokensList } from './tokens'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
function respond(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}
const lastCall = (spy: ReturnType<typeof respond>) => spy.mock.calls.at(-1) as unknown as [string, RequestInit]

describe('tokenCreate', () => {
  it('MCP 令牌带上 include_shared;名字去掉首尾空白;带 CSRF 头', async () => {
    const spy = respond(200, { ok: true, data: { id: 'k1', name: 'kiro', scope: 'mcp', token: 'kb_secret' } })
    const created = await tokenCreate('  kiro ', 'mcp', true)
    expect(created.token).toBe('kb_secret')
    const [url, init] = lastCall(spy)
    expect(url).toBe('/api/v1/auth/tokens')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ name: 'kiro', scope: 'mcp', include_shared: true })
    expect((init.headers as Record<string, string>)['x-kb-csrf']).toBe('1')
  })

  it('默认不包含共享内容', async () => {
    const spy = respond(200, { ok: true, data: { id: 'k1', name: 'kiro', scope: 'mcp', token: 't' } })
    await tokenCreate('kiro', 'mcp', false)
    expect(JSON.parse(String(lastCall(spy)[1].body)).include_shared).toBe(false)
  })

  it('API 令牌永远不发 include_shared=true(后端会忽略,界面不能让人以为开了)', async () => {
    const spy = respond(200, { ok: true, data: { id: 'k2', name: 'ci', scope: 'api', token: 't' } })
    await tokenCreate('ci', 'api', true)
    expect(JSON.parse(String(lastCall(spy)[1].body))).toEqual({ name: 'ci', scope: 'api', include_shared: false })
  })

  it('重名:409 抛 AccountError,带状态码', async () => {
    respond(409, { ok: false, error: { code: 'exists', message: '已有同名令牌:kiro' } })
    await expect(tokenCreate('kiro', 'mcp', false)).rejects.toMatchObject({ status: 409 })
  })
})

describe('tokensList', () => {
  it('补上 scopes 别名,保留 include_shared', async () => {
    respond(200, { ok: true, data: { tokens: [{ id: 'a', name: 'kiro', scope: 'mcp', include_shared: true, created_at: 1, last_used: null, revoked_at: null }] } })
    const [row] = await tokensList()
    expect(row).toMatchObject({ scope: 'mcp', scopes: 'mcp', include_shared: true })
  })

  it('服务端报错要抛出来,不能悄悄返回空列表(否则页面会说「还没有令牌」)', async () => {
    respond(500, { ok: false, error: { code: 'internal', message: '令牌服务暂时不可用' } })
    await expect(tokensList()).rejects.toMatchObject({ status: 500 })
  })
})

describe('tokenRevoke', () => {
  it('DELETE 到令牌自己的地址,id 做了转义', async () => {
    const spy = respond(200, { ok: true, data: { id: 'a/b', revoked_at: 1 } })
    await tokenRevoke('a/b')
    const [url, init] = lastCall(spy)
    expect(url).toBe('/api/v1/auth/tokens/a%2Fb')
    expect(init.method).toBe('DELETE')
  })
})
