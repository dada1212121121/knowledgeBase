#!/usr/bin/env node
// 生成 packages/kb-ui/src/tokens/contrast.css:只在 semantic.css / primitives.css 里的值不达标时,
// 把对应颜色往白(深色主题)或黑(浅色主题)方向推最小的量,直到在该主题所有背景上都达标。
// 不改动「GENERATED」的 semantic.css / primitives.css(它们的生成脚本不在仓库里);校准值全在 contrast.css,可单独审阅、可整个删掉。
// 跑法:node scripts/calibrate-contrast.mjs
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BGS, CONTROL_NEED, NEED, THEMES, TONE, TOKENS_DIR, accentTexts, contrast, hex, loadTheme, push, resolve, tintBackgrounds, toHex } from './lib/contrast.mjs'

const loaded = loadTheme(['primitives.css', 'semantic.css'])
const { base, themes } = loaded
const margin = 0.08 // 比阈值多留一点,避免四舍五入后刚好踩线

/** 把 color 往 toward 推到在 bgs 上都 ≥ need;已经达标就原样返回 null。 */
function fix(color, bgs, need, towardWhite) {
  const worst = (rgb) => Math.min(...bgs.map((bg) => contrast(rgb, bg)))
  if (worst(color) >= need) return null
  for (let step = 1; step <= 400; step++) {
    const next = push(color, towardWhite, step / 400)
    if (worst(next) >= need + margin) return toHex(next)
  }
  throw new Error('推到头也达不到')
}

const lines = [
  '/* 对比度校准:正文 ≥ 7:1,次要文字 ≥ 4.5:1,弱化(图标 / 分隔符 / 占位符)≥ 3:1,状态与强调文字 ≥ 4.5:1。',
  '   由 scripts/calibrate-contrast.mjs 生成,npm run lint 里的 check-contrast 守着;不要手改。semantic.css 里这些值原样保留,这里只覆盖不达标的。 */',
]
const SELECT = {
  dark: ':root[data-theme=dark],[data-theme=dark],:root:not([data-theme])',
  oled: ':root[data-theme=oled],[data-theme=oled]',
  slate: ':root[data-theme=slate],[data-theme=slate]',
  light: ':root[data-theme=light],[data-theme=light]',
  paper: ':root[data-theme=paper],[data-theme=paper]',
}
for (const theme of THEMES) {
  const vars = themes[theme]
  const bgs = BGS.map((name) => hex(resolve(vars[name], vars, base)))
  const decls = []
  const tints = tintBackgrounds(theme, loaded)
  for (const token of Object.keys(NEED)) {
    // 状态色文字还要在自己的淡色底(tag、提示条)上达标,否则 axe 会在 .tag.y 这类地方报 color-contrast
    const status = token.match(/^status-(\w+)-text$/)?.[1]
    const need = status ? [...bgs, ...tints[`status:${status}`]] : bgs
    const fixed = fix(hex(resolve(vars[token], vars, base)), need, NEED[token], TONE[theme] === 'd')
    if (fixed) decls.push(`--${token}:${fixed}`)
  }
  // 控件边界:从弱化文字色起步(它本来就 ≥ 3:1 的量级),推到所有背景上都 ≥ 3:1;总是写出来,供 CSS 直接引用
  for (const [token, need] of Object.entries(CONTROL_NEED)) {
    const seed = hex(resolve(vars['text-quaternary'], vars, base))
    decls.push(`--${token}:${fix(seed, bgs, need, TONE[theme] === 'd') ?? toHex(seed)}`)
  }
  if (decls.length) lines.push(`${SELECT[theme]}{${decls.join(';')}}`)
}
// 强调色文字:深色主题共用 text-d,浅色主题共用 text-l——要在同一类主题的所有背景上都达标
const prim = []
for (const [accent, texts] of Object.entries(accentTexts(base))) {
  for (const tone of ['d', 'l']) {
    const sameTone = THEMES.filter((theme) => TONE[theme] === tone)
    // 实心背景 + 强调色淡色底(选中的药丸、.tag.ac、目录高亮),同一类主题共用一个文字色,所以取全部
    const bgs = sameTone.flatMap((theme) => [
      ...BGS.map((name) => hex(resolve(themes[theme][name], themes[theme], base))),
      ...(tintBackgrounds(theme, loaded)[`accent:${accent}`] ?? []),
    ])
    const fixed = fix(hex(texts[tone]), bgs, 4.5, tone === 'd')
    if (fixed) prim.push(`--p-${accent}-text-${tone}:${fixed}`)
  }
}
if (prim.length) lines.push(`:root{${prim.join(';')}}`)
writeFileSync(join(TOKENS_DIR, 'contrast.css'), lines.join('\n') + '\n')
console.log(`已生成 contrast.css(${lines.length - 2} 条覆盖)`)
