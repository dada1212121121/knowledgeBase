// 协作光标:别人光标上的名牌(腾讯文档式)和与之配套的颜色计算。
import './cursor.css'

// 颜色由服务端按用户 id 从 12 个固定色里挑(crates/kb-collab/src/types.rs),这里只负责"这个底色上用什么字色"。

/** 解析 #rrggbb;不认识的返回 null */
function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!match) return null
  const value = match[1]!
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)]
}

/** WCAG 相对亮度 */
function luminance([red, green, blue]: [number, number, number]): number {
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

/**
 * 在这个底色上用白字还是黑字。哪个对比度高用哪个:
 * 服务端调色板的 12 个颜色里,绿 / 青 / 橙 / 橄榄这 6 个上面白字只有 3.0~4.35(不到 4.5),必须用黑字。
 * 颜色缺失或写法不认识时当成深色,用白字(头像和名牌至少有一圈底色)。
 */
export function textOn(color: string): '#fff' | '#000' {
  const rgb = parseHex(color)
  if (!rgb) return '#fff'
  const lum = luminance(rgb)
  const white = 1.05 / (lum + 0.05)
  const black = (lum + 0.05) / 0.05
  return white >= black ? '#fff' : '#000'
}

/** 光标名牌用的颜色:服务端没给(或写法不认识)时退回一个中性的灰蓝,不显示成透明 */
export function cursorColor(color: unknown): string {
  return typeof color === 'string' && parseHex(color) ? color : '#5c6bc0'
}

interface CursorUser {
  name?: unknown
  color?: unknown
}

/**
 * y-prosemirror 的 `cursorBuilder`:返回光标线 + 名牌的 DOM。
 * 和库自带的区别:名牌字色按底色算(见 textOn);名字过长截断;名牌挂在 `data-name` 上不重复放进文本,
 * 读屏软件不会把别人的名字念进正文;样式全在 CSS(`.kb-cursor*`),这里只放数据。
 */
export function buildCursor(user: CursorUser): HTMLElement {
  const color = cursorColor(user.color)
  const name = typeof user.name === 'string' && user.name.trim() ? user.name.trim() : '协作者'
  const cursor = document.createElement('span')
  cursor.className = 'kb-cursor'
  cursor.style.setProperty('--cursor-color', color)
  cursor.style.setProperty('--cursor-ink', textOn(color))
  // 前后各放一个零宽连接符:库自带的做法,防止光标线在行首 / 行尾被浏览器折叠掉
  cursor.append(document.createTextNode('\u2060'))
  const label = document.createElement('span')
  label.className = 'kb-cursor-label'
  label.setAttribute('aria-hidden', 'true')
  label.textContent = name
  cursor.append(label)
  cursor.append(document.createTextNode('\u2060'))
  // \u5143\u7d20\u8981\u7b49\u7f16\u8f91\u5668\u628a\u5b83\u63d2\u8fdb\u9875\u9762\u4e4b\u540e\u624d\u91cf\u5f97\u51fa\u4f4d\u7f6e;y-prosemirror \u5728\u5bf9\u65b9\u5149\u6807\u79fb\u52a8\u65f6\u4f1a\u91cd\u5efa\u8fd9\u4e2a\u5143\u7d20,\u6240\u4ee5\u6bcf\u6b21\u90fd\u4f1a\u91cd\u65b0\u91cf
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fitCursorLabel(cursor))
  return cursor
}

/**
 * 名牌要不要翻到光标左边。名牌默认向右展开,光标靠近一行最右端时会伸出文档区(手机上整个伸出屏幕)。
 * 只有「右边放不下、左边放得下」才翻:两边都放不下(窗口极窄)翻了也一样伸出去,保持向右并靠 max-width 截断。
 */
export function shouldFlip(cursorLeft: number, labelWidth: number, boundsLeft: number, boundsRight: number): boolean {
  const overflowsRight = cursorLeft + labelWidth > boundsRight
  const fitsOnLeft = cursorLeft - labelWidth >= boundsLeft
  return overflowsRight && fitsOnLeft
}

/** 量一个光标的名牌,放不下就翻到左边(类名 is-flip,样式见 cursor.css)。边界取文档区与屏幕的交集。 */
export function fitCursorLabel(cursor: HTMLElement): void {
  const label = cursor.querySelector<HTMLElement>('.kb-cursor-label')
  // 文档区的根：旧编辑器是 .kb-doc，新文本面是 .kb-text-surface；边界取它与屏幕的交集
  const root = cursor.closest<HTMLElement>('.kb-doc, .kb-text-surface')
  if (!label || !root || !cursor.isConnected) return
  // 先去掉旧的翻转再量:位置变了(别人在前面打字、窗口变宽)之前翻过的可能已经不需要翻了
  cursor.classList.remove('is-flip')
  const at = cursor.getBoundingClientRect()
  const width = label.getBoundingClientRect().width
  const area = root.getBoundingClientRect()
  if (shouldFlip(at.left, width, Math.max(0, area.left), Math.min(window.innerWidth, area.right))) cursor.classList.add('is-flip')
}

/** 重新量文档里所有人的名牌(窗口大小变了、点头像跳转让名牌重新亮出之前) */
export function fitCursorLabels(root: ParentNode): void {
  for (const cursor of root.querySelectorAll<HTMLElement>('.kb-cursor')) fitCursorLabel(cursor)
}

/** 选区高亮:同色的半透明底。库默认是 `{ style: 'background-color: <color>70' }`,这里用类名,颜色交给 CSS 变量 */
export function buildSelection(user: CursorUser): { class: string; style: string } {
  return { class: 'kb-cursor-selection', style: `--cursor-color: ${cursorColor(user.color)};` }
}
