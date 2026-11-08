import { describe, expect, it } from 'vitest'
import { buildCursor, buildSelection, cursorColor, fitCursorLabel, fitCursorLabels, shouldFlip, textOn } from './cursor'

/** 服务端调色板(crates/kb-collab/src/types.rs):测试里照抄一份,调色板改了这里要跟着改 */
const PALETTE = ['#e03131', '#c2255c', '#9c36b5', '#6741d9', '#3b5bdb', '#1971c2', '#0c8599', '#099268', '#2f9e44', '#e67700', '#d9480f', '#5c940d']

function contrast(foreground: string, background: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const fg = foreground === '#fff' ? '#ffffff' : foreground === '#000' ? '#000000' : foreground
  const [a, b] = [lum(fg), lum(background)].sort((x, y) => y - x) as [number, number]
  return (a + 0.05) / (b + 0.05)
}

describe('textOn', () => {
  it('服务端调色板的 12 个颜色:选出来的字色对比度都 ≥ 4.5', () => {
    for (const color of PALETTE) expect(contrast(textOn(color), color), color).toBeGreaterThanOrEqual(4.5)
  })
  it('浅底色用黑字,深底色用白字', () => {
    expect(textOn('#ffeb3b')).toBe('#000')
    expect(textOn('#1a237e')).toBe('#fff')
  })
  it('绿 / 橙这类白字不达标的颜色选黑字(固定写白字会读不清)', () => {
    expect(textOn('#2f9e44')).toBe('#000')
    expect(textOn('#e67700')).toBe('#000')
  })
  it('颜色缺失或写法不认识:当深色处理', () => {
    expect(textOn('')).toBe('#fff')
    expect(textOn('red')).toBe('#fff')
  })
})

describe('cursorColor', () => {
  it('合法颜色原样返回,缺失 / 不认识的退回中性色而不是透明', () => {
    expect(cursorColor('#1971c2')).toBe('#1971c2')
    expect(cursorColor(undefined)).toBe('#5c6bc0')
    expect(cursorColor('javascript:alert(1)')).toBe('#5c6bc0')
    expect(cursorColor('url(x)')).toBe('#5c6bc0')
  })
})

describe('buildCursor', () => {
  it('名字在名牌里,颜色与字色走 CSS 变量(不拼进 style 字符串)', () => {
    const el = buildCursor({ name: 'Alice', color: '#2f9e44' })
    expect(el.className).toBe('kb-cursor')
    expect(el.style.getPropertyValue('--cursor-color')).toBe('#2f9e44')
    expect(el.style.getPropertyValue('--cursor-ink')).toBe('#000')
    expect(el.querySelector('.kb-cursor-label')?.textContent).toBe('Alice')
  })
  it('名牌对读屏软件隐藏:别人的名字不该被念进正文', () => {
    expect(buildCursor({ name: 'Alice', color: '#e03131' }).querySelector('.kb-cursor-label')?.getAttribute('aria-hidden')).toBe('true')
  })
  it('名字缺失显示「协作者」;名字里的标签当文本,不会变成元素', () => {
    expect(buildCursor({ color: '#e03131' }).querySelector('.kb-cursor-label')?.textContent).toBe('协作者')
    const evil = buildCursor({ name: '<img src=x onerror=alert(1)>', color: '#e03131' })
    expect(evil.querySelector('img')).toBeNull()
    expect(evil.querySelector('.kb-cursor-label')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })
  it('颜色是注入内容时不进样式', () => {
    const el = buildCursor({ name: 'x', color: 'red; background:url(//evil)' })
    expect(el.style.getPropertyValue('--cursor-color')).toBe('#5c6bc0')
  })
})

describe('shouldFlip(名牌放不下就翻到光标左边)', () => {
  it('右边放得下:不翻', () => {
    expect(shouldFlip(100, 80, 0, 400)).toBe(false)
  })
  it('右边放不下、左边放得下:翻', () => {
    expect(shouldFlip(350, 80, 0, 400)).toBe(true)
  })
  it('两边都放不下(窗口极窄):不翻,翻了一样伸出去,交给 max-width 截断', () => {
    expect(shouldFlip(30, 80, 0, 60)).toBe(false)
  })
  it('刚好贴边不算放不下', () => {
    expect(shouldFlip(320, 80, 0, 400)).toBe(false)
    expect(shouldFlip(321, 80, 0, 400)).toBe(true)
  })
})

describe('fitCursorLabel', () => {
  /** jsdom 不排版,getBoundingClientRect 全是 0:按需要给元素写死一个矩形 */
  function rect(el: Element, left: number, width: number) {
    el.getBoundingClientRect = () => ({ left, right: left + width, width, top: 0, bottom: 20, height: 20, x: left, y: 0, toJSON: () => ({}) })
  }
  function mountCursor(cursorLeft: number, labelWidth: number, area: { left: number; width: number }) {
    const root = document.createElement('div')
    root.className = 'kb-doc'
    rect(root, area.left, area.width)
    const cursor = buildCursor({ name: '某人', color: '#1971c2' })
    root.append(cursor)
    document.body.append(root)
    rect(cursor, cursorLeft, 2)
    rect(cursor.querySelector('.kb-cursor-label')!, cursorLeft, labelWidth)
    return { root, cursor }
  }

  it('靠右放不下:加 is-flip;位置挪回来再量,翻转会撤掉', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
    const { root, cursor } = mountCursor(350, 80, { left: 0, width: 400 })
    fitCursorLabel(cursor)
    expect(cursor.classList.contains('is-flip')).toBe(true)
    rect(cursor, 100, 2)
    fitCursorLabels(root)
    expect(cursor.classList.contains('is-flip')).toBe(false)
    root.remove()
  })

  it('边界取文档区与屏幕的交集:文档区比屏幕宽时按屏幕算', () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
    const { root, cursor } = mountCursor(340, 80, { left: 0, width: 800 })
    fitCursorLabel(cursor)
    expect(cursor.classList.contains('is-flip')).toBe(true)
    root.remove()
  })

  it('不在文档里的光标(还没插入)不动', () => {
    const cursor = buildCursor({ name: 'x', color: '#1971c2' })
    fitCursorLabel(cursor)
    expect(cursor.classList.contains('is-flip')).toBe(false)
  })
})

describe('buildSelection', () => {
  it('用类名和 CSS 变量,颜色非法时退回中性色', () => {
    expect(buildSelection({ color: '#1971c2' })).toEqual({ class: 'kb-cursor-selection', style: '--cursor-color: #1971c2;' })
    expect(buildSelection({ color: 'x;y' }).style).toBe('--cursor-color: #5c6bc0;')
  })
})
