// 界面偏好 store:本地先渲染、登录后服务端覆盖、防抖写回、失败静默、不冲掉别的键。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const fetchPrefs = vi.fn()
const savePrefs = vi.fn()
vi.mock('@/api/prefs', () => ({ fetchPrefs: (...args: unknown[]) => fetchPrefs(...args), savePrefs: (...args: unknown[]) => savePrefs(...args) }))

import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampSidebarWidth, sanitizeUi, useUiStore } from './ui'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-ui-density')
  fetchPrefs.mockReset()
  savePrefs.mockReset()
  savePrefs.mockResolvedValue(true)
  setActivePinia(createPinia())
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('sanitizeUi', () => {
  it('只认合法的值,不认识的键和值丢掉', () => {
    expect(sanitizeUi({ sidebar: 'rail', sidebarWidth: 300, density: 'compact', extra: 1 })).toEqual({ sidebar: 'rail', sidebarWidth: 300, density: 'compact' })
    expect(sanitizeUi({ sidebar: 'collapsed', density: 'dense', sidebarWidth: 'wide' })).toEqual({})
    expect(sanitizeUi(null)).toEqual({})
    expect(sanitizeUi('x')).toEqual({})
  })
  it('宽度被夹在范围内', () => {
    expect(sanitizeUi({ sidebarWidth: 10 }).sidebarWidth).toBe(SIDEBAR_MIN)
    expect(sanitizeUi({ sidebarWidth: 9999 }).sidebarWidth).toBe(SIDEBAR_MAX)
    expect(clampSidebarWidth(250.4)).toBe(250)
  })
})

describe('useUiStore', () => {
  it('先读 localStorage 立即渲染:没选过侧栏就是 null,密度默认舒适并写到 <html>', () => {
    const ui = useUiStore()
    expect(ui.sidebar).toBeNull()
    expect(ui.sidebarWidth).toBe(SIDEBAR_DEFAULT)
    expect(ui.density).toBe('comfortable')
    expect(document.documentElement.getAttribute('data-ui-density')).toBe('comfortable')
  })

  it('本地已有选择就用本地的', () => {
    localStorage.setItem('kb.ui', JSON.stringify({ sidebar: 'hidden', sidebarWidth: 280, density: 'compact' }))
    setActivePinia(createPinia())
    const ui = useUiStore()
    expect(ui.sidebar).toBe('hidden')
    expect(ui.sidebarWidth).toBe(280)
    expect(ui.density).toBe('compact')
    expect(document.documentElement.getAttribute('data-ui-density')).toBe('compact')
  })

  it('localStorage 里是坏数据时回到默认,不抛错', () => {
    localStorage.setItem('kb.ui', '{not json')
    setActivePinia(createPinia())
    expect(useUiStore().sidebar).toBeNull()
  })

  it('变更立刻写本地,500ms 防抖后整体 PUT,并带上服务端的其它键', async () => {
    fetchPrefs.mockResolvedValue({ theme: 'dark', other: { a: 1 } })
    const ui = useUiStore()
    ui.setSidebar('rail')
    expect(JSON.parse(localStorage.getItem('kb.ui')!).sidebar).toBe('rail')
    ui.setSidebarWidth(300)
    await vi.advanceTimersByTimeAsync(499)
    expect(savePrefs).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(savePrefs).toHaveBeenCalledTimes(1)
    const sent = savePrefs.mock.calls[0]![0] as Record<string, unknown>
    // 整体替换:别的键必须原样带回,否则会冲掉别的功能存的偏好
    expect(sent.theme).toBe('dark')
    expect(sent.other).toEqual({ a: 1 })
    expect(sent.ui).toEqual({ sidebarWidth: 300, density: 'comfortable', sidebar: 'rail' })
  })

  it('连续变更只发一次请求(防抖合并)', async () => {
    fetchPrefs.mockResolvedValue({})
    const ui = useUiStore()
    ui.setSidebar('rail')
    await vi.advanceTimersByTimeAsync(300)
    ui.setSidebar('hidden')
    await vi.advanceTimersByTimeAsync(300)
    ui.setDensity('compact')
    await vi.advanceTimersByTimeAsync(600)
    expect(savePrefs).toHaveBeenCalledTimes(1)
    expect((savePrefs.mock.calls[0]![0] as { ui: unknown }).ui).toMatchObject({ sidebar: 'hidden', density: 'compact' })
  })

  it('取不到服务端偏好时不写(宁可不写也不冲掉别的键),本地照常记住', async () => {
    fetchPrefs.mockResolvedValue(null)
    const ui = useUiStore()
    ui.setSidebar('rail')
    await vi.advanceTimersByTimeAsync(600)
    expect(savePrefs).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('kb.ui')!).sidebar).toBe('rail')
  })

  it('写失败静默:不抛错,下一次变更还会重试', async () => {
    fetchPrefs.mockResolvedValue({})
    savePrefs.mockResolvedValueOnce(false)
    const ui = useUiStore()
    ui.setSidebar('rail')
    await vi.advanceTimersByTimeAsync(600)
    expect(savePrefs).toHaveBeenCalledTimes(1)
    ui.setSidebar('hidden')
    await vi.advanceTimersByTimeAsync(600)
    expect(savePrefs).toHaveBeenCalledTimes(2)
  })

  it('登录后服务端的 ui 覆盖本地,并同步回本地存储和 <html>', async () => {
    localStorage.setItem('kb.ui', JSON.stringify({ sidebar: 'expanded', density: 'comfortable' }))
    setActivePinia(createPinia())
    fetchPrefs.mockResolvedValue({ ui: { sidebar: 'hidden', sidebarWidth: 320, density: 'compact' } })
    const ui = useUiStore()
    await ui.syncFromServer()
    expect(ui.sidebar).toBe('hidden')
    expect(ui.sidebarWidth).toBe(320)
    expect(ui.density).toBe('compact')
    expect(document.documentElement.getAttribute('data-ui-density')).toBe('compact')
    expect(JSON.parse(localStorage.getItem('kb.ui')!).sidebar).toBe('hidden')
    // 只是读取,不该触发回写
    await vi.advanceTimersByTimeAsync(600)
    expect(savePrefs).not.toHaveBeenCalled()
  })

  it('服务端没有 ui、本地有选择:把本地的推上去(换设备时能带过去)', async () => {
    localStorage.setItem('kb.ui', JSON.stringify({ sidebar: 'rail' }))
    setActivePinia(createPinia())
    fetchPrefs.mockResolvedValue({ theme: 'light' })
    const ui = useUiStore()
    await ui.syncFromServer()
    await vi.advanceTimersByTimeAsync(600)
    expect(savePrefs).toHaveBeenCalledTimes(1)
    expect((savePrefs.mock.calls[0]![0] as Record<string, unknown>).theme).toBe('light')
  })

  it('服务端偏好读取失败时保持本地值', async () => {
    localStorage.setItem('kb.ui', JSON.stringify({ sidebar: 'rail' }))
    setActivePinia(createPinia())
    fetchPrefs.mockResolvedValue(null)
    const ui = useUiStore()
    await ui.syncFromServer()
    expect(ui.sidebar).toBe('rail')
  })

  it('服务端传来的坏值被洗掉,不会把外壳弄坏', async () => {
    fetchPrefs.mockResolvedValue({ ui: { sidebar: 'sideways', sidebarWidth: -5, density: 42 } })
    const ui = useUiStore()
    await ui.syncFromServer()
    expect(ui.sidebar).toBeNull()
    expect(ui.sidebarWidth).toBe(SIDEBAR_MIN)
    expect(ui.density).toBe('comfortable')
  })

  it('flush 立即发出待写内容(页面切到后台时用)', async () => {
    fetchPrefs.mockResolvedValue({})
    const ui = useUiStore()
    ui.setSidebar('rail')
    await ui.flush({ keepalive: true })
    expect(savePrefs).toHaveBeenCalledTimes(1)
    expect(savePrefs.mock.calls[0]![1]).toEqual({ keepalive: true })
  })
})
