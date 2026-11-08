/**
 * Word 编辑的快捷键 → 命令
 *
 * 粗斜体下划线在输入层（attachDocxInput）里直接处理——它们要和输入法组合、围栏一起判断；
 * 这里只放"纯格式命令"的快捷键：对齐、上下标、清除格式、列表缩进。
 * 键位来自上游 `commands/descriptors.ts`（Mod = macOS 的 ⌘ / 其它平台的 Ctrl）。
 * 纯函数：输入一个键盘事件的形状，输出命令或 null，单测不需要 DOM。
 */
import type { DocxCommandArgsMap, DocxCommandType } from './intents'

export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export interface ShortcutCommand<K extends DocxCommandType = DocxCommandType> {
  type: K
  args?: DocxCommandArgsMap[K]
}

/** 在 macOS 上 Mod 是 ⌘，其它平台是 Ctrl；传入 isMac 便于测试 */
export function shortcutCommand(event: KeyLike, isMac = false): ShortcutCommand | null {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!mod || event.altKey) return null
  const key = event.key.toLowerCase()
  if (!event.shiftKey) {
    switch (key) {
      case 'l':
        return { type: 'docx.align', args: { value: 'left' } }
      case 'e':
        return { type: 'docx.align', args: { value: 'center' } }
      case 'r':
        return { type: 'docx.align', args: { value: 'right' } }
      case 'j':
        return { type: 'docx.align', args: { value: 'both' } }
      case '=':
        return { type: 'docx.subscript' }
      case ' ':
        // macOS 的 ⌘Space 是系统聚焦搜索，上游在 mac 上改用 ⌘\
        return isMac ? null : { type: 'docx.clearFormat' }
      case '\\':
        return isMac ? { type: 'docx.clearFormat' } : null
      case '[':
        return { type: 'docx.indent', args: { direction: 'decrease' } }
      case ']':
        return { type: 'docx.indent', args: { direction: 'increase' } }
      default:
        return null
    }
  }
  // Shift 组合：Shift+= 在多数键盘上产出 '+'
  if (key === '=' || key === '+') return { type: 'docx.superscript' }
  if (key === '7') return { type: 'docx.list', args: { kind: 'numbered' } }
  if (key === '8') return { type: 'docx.list', args: { kind: 'bullet' } }
  return null
}
