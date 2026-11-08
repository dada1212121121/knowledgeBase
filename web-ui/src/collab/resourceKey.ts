// 协作房间的资源键:和后端 `ResourceKey` 的 Display 一致(crates/kb-core/src/share.rs)。
//   笔记  doc:<知识库>/<集合>/i/<笔记 id>
//   文件  doc:<知识库>/<集合>/f/<路径,按 / 分段编码>
// 编码规则:除字母数字和 . _ ~ - 以外的每个字节都写成 %XX(大写)——不能用 encodeURIComponent,
// 它会放过 ! '  *,而服务端对每个键只认唯一一种写法。

const encoder = new TextEncoder()

export function encodeSegment(segment: string): string {
  let out = ''
  for (const byte of encoder.encode(segment)) {
    const ch = String.fromCharCode(byte)
    out += /[A-Za-z0-9._~-]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

export type DocRefInput = { insight: string } | { file: string }

export function docKey(spaceId: string, collection: string, doc: DocRefInput): string {
  const head = `doc:${spaceId}/${encodeSegment(collection)}`
  if ('insight' in doc) return `${head}/i/${encodeSegment(doc.insight)}`
  return `${head}/f/${doc.file.split('/').map(encodeSegment).join('/')}`
}

/** Markdown 文件的扩展名:和后端 `DocKind::for_file`(crates/kb-collab/src/types.rs)、页面判断「用富文本页编辑」的列表一致。 */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown', 'mdx'] as const

export function isMarkdownPath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return (MARKDOWN_EXTENSIONS as readonly string[]).includes(path.slice(dot + 1).toLowerCase())
}

/**
 * 协作房间的结构:笔记和 Markdown 文件是富文本(页面用所见即所得编辑),其它文件是纯文本(CodeMirror)。
 * 必须和服务端的判断一致,否则编辑器绑的 Yjs 类型和房间里的对不上。
 */
export function collabKindOf(doc: DocRefInput): 'rich' | 'text' {
  if ('insight' in doc) return 'rich'
  return isMarkdownPath(doc.file) ? 'rich' : 'text'
}
