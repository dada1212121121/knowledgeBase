// 邮件解析(.eml / .mbox / Outlook .msg):头(RFC 2047 编码词)、multipart 递归、base64 / quoted-printable、
// 任意字符集(TextDecoder)、内嵌图片 cid: → data URL、附件清单。只做展示需要的那部分,不实现完整 MIME。
import { openOle } from './legacyOffice'

export interface MailAttachment {
  name: string
  type: string
  size: number
}

export interface Mail {
  subject: string
  from: string
  to: string
  cc: string
  date: string
  /** 原始 HTML 正文(未清洗,调用方过 sanitizeDocHtml) */
  html: string
  text: string
  attachments: MailAttachment[]
}

const MAX_INLINE_IMAGE = 3 * 1024 * 1024

/** latin1 字符串(一字节一字符)→ 字节 */
const toBytes = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff)

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function decodeQuotedPrintable(value: string): Uint8Array {
  const joined = value.replace(/=\r?\n/g, '')
  const out: number[] = []
  for (let at = 0; at < joined.length; at += 1) {
    const char = joined[at]!
    if (char === '=' && /^[0-9a-fA-F]{2}$/.test(joined.slice(at + 1, at + 3))) {
      out.push(Number.parseInt(joined.slice(at + 1, at + 3), 16))
      at += 2
    } else {
      out.push(char.charCodeAt(0) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

function decodeBase64(value: string): Uint8Array {
  try {
    return toBytes(atob(value.replace(/[^A-Za-z0-9+/=]/g, '')))
  } catch {
    return new Uint8Array()
  }
}

/** RFC 2047:`=?utf-8?B?...?=` / `=?gb2312?Q?...?=`,相邻的编码词之间的空白要吃掉。 */
export function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_all, charset: string, mode: string, data: string) => {
      const bytes = mode.toUpperCase() === 'B' ? decodeBase64(data) : decodeQuotedPrintable(data.replace(/_/g, ' '))
      return decodeCharset(bytes, charset.split('*')[0]!)
    })
}

interface Headers {
  get(name: string): string
}

function parseHeaders(block: string): Headers {
  const map = new Map<string, string>()
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    if (!map.has(name)) map.set(name, line.slice(colon + 1).trim())
  }
  return { get: (name) => map.get(name.toLowerCase()) ?? '' }
}

/** `text/html; charset="utf-8"; boundary=abc` → { value, params } */
function parseParams(header: string): { value: string; params: Record<string, string> } {
  const [first = '', ...rest] = header.split(';')
  const params: Record<string, string> = {}
  for (const part of rest) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    let value = part.slice(eq + 1).trim().replace(/^"|"$/g, '')
    if (key.endsWith('*')) {
      // RFC 2231:filename*=utf-8''%E4%BD%A0
      const match = /^([^']*)'[^']*'(.*)$/.exec(value)
      if (match) {
        try {
          value = decodeCharset(Uint8Array.from(decodeURIComponent(match[2]!), (char) => char.charCodeAt(0)), match[1]!)
        } catch {
          /* 保持原样 */
        }
        params[key.slice(0, -1)] = decodeURIComponentSafe(match[2]!, match[1]!)
        continue
      }
    }
    params[key] = value
  }
  return { value: first.trim().toLowerCase(), params }
}

function decodeURIComponentSafe(value: string, charset: string): string {
  const bytes = value.replace(/%([0-9a-fA-F]{2})/g, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  return decodeCharset(toBytes(bytes), charset)
}

interface Part {
  type: string
  charset: string
  name: string
  disposition: string
  contentId: string
  bytes: Uint8Array
}

function decodeBody(body: string, encoding: string): Uint8Array {
  switch (encoding.toLowerCase()) {
    case 'base64':
      return decodeBase64(body)
    case 'quoted-printable':
      return decodeQuotedPrintable(body)
    default:
      return toBytes(body)
  }
}

function splitMessage(raw: string): [string, string] {
  const match = /\r?\n\r?\n/.exec(raw)
  return match ? [raw.slice(0, match.index), raw.slice(match.index + match[0].length)] : [raw, '']
}

function walk(raw: string, parts: Part[], depth = 0): void {
  const [headerBlock, body] = splitMessage(raw)
  const headers = parseHeaders(headerBlock)
  const type = parseParams(headers.get('content-type') || 'text/plain')
  if (type.value.startsWith('multipart/') && type.params.boundary && depth < 8) {
    const boundary = type.params.boundary
    const chunks = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`))
    for (const chunk of chunks.slice(1)) if (chunk.trim()) walk(chunk.replace(/^\r?\n/, ''), parts, depth + 1)
    return
  }
  const disposition = parseParams(headers.get('content-disposition'))
  const name = decodeWords(disposition.params.filename || type.params.name || '')
  parts.push({
    type: type.value,
    charset: type.params.charset || 'utf-8',
    name,
    disposition: disposition.value,
    contentId: headers.get('content-id').replace(/^<|>$/g, ''),
    bytes: decodeBody(body, headers.get('content-transfer-encoding')),
  })
}

export function parseEml(source: Uint8Array | string): Mail {
  const raw = typeof source === 'string' ? source : Array.from(source, (value) => String.fromCharCode(value)).join('')
  const [headerBlock] = splitMessage(raw)
  const headers = parseHeaders(headerBlock)
  const parts: Part[] = []
  walk(raw, parts)
  let html = ''
  let text = ''
  const images = new Map<string, string>()
  const attachments: MailAttachment[] = []
  for (const part of parts) {
    const attachment = part.disposition === 'attachment' || (part.name && !part.type.startsWith('text/'))
    if (part.type.startsWith('image/') && part.contentId && part.bytes.byteLength <= MAX_INLINE_IMAGE && /^image\/(png|jpe?g|gif|webp|bmp)$/.test(part.type)) {
      let binary = ''
      for (const value of part.bytes) binary += String.fromCharCode(value)
      images.set(part.contentId, `data:${part.type};base64,${btoa(binary)}`)
    }
    if (attachment && !(part.contentId && images.has(part.contentId) && part.disposition !== 'attachment')) {
      attachments.push({ name: part.name || '(未命名附件)', type: part.type, size: part.bytes.byteLength })
    } else if (part.type === 'text/html' && !html) {
      html = decodeCharset(part.bytes, part.charset)
    } else if (part.type === 'text/plain' && !text) {
      text = decodeCharset(part.bytes, part.charset)
    }
  }
  if (html) html = html.replace(/(src=["'])cid:([^"']+)(["'])/gi, (all, open: string, id: string, close: string) => (images.has(id) ? `${open}${images.get(id)}${close}` : all))
  return {
    subject: decodeWords(headers.get('subject')),
    from: decodeWords(headers.get('from')),
    to: decodeWords(headers.get('to')),
    cc: decodeWords(headers.get('cc')),
    date: headers.get('date'),
    html,
    text,
    attachments,
  }
}

/** mbox:以 `From ` 开头的行分隔(行首 `>From ` 是转义,不分)。 */
export function parseMbox(source: Uint8Array | string): Mail[] {
  const raw = typeof source === 'string' ? source : Array.from(source, (value) => String.fromCharCode(value)).join('')
  const messages = raw.split(/^From [^\n]*\n/m).filter((chunk) => chunk.trim())
  return messages.map((chunk) => parseEml(chunk.replace(/^>From /gm, 'From ')))
}

/** Outlook .msg(OLE):主题 / 发件人 / 正文取固定属性流。找不到的字段留空。 */
export function parseMsg(bytes: Uint8Array): Mail {
  const ole = openOle(bytes)
  const read = (tag: string): string => {
    const wide = ole.stream(`__substg1.0_${tag}001F`)
    if (wide) return new TextDecoder('utf-16le').decode(wide).replace(/\0+$/, '')
    const narrow = ole.stream(`__substg1.0_${tag}001E`)
    return narrow ? new TextDecoder('windows-1252').decode(narrow).replace(/\0+$/, '') : ''
  }
  const htmlBytes = ole.stream('__substg1.0_10130102')
  const attachments: MailAttachment[] = ole.names
    .filter((name) => name.startsWith('__attach_version1.0_'))
    .map((name) => ({ name, type: '', size: 0 }))
  return {
    subject: read('0037'),
    from: read('0C1A') || read('0042'),
    to: read('0E04'),
    cc: read('0E03'),
    date: '',
    html: htmlBytes ? new TextDecoder('utf-8').decode(htmlBytes) : '',
    text: read('1000'),
    attachments,
  }
}
