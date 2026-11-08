import { describe, expect, it, vi } from 'vitest'
import { isInsideEditor, matchEditorHotkey, useEditorHotkeys } from './useEditorHotkeys'
import { ref } from 'vue'

/** 构造键盘事件（jsdom 不支持按键默认行为模拟，这里只测映射与拦截） */
function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
}

describe('编辑器快捷键：只在编辑器内部接管', () => {
  it('67. Ctrl/⌘+S 映射为保存，Ctrl/⌘+Z 撤销，Shift+Z / Ctrl+Y 重做', () => {
    expect(matchEditorHotkey(key({ key: 's', ctrlKey: true }))).toBe('save')
    expect(matchEditorHotkey(key({ key: 's', metaKey: true }))).toBe('save')
    expect(matchEditorHotkey(key({ key: 'z', ctrlKey: true }))).toBe('undo')
    expect(matchEditorHotkey(key({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe('redo')
    expect(matchEditorHotkey(key({ key: 'y', ctrlKey: true }))).toBe('redo')
  })

  it('68. 无修饰键、Alt 组合、其它按键都不归编辑器管', () => {
    expect(matchEditorHotkey(key({ key: 's' }))).toBeNull()
    expect(matchEditorHotkey(key({ key: 's', ctrlKey: true, altKey: true }))).toBeNull()
    expect(matchEditorHotkey(key({ key: 'a', ctrlKey: true }))).toBeNull()
  })

  it('69. isInsideEditor 基于根节点包含关系，Canvas 的隐藏 textarea 也算内部', () => {
    const root = document.createElement('section')
    const hiddenTextarea = document.createElement('textarea')
    root.appendChild(hiddenTextarea)
    const outside = document.createElement('input')

    expect(isInsideEditor(root, hiddenTextarea)).toBe(true)
    expect(isInsideEditor(root, root)).toBe(true)
    expect(isInsideEditor(root, outside)).toBe(false)
    expect(isInsideEditor(null, hiddenTextarea)).toBe(false)
  })

  it('70. 焦点在编辑器外部时不拦截、不触发动作', () => {
    const root = document.createElement('section')
    const outside = document.createElement('input')
    document.body.append(root, outside)
    const onSave = vi.fn()
    const onUndo = vi.fn()
    const onRedo = vi.fn()

    const { detach } = useEditorHotkeys({
      root: ref(root),
      onSave,
      onUndo,
      onRedo,
    })

    const event = key({ key: 's', ctrlKey: true })
    Object.defineProperty(event, 'target', { value: outside })
    window.dispatchEvent(event)

    expect(onSave).not.toHaveBeenCalled()
    detach()
    root.remove()
    outside.remove()
  })

  it('71. 焦点在编辑器内部时触发保存并阻止浏览器默认行为', () => {
    const root = document.createElement('section')
    const inner = document.createElement('div')
    root.appendChild(inner)
    document.body.append(root)

    const onSave = vi.fn()
    const { detach } = useEditorHotkeys({
      root: ref(root),
      onSave,
      onUndo: vi.fn(),
      onRedo: vi.fn(),
    })

    const event = key({ key: 's', ctrlKey: true })
    Object.defineProperty(event, 'target', { value: inner })
    window.dispatchEvent(event)

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)

    detach()
    root.remove()
  })

  it('73. 内容面已经处理过的按键不再重复触发（避免一次 Ctrl+Z 撤两步）', () => {
    const root = document.createElement('section')
    const inner = document.createElement('div')
    root.appendChild(inner)
    document.body.append(root)

    const onUndo = vi.fn()
    const { detach } = useEditorHotkeys({
      root: ref(root),
      onSave: vi.fn(),
      onUndo,
      onRedo: vi.fn(),
    })

    const undo = key({ key: 'z', ctrlKey: true })
    Object.defineProperty(undo, 'target', { value: inner })
    undo.preventDefault()
    window.dispatchEvent(undo)

    expect(onUndo).not.toHaveBeenCalled()
    detach()
    root.remove()
  })

  it('72. 只读态下撤销/重做不触发，但保存仍可交给上层决定', () => {
    const root = document.createElement('section')
    const inner = document.createElement('div')
    root.appendChild(inner)
    document.body.append(root)

    const onUndo = vi.fn()
    const onRedo = vi.fn()
    const { detach } = useEditorHotkeys({
      root: ref(root),
      onSave: vi.fn(),
      onUndo,
      onRedo,
      readonly: () => true,
    })

    const undo = key({ key: 'z', ctrlKey: true })
    Object.defineProperty(undo, 'target', { value: inner })
    window.dispatchEvent(undo)
    const redo = key({ key: 'z', ctrlKey: true, shiftKey: true })
    Object.defineProperty(redo, 'target', { value: inner })
    window.dispatchEvent(redo)

    expect(onUndo).not.toHaveBeenCalled()
    expect(onRedo).not.toHaveBeenCalled()

    detach()
    root.remove()
  })
})
