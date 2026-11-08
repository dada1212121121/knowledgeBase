/**
 * 代码块语法高亮的「引擎」：CodeMirror 语言描述 + Lezer 解析与上色
 *
 * 这个模块会把 `@codemirror/language`、`@codemirror/view`、`@lezer/*` 和整张语言表带进来（约 100 KB gzip），
 * 而大多数笔记根本没有带语言的代码块。所以文本面**不静态 import 它**：`codeHighlight.ts` 只在文档里真的出现
 * 带语言的代码块时才 `import` 这个文件（构建期门禁 `editor-native --surface=text` 会数笔记编辑增量，
 * 超过 150 KB gzip 就失败，见）。
 *
 * 刻意保持「零共享」：这里不 import 文本面的任何模块（包括 ProseMirror 的运行时），输入输出都是普通数据——
 * 否则 Rollup 会把共享的小模块放进文本面 chunk 再让引擎反向引用它，文本面 chunk 就丢了入口身份，
 * 体积门禁按 manifest 里 `surfaces/text/index.ts` 找不到它（见 e2e/editor-native.mjs 的 textEditIncrement）。
 *
 * 语言包本身再按语言各拆一个 chunk（和 CodeEditor 同一份 `@codemirror/language-data`）：没出现过的语言不下载。
 * 超过 HIGHLIGHT_MAX_CHARS 字符的块不高亮（和 staticHighlight 同一个上限，避免卡输入）。
 */
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { classHighlighter, highlightTree } from '@lezer/highlight'
import type { Parser } from '@lezer/common'
import { languageFor } from '@/utils/editorLanguage'

export const HIGHLIGHT_MAX_CHARS = 200_000

/** 一个需要上色的代码块：`pos` 是块在文档里的起始位置，`name` 是围栏上的语言名（外壳已经排除了流程图 / 公式 / 纯文本） */
export interface HighlightBlock {
  pos: number
  code: string
  name: string
}

/** 一段上色区间（文档里的绝对位置） */
export interface HighlightRange {
  from: number
  to: number
  classes: string
}

/** 语言名或别名（js / ts / py / bash…）→ 语言描述；认不出再当扩展名试一次 */
export function languageForName(name: string): LanguageDescription | null {
  return LanguageDescription.matchLanguageName(languages, name, true) ?? languageFor(`x.${name}`)
}

/** 已加载好的语言解析器（按语言名缓存）；null = 加载失败，不再重试 */
const loaded = new Map<string, Parser | null>()
const loading = new Map<string, Promise<void>>()

/** 确保这门语言的解析器已加载（所有调用方共用同一个 Promise，各自在完成后重绘） */
function ensureLoaded(description: LanguageDescription): Promise<void> {
  if (loaded.has(description.name)) return Promise.resolve()
  let pending = loading.get(description.name)
  if (!pending) {
    pending = description
      .load()
      .then((support) => void loaded.set(description.name, support.language.parser))
      .catch(() => void loaded.set(description.name, null))
      .finally(() => void loading.delete(description.name))
    loading.set(description.name, pending)
  }
  return pending
}

/** 一段代码的高亮区间（相对代码开头）。语言还没加载好 / 加载失败 / 太长时返回空数组（先显示成纯文本） */
function rangesOfCode(code: string, description: LanguageDescription): { from: number; to: number; classes: string }[] {
  if (code.length > HIGHLIGHT_MAX_CHARS) return []
  const parser = loaded.get(description.name)
  if (!parser) return []
  const out: { from: number; to: number; classes: string }[] = []
  highlightTree(parser.parse(code), classHighlighter, (from, to, classes) => out.push({ from, to, classes }))
  return out
}

/** 这些代码块当前能上色的区间（语言包还没加载好的块这次返回空，加载完后外壳再调用一次） */
export function highlightRanges(blocks: readonly HighlightBlock[]): HighlightRange[] {
  const out: HighlightRange[] = []
  for (const { pos, code, name } of blocks) {
    const description = languageForName(name)
    if (!description) continue
    // 代码块里只有一个文本节点（marks: ''），文字从 pos + 1 开始
    for (const range of rangesOfCode(code, description)) out.push({ from: pos + 1 + range.from, to: pos + 1 + range.to, classes: range.classes })
  }
  return out
}

/** 这些块用到、但还没加载的语言：逐个加载，每加载完一个就通知一次（先加载好的先上色） */
export function loadMissingLanguages(names: readonly string[], onLoaded: () => void): void {
  for (const name of new Set(names)) {
    const description = languageForName(name)
    if (!description || loaded.has(description.name)) continue
    void ensureLoaded(description).then(onLoaded)
  }
}

/** 仅供测试：清掉已加载的语言缓存 */
export function resetHighlightCache(): void {
  loaded.clear()
  loading.clear()
}
