/**
 * Text Surface 键盘映射
 *
 * 设计约束：
 * 1. 只接管「编辑器内部语义」的按键：列表缩进/回车、代码块换行、行内标记快捷键。
 * 2. 编辑/撤销/保存这类全局动作由 `useEditorHotkeys` 在 Host 层统一拦截（还带焦点判定），
 *    这里不重复绑定，避免 Canvas/iframe 场景下两处互相打架。
 * 3. 每个命令都是幂等的：条件不满足时返回 false，让事件继续冒泡，不吞浏览器默认行为。
 */
import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  exitCode,
  joinBackward,
  joinForward,
  liftEmptyBlock,
  newlineInCode,
  setBlockType,
  splitBlock,
} from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { undoInputRule } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list'
import type { Command, Plugin } from 'prosemirror-state'
import type { MarkType, NodeType, Schema } from 'prosemirror-model'
import { goToCell } from './tableCommands'
import { moveBlock } from './blockHandle'
import { clearFormatting, indentCode, setHeadingLevel, toggleBlockquote, toggleListKind, toggleTaskList } from './commands'

/** 切换行内标记；选区为空时只切换「待输入」状态（与 ProseMirror 官方示例一致） */
export function toggleMark(markType: MarkType): Command {
  return (state, dispatch) => {
    const { from, to, empty, $from } = state.selection
    if (empty) {
      if (dispatch) {
        // 必须用同一个事务：分两次 dispatch 时第二次会用旧 state 建事务，第一次的移除就丢了
        const has = markType.isInSet(state.storedMarks ?? $from.marks())
        const tr = state.tr
        if (has) tr.removeStoredMark(markType)
        else tr.addStoredMark(markType.create())
        dispatch(tr)
      }
      return true
    }
    const has = state.doc.rangeHasMark(from, to, markType)
    if (dispatch) {
      const tr = state.tr
      if (has) tr.removeMark(from, to, markType)
      else tr.addMark(from, to, markType.create())
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

/**
 * 列表项回车（导出便于单测直接驱动命令，不必伪造 KeyboardEvent）：
 * - 空列表项 → 提升一级（退出列表），否则会无限生成空项
 * - 非空 → 拆成两个列表项
 */
export function createListEnter(itemType: NodeType): Command {
  return (state, dispatch, view) => {
    const { $from, empty } = state.selection
    if (!empty) return splitListItem(itemType)(state, dispatch, view)
    const item = $from.node($from.depth - 1)
    if (!item || item.type !== itemType) return false
    if (item.textContent.trim() === '') return liftListItem(itemType)(state, dispatch, view)
    return splitListItem(itemType)(state, dispatch, view)
  }
}

/**
 * 撤销 / 重做的实现。单人编辑用 prosemirror-history；多人编辑必须换成 y-prosemirror 的
 * 撤销管理器：本地历史会把别人的修改一起撤掉，y 的撤销只撤自己的改动。
 */
export interface HistoryBinding {
  undo: Command
  redo: Command
  /** 撤销所需的插件；y-prosemirror 的 yUndoPlugin 由调用方自己放进插件列表，这里传 null */
  plugin: Plugin | null
}

/**
 * 组装键位表。
 * 顺序有意义：先列表/代码块这类「结构化」命令，最后才落到 baseKeymap。
 */
export interface KeymapOptions {
  /** Ctrl/⌘+K：请求打开链接输入（由 Host 的 Chrome 承载）；不给就不绑 */
  onLinkRequest?: () => void
}

/**
 * 键位表本身（不含插件）：buildKeymap 用它，单测拿它核对「工具栏 / 快捷键清单里写的每个快捷键都真的绑了」。
 * 键名是 prosemirror-keymap 的写法（`Mod` = Windows / Linux 的 Ctrl、macOS 的 ⌘）。
 */
export function textKeyBindings(
  schema: Schema,
  historyBinding: Pick<HistoryBinding, 'undo' | 'redo'> = { undo, redo },
  options: KeymapOptions = {},
): Record<string, Command> {
  const itemType = schema.nodes.list_item
  const enter = chainCommands(
    createListEnter(itemType),
    newlineInCode,
    createParagraphNear,
    liftEmptyBlock,
    splitBlock,
  )

  const keys: Record<string, Command> = {
    Enter: enter,
    // Shift+Enter 是硬换行（序列化为行尾两空格），不要拆段落
    'Shift-Enter': (state, dispatch) => {
      if (dispatch) {
        dispatch(state.tr.replaceSelectionWith(schema.nodes.hardbreak.create()).scrollIntoView())
      }
      return true
    },
    Backspace: chainCommands(
      // 刚被输入规则改掉的字（`## ` 变标题、`**粗**` 变加粗、`1. ` 变列表…）：退格先撤回成原来打的字，
      // 想写字面的 `## ` 时不用再去找「正文」按钮。只认「上一步就是规则生效」，平时的退格不受影响
      undoInputRule,
      // 列表项开头退格 → 退出列表（否则会把列表项并进上一段，结构丢失）
      (state, dispatch, view) =>
        state.selection.empty && state.selection.$from.parentOffset === 0
          ? liftListItem(itemType)(state, dispatch, view)
          : false,
      joinBackward,
      createParagraphNear,
      liftEmptyBlock,
      baseKeymap.Backspace,
    ),
    Delete: joinForward,
    // 代码块里 Tab / Shift-Tab 是缩进 / 反缩进（选中多行时整块一起）；
    // 表格里在格间跳转（最后一格 Tab 新增一行）；其它地方是列表缩进，顶层列表项再 Shift-Tab 就是退出列表
    Tab: chainCommands(indentCode(schema, 1), goToCell(schema, 1), sinkListItem(itemType)),
    'Shift-Tab': chainCommands(indentCode(schema, -1), goToCell(schema, -1), liftListItem(itemType)),
    'Mod-b': toggleMark(schema.marks.strong),
    'Mod-i': toggleMark(schema.marks.emphasis),
    'Mod-`': toggleMark(schema.marks.inlineCode),
    // 以下和工具栏按钮是同一批命令（commands.ts），按钮提示和快捷键一览里写的就是这些键。
    // 选键的原则：飞书 / Google 文档里常见的那一套，并且不和浏览器自己的快捷键冲突（Ctrl+Shift+Q 在 Windows 上是关掉 Chrome，不用）
    'Mod-Shift-x': toggleMark(schema.marks.strike_through),
    'Mod-Alt-0': setHeadingLevel(schema, 0),
    'Mod-Alt-1': setHeadingLevel(schema, 1),
    'Mod-Alt-2': setHeadingLevel(schema, 2),
    'Mod-Alt-3': setHeadingLevel(schema, 3),
    'Mod-Alt-4': setHeadingLevel(schema, 4),
    'Mod-Alt-5': setHeadingLevel(schema, 5),
    'Mod-Alt-6': setHeadingLevel(schema, 6),
    'Mod-Shift-7': toggleListKind(schema, 'ordered_list'),
    'Mod-Shift-8': toggleListKind(schema, 'bullet_list'),
    'Mod-Shift-9': toggleTaskList(schema),
    'Mod-Shift-b': toggleBlockquote(schema),
    'Mod-Alt-c': setBlockType(schema.nodes.code_block),
    'Mod-\\': clearFormatting(schema),
    'Mod-z': historyBinding.undo,
    'Mod-y': historyBinding.redo,
    'Shift-Mod-z': historyBinding.redo,
    // 块上移 / 下移（块手柄拖动排序的键盘等价操作）
    'Mod-Shift-ArrowUp': moveBlock(-1),
    'Mod-Shift-ArrowDown': moveBlock(1),
    // 代码块内退出：Ctrl/⌘+Enter 在代码块之后新起一段
    'Mod-Enter': exitCode,
  }
  if (options.onLinkRequest) {
    const request = options.onLinkRequest
    keys['Mod-k'] = () => {
      request()
      return true
    }
  }
  return keys
}

export function buildKeymap(
  schema: Schema,
  historyBinding: HistoryBinding = { undo, redo, plugin: history() },
  options: KeymapOptions = {},
): Plugin[] {
  return [keymap(textKeyBindings(schema, historyBinding, options)), keymap(baseKeymap), ...(historyBinding.plugin ? [historyBinding.plugin] : [])]
}
