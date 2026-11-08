/**
 * 代码 / 配置文本编解码
 *
 * 这里的「源码」和 Markdown 不一样：没有语法树要重建，唯一的目标是保存时不动用户没改过的字节。
 *  - 打开：BOM、CRLF、末尾换行由 `parseText` 抽出来，编辑器里统一用 LF 显示；
 *  - 保存：内容没改就原样回写；改过才按原文件的 BOM / 行尾 / 末尾换行重新编码。
 * 这样一次「打开 → 保存」不会把整个文件的 diff 变成行尾噪音，也不会给没有末尾换行的文件凭空补一行。
 */
import type { EditorSource, SurfaceDocument } from '../types'
import { parseText, serializeText, type ParsedText } from './text'

/** 代码面解码结果：payload 保持为普通对象，Surface 直接持有，不进 Vue 响应式 */
export interface CodeDocument {
  /** 去掉 BOM、行尾归一化成 `\n` 的显示文本 */
  text: string
  name: string
  /** 原始文本（含 BOM / CRLF），未改动时逐字节回写 */
  original: string
  parsed: ParsedText
  /** 原件地址（只读预览时可能有；保存不依赖它） */
  url?: string
}

/** 代码 / 配置扩展名：与 `FORMAT_TO_SURFACE` 的 code 段保持一致 */
export const CODE_FORMATS: readonly string[] = [
  'json', 'jsonc', 'json5', 'jsonl', 'ndjson',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties', 'xml', 'xsd', 'xsl', 'plist',
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
  'rs', 'py', 'pyi', 'go', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'vb', 'rb', 'php', 'swift', 'm', 'mm',
  'lua', 'r', 'pl', 'pm', 'dart', 'ex', 'exs', 'erl', 'hs', 'clj', 'ml', 'jl', 'nim', 'zig', 'v', 'sol',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'graphql', 'gql', 'proto', 'thrift',
  'tf', 'hcl', 'cmake', 'mk', 'dockerfile', 'lock', 'gitignore', 'editorconfig', 'txt', 'text', 'log',
]

/** 从任意文本源解码；二进制源按 UTF-8 解，解不出来时用替换字符而不是抛错（查看器仍需可读） */
export function openCode(source: EditorSource): CodeDocument {
  const original = source.kind === 'text' ? source.text : new TextDecoder().decode(source.bytes)
  const parsed = parseText(original)
  return { text: parsed.text, name: source.name, original, parsed, url: source.url }
}

/**
 * 保存：未改动返回原文（含 BOM / CRLF）；改动后按原文件约定重新编码。
 * `name` 由调用方传入，避免改名时沿用旧文件名。
 */
export function saveCode(doc: CodeDocument, text: string, name = doc.name): EditorSource {
  const value = text.replace(/\r\n/g, '\n')
  return {
    kind: 'text',
    text: value === doc.text ? doc.original : serializeText(doc.parsed, value),
    name,
    encoding: 'utf-8',
  }
}

/** Codec 形状的薄封装：其它 Surface 要走统一 codec 注册表时可直接复用 */
export const codeCodec = {
  id: 'code',
  formats: CODE_FORMATS,
  kind: 'code' as const,
  open: async (source: EditorSource): Promise<SurfaceDocument> => ({
    kind: 'code',
    format: source.name.split('.').pop()?.toLowerCase() ?? 'txt',
    revision: 0,
    payload: openCode(source),
  }),
  save: async (doc: SurfaceDocument, source: EditorSource): Promise<EditorSource> => {
    const payload = doc.payload as CodeDocument
    // 与 openCode 保持同一解码口径；只处理文本的 codec 也不能把 bytes 静默存成空文件
    const text = source.kind === 'text' ? source.text : new TextDecoder().decode(source.bytes)
    return saveCode(payload, text, source.name)
  },
}
