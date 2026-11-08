/**
 * 编辑器全局快捷键
 *
 * 为什么单独抽出来（设计规范 `host/useEditorHotkeys.ts`）：
 * 1. 快捷键必须能「只在焦点位于编辑器内部」时接管。如果挂在 document 上且无条件 preventDefault，
 *    会抢走页面搜索框、AI 输入框、评论框里的 Ctrl+Z / Ctrl+S，是一个典型的高频投诉点。
 * 2. 六类内容面里既有 DOM 编辑器（ProseMirror / CodeMirror）也有 Canvas（docx/xlsx/pptx），
 *    Canvas 里焦点落在隐藏 textarea 上，同样属于「编辑器内部」，因此判定基于宿主根节点包含关系，
 *    而不是元素类型。
 * 3. 抽成纯函数式的组合函数后可以单测，不必为了验证快捷键去挂载整个编辑器。
 */
import { getCurrentInstance, onBeforeUnmount, onMounted, type Ref } from 'vue'

/** 快捷键动作 */
export type EditorHotkeyAction = 'save' | 'undo' | 'redo' | 'find' | 'shortcuts'

export interface EditorHotkeysOptions {
  /** 编辑器根节点；只要事件目标在它内部就算「编辑器获得焦点」 */
  root: Ref<HTMLElement | null>
  /** 保存回调 */
  onSave: () => void
  /** 撤销回调 */
  onUndo: () => void
  /** 重做回调 */
  onRedo: () => void
  /** 查找回调（Ctrl/⌘+F）；只读态也允许查找 */
  onFind?: () => void
  /** 快捷键一览（Ctrl/⌘+/）；不给就不接管这个键（代码面里它是 CodeMirror 的「切换注释」，由内容面自己处理） */
  onShortcuts?: () => void
  /** 只读态：只允许保存被忽略，撤销重做也不再触发 */
  readonly?: () => boolean
  /** 注入 window，便于测试 */
  target?: Window
}

/** 把键盘事件映射成动作；返回 null 表示不归编辑器管 */
export function matchEditorHotkey(event: KeyboardEvent): EditorHotkeyAction | null {
  // Ctrl 或 ⌘；两者都接受，跨平台一致
  if (!(event.metaKey || event.ctrlKey)) return null
  // Alt 组合通常属于系统或浏览器，不抢
  if (event.altKey) return null
  const key = event.key.toLowerCase()
  if (key === 's') return 'save'
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  // Windows 习惯用 Ctrl+Y 重做
  if (key === 'y') return 'redo'
  // Ctrl/⌘+F：编辑器内部接管，打开自家查找条（只读态也能用）
  if (key === 'f' && !event.shiftKey) return 'find'
  // Ctrl/⌘+/：快捷键一览（有的键盘布局 / 要按 Shift，Ctrl+? 一并认）
  if (key === '/' || key === '?') return 'shortcuts'
  return null
}

/** 事件目标是否位于编辑器根节点内部 */
export function isInsideEditor(root: HTMLElement | null, target: EventTarget | null): boolean {
  if (!root || !(target instanceof Node)) return false
  return root.contains(target)
}

/**
 * 挂载/卸载快捷键监听，返回手动解绑函数（便于组件提前拆监听）。
 */
export function useEditorHotkeys(options: EditorHotkeysOptions): {
  attach: () => void
  detach: () => void
} {
  const win = options.target ?? (typeof window === 'undefined' ? undefined : window)
  const isReadonly = options.readonly ?? (() => false)

  const handler = (event: KeyboardEvent) => {
    // 内容面（ProseMirror / CodeMirror）会先在自己的 DOM 上处理快捷键并 preventDefault；
    // 已经处理过的不能再触发一次，否则一次 Ctrl+Z 会撤两步。
    if (event.defaultPrevented) return
    const action = matchEditorHotkey(event)
    if (!action) return
    if (action === 'shortcuts' && !options.onShortcuts) return
    if (!isInsideEditor(options.root.value, event.target)) return
    // 保存/查找在只读态没有副作用，仍然可用；撤销重做会改文档，只读时必须挡住
    if ((action === 'undo' || action === 'redo') && isReadonly()) return

    // 只有确定要处理才 preventDefault，避免把浏览器的默认行为打乱
    event.preventDefault()
    if (action === 'save') options.onSave()
    else if (action === 'undo') options.onUndo()
    else if (action === 'redo') options.onRedo()
    else if (action === 'shortcuts') options.onShortcuts?.()
    else options.onFind?.()
  }

  const attach = () => {
    if (win) win.addEventListener('keydown', handler)
  }
  const detach = () => {
    if (win) win.removeEventListener('keydown', handler)
  }

  if (getCurrentInstance()) {
    // 组件内：等挂载后再监听，避免 setup 期就抢到还没渲染的焦点事件
    onMounted(attach)
    onBeforeUnmount(detach)
  } else {
    // 非组件上下文（单测 / 非 Vue 宿主）：立即监听，由调用方负责 detach
    attach()
  }

  return { attach, detach }
}
