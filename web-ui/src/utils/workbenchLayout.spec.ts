import { describe, expect, it } from 'vitest'
import { carryPaneState, inspectorDefaultOpen, inspectorDocks, workbenchLayout, type PaneContext } from './workbenchLayout'

const ctx = (patch: Partial<PaneContext> = {}): PaneContext => ({ mobileDetail: false, foldCollapsed: false, hasDoc: false, sidebarCollapsed: false, ...patch })

describe('workbenchLayout 按可用宽度分版面', () => {
  it('边界值:599/600、839/840', () => {
    expect(workbenchLayout(390)).toBe('single')
    expect(workbenchLayout(599)).toBe('single')
    expect(workbenchLayout(600)).toBe('two')
    expect(workbenchLayout(744)).toBe('two')
    expect(workbenchLayout(820)).toBe('two')
    expect(workbenchLayout(839)).toBe('two')
    expect(workbenchLayout(840)).toBe('full')
    expect(workbenchLayout(1180)).toBe('full')
    expect(workbenchLayout(1920)).toBe('full')
  })

  it('右侧栏并排的下限是 1024;默认展开只给平板档', () => {
    expect(inspectorDocks(1023)).toBe(false)
    expect(inspectorDocks(1024)).toBe(true)
    expect(inspectorDefaultOpen(844)).toBe(false) // 手机横屏:放不下三栏
    expect(inspectorDefaultOpen(1024)).toBe(true)
    expect(inspectorDefaultOpen(1180)).toBe(true)
    expect(inspectorDefaultOpen(1279)).toBe(true)
    expect(inspectorDefaultOpen(1280)).toBe(false) // 桌面:保持默认收起
    expect(inspectorDefaultOpen(1920)).toBe(false)
  })
})

describe('carryPaneState 跨档时带着「现在看的是哪一块」', () => {
  it('同档位不变', () => {
    expect(carryPaneState('two', 'two', ctx({ foldCollapsed: true, hasDoc: true }))).toEqual({ mobileDetail: false, foldCollapsed: true })
    expect(carryPaneState('single', 'single', ctx({ mobileDetail: true, hasDoc: true }))).toEqual({ mobileDetail: true, foldCollapsed: false })
  })

  it('进单栏:有文档就停在文档上(不论目录栏开没开),没有文档才是列表', () => {
    expect(carryPaneState('two', 'single', ctx({ hasDoc: true, foldCollapsed: true })).mobileDetail).toBe(true)
    expect(carryPaneState('two', 'single', ctx({ hasDoc: true, foldCollapsed: false })).mobileDetail).toBe(true)
    expect(carryPaneState('full', 'single', ctx({ hasDoc: true })).mobileDetail).toBe(true)
    expect(carryPaneState('two', 'single', ctx({ hasDoc: false })).mobileDetail).toBe(false)
    expect(carryPaneState('full', 'single', ctx({ hasDoc: false })).mobileDetail).toBe(false)
  })

  it('单栏 → 两栏:看着文档就收起目录栏让文档独占,看着列表就并排展开', () => {
    expect(carryPaneState('single', 'two', ctx({ hasDoc: true, mobileDetail: true })).foldCollapsed).toBe(true)
    expect(carryPaneState('single', 'two', ctx({ hasDoc: true, mobileDetail: false })).foldCollapsed).toBe(false)
    // 没有文档时目录栏必须开着,否则整屏空白
    expect(carryPaneState('single', 'two', ctx({ hasDoc: false, mobileDetail: true })).foldCollapsed).toBe(false)
  })

  it('宽屏 → 两栏:沿用宽屏里目录栏的开合(横竖屏转来转去不忽开忽合)', () => {
    expect(carryPaneState('full', 'two', ctx({ sidebarCollapsed: true })).foldCollapsed).toBe(true)
    expect(carryPaneState('full', 'two', ctx({ sidebarCollapsed: false })).foldCollapsed).toBe(false)
  })

  it('进宽屏:单栏的「看文档」标记清掉', () => {
    expect(carryPaneState('single', 'full', ctx({ mobileDetail: true, hasDoc: true })).mobileDetail).toBe(false)
    expect(carryPaneState('two', 'full', ctx({ foldCollapsed: true, hasDoc: true })).mobileDetail).toBe(false)
  })
})
