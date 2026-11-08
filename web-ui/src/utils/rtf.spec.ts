import { describe, expect, it } from 'vitest'
import { rtfToHtml } from './rtf'

describe('rtfToHtml', () => {
  it('turns paragraphs and inline formatting into html', () => {
    const html = rtfToHtml('{\\rtf1\\ansi {\\fonttbl{\\f0 Arial;}}Hello {\\b bold} and {\\i italic}\\par Second {\\ul under}\\par}')
    expect(html).toBe('<p>Hello <b>bold</b> and <i>italic</i></p>\n<p>Second <u>under</u></p>')
  })
  it('skips font tables, colour tables, stylesheets and ignorable destinations', () => {
    const html = rtfToHtml('{\\rtf1{\\fonttbl{\\f0 Times;}}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\generator Word}{\\info{\\title X}}visible\\par}')
    expect(html).toBe('<p>visible</p>')
  })
  it('decodes code-page bytes (GBK) and unicode escapes with the skip count', () => {
    expect(rtfToHtml("{\\rtf1\\ansi\\ansicpg936 \\'c4\\'e3\\'ba\\'c3\\par}")).toBe('<p>你好</p>')
    expect(rtfToHtml('{\\rtf1\\ansi\\uc1 \\u20320?\\u22909?\\par}')).toBe('<p>你好</p>')
    expect(rtfToHtml('{\\rtf1\\ansi\\uc1 \\u-10179?\\par}')).toBe(`<p>${String.fromCharCode(-10179 + 65536)}</p>`)
  })
  it('escapes html in the source text', () => {
    expect(rtfToHtml('{\\rtf1 a <script>alert(1)</script> & b\\par}')).toBe('<p>a &lt;script&gt;alert(1)&lt;/script&gt; &amp; b</p>')
  })
  it('supports escaped braces, backslashes, line breaks, tabs and typographic symbols', () => {
    expect(rtfToHtml('{\\rtf1 a\\{b\\}c\\\\d\\line e\\tab f\\emdash g\\par}')).toBe('<p>a{b}c\\d<br>e    f—g</p>')
  })
  it('builds tables from trowd / cell / row', () => {
    const html = rtfToHtml('{\\rtf1 before\\par\\trowd\\cellx1000 A\\cell B\\cell\\row\\trowd C\\cell D\\cell\\row after\\par}')
    expect(html).toBe('<p>before</p>\n<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>\n<p>after</p>')
  })
  it('drops embedded pictures', () => {
    expect(rtfToHtml('{\\rtf1 x{\\pict\\pngblip 89504e47}y\\par}')).toBe('<p>xy</p>')
  })
  it('never throws on truncated input', () => {
    expect(() => rtfToHtml('{\\rtf1 {\\b open')).not.toThrow()
    expect(() => rtfToHtml('\\')).not.toThrow()
    expect(rtfToHtml('')).toBe('')
  })
})
