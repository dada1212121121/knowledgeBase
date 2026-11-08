// 编辑器 / 只读代码视图的语言识别:按文件名挑 CodeMirror 语言包(按需异步加载,每种语言一个 chunk)。
import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

/** 语言包里没有、但我们常见的扩展名 → 借用相近语言。 */
const ALIASES: Record<string, string> = {
  mdx: 'md',
  markdown: 'md',
  rst: 'md',
  jsonl: 'json',
  ndjson: 'json',
  env: 'sh',
  conf: 'ini',
  cfg: 'ini',
  vue: 'vue',
}

function extensionOf(filename: string): string {
  const name = filename.split('/').pop() ?? filename
  const at = name.lastIndexOf('.')
  return at > 0 ? name.slice(at + 1).toLowerCase() : ''
}

/** 按文件名找语言描述;认不出来就是纯文本(null)。 */
export function languageFor(filename: string): LanguageDescription | null {
  if (!filename) return null
  const name = filename.split('/').pop() ?? filename
  const direct = LanguageDescription.matchFilename(languages, name)
  if (direct) return direct
  const alias = ALIASES[extensionOf(name)]
  return alias ? LanguageDescription.matchFilename(languages, `x.${alias}`) : null
}

/** 状态栏上显示的语言名;认不出来就叫「纯文本」。 */
export function languageLabel(filename: string): string {
  return languageFor(filename)?.name ?? '纯文本'
}

export function isMarkdownName(filename: string): boolean {
  return ['md', 'markdown', 'mdx'].includes(extensionOf(filename))
}

/** 加载语言包;失败(chunk 拉不到)就退回纯文本,不让编辑器整个起不来。 */
export async function loadLanguage(filename: string): Promise<LanguageSupport | null> {
  const description = languageFor(filename)
  if (!description) return null
  try {
    return await description.load()
  } catch {
    return null
  }
}
