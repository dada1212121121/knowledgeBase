import { describe, expect, it } from 'vitest'
import { collabKindOf, docKey, encodeSegment, isMarkdownPath } from './resourceKey'

describe('docKey(和后端 ResourceKey 的写法一致)', () => {
  it('笔记:doc:<sid>/<集合>/i/<id>', () => {
    expect(docKey('sp_abc', '_global', { insight: '01a1-ff' })).toBe('doc:sp_abc/_global/i/01a1-ff')
  })
  it('文件:路径按 / 分段编码,中文和空格按 UTF-8 字节写成大写十六进制', () => {
    expect(docKey('sp_abc', 'proj_x', { file: 'docs/说明 书.md' })).toBe('doc:sp_abc/proj_x/f/docs/%E8%AF%B4%E6%98%8E%20%E4%B9%A6.md')
  })
  it('encodeURIComponent 放过的 ! \' ( ) * 在这里也要编码(服务端对每个键只认一种写法)', () => {
    expect(encodeSegment("a!b'c(d)e*f")).toBe('a%21b%27c%28d%29e%2Af')
    expect(encodeSegment('a/b%c')).toBe('a%2Fb%25c')
    expect(encodeSegment('A-z_0.9~')).toBe('A-z_0.9~')
  })
})

describe('collabKindOf(和后端 DocKind::for_file 一致)', () => {
  it('笔记和 Markdown 文件是富文本房间,其它文件是纯文本房间', () => {
    expect(collabKindOf({ insight: 'x' })).toBe('rich')
    for (const path of ['a.md', '文档/说明.MD', 'x/y.markdown', 'z.mdown', 'page.mdx']) expect(collabKindOf({ file: path })).toBe('rich')
    for (const path of ['a.txt', 'src/main.rs', 'README', 'md', 'a.md.bak', 'notes.md/readme.txt']) expect(collabKindOf({ file: path })).toBe('text')
  })
  it('isMarkdownPath 只看最后一段的扩展名', () => {
    expect(isMarkdownPath('dir.md/file')).toBe(false)
    expect(isMarkdownPath('.md')).toBe(true)
  })
})
