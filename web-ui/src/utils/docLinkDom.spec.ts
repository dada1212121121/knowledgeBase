// 正文链接改写(阅读态 / 预览共用)的契约:双链、相对路径、缺目标、图片、幂等。
// 这些行为以前埋在旧预览组件里只被组件测试间接触及, 把它提到 utils 后单独守一遍。
import { describe, expect, it } from 'vitest'
import { decorateWikilinks, resolveDocLinkClick, rewriteDocLinks, type DocLinkOptions } from './docLinkDom'
import { linkKey, noteLinkKey, type LinkContext } from './links'

const ctx: LinkContext = {
  collection: 'proj',
  sourcePath: 'docs/当前.md',
  rawUrl: (collection, path) => `/api/v1/raw?${new URLSearchParams({ collection, path }).toString()}`,
  downloadUrl: (collection, path) => `/api/v1/download?${new URLSearchParams({ collection, path }).toString()}`,
}

function makeOptions(patch: Partial<DocLinkOptions> = {}): DocLinkOptions {
  return { context: ctx, linkStates: {}, allowNotes: true, ...patch }
}

function host(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

const NOTE_ID = '01a19f63-f0ea-72fe-aa19-9998f6e2e5ad'

describe('decorateWikilinks', () => {
  it('文件双链按 collection 根解析,笔记双链变成 kb://note 链接', () => {
    const root = host('<p>[[docs/规范.md|规范]] [[01a19f63-f0ea-72fe-aa19-9998f6e2e5ad|旧笔记]]</p>')
    decorateWikilinks(root, makeOptions())
    const file = root.querySelector('a.kb-wikilink') as HTMLAnchorElement
    expect(file.dataset.kbHref).toBe('docs/规范.md')
    expect(file.dataset.kbRoot).toBe('1')
    expect(file.textContent).toBe('规范')
    const note = root.querySelector(`a[data-kb-note="${NOTE_ID}"]`) as HTMLAnchorElement
    expect(note.getAttribute('href')).toBe(`kb://note/${NOTE_ID}`)
    expect(note.textContent).toBe('旧笔记')
  })

  it('笔记双链按体检结果标出打不开;分享页只留文字', () => {
    const root = host(`<p>[[${NOTE_ID}|旧笔记]]</p>`)
    decorateWikilinks(root, makeOptions({ linkStates: { [noteLinkKey(NOTE_ID)]: 'missing' } }))
    const anchor = root.querySelector('a[data-kb-note]') as HTMLAnchorElement
    expect(anchor.classList.contains('kb-link-missing')).toBe(true)
    expect(anchor.dataset.kbProblem).toContain('不在知识库里')

    const shared = host(`<p>[[${NOTE_ID}|旧笔记]]</p>`)
    decorateWikilinks(shared, makeOptions({ allowNotes: false }))
    expect(shared.querySelector('a')).toBeNull()
    expect(shared.querySelector('span.kb-wikilink')?.textContent).toBe('旧笔记')
  })

  it('代码块 / 行内代码 / 已有链接里的双链不动', () => {
    const root = host('<pre><code>[[docs/a.md|a]]</code></pre><p><code>[[docs/b.md|b]]</code></p><p><a href="/x">[[docs/c.md|c]]</a></p>')
    decorateWikilinks(root, makeOptions())
    expect(root.querySelectorAll('a.kb-wikilink')).toHaveLength(0)
    expect(root.textContent).toContain('[[docs/a.md|a]]')
  })

  it('没有标题的 [[id]] 用 id 当文字;空 id 原样保留', () => {
    const root = host('<p>[[docs/无标题.md]] [[|空]]</p>')
    decorateWikilinks(root, makeOptions())
    expect(root.querySelector('a.kb-wikilink')?.textContent).toBe('docs/无标题.md')
    expect(root.textContent).toContain('[[|空]]')
  })
})

describe('rewriteDocLinks', () => {
  it('相对文件链接走 raw / download 地址,并记下目标供点击使用', () => {
    const root = host('<p><a href="./图.png">图</a><a href="kb://_global/模板.dotx?download=1">模板</a></p>')
    rewriteDocLinks(root, makeOptions())
    const [file, template] = [...root.querySelectorAll('a')] as HTMLAnchorElement[]
    expect(file.getAttribute('href')).toContain('/api/v1/raw?')
    expect(file.dataset.kbCollection).toBe('proj')
    expect(file.dataset.kbPath).toBe('docs/图.png')
    expect(template.getAttribute('href')).toContain('/api/v1/download?')
    expect(template.dataset.kbDownload).toBe('1')
  })

  it('外链新窗口;原电脑路径只提示不改地址', () => {
    const root = host('<p><a href="https://example.com/a">外链</a><a href="C:\\\\资料\\\\a.pdf">本地</a></p>')
    rewriteDocLinks(root, makeOptions())
    const [external, absolute] = [...root.querySelectorAll('a')] as HTMLAnchorElement[]
    expect(external.getAttribute('target')).toBe('_blank')
    expect(external.getAttribute('rel')).toContain('noopener')
    expect(absolute.dataset.kbProblem).toContain('原电脑')
    expect(absolute.getAttribute('href')).toBe('C:\\\\资料\\\\a.pdf')
  })

  it('图片解析成原件地址,缺图加提示;重复改写不会把地址再解析一次', () => {
    const root = host('<p><img src="./截图.png" alt="截图"></p>')
    const options = makeOptions({ linkStates: { [linkKey('proj', 'docs/截图.png')]: 'missing' } })
    rewriteDocLinks(root, options)
    const image = root.querySelector('img') as HTMLImageElement
    const first = image.src
    expect(first).toContain('/api/v1/raw?')
    expect(image.classList.contains('kb-img-missing')).toBe(true)
    rewriteDocLinks(root, options)
    expect(image.src).toBe(first)
    expect(image.dataset.kbSrc).toBe('./截图.png')
  })

  it('笔记双链的 href 不会被当成文件再解析一次', () => {
    const root = host(`<p>[[${NOTE_ID}|旧笔记]]</p>`)
    rewriteDocLinks(root, makeOptions())
    const anchor = root.querySelector(`a[data-kb-note="${NOTE_ID}"]`) as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe(`kb://note/${NOTE_ID}`)
    expect(anchor.dataset.kbCollection).toBeUndefined()
  })
})

describe('resolveDocLinkClick', () => {
  it('笔记 / 文件 / 缺目标各有自己的结果;下载与外部链接交回浏览器', () => {
    const root = host(`<p>
      <a href="#" data-kb-note="${NOTE_ID}">笔记</a>
      <a href="#" data-kb-collection="proj" data-kb-path="docs/a.md" data-kb-fragment="h2">文件</a>
      <a href="#" data-kb-problem="目标不在知识库里">坏</a>
      <a href="#" data-kb-collection="proj" data-kb-path="a.txt" data-kb-download="1">下载</a>
      <a href="https://example.com">外链</a>
    </p>`)
    const [note, file, broken, download, external] = [...root.querySelectorAll('a')] as HTMLAnchorElement[]
    expect(resolveDocLinkClick(note)).toEqual({ kind: 'note', id: NOTE_ID })
    expect(resolveDocLinkClick(file)).toEqual({ kind: 'file', collection: 'proj', path: 'docs/a.md', fragment: 'h2' })
    expect(resolveDocLinkClick(broken)).toEqual({ kind: 'problem', message: '目标不在知识库里' })
    expect(resolveDocLinkClick(download)).toBeNull()
    expect(resolveDocLinkClick(external)).toBeNull()
    // 分享页不允许跳笔记时,笔记点击也交回浏览器
    expect(resolveDocLinkClick(note, false)).toBeNull()
    expect(resolveDocLinkClick(null)).toBeNull()
  })
})
