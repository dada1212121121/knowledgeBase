/** Grid Surface 出口：几何 / 选区 / 绘制 / 控制器分层导出 */
export { GridSurface } from './surface'
export { CsvGridAdapter } from './csv'
export type { GridAdapter, GridSurfaceOptions } from './surface'
export { GridGeometry } from './geometry'
export { paintGrid, columnLabel } from './painter'
export * from './types'

/** 注册表工厂：Host 动态 import 后直接 new；CSV 数据源从 mount 的首屏 request 建 */
import { GridSurface } from './surface'
export function createGridSurface(): GridSurface {
  return new GridSurface()
}
