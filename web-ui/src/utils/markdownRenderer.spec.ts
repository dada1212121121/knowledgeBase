// 阅读态 Markdown 的分段输出：必须和整篇一次渲染逐字相同，标题表必须和渲染后的标题一致。
import { describe, expect, it } from 'vitest'
import { createMarkdownRenderer, renderMarkdownChunks } from './markdownRenderer'

const md = createMarkdownRenderer()

/** 覆盖跨块语义的样本：引用式链接定义在文末、松散列表、嵌套列表、引用里的标题、围栏代码里像标题的行、表格、公式块、分割线 */
const SAMPLE = [
  '# 一级 [引用][ref]',
  '',
  '段落一，带 **加粗** 和 `行内代码`，还有[文末定义的链接][later]。',
  '',
  '1. 松散列表第一项',
  '',
  '   续段落',
  '',
  '2. 第二项',
  '   - 嵌套甲',
  '   - 嵌套乙',
  '',
  '> 引用里的标题',
  '> ## 引用内二级',
  '> 引用正文',
  '',
  '```md',
  '# 代码块里的井号不是标题',
  '```',
  '',
  '| 列 | 值 |',
  '|---|---|',
  '| a | 1 |',
  '',
  '$$',
  'a+b',
  '$$',
  '',
  '---',
  '',
  '### 三级 `代码` 与 $x^2$',
  '',
  '最后一段。',
  '',
  '[ref]: https://example.com/ref',
  '[later]: https://example.com/later "标题"',
].join('\n')

describe('阅读态颜色 span', () => {
  it('常用色走主题 class，自定义色写内联 style，嵌套与配对正常', () => {
    const html = md.render('A <span style="color: #E5484D">红</span> B <span style="background-color: #123456">底</span> C <span style="color: #e5484d"><span style="background-color: #fff3a3">红底</span></span>')
    expect(html).toContain('<span class="kb-color is-fg-red">红</span>')
    expect(html).toContain('<span class="kb-color is-custom" style="background-color: #123456">底</span>')
    expect(html).toContain('<span class="kb-color is-fg-red"><span class="kb-color is-bg-yellow">红底</span></span>')
  })

  it('只放行颜色 / 字体子集：额外样式、孤立闭标签、其他 HTML 都按文本转义', () => {
    const html = md.render('前 </span> 后 <span style="color: #fff; position: fixed">x</span> <span onclick="x()">y</span>')
    expect(html).toContain('&lt;/span&gt;')
    expect(html).toContain('&lt;span style=&quot;color: #fff; position: fixed&quot;&gt;x&lt;/span&gt;')
    expect(html).toContain('&lt;span onclick=&quot;x()&quot;&gt;y&lt;/span&gt;')
    expect(html).not.toMatch(/<span style="color: #fff; position/)
  })
})

describe('renderMarkdownChunks', () => {
  it('分段拼回去与整篇渲染逐字相同（含文末才定义的引用式链接、松散列表、嵌套）', () => {
    const whole = md.render(SAMPLE)
    for (const target of [1, 40, 300, 3000, 1_000_000]) {
      const { chunks } = renderMarkdownChunks(md, SAMPLE, target)
      expect(chunks.join('')).toBe(whole)
    }
    // 引用式链接定义在文末，前面的段也认得（整篇只解析一次）
    expect(renderMarkdownChunks(md, SAMPLE, 1).chunks[0]).toContain('href="https://example.com/ref"')
  })

  it('只在顶层块边界切：目标很小时每个顶层块一段，嵌套内容不被切开', () => {
    const { chunks } = renderMarkdownChunks(md, SAMPLE, 1)
    // 列表（含松散的续段落和嵌套）、引用（含里面的标题）各自是完整的一段
    const list = chunks.find((chunk) => chunk.includes('松散列表第一项'))!
    expect(list).toContain('嵌套乙')
    expect(list.trimEnd().endsWith('</ol>')).toBe(true)
    const quote = chunks.find((chunk) => chunk.includes('引用内二级'))!
    expect(quote).toContain('引用正文')
    expect(quote.trimEnd().endsWith('</blockquote>')).toBe(true)
  })

  it('标题表：含嵌在引用里的标题，代码块里的井号不算；文字口径和渲染后的 DOM 一致', () => {
    const { headings } = renderMarkdownChunks(md, SAMPLE)
    expect(headings).toEqual([
      { level: 1, text: '一级 引用' },
      { level: 2, text: '引用内二级' },
      { level: 3, text: '三级 代码 与 x^2' },
    ])
    const dom = document.createElement('div')
    dom.innerHTML = md.render(SAMPLE)
    const rendered = [...dom.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((node) => ({ level: Number(node.tagName.slice(1)), text: (node.textContent ?? '').trim() }))
    expect(headings).toEqual(rendered)
  })

  it('headingsThrough 单调，最后一项等于标题总数，且第 n 个标题确实落在 headingsThrough 首次 > n 的那一段里', () => {
    const { chunks, headings, headingsThrough } = renderMarkdownChunks(md, SAMPLE, 1)
    expect(headingsThrough).toHaveLength(chunks.length)
    expect(headingsThrough.at(-1)).toBe(headings.length)
    for (let at = 1; at < headingsThrough.length; at += 1) expect(headingsThrough[at]!).toBeGreaterThanOrEqual(headingsThrough[at - 1]!)
    headings.forEach((heading, index) => {
      const chunkIndex = headingsThrough.findIndex((count) => count > index)
      expect(chunks[chunkIndex]).toContain(`<h${heading.level}`)
    })
  })

  it('空文档没有段', () => {
    expect(renderMarkdownChunks(md, '')).toEqual({ chunks: [], headings: [], headingsThrough: [] })
  })

  it('原始 HTML 不开：<script> 被转义成文字，和阅读态的硬边界一致', () => {
    const { chunks } = renderMarkdownChunks(md, '<script>alert(1)</script>\n\n正文')
    expect(chunks.join('')).not.toContain('<script>')
  })
})
