// 设计 token 的守卫:对比度、排版与间距阶梯、密度两档。
// 对比度规则与阈值在 scripts/lib/contrast.mjs;lint 里也跑同一套(scripts/check-contrast.mjs)。
import { describe, expect, it } from 'vitest'
import { BGS, CONTROL_NEED, NEED, THEMES, contrast, hex, loadTheme, matrix, readToken, resolve, tintBackgrounds, tintMatrix } from '../../scripts/lib/contrast.mjs'

const scaleCss = readToken('scale.css')
const shellCss = readToken('shell.css')
const kitCss = readToken('kit.css')

describe('对比度(五个主题 × 全部背景)', () => {
  const rows = matrix()

  it('每一项都达标:正文 ≥7:1,次要 ≥4.5:1,弱化 ≥3:1,状态与强调色文字 ≥4.5:1', () => {
    const bad = rows.filter((row) => !row.ok).map((row) => `${row.theme} ${row.token} ${row.worst.toFixed(2)} < ${row.need}`)
    expect(bad).toEqual([])
  })

  it('覆盖面:5 个主题 × (8 个文字 token + 8 个强调色 + 控件边界)', () => {
    expect(THEMES).toHaveLength(5)
    expect(rows).toHaveLength(5 * (Object.keys(NEED).length + 8 + Object.keys(CONTROL_NEED).length))
    // 控件边界(开关关闭态、输入框)每个主题都必须有一行,否则深色下又会回到 1.2:1 却没人发现
    for (const theme of THEMES) expect(rows.some((row) => row.theme === theme && row.token === 'control-line')).toBe(true)
    expect(BGS).toEqual(['bg-canvas', 'bg-sidebar', 'surface-1', 'surface-2', 'surface-3', 'surface-sunken'])
  })

  it('控件边界的阈值是 WCAG 1.4.11 的 3:1,不能放宽', () => {
    expect(CONTROL_NEED['control-line']).toBe(3)
  })

  it('阈值本身没被放宽(这是规则,不是可调参数)', () => {
    expect(NEED['text-primary']).toBe(7)
    expect(NEED['text-secondary']).toBe(7)
    expect(NEED['text-tertiary']).toBe(4.5)
    expect(NEED['text-quaternary']).toBe(3)
    for (const key of ['status-success-text', 'status-warning-text', 'status-danger-text', 'status-info-text']) expect(NEED[key]).toBe(4.5)
  })

  it('对比度公式正确:黑白 21:1,同色 1:1', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5)
    expect(contrast([120, 120, 120], [120, 120, 120])).toBeCloseTo(1, 5)
  })

  it('校准只改了不达标的:正文主色原样;深色主题的次要文字比原先亮', () => {
    const before = loadTheme(['primitives.css', 'semantic.css'])
    const after = loadTheme()
    const lum = (value: string) => hex(value)!.reduce((a, b) => a + b, 0)
    expect(after.themes.dark!['text-primary']).toBe(before.themes.dark!['text-primary'])
    expect(lum(after.themes.dark!['text-tertiary']!)).toBeGreaterThan(lum(before.themes.dark!['text-tertiary']!))
    // 浅色主题的次要文字原本就达标,不该被动
    expect(after.themes.light!['text-tertiary']).toBe(before.themes.light!['text-tertiary'])
  })

  it('变异检查:把深色主题的弱化文字调回原值,检查必须变红', () => {
    const loaded = loadTheme()
    const original = loadTheme(['primitives.css', 'semantic.css'])
    loaded.themes.dark!['text-tertiary'] = original.themes.dark!['text-tertiary']!
    const bad = matrix(loaded).filter((row) => !row.ok)
    expect(bad.some((row) => row.theme === 'dark' && row.token === 'text-tertiary')).toBe(true)
    expect(resolve('var(--x)', { x: '#fff' })).toBe('#fff')
  })
})

describe('淡色底上的文字(标签、选中的药丸、提示条:axe color-contrast 暴露的缺口)', () => {
  it('强调色文字、状态色文字叠在 14% 淡色底上都 ≥4.5:1', () => {
    const bad = tintMatrix().filter((row) => !row.ok).map((row) => `${row.theme} ${row.token} ${row.worst.toFixed(2)}`)
    expect(bad).toEqual([])
  })

  it('覆盖面:5 个主题 × (8 个强调色 + 4 种状态色)', () => {
    expect(tintMatrix()).toHaveLength(5 * (8 + 4))
  })

  it('淡色底确实比实心底难:靛蓝文字在淡色底上的最差值低于它在实心底上的', () => {
    // 这条是在证明上面那张表有意义:如果淡色底算出来和实心底一样,说明检查没量到东西
    const solid = matrix().filter((row) => row.theme === 'light' && row.token === 'accent-text(indigo)')[0]!.worst
    const tinted = tintMatrix().filter((row) => row.theme === 'light' && row.token === 'accent-text(indigo) 在淡色底上')[0]!.worst
    expect(tinted).toBeLessThan(solid)
    expect(tinted).toBeGreaterThanOrEqual(4.5)
    const bgs = tintBackgrounds('light')['accent:indigo']!
    expect(bgs).toHaveLength(BGS.length)
  })

  it('变异检查:把浅色靛蓝文字调回校准前的 #525ecf(在淡色底上 4.38:1),检查必须变红', () => {
    const loaded = loadTheme()
    loaded.base['p-indigo-text-l'] = '#525ecf'
    const bad = tintMatrix(loaded).filter((row) => !row.ok)
    expect(bad.some((row) => row.theme === 'light' && row.token === 'accent-text(indigo) 在淡色底上')).toBe(true)
  })

  it('变异检查:把浅色的警告色文字调回校准前的 #8a6a10(在淡色底上 4.12:1),检查必须变红', () => {
    const loaded = loadTheme()
    loaded.themes.light!['status-warning-text'] = '#8a6a10'
    const bad = tintMatrix(loaded).filter((row) => !row.ok)
    expect(bad.some((row) => row.theme === 'light' && row.token === 'status-warning-text 在淡色底上')).toBe(true)
  })
})

describe('排版与间距阶梯(scale.css)', () => {
  const css = scaleCss
  const value = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim()

  it('字号阶梯 12/13/14/15/16/20/24/32 + 微型 11,全部乘字号偏好', () => {
    for (const size of [11, 12, 13, 14, 15, 16, 20, 24, 32]) expect(value(`text-${size}`)).toBe(`calc(${size}px * var(--fs))`)
    expect(css).not.toMatch(/--text-(17|18|19|21|22|23|28)\b/)
  })

  it('中文行高 1.6–1.75、字重不用 700', () => {
    for (const name of ['lh-body', 'lh-loose']) {
      const n = Number(value(name))
      expect(n).toBeGreaterThanOrEqual(1.6)
      expect(n).toBeLessThanOrEqual(1.75)
    }
    expect(value('fw-title')).toBe('600')
    expect(css).not.toMatch(/font-weight:\s*700/)
  })

  it('间距阶梯 4 / 8 / 12 / 16 / 24 / 32', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => value(`sp-${n}`))).toEqual(['4px', '8px', '12px', '16px', '24px', '32px'])
  })

  it('密度两档:舒适 48 / 紧凑 36;手机卡片内边距 16;触屏紧凑档也 ≥44', () => {
    const block = (selector: string) => css.match(new RegExp(`${selector.replace(/[[\]=]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
    expect(block(':root[data-ui-density=compact]')).toContain('--list-row-h: 36px')
    expect(block(':root[data-ui-density=compact]')).toContain('--nav-item-h: 32px')
    expect(css).toMatch(/:root,\s*:root\[data-ui-density=comfortable\]\s*\{[^}]*--list-row-h: 48px/)
    // 手机规则的选择器必须和密度档一样具体((0,2,0)):页面一直带着 data-ui-density="comfortable",
    // 写成 `:root { … }` 只有 (0,1,0),会被它盖掉,手机上的卡片内边距就一直是 20(这条断言以前正是把那个写法钉住了)
    expect(css).toMatch(/@media \(max-width: 599px\)\s*\{\s*:root\[data-ui-density\] \{ --card-pad-ui: 16px; \}/)
    // 特异性相同时后写的赢:手机规则必须排在 comfortable 规则后面
    expect(css.indexOf(':root[data-ui-density] { --card-pad-ui: 16px; }')).toBeGreaterThan(css.search(/:root,\s*:root\[data-ui-density=comfortable\]/))
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*data-ui-density=compact\][^}]*--list-row-h: 44px/)
  })

  it('新外壳与组件的样式表里不再写死阶梯内的字号(一律用 --text-N)', () => {
    for (const [file, text] of [['shell.css', shellCss], ['kit.css', kitCss]] as const) {
      for (const size of [11, 12, 13, 14, 15, 16, 20, 24, 32]) expect(text, `${file} 里还有 ${size}px 字号`).not.toMatch(new RegExp(`font-size:\\s*calc\\(${size}px`))
    }
  })
})
