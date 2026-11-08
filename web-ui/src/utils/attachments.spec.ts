import { describe, expect, it } from 'vitest'
import {
  assetUrl,
  attachmentExt,
  attachmentKind,
  attachmentMarkdown,
  attachmentMeta,
  attachmentPath,
  displayName,
  downloadUrl,
  imageMarkdown,
  imageUploadName,
  isImageName,
  mediaKind,
  parseRawUrl,
  rawUrl,
  safeFileName,
} from './attachments'

describe('attachments', () => {
  it('builds a dated path with a random prefix and a cleaned file name', () => {
    const path = attachmentPath('a/b\\周会 纪要?.pdf', Date.UTC(2026, 9, 27), () => 0)
    expect(path).toBe('_attachments/2026-10/aaaaaaaa-周会 纪要.pdf')
  })
  it('keeps the extension when shortening long names', () => {
    const name = safeFileName(`${'长'.repeat(120)}.docx`)
    expect(name.length).toBe(80)
    expect(name.endsWith('.docx')).toBe(true)
    expect(safeFileName('   ')).toBe('file')
  })
  it('round-trips raw urls and rejects foreign ones', () => {
    const url = rawUrl('_global', '_attachments/2026-10/abc12345-报告 v2.pdf')
    expect(parseRawUrl(url)).toEqual({ collection: '_global', path: '_attachments/2026-10/abc12345-报告 v2.pdf' })
    expect(parseRawUrl('https://evil.example/api/v1/raw?collection=a&path=b')).toBeNull()
    expect(parseRawUrl('/api/v1/other?collection=a&path=b')).toBeNull()
    expect(parseRawUrl('/api/v1/raw?collection=a')).toBeNull()
  })
  it('builds streaming download urls and keeps admin_view', () => {
    expect(downloadUrl('_global', '_attachments/2026-10/a b.pdf')).toBe(
      `/api/v1/download?${new URLSearchParams({ collection: '_global', path: '_attachments/2026-10/a b.pdf' }).toString()}`,
    )
    expect(downloadUrl('_global', 'a.pdf', 'usr_1')).toContain('admin_view=usr_1')
  })
  it('writes image and attachment markdown, escaping brackets', () => {
    expect(imageMarkdown('架构 [v2].png', '/x')).toBe('![架构 \\[v2\\]](/x)')
    expect(attachmentMarkdown('报告.pdf', '/x', 2048)).toBe('[📎 报告.pdf](/x "2.0 KB")')
  })
  it('classifies names', () => {
    expect(isImageName('a.PNG')).toBe(true)
    expect(isImageName('a.pdf')).toBe(false)
    expect(attachmentKind('a.xlsx')).toBe('sheet')
    expect(attachmentKind('a.unknown')).toBe('file')
    expect(displayName('_attachments/2026-10/abcd1234-报告.pdf')).toBe('报告.pdf')
  })
})

describe('assetUrl · Markdown 里的相对图片地址', () => {
  const url = (collection: string, path: string) => `/api/v1/raw?${new URLSearchParams({ collection, path }).toString()}`

  it('按文件所在目录解析 ./ ../ 和裸文件名', () => {
    expect(assetUrl('./pic.png', 'proj', 'docs/guide.md')).toBe(url('proj', 'docs/pic.png'))
    expect(assetUrl('pic.png', 'proj', 'docs/guide.md')).toBe(url('proj', 'docs/pic.png'))
    expect(assetUrl('../shot.png', 'proj', 'docs/guide.md')).toBe(url('proj', 'shot.png'))
    expect(assetUrl('img/a/b.png', 'proj', 'readme.md')).toBe(url('proj', 'img/a/b.png'))
    expect(assetUrl('./a/./b/../c.png', 'proj', 'x/y.md')).toBe(url('proj', 'x/a/c.png'))
  })

  it('中文、空格和百分号编码的文件名(编码后的和没编码的都认)', () => {
    expect(assetUrl('./截图%201.png', 'proj', 'docs/手册.md')).toBe(url('proj', 'docs/截图 1.png'))
    expect(assetUrl('./截图 1.png', 'proj', 'docs/手册.md')).toBe(url('proj', 'docs/截图 1.png'))
  })

  it('查询串和锚点不带进路径', () => {
    expect(assetUrl('./pic.png?v=2#x', 'proj', 'docs/guide.md')).toBe(url('proj', 'docs/pic.png'))
  })

  it('带协议的、站点根路径、锚点、查询、空串:原样返回', () => {
    for (const href of ['https://a.com/x.png', 'data:image/png;base64,AAAA', 'blob:abc', '/api/v1/raw?collection=c&path=p', '#top', '?x=1', '', '\\server\\share\\a.png']) {
      expect(assetUrl(href, 'proj', 'docs/guide.md')).toBe(href)
    }
  })

  it('分享页用分享链接自己的原件地址;下载地址嵌进图片时换回预览地址', () => {
    const share = (c: string, p: string) => `/api/v1/share/tok/raw?${new URLSearchParams({ collection: c, path: p }).toString()}`
    expect(assetUrl('./pic.png', 'proj', 'docs/guide.md', '', share)).toBe(share('proj', 'docs/pic.png'))
    expect(assetUrl('/api/v1/download?collection=c&path=docs/pic.png', 'proj', 'docs/guide.md')).toBe(url('c', 'docs/pic.png'))
  })

  it('跑到集合外面的不解析(不替用户读集合以外的东西)', () => {
    expect(assetUrl('../../etc/passwd', 'proj', 'docs/guide.md')).toBe('../../etc/passwd')
    expect(assetUrl('../a.png', 'proj', 'guide.md')).toBe('../a.png')
  })

  it('不知道集合或文件路径时原样返回(新建笔记、没有来源的地方)', () => {
    expect(assetUrl('./pic.png', null, 'docs/guide.md')).toBe('./pic.png')
    expect(assetUrl('./pic.png', 'proj', null)).toBe('./pic.png')
    expect(assetUrl('./pic.png', 'proj', undefined)).toBe('./pic.png')
  })

  it('已经是本站原件地址的(笔记附件)不动', () => {
    const own = url('proj', '_attachments/2026-10/a-图.png')
    expect(assetUrl(own, 'proj', 'docs/guide.md')).toBe(own)
  })

  it('管理员只读查看:相对图片和已插入的原件地址都带上目标用户', () => {
    const admin = (collection: string, path: string) => `${url(collection, path)}&admin_view=usr_alice`
    expect(rawUrl('proj', 'p.png', 'usr_alice')).toBe(admin('proj', 'p.png'))
    expect(assetUrl('./pic.png', 'proj', 'docs/guide.md', 'usr_alice')).toBe(admin('proj', 'docs/pic.png'))
    const own = url('proj', '_attachments/2026-10/a-图.png')
    expect(assetUrl(own, 'proj', 'docs/guide.md', 'usr_alice')).toBe(admin('proj', '_attachments/2026-10/a-图.png'))
    // 站外地址即使指定了目标用户也原样返回
    expect(assetUrl('https://a.com/x.png', 'proj', 'docs/guide.md', 'usr_alice')).toBe('https://a.com/x.png')
  })

  it('笔记（没有文件路径）里上传的图片是 kb://集合/路径：照样换成原件地址，不留 kb:// 给浏览器（会被 CSP 拦掉成破图）', () => {
    expect(assetUrl('kb://proj_kb/_attachments/2026-11/a.png', 'proj_kb', null)).toBe(url('proj_kb', '_attachments/2026-11/a.png'))
    expect(assetUrl('kb://ext_docs/img/b.png', 'proj_kb', undefined)).toBe(url('ext_docs', 'img/b.png'))
    // 中文名（编码过的）
    expect(assetUrl('kb://proj_kb/_attachments/%E6%88%AA%E5%9B%BE.png', 'proj_kb', null)).toBe(url('proj_kb', '_attachments/截图.png'))
  })

  it('没有文件路径时，普通相对地址仍原样（无从解析），kb:// 之外的不受影响', () => {
    expect(assetUrl('./pic.png', 'proj', null)).toBe('./pic.png')
    expect(assetUrl('https://example.com/a.png', 'proj', null)).toBe('https://example.com/a.png')
    expect(assetUrl('kb://proj_kb/a.png', null, null)).toBe('kb://proj_kb/a.png')
  })
})

describe('mediaKind', () => {
  it('浏览器能直接播放的视频 / 音频认出来(不分大小写)', () => {
    for (const name of ['a.mp4', 'b.WEBM', 'c.mov']) expect(mediaKind(name), name).toBe('video')
    for (const name of ['a.mp3', 'b.WAV', 'c.m4a', 'd.flac', 'e.ogg']) expect(mediaKind(name), name).toBe('audio')
  })
  it('浏览器不认的格式、图片、文档、没有扩展名的都不是:仍是普通附件卡片', () => {
    for (const name of ['a.mkv', 'b.avi', 'c.wmv', 'd.png', 'e.pdf', 'f', 'g.mp4.txt']) expect(mediaKind(name), name).toBeNull()
  })
})

describe('imageUploadName（上传的文件是不是图片）', () => {
  it('常见图片扩展名原样保留，大小写不敏感', () => {
    expect(imageUploadName({ name: 'a.png' })).toBe('a.png')
    expect(imageUploadName({ name: 'deepseekR1.PNG' })).toBe('deepseekR1.PNG')
  })
  it('jfif 等老 JPEG 扩展名改成 jpg（服务端只给 jpg / jpeg 发 image/jpeg）', () => {
    expect(imageUploadName({ name: 'Gemini_Generated_Image_j1dwlf.jfif', type: 'image/jpeg' })).toBe('Gemini_Generated_Image_j1dwlf.jpg')
    expect(imageUploadName({ name: 'x.JFIF' })).toBe('x.jpg')
    expect(imageUploadName({ name: 'x.pjpeg' })).toBe('x.jpg')
  })
  it('文件名没有可用扩展名时看 MIME，并补上扩展名', () => {
    expect(imageUploadName({ name: 'image', type: 'image/png' })).toBe('image.png')
    expect(imageUploadName({ name: 'Screenshot 2026-11-05 17.58.12', type: 'image/jpeg' })).toBe('Screenshot 2026-11-05 17.58.12.jpg')
    expect(imageUploadName({ name: 'blob', type: 'image/svg+xml' })).toBe('blob.svg')
  })
  it('不是图片：返回 null（仍当附件）', () => {
    expect(imageUploadName({ name: '报告.pdf', type: 'application/pdf' })).toBeNull()
    expect(imageUploadName({ name: 'data', type: '' })).toBeNull()
    expect(imageUploadName({ name: 'x.heic', type: 'image/heic' })).toBeNull()
  })
})

describe('附件卡片的扩展名与说明行', () => {
  it('扩展名大写、最多 4 个字符；没有扩展名写 FILE', () => {
    expect(attachmentExt('季度报告.pdf')).toBe('PDF')
    expect(attachmentExt('data.tar.gz')).toBe('GZ')
    expect(attachmentExt('表格.xlsx')).toBe('XLSX')
    expect(attachmentExt('readme')).toBe('FILE')
    expect(attachmentExt('a.markdown')).toBe('MARK')
  })
  it('说明行：类型 · 大小；没有大小只写类型', () => {
    expect(attachmentMeta('a.pdf', '2.3 MB')).toBe('PDF · 2.3 MB')
    expect(attachmentMeta('a.pdf', '')).toBe('PDF')
    expect(attachmentMeta('a.pdf', '  ')).toBe('PDF')
  })
})
