// 笔记文本面的 ProseMirror 插件(纯逻辑,不依赖 Vue):
//   - 装饰:双链 [[id|标题]]、附件卡片 [📎 文件名](原件)、提示块 > [!NOTE];
//   - 粘贴 / 拖入文件 → 交给上传;
//   - 输入 `[[` → 唤出「引用笔记」选择器;
//   - 输入法组字收尾与光标滚动余量。
// 原在 utils/docPlugins.ts(旧 Milkdown 编辑器与新文本面共用); 删除旧编辑器后迁到文本面目录,
// 查找 / 选区批注 / 列表语义这三块只有旧编辑器用,随之删除(文本面有自己的 find.ts / quotes.ts)。
// 单测见 docPlugins.spec.ts(parseWikilink / calloutType)。
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import type { Node as PmNode } from 'prosemirror-model'
import { ATTACHMENT_MARK, attachmentExt, attachmentKind, attachmentMeta, mediaKind, parseRawUrl } from '@/utils/attachments'
import type { ResolvedLink } from '@/utils/links'
import { CALLOUT_TYPES, calloutType, type CalloutType } from '@/utils/callouts'

/* ---------------- 双链 ---------------- */

export const WIKILINK = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?]]/g

/** `[[ins_8b10|标题]]` → { id, alias }。 */
export function parseWikilink(raw: string): { id: string; alias: string } | null {
  const match = /^\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?]]$/.exec(raw)
  return match ? { id: match[1]!.trim(), alias: (match[2] ?? '').trim() } : null
}

export function wikilinkIds(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(WIKILINK)].map((match) => match[1]!.trim()))]
}

/* ---------------- 提示块 ---------------- */
// 类型表与判定拆到 callouts.ts:工具栏数据(editor/extensions/builtin/text.ts)要用同一份文案,
// 但它被编辑器外壳静态引用,不能为几个中文标签把整个装饰插件拉进外壳的首屏 chunk。
export { CALLOUT_TYPES, calloutType, type CalloutType }

/* ---------------- 装饰:双链 / 附件 / 提示块 ---------------- */

export const decoKey = new PluginKey<DecorationSet>('kbDeco')

export interface DecoOptions {
  readonly: () => boolean
  /** 双链的标题(取不到返回 undefined,阅读态就显示 id) */
  titleOf: (id: string) => string | undefined
  /** 把 Markdown 里的 href 解析成知识库目标(相对路径 / 站内原件地址);不给就只认本站原件地址。 */
  resolveLink?: (href: string) => ResolvedLink
  /** 链接指向的文件在不在:返回 missing / outside / invalid 时画虚线和提示。 */
  linkState?: (href: string) => { state: string; target?: string; reason?: string } | undefined
}

/** 文档里的内嵌播放器。`preload="metadata"`:只取时长和封面,不在打开文档时就把整段视频拉下来。 */
export function mediaPlayer(kind: 'video' | 'audio', src: string, name: string): HTMLElement {
  const box = document.createElement('span')
  box.className = `kb-media is-${kind}`
  box.contentEditable = 'false'
  const player = document.createElement(kind)
  player.src = src
  player.controls = true
  player.preload = 'metadata'
  player.setAttribute('aria-label', name)
  // 视频不要自己撑破版心;音频只要一条控制条
  if (kind === 'video') (player as HTMLVideoElement).playsInline = true
  box.append(player)
  return box
}

function buildDecorations(doc: PmNode, options: DecoOptions): DecorationSet {
  const decorations: Decoration[] = []
  const readonly = options.readonly()
  doc.descendants((node, pos) => {
    if (node.type.name === 'blockquote') {
      const first = node.firstChild
      const callout = first?.isTextblock ? calloutType(first.textContent) : null
      if (callout && first) {
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: `kb-callout is-${callout.type}`, 'data-label': CALLOUT_TYPES[callout.type] }))
        const markerFrom = pos + 2
        decorations.push(Decoration.inline(markerFrom, markerFrom + callout.length, { class: 'kb-callout-marker', 'data-label': CALLOUT_TYPES[callout.type] }))
      }
      return true
    }
    if (!node.isText || !node.text) return true
    if (node.marks.some((mark) => mark.type.name === 'inlineCode')) return false
    const link = node.marks.find((mark) => mark.type.name === 'link')
    const href = link ? String(link.attrs.href ?? '') : ''
    const resolved = link && options.resolveLink ? options.resolveLink(href) : null
    const target =
      resolved && (resolved.kind === 'file' || resolved.kind === 'raw') && resolved.collection && resolved.target
        ? { collection: resolved.collection, path: resolved.target, href: resolved.href }
        : parseRawUrl(href)
          ? { ...parseRawUrl(href)!, href }
          : null
    if (link && node.text.startsWith(ATTACHMENT_MARK)) {
      if (target) {
        const name = node.text.slice(ATTACHMENT_MARK.length).trim()
        decorations.push(
          // 卡片左边已有类型图标块，📎 只是 Markdown 里的标记（没有彩色字体的系统上还会显示成方块）：
          // 卡片从名字开始，📎 单独隐掉（阅读和编辑都一样；编辑时它仍在文字里，光标走过去会多停一下，但看不见）
          Decoration.inline(pos + ATTACHMENT_MARK.length, pos + node.nodeSize, {
            class: `kb-attach is-${attachmentKind(name)}`,
            'data-size': String(link.attrs.title ?? ''),
            'data-ext': attachmentExt(name),
            'data-meta': attachmentMeta(name, String(link.attrs.title ?? '')),
          }),
        )
        decorations.push(Decoration.inline(pos, pos + ATTACHMENT_MARK.length, { class: 'kb-attach-mark' }))
        // 视频 / 音频附件:卡片后面直接放播放器(阅读和编辑都有),不用点开预览页。Markdown 原文不变,
        // 在别的 Markdown 工具里它仍是一个普通附件链接
        const kind = mediaKind(name)
        if (kind) {
          decorations.push(
            Decoration.widget(pos + node.nodeSize, () => mediaPlayer(kind, target.href, name), {
              side: 1,
              key: `media:${kind}:${target.href}`,
              // 播放器自己的点击、拖动进度条不能被编辑器当成选区操作
              stopEvent: () => true,
              ignoreSelection: true,
            }),
          )
        }
      }
    }
    // 普通链接:目标文件不在 / 不在分享范围 / 原电脑路径 → 虚线 + 提示;不改 href,点击时再拦。
    if (link && !node.text.startsWith(ATTACHMENT_MARK)) {
      const state = options.linkState?.(href)
      if (state && state.state !== 'ok') {
        decorations.push(
          Decoration.inline(pos, pos + node.nodeSize, {
            class: `kb-link-${state.state}`,
            title: state.reason || (state.target ? `未找到：${state.target}` : '链接目标不可用'),
          }),
        )
      }
    }
    for (const match of node.text.matchAll(WIKILINK)) {
      const from = pos + (match.index ?? 0)
      const to = from + match[0].length
      const id = match[1]!.trim()
      const title = (match[2] ?? '').trim() || options.titleOf(id)
      if (readonly && title) {
        decorations.push(Decoration.inline(from, to, { class: 'kb-wikilink-raw' }))
        decorations.push(
          Decoration.widget(
            from,
            () => {
              const chip = document.createElement('span')
              chip.className = 'kb-wikilink'
              chip.dataset.id = id
              chip.textContent = title
              chip.title = id
              return chip
            },
            { side: -1, key: `wl:${id}:${title}` },
          ),
        )
      } else {
        decorations.push(Decoration.inline(from, to, { class: 'kb-wikilink', 'data-id': id, title: title || id }))
      }
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

export function decorationsPlugin(options: DecoOptions): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: decoKey,
    state: {
      init: (_config, state) => buildDecorations(state.doc, options),
      apply: (tr, old) => (tr.docChanged || tr.getMeta(decoKey) ? buildDecorations(tr.doc, options) : old.map(tr.mapping, tr.doc)),
    },
    props: {
      decorations(state) {
        return decoKey.getState(state)
      },
    },
  })
}

/** 标题取回来 / 读写模式切换后重建装饰 */
export function refreshDecorations(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(decoKey, true))
}

/* ---------------- 粘贴 / 拖入文件、`[[` 触发 ---------------- */

export interface InputOptions {
  readonly: () => boolean
  onFiles: (files: File[], pos: number) => void
  /** 刚输入了 `[[`:pos 是第二个 `[` 之后的位置 */
  onWikilinkTrigger: (pos: number) => void
}

function filesOf(data: DataTransfer | null): File[] {
  if (!data) return []
  const files = [...(data.files ?? [])]
  if (files.length) return files
  return [...(data.items ?? [])].filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => !!file)
}

/** compositionend 之后等 ProseMirror 把组字结果落进文档的时间(它自己用 20 ms 收尾),再读最终文本 */
export const COMPOSITION_SETTLE_MS = 30
/** 组字结束后推给编辑器的空事务的标记(没有任何插件需要读它,只是让状态更新一次) */
export const COMPOSITION_END_META = 'kb-composition-end'

export function inputPlugin(options: InputOptions): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, _to, text) {
        if (options.readonly() || text !== '[') return false
        // 组字中(拼音 / 注音的预编辑文字)凑出的 `[` 不算:弹出选择器会抢走焦点、打断组字。
        // 组字结束后由下面的 compositionend 按最终文本判断
        if (view.composing) return false
        if (view.state.doc.textBetween(Math.max(0, from - 1), from) === '[') {
          // 等这次输入落进文档后再弹出(否则位置差一个字)
          window.setTimeout(() => options.onWikilinkTrigger(view.state.selection.from), 0)
        }
        return false
      },
      handleDOMEvents: {
        compositionend(view, event) {
          if (options.readonly()) return false
          const data = (event as CompositionEvent).data ?? ''
          window.setTimeout(() => {
            if (view.isDestroyed) return
            // 上屏的文字和组字时的预编辑文字一样时(韩文、安卓键盘的联想词),文档没有变化,ProseMirror 不会再更新状态,
            // 而 Crepe 斜杠菜单只在状态更新时才按光标前的文字重新过滤——菜单会停在组字前的过滤结果上,
            // 回车执行的就是一个和输入对不上的菜单项。推一个空事务让它按最终文本重新判断
            view.dispatch(view.state.tr.setMeta(COMPOSITION_END_META, true))
            // 只有这次上屏的文字里带 `[` 才可能凑出 `[[`:否则用户 Esc 关掉选择器后,
            // 在 `[[` 后面随便组一个字再取消,选择器又会弹出来
            if (!data.includes('[')) return
            const { selection, doc } = view.state
            if (!selection.empty) return
            const at = selection.from
            if (at >= 2 && doc.textBetween(at - 2, at) === '[[') options.onWikilinkTrigger(at)
          }, COMPOSITION_SETTLE_MS)
          return false
        },
      },
    },
    view(view) {
      // 文件的粘贴 / 拖入在捕获阶段接管:Crepe 自带的图片处理会先把图片变成 blob: 地址(CSP 不放行,刷新即失效)
      const onPaste = (event: ClipboardEvent) => {
        if (options.readonly()) return
        const files = filesOf(event.clipboardData)
        if (!files.length) return
        event.preventDefault()
        event.stopImmediatePropagation()
        // 剪贴板里可能同时有文字和文件(从 Word / 网页复制图文最常见)。以前只要看到文件就把整次粘贴接管掉,
        // 文字跟着一起被吞了,用户只看到图片进来、以为「粘贴文字不能用」。
        // 先把文字按原格式放进文档,文件接在文字后面上传,顺序和剪贴板里一致。
        let pos = view.state.selection.from
        const data = event.clipboardData
        const text = data?.getData('text/plain') ?? ''
        // HTML 里指向本机 / blob 的 <img> 贴进来只会是一张破图(图片本身走 onFiles 上传),先剔掉
        const html = (data?.getData('text/html') ?? '').replace(/<img\b[^>]*>/gi, '')
        if (text.trim() || html.trim()) {
          // 交给 ProseMirror 自己解析,保留加粗、列表、表格这些格式
          const pasted = html.trim() ? view.pasteHTML(html, event) : view.pasteText(text, event)
          if (pasted) pos = view.state.selection.from
          else if (text) {
            view.dispatch(view.state.tr.insertText(text, pos))
            pos = view.state.selection.from
          }
        }
        options.onFiles(files, pos)
      }
      const onDrop = (event: DragEvent) => {
        if (options.readonly()) return
        const files = filesOf(event.dataTransfer)
        if (!files.length) return
        event.preventDefault()
        event.stopImmediatePropagation()
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
        options.onFiles(files, at?.pos ?? view.state.selection.from)
      }
      const onDragOver = (event: DragEvent) => {
        if (!options.readonly() && event.dataTransfer?.types.includes('Files')) event.preventDefault()
      }
      const dom = view.dom
      dom.addEventListener('paste', onPaste, true)
      dom.addEventListener('drop', onDrop, true)
      dom.addEventListener('dragover', onDragOver, true)
      return {
        destroy() {
          dom.removeEventListener('paste', onPaste, true)
          dom.removeEventListener('drop', onDrop, true)
          dom.removeEventListener('dragover', onDragOver, true)
        },
      }
    },
  })
}

/** ProseMirror 滚动光标时四边的余量(px) */
export interface ScrollSides {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * 让 ProseMirror 滚动光标进入视野时避开贴在键盘上沿的工具栏。
 * 它按「滚动容器的下沿」判断光标有没有出界,而工具栏是盖在容器下沿之上的,光标行落在工具栏后面它不会滚;
 * 余量对象由调用方持有、原地修改(工具栏贴上 / 放开、换了高度时改 bottom),这里每次滚动都现读。
 * threshold 是「离边多近就开始滚」,margin 是「滚完后离边多远」,两个都要加。
 */
export function scrollMarginPlugin(margin: ScrollSides, threshold: ScrollSides): Plugin {
  return new Plugin({ props: { scrollMargin: margin, scrollThreshold: threshold } })
}

/* ---------------- 选区批注:已有评论的摘录(页面传给文本面,文本面自己画高亮) ---------------- */

export interface QuoteItem {
  /** 评论 id(点高亮时据此定位到评论) */
  id: string
  text: string
  prefix: string
  suffix: string
  resolved: boolean
}
