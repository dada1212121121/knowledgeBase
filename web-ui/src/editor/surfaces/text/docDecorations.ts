/**
 * 笔记文本面的「正文装饰」：双链标题、附件卡片、提示块、链接体检、相对路径图片
 *
 * 装饰逻辑直接复用同目录的 `docPlugins.ts`（装饰、双链解析、提示块判定都在那里，
 * 且只依赖 ProseMirror 的 state / view / model，不依赖 Milkdown 运行时）：
 * 节点 / 标记名与旧编辑器一致（见 schema.ts 的房间格式不变量），所以同一份装饰代码两边都对。
 * 这样「同一篇笔记在新旧编辑器里看起来一样」由同一份代码保证，而不是靠两份实现长期对齐。
 *
 * 本文件只负责把「页面服务」（TextServices）接到装饰选项上，以及相对路径图片的节点视图。
 */
import type { Plugin } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeViewConstructor } from 'prosemirror-view'
import { decorationsPlugin, refreshDecorations, wikilinkIds } from '@/editor/surfaces/text/docPlugins'
import { assetUrl } from '@/utils/attachments'
import { MAX_IMAGE_WIDTH, MIN_IMAGE_WIDTH, clampImageWidth } from '@/utils/imageSize'
import { resolveDocHref, type ResolvedLink } from '@/utils/links'
import type { TextServices } from '../../types'
import { linkStateOf } from './linkFollow'

/** 取服务的函数：内容面在没有页面服务（单测 / 孤立使用）时返回 undefined，装饰降级为只认站内原件地址 */
export type ServicesGetter = () => TextServices | undefined

/** 双链标题缓存：id → 标题（'' = 已请求但没有结果，避免反复请求） */
export class TitleCache {
  private readonly titles = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly services: ServicesGetter) {}

  titleOf(id: string): string | undefined {
    return this.titles.get(id) || undefined
  }

  /** 补取文档里还没有标题的双链；取回后通知调用方重画装饰。防抖：连续输入时不每键请求 */
  resolveMissing(doc: PMNode, onResolved: () => void): void {
    const services = this.services()
    if (!services?.resolveTitles) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const missing = collectWikilinkIds(doc).filter((id) => !this.titles.has(id))
      if (!missing.length) return
      for (const id of missing) this.titles.set(id, '')
      void services
        .resolveTitles!(missing)
        .then((found) => {
          for (const [id, title] of Object.entries(found)) this.titles.set(id, title)
          onResolved()
        })
        .catch(() => {
          // 标题取不到就显示 id，不打断编辑
        })
    }, 250)
  }

  /** 记下刚插入的双链标题，免得马上再请求一次 */
  remember(id: string, title: string): void {
    this.titles.set(id, title)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

/** 文档里所有双链 id（去重）：逐个文本节点拼接后用与旧编辑器相同的正则取 */
export function collectWikilinkIds(doc: PMNode): string[] {
  const text: string[] = []
  doc.descendants((node) => {
    if (node.isText && node.text) text.push(node.text)
    return true
  })
  return wikilinkIds(text.join('\n'))
}

/** 装饰插件：选项里的函数每次现读服务，页面数据变了只需 refresh（不重建插件） */
export function textDecorations(options: { services: ServicesGetter; readonly: () => boolean; titles: TitleCache }): Plugin {
  const { services, readonly, titles } = options
  return decorationsPlugin({
    readonly,
    titleOf: (id) => titles.titleOf(id),
    resolveLink: (href): ResolvedLink => {
      const ctx = services()?.linkContext()
      // 没有上下文：不改写相对地址，当外链处理，装饰里只认站内原件地址
      return ctx ? resolveDocHref(href, ctx) : { kind: 'external', href, raw: href }
    },
    linkState: (href) => {
      const current = services()
      if (!current) return undefined
      const info = linkStateOf(href, current)
      if (!info) return undefined
      // 原电脑路径 / 跑出集合：状态不是后端给的，但同样要画不可用提示
      if (info.resolved.kind === 'absolute' || info.resolved.kind === 'invalid') {
        return { state: 'invalid', target: info.resolved.raw, reason: info.resolved.reason ?? '链接不可用' }
      }
      if (!info.state) return undefined
      const reason =
        info.state === 'missing'
          ? info.resolved.kind === 'note'
            ? '笔记不在知识库里'
            : '文件不在知识库里'
          : info.state === 'outside'
            ? '不在本次分享范围内'
            : '链接不可用'
      return { state: info.state, target: info.resolved.target, reason }
    },
  })
}

/** 页面数据（体检结果 / 标题 / 读写模式）变了：重画装饰 */
export function refreshTextDecorations(view: EditorView): void {
  refreshDecorations(view)
}

/**
 * 图片节点视图：
 * - 只在**渲染**时把相对地址换成原件地址，节点的 `src` 属性不动，所以序列化、保存、协同写回去的仍是作者写的原样
 *   （与旧编辑器的 imageAssetView 一致）；
 * - 可编辑时右下角有一个拖拽手柄：鼠标 / 手指（Pointer Events，触屏也能用）按住拖就改宽度，高度始终按原图比例算，
 *   所以只存宽度（节点的 `width` 属性，落到 Markdown 是地址的 `#w=` 片段，见 utils/imageSize.ts）。
 *   手柄也能用键盘：聚焦后 ← → 每次 8px（Shift 为 40px），Home 恢复自动宽度；双击手柄也恢复。
 *   编辑、阅读（MarkdownRead）、下载（导出时换成 <img width>）三处显示的大小一致。
 */
export function imageNodeView(services: ServicesGetter): NodeViewConstructor {
  return (node, view, getPos) => {
    let current = node
    const dom = document.createElement('span')
    dom.className = 'kb-img'
    // 整个节点不可编辑：光标进不去，也不会触发浏览器自带的图片缩放（Firefox 会在 contenteditable 里的图片上画手柄）
    dom.contentEditable = 'false'
    const img = document.createElement('img')
    const handle = document.createElement('span')
    handle.className = 'kb-img-handle'
    handle.tabIndex = 0
    handle.setAttribute('role', 'slider')
    handle.setAttribute('aria-label', '调整图片宽度')
    handle.setAttribute('aria-valuemin', String(MIN_IMAGE_WIDTH))
    handle.title = '拖动调整大小（双击恢复原始大小）'
    dom.append(img, handle)

    const paint = (attrs: { src?: unknown; alt?: unknown; title?: unknown; width?: unknown }) => {
      const svc = services()
      const src = String(attrs.src ?? '')
      img.setAttribute('src', svc ? assetUrl(src, svc.collection(), svc.sourcePath(), svc.adminView(), svc.linkContext()?.rawUrl) : src)
      // alt 为空串也要写出来：装饰图要让读屏跳过，缺属性会被当成「图片无说明」
      img.setAttribute('alt', String(attrs.alt ?? ''))
      if (attrs.title) img.setAttribute('title', String(attrs.title))
      else img.removeAttribute('title')
      const width = Number(attrs.width) || 0
      if (width) img.setAttribute('width', String(width))
      else img.removeAttribute('width')
      img.style.removeProperty('width')
      handle.setAttribute('aria-valuenow', String(width || Math.round(img.getBoundingClientRect().width)))
    }
    paint(node.attrs)

    const commit = (width: number | null) => {
      const pos = getPos()
      if (pos === undefined || !view.editable) return
      if ((Number(current.attrs.width) || null) === width) return
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width }))
    }
    /** 版心宽度：图片最宽不超过正文区域（再宽也会被 max-width:100% 压回去，存大了没意义） */
    const maxWidth = () => Math.floor(view.dom.getBoundingClientRect().width) || MAX_IMAGE_WIDTH

    handle.addEventListener('pointerdown', (event) => {
      if (!view.editable || (event.pointerType === 'mouse' && event.button !== 0)) return
      event.preventDefault()
      event.stopPropagation()
      const startX = event.clientX
      const startWidth = img.getBoundingClientRect().width
      const upper = maxWidth()
      let width = startWidth
      handle.setPointerCapture(event.pointerId)
      dom.classList.add('is-resizing')
      const move = (move: PointerEvent) => {
        width = clampImageWidth(startWidth + (move.clientX - startX), upper)
        img.style.width = `${width}px`
        handle.setAttribute('aria-valuenow', String(width))
      }
      const finish = (up: PointerEvent, apply: boolean) => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onCancel)
        if (handle.hasPointerCapture(up.pointerId)) handle.releasePointerCapture(up.pointerId)
        dom.classList.remove('is-resizing')
        img.style.removeProperty('width')
        // 没怎么动（点了一下手柄）不算调整
        if (apply && Math.abs(width - startWidth) >= 2) commit(width)
        else paint(current.attrs)
      }
      const onUp = (up: PointerEvent) => finish(up, true)
      const onCancel = (up: PointerEvent) => finish(up, false)
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onCancel)
    })
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault()
      commit(null)
    })
    handle.addEventListener('keydown', (event) => {
      if (!view.editable) return
      const step = event.shiftKey ? 40 : 8
      const now = Number(current.attrs.width) || Math.round(img.getBoundingClientRect().width)
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') commit(clampImageWidth(now + step, maxWidth()))
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') commit(clampImageWidth(now - step, maxWidth()))
      else if (event.key === 'Home') commit(null)
      else return
      event.preventDefault()
      event.stopPropagation()
    })

    return {
      dom,
      update: (next: PMNode) => {
        if (next.type !== node.type) return false
        current = next
        paint(next.attrs)
        return true
      },
      // 手柄上的指针 / 键盘事件由手柄自己处理，不交给 ProseMirror（否则按下就变成选区操作、拖拽被当成移动图片）
      stopEvent: (event) => event.target === handle,
      // 图片尺寸、手柄状态是视图自己改的 DOM，不是文档内容
      ignoreMutation: () => true,
    }
  }
}
