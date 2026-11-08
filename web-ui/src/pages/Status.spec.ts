// 404 页与服务不可用页。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

const authStatus = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  authStatus: (...args: unknown[]) => authStatus(...args),
}))
const push = vi.fn()
const replace = vi.fn(async () => undefined)
const back = vi.fn()
const route = reactive<{ fullPath: string; query: Record<string, string> }>({ fullPath: '/no/such', query: {} })
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push, replace, back }) }))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))

import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import NotFound from './NotFound.vue'
import Unavailable from './Unavailable.vue'

const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
let wrapper: VueWrapper | null = null
const setOnline = (value: boolean) => Object.defineProperty(navigator, 'onLine', { value, configurable: true })

beforeEach(() => {
  vi.useFakeTimers()
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  authStatus.mockReset()
  push.mockClear()
  replace.mockClear()
  back.mockClear()
  route.fullPath = '/no/such'
  route.query = {}
  setOnline(true)
  setActivePinia(createPinia())
})
afterEach(() => vi.useRealTimers())

describe('NotFound 404', () => {
  function open(features: string[], historyLength = 3) {
    const session = useSessionStore()
    session.features = new Set(features)
    session.loaded = true
    Object.defineProperty(window.history, 'length', { value: historyLength, configurable: true })
    wrapper = mount(NotFound, { attachTo: document.body })
  }

  it('说清楚找不到,显示出错的地址,有「回首页」', async () => {
    open(['search.basic'])
    route.fullPath = '/kb/oops?x=1'
    await flushPromises()
    expect($('[data-testid=not-found]')!.textContent).toContain('找不到这个页面')
    expect($('[data-testid=nf-path]')!.textContent).toBe('/kb/oops?x=1')
    $<HTMLButtonElement>('[data-testid=nf-home]')!.click()
    expect(push).toHaveBeenCalledWith('/home')
  })

  it('有搜索权限才给「去搜索」;有上一页才给「返回上一页」', async () => {
    open([], 1)
    expect($('[data-testid=nf-search]')).toBeNull()
    expect($('[data-testid=nf-back]')).toBeNull()
    wrapper!.unmount()
    document.body.innerHTML = ''
    open(['search.basic'], 3)
    expect($('[data-testid=nf-search]')).not.toBeNull()
    $<HTMLButtonElement>('[data-testid=nf-back]')!.click()
    expect(back).toHaveBeenCalled()
  })

  it('地址里的内容当文字显示,不会当 HTML 渲染', async () => {
    open([])
    route.fullPath = '/<img src=x onerror=alert(1)>'
    await flushPromises()
    expect($('[data-testid=nf-path]')!.querySelector('img')).toBeNull()
    expect($('[data-testid=nf-path]')!.textContent).toContain('<img')
  })
})

describe('Unavailable 服务不可用页', () => {
  function open(query: Record<string, string> = {}) {
    route.query = query
    wrapper = mount(Unavailable, { attachTo: document.body })
  }
  const kindOf = () => $('[data-testid=unavailable]')!.getAttribute('data-kind')

  it('按地址里的原因显示对应的话;不认识的原因当「连不上」', async () => {
    open({ kind: 'maintenance' })
    expect($('[data-testid=unavailable]')!.textContent).toContain('服务正在维护')
    wrapper!.unmount()
    document.body.innerHTML = ''
    open({ kind: 'bogus' })
    expect(kindOf()).toBe('network')
    expect($('[data-testid=unavailable]')!.textContent).toContain('连不上服务器')
  })

  it('点「重试」:服务通了就回到原来的页面', async () => {
    authStatus.mockResolvedValue({ logged_in: true })
    open({ kind: 'maintenance', next: '/kb?item=x' })
    $<HTMLButtonElement>('[data-testid=unavail-retry]')!.click()
    await flushPromises()
    expect(replace).toHaveBeenCalledWith('/kb?item=x')
  })

  it('回去的地址不是站内路径(开放重定向)就回首页', async () => {
    authStatus.mockResolvedValue({ logged_in: true })
    open({ kind: 'network', next: '//evil.com' })
    $<HTMLButtonElement>('[data-testid=unavail-retry]')!.click()
    await flushPromises()
    expect(replace).toHaveBeenCalledWith('/home')
  })

  it('重试还是不通:记下次数,并按这次的状态码更新原因(503→维护中,500→服务出错)', async () => {
    authStatus.mockRejectedValue(new CapabilityError('auth/status 500', 'unavailable', 500))
    open({ kind: 'maintenance' })
    $<HTMLButtonElement>('[data-testid=unavail-retry]')!.click()
    await flushPromises()
    expect(replace).not.toHaveBeenCalled()
    expect(kindOf()).toBe('server')
    expect($('[data-testid=unavail-attempts]')!.textContent).toContain('已重试 1 次')
  })

  it('会自动重试:先 3 秒、再 6 秒(先快后慢);恢复后自己回去', async () => {
    authStatus.mockRejectedValueOnce(new CapabilityError('auth/status 503', 'unavailable', 503)).mockResolvedValue({ logged_in: true })
    open({ kind: 'maintenance', next: '/home' })
    expect(authStatus).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(authStatus).toHaveBeenCalledTimes(1) // 3 秒后第一次自动重试,失败
    await vi.advanceTimersByTimeAsync(5_000)
    expect(authStatus).toHaveBeenCalledTimes(1) // 第二次要等 6 秒
    await vi.advanceTimersByTimeAsync(1_000)
    expect(authStatus).toHaveBeenCalledTimes(2)
    expect(replace).toHaveBeenCalledWith('/home')
  })

  it('设备没网:不自动重试(没网重试没有意义);网络回来(online 事件)马上试', async () => {
    authStatus.mockResolvedValue({ logged_in: true })
    setOnline(false)
    open({ kind: 'network', next: '/search' })
    expect(kindOf()).toBe('offline')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(authStatus).not.toHaveBeenCalled()
    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await flushPromises()
    expect(replace).toHaveBeenCalledWith('/search')
  })

  it('页面上正在看的时候断网(offline 事件):改成「设备离线」并停止自动重试', async () => {
    open({ kind: 'maintenance' })
    window.dispatchEvent(new Event('offline'))
    await flushPromises()
    expect(kindOf()).toBe('offline')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(authStatus).not.toHaveBeenCalled()
  })

  it('离开页面后不再重试', async () => {
    open({ kind: 'maintenance' })
    wrapper!.unmount()
    wrapper = null
    await vi.advanceTimersByTimeAsync(60_000)
    expect(authStatus).not.toHaveBeenCalled()
  })

  it('正在重试时,定时器或 online 事件再触发也不会发第二个请求(按钮置灰只挡得住手点)', async () => {
    let resolve: (value: unknown) => void = () => undefined
    authStatus.mockImplementation(() => new Promise((r) => (resolve = r)))
    open({ kind: 'network' })
    const button = $<HTMLButtonElement>('[data-testid=unavail-retry]')!
    button.click()
    await flushPromises()
    expect(button.disabled).toBe(true)
    window.dispatchEvent(new Event('online')) // 网络恢复的事件恰好在请求进行中到来
    await vi.advanceTimersByTimeAsync(10_000) // 自动重试的定时器也到期了
    await flushPromises()
    expect(authStatus).toHaveBeenCalledTimes(1)
    resolve({ logged_in: true })
    await flushPromises()
    expect(replace).toHaveBeenCalledTimes(1)
  })
})
