// 压缩包列表与条目读取:zip(含 jar / war / apk / 各种以 zip 为壳的格式)、tar、tar.gz / tgz、单文件 gz。
// 7z / rar / bz2 / xz 在浏览器里没有不依赖 wasm 的解码器(CSP 也没放开 wasm):明确报「不支持」,让界面提示下载。
import JSZip from 'jszip'

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveError'
  }
}

export interface ArchiveEntry {
  path: string
  size: number
  dir: boolean
  /** 毫秒时间戳;没有就是 0 */
  modified: number
}

export interface Archive {
  kind: 'zip' | 'tar' | 'gzip-file'
  entries: ArchiveEntry[]
  /** 读条目开头最多 `max` 字节 */
  read(entry: ArchiveEntry, max: number): Promise<Uint8Array>
}

const MAX_UNPACKED = 256 * 1024 * 1024

export async function gunzip(bytes: Uint8Array, limit = MAX_UNPACKED): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new ArchiveError('当前浏览器不支持 gzip 解压(需要较新的 Chrome / Safari / Firefox)')
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes as unknown as BufferSource)
      controller.close()
    },
  })
  const stream = source.pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        void reader.cancel()
        throw new ArchiveError('解压后超过 256 MB,不在页内展开,请下载后查看')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error
    throw new ArchiveError('gzip 数据已损坏,无法解压')
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) (out.set(chunk, at), (at += chunk.byteLength))
  return out
}

/* ------------------------------------------------------------------ tar */

const text = (bytes: Uint8Array, from: number, length: number) => new TextDecoder().decode(bytes.subarray(from, from + length)).replace(/\0.*$/s, '')
const octal = (bytes: Uint8Array, from: number, length: number) => Number.parseInt(text(bytes, from, length).trim() || '0', 8) || 0

export function isTar(bytes: Uint8Array): boolean {
  return bytes.length >= 512 && text(bytes, 257, 5) === 'ustar'
}

export function listTar(bytes: Uint8Array): Archive {
  const entries: (ArchiveEntry & { offset: number })[] = []
  let at = 0
  let longName = ''
  while (at + 512 <= bytes.length) {
    if (bytes.subarray(at, at + 512).every((value) => value === 0)) break
    const name = text(bytes, at, 100)
    const size = octal(bytes, at + 124, 12)
    const type = String.fromCharCode(bytes[at + 156] || 0x30)
    const prefix = text(bytes, at + 345, 155)
    const modified = octal(bytes, at + 136, 12) * 1000
    const body = at + 512
    if (type === 'L') {
      longName = text(bytes, body, size)
    } else if (type === 'x' || type === 'g') {
      const pax = new TextDecoder().decode(bytes.subarray(body, body + size))
      const match = /\d+ path=([^\n]*)\n/.exec(pax)
      if (match && type === 'x') longName = match[1]!
    } else {
      const path = longName || (prefix ? `${prefix}/${name}` : name)
      longName = ''
      const dir = type === '5' || path.endsWith('/')
      if (type === '0' || type === '\0' || type === '5' || type === '7') entries.push({ path, size: dir ? 0 : size, dir, modified, offset: body })
    }
    at = body + Math.ceil(size / 512) * 512
  }
  if (!entries.length) throw new ArchiveError('tar 里没有任何文件(或数据已损坏)')
  return {
    kind: 'tar',
    entries,
    async read(entry, max) {
      const found = entries.find((item) => item.path === entry.path)
      return found ? bytes.subarray(found.offset, found.offset + Math.min(found.size, max)) : new Uint8Array()
    },
  }
}

/* ------------------------------------------------------------------ zip */

export async function listZip(bytes: Uint8Array): Promise<Archive> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    throw new ArchiveError('zip 数据已损坏或不完整,无法读取目录')
  }
  const entries: ArchiveEntry[] = Object.values(zip.files).map((file) => ({
    path: file.name,
    // JSZip 没有公开未压缩大小,内部字段 _data.uncompressedSize 在 3.x 一直存在
    size: file.dir ? 0 : ((file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0),
    dir: file.dir,
    modified: file.date ? file.date.getTime() : 0,
  }))
  if (!entries.length) throw new ArchiveError('压缩包是空的')
  return {
    kind: 'zip',
    entries,
    async read(entry, max) {
      const file = zip.file(entry.path)
      if (!file) return new Uint8Array()
      const data = await file.async('uint8array')
      return data.byteLength > max ? data.subarray(0, max) : data
    },
  }
}

/** 按字节内容打开(不看扩展名):zip / tar / tar.gz / 单文件 gz。其它压缩格式抛 ArchiveError。 */
export async function openArchive(bytes: Uint8Array, filename = ''): Promise<Archive> {
  const head = bytes
  if (head[0] === 0x50 && head[1] === 0x4b) return listZip(bytes)
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const inner = await gunzip(bytes)
    if (isTar(inner)) return listTar(inner)
    const name = filename.split('/').pop()?.replace(/\.(gz|tgz)$/i, '') || 'data'
    const entry: ArchiveEntry = { path: name, size: inner.byteLength, dir: false, modified: 0 }
    return { kind: 'gzip-file', entries: [entry], read: async (_item, max) => inner.subarray(0, max) }
  }
  if (isTar(head)) return listTar(bytes)
  if (head[0] === 0x37 && head[1] === 0x7a) throw new ArchiveError('7z 压缩包暂不支持在页内展开(浏览器端没有可用的解码器),请下载后查看')
  if (head[0] === 0x52 && head[1] === 0x61) throw new ArchiveError('rar 压缩包暂不支持在页内展开(格式私有),请下载后查看')
  if (head[0] === 0x42 && head[1] === 0x5a) throw new ArchiveError('bz2 压缩暂不支持在页内展开,请下载后查看')
  if (head[0] === 0xfd && head[1] === 0x37) throw new ArchiveError('xz 压缩暂不支持在页内展开,请下载后查看')
  throw new ArchiveError('认不出这种压缩格式')
}

/** 把平铺路径变成目录树(按目录在前、名称排序),用于列表缩进显示。 */
export interface TreeRow {
  entry: ArchiveEntry
  depth: number
  name: string
}
export function treeRows(entries: ArchiveEntry[]): TreeRow[] {
  const seen = new Set<string>()
  const files: ArchiveEntry[] = []
  for (const entry of entries) {
    const parts = entry.path.replace(/\/$/, '').split('/')
    for (let depth = 1; depth < parts.length; depth += 1) {
      const dir = parts.slice(0, depth).join('/') + '/'
      if (!seen.has(dir)) {
        seen.add(dir)
        files.push({ path: dir, size: 0, dir: true, modified: 0 })
      }
    }
    if (!seen.has(entry.path)) {
      seen.add(entry.path)
      files.push(entry)
    }
  }
  const key = (path: string) => path.replace(/\/$/, '').split('/').map((part, index, all) => ((index < all.length - 1 || path.endsWith('/')) ? `0${part}` : `1${part}`))
  files.sort((left, right) => {
    const a = key(left.path)
    const b = key(right.path)
    for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
      if (a[at] !== b[at]) return a[at]! < b[at]! ? -1 : 1
    }
    return a.length - b.length
  })
  return files.map((entry) => {
    const parts = entry.path.replace(/\/$/, '').split('/')
    return { entry, depth: parts.length - 1, name: parts[parts.length - 1] ?? entry.path }
  })
}
