/**
 * Code Surface 控制器
 *
 * CodeMirror 内核与视图都留在 `CodeSurface.vue` → `CodeEditor.vue` 里，本类只做统一契约的适配：
 *  - mount / unmount 生命周期：Vue 应用只在 Host 真正打开代码文件时创建，卸载即销毁（不会把编辑器留在后台）；
 *  - 命令 / 查询：把 `search.*`、`undo`、`redo`、`nav.*` 翻译成 CodeMirror 操作；
 *  - 保存快照：未改动的文件原样交回原文（BOM / CRLF 不变），改过才按原文件风格重新编码。
 *
 * 为什么不用「一个全局 CodeMirror 实例」：打开 PDF 或 Markdown 时不应该为代码面付任何成本；
 * 这里用动态 import + Vue createApp，代码 chunk 只在 `CODE_FORMATS` 命中时下载。
 */
import { createApp, h, ref, type App } from 'vue'
import type { EditorView } from '@codemirror/view'
import CodeSurfaceView from './CodeSurface.vue'
import { openCode, saveCode, type CodeDocument } from '../../codecs/code'
import type {
  Anchor,
  CommandResult,
  EditorCommand,
  EditorSource,
  Selection,
  Size,
  Surface,
  SurfaceContext,
  SurfaceQuery,
  SurfaceState,
} from '../../types'

interface CodeSurfaceExposed {
  getText: () => string
  setReadonly: (value: boolean) => void
  focus: () => void
  undo: () => void
  redo: () => void
  revealLine: (line: number) => void
  selectAll: () => void
  selectRange: (from: number, to: number) => void
  getScrollTop: () => number
  setScrollTop: (value: number) => void
  getView: () => EditorView | null
  setSaveRequest: (handler: (() => void) | null) => void
  toggleWrap: () => void
  isWrapping: () => boolean
}

interface FindMatch {
  from: number
  to: number
}

/** 读取 payload：Host 直接传 EditorSource；走 codec 时传 CodeDocument */
function readPayload(payload: unknown): CodeDocument {
  if (payload && typeof payload === 'object' && 'parsed' in payload && 'original' in payload) {
    return payload as CodeDocument
  }
  return openCode(payload as EditorSource)
}

export class CodeSurface implements Surface {
  private ctx: SurfaceContext | null = null
  private app: App | null = null
  private host: HTMLElement | null = null
  private viewRef = ref<CodeSurfaceExposed | null>(null)
  private doc: CodeDocument | null = null
  private currentText = ''
  private findQuery = ''
  private findMatches: FindMatch[] = []
  private findIndex = -1

  async mount(el: HTMLElement, ctx: SurfaceContext): Promise<void> {
    this.ctx = ctx
    const doc = readPayload(ctx.document.payload)
    this.doc = doc
    this.currentText = doc.text
    el.classList.add('kb-code-surface-host')

    this.app = createApp({
      name: 'KbCodeSurfaceRoot',
      render: () =>
        h(CodeSurfaceView, {
          ref: this.viewRef,
          initialText: doc.text,
          filename: doc.name,
          readonly: ctx.readonly,
          collab: (ctx.collabProvider ?? null) as never,
          onChange: (text: string) => this.onChange(text),
          onSelection: (payload: { line: number; column: number; from: number; to: number; text: string }) =>
            this.onSelection(payload),
        }),
    })
    this.app.mount(el)
    this.host = el
    // CodeMirror 的 Mod-s 会 stopPropagation；把「保存意图」接回 Host，避免页面里出现第二条保存通道
    this.viewRef.value?.setSaveRequest(() => ctx.onSaveRequest?.())

    // 保存时回这里取当前内容；未改动交给原文，改动后按原文件行尾 / BOM 重建。
    // 多人编辑不注册：文本房间由服务端落地（编码按原文件写回），本地整份提交会越过房间
    if (!ctx.collabProvider) ctx.session.setSnapshotProvider?.(() => this.source())
    ctx.onDirtyChange?.(false)
  }

  unmount(): void {
    this.ctx?.session.setSnapshotProvider?.(null)
    this.app?.unmount()
    this.app = null
    this.viewRef.value = null
    this.host?.classList.remove('kb-code-surface-host')
    this.host = null
    this.ctx = null
  }

  resize(_size: Size): void {
    // CodeMirror 自己监听容器尺寸；这里不重复做布局
  }

  focus(): void {
    this.viewRef.value?.focus()
  }

  setReadonly(value: boolean): void {
    this.viewRef.value?.setReadonly(value)
  }

  async command(command: EditorCommand): Promise<CommandResult> {
    const view = this.viewRef.value
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    switch (command.type) {
      case 'view.focus':
        view.focus()
        return { ok: true }
      case 'view.selectAll':
        view.selectAll()
        return { ok: true }
      case 'view.toggleWrap':
        view.toggleWrap()
        return { ok: true }
      case 'undo':
        view.undo()
        this.syncDirty()
        return { ok: true }
      case 'redo':
        view.redo()
        this.syncDirty()
        return { ok: true }
      case 'text.insert': {
        const text = (command.args as { text?: string } | undefined)?.text ?? ''
        if (!text) return { ok: false, reason: 'empty_text' }
        const editor = view.getView?.()
        if (!editor) return { ok: false, reason: 'surface_not_mounted' }
        editor.dispatch(editor.state.replaceSelection(text))
        return { ok: true }
      }
      case 'search.set': {
        const query = String((command.args as { query?: string } | undefined)?.query ?? '')
        return this.applyFind(query, 0)
      }
      case 'search.next':
        return this.stepFind(1)
      case 'search.prev':
        return this.stepFind(-1)
      case 'search.replace':
        return this.replaceCurrent(String((command.args as { text?: string } | undefined)?.text ?? ''))
      case 'search.replaceAll':
        return this.replaceAll(String((command.args as { text?: string } | undefined)?.text ?? ''))
      case 'search.close':
        this.findQuery = ''
        this.findMatches = []
        this.findIndex = -1
        return { ok: true, data: { query: '', total: 0, index: -1, anchors: [] } }
      case 'nav.anchor':
      case 'nav.scrollToAnchor': {
        const anchor = (command.args as { anchor?: Anchor } | undefined)?.anchor
        if (!anchor || anchor.kind !== 'code') return { ok: false, reason: 'unsupported_anchor' }
        view.revealLine(anchor.line)
        return { ok: true }
      }
      default:
        return { ok: false, reason: `unsupported_command:${command.type}` }
    }
  }

  async query(query: SurfaceQuery): Promise<unknown> {
    switch (query.type) {
      case 'text':
        return this.currentText
      case 'selection': {
        const selection = this.ctx?.session.getSelection() ?? null
        return selection
      }
      case 'wordCount': {
        const lines = this.currentText ? this.currentText.split('\n').length : 0
        return { words: this.currentText.length, unitLabel: `字符 · ${lines} 行` }
      }
      case 'outline':
        return []
      case 'formatState':
        return { marks: [], block: '', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, toggles: this.viewRef.value?.isWrapping() ? ['wrap'] : [] }
      case 'search':
        return { query: this.findQuery, total: this.findMatches.length, index: this.findIndex }
      default:
        return null
    }
  }

  capture(): SurfaceState {
    const view = this.viewRef.value
    return {
      kind: 'code',
      scrollTop: view?.getScrollTop() ?? 0,
      selection: this.ctx?.session.getSelection() ?? null,
    }
  }

  restore(state: SurfaceState): void {
    if (typeof state.scrollTop === 'number') this.viewRef.value?.setScrollTop(state.scrollTop)
    const anchor = state.selection?.anchor
    if (anchor?.kind === 'code') this.viewRef.value?.revealLine(anchor.line)
  }

  /** 保存快照：未改动原样归还（一个字节都不动），改动后才重新编码 */
  private source(): EditorSource | null {
    if (!this.doc) return null
    return saveCode(this.doc, this.currentText, this.doc.name)
  }

  private onChange(text: string): void {
    this.currentText = text
    this.syncDirty()
    // 查找命中位置随文档变化失效：重新算一遍，保持 Chrome 的计数不撒谎
    if (this.findQuery) this.applyFind(this.findQuery, Math.max(0, this.findIndex))
  }

  private syncDirty(): void {
    // 多人编辑没有「本地未保存」：改动实时进房间，由服务端落地；只通知正文变了（页面草稿 / 字数）
    if (this.ctx?.collabProvider) {
      this.ctx.onContentChange?.()
      return
    }
    const changed = !!this.doc && this.currentText !== this.doc.text
    this.ctx?.onDirtyChange?.(changed)
  }

  private onSelection(payload: { line: number; column: number; from: number; to: number; text: string }): void {
    const length = Math.max(0, payload.to - payload.from)
    const selection: Selection = {
      kind: 'code',
      anchor: { kind: 'code', line: payload.line, column: payload.column, length },
      isEmpty: length === 0,
      text: payload.text || undefined,
    }
    this.ctx?.onSelectionChange?.(selection)
  }

  /** 重新计算命中并把第 index 条选中；query 为空时清空 */
  private applyFind(query: string, index: number): CommandResult {
    const view = this.viewRef.value
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    this.findQuery = query
    this.findMatches = query ? this.scan(query) : []
    if (!this.findMatches.length) {
      this.findIndex = -1
      return { ok: true, data: { query, total: 0, index: -1, anchors: [] } }
    }
    const next = Math.min(Math.max(0, index), this.findMatches.length - 1)
    this.findIndex = next
    const match = this.findMatches[next]
    view.selectRange(match.from, match.to)
    return { ok: true, data: this.findInfo() }
  }

  private stepFind(direction: 1 | -1): CommandResult {
    if (!this.findMatches.length) return { ok: true, data: { query: this.findQuery, total: 0, index: -1, anchors: [] } }
    const next = (this.findIndex + direction + this.findMatches.length) % this.findMatches.length
    return this.applyFind(this.findQuery, next)
  }

  private replaceCurrent(replacement: string): CommandResult {
    const view = this.viewRef.value
    const current = this.findMatches[this.findIndex]
    if (!view || !current) return { ok: true, data: this.findInfo() }
    const editor = view.getView?.()
    if (!editor) return { ok: false, reason: 'surface_not_mounted' }
    editor.dispatch({ changes: { from: current.from, to: current.to, insert: replacement } })
    return this.applyFind(this.findQuery, this.findIndex)
  }

  private replaceAll(replacement: string): CommandResult {
    const view = this.viewRef.value
    if (!view || !this.findMatches.length) return { ok: true, data: this.findInfo() }
    const editor = view.getView?.()
    if (!editor) return { ok: false, reason: 'surface_not_mounted' }
    // CodeMirror 的 change 必须按 from 升序且互不重叠；用它自己的 changes 数组，避免手工算偏移
    editor.dispatch({ changes: this.findMatches.map((match) => ({ from: match.from, to: match.to, insert: replacement })) })
    return this.applyFind(this.findQuery, 0)
  }

  private findInfo(): { query: string; total: number; index: number; anchors: Anchor[] } {
    return {
      query: this.findQuery,
      total: this.findMatches.length,
      index: this.findIndex,
      anchors: this.findMatches.map((match) => this.anchorAt(match.from)),
    }
  }

  private anchorAt(from: number): Anchor {
    const editor = this.viewRef.value?.getView?.()
    if (!editor) return { kind: 'code', line: 1, column: 1 }
    const line = editor.state.doc.lineAt(from)
    return { kind: 'code', line: line.number, column: from - line.from + 1 }
  }

  /** 大小写不敏感的原生扫描：代码查找不需要正则，简单可靠，也不会把特殊字符当元字符 */
  private scan(query: string): FindMatch[] {
    const text = this.currentText
    if (!query) return []
    const haystack = text.toLowerCase()
    const needle = query.toLowerCase()
    const out: FindMatch[] = []
    let at = haystack.indexOf(needle)
    while (at !== -1 && out.length < 5000) {
      out.push({ from: at, to: at + query.length })
      at = haystack.indexOf(needle, at + Math.max(1, needle.length))
    }
    return out
  }
}
