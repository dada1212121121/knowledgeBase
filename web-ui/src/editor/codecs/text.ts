/**
 * 纯文本（TXT）编解码
 *
 * 纯文本没有语法，编解码的全部价值在于「别动用户的字节」：
 * 1. 行尾风格（CRLF / LF）、BOM、末尾是否有换行，都必须原样保留，
 *    否则一次「打开 + 保存」就会把整个文件的行尾改掉，git diff 全是噪音。
 * 2. 改动后再序列化，只修正用户真正编辑过的文本部分，风格仍沿用原文件的约定。
 */

/** 解码结果：保留还原原始字节所需的全部元信息 */
export interface ParsedText {
  /** 去掉 BOM、行尾归一化成 `\n` 后的正文 */
  text: string
  /** 源文件行尾风格 */
  eol: '\n' | '\r\n'
  /** 源文件是否带 UTF-8 BOM */
  bom: boolean
  /** 源文件末尾是否有换行 */
  trailingNewline: boolean
}

const BOM = '\uFEFF'

/** 拆出 BOM / 行尾 / 末尾换行信息 */
export function parseText(source: string): ParsedText {
  const bom = source.startsWith(BOM)
  const body = bom ? source.slice(BOM.length) : source
  // 只有出现过 CRLF 才按 CRLF 还原；混用时以第一个换行为准（与旧编辑器一致）
  const firstBreak = body.indexOf('\n')
  const eol: '\n' | '\r\n' = firstBreak > 0 && body[firstBreak - 1] === '\r' ? '\r\n' : '\n'
  return {
    text: body.replace(/\r\n/g, '\n'),
    eol,
    bom,
    trailingNewline: body.endsWith('\n'),
  }
}

/** 按解码时的元信息还原字节（未改动时逐字节相同） */
export function serializeText(parsed: ParsedText, text: string): string {
  let body = text.replace(/\r\n/g, '\n')
  // 末尾换行按原文件习惯补/去：多数编辑器会强行补换行，那会让纯文本文件的 diff 凭空多一行
  const hasTrailing = body.endsWith('\n')
  if (parsed.trailingNewline && !hasTrailing) body += '\n'
  if (!parsed.trailingNewline && hasTrailing) body = body.replace(/\n+$/, '')
  if (parsed.eol === '\r\n') body = body.replace(/\n/g, '\r\n')
  return parsed.bom ? `${BOM}${body}` : body
}
