/**
 * 粘贴与拖放
 *
 * 三条通道，各走各的：
 * 1. HTML：先按白名单清洗（去 script/style/iframe/事件属性），再交给 schema 的 DOMParser。
 *    直接用 DOMParser.fromSchema 会把 `<div onclick>` 里的脚本属性带进来，也会把
 *    从网页复制的整站样式一起塞进文档，所以必须先洗。
 * 2. Markdown：纯文本且「看起来是 Markdown」时按 codec 解析成节点，保留结构；
 *    普通纯文本走 ProseMirror 默认行为（按空行分段）。
 * 3. 图片：走上传回调拿 URL；没有回调就当没发生（绝不用 base64 塞进笔记，否则文件瞬间膨胀）。
 */
import type { Node as PMNode, Schema, Slice } from 'prosemirror-model'
import { DOMParser as PMDOMParser, Fragment, Slice as PMSlice } from 'prosemirror-model'
import { parseMarkdown } from '../../codecs/markdown'

/** 不应进入文档的标签 */
const BLOCKED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'LINK',
  'META',
  'BASE',
  'FORM',
  'INPUT',
  'BUTTON',
  'TEXTAREA',
  'SELECT',
])

/** 保留的属性白名单（其余属性一律删） */
const KEPT_ATTRS: Record<string, string[]> = {
  A: ['href', 'title'],
  IMG: ['src', 'alt', 'title'],
  TD: [],
  TH: [],
  CODE: [],
  PRE: [],
}

/** 清洗 HTML：删危险标签、删全部事件属性与 style，只留白名单属性 */
export function sanitizePastedHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return ''
  const doc = new DOMParser().parseFromString(`<div id="kb-paste-root">${html}</div>`, 'text/html')
  const root = doc.getElementById('kb-paste-root')
  if (!root) return ''
  const walk = (node: Node) => {
    const children = [...node.childNodes]
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement
        if (BLOCKED_TAGS.has(el.tagName)) {
          el.remove()
          continue
        }
        const kept = KEPT_ATTRS[el.tagName] ?? []
        for (const attr of [...el.attributes]) {
          // `target` / `rel` 之外一律删；事件属性（on*）即使不在白名单也删
          if (!kept.includes(attr.name)) el.removeAttribute(attr.name)
        }
        // javascript: / data: 链接直接去链接，保留文字
        if (el.tagName === 'A') {
          const href = el.getAttribute('href') ?? ''
          if (/^\s*(javascript|data|vbscript):/i.test(href)) el.removeAttribute('href')
        }
        if (el.tagName === 'IMG') {
          const src = el.getAttribute('src') ?? ''
          // data: 图片体积不可控，粘贴时直接丢弃（用户应改用上传）
          if (!src || /^data:/i.test(src)) el.remove()
        }
        walk(el)
      } else if (child.nodeType === Node.COMMENT_NODE) {
        child.remove()
      }
    }
  }
  walk(root)
  return root.innerHTML
}

/** 粗略判断纯文本是否像 Markdown：至少命中两个强特征才按 Markdown 解析 */
export function looksLikeMarkdown(text: string): boolean {
  if (text.length < 3) return false
  const signals = [
    /^#{1,6}\s/m, // 标题
    /^```/m, // 围栏代码块
    /^\s*[-*+]\s+\S/m, // 无序列表
    /^\s*\d+\.\s+\S/m, // 有序列表
    /^\s*>\s+\S/m, // 引用
    /^\|.*\|.*\n\s*\|[-: |]+\|/m, // 表格
    /\*\*[^*\n]+\*\*/, // 加粗
    /\[[^\]\n]+\]\([^)\s]+\)/, // 链接
    /^\s*---\s*$/m, // 分割线
  ]
  return signals.reduce((hits, pattern) => hits + (pattern.test(text) ? 1 : 0), 0) >= 2
}

/** 把 Markdown 文本转成可插入的 Slice（用空文档容器裁掉包裹层级） */
export function markdownSlice(schema: Schema, text: string): Slice | null {
  // 纯空白不按 Markdown 解析：插一个空段落没有意义，交给默认行为更贴近用户预期
  if (!text.trim()) return null
  const parsed = parseMarkdown(text)
  const nodes: PMNode[] = []
  parsed.doc.forEach((child) => nodes.push(child))
  if (!nodes.length) return null
  const fragment = Fragment.fromArray(nodes)
  return new PMSlice(fragment, 0, 0)
}

/** HTML → Slice；清洗后仍解析不出内容时返回 null，交给默认行为 */
export function htmlSlice(schema: Schema, html: string): Slice | null {
  const clean = sanitizePastedHtml(html)
  if (!clean.trim()) return null
  const container = document.createElement('div')
  container.innerHTML = clean
  const parsed = PMDOMParser.fromSchema(schema).parse(container, { preserveWhitespace: false })
  if (!parsed.childCount) return null
  const nodes: PMNode[] = []
  parsed.forEach((child) => nodes.push(child))
  return new PMSlice(Fragment.fromArray(nodes), 0, 0)
}

/** 上传回调：返回可访问 URL；失败返回 null（调用方决定是否提示） */
export type ImageUploader = (file: File) => Promise<string | null>

/** 插入图片节点；上传失败不插入，避免留下空图 */
export async function insertImageFiles(
  schema: Schema,
  view: { dispatch: (tr: import('prosemirror-state').Transaction) => void; state: import('prosemirror-state').EditorState },
  files: readonly File[],
  upload: ImageUploader | undefined,
): Promise<boolean> {
  if (!upload || !files.length) return false
  let inserted = false
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    const src = await upload(file)
    if (!src) continue
    const node = schema.nodes.image.create({ src, alt: file.name || '', title: '' })
    view.dispatch(view.state.tr.replaceSelectionWith(node))
    inserted = true
  }
  return inserted
}
