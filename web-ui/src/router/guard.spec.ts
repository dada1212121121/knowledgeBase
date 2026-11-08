// 路由守卫:没登录 → 登录页;连不上服务 / 服务出错 → 服务不可用页(以前一律扔去登录页);公开页不查登录。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const authStatus = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  authStatus: (...args: unknown[]) => authStatus(...args),
}))

import { CapabilityError } from '@/api/client'
import { forgetAuth, router } from './index'

const setOnline = (value: boolean) => Object.defineProperty(navigator, 'onLine', { value, configurable: true })

async function go(path: string) {
  await router.push(path).catch(() => undefined)
  await router.isReady()
  return router.currentRoute.value
}

beforeEach(async () => {
  setActivePinia(createPinia()) // 守卫里读会话 store(两步验证拦截)
  authStatus.mockReset()
  forgetAuth()
  setOnline(true)
  // 先站到一个公开页上,让每个用例都是一次全新的导航
  await router.replace('/login').catch(() => undefined)
})

describe('路由守卫', () => {
  it('已登录:放行', async () => {
    authStatus.mockResolvedValue({ logged_in: true })
    expect((await go('/home')).path).toBe('/home')
  })

  it('没登录:去登录页,并带上要去的地址', async () => {
    authStatus.mockResolvedValue({ logged_in: false })
    const route = await go('/kb?collection=a')
    expect(route.path).toBe('/login')
    expect(route.query.next).toBe('/kb?collection=a')
  })

  it('服务返回 503(维护中):去服务不可用页,原因是 maintenance,带上要去的地址——不再扔去登录页', async () => {
    authStatus.mockRejectedValue(new CapabilityError('auth/status 503', 'unavailable', 503))
    const route = await go('/kb?item=x')
    expect(route.path).toBe('/unavailable')
    expect(route.query).toMatchObject({ kind: 'maintenance', next: '/kb?item=x' })
  })

  it('服务返回 500:原因是 server', async () => {
    authStatus.mockRejectedValue(new CapabilityError('auth/status 500', 'unavailable', 500))
    expect((await go('/home')).query.kind).toBe('server')
  })

  it('请求根本发不出去(没有状态码):原因是 network;设备没网则是 offline', async () => {
    authStatus.mockRejectedValue(new TypeError('Failed to fetch'))
    expect((await go('/home')).query.kind).toBe('network')
    forgetAuth()
    setOnline(false)
    expect((await go('/search')).query.kind).toBe('offline')
  })

  it('公开页(登录、服务不可用页本身)不查登录状态,所以服务挂了也能打开', async () => {
    authStatus.mockRejectedValue(new CapabilityError('auth/status 503', 'unavailable', 503))
    expect((await go('/unavailable?kind=maintenance')).path).toBe('/unavailable')
    expect((await go('/login')).path).toBe('/login')
    expect(authStatus).not.toHaveBeenCalled()
  })

  it('登录状态缓存期内不重复查,忘掉缓存后才再查', async () => {
    authStatus.mockResolvedValue({ logged_in: true })
    await go('/home')
    await go('/search')
    expect(authStatus).toHaveBeenCalledTimes(1)
    forgetAuth()
    await go('/kb')
    expect(authStatus).toHaveBeenCalledTimes(2)
  })
})

describe('404 兜底路由', () => {
  it('认不出的地址落到 not-found,保留原始地址;已有页面和旧地址重定向不受影响', async () => {
    authStatus.mockResolvedValue({ logged_in: true })
    const lost = await go('/no/such/page?x=1')
    expect(lost.name).toBe('not-found')
    expect(lost.fullPath).toBe('/no/such/page?x=1')
    expect((await go('/dashboard')).path).toBe('/admin/overview') // 旧地址还是重定向
    expect((await go('/tasks')).name).toBe('tasks')
  })
})
