/**
 * 编辑器工具栏的线性图标（16×16 视框、1.5 描边，与 kb-ui 的 KbIcon 同一套画法）
 *
 * 为什么按动作 id 查表、而不是改动作定义里的 `icon` 字段：
 * - `icon` 是扩展接口的一部分（第三方扩展、斜杠菜单、aria-label 都在用短字符），改它会动到契约；
 * - 字符图标（B / I / 🔗 / 🖼）在不同系统上字体、emoji 风格各不相同，深色主题里彩色 emoji 尤其扎眼。
 * 所以 Chrome 渲染时先按 id 查这里，查到就画 SVG；查不到（第三方扩展、新动作）仍显示原来的字符，不会出现空按钮。
 */
// 直接引路径表文件：编辑器是异步分包，不为几条路径拉进 kb-ui 的整个入口
import { iconPaths } from '@kb-ui/components/icons'

/** 一个图标 = 若干条 path（全部 stroke，不填充） */
export type ToolIconPaths = readonly string[]

/** 小圆点：圆角端点的零长线段在 1.5 描边下只有 1.5px，看不清；画成半径 0.9 的小圆，描边后约 3px */
const dot = (x: number, y: number) => `M${x} ${y - 0.9}a.9.9 0 1 1 0 1.8a.9.9 0 1 1 0-1.8z`

/** 圆角方框（任务列表 / 代码块 / 提示块共用的外框） */
const ROUNDED_BOX = 'M4 2.5h8A1.5 1.5 0 0 1 13.5 4v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5z'

const ICONS = {
  heading: ['M4 8h8', 'M4 13V3', 'M12 13V3'],
  // 正文（段落符 ¶）：斜杠菜单、块菜单里「正文」一项用，和标题的 H 区分
  paragraph: ['M12.5 2.5H7a3 3 0 0 0 0 6h3', 'M10 2.5v11', 'M12.5 2.5v11'],
  quote: ['M2.5 3.5h11', 'M6 8h7.5', 'M6 12.5h7.5', 'M2.5 8v4.5'],
  bold: ['M4.5 2.75h4a2.6 2.6 0 0 1 0 5.2h-4z', 'M4.5 7.95h4.75a2.65 2.65 0 0 1 0 5.3H4.5z'],
  italic: ['M12.5 2.75h-5.5', 'M9 13.25H3.5', 'M10 2.75 6 13.25'],
  underline: ['M4.5 2.5V7a3.5 3.5 0 0 0 7 0V2.5', 'M3.5 13.5h9'],
  strike: ['M2.5 8h11', 'M11 4a3 2.25 0 0 0-3-1.5c-1.8 0-3 .9-3 2.1 0 .7.35 1.1.9 1.4', 'M10.3 9.4c.45.35.7.8.7 1.4 0 1.35-1.3 2.2-3 2.2a3.2 2.4 0 0 1-3.2-1.7'],
  code: ['M10.5 12l4-4-4-4', 'M5.5 4l-4 4 4 4'],
  color: ['M4.5 11 8 2.75 11.5 11', 'M5.75 8h4.5', 'M3 13.75h10'],
  font: ['M2 12.5 5.5 3.5 9 12.5', 'M3.3 9.5h4.4', 'M13.5 8.5a2 2 0 1 0 0 4c1 0 1.7-.7 2-1.5v-2.5', 'M11.5 8.5v4'],
  bullet: [dot(3, 4), dot(3, 8), dot(3, 12), 'M6.5 4h7', 'M6.5 8h7', 'M6.5 12h7'],
  ordered: ['M7 4h6.5', 'M7 8h6.5', 'M7 12h6.5', 'M2.6 3.1 3.6 2.6v3.4', 'M2.5 9.6c0-.6.45-1 1-1s1 .4 1 .95c0 .75-2 1.35-2 2.45h2'],
  task: [ROUNDED_BOX, 'M5.25 8.25 7 10l3.75-4'],
  link: ['M6.75 9.25a3 3 0 0 0 4.5.3l1.8-1.8a3 3 0 0 0-4.25-4.25l-1 1', 'M9.25 6.75a3 3 0 0 0-4.5-.3l-1.8 1.8a3 3 0 0 0 4.25 4.25l1-1'],
  image: iconPaths.image,
  table: ['M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z', 'M2.5 6.25h11', 'M2.5 9.75h11', 'M8 6.25v7.25'],
  plus: iconPaths.plus,
  codeblock: [ROUNDED_BOX, 'M6.5 6 4.75 8l1.75 2', 'M9.5 6l1.75 2-1.75 2'],
  diagram: ['M3 2.5h3.5v3.5H3z', 'M9.5 10h3.5v3.5H9.5z', 'M4.75 6v2.25a1.5 1.5 0 0 0 1.5 1.5h3.25'],
  math: ['M12 3H4l4.5 5L4 13h8'],
  wikilink: ['M5.5 2.5h-2v11h2', 'M10.5 2.5h2v11h-2', 'M6.75 8h2.5'],
  file: iconPaths.doc,
  attachment: ['M13 7.5 8.1 12.4a3.1 3.1 0 0 1-4.4-4.4l5-5a2.05 2.05 0 0 1 2.9 2.9l-5 5a1 1 0 0 1-1.45-1.45l4.6-4.6'],
  callout: [ROUNDED_BOX, 'M8 7.25v3.5', dot(8, 5.25)],
  hr: ['M2.5 8h11'],
  // 突出显示：马克笔（笔身 + 笔帽 + 纸面基线），和「文字颜色」的 A 区分开
  highlight: ['M3 13.5h10', 'M3.5 12.5 10 6l1.5 1.5-6.5 6.5z', 'M9.5 5 11.5 3 13 4.5 11 6.5'],
  lineSpacing: ['M2.5 3.5h7', 'M2.5 7h7', 'M2.5 10.5h7', 'M11 3v10', 'M9 5l2-2 2 2', 'M9 11l2 2 2-2'],
  // 分页符：上下两页的边线 + 中间虚线，和「分隔线」的单线区分
  pageBreak: ['M2.5 3.5h11', 'M2.5 12.5h11', 'M4 8h1.5', 'M7 8h2', 'M11 8h1.5'],
  find: iconPaths.search,
  source: ['M5 4.5 1.5 8 5 11.5', 'M11 4.5 14.5 8 11 11.5', 'M9.25 3 6.75 13'],
  outline: ['M2.5 3.5h11', 'M5 8h8.5', 'M5 12.5h8.5', dot(2.75, 8), dot(2.75, 12.5)],
  undo: ['M5.5 9.5 2.5 6.5l3-3', 'M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7.5'],
  redo: ['M10.5 9.5l3-3-3-3', 'M13.5 6.5h-7a3.5 3.5 0 0 0 0 7h2'],
  alignLeft: ['M2.5 3.5h11', 'M2.5 6.5h7', 'M2.5 9.5h11', 'M2.5 12.5h7'],
  alignCenter: ['M2.5 3.5h11', 'M4.5 6.5h7', 'M2.5 9.5h11', 'M4.5 12.5h7'],
  alignRight: ['M2.5 3.5h11', 'M6.5 6.5h7', 'M2.5 9.5h11', 'M6.5 12.5h7'],
  alignJustify: ['M2.5 3.5h11', 'M2.5 6.5h11', 'M2.5 9.5h11', 'M2.5 12.5h11'],
  outdent: ['M7 4h6.5', 'M7 8h6.5', 'M7 12h6.5', 'M4.5 6 2.5 8l2 2'],
  indent: ['M7 4h6.5', 'M7 8h6.5', 'M7 12h6.5', 'M2.5 6l2 2-2 2'],
  // 表格工具（光标在表格里时，工具栏下面那一行）
  rowAbove: ['M2.5 8.5h11v5h-11z', 'M2.5 11h11', 'M8 2.25v4', 'M6 4.25h4'],
  rowBelow: ['M2.5 2.5h11v5h-11z', 'M2.5 5h11', 'M8 9.75v4', 'M6 11.75h4'],
  colLeft: ['M8.5 2.5h5v11h-5z', 'M11 2.5v11', 'M2.25 8h4', 'M4.25 6v4'],
  colRight: ['M2.5 2.5h5v11h-5z', 'M5 2.5v11', 'M9.75 8h4', 'M11.75 6v4'],
  rowDelete: ['M2.5 5.5h11v5h-11z', 'M6.6 6.9l2.8 2.2', 'M9.4 6.9l-2.8 2.2'],
  colDelete: ['M5.5 2.5h5v11h-5z', 'M6.9 6.6l2.2 2.8', 'M9.1 6.6l-2.2 2.8'],
  tableDelete: ['M2.5 3.5h11v9h-11z', 'M2.5 7h11', 'M7 3.5v9', 'M3.5 3l9 10'],
  // 格式刷（刷子头 + 弯杆 + 握柄，和 Google 文档的「格式绘制」一样是滚刷）、清除格式（T 加一个叉）
  painter: ['M3.5 2.5h7.5a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1z', 'M12 4.5h1.5V8H8v2', 'M7 10h2v3.5H7z'],
  clearFormat: ['M2.5 3h8', 'M6.5 3v10', 'M10 10l3.5 3.5', 'M13.5 10 10 13.5'],
  more: iconPaths.more,
  caret: iconPaths.chevron,
  // 代码面工具栏：换行 / 全选 / 聚焦是纯文字按钮，和旁边的 SVG 图标不一致，补三颗线性图标
  wrap: ['M3 3.5h10', 'M3 8h7.5a2 2 0 0 1 0 4H8', 'M9.5 10.5 8 12l1.5 1.5', 'M3 13h3.5'],
  selectAll: ['M3 5V3h2', 'M11 3h2v2', 'M13 11v2h-2', 'M5 13H3v-2', 'M5.5 5.5h5v5h-5z'],
  focus: ['M2.5 6V2.5H6', 'M10 2.5h3.5V6', 'M13.5 10v3.5H10', 'M6 13.5H2.5V10', dot(8, 8)],
  download: iconPaths.download,
  edit: iconPaths.edit,
  // 块手柄的拖动把手：两列三行的点（⠿ 字符在不同字体里粗细、位置都不一样）
  grip: [dot(6, 4), dot(10, 4), dot(6, 8), dot(10, 8), dot(6, 12), dot(10, 12)],
  // 块菜单：复制一份 / 上移 / 下移 / 删除 / 当前类型打勾
  copy: iconPaths.copy,
  moveUp: ['M8 13V3', 'M4 7l4-4 4 4'],
  moveDown: ['M8 3v10', 'M4 9l4 4 4-4'],
  trash: iconPaths.trash,
  check: iconPaths.check,
  // AI 写作（插入下拉、斜杠菜单、AI 写作条）与关闭
  sparkles: iconPaths.sparkles,
  close: iconPaths.close,
} satisfies Record<string, ToolIconPaths>

export type ToolIconName = keyof typeof ICONS

/**
 * 动作 id → 图标。笔记文本面、视图扩展、Word 编辑面里同义的动作共用一个图标（加粗就是加粗），
 * 提示块的 `callout.<类型>` 按前缀匹配。
 */
const BY_ACTION: Readonly<Record<string, ToolIconName>> = {
  heading: 'heading',
  paragraph: 'paragraph',
  quote: 'quote',
  painter: 'painter',
  clearFormat: 'clearFormat',
  bold: 'bold',
  italic: 'italic',
  strike: 'strike',
  code: 'code',
  color: 'color',
  font: 'font',
  bullet: 'bullet',
  ordered: 'ordered',
  task: 'task',
  link: 'link',
  image: 'image',
  'image.upload': 'image',
  table: 'table',
  insertMore: 'plus',
  'ai.write': 'sparkles',
  'ai.continue': 'sparkles',
  codeblock: 'codeblock',
  diagram: 'diagram',
  math: 'math',
  mathInline: 'math',
  wikilink: 'wikilink',
  filelink: 'file',
  attachment: 'attachment',
  hr: 'hr',
  find: 'find',
  wrap: 'wrap',
  selectAll: 'selectAll',
  focus: 'focus',
  source: 'source',
  outline: 'outline',
  'docx.bold': 'bold',
  'docx.italic': 'italic',
  'docx.underline': 'underline',
  'docx.strike': 'strike',
  'docx.textColor': 'color',
  'docx.highlight': 'highlight',
  'docx.lineSpacing': 'lineSpacing',
  'docx.fontFamily': 'font',
  'docx.fontSize': 'font',
  'docx.style': 'heading',
  'docx.clearFormat': 'clearFormat',
  'docx.list.bullet': 'bullet',
  'docx.list.numbered': 'ordered',
  'docx.outdent': 'outdent',
  'docx.indent': 'indent',
  'docx.align.left': 'alignLeft',
  'docx.align.center': 'alignCenter',
  'docx.align.right': 'alignRight',
  'docx.align.both': 'alignJustify',
  'docx.table.insert': 'table',
  'docx.table.rowAbove': 'rowAbove',
  'docx.table.rowBelow': 'rowBelow',
  'docx.table.colLeft': 'colLeft',
  'docx.table.colRight': 'colRight',
  'docx.table.deleteRow': 'rowDelete',
  'docx.table.deleteColumn': 'colDelete',
  'docx.table.delete': 'tableDelete',
  'docx.image': 'image',
  'docx.image.wrap': 'image',
  'docx.pageBreak': 'pageBreak',
  'docx.export': 'download',
  'docx.trackChanges': 'edit',
}

/** 按动作 id 取图标路径；没有对应图标返回 null，调用方退回动作自带的字符图标 */
export function toolIcon(actionId: string): ToolIconPaths | null {
  const name = BY_ACTION[actionId] ?? (actionId.startsWith('callout.') ? 'callout' : undefined)
  return name ? ICONS[name] : null
}

/** 直接按图标名取（撤销 / 重做 / 更多 / 下拉箭头这些不是动作的按钮） */
export function namedToolIcon(name: ToolIconName): ToolIconPaths {
  return ICONS[name]
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 手工建的 DOM（块手柄、斜杠菜单在内容面里直接建元素，不是 Vue 组件）画同一套线性图标，
 * 属性与 ToolIcon.vue 一致：颜色跟随 currentColor，读屏跳过。
 */
export function toolIconElement(doc: Document, paths: ToolIconPaths, size = 16): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'kb-tool-icon')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  for (const d of paths) {
    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}
