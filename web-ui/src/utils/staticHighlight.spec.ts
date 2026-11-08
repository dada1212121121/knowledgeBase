import { describe, expect, it } from 'vitest'
import { highlightToHtml } from './staticHighlight'

describe('highlightToHtml', () => {
  it('wraps tokens in tok-* classes and escapes everything', async () => {
    const html = await highlightToHtml('let a = "<x>"; // c', 'x.js')
    expect(html).toContain('class="tok-keyword"')
    expect(html).toContain('class="tok-string"')
    expect(html).toContain('&lt;x&gt;')
    expect(html).not.toContain('<x>')
    expect(html.replace(/<[^>]+>/g, '')).toBe('let a = "&lt;x&gt;"; // c')
  })
  it('only escapes when the language is unknown or the input is huge', async () => {
    expect(await highlightToHtml('a < b', 'notes.unknownext')).toBe('a &lt; b')
    expect((await highlightToHtml('x'.repeat(200_001), 'a.js')).length).toBe(200_001)
  })
})
