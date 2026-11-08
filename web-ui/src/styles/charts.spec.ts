// 图表色板的守卫:分类色 --viz-1…6 在 5 个主题 × 6 层表面上对比度 ≥ 3:1(WCAG 非文本),
// 相邻分类不能被改成几乎一样的颜色,坐标轴文字要达到次要文字的 4.5:1。
// 对比度的算法与表面色取自 scripts/lib/contrast.mjs(lint 里的 check-contrast 用的是同一套)。
import { describe, expect, it } from 'vitest'
import { BGS, THEMES, TONE, contrast, hex, loadTheme, readToken, resolve } from '../../scripts/lib/contrast.mjs'

const css = readToken('charts.css')

/** 读 `选择器 { --viz-1: #xxxxxx; … }` 里的六个分类色。 */
function palette(selectorPattern: RegExp): string[] {
  const rule = css.match(selectorPattern)
  if (!rule) throw new Error(`charts.css 里找不到 ${selectorPattern}`)
  return [1, 2, 3, 4, 5, 6].map((index) => {
    const value = rule[1]!.match(new RegExp(`--viz-${index}:\\s*(#[0-9a-fA-F]{6})`))?.[1]
    if (!value) throw new Error(`--viz-${index} 缺失或不是 6 位十六进制`)
    return value
  })
}

const dark = palette(/:root\s*\{([^}]*)\}/)
const light = palette(/:root\[data-tone=light\][^{]*\{([^}]*)\}/)
const loaded = loadTheme()
/** 把主题里的一个 token 解析成 RGB;token 不存在就直接报错,不让 undefined 悄悄变成 NaN 通过比较 */
const rgbOf = (theme: string, name: string): number[] => {
  const vars = loaded.themes[theme]!
  const value = resolve(vars[name], vars, loaded.base)
  const parsed = value ? hex(value) : null
  if (!parsed) throw new Error(`${theme} 主题里 --${name} 解析不出颜色`)
  return parsed
}
const surfaces = (theme: string) => BGS.map((name) => rgbOf(theme, name))

describe('图表分类色板', () => {
  for (const theme of THEMES) {
    const colors = TONE[theme] === 'd' ? dark : light
    it(`${theme}:六个分类色在所有表面上对比度 ≥ 3:1`, () => {
      const bgs = surfaces(theme)
      const bad = colors
        .map((color, index) => ({ name: `--viz-${index + 1} ${color}`, worst: Math.min(...bgs.map((bg) => contrast(hex(color)!, bg))) }))
        .filter((item) => item.worst < 3)
        .map((item) => `${item.name} 最差 ${item.worst.toFixed(2)}`)
      expect(bad).toEqual([])
    })
  }

  it('同一套里任意两个分类色不能太像(RGB 距离 ≥ 45)', () => {
    const distance = (a: string, b: string) => {
      const [r1, g1, b1] = hex(a)!
      const [r2, g2, b2] = hex(b)!
      return Math.hypot(r1 - r2, g1 - g2, b1 - b2)
    }
    const close: string[] = []
    for (const [label, set] of [['深色', dark], ['浅色', light]] as const) {
      for (let i = 0; i < set.length; i += 1) {
        for (let j = i + 1; j < set.length; j += 1) {
          const d = distance(set[i]!, set[j]!)
          if (d < 45) close.push(`${label} --viz-${i + 1} 与 --viz-${j + 1} 只差 ${d.toFixed(0)}`)
        }
      }
    }
    expect(close).toEqual([])
  })

  it('深色和浅色是两套不同的值(浅色不是复制深色)', () => {
    expect(dark.some((color, index) => color !== light[index])).toBe(true)
    expect(dark.filter((color, index) => color === light[index])).toEqual([])
  })

  it('坐标轴、网格、「其它」、回落标记用的都是已有 token,不另写颜色', () => {
    for (const name of ['viz-other', 'viz-axis', 'viz-grid', 'viz-flag']) {
      expect(css).toMatch(new RegExp(`--${name}:\\s*var\\(--[\\w-]+\\)`))
    }
  })

  it('轴文字 token(--text-tertiary)在每个主题的每层表面上 ≥ 4.5:1;回落标记(--status-danger)≥ 3:1', () => {
    expect(css).toContain('--viz-axis: var(--text-tertiary)')
    expect(css).toContain('--viz-flag: var(--status-danger)')
    for (const theme of THEMES) {
      const bgs = surfaces(theme)
      const axis = rgbOf(theme, 'text-tertiary')
      const flag = rgbOf(theme, 'status-danger')
      expect(Math.min(...bgs.map((bg) => contrast(axis, bg))), `${theme} 轴文字`).toBeGreaterThanOrEqual(4.5)
      expect(Math.min(...bgs.map((bg) => contrast(flag, bg))), `${theme} 回落标记`).toBeGreaterThanOrEqual(3)
    }
  })
})
