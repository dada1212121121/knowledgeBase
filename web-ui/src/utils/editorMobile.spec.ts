// 手机上的编辑器:工具栏贴键盘 / 菜单走底部面板的判断,以及光标滚动量。
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCROLL_MARGIN,
  DOCK_GAP,
  bottomReserve,
  caretScrollDelta,
  menusAsSheet,
  scrollMarginBottom,
  shouldDockToolbar,
} from './editorMobile'

describe('shouldDockToolbar', () => {
  it('手机竖屏:键盘打开才贴,收起回到顶部', () => {
    expect(shouldDockToolbar({ keyboardOpen: true, width: 390, screenShortSide: 390 })).toBe(true)
    expect(shouldDockToolbar({ keyboardOpen: false, width: 390, screenShortSide: 390 })).toBe(false)
  })

  it('手机横屏(844×390):视口宽 ≥ 600,但屏幕短边 < 500,键盘打开时同样贴', () => {
    expect(shouldDockToolbar({ keyboardOpen: true, width: 844, screenShortSide: 390 })).toBe(true)
  })

  it('平板和桌面保持现状:键盘打开也不贴', () => {
    expect(shouldDockToolbar({ keyboardOpen: true, width: 820, screenShortSide: 820 })).toBe(false)
    expect(shouldDockToolbar({ keyboardOpen: true, width: 1180, screenShortSide: 820 })).toBe(false)
    expect(shouldDockToolbar({ keyboardOpen: true, width: 1440, screenShortSide: 900 })).toBe(false)
  })

  it('折叠屏展开(673×841)属于 600–839 档,不当手机', () => {
    expect(shouldDockToolbar({ keyboardOpen: true, width: 673, screenShortSide: 673 })).toBe(false)
  })

  it('边界:宽度 599 是手机、600 不是;屏幕短边 499 是手机、500 不是', () => {
    expect(shouldDockToolbar({ keyboardOpen: true, width: 599, screenShortSide: 900 })).toBe(true)
    expect(shouldDockToolbar({ keyboardOpen: true, width: 600, screenShortSide: 900 })).toBe(false)
    expect(shouldDockToolbar({ keyboardOpen: true, width: 900, screenShortSide: 499 })).toBe(true)
    expect(shouldDockToolbar({ keyboardOpen: true, width: 900, screenShortSide: 500 })).toBe(false)
  })

  it('取不到 screen(老环境 / 测试)时传 Infinity,只按宽度判断', () => {
    expect(shouldDockToolbar({ keyboardOpen: true, width: 390, screenShortSide: Number.POSITIVE_INFINITY })).toBe(true)
    expect(shouldDockToolbar({ keyboardOpen: true, width: 1200, screenShortSide: Number.POSITIVE_INFINITY })).toBe(false)
  })

  it('安卓平板横屏:软键盘把布局视口压矮也不贴(判断用的是屏幕短边,不是视口高度)', () => {
    // 1180×820 的平板,键盘弹出后 innerHeight 只剩 420,但 width 仍是 1180、screen 短边 820
    expect(shouldDockToolbar({ keyboardOpen: true, width: 1180, screenShortSide: 820 })).toBe(false)
  })
})

describe('menusAsSheet', () => {
  it('手机宽度总是底部面板', () => {
    expect(menusAsSheet({ width: 390, coarse: true })).toBe(true)
    expect(menusAsSheet({ width: 390, coarse: false })).toBe(true)
    expect(menusAsSheet({ width: 599, coarse: false })).toBe(true)
  })

  it('触屏平板也是底部面板(软键盘会盖住光标下方的浮层)', () => {
    expect(menusAsSheet({ width: 820, coarse: true })).toBe(true)
    expect(menusAsSheet({ width: 1180, coarse: true })).toBe(true)
  })

  it('有鼠标的桌面 / 笔记本保持跟随光标的浮层', () => {
    expect(menusAsSheet({ width: 600, coarse: false })).toBe(false)
    expect(menusAsSheet({ width: 1440, coarse: false })).toBe(false)
  })
})

describe('bottomReserve / scrollMarginBottom', () => {
  it('贴了键盘的工具栏盖住多高就留多高;没贴是 0', () => {
    expect(bottomReserve({ docked: true, barHeight: 55.6 })).toBe(56)
    expect(bottomReserve({ docked: false, barHeight: 55 })).toBe(0)
  })

  it('量不到高度(0 / 负数)时不留', () => {
    expect(bottomReserve({ docked: true, barHeight: 0 })).toBe(0)
    expect(bottomReserve({ docked: true, barHeight: -3 })).toBe(0)
  })

  it('ProseMirror 的底部滚动余量:没贴是默认值,贴了要加上工具栏高度和空隙', () => {
    expect(scrollMarginBottom(0)).toBe(DEFAULT_SCROLL_MARGIN)
    expect(scrollMarginBottom(56)).toBe(56 + DOCK_GAP)
  })
})

describe('caretScrollDelta', () => {
  // 手机竖屏:键盘 338,可视高度 506;工具栏 56 贴在键盘上 → 可见区 [0, 506 − 56]
  const base = { viewTop: 0, viewBottom: 506, reserveBottom: 56 }

  it('光标在可见区里:不滚', () => {
    expect(caretScrollDelta({ ...base, caret: { top: 200, bottom: 224 } })).toBe(0)
  })

  it('光标被键盘后面的工具栏盖住:往上滚到可见区正中', () => {
    // 光标行在 470–494:在工具栏(450–506)后面
    const delta = caretScrollDelta({ ...base, caret: { top: 470, bottom: 494 } })
    expect(delta).toBeGreaterThan(0)
    // 滚完光标中心应在可见区 [8, 442] 的正中 225
    expect(Math.round((470 + 494) / 2 - delta)).toBe(225)
  })

  it('光标刚好贴着工具栏上沿(留出空隙以内)也要滚', () => {
    const touching = caretScrollDelta({ ...base, caret: { top: 420, bottom: 450 } })
    expect(touching).toBeGreaterThan(0)
  })

  it('光标在顶部看不见:往下滚(返回负数)', () => {
    const delta = caretScrollDelta({ ...base, caret: { top: -40, bottom: -16 } })
    expect(delta).toBeLessThan(0)
  })

  it('没有工具栏(reserve 0):可见区一直到键盘上沿', () => {
    expect(caretScrollDelta({ viewTop: 0, viewBottom: 506, reserveBottom: 0, caret: { top: 460, bottom: 484 } })).toBe(0)
    expect(caretScrollDelta({ viewTop: 0, viewBottom: 506, reserveBottom: 0, caret: { top: 490, bottom: 514 } })).toBeGreaterThan(0)
  })

  it('横屏键盘弹出后只剩很小的可见区:光标行比可见区还高时对齐上沿,不来回抖', () => {
    // 可视高度 195,工具栏 48:可见区 [8, 139] = 131 高;光标行 140 高
    const delta = caretScrollDelta({ viewTop: 0, viewBottom: 195, reserveBottom: 48, caret: { top: 150, bottom: 290 } })
    expect(delta).toBe(142)
  })

  it('可见区被工具栏占满(量出来为负):不滚,免得无限滚动', () => {
    expect(caretScrollDelta({ viewTop: 0, viewBottom: 60, reserveBottom: 56, caret: { top: 10, bottom: 30 } })).toBe(0)
  })

  it('滚动容器自己不在视口顶部(viewTop > 0):按它的上沿算', () => {
    // 容器 [100, 606],光标在 120–144:离上沿 20,大于空隙 8 → 不滚
    expect(caretScrollDelta({ viewTop: 100, viewBottom: 606, reserveBottom: 56, caret: { top: 120, bottom: 144 } })).toBe(0)
    expect(caretScrollDelta({ viewTop: 100, viewBottom: 606, reserveBottom: 56, caret: { top: 102, bottom: 126 } })).toBeLessThan(0)
  })
})
