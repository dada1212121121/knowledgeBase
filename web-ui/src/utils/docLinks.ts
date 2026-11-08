// 从 Markdown 正文里找链接。单独成文件:解析器(markdown-it)只在「体检链接」时用到,
// 不跟着 `links.ts` 的路径解析一起进入附件 / 图片地址的公共包。
import MarkdownIt from 'markdown-it'
import { isNoteLinkId } from './links'

export interface DocLink {
  href: string
  line: number
  /** 图片的 alt 文本;普通链接为空。 */
  label?: string
  /** 双链 `[[path]]`:路径按 collection 根解析,而不是当前文件所在目录。 */
  fromRoot?: boolean
}

/** 与编辑器 `WIKILINK` 保持同一形状;这里不引 ProseMirror,避免体检把编辑器依赖带进公共包。 */
const WIKILINK = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?]]/g

const md = new MarkdownIt({ html: false, linkify: false })

/** 从 Markdown 里取出所有链接和图片(同一 href 只留第一次出现的位置)。 */
export function extractDocLinks(markdown: string): DocLink[] {
  if (!markdown) return []
  const links: DocLink[] = []
  const seen = new Set<string>()
  const push = (href: string | null, line: number, label?: string, fromRoot = false) => {
    const value = href?.trim()
    if (!value) return
    const key = `${fromRoot ? 'root' : 'rel'}:${value}`
    if (seen.has(key)) return
    seen.add(key)
    links.push({ href: value, line, label, fromRoot })
  }
  for (const token of md.parse(markdown, {})) {
    if (token.type !== 'inline' || !token.children) continue
    const line = (token.map?.[0] ?? 0) + 1
    for (const child of token.children) {
      if (child.type === 'link_open') push(child.attrGet('href'), line)
      else if (child.type === 'image') push(child.attrGet('src'), line, child.content || child.attrGet('alt') || '')
      else if (child.type === 'text') {
        // 双链在 markdown-it 里只是普通文本;代码块 / 行内代码不会走到 text token 之外,
        // 这里再扫一遍,让 [[...]] 也能参与体检(反向链接同样按这个规则)。
        for (const match of child.content.matchAll(WIKILINK)) {
          const id = (match[1] ?? '').trim()
          if (!id) continue
          const alias = (match[2] ?? '').trim()
          if (isNoteLinkId(id)) push(`kb://note/${encodeURIComponent(id)}`, line, alias || id)
          else push(id, line, alias || id, true)
        }
      }
    }
  }
  return links
}
