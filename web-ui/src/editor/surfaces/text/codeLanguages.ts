/**
 * 代码块语言候选（笔记编辑器的语言选择菜单）
 *
 * 只收「写进围栏就能上色」的名字：每一项都用 `@codemirror/language-data` 的 `LanguageDescription.matchLanguageName`
 * 验证过能匹配到语言包（高亮引擎 codeHighlightEngine 用的是同一张表）；加新项前先验一下，别列出一个选了却不上色的名字。
 * 另外三项有特殊处理：mermaid（流程图预览）、latex（公式预览）、text（纯文本，不上色）。
 * 这个文件很小、静态加载；语言包本身仍是按需加载的，不会因为列表变长多下载什么。
 */

export interface CodeLanguage {
  /** 写进围栏的名字（```bash） */
  id: string
  /** 菜单里右侧的小字说明（可选） */
  hint?: string
}

export const CODE_LANGUAGE_LIST: readonly CodeLanguage[] = [
  { id: 'text', hint: '纯文本' },
  { id: 'mermaid', hint: '流程图' },
  { id: 'latex', hint: '公式' },
  { id: 'bash' },
  { id: 'c' },
  { id: 'clojure' },
  { id: 'cmake' },
  { id: 'cobol' },
  { id: 'coffeescript' },
  { id: 'cpp', hint: 'C++' },
  { id: 'crystal' },
  { id: 'csharp', hint: 'C#' },
  { id: 'css' },
  { id: 'cypher' },
  { id: 'd' },
  { id: 'dart' },
  { id: 'diff' },
  { id: 'dockerfile' },
  { id: 'elm' },
  { id: 'erlang' },
  { id: 'fortran' },
  { id: 'fsharp', hint: 'F#' },
  { id: 'go' },
  { id: 'groovy' },
  { id: 'haskell' },
  { id: 'html' },
  { id: 'http' },
  { id: 'ini' },
  { id: 'java' },
  { id: 'javascript' },
  { id: 'json' },
  { id: 'jsonc', hint: '带注释的 JSON' },
  { id: 'jsx' },
  { id: 'julia' },
  { id: 'kotlin' },
  { id: 'less' },
  { id: 'lisp' },
  { id: 'lua' },
  { id: 'markdown' },
  { id: 'mysql' },
  { id: 'nginx' },
  { id: 'objective-c' },
  { id: 'ocaml' },
  { id: 'octave', hint: 'MATLAB' },
  { id: 'pascal' },
  { id: 'perl' },
  { id: 'php' },
  { id: 'postgresql' },
  { id: 'powershell' },
  { id: 'properties' },
  { id: 'protobuf' },
  { id: 'python' },
  { id: 'r' },
  { id: 'ruby' },
  { id: 'rust' },
  { id: 'sass' },
  { id: 'scala' },
  { id: 'scheme' },
  { id: 'scss' },
  { id: 'sh', hint: 'shell' },
  { id: 'smalltalk' },
  { id: 'sparql' },
  { id: 'sql' },
  { id: 'sqlite' },
  { id: 'stylus' },
  { id: 'swift' },
  { id: 'tcl' },
  { id: 'toml' },
  { id: 'tsx' },
  { id: 'typescript' },
  { id: 'verilog' },
  { id: 'vhdl' },
  { id: 'vue' },
  { id: 'xml' },
  { id: 'yaml' },
  { id: 'zsh' },
]

/**
 * 按输入过滤候选：
 * - 输入为空、或正好是某一项（选中了再点开）：列出全部，让人能换别的；
 * - 否则按名字 / 说明包含输入过滤，名字以输入开头的排前面。
 */
export function filterCodeLanguages(query: string): CodeLanguage[] {
  const q = query.trim().toLowerCase()
  if (!q || CODE_LANGUAGE_LIST.some((item) => item.id.toLowerCase() === q)) return [...CODE_LANGUAGE_LIST]
  const hits = CODE_LANGUAGE_LIST.filter((item) => item.id.toLowerCase().includes(q) || (item.hint ?? '').toLowerCase().includes(q))
  return hits.sort((a, b) => Number(b.id.toLowerCase().startsWith(q)) - Number(a.id.toLowerCase().startsWith(q)))
}
