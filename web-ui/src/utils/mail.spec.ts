import { describe, expect, it } from 'vitest'
import { decodeWords, parseEml, parseMbox } from './mail'

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
const latin1 = (text: string) => String.fromCharCode(...new TextEncoder().encode(text))

describe('decodeWords', () => {
  it('decodes B and Q encoded words in any charset and joins adjacent words', () => {
    expect(decodeWords(`=?utf-8?B?${b64('周会纪要')}?=`)).toBe('周会纪要')
    expect(decodeWords('=?gb2312?B?1ty74Q==?=')).toBe('周会')
    expect(decodeWords('=?utf-8?Q?caf=C3=A9_menu?=')).toBe('café menu')
    expect(decodeWords(`=?utf-8?B?${b64('你')}?= =?utf-8?B?${b64('好')}?=`)).toBe('你好')
    expect(decodeWords('plain subject')).toBe('plain subject')
  })
})

describe('parseEml', () => {
  it('reads headers and a plain-text body', () => {
    const mail = parseEml('From: A <a@x.com>\r\nTo: b@y.com\r\nSubject: Hi\r\nDate: Mon, 26 Oct 2026 10:00:00 +0800\r\n\r\nhello\r\nworld')
    expect(mail).toMatchObject({ subject: 'Hi', from: 'A <a@x.com>', to: 'b@y.com', date: 'Mon, 26 Oct 2026 10:00:00 +0800', text: 'hello\r\nworld', html: '' })
  })
  it('unfolds headers and decodes utf-8 base64 bodies', () => {
    const mail = parseEml(
      `Subject: =?utf-8?B?${b64('长主题')}?=\r\n continued\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64('正文内容')}`,
    )
    expect(mail.subject).toBe('长主题 continued')
    expect(mail.text).toBe('正文内容')
  })
  it('decodes quoted-printable in a non-utf8 charset', () => {
    const mail = parseEml('Content-Type: text/plain; charset=gbk\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=C4=E3=BA=C3=\r\n!')
    expect(mail.text).toBe('你好!')
  })
  it('walks multipart/alternative, preferring to keep both bodies', () => {
    const raw =
      'Content-Type: multipart/alternative; boundary="B1"\r\n\r\n--B1\r\nContent-Type: text/plain\r\n\r\nplain body\r\n--B1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>html body</p>\r\n--B1--\r\n'
    const mail = parseEml(raw)
    expect(mail.text.trim()).toBe('plain body')
    expect(mail.html.trim()).toBe('<p>html body</p>')
  })
  it('lists attachments (with RFC 2231 names) and inlines cid images', () => {
    const png = 'iVBORw0KGgo='
    const raw = [
      'Content-Type: multipart/mixed; boundary="M"',
      '',
      '--M',
      'Content-Type: multipart/related; boundary="R"',
      '',
      '--R',
      'Content-Type: text/html',
      '',
      '<img src="cid:logo@x"> hi',
      '--R',
      'Content-Type: image/png',
      'Content-ID: <logo@x>',
      'Content-Transfer-Encoding: base64',
      '',
      png,
      '--R--',
      '--M',
      'Content-Type: application/pdf; name="r.pdf"',
      "Content-Disposition: attachment; filename*=utf-8''%E6%8A%A5%E5%91%8A.pdf",
      'Content-Transfer-Encoding: base64',
      '',
      b64('PDFDATA'),
      '--M--',
      '',
    ].join('\r\n')
    const mail = parseEml(raw)
    expect(mail.html).toContain(`src="data:image/png;base64,${png}"`)
    expect(mail.attachments).toEqual([{ name: '报告.pdf', type: 'application/pdf', size: 7 }])
  })
  it('accepts raw bytes and survives garbage', () => {
    expect(parseEml(new TextEncoder().encode('Subject: x\r\n\r\nbody')).subject).toBe('x')
    expect(() => parseEml('')).not.toThrow()
    expect(() => parseEml(latin1('Content-Type: multipart/mixed; boundary=\r\n\r\n--'))).not.toThrow()
  })
})

describe('parseMbox', () => {
  it('splits messages on From lines and unescapes >From', () => {
    const mails = parseMbox('From a@x Mon Oct 26 10:00:00 2026\nSubject: one\n\nfirst\n>From inside\n\nFrom b@y Mon Oct 26 11:00:00 2026\nSubject: two\n\nsecond\n')
    expect(mails.map((mail) => mail.subject)).toEqual(['one', 'two'])
    expect(mails[0]!.text).toContain('From inside')
  })
})
