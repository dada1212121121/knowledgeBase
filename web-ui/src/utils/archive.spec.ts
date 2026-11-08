import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { ArchiveError, gunzip, isTar, listTar, listZip, openArchive, treeRows } from './archive'

function tarOf(files: Record<string, string>, { long = false } = {}): Uint8Array {
  const blocks: Uint8Array[] = []
  const enc = new TextEncoder()
  const header = (name: string, size: number, type = '0') => {
    const block = new Uint8Array(512)
    block.set(enc.encode(name.slice(0, 100)), 0)
    block.set(enc.encode(size.toString(8).padStart(11, '0') + '\0'), 124)
    block.set(enc.encode('00000000000\0'), 136)
    block[156] = type.charCodeAt(0)
    block.set(enc.encode('ustar\0'), 257)
    return block
  }
  for (const [name, body] of Object.entries(files)) {
    if (long && name.length > 100) {
      const data = enc.encode(name + '\0')
      blocks.push(header('././@LongLink', data.length, 'L'))
      const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
      padded.set(data)
      blocks.push(padded)
    }
    const data = enc.encode(body)
    blocks.push(header(name, data.length, name.endsWith('/') ? '5' : '0'))
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
    padded.set(data)
    if (padded.length) blocks.push(padded)
  }
  blocks.push(new Uint8Array(1024))
  const out = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0))
  let at = 0
  for (const block of blocks) (out.set(block, at), (at += block.length))
  return out
}
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes as unknown as BufferSource)
      controller.close()
    },
  })
  const stream = source.pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('zip', () => {
  it('lists entries with sizes and reads content', async () => {
    const zip = new JSZip()
    zip.file('a.txt', 'hello')
    zip.file('dir/b.md', '# b')
    const archive = await listZip(await zip.generateAsync({ type: 'uint8array' }))
    expect(archive.kind).toBe('zip')
    const a = archive.entries.find((entry) => entry.path === 'a.txt')!
    expect(a.size).toBe(5)
    expect(text(await archive.read(a, 100))).toBe('hello')
    expect(text(await archive.read(a, 2))).toBe('he')
    expect(archive.entries.some((entry) => entry.dir && entry.path === 'dir/')).toBe(true)
  })
  it('explains a corrupt zip', async () => {
    await expect(listZip(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).rejects.toBeInstanceOf(ArchiveError)
  })
})

describe('tar / gzip', () => {
  it('reads a tar, including long names', async () => {
    const long = 'deep/' + 'x'.repeat(120) + '.txt'
    const archive = listTar(tarOf({ 'a.txt': 'AAA', 'sub/': '', [long]: 'LONG' }, { long: true }))
    expect(archive.entries.map((entry) => entry.path)).toEqual(['a.txt', 'sub/', long])
    expect(archive.entries[1]!.dir).toBe(true)
    expect(text(await archive.read(archive.entries[2]!, 100))).toBe('LONG')
    expect(isTar(tarOf({ 'a': 'b' }))).toBe(true)
  })
  it('opens tar.gz and a single-file gz by content', async () => {
    const tgz = await openArchive(await gzip(tarOf({ 'x.txt': 'hi' })), 'pack.tar.gz')
    expect(tgz.kind).toBe('tar')
    expect(text(await tgz.read(tgz.entries[0]!, 10))).toBe('hi')
    const gz = await openArchive(await gzip(new TextEncoder().encode('just a log')), 'app.log.gz')
    expect(gz.kind).toBe('gzip-file')
    expect(gz.entries[0]!.path).toBe('app.log')
    expect(text(await gz.read(gz.entries[0]!, 100))).toBe('just a log')
  })
  it('refuses to inflate past the limit and reports corrupt gzip', async () => {
    await expect(gunzip(await gzip(new Uint8Array(10000)), 1000)).rejects.toThrow(/256 MB/)
    await expect(gunzip(new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]))).rejects.toBeInstanceOf(ArchiveError)
  })
})

describe('openArchive', () => {
  it('names the formats it cannot open', async () => {
    await expect(openArchive(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf]))).rejects.toThrow(/7z/)
    await expect(openArchive(new Uint8Array([0x52, 0x61, 0x72, 0x21]))).rejects.toThrow(/rar/)
    await expect(openArchive(new Uint8Array([0x42, 0x5a, 0x68]))).rejects.toThrow(/bz2/)
    await expect(openArchive(new Uint8Array([0xfd, 0x37, 0x7a]))).rejects.toThrow(/xz/)
    await expect(openArchive(new Uint8Array([1, 2, 3]))).rejects.toThrow(/认不出/)
  })
})

describe('treeRows', () => {
  it('synthesises missing directories and sorts folders first', () => {
    const rows = treeRows([
      { path: 'b.txt', size: 1, dir: false, modified: 0 },
      { path: 'src/lib/x.rs', size: 2, dir: false, modified: 0 },
      { path: 'a.txt', size: 3, dir: false, modified: 0 },
    ])
    expect(rows.map((row) => `${' '.repeat(row.depth)}${row.name}${row.entry.dir ? '/' : ''}`)).toEqual(['src/', ' lib/', '  x.rs', 'a.txt', 'b.txt'])
  })
})
