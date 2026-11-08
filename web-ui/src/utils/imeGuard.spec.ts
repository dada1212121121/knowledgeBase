// 输入法组字守卫:有状态的 createImeGuard(整个编辑器用)与无状态的 menuKeyOf(候选面板的键盘导航用)。
import { describe, expect, it } from 'vitest'
import { IME_GRACE_MS, IME_OWNED_KEYS, createImeGuard, menuKeyOf } from './imeGuard'

const key = (name: string, extra: Partial<{ isComposing: boolean; keyCode: number; shiftKey: boolean }> = {}) => ({
  key: name,
  isComposing: false,
  keyCode: 0,
  shiftKey: false,
  ...extra,
})

describe('createImeGuard', () => {
  it('没有组字时,普通按键不归输入法', () => {
    const guard = createImeGuard(() => 1000)
    expect(guard.composing).toBe(false)
    for (const name of IME_OWNED_KEYS) expect(guard.owns(key(name))).toBe(false)
  })

  it('compositionstart 到 compositionend 之间,所有按键都归输入法(包括 key 是 Process 的)', () => {
    const guard = createImeGuard(() => 1000)
    guard.start()
    expect(guard.composing).toBe(true)
    expect(guard.owns(key('Enter'))).toBe(true)
    expect(guard.owns(key('ArrowDown'))).toBe(true)
    expect(guard.owns(key('Process', { keyCode: 229 }))).toBe(true)
  })

  it('浏览器没发 compositionstart 但 keydown 自己带 isComposing 时也认', () => {
    const guard = createImeGuard(() => 1000)
    expect(guard.owns(key('Escape', { isComposing: true }))).toBe(true)
  })

  it('组字结束后恢复:回车、方向键、Esc 不再归输入法', () => {
    let clock = 1000
    const guard = createImeGuard(() => clock)
    guard.start()
    guard.end()
    clock += IME_GRACE_MS + 1
    expect(guard.composing).toBe(false)
    expect(guard.owns(key('Enter'))).toBe(false)
    expect(guard.owns(key('ArrowDown'))).toBe(false)
    expect(guard.owns(key('Escape'))).toBe(false)
  })

  it('Safari:compositionend 之后紧跟的上屏回车(isComposing 已是 false)在短窗口内仍归输入法', () => {
    let clock = 1000
    const guard = createImeGuard(() => clock)
    guard.start()
    guard.end()
    clock += 5
    expect(guard.owns(key('Enter'))).toBe(true)
    expect(guard.owns(key('Enter', { keyCode: 229 }))).toBe(true)
    // 方向键不在这个宽限里:组字一结束用户马上按↓就是想移动菜单
    expect(guard.owns(key('ArrowDown'))).toBe(false)
    clock += IME_GRACE_MS
    expect(guard.owns(key('Enter'))).toBe(false)
  })

  it('下一次组字开始时重新占用', () => {
    let clock = 1000
    const guard = createImeGuard(() => clock)
    guard.start()
    guard.end()
    clock += 500
    guard.start()
    expect(guard.owns(key('Enter'))).toBe(true)
  })
})

describe('menuKeyOf', () => {
  it('没有组字时:↓ 下一项,↑ 上一项,回车确认,Esc 取消', () => {
    expect(menuKeyOf(key('ArrowDown'))).toBe('next')
    expect(menuKeyOf(key('ArrowUp'))).toBe('prev')
    expect(menuKeyOf(key('Enter'))).toBe('confirm')
    expect(menuKeyOf(key('Escape'))).toBe('cancel')
  })

  it('组字中(isComposing)这些键都归输入法,返回 null', () => {
    for (const name of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) expect(menuKeyOf(key(name, { isComposing: true }))).toBeNull()
  })

  it('keyCode 229(Safari 上屏回车 isComposing 已是 false)也归输入法', () => {
    expect(menuKeyOf(key('Enter', { keyCode: 229 }))).toBeNull()
    expect(menuKeyOf(key('ArrowDown', { keyCode: 229 }))).toBeNull()
  })

  it('Shift+回车是换行,不是确认', () => {
    expect(menuKeyOf(key('Enter', { shiftKey: true }))).toBeNull()
  })

  it('其它键没有面板含义', () => {
    expect(menuKeyOf(key('a'))).toBeNull()
    expect(menuKeyOf(key('Tab'))).toBeNull()
    expect(menuKeyOf(key(' '))).toBeNull()
  })
})
