// 文件格式 → 查看器路由。唯一的真相来源:FileViewer 用它选组件,Browser 用它决定「编辑」「渲染预览」等入口。
// 认不出的扩展名不会落到「没有可预览内容」,而是走 `sniff`(按内容判断是文本、容器还是二进制),所以任何文件都有出路。
import { IMAGE_FORMATS, MEDIA_FORMATS, SHEET_FORMATS } from './files'

export type ViewKind =
  | 'pdf' | 'docx' | 'pptx' | 'sheet' | 'legacy-doc' | 'legacy-ppt' | 'odt' | 'odp' | 'rtf' | 'epub'
  | 'mail' | 'notebook' | 'html' | 'archive' | 'markdown' | 'code' | 'image' | 'media' | 'sniff' | 'binary'
  // 扩展注册了 Codec / 内容面的格式（FileViewer 问过扩展注册表后才会用到；viewKindOf 永远不会返回它）
  | 'extension'

const ARCHIVE = new Set(['zip', 'jar', 'war', 'apk', 'aar', 'tar', 'tgz', 'gz', '7z', 'rar', 'bz2', 'xz', 'zst', 'pages', 'key', 'epubx', 'whl', 'vsix', 'crx', 'xpi'])
const MAIL = new Set(['eml', 'mbox', 'msg', 'emlx'])
const HTML = new Set(['html', 'htm', 'xhtml', 'mht'])
const MARKDOWN = new Set(['md', 'markdown', 'mdown', 'mdx'])

/** 已知是纯文本 / 源码的扩展名:直接用代码视图,不必先嗅探 */
export const TEXT_FORMATS = new Set([
  'txt', 'text', 'log', 'rst', 'adoc', 'asciidoc', 'org', 'tex', 'bib', 'nfo', 'diff', 'patch',
  'json', 'jsonl', 'ndjson', 'json5', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties', 'xml', 'xsd', 'xsl', 'plist',
  'rs', 'py', 'pyi', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'go', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh',
  'cs', 'fs', 'vb', 'rb', 'php', 'swift', 'm', 'mm', 'lua', 'r', 'pl', 'pm', 'dart', 'ex', 'exs', 'erl', 'hs', 'clj', 'ml', 'jl', 'nim', 'zig', 'v', 'sol',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'graphql', 'gql', 'proto', 'thrift', 'tf', 'hcl', 'cmake', 'mk', 'dockerfile',
  'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro', 'lock', 'gitignore', 'editorconfig', 'csv', 'tsv',
])

function extensionOf(format: string): string {
  const value = format.toLowerCase().trim()
  return value.includes('.') ? (value.split('.').pop() ?? '') : value
}

/** 页面自己认得的扩展名对应的查看器；认不出（内置没有这个格式）返回 null，不含后面的内容嗅探兜底 */
function explicitKindOf(ext: string): ViewKind | null {
  if (ext === 'pdf') return 'pdf'
  if (['docx', 'docm', 'dotx', 'dotm'].includes(ext)) return 'docx'
  if (['pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm'].includes(ext)) return 'pptx'
  if (SHEET_FORMATS.has(ext)) return 'sheet'
  if (ext === 'doc' || ext === 'dot') return 'legacy-doc'
  if (ext === 'ppt' || ext === 'pps' || ext === 'pot') return 'legacy-ppt'
  if (ext === 'odt' || ext === 'ott') return 'odt'
  if (ext === 'odp' || ext === 'otp') return 'odp'
  if (ext === 'rtf') return 'rtf'
  if (ext === 'epub') return 'epub'
  if (MAIL.has(ext)) return 'mail'
  if (ext === 'ipynb') return 'notebook'
  if (HTML.has(ext)) return 'html'
  if (ARCHIVE.has(ext)) return 'archive'
  if (IMAGE_FORMATS.has(ext)) return 'image'
  if (MEDIA_FORMATS.has(ext)) return 'media'
  if (MARKDOWN.has(ext)) return 'markdown'
  if (TEXT_FORMATS.has(ext)) return 'code'
  return null
}

/**
 * 页面是不是自己认得这个格式（有专门的查看器 / 已知的文本类扩展名）。
 * 认得的格式永远优先，编辑器扩展不能接管它们；只有不认得的扩展名，页面才去问扩展注册表有没有 Codec / 内容面
 * （见 composables/useExtensionFormat）。和 viewKindOf 共用同一张表，免得两处各记一份对不上。
 */
export function isBuiltinViewFormat(format: string): boolean {
  return explicitKindOf(extensionOf(format)) !== null
}

/**
 * @param format 扩展名(`file_preview.format`)
 * @param hasContent 后端已经给了文本原文(≤512 KB 的 UTF-8 文本)
 * @param hasSource 有原件地址(能自己读字节)
 */
export function viewKindOf(format: string, hasContent: boolean, hasSource: boolean): ViewKind {
  const explicit = explicitKindOf(extensionOf(format))
  if (explicit) return explicit
  if (hasContent) return 'code'
  return hasSource ? 'sniff' : 'code'
}
