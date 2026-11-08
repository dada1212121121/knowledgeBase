import { describe, expect, it } from 'vitest'
import { hrefForTarget, isNoteLinkId, isTemplatePath, kbFileHref, linkKey, noteHref, normalizeLinkPath, parseFileUrl, relativeFileHref, resolveDocHref, sanitizeRenderHref, scrollToFragment, type LinkContext } from './links'

const ctx = (sourcePath?: string): LinkContext => ({
  collection: 'proj',
  sourcePath,
  rawUrl: (collection, path) => `/api/v1/raw?${new URLSearchParams({ collection, path }).toString()}`,
  downloadUrl: (collection, path) => `/api/v1/download?${new URLSearchParams({ collection, path }).toString()}`,
})

describe('links · 路径规整', () => {
  it('把 ./ 和 ../ 规整到 collection 内', () => {
    expect(normalizeLinkPath('./docs/../a.md')).toBe('a.md')
    expect(normalizeLinkPath('docs\\a.md')).toBe('docs/a.md')
    expect(normalizeLinkPath('../a.md')).toBeNull()
    expect(normalizeLinkPath('docs/\u0000a.md')).toBeNull()
  })
})

describe('links · 解析 href', () => {
  it('相对链接按文件所在目录解析,保留 #fragment 和 query', () => {
    const link = resolveDocHref('./截图%201.png?raw=1#x', ctx('docs/手册.md'))
    expect(link.kind).toBe('file')
    expect(link.target).toBe('docs/截图 1.png')
    expect(link.fragment).toBe('x')
    expect(link.href).toContain('path=docs%2F%E6%88%AA%E5%9B%BE+1.png')
    expect(link.href).toContain('&raw=1#x')
  })

  it('锚点 / 外链原样返回', () => {
    expect(resolveDocHref('#标题', ctx()).kind).toBe('anchor')
    expect(resolveDocHref('https://example.com/a', ctx()).kind).toBe('external')
    expect(resolveDocHref('/docs/a.md', ctx()).kind).toBe('external')
  })

  it('原电脑路径和不安全协议不伪装成知识库文件', () => {
    expect(resolveDocHref('D:\\资料\\a.xlsx', ctx()).kind).toBe('absolute')
    expect(resolveDocHref('file:///C:/a.md', ctx()).kind).toBe('absolute')
    expect(resolveDocHref('javascript:alert(1)', ctx()).kind).toBe('invalid')
    expect(resolveDocHref('../../secret.md', ctx('docs/a.md')).kind).toBe('invalid')
  })

  it('模板 / ?download=1 保留下载意图,不再改写成预览地址', () => {
    const explicit = resolveDocHref('kb://_global/亚马逊运营/成本对比.csv?download=1#top', ctx())
    expect(explicit.kind).toBe('file')
    expect(explicit.collection).toBe('_global')
    expect(explicit.target).toBe('亚马逊运营/成本对比.csv')
    expect(explicit.download).toBe(true)
    expect(explicit.href).toContain('/api/v1/download?')
    expect(explicit.href).toContain('#top')
    expect(explicit.href).not.toContain('download=1')

    // 扩展名已经说明是模板:即使作者没写 ?download=1,也直接下载
    const template = resolveDocHref('kb://_global/模板/报价单.dotx', ctx())
    expect(template.download).toBe(true)
    expect(template.href).toContain('/api/v1/download?')

    // 相对路径同样保留下载意图
    const relative = resolveDocHref('./模板/报价单.xltx', ctx('销售/笔记.md'))
    expect(relative.download).toBe(true)
    expect(relative.href).toContain('/api/v1/download?')

    expect(isTemplatePath('a.potx')).toBe(true)
    expect(isTemplatePath('a.docx')).toBe(false)
  })

  it('kb:// 可跨集合,note 走笔记 id', () => {
    const file = resolveDocHref('kb://proj_other/资料/手册.md#安装', ctx())
    expect(file.kind).toBe('file')
    expect(file.collection).toBe('proj_other')
    expect(file.target).toBe('资料/手册.md')
    expect(file.fragment).toBe('安装')

    const note = resolveDocHref('kb://note/01a19f63-f0ea-72fe-aa19-9998f6e2e5ad', ctx())
    expect(note.kind).toBe('note')
    expect(note.noteId).toBe('01a19f63-f0ea-72fe-aa19-9998f6e2e5ad')

    expect(resolveDocHref('kb://proj/../../secret.md', ctx()).kind).toBe('invalid')
    expect(resolveDocHref('kb://proj/a%2F..%2Fsecret.md', ctx()).kind).toBe('invalid')
    expect(resolveDocHref('kb://note/..', ctx()).kind).toBe('invalid')
    expect(resolveDocHref('kb://unknown/a.md', ctx()).kind).toBe('invalid')
    expect(resolveDocHref('kb://_global/', ctx()).kind).toBe('invalid')
  })

  it('生成引用时逐段编码,并且能往返解析', () => {
    const href = kbFileHref('_global', '利润表/成本 #1.csv', { download: true, fragment: '表' })
    expect(href).toBe('kb://_global/%E5%88%A9%E6%B6%A6%E8%A1%A8/%E6%88%90%E6%9C%AC%20%231.csv?download=1#表')
    const link = resolveDocHref(href, ctx())
    expect(link.target).toBe('利润表/成本 #1.csv')
    expect(link.download).toBe(true)
    expect(link.fragment).toBe('表')
    expect(noteHref('ins_8b10')).toBe('kb://note/ins_8b10')
    expect(noteHref('../x')).toBe('')
  })

  it('双链 id 与模板扩展名判定沿用编辑器约定', () => {
    expect(isNoteLinkId('01a19f63-f0ea-72fe-aa19-9998f6e2e5ad')).toBe(true)
    expect(isNoteLinkId('ins_8b10')).toBe(true)
    expect(isNoteLinkId('docs/规范.md')).toBe(false)
    expect(isNoteLinkId('图.png')).toBe(false)
    expect(isNoteLinkId('目录')).toBe(true) // 没有扩展名,沿用编辑器的「按笔记处理」
    expect(linkKey('_global', 'a.md')).not.toBe(noteHref('a.md'))
  })

  it('本站原件地址归一成 collection 内目标,外站原件地址不动', () => {
    expect(parseFileUrl('/api/v1/raw?collection=proj&path=a%2Fb.png')).toEqual({ kind: 'raw', collection: 'proj', path: 'a/b.png' })
    expect(parseFileUrl('/api/v1/download?collection=proj&path=a.png')?.kind).toBe('download')
    expect(parseFileUrl('https://evil.example/api/v1/raw?collection=proj&path=a.png')).toBeNull()
    const link = resolveDocHref('/api/v1/share/tok/download?collection=proj&path=a.png', ctx())
    expect(link.kind).toBe('raw')
    expect(link.collection).toBe('proj')
    expect(link.target).toBe('a.png')
  })
})

describe('links · 生成引用地址', () => {
  it('同集合用相对路径,跨集合 / 新笔记用 kb://', () => {
    expect(relativeFileHref('docs/笔记.md', 'attachments/2026-01/a b.pdf')).toBe('../attachments/2026-01/a%20b.pdf')
    expect(relativeFileHref('docs/笔记.md', 'docs/图.png')).toBe('%E5%9B%BE.png')
    expect(relativeFileHref('docs/笔记.md', 'docs/sub/图.png')).toBe('sub/%E5%9B%BE.png')
    expect(relativeFileHref(null, 'docs/图.png')).toBeNull()
    expect(relativeFileHref('a.md', '../x.png')).toBeNull()

    expect(hrefForTarget('_global', 'docs/笔记.md', '_global', 'attachments/a.pdf')).toBe('../attachments/a.pdf')
    expect(hrefForTarget('_global', 'docs/笔记.md', 'proj_x', 'docs/a.pdf')).toBe('kb://proj_x/docs/a.pdf')
    expect(hrefForTarget('_global', null, '_global', '模板/报价单.dotx', { download: true })).toBe('kb://_global/%E6%A8%A1%E6%9D%BF/%E6%8A%A5%E4%BB%B7%E5%8D%95.dotx?download=1')
  })
})

describe('links · 滚动到锚点', () => {
  it('按 id / name 查找并解码', () => {
    const root = document.createElement('div')
    root.innerHTML = '<h2 id="中文标题">标题</h2><a name="old"></a>'
    document.body.append(root)
    const scrolled: string[] = []
    const spy = (element: Element) => scrolled.push(element.id || element.getAttribute('name') || '')
    root.querySelectorAll('h2,a').forEach((element) => (element.scrollIntoView = () => spy(element)))
    scrollToFragment('%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98', root)
    scrollToFragment('old', root)
    expect(scrolled).toEqual(['中文标题', 'old'])
    root.remove()
  })
})

describe('links · 渲染 href 白名单', () => {
  it('保留 kb:// 内部链接(否则附件卡片 / 跨集合引用点不动)', () => {
    expect(sanitizeRenderHref('kb://proj/a%20b.md')).toBe('kb://proj/a%20b.md')
    expect(sanitizeRenderHref('KB://note/01a1')).toBe('KB://note/01a1')
  })

  it('放行常规协议与相对链接', () => {
    expect(sanitizeRenderHref('https://example.com/x')).toBe('https://example.com/x')
    expect(sanitizeRenderHref('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(sanitizeRenderHref('./图.png')).toBe('./图.png')
    expect(sanitizeRenderHref('#anchor')).toBe('#anchor')
  })

  it('拦住脚本协议与空值,不能靠不可见字符绕过', () => {
    expect(sanitizeRenderHref('')).toBe('')
    expect(sanitizeRenderHref(null)).toBe('')
    expect(sanitizeRenderHref('javascript:alert(1)')).toBe('')
    expect(sanitizeRenderHref('java\u0000script:alert(1)')).toBe('')
    expect(sanitizeRenderHref('data:text/html,<b>x</b>')).toBe('')
  })
})
