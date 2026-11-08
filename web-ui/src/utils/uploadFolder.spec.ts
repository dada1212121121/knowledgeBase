// 导入时的目标文件夹:规整、校验、给文件加前缀。
import { describe, expect, it } from 'vitest'
import { relativePathOf } from '@/api/upload'
import { normalizeFolder, withFolderPrefix } from './uploadFolder'

describe('normalizeFolder', () => {
  it('不填是合法的:放在集合根目录', () => {
    expect(normalizeFolder('')).toEqual({ ok: true, folder: '' })
    expect(normalizeFolder('   ')).toEqual({ ok: true, folder: '' })
    expect(normalizeFolder(' / ./ ')).toEqual({ ok: true, folder: '' })
  })

  it('规整成用 / 分隔、没有首尾斜杠和重复斜杠的路径,中文和空格保留', () => {
    expect(normalizeFolder('手册/2026')).toEqual({ ok: true, folder: '手册/2026' })
    expect(normalizeFolder('/手册//2026/')).toEqual({ ok: true, folder: '手册/2026' })
    expect(normalizeFolder('手册\\2026\\ 十月 ')).toEqual({ ok: true, folder: '手册/2026/十月' })
    expect(normalizeFolder('./a/./b')).toEqual({ ok: true, folder: 'a/b' })
  })

  it('拒绝 .. 和控制字符(跳出集合、写到别处)', () => {
    expect(normalizeFolder('a/../b')).toEqual({ ok: false, reason: '文件夹里不能有 ..' })
    expect(normalizeFolder('..')).toEqual({ ok: false, reason: '文件夹里不能有 ..' })
    expect(normalizeFolder('a/b\u0007c').ok).toBe(false)
  })
})

describe('withFolderPrefix', () => {
  const file = (name: string, relative?: string) => {
    const made = new File(['内容'], name, { type: 'text/plain', lastModified: 1_700_000_000_000 })
    if (relative) Object.defineProperty(made, 'webkitRelativePath', { value: relative })
    return made
  }

  it('不填文件夹:原样返回同一批文件', () => {
    const files = [file('a.md')]
    expect(withFolderPrefix(files, '')).toBe(files)
  })

  it('单个文件放进文件夹;选的是整个文件夹时保留里面的层级', () => {
    const [single, nested] = withFolderPrefix([file('a.md'), file('b.md', '资料/子目录/b.md')], '手册/2026')
    expect(relativePathOf(single!)).toBe('手册/2026/a.md')
    expect(relativePathOf(nested!)).toBe('手册/2026/资料/子目录/b.md')
  })

  it('文件本身不变:名字、类型、大小、修改时间、内容', async () => {
    const original = file('a.md')
    const [wrapped] = withFolderPrefix([original], 'x')
    expect(wrapped!.name).toBe('a.md')
    expect(wrapped!.type).toBe('text/plain')
    expect(wrapped!.size).toBe(original.size)
    expect(wrapped!.lastModified).toBe(original.lastModified)
    // jsdom 的 File 没有 text,用 FileReader 读
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(wrapped!)
    })
    expect(text).toBe('内容')
  })
})
