// 不起编辑器实例的语法高亮:把代码变成带 tok-* 类名的 HTML(笔记本代码单元格、压缩包里的文本预览用)。
// 颜色在 CodeEditor 之外由 `.kb-tok` 样式给(取 --code-* 变量)。超过 200 KB 或认不出语言就只转义。
import { classHighlighter, highlightTree } from '@lezer/highlight'
import { languageFor } from './editorLanguage'

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const MAX = 200_000

export async function highlightToHtml(code: string, filename: string): Promise<string> {
  if (code.length > MAX) return escapeHtml(code)
  const description = languageFor(filename)
  if (!description) return escapeHtml(code)
  let tree
  try {
    const support = await description.load()
    tree = support.language.parser.parse(code)
  } catch {
    return escapeHtml(code)
  }
  let out = ''
  let at = 0
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (from > at) out += escapeHtml(code.slice(at, from))
    out += `<span class="${classes}">${escapeHtml(code.slice(from, to))}</span>`
    at = to
  })
  return out + escapeHtml(code.slice(at))
}
