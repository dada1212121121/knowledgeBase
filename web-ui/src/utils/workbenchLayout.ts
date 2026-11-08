// 知识库页(文档工作台)的版面判断:只看窗口的「可用宽度」,不看设备类型。
// iPad 分屏、桌面小窗口、手机横屏、折叠屏展开,都落在同一套规则里(设计规范与设计稿)。
//
//   single  < 600        手机:列表和文档分两屏,文档里有「返回列表」
//   two     600–839      小平板竖屏 / 折叠屏 / 分屏半宽:目录栏 + 文档两栏,目录栏可收起,选中文档后自动收起
//   full    ≥ 840        平板横屏 / 笔记本 / 桌面:目录栏 + 文档(+ 右侧栏)
//
// 档位下界直接引用 useViewport 的常量,断点只在一处定义。
import { TIER_MIN } from '@/composables/useViewport'

export type WorkbenchLayout = 'single' | 'two' | 'full'

export function workbenchLayout(width: number): WorkbenchLayout {
  if (width < TIER_MIN.fold) return 'single'
  if (width < TIER_MIN.tablet) return 'two'
  return 'full'
}

/**
 * 右侧栏(属性 / 评论 / 历史)是否并排占一栏。再窄就只能盖在文档上(浮层):
 * 1024 宽时导航图标栏 64 + 目录栏约 260 + 右侧栏约 290,文档还剩 400 左右,是能读的下限;
 * 840–1023 这一段(例如手机横屏)放不下三栏,做成浮层。
 */
export const INSPECTOR_DOCK_MIN = 1024
export const inspectorDocks = (width: number): boolean => width >= INSPECTOR_DOCK_MIN

/** 用户没表态过时,右侧栏是否默认展开:平板档(1024–1279)并排展开,让「目录 | 文档 | 右侧栏」三栏一进来就是三栏;桌面保持默认收起。 */
export function inspectorDefaultOpen(width: number): boolean {
  return inspectorDocks(width) && width < TIER_MIN.desktop
}

/** 与「窄」「宽」两个版面相关的、会随窗口变化而被带过去的状态。 */
export interface PaneState {
  /** 单栏版面下:正在看文档(而不是列表) */
  mobileDetail: boolean
  /** 两栏版面下:目录栏已收起 */
  foldCollapsed: boolean
}

export interface PaneContext extends PaneState {
  /** 有正在看的文档(含新建中、共享的文档) */
  hasDoc: boolean
  /** 宽屏版面里用户收起过目录栏(会记住) */
  sidebarCollapsed: boolean
}

/**
 * 窗口宽度跨档(旋转、分屏、拖窗口)时,把「现在看到的是哪一块」带到新版面里,
 * 绝不能让正在看或正在编辑的文档凭空消失。文档组件一直挂着不卸载,这里只管哪一栏显示:
 *   - 进单栏:有文档就停在文档上(正在编辑的更不能被一屏列表盖掉),没有文档才是列表;
 *   - 单栏进两栏:原来看着文档就把目录栏收起(文档独占),看着列表就并排展开;
 *   - 宽屏进两栏:沿用宽屏里目录栏的开合,横竖屏转来转去不会忽开忽合。
 */
export function carryPaneState(prev: WorkbenchLayout, next: WorkbenchLayout, ctx: PaneContext): PaneState {
  if (prev === next) return { mobileDetail: ctx.mobileDetail, foldCollapsed: ctx.foldCollapsed }
  if (next === 'single') {
    return { mobileDetail: ctx.hasDoc, foldCollapsed: ctx.foldCollapsed }
  }
  if (next === 'two') {
    const collapsed = prev === 'single' ? ctx.hasDoc && ctx.mobileDetail : ctx.sidebarCollapsed
    return { mobileDetail: false, foldCollapsed: collapsed }
  }
  // 进宽屏:目录栏的开合归用户保存的偏好管;单栏的「看文档」标记用不着了
  return { mobileDetail: false, foldCollapsed: ctx.foldCollapsed }
}
