// 内容嗅探:扩展名认不出来 / 对不上时,按魔数和文本特征决定用哪个查看器。纯函数,单测见 sniff.spec.ts。
//
// 返回的 kind 与 FileViewer 的路由名一致;zip 和 OLE 容器只能先说「是容器」,
// 具体是 docx / xlsx / pptx / odt / epub 还是普通压缩包,要看里面的条目名(sniffZipEntries / sniffOleStreams)。

export type SniffKind =
  | 'pdf' | 'zip' | 'ole' | 'gzip' | 'bzip2' | 'xz' | '7z' | 'rar' | 'tar'
  | 'png' | 'jpg' | 'gif' | 'webp' | 'bmp' | 'tiff' | 'heic' | 'ico'
  | 'mp3' | 'wav' | 'flac' | 'ogg' | 'mp4' | 'webm' | 'avi'
  | 'rtf' | 'html' | 'svg' | 'json' | 'text' | 'binary'

const startsWith = (bytes: Uint8Array, pattern: number[], at = 0) => pattern.every((value, index) => bytes[at + index] === value)
const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))

export function sniffMagic(bytes: Uint8Array): SniffKind | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf'
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return 'zip'
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole'
  if (startsWith(bytes, [0x1f, 0x8b])) return 'gzip'
  if (startsWith(bytes, [0x42, 0x5a, 0x68])) return 'bzip2'
  if (startsWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz'
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z'
  if (startsWith(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar'
  if (bytes.length > 262 && ascii(bytes, 257, 262) === 'ustar') return 'tar'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpg'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return 'wav'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'AVI ') return 'avi'
  if (startsWith(bytes, [0x42, 0x4d]) && bytes.length > 14) return 'bmp'
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff'
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'ico'
  if (startsWith(bytes, [0x49, 0x44, 0x33]) || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return 'mp3'
  if (ascii(bytes, 0, 4) === 'fLaC') return 'flac'
  if (ascii(bytes, 0, 4) === 'OggS') return 'ogg'
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm'
  if (ascii(bytes, 4, 8) === 'ftyp') return /^(heic|heix|hevc|mif1|msf1)/.test(ascii(bytes, 8, 12)) ? 'heic' : 'mp4'
  if (ascii(bytes, 0, 5) === '{\\rtf') return 'rtf'
  return null
}

/** 文本探测:前 8 KB 没有 NUL,且能按 UTF-8 / GB18030 解成可读字符。返回解码后的编码名,不是文本返回 null。 */
export function sniffTextEncoding(bytes: Uint8Array): 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030' | null {
  const head = bytes.subarray(0, 8192)
  if (head.length === 0) return 'utf-8'
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le'
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be'
  if (head.includes(0)) return null
  let controls = 0
  for (const value of head) if (value < 9 || (value > 13 && value < 32 && value !== 27)) controls += 1
  if (controls / head.length > 0.02) return null
  // 末尾可能正好切在多字节字符中间:最多容忍丢掉最后 3 个字节
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let trim = 0; trim <= 3 && trim < head.length; trim += 1) {
    try {
      decoder.decode(head.subarray(0, head.length - trim))
      return 'utf-8'
    } catch {
      /* 再少一个字节试试 */
    }
  }
  return 'gb18030'
}

/** 按嗅探到的编码解码(去 BOM)。 */
export function decodeBytes(bytes: Uint8Array, encoding?: string | null): string {
  const label = encoding ?? sniffTextEncoding(bytes) ?? 'utf-8'
  const text = new TextDecoder(label).decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 文本内容的细分:html / svg / json / 普通文本。 */
export function sniffTextKind(text: string): 'html' | 'svg' | 'json' | 'text' {
  const head = text.slice(0, 1024).trimStart().toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg'
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || /^<(head|body|div|p|h1|table)[\s>]/.test(head)) return 'html'
  if (head.startsWith('{') || head.startsWith('[')) {
    try {
      JSON.parse(text.length > 2_000_000 ? '{}' : text)
      return 'json'
    } catch {
      return 'text'
    }
  }
  return 'text'
}

/** zip 容器的真实身份:看条目名。返回 `archive` 表示普通压缩包。 */
export function sniffZipEntries(names: string[]): 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'epub' | 'archive' {
  const has = (value: string) => names.includes(value)
  if (has('[Content_Types].xml')) {
    if (names.some((name) => name.startsWith('word/'))) return 'docx'
    if (names.some((name) => name.startsWith('xl/'))) return 'xlsx'
    if (names.some((name) => name.startsWith('ppt/'))) return 'pptx'
  }
  if (has('mimetype') && has('META-INF/container.xml')) return 'epub'
  if (has('mimetype') && has('content.xml')) {
    return 'odt'
  }
  return 'archive'
}

/** OLE 复合文档(老 Office)的真实身份:看根下的流名。 */
export function sniffOleStreams(names: string[]): 'doc' | 'xls' | 'ppt' | 'msg' | 'ole' {
  if (names.includes('WordDocument')) return 'doc'
  if (names.includes('Workbook') || names.includes('Book')) return 'xls'
  if (names.includes('PowerPoint Document')) return 'ppt'
  if (names.some((name) => name.startsWith('__substg1.0_'))) return 'msg'
  return 'ole'
}

/** 嗅探的最终结论:交给 FileViewer 当作新的 (kind, format) 重新路由。 */
export interface Resolved {
  /** 虚拟扩展名,给下游组件(SheetViewer 要 xlsx / xls 之分,DocReader 要 doc / ppt 之分)用 */
  format: string
  binary: boolean
}

/**
 * 把「魔数 + 容器内部条目名 + 文本特征」合成一个结论。
 * @param zipNames zip 容器的条目名(魔数是 zip 时才需要)
 * @param zipMime  zip 里 `mimetype` 文件的内容(区分 odt / ods / odp)
 * @param oleNames OLE 容器根下的流名(魔数是 OLE 时才需要)
 */
export function resolveSniffed(bytes: Uint8Array, zipNames: string[] = [], zipMime = '', oleNames: string[] = []): Resolved {
  const magic = sniffMagic(bytes)
  switch (magic) {
    case 'pdf': return { format: 'pdf', binary: false }
    case 'zip': {
      const inner = sniffZipEntries(zipNames)
      if (inner === 'odt') {
        if (/spreadsheet/.test(zipMime)) return { format: 'ods', binary: false }
        if (/presentation/.test(zipMime)) return { format: 'odp', binary: false }
      }
      return { format: inner === 'archive' ? 'zip' : inner, binary: false }
    }
    case 'ole': {
      const inner = sniffOleStreams(oleNames)
      return inner === 'ole' ? { format: 'bin', binary: true } : { format: inner, binary: false }
    }
    case 'gzip': case 'bzip2': case 'xz': case '7z': case 'rar': case 'tar':
      return { format: magic === 'gzip' ? 'gz' : magic === 'bzip2' ? 'bz2' : magic, binary: false }
    case 'png': case 'jpg': case 'gif': case 'webp': case 'bmp': case 'ico':
      return { format: magic, binary: false }
    case 'tiff': return { format: 'tiff', binary: false }
    case 'heic': return { format: 'heic', binary: false }
    case 'mp3': case 'wav': case 'flac': case 'ogg': case 'mp4': case 'webm': case 'avi':
      return { format: magic, binary: false }
    case 'rtf': return { format: 'rtf', binary: false }
    default: {
      const encoding = sniffTextEncoding(bytes)
      if (!encoding) return { format: 'bin', binary: true }
      const kind = sniffTextKind(decodeBytes(bytes.subarray(0, 4096), encoding))
      return { format: kind === 'text' ? 'txt' : kind, binary: false }
    }
  }
}
