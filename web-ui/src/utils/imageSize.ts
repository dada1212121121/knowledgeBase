/**
 * 笔记里图片的显示宽度（拖拽调整后保存的值）
 *
 * 存法：写在图片地址的片段里 —— `![说明](地址#w=320)`。选这个写法的原因：
 * - 它仍是一条合法的标准 Markdown 图片，任何 Markdown 阅读器 / 旧版本打开都能显示图片（只是按原尺寸），不会出现乱码；
 * - 片段不会发给服务器（浏览器不把 # 后面的内容放进请求），图片文件地址不受影响；
 * - 只存宽度，高度由浏览器按原图比例算（height:auto），所以编辑、预览、导出的比例永远一致。
 * 编辑器把它拆成图片节点的 `width` 属性，序列化时再拼回去；阅读渲染（MarkdownRead）同样拆出来写成 `width` 属性；
 * 下载（导出 Markdown）时再换成通用的 `<img width>`，到别的软件里也是同样大小。
 */

/** 能拖到的最小宽度（px）：再小就抓不住手柄了 */
export const MIN_IMAGE_WIDTH = 48
/** 存进文档的宽度上限（px）：防止手抖 / 脏数据写出离谱的值 */
export const MAX_IMAGE_WIDTH = 4096

const WIDTH_FRAGMENT = /#w=(\d{2,4})$/

/** 把地址里的 `#w=宽度` 拆出来；没有（或值不合法）时 width 为 null、地址原样返回 */
export function splitImageWidth(src: string): { src: string; width: number | null } {
  const match = WIDTH_FRAGMENT.exec(src)
  if (!match) return { src, width: null }
  const width = Number(match[1])
  if (width < MIN_IMAGE_WIDTH || width > MAX_IMAGE_WIDTH) return { src, width: null }
  return { src: src.slice(0, match.index), width }
}

/** 把宽度拼回地址（null / 0 表示「自动」，不写片段） */
export function joinImageWidth(src: string, width: number | null | undefined): string {
  if (!width || width < MIN_IMAGE_WIDTH) return src
  return `${src}#w=${Math.min(MAX_IMAGE_WIDTH, Math.round(width))}`
}

/** 拖拽 / 键盘调整出来的宽度，限制到 [最小, 上限] 并取整 */
export function clampImageWidth(width: number, max: number): number {
  const upper = Math.max(MIN_IMAGE_WIDTH, Math.min(MAX_IMAGE_WIDTH, Math.floor(max)))
  return Math.round(Math.min(upper, Math.max(MIN_IMAGE_WIDTH, width)))
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * 下载（导出）用：把带宽度的图片换成通用的 `<img src alt width>`，到 GitHub / Typora / VS Code 等别的软件里大小不变。
 * 没有宽度的图片不动。只认标准写法 `![说明](地址#w=数字 "标题")`，代码块里的示例也会被换，所以只给「下载」用，不改存库的内容
 */
export function exportImageSizes(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\(([^()\s]+#w=\d{2,4})(?:\s+"([^"]*)")?\)/g, (whole, alt: string, target: string, title?: string) => {
    const { src, width } = splitImageWidth(target)
    if (!width) return whole
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : ''
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${titleAttr} width="${width}">`
  })
}
