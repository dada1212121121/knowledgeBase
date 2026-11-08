// 离线版指南:色板要覆盖样式表用到的每个变量(否则离线版里那部分颜色会失效成透明),
// 页面里不能有脚本和外部资源,目录里的锚点都要落在正文的标题上。
import { describe, expect, it } from 'vitest'
import GUIDE from '../../../docs/guide/USER_GUIDE.md?raw'
import GUIDE_CSS from '../styles/guide.css?raw'
import { buildStandaloneHtml, LIGHT_PALETTE } from './guideExport'
import { renderGuide } from './guideDoc'

const rendered = renderGuide(GUIDE, { resolveImage: () => 'data:image/png;base64,AAAA' })
const html = buildStandaloneHtml({ title: rendered.title, bodyHtml: rendered.html, headings: rendered.headings, articleCss: GUIDE_CSS })

describe('buildStandaloneHtml', () => {
  it('色板覆盖了 guide.css 里 var(--x) 用到的全部变量', () => {
    const used = new Set([...GUIDE_CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!))
    const defined = new Set([...LIGHT_PALETTE.matchAll(/(--[a-z0-9-]+):/g)].map((match) => match[1]!))
    expect(used.size).toBeGreaterThan(8)
    for (const name of used) expect(defined.has(name), name).toBe(true)
  })

  it('单文件:没有脚本,也不引用外部资源(图片全部内嵌)', () => {
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/(?:src|href)="https?:/i)
    expect(html).not.toMatch(/src="(?!data:)/)
    expect(html).toContain('src="data:image/png;base64,AAAA"')
  })

  it('标题只出现一次(封面里的),目录里的每个锚点都落在正文的标题上', () => {
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    const ids = new Set([...html.matchAll(/<h[23] id="([^"]+)"/g)].map((match) => match[1]!))
    const links = [...html.matchAll(/<li class="[^"]*"><a href="#([^"]+)">/g)].map((match) => match[1]!)
    expect(links.length).toBe(rendered.headings.length)
    for (const id of links) expect(ids.has(id), id).toBe(true)
  })

  it('页面语言和编码声明齐全(中文在没有网络的机器上也能正确显示)', () => {
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<meta charset="utf-8">')
  })

  it('目录里的文字会转义', () => {
    const out = buildStandaloneHtml({ title: 'a<b', bodyHtml: '', headings: [{ id: 'x', level: 2, text: '<i>' }], articleCss: '' })
    expect(out).toContain('<title>a&lt;b</title>')
    expect(out).toContain('&lt;i&gt;')
  })
})
