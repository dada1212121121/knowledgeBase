/**
 * 内置内容面注册
 *
 * 为什么集中注册而不是在 Host 里 switch：
 * 1. Host 一旦静态 import TextSurface，ProseMirror 就会进首屏 bundle， 的 ≤ 500 ms 直接失守；
 *    注册表里每个 loader 都是动态 import，只有真正要打开该格式时才下载对应 chunk。
 * 2. 未注册的格式返回 null（合法中性态「尚未接入」），与加载失败区分开，
 *    这样每种格式落地时可以只注册自己那一种，其余格式不报错。
 */
import { registerSurface } from './registry'

let registered = false

/** 注册当前已落地的内置内容面；重复调用无副作用 */
export function registerBuiltinSurfaces(): void {
  if (registered) return
  registered = true
  // 文本面、代码面 / PDF 面、分页文档面、幻灯片面
  registerSurface('text', async () => (await import('./text')).createTextSurface)
  registerSurface('code', async () => (await import('./code')).createCodeSurface)
  registerSurface('pdf', async () => (await import('./pdf')).createPdfSurface)
  // 分页文档：目前只有 docx 只读；doc / odt / rtf / wps 仍走旧的转换预览，不经这里
  registerSurface('page', async () => (await import('./page')).createPageSurface)
  // 幻灯片：外壳 + 缩略图 / 备注 / 放映；渲染后端按任务卡接入（pptx）
  registerSurface('slide', async () => (await import('./slide')).createSlideSurface)
  // 表格有两种完全不同的绘制模型：CSV 是单元格矩阵，XLSX 是视口帧；按格式分 chunk，CSV 不带引擎
  registerSurface('grid', async (format) =>
    format?.toLowerCase() === 'xlsx'
      ? (await import('./grid/xlsxSurface')).createXlsxReadSurface
      : (await import('./grid')).createGridSurface,
  )
}

/** 仅供测试：允许重新注册 */
export function resetBuiltinSurfaces(): void {
  registered = false
}
