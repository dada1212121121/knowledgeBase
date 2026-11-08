// 侧栏状态的合成规则:用户的选择 × 屏幕宽度 × 页面类型。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/prefs', () => ({ fetchPrefs: vi.fn(async () => ({})), savePrefs: vi.fn(async () => true) }))

import { defaultSidebar, nextInCycle, resolveSidebar, snapWidth, useNavStore } from './nav'
import { useUiStore } from './ui'
import { remeasureViewport } from '@/composables/useViewport'

function setWidth(width: number, height = 900) {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', height)
  remeasureViewport()
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  setWidth(1440)
})

describe('默认状态', () => {
  it('电脑和宽屏默认展开;平板、折叠屏是图标栏', () => {
    expect(defaultSidebar({ tier: 'desktop' })).toBe('expanded')
    expect(defaultSidebar({ tier: 'wide' })).toBe('expanded')
    expect(defaultSidebar({ tier: 'tablet' })).toBe('rail')
    expect(defaultSidebar({ tier: 'fold' })).toBe('rail')
  })
  it('外观里选了「图标栏」布局,默认才是图标栏', () => {
    expect(defaultSidebar({ tier: 'desktop', layout: 'rail' })).toBe('rail')
    expect(defaultSidebar({ tier: 'desktop', layout: 'sidebar' })).toBe('expanded')
  })
})

describe('resolveSidebar', () => {
  it('用户选过的优先于默认值', () => {
    expect(resolveSidebar({ stored: 'expanded', tier: 'desktop', overlay: false })).toBe('expanded')
    expect(resolveSidebar({ stored: 'hidden', tier: 'wide', overlay: false })).toBe('hidden')
    expect(resolveSidebar({ stored: 'rail', tier: 'desktop', overlay: false })).toBe('rail')
  })
  it('浮层档位里「展开」不当成常驻状态(否则一进页面导航就盖住内容)', () => {
    expect(resolveSidebar({ stored: 'expanded', tier: 'tablet', overlay: true })).toBe('rail')
    expect(resolveSidebar({ stored: 'hidden', tier: 'tablet', overlay: true })).toBe('hidden')
  })
})

describe('循环与吸附', () => {
  it('⌘B 的顺序:展开 → 图标栏 → 隐藏 → 展开', () => {
    expect(nextInCycle('expanded')).toBe('rail')
    expect(nextInCycle('rail')).toBe('hidden')
    expect(nextInCycle('hidden')).toBe('expanded')
  })
  it('拖动松手按宽度吸附', () => {
    expect(snapWidth(10)).toEqual({ state: 'hidden' })
    expect(snapWidth(39)).toEqual({ state: 'hidden' })
    expect(snapWidth(40)).toEqual({ state: 'rail' })
    expect(snapWidth(139)).toEqual({ state: 'rail' })
    expect(snapWidth(140)).toEqual({ state: 'expanded', width: 200 })
    expect(snapWidth(260)).toEqual({ state: 'expanded', width: 260 })
    expect(snapWidth(900)).toEqual({ state: 'expanded', width: 360 })
  })
})

describe('useNavStore', () => {
  it('电脑默认展开,宽度 240;⌘B 依次切换并被记住', () => {
    const nav = useNavStore()
    const ui = useUiStore()
    expect(nav.state).toBe('expanded')
    expect(nav.slotWidth).toBe(240)
    nav.cycle()
    expect(nav.state).toBe('rail')
    expect(nav.slotWidth).toBe(64)
    expect(ui.sidebar).toBe('rail')
    nav.cycle()
    expect(nav.state).toBe('hidden')
    expect(nav.slotWidth).toBe(0)
    nav.cycle()
    expect(nav.state).toBe('expanded')
  })

  it('进文档工作台不会自己收起;每个页面都能手动收起', () => {
    const nav = useNavStore()
    nav.workbench = true
    expect(nav.state).toBe('expanded')
    nav.toggle()
    expect(nav.state).toBe('rail')
    nav.cycle()
    expect(nav.state).toBe('hidden')
    nav.cycle()
    expect(nav.state).toBe('expanded')
    nav.cycle()
    expect(nav.state).toBe('rail')
    nav.cycle()
    expect(nav.state).toBe('hidden')
  })

  it('平板上「展开」是浮层:开合不写进偏好,也不占位', () => {
    setWidth(1000, 1300)
    const nav = useNavStore()
    const ui = useUiStore()
    expect(nav.overlayTier).toBe(true)
    expect(nav.state).toBe('rail')
    expect(nav.slotWidth).toBe(64)
    nav.toggle()
    expect(nav.overlayOpen).toBe(true)
    expect(nav.labelsVisible).toBe(true)
    expect(nav.slotWidth).toBe(64)
    expect(ui.sidebar).toBeNull()
    nav.cycle()
    expect(nav.overlayOpen).toBe(false)
    expect(ui.sidebar).toBeNull()
  })

  it('平板上用户选了「隐藏」会被记住,浮层仍可打开', () => {
    setWidth(1000, 1300)
    localStorage.setItem('kb.ui', JSON.stringify({ sidebar: 'hidden' }))
    setActivePinia(createPinia())
    const nav = useNavStore()
    expect(nav.state).toBe('hidden')
    expect(nav.slotWidth).toBe(0)
    nav.toggle()
    expect(nav.overlayOpen).toBe(true)
  })

  it('手机没有侧栏:操作无效、占位为 0', () => {
    setWidth(390, 844)
    const nav = useNavStore()
    const ui = useUiStore()
    expect(nav.hasSidebar).toBe(false)
    expect(nav.slotWidth).toBe(0)
    nav.cycle()
    nav.toggle()
    expect(ui.sidebar).toBeNull()
  })

  it('拖动:过程中占位随手移动,松手吸附并记住宽度', () => {
    const nav = useNavStore()
    const ui = useUiStore()
    nav.dragTo(180)
    expect(nav.slotWidth).toBe(180)
    expect(nav.labelsVisible).toBe(true)
    nav.dragTo(100)
    expect(nav.labelsVisible).toBe(false)
    nav.commitDrag(300)
    expect(nav.dragWidth).toBeNull()
    expect(ui.sidebarWidth).toBe(300)
    expect(nav.state).toBe('expanded')
    expect(nav.slotWidth).toBe(300)
    nav.commitDrag(90)
    expect(nav.state).toBe('rail')
    nav.commitDrag(5)
    expect(nav.state).toBe('hidden')
  })
})
