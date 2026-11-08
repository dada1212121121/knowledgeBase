// client.ts 的契约:CSRF 头、错误码映射、409 冲突识别。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountError, CapabilityError, accountRequest, callCapability } from './client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function respond(status: number, body: unknown) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

describe('callCapability', () => {
  it('成功时返回 data,并带上 CSRF 头', async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, data: { rows: 3 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    globalThis.fetch = spy as unknown as typeof fetch
    const data = await callCapability<{ rows: number }>('stats_overview')
    expect(data.rows).toBe(3)
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-kb-csrf']).toBe('1')
  })

  it('网关返回的不是 JSON(守护进程重启 / 超时):抛带中文说明的 bad_gateway,不是 SyntaxError', async () => {
    globalThis.fetch = vi.fn(async () => new Response('kbd unavailable', { status: 502 })) as unknown as typeof fetch
    await expect(callCapability('eval_run')).rejects.toMatchObject({
      name: 'CapabilityError',
      code: 'bad_gateway',
      status: 502,
      message: expect.stringContaining('服务暂时没有响应'),
    })
    globalThis.fetch = vi.fn(async () => new Response('<html>oops</html>', { status: 200 })) as unknown as typeof fetch
    await expect(callCapability('eval_run')).rejects.toMatchObject({ code: 'bad_gateway', message: expect.stringContaining('无法识别') })
  })

  it('409 映射成 conflict,isConflict 为真', async () => {
    respond(409, { ok: false, error: { code: 'conflict', message: '版本不一致' } })
    await expect(callCapability('edit_item', { id: 'x' })).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    })
    try {
      await callCapability('edit_item', { id: 'x' })
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError)
      expect((err as CapabilityError).isConflict).toBe(true)
    }
  })

  it('dry_run 走查询参数', async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    globalThis.fetch = spy as unknown as typeof fetch
    await callCapability('delete_item', { id: 'x' }, { dryRun: true })
    const [url] = spy.mock.calls[0] as unknown as [string]
    expect(url).toContain('dry_run=true')
  })

  it('401 跳转登录页,并抛出 unauthorized(验收项)', async () => {
    respond(401, { ok: false, error: { code: 'unauthorized', message: '请先登录' } })
    // jsdom 里给 location.href 赋值会触发“导航未实现”,换成可写对象观察跳转
    const location = { href: '/', pathname: '/', search: '' }
    Object.defineProperty(window, 'location', { value: location, writable: true })
    await expect(callCapability('list_items', {})).rejects.toMatchObject({ code: 'unauthorized' })
    expect(location.href).toBe('/login')
  })

  it('已在登录页时 401 不再跳转(否则整页刷新会形成无限循环)', async () => {
    respond(401, { ok: false, error: { code: 'unauthorized', message: '请先登录' } })
    const location = { href: '/login', pathname: '/login', search: '' }
    Object.defineProperty(window, 'location', { value: location, writable: true })
    await expect(callCapability('list_items', {})).rejects.toMatchObject({ code: 'unauthorized' })
    expect(location.href).toBe('/login')
  })

  it('在其它页面 401 会带上当前位置,登录后能回到原处', async () => {
    respond(401, { ok: false, error: { code: 'unauthorized', message: '请先登录' } })
    const location = { href: '/jobs', pathname: '/jobs', search: '?tab=x' }
    Object.defineProperty(window, 'location', { value: location, writable: true })
    await expect(callCapability('list_items', {})).rejects.toMatchObject({ code: 'unauthorized' })
    expect(location.href).toBe('/login?next=%2Fjobs%3Ftab%3Dx')
  })

  it('cwd / project 走百分号编码(服务端 api.rs 用 pct::decode_strict)', async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    globalThis.fetch = spy as unknown as typeof fetch
    await callCapability(
      'search_knowledge',
      { query: 'x' },
      { cwd: '/tmp/我的 项目', project: 'demo proj' },
    )
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['x-kb-cwd']).toBe(encodeURIComponent('/tmp/我的 项目'))
    expect(headers['x-kb-project']).toBe(encodeURIComponent('demo proj'))
    expect(headers['x-kb-project']).not.toContain(' ')
  })

  it('space 选项带上 X-KB-Space;不传就没有这个头(默认是自己的知识库)', async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    globalThis.fetch = spy as unknown as typeof fetch
    await callCapability('get_item', { id: 'a' }, { space: 'sp_alice0123456789' })
    await callCapability('get_item', { id: 'a' })
    const headersOf = (index: number) => (spy.mock.calls[index] as unknown as [string, RequestInit])[1].headers as Record<string, string>
    expect(headersOf(0)['x-kb-space']).toBe('sp_alice0123456789')
    expect(headersOf(1)['x-kb-space']).toBeUndefined()
  })
})

describe('accountRequest', () => {
  function capture(response: Response) {
    const spy = vi.fn(async () => response)
    globalThis.fetch = spy as unknown as typeof fetch
    return spy
  }
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers })

  it('JSON 请求带 CSRF 头和 content-type,成功时返回 data', async () => {
    const spy = capture(json(200, { ok: true, data: { display_name: '林一' } }))
    const result = await accountRequest<{ display_name: string }>('PATCH', '/api/v1/me/profile', { json: { display_name: '林一' } })
    expect(result).toEqual({ display_name: '林一' })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/me/profile')
    expect(init.method).toBe('PATCH')
    expect(init.credentials).toBe('same-origin')
    expect(init.headers).toEqual({ 'x-kb-csrf': '1', 'content-type': 'application/json' })
    expect(init.body).toBe('{"display_name":"林一"}')
  })

  it('上传图片:请求体是原始字节,类型是 octet-stream,不再套 JSON', async () => {
    const spy = capture(json(200, { ok: true, data: { avatar: 'usr_1-0123abcd.png' } }))
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    await accountRequest('PUT', '/api/v1/me/avatar', { bytes: blob })
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body).toBe(blob)
    expect(init.headers).toEqual({ 'x-kb-csrf': '1', 'content-type': 'application/octet-stream' })
  })

  it('没有请求体的请求(删除、取列表)不带 content-type', async () => {
    const spy = capture(json(200, { ok: true, data: {} }))
    await accountRequest('DELETE', '/api/v1/me/avatar')
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toEqual({ 'x-kb-csrf': '1' })
    expect(init.body).toBeUndefined()
  })

  it('失败时抛 AccountError:消息是服务端的话,并去掉「invalid input: 」这个给程序员看的前缀', async () => {
    capture(json(400, { ok: false, error: { code: 'invalid_input', message: 'invalid input: 只支持 PNG、JPEG、WebP、GIF 图片' } }))
    const error = await accountRequest('PUT', '/api/v1/me/avatar', { bytes: new Blob(['x']) }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AccountError)
    expect((error as AccountError).message).toBe('只支持 PNG、JPEG、WebP、GIF 图片')
    expect((error as AccountError).status).toBe(400)
  })

  it('限频时带上 Retry-After 秒数', async () => {
    capture(json(429, { ok: false, error: { message: '头像上传太频繁了,请一分钟后再试' } }, { 'retry-after': '60' }))
    const error = (await accountRequest('PUT', '/api/v1/me/avatar', { bytes: new Blob(['x']) }).catch((e: unknown) => e)) as AccountError
    expect(error.retryAfter).toBe(60)
    expect(error.message).toContain('太频繁')
  })

  it('框架直接返回的 413(没有 JSON 体)也有一句人话,不是「请求失败(413)」', async () => {
    capture(new Response('', { status: 413 }))
    const error = (await accountRequest('PUT', '/api/v1/me/avatar', { bytes: new Blob(['x']) }).catch((e: unknown) => e)) as AccountError
    expect(error.message).toBe('文件太大了')
    capture(new Response('<html>Bad Gateway</html>', { status: 502 }))
    const gateway = (await accountRequest('GET', '/api/v1/me/sessions').catch((e: unknown) => e)) as AccountError
    expect(gateway.message).toBe('请求失败(502)')
  })

  it('已登录接口遇到 401:回登录页并带上当前位置;公开接口的 401 不跳转', async () => {
    const location = { pathname: '/me', search: '?tab=security', href: '' }
    vi.stubGlobal('window', { location })
    try {
      capture(json(401, { ok: false, error: { message: '请先登录' } }))
      const error = (await accountRequest('GET', '/api/v1/me/sessions', { signedIn: true }).catch((e: unknown) => e)) as AccountError
      expect(error.status).toBe(401)
      expect(location.href).toBe('/login?next=%2Fme%3Ftab%3Dsecurity')
      // 已经在登录页就不要再跳(整页刷新会形成无限循环)
      location.href = ''
      location.pathname = '/login'
      await accountRequest('GET', '/api/v1/me/sessions', { signedIn: true }).catch(() => undefined)
      expect(location.href).toBe('')
      // 公开接口:不跳转,只抛错
      location.pathname = '/register'
      capture(json(401, { ok: false, error: { message: '验证码不对' } }))
      const publicError = (await accountRequest('POST', '/api/v1/auth/register', { json: {} }).catch((e: unknown) => e)) as AccountError
      expect(publicError.message).toBe('验证码不对')
      expect(location.href).toBe('')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
