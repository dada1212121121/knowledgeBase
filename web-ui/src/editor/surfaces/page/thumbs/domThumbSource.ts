/**
 * 只读预览的缩略图后端（补全）：把 docx-preview 渲染好的那一页 DOM 缩小克隆一份
 *
 * 为什么是克隆 DOM 而不是截图 / 位图：
 * - 浏览器没有"把一段 DOM 画成位图"的同源安全途径：SVG foreignObject 要内联全部样式与字体，Safari 还会污染画布；
 *   也不能用 `blob:` Worker（页面 CSP 禁止）。克隆 DOM 零额外依赖，字体、图片、表格都与正文一模一样，CSP 无影响；
 * - 缩放用 CSS transform，侧栏尺寸变化（纵栏 ↔ 横条、窗口缩放）不需要重新生成；
 * - 只生成可见的几张（生成队列保证），其余不占 DOM；克隆在缓存里只留有限条。
 *
 * 克隆体的约束（都在 `cloneForThumbnail` 里落实）：
 * 1. **不能再是 `section.kbdocx`**：页面计数、页码、查找、`pageRect` 都按这个选择器取页，克隆体混进去会让「20 页」变成「40 页」。
 *    所以外壳换成 `div`，只保留 `kbdocx` 这个类名（docx-preview 的样式表按它限定后代选择器），
 *    原来写在 `section.kbdocx` 上的几条版式规则（纵向 flex、相对定位、裁切）在组件样式里照抄一份；
 * 2. **不能和正文抢 id / 锚点**：去掉全部 id、断开链接，SVG 里的引用（渐变 / 裁切）跟着改名；
 * 3. **不可交互**：`inert` + `aria-hidden`，读屏、Tab、选择、查找都碰不到它。
 */
import type { ThumbBox, ThumbSource } from './types'

export interface DomThumbOptions {
  /** 当前所有页的容器（每次生成时现取：文档重新渲染后元素会换） */
  pages(): readonly HTMLElement[]
  /** 第 `index` 页**未缩放**的版面尺寸（px）；量不到返回 null，按页面自己的内联宽度估 */
  naturalSize(index: number): { width: number; height: number } | null
  /** docx-preview 的类名（`kbdocx`） */
  className: string
}

const REMOVE_SELECTOR = 'script, iframe, object, embed, audio, video, style, link'
const REFERENCING_ATTRIBUTES = ['fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end', 'style']

/** SVG 内部的 id 引用（`url(#a)`、`href="#a"`）：克隆体里的 id 都被前缀改名，引用也要跟着改，否则渐变 / 裁切会失效 */
function remapSvgIds(root: HTMLElement, prefix: string): void {
  const renamed = new Map<string, string>()
  for (const element of root.querySelectorAll('svg [id]')) {
    const old = element.getAttribute('id') ?? ''
    if (!old) continue
    renamed.set(old, `${prefix}${old}`)
  }
  if (!renamed.size) return
  const rewrite = (value: string): string => value.replace(/url\(\s*#([^)\s]+)\s*\)/g, (whole, id: string) => (renamed.has(id) ? `url(#${renamed.get(id)})` : whole))
  for (const svg of root.querySelectorAll('svg')) {
    for (const element of [svg, ...svg.querySelectorAll('*')]) {
      for (const name of REFERENCING_ATTRIBUTES) {
        const value = element.getAttribute(name)
        if (value && value.includes('url(')) element.setAttribute(name, rewrite(value))
      }
      for (const name of ['href', 'xlink:href']) {
        const value = element.getAttribute(name)
        if (value?.startsWith('#') && renamed.has(value.slice(1))) element.setAttribute(name, `#${renamed.get(value.slice(1))}`)
      }
      const id = element.getAttribute('id')
      if (id && renamed.has(id)) element.setAttribute('id', renamed.get(id)!)
    }
  }
}

/** 把一页克隆成不可交互、不与正文冲突的缩略图外壳（导出供单测） */
export function cloneForThumbnail(section: HTMLElement, className: string, prefix = 'kbt-'): HTMLElement {
  const sheet = document.createElement('div')
  sheet.className = `${className} kb-pgt-sheet`
  sheet.style.cssText = section.style.cssText
  for (const child of Array.from(section.childNodes)) sheet.appendChild(child.cloneNode(true))
  for (const node of Array.from(sheet.querySelectorAll(REMOVE_SELECTOR))) node.remove()
  for (const element of sheet.querySelectorAll('[id]')) {
    // SVG 里的 id 先留着给 remapSvgIds 改名；其余的（书签等）直接去掉
    if (!element.closest('svg')) element.removeAttribute('id')
  }
  remapSvgIds(sheet, prefix)
  for (const anchor of sheet.querySelectorAll('a[href]')) anchor.removeAttribute('href')
  for (const element of sheet.querySelectorAll('[name], [tabindex], [contenteditable]')) {
    element.removeAttribute('name')
    element.removeAttribute('tabindex')
    element.removeAttribute('contenteditable')
  }
  for (const image of sheet.querySelectorAll('img')) {
    image.decoding = 'async'
    image.draggable = false
  }
  sheet.setAttribute('aria-hidden', 'true')
  sheet.setAttribute('inert', '')
  return sheet
}

export function createDomThumbSource(options: DomThumbOptions): ThumbSource {
  return {
    async render(index: number, box: ThumbBox, signal: AbortSignal): Promise<HTMLElement> {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError')
      const section = options.pages()[index]
      if (!section) throw new Error(`没有第 ${index + 1} 页`)
      const natural = options.naturalSize(index)
      const width = natural?.width || section.offsetWidth || 816
      const sheet = cloneForThumbnail(section, options.className)
      // 按盒子宽度缩小；版面保持未缩放时的大小，所以换行、分页与正文完全一致
      sheet.style.transformOrigin = 'top left'
      sheet.style.transform = `scale(${box.width / width})`
      const clip = document.createElement('span')
      clip.className = 'kb-pgt-clip'
      clip.style.width = `${box.width}px`
      clip.style.height = `${box.height}px`
      clip.appendChild(sheet)
      return clip
    },
  }
}
