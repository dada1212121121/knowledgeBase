import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { looksLikeEmail, useEmailCode } from './useEmailCode'

function mountHook(purpose: 'register' | 'reset') {
  let api!: ReturnType<typeof useEmailCode>
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useEmailCode(purpose)
        return () => h('div')
      },
    }),
  )
  return { api, wrapper }
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }))
}

describe('useEmailCode', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('邮箱格式不对时不发请求', async () => {
    const fetchMock = respond(200, {})
    vi.stubGlobal('fetch', fetchMock)
    const { api } = mountHook('register')
    expect(looksLikeEmail('user@example.com')).toBe(true)
    expect(looksLikeEmail('lin@')).toBe(false)
    expect(await api.send('not-an-email')).toBe(false)
    expect(api.error.value).toBe('请输入正确的邮箱地址')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('发送成功后开始倒计时,倒计时内不能重复发送', async () => {
    const fetchMock = respond(200, { data: { sent: true, wait_secs: 60, ttl_minutes: 10 } })
    vi.stubGlobal('fetch', fetchMock)
    const { api } = mountHook('register')
    expect(api.buttonLabel.value).toBe('获取验证码')
    expect(await api.send(' user@example.com ')).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/auth/email-code')
    expect(JSON.parse(init.body as string)).toEqual({ email: 'user@example.com', purpose: 'register' })
    expect((init.headers as Record<string, string>)['x-kb-csrf']).toBe('1')
    expect(api.notice.value).toContain('user@example.com')
    expect(api.remaining.value).toBe(60)
    expect(api.buttonLabel.value).toBe('60 秒后重发')
    expect(await api.send('user@example.com')).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(api.remaining.value).toBe(0)
    expect(api.buttonLabel.value).toBe('重新发送')
  })

  it('被限频时显示服务端的话,并按 Retry-After 倒计时', async () => {
    vi.stubGlobal(
      'fetch',
      respond(429, { error: { message: '请 42 秒后再获取验证码' } }, { 'retry-after': '42' }),
    )
    const { api } = mountHook('reset')
    expect(await api.send('user@example.com')).toBe(false)
    expect(api.error.value).toBe('请 42 秒后再获取验证码')
    expect(api.remaining.value).toBe(42)
  })

  it('其它错误只显示提示,不开始倒计时', async () => {
    vi.stubGlobal('fetch', respond(503, { error: { message: '邮箱功能暂未开放,请联系管理员' } }))
    const { api } = mountHook('register')
    expect(await api.send('user@example.com')).toBe(false)
    expect(api.error.value).toBe('邮箱功能暂未开放,请联系管理员')
    expect(api.remaining.value).toBe(0)
  })

  it('断网:不显示浏览器的英文 Failed to fetch,说连不上并让人检查网络', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const { api } = mountHook('register')
    expect(await api.send('user@example.com')).toBe(false)
    expect(api.error.value).toContain('连不上服务器')
    expect(api.error.value).not.toContain('Failed to fetch')
    expect(api.remaining.value).toBe(0)
  })

  it('服务端没给原因(网关 502,响应体不是 JSON):不露状态码,告诉人下一步', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 })))
    const { api } = mountHook('register')
    expect(await api.send('user@example.com')).toBe(false)
    expect(api.error.value).not.toContain('502')
    expect(api.error.value).toContain('请稍后再试')
  })
})
