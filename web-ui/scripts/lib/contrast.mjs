// 对比度计算与规则(WCAG 2.x 相对亮度公式),被 check-contrast.mjs(lint 时检查)和 calibrate-contrast.mjs(生成校准)共用。
//
// 规则来自设计规范「颜色」:深色、浅色两套,正文对比度 ≥ 7:1,次要文字 ≥ 4.5:1;状态色只在状态上用(其文字色也要 ≥ 4.5:1)。
// 落到 token 上:
//   --text-primary / --text-secondary   ≥ 7   (正文、表格单元格)
//   --text-tertiary                     ≥ 4.5 (说明、标签、时间等「次要文字」)
//   --text-quaternary                   ≥ 3   (只用于图标、分隔符、占位符这类非正文;WCAG 对非文本要求 3:1)
//   --status-*-text、--accent-text      ≥ 4.5 (状态与链接 / 强调文字)
// 每个都要在该主题的所有背景(画布、侧栏、三层表面、凹陷面)上达标。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const TOKENS_DIR = join(import.meta.dirname, '../../packages/kb-ui/src/tokens')
export const BGS = ['bg-canvas', 'bg-sidebar', 'surface-1', 'surface-2', 'surface-3', 'surface-sunken']
export const THEMES = ['dark', 'oled', 'slate', 'light', 'paper']
export const TONE = { dark: 'd', oled: 'd', slate: 'd', light: 'l', paper: 'l' }
export const NEED = {
  'text-primary': 7,
  'text-secondary': 7,
  'text-tertiary': 4.5,
  'text-quaternary': 3,
  'status-success-text': 4.5,
  'status-warning-text': 4.5,
  'status-danger-text': 4.5,
  'status-info-text': 4.5,
}

// 控件的边界 / 关闭态轨道(开关、输入框、搜索框)。WCAG 1.4.11 要求识别控件所需的图形和相邻颜色至少 3:1。
// 深色下原来的 rgba(白,.1) 轨道叠在 #101012 上只有约 1.3:1,开关关着时几乎看不见。
// 它不在 semantic.css 里,由校准脚本从 text-quaternary 起步,推到在该主题所有背景上都 ≥ 3:1,写进 contrast.css。
export const CONTROL_NEED = { 'control-line': 3 }

/** 读 tokens 目录下的一个 CSS 文件原文(单测里 CSS 的 ?raw 导入会被 vitest 清空,所以走 fs)。 */
export const readToken = (file) => readFileSync(join(TOKENS_DIR, file), 'utf8')

export const hex = (value) => {
  const match = String(value).trim().match(/^#([0-9a-f]{6})$/i)
  return match ? [0, 2, 4].map((index) => parseInt(match[1].slice(index, index + 2), 16)) : null
}
export const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`
const luminance = ([r, g, b]) => {
  const f = (c) => {
    c /= 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** 把颜色往白(dark)或黑(light)方向推 amount(0–1) */
export const push = (rgb, towardWhite, amount) => rgb.map((v) => (towardWhite ? v + (255 - v) * amount : v * (1 - amount)))

/** 读 CSS 文件里的 `选择器{--变量:值;…}`,按顺序叠加成「主题 → 变量表」。 */
export function loadTheme(files = ['primitives.css', 'semantic.css', 'contrast.css']) {
  const base = {}
  const themes = Object.fromEntries(THEMES.map((name) => [name, {}]))
  for (const file of files) {
    let css
    try {
      css = readFileSync(join(TOKENS_DIR, file), 'utf8')
    } catch {
      continue
    }
    css = css.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1]
      const decls = {}
      for (const decl of rule[2].matchAll(/--([\w-]+):([^;]+);?/g)) decls[decl[1]] = decl[2].trim()
      if (!Object.keys(decls).length) continue
      const named = THEMES.filter((theme) => selector.includes(`data-theme=${theme}`))
      // 只认「按主题」或「全局 :root」的规则;带 data-accent / data-tone 等其它属性的组合规则不在这里算
      if (/data-accent|data-tone|data-density|data-radius|data-font|data-motion/.test(selector)) continue
      if (named.length) for (const theme of named) Object.assign(themes[theme], decls)
      else if (/^\s*:root\s*$/.test(selector)) Object.assign(base, decls)
    }
  }
  return { base, themes }
}

/** 解析 `var(--x)` 引用(最多 4 层)。 */
export function resolve(value, ...scopes) {
  let current = value
  for (let depth = 0; depth < 4; depth++) {
    const match = current?.match?.(/^var\(--([\w-]+)\)$/)
    if (!match) break
    current = scopes.map((scope) => scope[match[1]]).find((v) => v !== undefined)
  }
  return current
}

export function accentTexts(base) {
  const out = {}
  for (const [key, value] of Object.entries(base)) {
    const match = key.match(/^p-(\w+)-text-([dl])$/)
    if (match) (out[match[1]] ??= {})[match[2]] = value
  }
  return out
}

/** 整张矩阵:返回所有检查项。 */
export function matrix(loaded = loadTheme()) {
  const { base, themes } = loaded
  const rows = []
  for (const theme of THEMES) {
    const vars = themes[theme]
    const bgs = BGS.map((name) => hex(resolve(vars[name], vars, base)))
    for (const [token, need] of Object.entries(NEED)) {
      const color = hex(resolve(vars[token], vars, base))
      const worst = Math.min(...bgs.map((bg) => contrast(color, bg)))
      rows.push({ theme, token, worst, need, ok: worst + 1e-9 >= need })
    }
    for (const [accent, texts] of Object.entries(accentTexts(base))) {
      const color = hex(texts[TONE[theme]])
      const worst = Math.min(...bgs.map((bg) => contrast(color, bg)))
      rows.push({ theme, token: `accent-text(${accent})`, worst, need: 4.5, ok: worst + 1e-9 >= 4.5 })
    }
    for (const [token, need] of Object.entries(CONTROL_NEED)) {
      // 还没生成:算不达标(worst=0),提示去跑校准脚本,而不是在这里崩掉
      const color = hex(resolve(vars[token], vars, base))
      const worst = color ? Math.min(...bgs.map((bg) => contrast(color, bg))) : 0
      rows.push({ theme, token, worst, need, ok: worst + 1e-9 >= need })
    }
  }
  return rows
}

// ---- 淡色底上的文字(axe color-contrast 暴露的缺口)----
// matrix() 只在「实心背景」(画布 / 侧栏 / 三层表面 / 凹陷面)上量文字。可界面上大量文字坐在
// 「强调色 / 状态色的淡色底」上:标签、选中的药丸、提示条、目录高亮。淡色底把背景拉向有色,对比度比实心底低,
// 例如浅色主题的靛蓝文字在 14% 靛蓝底上只有 4.38:1,按 matrix() 的结果看是达标的。
// 所以另算一张表:文字色叠在「淡色底铺在各层背景上」的结果上也要 ≥ 4.5。
// 淡色底的浓度取 --accent-soft / .tag 用的 14%。(曾试过再叠一层模拟「选中的行里放标签」,靛蓝文字要被压暗到 #424ca7,
// 整站强调色字都跟着变沉,代价太大;14% 单层的结果已经比 axe 实测的最差处(4.05:1)更严。)
export const TINT = 0.14
const mixRgb = (fg, bg, alpha) => fg.map((v, index) => v * alpha + bg[index] * (1 - alpha))
const STATUS_KEYS = ['success', 'warning', 'danger', 'info']

/** 某个主题下,每种「淡色底」铺在六层背景上的实际底色:{ 名称 → [rgb…] }。强调色按 p-<色>-500,状态色按 status-<名>。 */
export function tintBackgrounds(theme, loaded = loadTheme()) {
  const { base, themes } = loaded
  const vars = themes[theme]
  const bgs = BGS.map((name) => hex(resolve(vars[name], vars, base)))
  const out = {}
  for (const accent of Object.keys(accentTexts(base))) {
    const solid = hex(resolve(base[`p-${accent}-500`], base))
    if (!solid) continue
    out[`accent:${accent}`] = bgs.map((bg) => mixRgb(solid, bg, TINT))
  }
  for (const key of STATUS_KEYS) {
    const solid = hex(resolve(vars[`status-${key}`], vars, base))
    if (solid) out[`status:${key}`] = bgs.map((bg) => mixRgb(solid, bg, TINT))
  }
  return out
}

/** 淡色底上的文字检查表:强调色文字 × 8 个强调色,状态色文字 × 4 种状态,每个主题各一遍。 */
export function tintMatrix(loaded = loadTheme()) {
  const { base, themes } = loaded
  const rows = []
  for (const theme of THEMES) {
    const vars = themes[theme]
    const tints = tintBackgrounds(theme, loaded)
    for (const [accent, texts] of Object.entries(accentTexts(base))) {
      const color = hex(texts[TONE[theme]])
      const worst = Math.min(...tints[`accent:${accent}`].map((bg) => contrast(color, bg)))
      rows.push({ theme, token: `accent-text(${accent}) 在淡色底上`, worst, need: 4.5, ok: worst + 1e-9 >= 4.5 })
    }
    for (const key of STATUS_KEYS) {
      const color = hex(resolve(vars[`status-${key}-text`], vars, base))
      const worst = Math.min(...tints[`status:${key}`].map((bg) => contrast(color, bg)))
      rows.push({ theme, token: `status-${key}-text 在淡色底上`, worst, need: 4.5, ok: worst + 1e-9 >= 4.5 })
    }
  }
  return rows
}
