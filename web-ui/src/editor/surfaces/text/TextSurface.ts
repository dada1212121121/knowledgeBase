/**
 * Text Surface：笔记正文的 ProseMirror 内容面
 *
 * 职责边界（见设计规范）：
 * - 只管渲染、输入、选区、滚动与局部查询；网络、版本、锁、协同一律在 Host / Session 层。
 * - 保真是两层策略：文档没被改动时直接把原始字符串交给 Session（一个字节都不动）；
 *   一旦改动才走 markdown 序列化，风格沿用 milkdownConfig.ts 的既定契约。
 * - 与 Vue 完全不耦合：Host 用 shallowRef 持有本类实例，内部状态不进响应式系统。
 * - 多人编辑：Host 透传已连好的富文本房间（`ctx.collabRich`），这里用 y-prosemirror 绑定房间的
 *   Y.XmlFragment。节点名与旧编辑器一致（见 schema.ts），新旧两种客户端可以同时在一个房间里写；
 * 正文以房间为准，本地不注册保存快照，落地由页面的 landing 调度（同步取 `textNow`）。
 */
import { AllSelection, EditorState, TextSelection, type Command, type Plugin, type Transaction } from 'prosemirror-state'
import { redo as historyRedo, undo as historyUndo } from 'prosemirror-history'
import { EditorView } from 'prosemirror-view'
import { Fragment, Slice, type Mark, type Node as PMNode } from 'prosemirror-model'
import type { CalloutType } from '@/utils/callouts'
import type { ColorProp } from '@/utils/colorPalette'
import { countWords, parseMarkdown, serializeMarkdown } from '../../codecs/markdown'
import type {
  AiApplyMode,
  AiWriteAction,
  Anchor,
  CollabRichLike,
  CommandResult,
  EditorCommand,
  EditorSource,
  Selection,
  Size,
  Surface,
  SurfaceContext,
  SurfaceDocument,
  SurfaceQuery,
  SurfaceState,
  TextPanelName,
} from '../../types'
import { MARK_ORDER, textSchema } from './schema'
import { buildKeymap, type HistoryBinding } from './keymap'
import { markdownInputRules } from './inputRules'
import { htmlSlice, insertImageFiles, looksLikeMarkdown, markdownSlice, type ImageUploader } from './paste'
import { anchorFromState, blockText, rangeFromAnchor, selectionFromState } from './selection'
import { locatedQuotes, quoteIdAt, quotePlugin, refreshQuotes, resolveAnchorRange, revealQuote } from './quotes'
import { QuoteTools } from './quoteTools'
import {
  activeMarks,
  applyStyleMarks,
  clearFormatting,
  styleMarksAt,
  currentBlock,
  insertBlocks,
  insertCallout,
  insertDiagram,
  insertHorizontalRule,
  insertImageNode,
  insertMathBlock,
  linkAtSelection,
  setColor,
  toggleTaskItemAt,
  insertTable,
  isInNode,
  MARK_COMMANDS,
  setHeadingLevel,
  setLink,
  toggleBlockquote,
  toggleInlineMark,
  toggleListKind,
  toggleTaskList,
} from './commands'
import { EMPTY_FIND, findHighlightPlugin, findMatches, readFindState, withFindState, type FindMatch } from './find'
import { imageNodeView, refreshTextDecorations, TitleCache, textDecorations } from './docDecorations'
import { cursorPlugins, EMPTY_DOC_PLACEHOLDER, placeholderPlugin } from './cursors'
import { taskListItemView } from './listItemView'
import { codeHighlightPlugin } from './codeHighlight'
import { codeBlockView } from './codeBlockView'
import { mathInlineView } from './mathView'
import { BlockHandle } from './blockHandle'
import { addColumn, addRow, deleteColumn, deleteRow, deleteTable, isInTable, setColumnAlignment } from './tableCommands'
import { isSafeHref } from './commands'
import { resolveExternalOpen, resolveFollow } from './linkFollow'
import { COMPOSITION_SETTLE_MS, inputPlugin, scrollMarginPlugin } from '@/editor/surfaces/text/docPlugins'
import { DEFAULT_SCROLL_MARGIN, menusAsSheet, scrollMarginBottom } from '@/utils/editorMobile'
import { scrollRectIntoView } from '@/composables/useVisualViewport'
import { filterSlashActions, groupSlashActions, SLASH_MARKDOWN_HINTS, type EditorAction, type SlashGroup } from '../../extensions/builtin/text'
import { toolIcon, toolIconElement } from '../../host/toolIcons'
import { recentSlashIds, recordSlashUse } from './slashRecent'
import { aiTargetOf, aiTargetPlugin, clearAiTarget, setAiTarget } from './aiTarget'
import { blockKey, blockKeysMatch } from '@/utils/blockKey'
import { setBlockType } from 'prosemirror-commands'
import '@/styles/kbColor.css'
import './textSurface.css'
import '@/styles/attachCard.css'
import '@/styles/proseMarks.css'

/** view.alignBlock 的参数（DocPage 的阅读 → 编辑交接） */
interface AlignBlockArgs {
  key: string
  occurrence?: number
  top: number
  minTop?: number
  caret?: { x: number; y: number }
}

/** 大纲条目（Chrome 目录用） */
export interface TextOutlineItem {
  level: number
  text: string
  anchor: Anchor
}

export interface TextSurfaceOptions {
  /** 粘贴/拖入图片的上传通道；缺省时忽略图片，绝不用 base64 落库 */
  uploadImage?: ImageUploader
  /**
   * 斜杠菜单可选项；由 Host 从内置贡献注入，缺省时斜杠菜单不可用（但输入 `/` 不报错）。
   * 写成函数时每次打开菜单都现取——扩展可以在编辑器打开之后才装上或卸载。
   */
  slashActions?: readonly EditorAction[] | (() => readonly EditorAction[])
}

/** 查找状态：Chrome 通过 `search` 查询读到，写入一律走命令 */
export interface TextFindInfo {
  query: string
  total: number
  index: number
}

/**
 * 光标所在行真正在其中滚动的那一层：从正文本身往外找第一个“能滚（overflow:auto/scroll）且现在确实溢出”的元素；
 * 都没有就是窗口（返回 null）。不能只看样式——外壳的舞台层也是 overflow:auto，但高度随内容长，从不溢出，滚它没有效果。
 */
function overflowingAncestor(start: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = start; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) return node
  }
  return null
}

/** 粘贴的内容是不是「一个网址」：整段就是一个 http(s) / mailto 地址，中间没有空白 */
export function pastedLinkTarget(text: string): boolean {
  if (!text || /\s/.test(text) || text.length > 2048) return false
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(text)) return true
  if (!/^https?:\/\/[^/?#\s]+/i.test(text)) return false
  try {
    const url = new URL(text)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname
  } catch {
    return false
  }
}

/** 读取请求里的文本内容；二进制格式走别的 Surface，这里只认文本 */
function readSource(source: EditorSource): { text: string; name: string } {
  if (source.kind === 'text') return { text: source.text, name: source.name }
  return { text: '', name: source.name }
}

/** 斜杠菜单组名的 id 计数（同一页面可能有多个编辑器，aria-labelledby 指向的 id 不能重） */
let slashGroupSeq = 0

/** 两端开放的切片：首尾是文本块时并进插入点前后的文字（和粘贴一样），不在插入点硬拆出空段落 */
function openSlice(nodes: readonly PMNode[]): Slice {
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  return new Slice(Fragment.fromArray([...nodes]), first?.isTextblock ? 1 : 0, last?.isTextblock ? 1 : 0)
}

/**
 * 斜杠菜单项前的图标：认得的动作画工具栏同一套线性 SVG；各级标题画「H1」…「H6」文字（和段落格式下拉一致）；
 * 第三方扩展的动作退回它自带的短字符。图标只是装饰，读屏读名字
 */
function slashIcon(doc: Document, item: EditorAction): HTMLElement {
  const icon = doc.createElement('span')
  icon.className = 'kb-slash-icon'
  icon.setAttribute('aria-hidden', 'true')
  const heading = /^heading\.([1-6])$/.exec(item.id)
  const paths = heading ? null : toolIcon(item.id)
  if (paths) icon.appendChild(toolIconElement(doc, paths, 16))
  else if (heading) {
    icon.classList.add('is-face')
    icon.textContent = `H${heading[1]}`
  } else icon.textContent = item.icon ?? '•'
  return icon
}

export class TextSurface implements Surface {
  private ctx: SurfaceContext | null = null
  private view: EditorView | null = null
  private initialDoc: PMNode | null = null
  private originalText = ''
  private frontmatter: string | null = null
  private eol: '\n' | '\r\n' = '\n'
  private name = ''
  private readonly options: TextSurfaceOptions
  /** 当前查找串与命中（命中位置随文档变动失效，见 findHighlightPlugin） */
  private findQuery = ''
  private findCaseSensitive = false
  /** 斜杠菜单 DOM 与当前高亮项（菜单归 Surface 所有：定位依赖光标坐标） */
  private slashEl: HTMLElement | null = null
  private slashIndex = 0
  private slashQuery = ''
  private slashDismissed = false
  /** 撤销 / 重做：单人是 prosemirror-history，多人是 y-prosemirror 的撤销管理器（只撤自己的改动） */
  private undoCommand: Command = historyUndo
  private redoCommand: Command = historyRedo
  /** 多人编辑：房间还没同步好 / 被降为只读时锁住输入，免得打的字被服务端丢掉 */
  private collabLocked = false
  private readonlyFlag = false
  private collabOff: (() => void) | null = null
  /**
   * ProseMirror 滚动光标进视野的余量：原地改，它每次滚动都现读。
   * 手机上贴键盘的工具栏 / 底部面板盖住了内容底部一截，光标行落在它们后面 PM 不会自己滚（它按滚动容器的下沿判断）
   */
  private readonly scrollMargin = { top: DEFAULT_SCROLL_MARGIN, right: DEFAULT_SCROLL_MARGIN, bottom: DEFAULT_SCROLL_MARGIN, left: DEFAULT_SCROLL_MARGIN }
  private readonly scrollThreshold = { top: 0, right: 0, bottom: 0, left: 0 }
  /** 源码模式：隐藏所见即所得，直接编辑 Markdown 源码（旧编辑器的“源码”开关） */
  private sourceEl: HTMLTextAreaElement | null = null
  private sourceText = ''
  /** 进入源码模式时的正文：退出时没改过就不重新解析，避免“看一眼源码”也改写文档 */
  private sourceEntered = ''
  /** 点头像跳转后让名牌重新亮几秒的计时器 */
  private revealTimer = 0
  /** 块手柄（悬停某个块时左边的 ＋ 和拖动把手） */
  private blockHandle: BlockHandle | null = null
  /** 选区浮条 / 链接卡 / 表格工具（DOM 构建，位置取决于光标坐标，所以归内容面） */
  /** 选中文字时的「评论」浮钮（选区批注） */
  private quoteTools: QuoteTools | null = null
  /** 双链标题缓存（页面的 resolveTitles 异步取回后重画装饰） */
  private readonly titles = new TitleCache(() => this.services())
  /**
   * 格式刷：取了样、等着刷到下一段选中的文字上。sticky = 双击格式刷按钮进来的，可以连续刷，按 Esc 或再点一下按钮才退出
   * （和 Word / WPS 一样）。只是视图状态，不进文档和协同房间
   */
  private painter: { marks: readonly Mark[]; sticky: boolean } | null = null

  constructor(options: TextSurfaceOptions = {}) {
    this.options = options
  }

  /** 当前编辑器状态（只读快照；宿主与测试用，不要在外层改它） */
  get editorState(): EditorState | null {
    return this.view?.state ?? null
  }

  async mount(el: HTMLElement, ctx: SurfaceContext): Promise<void> {
    this.ctx = ctx
    const payload = ctx.document.payload
    const source: EditorSource =
      payload && typeof payload === 'object' && 'kind' in payload
        ? (payload as EditorSource)
        : { kind: 'text', text: '', name: ctx.document.format }
    const { text, name } = readSource(source)
    this.name = name
    this.originalText = text
    const parsed = parseMarkdown(text)
    this.frontmatter = parsed.frontmatter
    this.eol = parsed.eol
    this.initialDoc = parsed.doc

    this.readonlyFlag = ctx.readonly
    const rich = ctx.collabRich ?? null
    const collab = rich ? await this.collabPlugins(rich) : null
    const state = EditorState.create({
      // 多人编辑时正文来自房间（y-prosemirror 首次渲染时整份换上），这里先放一个空段落
      doc: collab ? textSchema.topNodeType.createAndFill() ?? undefined : parsed.doc,
      plugins: [
        ...(collab?.plugins ?? []),
        ...cursorPlugins(),
        ...buildKeymap(textSchema, collab?.history, { onLinkRequest: () => this.ctx?.onLinkRequest?.() }),
        markdownInputRules(textSchema),
        findHighlightPlugin(),
        placeholderPlugin(EMPTY_DOC_PLACEHOLDER, () => !this.isLocked()),
        codeHighlightPlugin(),
        ...this.pagePlugins(),
      ],
    })

    // 用 PM 调用时绑定的 this（正在构造的 EditorView），而不是 this.view：y-prosemirror 在构造函数里就会派发
    // 「换上房间内容」的事务，那时 this.view 还没赋值，丢掉这个事务房间内容就显示不出来
    const onDispatch = (view: EditorView, tr: Transaction) => this.dispatch(tr, view)
    this.view = new EditorView(el, {
      state,
      editable: () => !this.readonlyFlag && !this.collabLocked,
      // 相对路径图片：渲染时换成原件地址，节点的 src 不动（保存 / 协同写回的仍是作者写的原样）
      // 任务项的复选框可点击（写回 checked）
      // 代码块（语言 / 复制 / 流程图与公式预览）、行内公式（KaTeX，点一下就地编辑）
      nodeViews: {
        image: imageNodeView(() => this.services()),
        list_item: taskListItemView,
        code_block: codeBlockView,
        math_inline: mathInlineView,
      },
      attributes: {
        class: 'kb-text-prose',
        role: 'textbox',
        'aria-multiline': 'true',
        // 读屏用户、axe 场景都按这个名字（「文档正文」）认编辑区
        'aria-label': '文档正文',
      },
      dispatchTransaction: function (this: EditorView, tr: Transaction) {
        onDispatch(this, tr)
      },
      handleKeyDown: (view, event) => this.handleKeyDown(view, event),
      handlePaste: (view, event) => this.handlePaste(view, event),
      handleDrop: (view, event) => this.handleDrop(view, event),
      handleDOMEvents: {
        // Ctrl/⌘ 点击（只读时直接点）跟随链接 / 双链 / 附件卡片
        click: (_view, event) => {
          // 点中批注高亮：通知页面聚焦那条评论（正在拖选 / 已选中文字时不算点击）；同一下点击仍按链接规则处理
          this.quoteClicked(event as MouseEvent)
          return this.followLink(event as MouseEvent)
        },
        // 组字结束后按最终文本重新过滤斜杠菜单：上屏的字和组字时的预编辑文字一样时（韩文、安卓键盘的联想词）
        // 文档没有变化，状态不会更新，菜单会停在组字前的过滤结果上，回车执行的就是一个和输入对不上的菜单项
        compositionend: () => {
          window.setTimeout(() => this.view && this.syncSlashMenu(), COMPOSITION_SETTLE_MS)
          return false
        },
        // 格式刷：拖选（鼠标 / 手指）松开、或 Shift+方向键选完松开 Shift 时落笔。等浏览器把选区更新完（下一轮任务）再读
        mouseup: () => {
          if (this.painter) window.setTimeout(() => this.paintSelection(), 0)
          return false
        },
        touchend: () => {
          if (this.painter) window.setTimeout(() => this.paintSelection(), 0)
          return false
        },
        keyup: (_view, event) => {
          if (this.painter && (event as KeyboardEvent).key === 'Shift') this.paintSelection()
          return false
        },
      },
    })
    // 关掉浏览器自带的图片 / 表格缩放手柄（Firefox 会给选中的图片画，调整后的大小不会存进文档，还和下面自己的手柄打架）。
    // 图片大小用我们自己的手柄调（imageNodeView：鼠标 / 触屏都能拖，只存宽度，保存后阅读、下载大小一致）。
    // 其它浏览器没有这个行为，调用失败也无妨
    try {
      document.execCommand('enableObjectResizing', false, 'false')
      document.execCommand('enableInlineTableEditing', false, 'false')
    } catch {
      /* 不支持就算了 */
    }

    el.classList.add('kb-text-surface')
    this.blockHandle = new BlockHandle({ view: () => this.view, isLocked: () => this.isLocked() })
    this.blockHandle.attach(this.view)
    this.quoteTools = new QuoteTools({
      view: () => this.view,
      comments: () => this.services()?.comments,
      notify: (message) => this.ctx?.textHost?.notify(message),
    })

    // 会话保存时回到这里取当前内容：未改动直接给原文，改动后才序列化。
    // 多人编辑不注册：正文由房间落地，本地整份提交会盖掉别人刚写的内容
    if (!rich) ctx.session.setSnapshotProvider?.(() => this.source())
    ctx.onDirtyChange?.(false)
    if (rich) this.watchCollab(rich)
    this.resolveTitles()
  }

  /** 页面服务（选择器 / 上传 / 链接体检）；没有桥时为 undefined，对应功能降级而不是报错 */
  private services() {
    return this.ctx?.textHost?.services
  }

  /** 是否处于不可编辑状态（只读或协同房间还没就绪）：装饰和输入拦截都按它判断 */
  private isLocked(): boolean {
    return this.readonlyFlag || this.collabLocked
  }

  /**
   * 依赖页面的插件（装饰、`[[` 触发与文件粘贴 / 拖入）。
   * 没有页面桥（单测、孤立使用）时只装装饰：它们对没有服务的情形已降级，且不会请求任何东西。
   */
  private pagePlugins(): Plugin[] {
    const plugins: Plugin[] = [
      scrollMarginPlugin(this.scrollMargin, this.scrollThreshold),
      textDecorations({ services: () => this.services(), readonly: () => this.isLocked(), titles: this.titles }),
      // 选区批注的高亮：只是装饰，不进文档 / 撤销栈 / 协同房间；页面没有评论栏时什么都不画
      quotePlugin({ comments: () => this.services()?.comments }),
      // AI 写作要改的那一段：高亮并随编辑映射位置（同样只是装饰）
      aiTargetPlugin(),
    ]
    if (this.ctx?.textHost) {
      const bridge = this.ctx.textHost
      plugins.push(
        inputPlugin({
          readonly: () => this.isLocked(),
          onFiles: (files, pos) => bridge.uploadFiles(files, pos),
          // `[[` 刚输入完：pos 在第二个 `[` 之后，面板需要 `[[` 的起点
          onWikilinkTrigger: (pos) => bridge.openPanel('wikilink', { from: pos - 2 }),
        }),
      )
    }
    return plugins
  }

  private setReserve(reserve: number, reveal: boolean): void {
    const margin = scrollMarginBottom(reserve)
    this.scrollMargin.bottom = margin
    this.scrollThreshold.bottom = reserve > 0 ? margin : 0
    const view = this.view
    if (!reveal || !view) return
    // 等保留高度写进 CSS 变量、正文底部留白生效后再滚
    requestAnimationFrame(() => {
      if (this.view !== view) return
      try {
        scrollRectIntoView(view.dom, view.coordsAtPos(view.state.selection.head), { scroller: overflowingAncestor(view.dom) })
      } catch {
        // 没有布局（隐藏的标签页）时无处可滚
      }
    })
  }

  /** 补取文档里还没有标题的双链，取回后重画装饰 */
  private resolveTitles(): void {
    const view = this.view
    if (!view) return
    this.titles.resolveMissing(view.state.doc, () => {
      if (this.view) refreshTextDecorations(this.view)
    })
  }

  /** 点击批注高亮：交给页面聚焦对应评论。选中了文字（拖选结束时也会触发 click）不算点高亮 */
  private quoteClicked(event: MouseEvent): void {
    const view = this.view
    const comments = this.services()?.comments
    if (!view || !comments) return
    const id = quoteIdAt(view, event.target)
    if (id && window.getSelection()?.isCollapsed !== false) comments.quoteClick(id)
  }

  /** 点击：链接 / 双链 / 附件卡片 */
  private followLink(event: MouseEvent): boolean {
    const services = this.services()
    if (!services || !(event.target instanceof HTMLElement)) return false
    const readonly = this.isLocked()
    const follow = readonly || event.ctrlKey || event.metaKey
    let result = resolveFollow(event.target, services, follow)
    if (!result.action) result = resolveExternalOpen(event.target, readonly)
    if (!result.action) return false
    if (result.preventDefault) event.preventDefault()
    const action = result.action
    if (action.type === 'openLink') services.openLink(action.id)
    else if (action.type === 'openAttachment') services.openAttachment(action.target)
    else if (action.type === 'openWindow') window.open(action.href, '_blank', 'noopener,noreferrer')
    else services.linkError(action.message)
    return true
  }

  /**
   * 多人编辑的插件：同步（Y.XmlFragment ⇄ 文档）、别人的光标、y 的撤销管理器。
   * y-prosemirror 与光标样式只在协同时动态加载，单人编辑的 chunk 不为它们付体积。
   */
  private async collabPlugins(rich: CollabRichLike): Promise<{ plugins: Plugin[]; history: HistoryBinding }> {
    const [y, cursor] = await Promise.all([import('y-prosemirror'), import('@/collab/cursor')])
    this.undoCommand = y.undo
    this.redoCommand = y.redo
    // 首次渲染前房间内容还没换上：锁住输入，直到房间说可写且同步过
    this.collabLocked = true
    return {
      plugins: [
        y.ySyncPlugin(rich.fragment as never, {
          // 首次把房间内容渲染进来之后，如果本连接被点名初始化（空房间），再把文件正文放进去。
          // y-prosemirror 在 EditorView 构造函数里同步调用它，那时 this.view 还没赋值，推到微任务里做
          onFirstRender: () => {
            queueMicrotask(() => {
              if (!this.view) return
              const pending = rich.getState().initMarkdown
              if (pending !== null) this.initRoom(rich, pending)
              this.applyCollabState(rich)
              this.ctx?.onContentChange?.()
            })
          },
        }),
        y.yCursorPlugin(rich.awareness as never, { cursorBuilder: cursor.buildCursor, selectionBuilder: cursor.buildSelection }),
        y.yUndoPlugin(),
      ],
      history: { undo: y.undo, redo: y.redo, plugin: null },
    }
  }

  /** 订阅房间状态（可写 / 同步）与「初始化」点名 */
  private watchCollab(rich: CollabRichLike): void {
    const offState = rich.subscribe(() => this.applyCollabState(rich))
    const offInit = rich.on('init', (markdown) => this.initRoom(rich, markdown))
    // 点头像跳到对方光标（CollabProvider 的 reveal 事件；契约里只声明了 init，实际连接还多这一个）
    const withReveal = rich as unknown as { on(event: 'reveal', listener: (payload: { head?: unknown }) => void): () => void }
    const offReveal = withReveal.on('reveal', (payload) => {
      // 防御：房间实现若不区分事件名，别的事件的载荷（init 的字符串）也会到这里
      if (payload && typeof payload === 'object' && 'head' in payload) void this.revealCursor(payload.head)
    })
    this.collabOff = () => {
      offState()
      offInit()
      offReveal()
      window.clearTimeout(this.revealTimer)
    }
  }

  /**
   * 点头像跳转：滚到对方光标所在位置，并让所有人的名牌重新亮几秒（平时 3 秒后收起，到了地方也找不到是谁的）。
   * 位置换算与 y-prosemirror 画对方光标时同一套：相对位置 → 文档位置，换不出来（对方的位置在已被删掉的内容里）就放弃。
   */
  private async revealCursor(head: unknown): Promise<void> {
    const view = this.view
    if (!view || !head) return
    const [{ ySyncPluginKey, relativePositionToAbsolutePosition }, Y, cursor] = await Promise.all([
      import('y-prosemirror'),
      import('yjs'),
      import('@/collab/cursor'),
    ])
    const sync = ySyncPluginKey.getState(view.state)
    if (!sync?.binding || this.view !== view) return
    const absolute = relativePositionToAbsolutePosition(sync.doc, sync.type, Y.createRelativePositionFromJSON(head), sync.binding.mapping)
    if (absolute === null) return
    const pos = Math.min(Math.max(absolute, 0), Math.max(view.state.doc.content.size - 1, 0))
    const { node } = view.domAtPos(pos)
    const target = node instanceof Element ? node : node.parentElement
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    target?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    const root = view.dom.parentElement
    if (!root) return
    root.classList.add('is-revealing')
    // 滚动之后名牌的位置变了，重新量一遍是否要翻到光标左边
    cursor.fitCursorLabels(root)
    window.clearTimeout(this.revealTimer)
    this.revealTimer = window.setTimeout(() => root.classList.remove('is-revealing'), 3500)
  }

  private applyCollabState(rich: CollabRichLike): void {
    const state = rich.getState()
    // 第一次同步成功之前（还没拿到内容）和只读时锁定；同步过之后断线仍可继续写，改动留在本地、恢复后自动合并
    const locked = !(state.writable && (state.ready || state.everSynced))
    if (locked === this.collabLocked) return
    this.collabLocked = locked
    this.view?.setProps({ editable: () => !this.readonlyFlag && !this.collabLocked })
    if (this.view) refreshTextDecorations(this.view)
  }

  /**
   * 初始化空房间：笔记第一次被协同打开时，服务端点名一条连接把现有正文放进去。
   * 只在房间确实是空的时候写——名单有误时也不会覆盖别人已经写的内容（与旧编辑器 applyTemplate 一致）。
   */
  private initRoom(rich: CollabRichLike, markdown: string): void {
    const view = this.view
    if (!view) return
    const fragment = rich.fragment as { length?: number }
    if (!fragment.length) {
      const parsed = parseMarkdown(markdown)
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.doc.content))
    }
    rich.initDone()
  }

  /** 同步取当前正文（落地调度用）：没改过回原文，改过才序列化 */
  textNow(): string {
    return this.serializeCurrent()
  }

  unmount(): void {
    this.painter = null
    this.collabOff?.()
    this.collabOff = null
    this.titles.dispose()
    this.quoteTools?.destroy()
    this.quoteTools = null
    this.blockHandle?.destroy()
    this.blockHandle = null
    this.sourceEl?.remove()
    this.sourceEl = null
    this.ctx?.session.setSnapshotProvider?.(null)
    this.view?.dom.parentElement?.classList.remove('kb-text-surface')
    this.removeSlashMenu()
    this.view?.destroy()
    this.view = null
    this.ctx = null
  }

  resize(_size: Size): void {
    // 文本面是流式布局，尺寸变化由 CSS 处理；保留接口以满足 Surface 契约
  }

  focus(): void {
    if (this.sourceEl) this.sourceEl.focus()
    else this.view?.focus()
  }

  setReadonly(value: boolean): void {
    this.readonlyFlag = value
    if (!this.view) return
    // 变成只读时退出源码模式（文本框不该继续可编辑）
    if (value && this.sourceEl) this.leaveSource()
    this.view.setProps({ editable: () => !this.readonlyFlag && !this.collabLocked })
    // 装饰在只读 / 可编辑下不一样（双链显示标题还是原文、附件卡片的 📎）
    refreshTextDecorations(this.view)
  }

  async command(command: EditorCommand): Promise<CommandResult> {
    const view = this.view
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    // 源码模式下查找替换作用在看不见的文档上，没有意义：说明原因而不是静默改了隐藏的文档
    if (this.sourceEl && command.type.startsWith('search.') && command.type !== 'search.close') {
      return { ok: false, reason: '源码模式下不能查找替换，请先切回所见即所得' }
    }
    switch (command.type) {
      case 'view.focus':
        if (this.sourceEl) this.sourceEl.focus()
        else view.focus()
        return { ok: true }
      case 'view.toggleSource':
        return this.sourceEl ? this.leaveSource() : this.enterSource()
      case 'view.selectAll':
        view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)))
        return { ok: true }
      case 'view.alignBlock':
        return this.alignBlock(command.args as AlignBlockArgs | undefined)
      case 'undo':
        return this.run(this.undoCommand)
      case 'redo':
        return this.run(this.redoCommand)
      case 'text.insert': {
        const args = command.args as { text?: string } | undefined
        const inserted = args?.text ?? ''
        if (!inserted) return { ok: false, reason: 'empty_text' }
        view.dispatch(view.state.tr.insertText(inserted))
        return { ok: true }
      }
      case 'text.replaceAll': {
        const args = command.args as { text?: string } | undefined
        if (typeof args?.text !== 'string') return { ok: false, reason: 'missing_text' }
        const next = parseMarkdown(args.text)
        view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, next.doc.content))
        return { ok: true }
      }
      case 'mark.toggle':
        return this.run(toggleInlineMark(textSchema.marks[String((command.args as { mark?: string } | undefined)?.mark)]))
      case 'text.clearFormat': {
        const result = this.run(clearFormatting(textSchema))
        return result.ok ? result : { ok: false, reason: view.state.selection.empty ? '先选中要清除格式的文字' : '选中的文字没有可清除的格式' }
      }
      case 'text.formatPainter':
        return this.togglePainter((command.args as { sticky?: boolean } | undefined)?.sticky === true)
      case 'block.setHeading':
        return this.run(setHeadingLevel(textSchema, Number((command.args as { level?: number } | undefined)?.level ?? 0)))
      case 'block.toggleBlockquote':
        return this.run(toggleBlockquote(textSchema))
      case 'block.toggleBulletList':
        return this.run(toggleListKind(textSchema, 'bullet_list'))
      case 'block.toggleOrderedList':
        return this.run(toggleListKind(textSchema, 'ordered_list'))
      case 'block.toggleTaskList':
        return this.run(toggleTaskList(textSchema))
      case 'block.insertTable': {
        const args = command.args as { rows?: number; cols?: number } | undefined
        return this.run(insertTable(textSchema, args?.rows ?? 3, args?.cols ?? 3))
      }
      case 'block.insertHr':
        return this.run(insertHorizontalRule(textSchema))
      case 'block.insertCodeBlock':
        return this.run(setBlockType(textSchema.nodes.code_block))
      case 'text.link.apply': {
        const href = (command.args as { href?: string } | undefined)?.href ?? ''
        return this.run(setLink(textSchema, href))
      }
      case 'insert.image': {
        const args = command.args as { src?: string; alt?: string } | undefined
        return this.run(insertImageNode(textSchema, args?.src ?? '', args?.alt ?? ''))
      }
      case 'nav.anchor': {
        const anchor = (command.args as { anchor?: Anchor } | undefined)?.anchor
        if (!anchor) return { ok: false, reason: 'missing_anchor' }
        return this.selectAnchor(anchor)
      }
      case 'search.set':
        return { ok: true, data: this.setFind(String((command.args as { query?: string } | undefined)?.query ?? ''), command.args) }
      case 'search.next':
        return { ok: true, data: this.stepFind(command.args, 1) }
      case 'search.prev':
        return { ok: true, data: this.stepFind(command.args, -1) }
      case 'search.replace':
        return this.replaceCurrent(String((command.args as { text?: string } | undefined)?.text ?? ''))
      case 'search.replaceAll':
        return this.replaceAll(String((command.args as { text?: string } | undefined)?.text ?? ''))
      case 'search.close':
        this.findQuery = ''
        view.dispatch(withFindState(view.state.tr, EMPTY_FIND))
        return { ok: true }
      case 'slash.run':
        return this.runSlash(String((command.args as { id?: string } | undefined)?.id ?? ''))
      case 'block.insertCallout':
        return this.run(insertCallout(textSchema, String((command.args as { type?: string } | undefined)?.type ?? 'note') as CalloutType))
      case 'block.insertDiagram':
        return this.run(insertDiagram(textSchema))
      case 'block.insertMath':
        return this.run(insertMathBlock(textSchema))
      case 'mark.color': {
        const args = command.args as { prop?: ColorProp; key?: string | null } | undefined
        const result = this.run(setColor(textSchema, args?.prop ?? 'color', args?.key ?? null))
        return result.ok ? result : { ok: false, reason: '先选中要上色的文字' }
      }
      case 'view.reserve': {
        // 贴键盘的工具栏 / 底部面板盖住了内容底部这么多：光标滚动让出位置；面板刚出现或变高时把光标滚到它上面
        const args = command.args as { reserve?: number; reveal?: boolean } | undefined
        this.setReserve(Math.max(0, Number(args?.reserve) || 0), args?.reveal === true)
        return { ok: true }
      }
      case 'text.refresh':
        // 页面数据（链接体检 / 集合列表）异步回来了：重画装饰，并补取新出现的双链标题
        refreshTextDecorations(view)
        this.resolveTitles()
        return { ok: true }
      case 'text.quotes.refresh':
        // 页面的评论列表 / 聚焦项变了：高亮重算（不改文档），浮钮也按页面能不能评论重新判断
        refreshQuotes(view)
        this.quoteTools?.update()
        return { ok: true }
      case 'view.revealQuote': {
        const id = String((command.args as { id?: string } | undefined)?.id ?? '')
        return revealQuote(view, id) ? { ok: true } : { ok: false, reason: 'anchor_lost' }
      }
      case 'text.replaceHref': {
        const args = command.args as { oldHref?: string; newHref?: string } | undefined
        return this.replaceHref(args?.oldHref ?? '', args?.newHref ?? '')
      }
      case 'text.wikilink.insert':
        return this.insertWikilink(command.args as { from?: number; id?: string; title?: string } | undefined)
      case 'text.markdown.insert':
        return this.insertMarkdown(command.args as { markdown?: string; pos?: number } | undefined)
      case 'text.ai.open':
        // 斜杠菜单的 AI 项：交给 Host 打开工具栏下面的 AI 写作条（runSlash 已经删掉了 `/查询`）
        if (!this.ctx?.textHost?.openAi || !this.ctx.textHost.aiAvailable?.()) return { ok: false, reason: '这里没有接入 AI 写作' }
        this.ctx.textHost.openAi({ action: (command.args as { action?: AiWriteAction } | undefined)?.action })
        return { ok: true }
      case 'text.locate':
        return this.locateText(String((command.args as { text?: string } | undefined)?.text ?? ''))
      case 'text.ai.mark':
        return this.markAiTarget()
      case 'text.ai.apply':
        return this.applyAi(command.args as { markdown?: string; mode?: AiApplyMode } | undefined)
      case 'text.ai.clear':
        if (aiTargetOf(view.state)) view.dispatch(setAiTarget(view.state.tr, null))
        return { ok: true }
      case 'table.addRow':
        return this.run(addRow(textSchema, (command.args as { where?: string } | undefined)?.where === 'before' ? 'before' : 'after'))
      case 'table.addColumn':
        return this.run(addColumn(textSchema, (command.args as { where?: string } | undefined)?.where === 'before' ? 'before' : 'after'))
      case 'table.deleteRow':
        return this.run(deleteRow())
      case 'table.deleteColumn':
        return this.run(deleteColumn(textSchema))
      case 'table.delete':
        return this.run(deleteTable(textSchema))
      case 'table.align': {
        const align = (command.args as { align?: string } | undefined)?.align
        return this.run(setColumnAlignment(align === 'left' || align === 'center' || align === 'right' ? align : null))
      }
      case 'text.math.inline':
        return this.insertInlineMath()
      case 'text.link.open-href': {
        const href = (command.args as { href?: string } | undefined)?.href ?? ''
        // 外链新窗口打开；站内链接按点击跟随的规则走（Ctrl 点击同一条路径），这里只处理 http(s)
        if (!/^https?:/i.test(href) || !isSafeHref(href)) return { ok: false, reason: '只能在新窗口打开 http(s) 链接' }
        window.open(href, '_blank', 'noopener,noreferrer')
        return { ok: true }
      }
      case 'text.panel.open': {
        // 工具栏 / 斜杠菜单 / 插入下拉打开 Host 侧面板（选择器、文件选择）；没有页面桥的场景（单测、别处复用）如实说明
        const panel = (command.args as { panel?: TextPanelName } | undefined)?.panel
        const bridge = this.ctx?.textHost
        if (!panel || !bridge) return { ok: false, reason: '这里不能使用该功能' }
        bridge.openPanel(panel)
        return { ok: true }
      }
      case 'text.task.toggle': {
        const pos = Number((command.args as { pos?: number } | undefined)?.pos)
        return Number.isFinite(pos) ? this.run(toggleTaskItemAt(pos)) : { ok: false, reason: 'missing_pos' }
      }
      default:
        // 斜杠菜单里的扩展命令不经过 Host 的命令总线，先问扩展再报不支持
        return this.ctx?.runExtensionCommand?.(command.type, command.args) ?? { ok: false, reason: `unsupported_command:${command.type}` }
    }
  }

  async query(query: SurfaceQuery): Promise<unknown> {
    const view = this.view
    if (!view) return null
    switch (query.type) {
      case 'wordCount':
        // 按保存出来的 Markdown 计，和页头 / 阅读态同一个口径；没改过时 serializeCurrent 直接回原文，不序列化
        return { words: countWords(this.serializeCurrent()), unitLabel: '' }
      case 'outline':
        return this.outline()
      case 'selection':
        return selectionFromState(view.state)
      case 'viewAnchor': {
        // 阅读也用编辑器外壳时（Markdown 文件开着批注）的阅读 → 编辑交接：记下屏幕上正看着的那一块，换成可编辑的外壳后按它对齐
        const args = query.args as { top?: number; point?: { x: number; y: number } } | undefined
        return this.viewAnchor(args?.top ?? 0, args?.point)
      }
      case 'selectionText': {
        // 完整的选区文字（跨块用换行连接）：Selection.text 只带起始块里的那一段，扩展 / AI 工具要的是整段
        const { from, to } = view.state.selection
        return from === to ? '' : view.state.doc.textBetween(from, to, '\n', '\n')
      }
      case 'formatState':
        return this.formatState()
      case 'search':
        return this.findInfo()
      case 'slash':
        return this.slashInfo()
      case 'caret': {
        // 光标位置与屏幕坐标：选择器贴着光标弹出；没有布局（jsdom、隐藏的标签页）时坐标为 0
        const pos = view.state.selection.from
        try {
          // 光标可能在屏幕外（用户滚走了再点工具栏）：先滚进视野，选择器才能贴着它弹出而不是落在屏幕外
          view.dispatch(view.state.tr.scrollIntoView())
          const rect = view.coordsAtPos(pos)
          return { pos, left: rect.left, top: rect.top, bottom: rect.bottom }
        } catch {
          return { pos, left: 0, top: 0, bottom: 0 }
        }
      }
      case 'quotes':
        // 现在正文里找得到的批注：评论 id + 统一锚点（找不到的不在其中 = 原文已改动）
        return locatedQuotes(view.state, this.services()?.comments?.quotes() ?? [])
      case 'link': {
        // 光标所在的链接（Chrome 的链接条回填地址用）
        const found = linkAtSelection(view.state)
        return found ? { href: found.href } : null
      }
      case 'text':
        return this.serializeCurrent()
      case 'anchorRect': {
        const anchor = (query.args as { anchor?: Anchor } | undefined)?.anchor
        if (!anchor) return null
        return this.anchorRect(anchor)
      }
      default:
        return null
    }
  }

  capture(): SurfaceState {
    const view = this.view
    if (!view) return { kind: 'text' }
    return {
      kind: 'text',
      scrollTop: view.dom.scrollTop,
      selection: selectionFromState(view.state),
    }
  }

  restore(state: SurfaceState): void {
    const view = this.view
    if (!view) return
    if (state.selection?.anchor) {
      const range = rangeFromAnchor(view.state.doc, state.selection.anchor)
      if (range) {
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)))
      }
    }
    if (typeof state.scrollTop === 'number') view.dom.scrollTop = state.scrollTop
  }

  /** 当前内容的保存形态（供 Session.snapshot 使用） */
  private source(): EditorSource | null {
    return { kind: 'text', text: this.serializeCurrent(), name: this.name }
  }

  /**
   * 保真快速路径：文档没改过就回写原文。
   * 这样「打开 → 保存」在字节层面完全相同，git 里不会出现格式规范化噪音。
   */
  private serializeCurrent(): string {
    const view = this.view
    // 源码模式下用户正在改的就是正文本身（多人编辑除外：房间里的才是真源，退出源码时才写回房间）
    if (this.sourceEl && !this.ctx?.collabRich) return this.sourceText
    if (!view || !this.initialDoc) return this.originalText
    if (view.state.doc.eq(this.initialDoc)) return this.originalText
    return serializeMarkdown(view.state.doc, { frontmatter: this.frontmatter, eol: this.eol })
  }

  /**
   * 阅读 → 编辑交接（DocPage 发来）：在顶层块里按文字找到阅读页上正看着的那一块（第 occurrence 次出现的），
   * 把它滚到离视口顶 top 的位置（不高于 minTop：吸顶的工具栏下面），光标放到双击的位置或这一块开头，并聚焦。
   * 只滚动、不改文档；找不到那一块就如实返回失败，位置保持原样
   */
  private alignBlock(args: AlignBlockArgs | undefined): CommandResult {
    const view = this.view
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    const want = blockKey(args?.key ?? '')
    if (!args || !want) return { ok: false, reason: 'missing_key' }
    let seen = 0
    let found: { pos: number; node: PMNode } | null = null
    view.state.doc.forEach((node, offset) => {
      if (found || !blockKeysMatch(blockKey(node.textContent), want)) return
      if (seen === (args.occurrence ?? 0)) found = { pos: offset, node }
      seen += 1
    })
    const target = found as { pos: number; node: PMNode } | null
    const dom = target ? view.nodeDOM(target.pos) : null
    if (!target || !(dom instanceof HTMLElement)) return { ok: false, reason: 'anchor_lost' }
    const desired = Math.max(args.top, args.minTop ?? Number.NEGATIVE_INFINITY)
    const delta = dom.getBoundingClientRect().top - desired
    if (Math.abs(delta) >= 1) {
      const scroller = overflowingAncestor(view.dom)
      if (scroller) scroller.scrollTop += delta
      else window.scrollBy(0, delta)
    }
    let pos = target.pos + 1
    if (args.caret) {
      // 那一块被挪下来多少（躲吸顶工具栏），双击的点也跟着挪多少；块里的排版和阅读页一样，同一个点就是同一个字
      const hit = view.posAtCoords({ left: args.caret.x, top: args.caret.y + (desired - args.top) })
      if (hit && hit.pos > target.pos && hit.pos < target.pos + target.node.nodeSize) pos = hit.pos
    }
    const selection = TextSelection.near(view.state.doc.resolve(Math.min(pos, view.state.doc.content.size)))
    // 不带 scrollIntoView：位置已经对好了，再滚一次会把刚对齐的那一块推走
    view.dispatch(view.state.tr.setSelection(selection))
    view.focus()
    return { ok: true }
  }

  /**
   * 屏幕上正看着的那一块（alignBlock 的反面）：给了双击点就是点中的那块，否则是视口里（top 以下）第一块有文字的块。
   * 只读不改；块认不出来（没有文字）返回 null
   */
  private viewAnchor(top: number, point?: { x: number; y: number }): AlignBlockArgs | null {
    const view = this.view
    if (!view) return null
    const entries: { pos: number; key: string }[] = []
    view.state.doc.forEach((node, offset) => entries.push({ pos: offset, key: blockKey(node.textContent) }))
    const planFor = (index: number, caret?: { x: number; y: number }): AlignBlockArgs | null => {
      const entry = entries[index]
      const dom = entry ? view.nodeDOM(entry.pos) : null
      if (!entry || !entry.key || !(dom instanceof HTMLElement)) return null
      const occurrence = entries.slice(0, index).filter((other) => blockKeysMatch(other.key, entry.key)).length
      return { key: entry.key, occurrence, top: dom.getBoundingClientRect().top, ...(caret ? { caret } : {}) }
    }
    if (point) {
      const hit = view.posAtCoords({ left: point.x, top: point.y })
      const plan = hit ? planFor(view.state.doc.resolve(hit.pos).index(0), point) : null
      if (plan) return plan
    }
    const bottom = window.innerHeight
    let partial = -1
    for (let index = 0; index < entries.length; index += 1) {
      const dom = view.nodeDOM(entries[index]!.pos)
      if (!(dom instanceof HTMLElement)) continue
      const rect = dom.getBoundingClientRect()
      if (rect.bottom <= top) continue
      if (rect.top >= bottom) break
      if (!entries[index]!.key) continue
      if (rect.top >= top - 1) return planFor(index)
      if (partial < 0) partial = index
    }
    return partial >= 0 ? planFor(partial) : null
  }

  /** 跳到某个文本锚点（目录 / 评论 / AI 引用共用）；锚点失效时如实返回失败 */
  private selectAnchor(anchor: Anchor): CommandResult {
    const view = this.view
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    // 带 quote 的锚点（批注）在正文被改过后按文字重新定位；不带的（目录、搜索命中）按块路径
    const range = resolveAnchorRange(view.state.doc, anchor)
    if (!range) return { ok: false, reason: 'anchor_lost' }
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to))
    view.dispatch(tr.scrollIntoView())
    view.focus()
    return { ok: true }
  }

  /** 当前格式状态：工具栏高亮与「只读时禁用」都读它 */
  private formatState(): {
    marks: string[]
    block: string
    level?: number
    inBlockquote: boolean
    lists: { bullet: boolean; ordered: boolean; task: boolean }
    inTable: boolean
    toggles: string[]
    /** 光标 / 选区开头的字体、字色、底色（调色板的 key，没有是 null）：下拉菜单据此打勾，颜色按钮据此显示当前色 */
    values: Record<string, string | null>
  } {
    const view = this.view
    if (!view) return { marks: [], block: 'paragraph', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, inTable: false, toggles: [], values: {} }
    const state = view.state
    const block = currentBlock(state, textSchema)
    const { $from } = state.selection
    let task = false
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const node = $from.node(depth)
      if (node.type === textSchema.nodes.list_item && node.attrs.checked != null) {
        task = true
        break
      }
    }
    return {
      marks: activeMarks(state),
      block: block.type,
      level: block.level,
      inBlockquote: isInNode(state, textSchema.nodes.blockquote),
      lists: {
        bullet: isInNode(state, textSchema.nodes.bullet_list),
        ordered: isInNode(state, textSchema.nodes.ordered_list),
        task,
      },
      inTable: isInTable(state),
      toggles: [...(this.sourceEl ? ['source'] : []), ...(this.painter ? ['painter'] : [])],
      values: styleValues(state),
    }
  }

  /** 重新计算命中并把第 index 条选中；index 越界时收敛到区间内 */
  private refreshFind(index = 0): TextFindInfo {
    const view = this.view
    if (!view) return { query: this.findQuery, total: 0, index: -1 }
    const matches = findMatches(view.state.doc, this.findQuery, this.findCaseSensitive)
    const next = matches.length ? Math.max(0, Math.min(matches.length - 1, index)) : -1
    const tr = withFindState(view.state.tr, { matches, index: next })
    const match = matches[next]
    if (match) tr.setSelection(TextSelection.create(tr.doc, match.from, match.to)).scrollIntoView()
    view.dispatch(tr)
    return { query: this.findQuery, total: matches.length, index: next }
  }

  /** 查找：设置查询串并选中第一条；空串等于关闭 */
  private setFind(query: string, args?: unknown): TextFindInfo {
    this.findCaseSensitive = !!(args as { caseSensitive?: boolean } | undefined)?.caseSensitive
    this.findQuery = query
    if (!query.trim()) {
      const view = this.view
      if (view) view.dispatch(withFindState(view.state.tr, EMPTY_FIND))
      return { query, total: 0, index: -1 }
    }
    return this.refreshFind(0)
  }

  /** 上/下一个命中；没有当前命中时按方向从两端进入 */
  private stepFind(args: unknown, direction: 1 | -1): TextFindInfo {
    const view = this.view
    if (!view || !this.findQuery) return { query: this.findQuery, total: 0, index: -1 }
    const matches = findMatches(view.state.doc, this.findQuery, this.findCaseSensitive)
    if (matches.length === 0) {
      view.dispatch(withFindState(view.state.tr, EMPTY_FIND))
      return { query: this.findQuery, total: 0, index: -1 }
    }
    const current = readFindState(view.state).index
    const index =
      current < 0 ? (direction > 0 ? 0 : matches.length - 1) : (current + direction + matches.length) % matches.length
    void args
    void matches
    return this.refreshFind(index)
  }

  private findInfo(): TextFindInfo {
    const view = this.view
    if (!view) return { query: this.findQuery, total: 0, index: -1 }
    const plugin = readFindState(view.state)
    return { query: this.findQuery, total: plugin.matches.length, index: plugin.index }
  }

  /** 替换当前命中；替换后自动跳到下一条，连续点「替换」可以一路替换下去 */
  private replaceCurrent(text: string): CommandResult {
    const view = this.view
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    const { matches, index } = readFindState(view.state)
    const match = matches[index]
    if (!match) return { ok: false, reason: 'no_match' }
    const tr = view.state.tr
    if (text) tr.replaceWith(match.from, match.to, textSchema.text(text))
    else tr.delete(match.from, match.to)
    view.dispatch(tr)
    return { ok: true, data: this.refreshFind(index) }
  }

  /** 全部替换；顺序从后往前，避免前面的改动把后面的位置推乱 */
  private replaceAll(text: string): CommandResult {
    const view = this.view
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    const matches = findMatches(view.state.doc, this.findQuery, this.findCaseSensitive)
    if (matches.length === 0) return { ok: false, reason: 'no_match' }
    const tr = view.state.tr
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const match = matches[i]
      if (!match) continue
      if (text) tr.replaceWith(match.from, match.to, textSchema.text(text))
      else tr.delete(match.from, match.to)
    }
    view.dispatch(tr)
    return { ok: true, data: this.refreshFind(0) }
  }

  /**
   * 斜杠菜单状态：只有「空块里以 `/` 开头、且光标在行尾」才激活。
   * 这样正文里的 `/路径`、`a/b` 之类不会突然弹出菜单。
   */
  private slashInfo(): { active: boolean; query: string; items: EditorAction[]; groups: SlashGroup[] } {
    const inactive = { active: false, query: '', items: [], groups: [] }
    const view = this.view
    const configured = this.options.slashActions
    const listed = typeof configured === 'function' ? configured() : configured
    // AI 项只在页面接了 AI 写作时出现（AI 总开关关了、没有 AI 助手功能、分享页都不显示）
    const ai = !!this.ctx?.textHost?.aiAvailable?.()
    const actions = ai ? listed : listed?.filter((action) => action.command !== 'text.ai.open')
    if (!view || !actions || this.ctx?.readonly) return inactive
    const state = view.state
    const { $from, empty } = state.selection
    if (!empty || !$from.parent.isTextblock) return inactive
    // 只认「在块末尾打 /」：正文中间打斜杠是在写路径，不该跳菜单
    if ($from.parentOffset !== $from.parent.content.size) return inactive
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
    // 中文标点状态下按 `/` 键打出来的是顿号「、」（全角模式是「／」）：段首的顿号同样唤出菜单，不用先切英文。
    // 中文正文不会以顿号开头，只认段首不会误触发
    const match = /^[/、／](\S*)$/.exec(before)
    if (!match) {
      // 已经离开了 `/` 触发的块：解除 Esc 的抑制，下次再打 `/` 还能唤出菜单
      this.slashDismissed = false
      return inactive
    }
    if (this.slashDismissed) return inactive
    const query = match[1] ?? ''
    // 有查询词：按命中程度排成一列（回车选最像的）；没有：分组浏览，常用的在前，最近用过的放最上面
    if (query) return { active: true, query, items: filterSlashActions(query, actions), groups: [] }
    const groups = groupSlashActions(actions, recentSlashIds())
    return { active: true, query, items: groups.flatMap((group) => group.items), groups }
  }

  /** 执行斜杠菜单项：先删掉 `/查询`，再跑对应命令（失败时不再把文字吞掉） */
  private async runSlash(id: string): Promise<CommandResult> {
    const view = this.view
    const info = this.slashInfo()
    if (!view || !info.active) return { ok: false, reason: 'slash_inactive' }
    const action = info.items.find((item) => item.id === id)
    if (!action) return { ok: false, reason: 'slash_unknown' }
    const { $from } = view.state.selection
    view.dispatch(view.state.tr.delete($from.start(), $from.pos))
    const result = await this.command({ id: `slash_${id}`, type: action.command, args: action.args, source: 'user' })
    if (result.ok) recordSlashUse(id)
    return result
  }

  /**
   * 斜杠菜单的 DOM 同步：菜单只在「光标在空块里打了 /」时出现，
   * 位置取光标坐标（视口坐标 + 固定定位），超出右边界时向左收。
   */
  private syncSlashMenu(): void {
    const view = this.view
    if (!view) return
    const info = this.slashInfo()
    if (!info.active || info.items.length === 0) {
      this.removeSlashMenu()
      return
    }
    if (this.slashQuery !== info.query) {
      this.slashQuery = info.query
      this.slashIndex = 0
    }
    this.slashIndex = Math.min(this.slashIndex, info.items.length - 1)
    const doc = view.dom.ownerDocument
    if (!this.slashEl) {
      const el = doc.createElement('div')
      el.className = 'kb-slash-menu'
      el.setAttribute('role', 'listbox')
      el.setAttribute('aria-label', '插入命令')
      el.dataset.testid = 'editor-slash-menu'
      el.addEventListener('mousedown', (event) => event.preventDefault())
      view.dom.parentElement?.appendChild(el)
      this.slashEl = el
    }
    const el = this.slashEl
    el.textContent = ''
    let index = 0
    const option = (item: EditorAction): HTMLButtonElement => {
      const at = index++
      const button = doc.createElement('button')
      button.type = 'button'
      button.className = at === this.slashIndex ? 'kb-slash-item is-active' : 'kb-slash-item'
      button.dataset.slashId = item.id
      button.setAttribute('role', 'option')
      button.setAttribute('aria-selected', String(at === this.slashIndex))
      const label = doc.createElement('span')
      label.className = 'kb-slash-label'
      label.textContent = item.label
      button.append(slashIcon(doc, item), label)
      const hint = SLASH_MARKDOWN_HINTS[item.id]
      if (hint) {
        const keys = doc.createElement('span')
        keys.className = 'kb-slash-hint'
        keys.setAttribute('aria-hidden', 'true')
        keys.textContent = hint
        button.append(keys)
      }
      button.addEventListener('click', () => {
        void this.command({ id: `slash_${item.id}`, type: 'slash.run', args: { id: item.id }, source: 'user' })
        view.focus()
      })
      return button
    }
    if (info.groups.length) {
      // 分组：每组一个 role=group，组名给读屏（aria-labelledby），选项仍按出现顺序编号，方向键在组之间连续走
      for (const group of info.groups) {
        const box = doc.createElement('div')
        box.className = 'kb-slash-group'
        box.setAttribute('role', 'group')
        const title = doc.createElement('div')
        title.className = 'kb-slash-group-label'
        title.id = `kb-slash-group-${++slashGroupSeq}`
        title.textContent = group.label
        box.setAttribute('aria-labelledby', title.id)
        box.append(title, ...group.items.map(option))
        el.appendChild(box)
      }
    } else {
      for (const item of info.items) el.appendChild(option(item))
    }
    // 方向键走到菜单可视区外时把当前项滚进来（菜单有最大高度、自己滚动）；要在定好位置之后做
    const revealActive = () => el.querySelector<HTMLElement>('.kb-slash-item.is-active')?.scrollIntoView?.({ block: 'nearest' })
    // 手机（宽 <600 或触屏）：跟着光标的浮层会被键盘盖住或溢出屏幕，改成贴键盘上沿的底部面板（样式见 textSurface.css .is-sheet）。
    // 不抢焦点：面板只是样式变化，编辑器的键盘不收起
    const sheet = !this.isLocked() && menusAsSheet({ width: window.innerWidth, coarse: typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches })
    el.classList.toggle('is-sheet', sheet)
    if (sheet) {
      el.style.left = ''
      el.style.top = ''
      this.ctx?.onSheetHeight?.(Math.round(el.getBoundingClientRect().height))
      revealActive()
      return
    }
    const coords = view.coordsAtPos(view.state.selection.from)
    const docWidth = doc.documentElement.clientWidth || 1024
    // 与 textSurface.css 里 .kb-slash-menu 的宽度一致（右边放不下时按它向左收）
    const width = 264
    el.style.left = `${Math.max(8, Math.min(coords.left, docWidth - width - 8))}px`
    // 光标在窗口下半部分时下方放不下：翻到光标上方；最后夹进视口（菜单项要点得到）
    const height = el.getBoundingClientRect().height
    const limit = (window.innerHeight || doc.documentElement.clientHeight) - 8
    let top = coords.bottom + 6
    if (height && top + height > limit) top = coords.top - 6 - height
    el.style.top = `${height ? Math.max(8, Math.min(top, limit - height)) : top}px`
    revealActive()
  }

  private removeSlashMenu(): void {
    if (this.slashEl) this.ctx?.onSheetHeight?.(0)
    this.slashEl?.remove()
    this.slashEl = null
    this.slashQuery = ''
    this.slashIndex = 0
  }

  /** 菜单打开时接管方向键/回车/Esc；不在菜单里就一律放行，不吞按键 */
  private handleKeyDown(_view: EditorView, event: KeyboardEvent): boolean {
    // 格式刷开着时 Esc 先退出格式刷（和 Word 一样），不往下传
    if (this.painter && event.key === 'Escape' && !event.isComposing) {
      event.preventDefault()
      this.stopPainter()
      return true
    }
    if (!this.slashEl) return false
    // 输入法组字：回车 = 上屏、方向键 = 选词、Esc = 取消组字，都不是菜单的命令
    // （旧编辑器的斜杠菜单监听在 window 上，要自己拦；这里 ProseMirror 组字中本就不调 handleKeyDown，再兜一层防 Safari 的上屏回车晚到）
    if (event.isComposing || event.keyCode === 229) return false
    const info = this.slashInfo()
    if (!info.active || info.items.length === 0) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      this.slashIndex = (this.slashIndex + delta + info.items.length) % info.items.length
      this.syncSlashMenu()
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const item = info.items[this.slashIndex]
      if (!item) return false
      event.preventDefault()
      void this.command({ id: `slash_${item.id}`, type: 'slash.run', args: { id: item.id }, source: 'user' })
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      this.slashDismissed = true
      this.removeSlashMenu()
      return true
    }
    return false
  }

  /** 进入源码模式：隐藏所见即所得，换成一个等宽文本框编辑 Markdown 源码 */
  private enterSource(): CommandResult {
    const view = this.view
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    if (this.isLocked()) return { ok: false, reason: '文档当前不可编辑' }
    this.removeSlashMenu()
    const text = this.serializeCurrent()
    this.sourceEntered = text
    this.sourceText = text
    const area = view.dom.ownerDocument.createElement('textarea')
    area.className = 'kb-text-source'
    area.value = text
    area.spellcheck = false
    area.setAttribute('aria-label', 'Markdown 源码')
    area.dataset.testid = 'text-source'
    area.addEventListener('input', () => {
      this.sourceText = area.value
      if (this.ctx?.collabRich) return
      this.ctx?.onDirtyChange?.(area.value !== this.originalText)
    })
    // 文本框有自己的撤销栈：Host 的 Ctrl+Z / Ctrl+Y / Ctrl+F 快捷键别抢（保存仍交给 Host）
    area.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && ['z', 'y', 'f'].includes(event.key.toLowerCase())) event.stopPropagation()
    })
    view.dom.style.display = 'none'
    view.dom.parentElement?.appendChild(area)
    this.sourceEl = area
    area.focus()
    return { ok: true }
  }

  /** 退出源码模式：改过就按新源码重建文档（一次可撤销的整篇替换），没改过原样回去 */
  private leaveSource(): CommandResult {
    const view = this.view
    const area = this.sourceEl
    if (!view || !area) return { ok: false, reason: 'not_in_source_mode' }
    const text = area.value
    area.remove()
    this.sourceEl = null
    view.dom.style.display = ''
    if (text !== this.sourceEntered) {
      const parsed = parseMarkdown(text)
      this.frontmatter = parsed.frontmatter
      this.eol = parsed.eol
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.doc.content))
    }
    view.focus()
    return { ok: true }
  }

  /** 选区变成行内公式 `$…$`（选区文字就是公式源码）；与旧编辑器选区工具栏的“行内公式”一致 */
  private insertInlineMath(): CommandResult {
    const view = this.view
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    const { from, to, empty } = view.state.selection
    if (empty) return { ok: false, reason: '先选中公式的内容' }
    const value = view.state.doc.textBetween(from, to).trim()
    if (!value) return { ok: false, reason: '先选中公式的内容' }
    view.dispatch(view.state.tr.replaceSelectionWith(textSchema.nodes.math_inline.create({ value })).scrollIntoView())
    return { ok: true }
  }

  /** 把引用笔记选择器选中的笔记写成 `[[id|标题]]`，替换掉刚输入的 `[[` */
  private insertWikilink(args: { from?: number; id?: string; title?: string } | undefined): CommandResult {
    const view = this.view
    const id = args?.id?.trim()
    if (!view || !id) return { ok: false, reason: 'missing_id' }
    const title = (args?.title ?? '').replace(/[[\]|\n]/g, ' ').trim()
    const text = `[[${id}${title ? `|${title}` : ''}]] `
    const { state } = view
    const from = args?.from
    const to = state.selection.from
    // 确认 from 处还是 `[[`（期间用户可能挪了光标）
    const intact = from !== undefined && state.doc.textBetween(Math.max(0, from), Math.min(state.doc.content.size, from + 2)) === '[['
    view.dispatch(intact ? state.tr.insertText(text, from, Math.max(from + 2, to)) : state.tr.insertText(text))
    this.titles.remember(id, title)
    view.focus()
    return { ok: true }
  }

  /** 把一段 Markdown（上传结果、文件引用）解析后作为块插到光标处；pos 给定时先把光标放过去 */
  private insertMarkdown(args: { markdown?: string; pos?: number } | undefined): CommandResult {
    const view = this.view
    const markdown = args?.markdown ?? ''
    if (!view || !markdown.trim()) return { ok: false, reason: 'empty_markdown' }
    if (typeof args?.pos === 'number') {
      const safe = Math.min(Math.max(0, args.pos), view.state.doc.content.size)
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(safe))))
    }
    const nodes: PMNode[] = []
    parseMarkdown(markdown).doc.forEach((child) => nodes.push(child))
    const result = this.run(insertBlocks(textSchema, nodes))
    view.focus()
    return result
  }

  /**
   * 在正文里找一段文字并选中、滚过去（AI 修改建议的「在正文里找到」）。只在单个文本块里找
   * （跨段的原文在页面上传进来时已经只取第一行，见 utils/locateText.ts）；只读也能用（只动选区）。
   */
  private locateText(needle: string): CommandResult {
    const view = this.view
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    if (!needle) return { ok: false, reason: '没有要找的文字' }
    let found: { from: number; to: number } | null = null
    view.state.doc.descendants((node, pos) => {
      if (found) return false
      if (!node.isTextblock) return true
      // 行内的非文字节点（图片、换行）各占一个位置，用一个占位字符代替，偏移和文档位置一一对应
      const at = node.textBetween(0, node.content.size, undefined, '\ufffc').indexOf(needle)
      if (at >= 0) found = { from: pos + 1 + at, to: pos + 1 + at + needle.length }
      return false
    })
    if (!found) return { ok: false, reason: '正文里没找到这段文字' }
    const { from, to } = found
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)).scrollIntoView())
    view.focus()
    return { ok: true }
  }

  /**
   * AI 写作发起时：记下要改的那一段（高亮、随编辑映射），交出选中的内容（Markdown，保住列表 / 加粗）和光标前的上下文。
   * 没选中时记的是光标位置（续写 / 按要求写一段插在这里）。
   */
  private markAiTarget(): CommandResult {
    const view = this.view
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    if (this.isLocked()) return { ok: false, reason: '文档当前不可编辑' }
    const { from, to, empty } = view.state.selection
    let text = ''
    if (!empty) {
      const slice = view.state.selection.content()
      const doc = textSchema.topNodeType.createAndFill(null, slice.content)
      // 选区切出来的片段拼不成合法文档（例如只选了表格里的几格）：退回纯文字，不丢内容
      text = (doc ? serializeMarkdown(doc) : view.state.doc.textBetween(from, to, '\n\n', ' ')).trim()
    }
    // 上下文只要贴近光标的一截（服务端也只取最后 4000 字）；块之间空一行，读起来和原文一样分段
    const context = view.state.doc.textBetween(Math.max(0, from - 8000), from, '\n\n', ' ').slice(-4000)
    view.dispatch(setAiTarget(view.state.tr, { from, to }))
    return { ok: true, data: { text, context, hasSelection: !empty } }
  }

  /**
   * 把 AI 的结果（Markdown）写回目标区间。一个事务，一步撤销；协同下和普通输入一样同步。
   * - replace：替换选中的内容。结果只有一段、选区也在同一段里时按行内内容替换（不把段落拆开）；
   *   否则按两端开放的切片替换（和粘贴一样，首尾并进前后文字）
   * - below：插到选中内容所在的顶层块后面（总结 / 翻译常用，原文保留）
   * - cursor：插在光标处；光标在空段落里就替换这个空段落，在段落末尾就另起新段，在段落中间按粘贴处理
   */
  private applyAi(args: { markdown?: string; mode?: AiApplyMode } | undefined): CommandResult {
    const view = this.view
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    if (this.isLocked()) return { ok: false, reason: '文档当前不可编辑' }
    const target = aiTargetOf(view.state)
    if (!target || !target.alive) return { ok: false, reason: '要改的那段内容已经被删掉或改动了，请重新生成' }
    const nodes: PMNode[] = []
    parseMarkdown(args?.markdown ?? '').doc.forEach((child) => nodes.push(child))
    if (!nodes.length || !nodes.some((node) => node.textContent.trim() || node.type.name !== 'paragraph')) return { ok: false, reason: 'AI 没有给出内容' }
    const mode: AiApplyMode = args?.mode === 'below' || args?.mode === 'cursor' ? args.mode : 'replace'
    const { doc } = view.state
    const from = Math.min(target.from, doc.content.size)
    const to = Math.min(target.to, doc.content.size)
    let tr = clearAiTarget(view.state.tr)
    let end: number
    if (mode === 'below') {
      const $to = doc.resolve(to)
      const after = $to.depth >= 1 ? $to.after(1) : to
      tr = tr.insert(after, Fragment.fromArray(nodes))
      end = after + Fragment.fromArray(nodes).size
    } else if (mode === 'cursor') {
      const $at = doc.resolve(from)
      const block = $at.parent
      if (block.isTextblock && block.content.size === 0 && $at.depth >= 1) {
        tr = tr.replaceWith($at.before(), $at.after(), Fragment.fromArray(nodes))
        end = $at.before() + Fragment.fromArray(nodes).size
      } else if (block.isTextblock && $at.parentOffset === block.content.size && $at.depth >= 1) {
        tr = tr.insert($at.after(), Fragment.fromArray(nodes))
        end = $at.after() + Fragment.fromArray(nodes).size
      } else {
        tr = tr.replaceRange(from, from, openSlice(nodes))
        end = tr.mapping.map(from, 1)
      }
    } else {
      const $from = doc.resolve(from)
      const $to = doc.resolve(to)
      const single = nodes.length === 1 && nodes[0]!.type === textSchema.nodes.paragraph
      if (single && $from.sameParent($to) && $from.parent.isTextblock) {
        tr = tr.replaceWith(from, to, nodes[0]!.content)
        end = from + nodes[0]!.content.size
      } else {
        tr = tr.replaceRange(from, to, openSlice(nodes))
        end = tr.mapping.map(to, 1)
      }
    }
    const caret = Math.min(Math.max(0, end), tr.doc.content.size)
    tr.setSelection(TextSelection.near(tr.doc.resolve(caret), -1))
    view.dispatch(tr.scrollIntoView())
    view.focus()
    return { ok: true }
  }

  /**
   * 把正文里的旧 href 换成新地址（「从库中选择」修坏引用时用）。
   * 只改链接标记和图片 src，不动文字；返回改到的处数，0 表示正文里已经找不到这个旧地址。
   */
  private replaceHref(oldHref: string, newHref: string): CommandResult {
    const view = this.view
    if (!view || !oldHref || !newHref || oldHref === newHref) return { ok: true, data: { count: 0 } }
    const linkType = textSchema.marks.link
    let count = 0
    const tr = view.state.tr
    view.state.doc.descendants((node, pos) => {
      if (node.isText) {
        const matched = node.marks.filter((mark) => mark.type === linkType && String(mark.attrs.href ?? '') === oldHref)
        if (!matched.length) return
        tr.removeMark(pos, pos + node.nodeSize, linkType)
        tr.addMark(pos, pos + node.nodeSize, linkType.create({ ...matched[0]!.attrs, href: newHref }))
        count += 1
        return
      }
      // 图片没有链接标记：地址在 src 属性上，单独改
      if (node.type.name === 'image' && String(node.attrs.src ?? '') === oldHref) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: newHref })
        count += 1
      }
    })
    if (count) view.dispatch(tr)
    return { ok: true, data: { count } }
  }

  private dispatch(tr: Transaction, view: EditorView | null = this.view): void {
    const ctx = this.ctx
    if (!view || !ctx) return
    const previousDoc = view.state.doc
    view.updateState(view.state.apply(tr))
    if (!view.state.doc.eq(previousDoc)) {
      this.resolveTitles()
      // 多人编辑：没有「本地未保存」这回事（房间负责落地），只通知内容变了
      if (ctx.collabRich) ctx.onContentChange?.()
      else ctx.onDirtyChange?.(!this.initialDoc || !view.state.doc.eq(this.initialDoc))
    }
    if (tr.selectionSet || tr.docChanged) ctx.onSelectionChange?.(selectionFromState(view.state))
    // 组字过程中不按预编辑文字重新过滤斜杠菜单（旧编辑器同样：上屏之后才按最终文本过滤，见 compositionend）
    if (!view.composing) this.syncSlashMenu()
    if (tr.selectionSet || tr.docChanged) {
      this.quoteTools?.update()
    }
    if (tr.docChanged) this.blockHandle?.refresh()
  }

  private run(command: (state: EditorState, dispatch: (tr: Transaction) => void) => boolean): CommandResult {
    const view = this.view
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    const applied = command(view.state, (tr) => view.dispatch(tr))
    return applied ? { ok: true } : { ok: false, reason: 'command_rejected' }
  }

  private allSelection() {
    const view = this.view
    if (!view) throw new Error('surface_not_mounted')
    return new AllSelection(view.state.doc)
  }

  private outline(): TextOutlineItem[] {
    const view = this.view
    if (!view) return []
    const items: TextOutlineItem[] = []
    view.state.doc.forEach((node, _offset, index) => {
      if (node.type.name !== 'heading') return
      // 顶层块路径就是顶层序号； 引入稳定块 id 后再替换，锚点模型不变
      items.push({
        level: Number(node.attrs.level),
        text: node.textContent,
        anchor: { kind: 'text', block: String(index), offset: 0, length: 0 },
      })
    })
    return items
  }

  private anchorRect(anchor: Anchor): { x: number; y: number; width: number; height: number } | null {
    const view = this.view
    if (!view) return null
    const range = resolveAnchorRange(view.state.doc, anchor)
    if (!range) return null
    const start = view.coordsAtPos(range.from)
    const end = view.coordsAtPos(Math.max(range.from, range.to))
    return { x: start.left, y: start.top, width: Math.max(0, end.right - start.left), height: Math.max(1, start.bottom - start.top) }
  }

  /** 粘贴：图片 > 选中文字时粘贴网址（变链接） > HTML > Markdown > 纯文本 */
  private handlePaste(view: EditorView, event: ClipboardEvent): boolean {
    const data = event.clipboardData
    if (!data) return false
    // 选中一段文字再粘贴一个网址：把这段文字变成指向它的链接，文字不动（飞书 / Notion / Google 文档都是这样）。
    // 只认「整段剪贴板就是一个 http(s) / mailto 地址」，并且选区在同一个段落里、不在代码里
    if (!view.state.selection.empty && !data.files.length) {
      const href = data.getData('text/plain').trim()
      if (pastedLinkTarget(href) && this.linkSelection(view, href)) return true
    }
    const files = [...data.files]
    // 有页面桥时文件由 inputPlugin 在捕获阶段接管（图片 + 附件，文字不被吞）；这里不再重复处理
    if (files.length && !this.ctx?.textHost && this.options.uploadImage) {
      void insertImageFiles(textSchema, view, files, this.options.uploadImage)
      return true
    }
    const html = data.getData('text/html')
    if (html) {
      const slice = htmlSlice(textSchema, html)
      if (slice) {
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
        return true
      }
    }
    const text = data.getData('text/plain')
    if (text && looksLikeMarkdown(text)) {
      const slice = markdownSlice(textSchema, text)
      if (slice) {
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
        return true
      }
    }
    // 纯文本交给默认行为（按空行分段、保留换行语义）
    return false
  }

  /** 把选区变成链接（粘贴网址时用）；选区跨段落 / 在代码块里 / 在行内代码上时不做，交给普通粘贴 */
  private linkSelection(view: EditorView, href: string): boolean {
    const { $from, $to } = view.state.selection
    if ($from.parent !== $to.parent || !$from.parent.isTextblock || $from.parent.type.spec.code) return false
    if (view.state.doc.rangeHasMark($from.pos, $to.pos, textSchema.marks.inlineCode)) return false
    return setLink(textSchema, href)(view.state, (tr) => view.dispatch(tr))
  }

  /** 格式刷开关：开的时候从当前选区 / 光标处取样 */
  private togglePainter(sticky: boolean): CommandResult {
    const view = this.view
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    if (this.isLocked()) return { ok: false, reason: '文档当前不可编辑' }
    // 双击按钮：两次单击先开后关，接着到这里的 sticky 再打开成连续模式
    if (this.painter && !sticky) {
      this.stopPainter()
      return { ok: true }
    }
    this.painter = { marks: styleMarksAt(view.state), sticky }
    view.dom.classList.add('is-painting')
    this.ctx?.onStatsChange?.()
    return { ok: true }
  }

  private stopPainter(): void {
    if (!this.painter) return
    this.painter = null
    this.view?.dom.classList.remove('is-painting')
    this.ctx?.onStatsChange?.()
  }

  /** 格式刷落笔：选区非空才刷；单次模式刷完就退出 */
  private paintSelection(): void {
    const view = this.view
    const painter = this.painter
    if (!view || !painter || view.state.selection.empty || this.isLocked()) return
    applyStyleMarks(painter.marks)(view.state, (tr) => view.dispatch(tr))
    if (!painter.sticky) this.stopPainter()
  }

  private handleDrop(view: EditorView, event: DragEvent): boolean {
    const files = [...(event.dataTransfer?.files ?? [])]
    if (!files.length || this.ctx?.textHost) return false
    event.preventDefault()
    void insertImageFiles(textSchema, view, files, this.options.uploadImage)
    return true
  }
}

/** 标记顺序导出，便于测试断言与外部渲染复用 */
export { MARK_ORDER }

/** 光标（或选区开头）处的字体 / 字色 / 底色：取 kb_color 标记里对应 prop 的 key */
function styleValues(state: EditorState): Record<string, string | null> {
  const marks = state.storedMarks ?? state.selection.$from.marks()
  const keyOf = (prop: string): string | null => {
    const mark = marks.find((item) => item.type === textSchema.marks.kb_color && item.attrs.prop === prop)
    return mark ? String(mark.attrs.key) : null
  }
  return { noteFont: keyOf('font-family'), noteColor: keyOf('color'), noteBg: keyOf('background-color') }
}
