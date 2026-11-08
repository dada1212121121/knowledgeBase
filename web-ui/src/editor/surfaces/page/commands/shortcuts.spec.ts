/** 快捷键表单测：键位 → 命令，含 macOS / 其它平台差异与不该吞的组合。 */
import { describe, expect, it } from 'vitest'
import { shortcutCommand, type KeyLike } from './shortcuts'

const key = (k: string, init: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init })

describe('shortcutCommand', () => {
  it.each([
    ['l', 'left'],
    ['e', 'center'],
    ['r', 'right'],
    ['j', 'both'],
  ])('Ctrl+%s → 对齐 %s', (k, value) => {
    expect(shortcutCommand(key(k, { ctrlKey: true }))).toEqual({ type: 'docx.align', args: { value } })
  })

  it('大小写不敏感（Caps Lock 开着也一样）', () => {
    expect(shortcutCommand(key('L', { ctrlKey: true }))).toEqual({ type: 'docx.align', args: { value: 'left' } })
  })

  it('下标 Ctrl+=，上标 Ctrl+Shift+=（Shift 下 = 键产出 +）', () => {
    expect(shortcutCommand(key('=', { ctrlKey: true }))).toEqual({ type: 'docx.subscript' })
    expect(shortcutCommand(key('+', { ctrlKey: true, shiftKey: true }))).toEqual({ type: 'docx.superscript' })
    expect(shortcutCommand(key('=', { ctrlKey: true, shiftKey: true }))).toEqual({ type: 'docx.superscript' })
  })

  it('清除格式：非 mac 用 Ctrl+Space，mac 用 ⌘\\（⌘Space 是系统搜索，不能占）', () => {
    expect(shortcutCommand(key(' ', { ctrlKey: true }))).toEqual({ type: 'docx.clearFormat' })
    expect(shortcutCommand(key(' ', { metaKey: true }), true)).toBeNull()
    expect(shortcutCommand(key('\\', { metaKey: true }), true)).toEqual({ type: 'docx.clearFormat' })
    expect(shortcutCommand(key('\\', { ctrlKey: true }))).toBeNull()
  })

  it('mac 上认 ⌘ 不认 Ctrl；其它平台反之', () => {
    expect(shortcutCommand(key('e', { metaKey: true }), true)).toEqual({ type: 'docx.align', args: { value: 'center' } })
    expect(shortcutCommand(key('e', { ctrlKey: true }), true)).toBeNull()
    expect(shortcutCommand(key('e', { metaKey: true }), false)).toBeNull()
  })

  it('列表：Ctrl+Shift+7 编号，Ctrl+Shift+8 项目符号；缩进 Ctrl+[ / ]', () => {
    expect(shortcutCommand(key('7', { ctrlKey: true, shiftKey: true }))).toEqual({ type: 'docx.list', args: { kind: 'numbered' } })
    expect(shortcutCommand(key('8', { ctrlKey: true, shiftKey: true }))).toEqual({ type: 'docx.list', args: { kind: 'bullet' } })
    expect(shortcutCommand(key('[', { ctrlKey: true }))).toEqual({ type: 'docx.indent', args: { direction: 'decrease' } })
    expect(shortcutCommand(key(']', { ctrlKey: true }))).toEqual({ type: 'docx.indent', args: { direction: 'increase' } })
  })

  it('不带修饰键 / 带 Alt / 无关键位：不吞', () => {
    expect(shortcutCommand(key('l'))).toBeNull()
    expect(shortcutCommand(key('l', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(shortcutCommand(key('q', { ctrlKey: true }))).toBeNull()
    expect(shortcutCommand(key('a', { ctrlKey: true }))).toBeNull()
    expect(shortcutCommand(key('c', { ctrlKey: true }))).toBeNull()
  })

  it('Ctrl+Shift+L 等带 Shift 的非表内组合不吞（浏览器 / 别的功能可能在用）', () => {
    expect(shortcutCommand(key('l', { ctrlKey: true, shiftKey: true }))).toBeNull()
  })

  it('Ctrl+Meta 同时按下不算（避免 AltGr 之类的误触）', () => {
    expect(shortcutCommand(key('e', { ctrlKey: true, metaKey: true }))).toBeNull()
  })
})
