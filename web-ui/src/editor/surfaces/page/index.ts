/** Page Surface 出口：只导出工厂与控制器 */
import type { SurfaceFactory } from '../registry'
import { PageSurface } from './surface'

export { PageSurface } from './surface'
export const createPageSurface: SurfaceFactory = () => new PageSurface()
