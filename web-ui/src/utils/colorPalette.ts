// 文字颜色 / 背景高亮的调色板与 Markdown 写法(单一真源)。
//
// 文本面(ProseMirror)与工具栏、Markdown 编解码共用的调色板（从旧编辑器抽出； 删除旧编辑器后只剩这一处）。
// 写法:`<span style="color: #e5484d">红字</span>` / `<span style="background-color: #fff3a3">黄底</span>`。
// 常用色仍按 key 渲染成 class（深浅色主题各自取对比合适的值）；自定义色直接把 6 位 hex 存进 key，
// 由 schema 写成内联 style，Markdown 里也是同一个写法，往返不丢颜色。

export type ColorProp = 'color' | 'background-color' | 'font-family'

/** 自定义色只接受 6 位 hex；统一小写，Markdown 往返时不会因为大小写产生两份。 */
const HEX_COLOR = /^#[0-9a-f]{6}$/i
export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value.trim())
}
export function normalizeColorHex(value: string): string | null {
  const text = value.trim().toLowerCase()
  return HEX_COLOR.test(text) ? text : null
}

export const TEXT_COLORS: { key: string; label: string; hex: string }[] = [
  { key: 'gray', label: '灰色', hex: '#8b8d98' },
  { key: 'red', label: '红色', hex: '#e5484d' },
  { key: 'orange', label: '橙色', hex: '#f76b15' },
  { key: 'yellow', label: '黄色', hex: '#ca8a04' },
  { key: 'green', label: '绿色', hex: '#30a46c' },
  { key: 'blue', label: '蓝色', hex: '#0090ff' },
  { key: 'purple', label: '紫色', hex: '#8e4ec6' },
]
export const BACKGROUND_COLORS: { key: string; label: string; hex: string }[] = [
  { key: 'gray', label: '灰底', hex: '#ececec' },
  { key: 'red', label: '红底', hex: '#ffe3e3' },
  { key: 'orange', label: '橙底', hex: '#ffe8d1' },
  { key: 'yellow', label: '黄底', hex: '#fff3a3' },
  { key: 'green', label: '绿底', hex: '#d3f9d8' },
  { key: 'blue', label: '蓝底', hex: '#d0ebff' },
  { key: 'purple', label: '紫底', hex: '#e5dbff' },
]

/**
 * 字体：key → 显示名 + CSS 字体栈。
 * 字体栈里不带引号（`PingFang SC` 这种带空格的名字不加引号 CSS 也认）：它要写进 Markdown 的 `style="…"` 属性里，
 * 带引号会和属性的引号撞在一起。排在前面的是各系统自带的字体（Mac 苹方 / 宋体-简、Windows 雅黑 / 宋体 / 楷体 / 仿宋），
 * 最后一个是通用族兜底，哪个系统都能显示成同一类字体。
 * 它和 TEXT_COLORS 同属「字符样式」，共用同一个 kb_color 标记（prop = 'font-family'），写法也一样：`<span style="font-family: …">`。
 */
export const FONT_FAMILIES: { key: string; label: string; hex: string }[] = [
  { key: 'sans', label: '黑体', hex: 'PingFang SC, Microsoft YaHei, Noto Sans SC, sans-serif' },
  { key: 'serif', label: '宋体', hex: 'Songti SC, SimSun, Noto Serif SC, serif' },
  { key: 'kai', label: '楷体', hex: 'Kaiti SC, KaiTi, STKaiti, serif' },
  { key: 'fang', label: '仿宋', hex: 'STFangsong, FangSong, serif' },
  { key: 'mono', label: '等宽', hex: 'SF Mono, Cascadia Code, Consolas, Menlo, monospace' },
  { key: 'georgia', label: 'Georgia', hex: 'Georgia, Times New Roman, serif' },
  { key: 'arial', label: 'Arial', hex: 'Arial, Helvetica, sans-serif' },
]

const paletteOf = (prop: ColorProp) => (prop === 'color' ? TEXT_COLORS : prop === 'background-color' ? BACKGROUND_COLORS : FONT_FAMILIES)

/** 比较用的规范化：小写、去引号、逗号后统一一个空格、空白压成一个（写进 Markdown 的字体栈别的软件可能改过空格 / 引号） */
const normalize = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')

/** `#E5484D` → 'red'；不在调色板里返回 null（自定义 hex 由调用方保留原值）。 */
export function colorKey(prop: ColorProp, hex: string): string | null {
  const value = normalize(hex)
  return paletteOf(prop).find((item) => normalize(item.hex) === value)?.key ?? null
}
export function colorHex(prop: ColorProp, key: string): string | null {
  return paletteOf(prop).find((item) => item.key === key)?.hex ?? normalizeColorHex(key)
}

/** 颜色 span 的开标签(大小写、空格、末尾分号都放宽);闭标签 */
export const COLOR_SPAN_OPEN = /^<span\s+style\s*=\s*["']\s*(color|background-color)\s*:\s*(#[0-9a-fA-F]{6})\s*;?\s*["']\s*>$/
export const COLOR_SPAN_CLOSE = /^<\/span\s*>$/

/** 字体 span 的开标签（`<span style="font-family: …">`；字体栈里不含引号，见 FONT_FAMILIES） */
export const FONT_SPAN_OPEN = /^<span\s+style\s*=\s*(?:"\s*font-family\s*:\s*([^";]+?)\s*;?\s*"|'\s*font-family\s*:\s*([^';]+?)\s*;?\s*')\s*>$/i

/**
 * 一段行内 HTML 是不是颜色 / 字体 span 开标签：是就返回 { prop, key }。
 * 颜色接受常用色 key 和任意 6 位 hex（自定义色）；字体只认表里的字体栈。
 * 不是的话返回 null，调用方把它当普通 HTML 原样保留。
 */
export function parsePaletteSpan(html: string): { prop: ColorProp; key: string } | null {
  const color = COLOR_SPAN_OPEN.exec(html)
  if (color) {
    const prop = color[1]!.toLowerCase() as ColorProp
    // 常用色映射回 key（主题色值可随深浅色变化）；其余 6 位 hex 原样作为 key，支持自定义颜色
    const key = colorKey(prop, color[2]!) ?? normalizeColorHex(color[2]!)
    return key ? { prop, key } : null
  }
  const font = FONT_SPAN_OPEN.exec(html)
  if (font) {
    const key = colorKey('font-family', (font[1] ?? font[2])!)
    return key ? { prop: 'font-family', key } : null
  }
  return null
}

/** 序列化时写回的开标签 */
export function colorSpanOpen(prop: ColorProp, key: string): string {
  // 自定义色 key 本身就是 hex；异常 key 才退回灰色，避免写出 `color: undefined`
  return `<span style="${prop}: ${colorHex(prop, key) ?? '#8b8d98'}">`
}
