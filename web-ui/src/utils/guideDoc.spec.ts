// 使用指南的渲染与内容守卫:
//   - 渲染:显式锚点、AI 块开关、图片变 <figure>、原始 HTML 不会进页面;
//   - 内容:工具表和 Rust 源码里 MCP 可见的能力一致、文内链接都能落到标题、没有疑似真实令牌或真实域名。
import { describe, expect, it } from 'vitest'
import GUIDE from '../../../docs/guide/USER_GUIDE.md?raw'
import { renderGuide, stripAiBlocks } from './guideDoc'

// 能力注册已按域拆到 defs/register/ 目录,拼接全部源文件后再做静态检查。
const RUST_CAPABILITIES = Object.values(
  import.meta.glob('../../../crates/kb-capability/src/defs/register/**/*.rs', { eager: true, query: '?raw', import: 'default' }),
).join('\n')

describe('stripAiBlocks', () => {
  const doc = ['前', '::: ai', '助手内容', ':::', '后'].join('\n')

  it('AI 开着:只去掉标记行,内容保留', () => {
    expect(stripAiBlocks(doc, true).split('\n')).toEqual(['前', '助手内容', '后'])
  })

  it('AI 关着:整块(含标记)去掉', () => {
    expect(stripAiBlocks(doc, false).split('\n')).toEqual(['前', '后'])
  })

  it('代码块里的 ::: 不是标记', () => {
    const fenced = ['```', '::: ai', '```', '正文'].join('\n')
    expect(stripAiBlocks(fenced, false)).toBe(fenced)
  })

  it('没闭合直接报错,不静默吞掉后面的内容', () => {
    expect(() => stripAiBlocks('::: ai\n内容', true)).toThrow('没闭合')
  })
})

describe('renderGuide', () => {
  it('标题的显式锚点:写进 id、不出现在文字里,并进入目录(只收二三级)', () => {
    const out = renderGuide('# 总标题 {#top}\n\n## 第一节 {#one}\n\n### 小节 {#one-a}\n\n#### 更细 {#deep}')
    expect(out.html).toContain('<h2 id="one">第一节</h2>')
    expect(out.html).not.toContain('{#')
    expect(out.title).toBe('总标题')
    expect(out.headings).toEqual([
      { id: 'one', level: 2, text: '第一节' },
      { id: 'one-a', level: 3, text: '小节' },
    ])
  })

  it('没写锚点的标题自动编号;重复的 id 自动加后缀,保证页内唯一', () => {
    const out = renderGuide('## 甲\n\n## 乙 {#same}\n\n## 丙 {#same}')
    const ids = out.headings.map((item) => item.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids[0]).toMatch(/^sec-\d+$/)
    expect(ids[2]).toBe('same-2')
  })

  it('图片变成 <figure>,说明文字就是图注;只含一张图的段落不再套 <p>', () => {
    const out = renderGuide('![令牌卡片](img/token-card.png)')
    expect(out.html).toContain('<figure class="kb-guide-fig"><img src="/guide/img/token-card.png" alt="令牌卡片"')
    expect(out.html).toContain('<figcaption>令牌卡片</figcaption>')
    expect(out.html).not.toContain('<p>')
  })

  it('图片地址:可换前缀、可完全自定义(离线 HTML 内嵌),绝对地址原样保留', () => {
    expect(renderGuide('![a](img/x.png)', { imageBase: '/static/' }).html).toContain('src="/static/img/x.png"')
    expect(renderGuide('![a](img/x.png)', { resolveImage: () => 'data:image/png;base64,AAA' }).html).toContain('src="data:image/png;base64,AAA"')
    expect(renderGuide('![a](/abs/x.png)').html).toContain('src="/abs/x.png"')
  })

  it('手机截图(phone-…)带 is-phone,按手机宽度显示;其它截图不带', () => {
    expect(renderGuide('![a](img/phone-mine.png)').html).toContain('class="kb-guide-fig is-phone"')
    expect(renderGuide('![a](img/token-card.png)').html).toContain('class="kb-guide-fig"')
    expect(renderGuide('![a](img/not-phone-x.png)').html).not.toContain('is-phone')
  })

  it('图片的说明文字会转义,不能借它塞进标签', () => {
    const out = renderGuide('![a"><script>x</script>](img/x.png)')
    expect(out.html).not.toContain('<script>')
  })

  it('源文里的原始 HTML 按文字显示,不进页面', () => {
    const out = renderGuide('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(out.html).not.toContain('<script>')
    expect(out.html).not.toContain('<img src=x')
  })

  it('能横向滚动的表格和代码块可以被键盘聚焦,表格区域有名字', () => {
    const table = renderGuide('| a |\n|---|\n| b |').html
    expect(table).toContain('class="kb-guide-table" tabindex="0" role="region" aria-label="表格,可左右滚动查看"')
    expect(renderGuide('```bash\nls\n```').html).toMatch(/^<pre tabindex="0"><code class="language-bash">/)
    expect(renderGuide('    indented code').html).toMatch(/^<pre tabindex="0"><code>/)
  })

  it('以「提示」「注意」开头的引用块带上对应的样式类', () => {
    expect(renderGuide('> **提示** 内容').html).toContain('class="kb-guide-note is-tip"')
    expect(renderGuide('> **注意** 内容').html).toContain('class="kb-guide-note is-warn"')
    expect(renderGuide('> 普通引用').html).not.toContain('kb-guide-note')
  })

  it('表格放进自己的横向滚动容器;外链新窗口打开并带 noopener', () => {
    expect(renderGuide('| a |\n|---|\n| b |').html).toMatch(/<div class="kb-guide-table"[^>]*><table>/)
    const link = renderGuide('[官网](https://example.com/)').html
    expect(link).toContain('target="_blank"')
    expect(link).toContain('rel="noopener noreferrer"')
    expect(renderGuide('[本页](#top)').html).not.toContain('target=')
  })
})

describe('指南内容守卫', () => {
  const rendered = renderGuide(GUIDE)
  const ids = new Set(rendered.headings.map((item) => item.id))

  it('文内的 (#锚点) 链接都能落到一个标题上', () => {
    const targets = [...GUIDE.matchAll(/\]\(#([A-Za-z0-9_-]+)\)/g)].map((match) => match[1]!)
    expect(targets.length).toBeGreaterThan(3)
    for (const target of targets) expect(target === 'top' || ids.has(target), `#${target}`).toBe(true)
  })

  it('二三级标题都写了显式锚点(链接和目录靠它稳定,不依赖自动编号)', () => {
    for (const heading of rendered.headings) expect(heading.id, heading.text).not.toMatch(/^sec-\d+$/)
  })

  it('MCP 工具表和 Rust 源码里「网络连接(/mcp)能用」的能力完全一致', () => {
    // 按注册块取,不按行正则:有的 description 是几行拼起来的,逐行匹配会漏掉这些能力
    const exposed = RUST_CAPABILITIES.split('registry.register(Capability {')
      .slice(1)
      .flatMap((block) => {
        const name = block.match(/name: "([a-z_]+)"/)?.[1]
        const surfaces = block.match(/surfaces: (\w+)/)?.[1] ?? ''
        return name && surfaces.includes('MCP') ? [name] : []
      })
      .sort()
    const section = GUIDE.slice(GUIDE.indexOf('### 4.5'), GUIDE.indexOf('### 4.6'))
    const documented = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]!).sort()
    // 表格里连 agent_history 一起列(它只在本机 stdio 连接里出现,正文有说明)
    expect(documented).toEqual(exposed)
  })

  it('指南引用的每张截图都存在,目录里也没有没人引用的图', () => {
    const files = Object.keys(import.meta.glob('../../public/guide/img/*.png')).map((path) => path.split('/').pop()!)
    const used = [...GUIDE.matchAll(/\]\(img\/([A-Za-z0-9_-]+\.png)\)/g)].map((match) => match[1]!)
    expect(used.length).toBeGreaterThan(10)
    for (const name of used) expect(files, `缺少截图 ${name}(运行 node e2e/guide-shots.mjs 生成)`).toContain(name)
    for (const name of files) expect(used, `${name} 没有被指南引用`).toContain(name)
  })

  it('每张图的说明文字里都有编号图例(①②…),读者才知道红色数字对应什么', () => {
    const alts = [...GUIDE.matchAll(/!\[([^\]]*)\]\(img\//g)].map((match) => match[1]!)
    for (const alt of alts) expect(alt, alt).toMatch(/①/)
  })

  it('没有疑似真实令牌,链接里的服务地址都是占位符', () => {
    expect(GUIDE).not.toMatch(/kb_[A-Za-z0-9_-]{16,}/)
    for (const url of GUIDE.match(/https?:\/\/[^\s)`'"]+/g) ?? []) {
      expect(url, url).toMatch(/^https?:\/\/<你的知识库地址>/)
    }
  })

  it('AI 总开关关闭时,正文里不出现「AI」字样', () => {
    const off = renderGuide(GUIDE, { ai: false })
    const text = off.html.replace(/<[^>]*>/g, ' ')
    expect(text).not.toMatch(/AI/)
    // 开着的时候这些内容是在的,说明上面的断言不是因为整段都没渲染出来
    expect(renderGuide(GUIDE, { ai: true }).html).toContain('内置助手')
    expect(off.html).not.toContain('内置助手')
  })
})
