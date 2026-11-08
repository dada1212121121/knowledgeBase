/** PDF Surface 出口：只导出工厂与控制器 */
import type { SurfaceFactory } from '../registry'
import { PdfSurface } from './surface'

export { PdfSurface } from './surface'
export const createPdfSurface: SurfaceFactory = () => new PdfSurface()
