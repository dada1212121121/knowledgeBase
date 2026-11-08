import { describe, expect, it } from 'vitest'
import { sanitizeDocHtml, sanitizeMarkdownHtml } from './sanitizeHtml'

describe('sanitizeDocHtml', () => {
  it('removes scripts, styles, frames, forms and event handlers', () => {
    const html = sanitizeDocHtml('<p onclick="x()">a</p><script>alert(1)</script><style>p{display:none}</style><iframe src="/x"></iframe><form><input></form><b>ok</b>')
    expect(html).toBe('<p>a</p><b>ok</b>')
  })
  it('strips style / class / id so documents cannot restyle or overlay the app', () => {
    expect(sanitizeDocHtml('<div class="kb-sidebar" id="x" style="position:fixed;inset:0">hi</div>')).toBe('<div>hi</div>')
  })
  it('keeps only safe link schemes and forces a new window with noopener', () => {
    const html = sanitizeDocHtml('<a href="https://a.com">a</a><a href="javascript:alert(1)">b</a><a href="mailto:x@y.z">c</a><a href="#top">d</a>')
    expect(html).toContain('<a href="https://a.com" target="_blank" rel="noopener noreferrer nofollow">a</a>')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="mailto:x@y.z"')
    expect(html).toContain('<a href="#top">d</a>')
  })
  it('keeps data: images and replaces remote ones with a visible placeholder', () => {
    const html = sanitizeDocHtml('<img src="data:image/png;base64,AAAA" alt="ok"><img src="https://evil/x.png" alt="logo">')
    expect(html).toContain('data:image/png;base64,AAAA')
    expect(html).not.toContain('evil')
    expect(html).toContain('[图片：logo]')
  })
  it('handles empty input', () => {
    expect(sanitizeDocHtml('')).toBe('')
  })
})

describe('sanitizeMarkdownHtml', () => {
  // 原在 MarkdownPreview.spec（md-editor-v3 的预览组件，已随 删除）；清洗函数本身仍是 MarkdownRead / 助手回答共用的闸门
  it('strips javascript urls that hide whitespace inside the scheme', () => {
    const html = sanitizeMarkdownHtml('<a href="java&#x09;script:alert(1)">x</a>')
    const host = document.createElement('div')
    host.innerHTML = html
    const link = host.querySelector('a')
    if (!link) return
    const protocol = new URL(link.href, 'https://kb.local/').protocol
    expect(protocol).not.toBe('javascript:')
  })
})
