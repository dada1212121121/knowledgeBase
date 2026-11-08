/** Slide Surface 出口：只导出工厂与控制器 */
import type { SurfaceFactory } from '../registry'
import { createPptxReadLoader } from './pptx-read'
import { SlideSurface } from './surface'

export { SlideSurface } from './surface'
export type { SlideLoaderFactory } from './surface'

/** 默认工厂：只读渲染（引擎在打开时才动态加载，见 pptx-read.ts） */
export const createSlideSurface: SurfaceFactory = () => new SlideSurface(createPptxReadLoader)
