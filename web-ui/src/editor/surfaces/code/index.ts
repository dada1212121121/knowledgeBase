/** Code Surface 出口：只导出工厂，CodeMirror 细节不对外 */
import type { SurfaceFactory } from '../registry'
import { CodeSurface } from './surface'

export { CodeSurface } from './surface'
export const createCodeSurface: SurfaceFactory = () => new CodeSurface()
