/**
 * docx 只读渲染后端：docx-preview 的 DOM 分页
 *
 * 为什么默认走它而不是引擎的画布：@betteroffice/docx 的整篇分页只在 `docx_edit`（brotli 5.3 MB）里，
 * 核心包的 layout 模块只有单段落 / 单表格原语。只读用 docx-preview 是 0 WASM、传输约 20 KB，
 * 20 页样本冷开 700 ms（基线）；要高保真就点「在线编辑」，那条路本来就会加载引擎。
 *
 * 这里只放"不依赖 Vue 的部分"：渲染、链接清理、页与大纲的读取、复制文本。视图层（缩放、滚动、批注栏）在 DocxReadView.vue。
 */
import { adaptBatch, afterNextFrame } from '@/utils/frameYield'

export const DOCX_CLASS = 'kbdocx'

/** 渲染选项：不执行文档脚本；图片内联成 data: URL（CSP 的 img-src 不含 blob:）；批注与修订不画在纸面上，批注走侧栏 */
export const RENDER_OPTIONS = {
  className: DOCX_CLASS,
  inWrapper: true,
  breakPages: true,
  ignoreLastRenderedPageBreak: true,
  useBase64URL: true,
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
  renderEndnotes: true,
  renderComments: false,
  renderChanges: false,
  experimental: false,
  debug: false,
} as const

export interface RenderedDocx {
  /** 文档里的图形（流程图、文本框这类 SVG 形状）个数：轻只读渲染它们不完整，视图据此提示 */
  shapes: number
  pages: number
  /** 页面自然宽度（px），适应宽度缩放用 */
  naturalWidth: number
}

/**
 * 分阶段显示：页数达到这个数才分批（小文档一次显示完，行为和以前完全一样）。
 * 20 页的整篇布局在 4× 降速下是 100~140 ms 的一条长任务（文字排版 + 布局 + 样式重算），而且谁先读一下尺寸就会立刻整篇算一遍。
 */
export const STAGE_MIN_PAGES = 4
/** 容器上的标记：带它时，还没轮到的页 content-visibility: hidden，不参与布局（样式在 DocxReadView.vue） */
export const STAGING_CLASS = 'is-staging'
/** 页上的标记：已经轮到、正常参与布局 */
export const SHOWN_CLASS = 'is-shown'

/** 逐页显示的批量：一批 3 页起步，按实测帧耗时自适应；一帧超过 SLOW 就缩小 */
const REVEAL_BATCH = { start: 3, min: 1, max: 12, slowMs: 34, fastMs: 22 }

/**
 * 渲染到容器。动态 import：普通预览路径不为 docx-preview 付首屏体积。
 * `stage`：页数够多时整篇先以「全部隐藏」的状态挂上去（content-visibility: hidden，不布局），随后由 `revealPages` 一批一批显示。
 * 这里量宽度读的是各页的盒子，隐藏的页只有盒子没有内容，不会触发整篇布局。
 */
export async function renderDocx(buffer: ArrayBuffer, host: HTMLElement, styles: HTMLElement, options: { stage?: boolean } = {}): Promise<RenderedDocx> {
  const { renderAsync } = await import('docx-preview')
  host.replaceChildren()
  styles.replaceChildren()
  host.classList.toggle(STAGING_CLASS, !!options.stage)
  await renderAsync(buffer, host, styles, { ...RENDER_OPTIONS })
  sanitizeLinks(host)
  labelImages(host)
  repairShapes(host)
  const sections = pageElements(host)
  // 页数不多：不值得分批，直接全部参与布局
  if (sections.length < STAGE_MIN_PAGES) host.classList.remove(STAGING_CLASS)
  return { shapes: host.querySelectorAll('svg').length, pages: sections.length, naturalWidth: Math.max(0, ...sections.map((section) => section.offsetWidth)) }
}

/**
 * 一批一批把页显示出来（每批之间让出一帧），第一批同步显示。返回 false = 中途被取消（换了文档 / 卸载）。
 * 全部显示完才摘掉容器上的分阶段标记，这时每一页都是真实布局，后面量尺寸、算页码、画缩略图都和以前一样精确。
 */
export async function revealPages(host: HTMLElement, cancelled: () => boolean): Promise<boolean> {
  if (!host.classList.contains(STAGING_CLASS)) return true
  const sections = pageElements(host)
  let batch = REVEAL_BATCH.start
  let at = 0
  while (at < sections.length) {
    for (let count = 0; count < batch && at < sections.length; count += 1, at += 1) sections[at]!.classList.add(SHOWN_CLASS)
    if (at >= sections.length) break
    const handedOver = performance.now()
    await afterNextFrame()
    if (cancelled()) return false
    batch = adaptBatch(batch, performance.now() - handedOver, REVEAL_BATCH)
  }
  host.classList.remove(STAGING_CLASS)
  return true
}

/** 只放行 http(s) / mailto / 文内锚点；其余（javascript: 等）一律去掉，外链强制 noopener */
export function sanitizeLinks(root: HTMLElement): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = anchor.getAttribute('href') ?? ''
    if (/^(https?:|mailto:|#)/i.test(href)) {
      if (!href.startsWith('#')) {
        anchor.target = '_blank'
        anchor.rel = 'noopener noreferrer nofollow'
      }
    } else {
      anchor.removeAttribute('href')
    }
  }
}

/**
 * docx-preview 渲染的 <img> 没有 alt（文档里的 descr 它不读），屏幕阅读器会念文件名甚至跳过。
 * 补一个通用说明：比没有强，也满足 axe 的 image-alt；文档自带的 alt 以后能读到再换。
 */
export function labelImages(root: HTMLElement): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('img:not([alt])')) image.alt = '文档图片'
}

/**
 * 修补 docx-preview 输出的形状（SVG）里两处让形状整个看不见的缺陷。
 *
 * 现象：Word 画的流程图（椭圆 + 箭头，文字写在形状里）在轻只读预览里是一整页空白，而 DOM 里文字都在、SVG 也有尺寸。
 * 实测（营养系统流程图，26 个形状全中）两个原因：
 * 1. 填充色写成 `#4f81bd [3204]`：Word 把主题色索引附在了后面，这不是合法的 SVG 颜色，浏览器当无效值丢掉，
 *    形状变成透明、又没有描边；
 * 2. 形状里的文字框 `<foreignObject>` 被放在 `<ellipse>` 里面：SVG 的图形元素不能有子节点，浏览器不渲染它们，文字也就看不到。
 * 这是第三方库的输出问题，改不了 node_modules，所以渲染完在我们的 DOM 上修。规则保守：只处理命中的节点，没有命中不动 DOM，
 * 也不碰文字内容（只挪位置、只去掉颜色后面的索引）。
 */
const SHAPES_WITHOUT_CHILDREN = new Set(['ellipse', 'rect', 'circle', 'line', 'path', 'polygon', 'polyline'])
/** `#4f81bd [3204]` / `red [12]`：一个颜色后面跟 Word 的主题索引 */
const COLOR_WITH_INDEX = /^\s*(#[0-9a-f]{3,8}|[a-z]+)\s*\[\d+\]\s*$/i

export function repairShapes(root: HTMLElement): { colors: number; textBoxes: number } {
  let colors = 0
  let textBoxes = 0
  for (const svg of root.querySelectorAll('svg')) {
    for (const node of svg.querySelectorAll('[fill], [stroke]')) {
      for (const attribute of ['fill', 'stroke']) {
        const match = COLOR_WITH_INDEX.exec(node.getAttribute(attribute) ?? '')
        if (match) {
          node.setAttribute(attribute, match[1]!)
          colors += 1
        }
      }
    }
    for (const box of svg.querySelectorAll('foreignObject')) {
      const parent = box.parentElement
      if (!parent || !SHAPES_WITHOUT_CHILDREN.has(parent.tagName.toLowerCase())) continue
      // 文字框挪到图形后面，和图形同级：图形先画、文字压在上面
      parent.after(box)
      textBoxes += 1
    }
  }
  return { colors, textBoxes }
}

/** 每个 section 是一页（docx-preview 的 breakPages） */
export function pageElements(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>(`section.${DOCX_CLASS}`))
}

/** 节点所在的页码（1 起）；不在任何页里返回 0 */
export function pageOfNode(host: HTMLElement, node: Node | null): number {
  const element = node && (node.nodeType === 1 ? (node as Element) : node.parentElement)
  const section = element?.closest(`section.${DOCX_CLASS}`)
  if (!section) return 0
  return pageElements(host).indexOf(section as HTMLElement) + 1
}

/**
 * 视口中线落在哪一页：滚动时更新页码指示。中线之下没有页面时取最后一页。
 * 页按文档顺序自上而下排列，「底边不在中线之上」对页序是单调的，所以用二分：几百页的文档每帧只读 O(log n) 页的布局，
 * 缩略图栏开着时主视图滚动也不会被页码计算拖慢（结果与逐页扫描完全一致）。
 */
export function currentPage(scroller: HTMLElement, host: HTMLElement): number {
  const pages = pageElements(host)
  if (!pages.length) return 0
  const box = scroller.getBoundingClientRect()
  const middle = box.top + box.height / 2
  let low = 0
  let high = pages.length - 1
  while (low < high) {
    const index = (low + high) >> 1
    if (pages[index]!.getBoundingClientRect().bottom >= middle) high = index
    else low = index + 1
  }
  return low + 1
}

export interface OutlineEntry {
  level: number
  text: string
  page: number
}

/** 大纲：渲染结果里 class 命中标题样式的段落，按文档顺序 */
export function collectOutline(host: HTMLElement, headingClasses: ReadonlyMap<string, number>): OutlineEntry[] {
  if (!headingClasses.size) return []
  const pages = pageElements(host)
  const entries: OutlineEntry[] = []
  pages.forEach((section, index) => {
    for (const paragraph of Array.from(section.querySelectorAll<HTMLElement>('p'))) {
      // 页眉页脚里的段落不进大纲
      if (paragraph.closest('header, footer')) continue
      let level = 0
      for (const name of Array.from(paragraph.classList)) {
        const found = headingClasses.get(name)
        if (found) level = found
      }
      const text = (paragraph.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (level && text) entries.push({ level: Math.min(level, 4), text: text.slice(0, 80), page: index + 1 })
    }
  })
  return entries
}

/** 选区外的元素不要：页眉页脚属于每一页的"版面"，复制一段正文时不该带上 */
const RUNNING = 'header, footer'
/** 这些容器里的纯空白文本节点只是源码缩进，不是内容；段落里的空格（`<span>a</span> <span>b</span>`）则要保留 */
const STRUCTURAL = new Set(['DIV', 'SECTION', 'ARTICLE', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'HEADER', 'FOOTER', 'UL', 'OL'])
const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'SECTION', 'ARTICLE', 'BLOCKQUOTE'])

/**
 * 选区片段转纯文本：段落一行，表格行一行、单元格之间用制表符（粘贴到笔记 / Excel 都保持表格形状）。
 * 不用 innerText：脱离文档的片段没有布局，innerText 会退化成 textContent 把所有段落粘在一起。
 */
export function fragmentToText(fragment: DocumentFragment | Element): string {
  const lines: string[] = []
  let line = ''
  const flush = () => {
    lines.push(line)
    line = ''
  }
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? ''
      const parent = node.parentElement
      if (!text.trim() && (!parent || STRUCTURAL.has(parent.tagName))) return
      line += text
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    if (el.tagName === 'BR') {
      flush()
      return
    }
    if (el.tagName === 'TD' || el.tagName === 'TH') {
      // 单元格里的多个段落并成一行（否则一个单元格会拆成几行，表格形状就丢了）；行尾多出的制表符在 TR 收尾时去掉
      line += `${fragmentToText(el).replace(/\s*\n+\s*/g, ' ')}\t`
      return
    }
    const block = BLOCK.has(el.tagName)
    if (block && line) flush()
    for (const child of Array.from(el.childNodes)) walk(child)
    if (el.tagName === 'TR') line = line.replace(/\t$/, '')
    if (block && (line || el.tagName === 'P')) flush()
  }
  // 从根的子节点开始：根本身可能是 TD（单元格递归调用），当作元素处理会无限递归
  for (const child of Array.from(fragment.childNodes)) walk(child)
  if (line) flush()
  // 连续空行压成一个；首尾空行去掉
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
}

/** 把选区复制成 { text, html }；除非选区覆盖整页，否则去掉页眉页脚。没有选中任何文字返回 null */
export function selectionClipboard(range: Range, host: HTMLElement): { text: string; html: string } | null {
  if (range.collapsed) return null
  const fragment = range.cloneContents()
  const wholePage = pageElements(host).some((section) => range.comparePoint(section, 0) === 0 && range.comparePoint(section, section.childNodes.length) === 0)
  const box = document.createElement('div')
  box.append(fragment)
  // 选区整个落在页眉 / 页脚里是用户有意要复制它，保留；跨出去的部分才去掉
  const inRunning = !!(range.commonAncestorContainer.nodeType === 1 ? (range.commonAncestorContainer as Element) : range.commonAncestorContainer.parentElement)?.closest(RUNNING)
  if (!wholePage && !inRunning) for (const el of Array.from(box.querySelectorAll(RUNNING))) el.remove()
  const text = fragmentToText(box)
  if (!text.trim()) return null
  return { text, html: box.innerHTML }
}
