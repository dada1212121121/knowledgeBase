import { describe, expect, it } from 'vitest'
import { blocksToHtml, mailToHtml, pptSlidesToSections } from './docHtml'

describe('docHtml', () => {
  it('renders paragraphs and tables with escaping, skipping blank paragraphs', () => {
    expect(
      blocksToHtml([
        { kind: 'p', text: 'a<b>\nc' },
        { kind: 'p', text: '  ' },
        { kind: 'table', rows: [['x', '1&2']] },
      ]),
    ).toBe('<p>a&lt;b&gt;<br>c</p>\n\n<table><tr><td>x</td><td>1&amp;2</td></tr></table>')
  })
  it('turns slides into sections with notes in a quote', () => {
    const sections = pptSlidesToSections([
      { title: '路线图', body: ['批次 1'], notes: ['先讲'] },
      { title: '', body: [], notes: [] },
    ])
    expect(sections[0]).toEqual({ title: '路线图', html: '<h2>路线图</h2><p>批次 1</p><hr><blockquote><p><b>演讲者备注</b></p><p>先讲</p></blockquote>' })
    expect(sections[1]!.title).toBe('第 2 张')
  })
  it('builds a mail view from html or text and lists attachments', () => {
    const base = { subject: '周会 <1>', from: 'a@x', to: 'b@y', cc: '', date: '', html: '', text: '第一段\n仍是第一段\n\n第二段', attachments: [{ name: '报告.pdf', type: 'application/pdf', size: 2048 }] }
    const html = mailToHtml(base)
    expect(html).toContain('<h2>周会 &lt;1&gt;</h2>')
    expect(html).toContain('<p>第一段<br>仍是第一段</p><p>第二段</p>')
    expect(html).toContain('<li>报告.pdf（2.0 KB）</li>')
    expect(html).not.toContain('抄送')
    expect(mailToHtml({ ...base, html: '<p>H</p>', text: '' })).toContain('<p>H</p>')
    expect(mailToHtml({ ...base, text: '', attachments: [] })).toContain('邮件没有正文')
  })
})
