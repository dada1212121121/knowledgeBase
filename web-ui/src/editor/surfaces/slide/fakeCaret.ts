/** 假后端用的简化光标移动（单行文本）：只在测试里用 */
import type { CaretMove } from './types'

export function moveCaretSimple(text: string, position: number, line: number, kind: CaretMove): { position: number; line: number } {
  const at = Math.min(Math.max(0, position), text.length)
  switch (kind) {
    case 'left':
      return { position: Math.max(0, at - 1), line }
    case 'right':
      return { position: Math.min(text.length, at + 1), line }
    case 'up':
    case 'storyStart':
    case 'lineStart':
      return { position: 0, line: 0 }
    case 'down':
    case 'storyEnd':
    case 'lineEnd':
      return { position: text.length, line: 0 }
    case 'wordLeft': {
      const before = text.slice(0, at).replace(/\s+$/, '')
      return { position: Math.max(0, before.lastIndexOf(' ') + 1), line }
    }
    case 'wordRight': {
      const rest = text.indexOf(' ', at)
      return { position: rest < 0 ? text.length : rest + 1, line }
    }
  }
}
