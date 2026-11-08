// 使用指南(docs/guide/USER_GUIDE.md)的渲染:网页里的「使用指南」页、离线 HTML、PDF 三处共用这一份,
// 内容只维护一份 Markdown,三个出口不会各说各话。纯函数,不碰 DOM,方便单测,也能在 Node 里(vite-node)直接跑。
import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'

export interface GuideHeading {
  id: string
  level: 2 | 3
  text: string
}

export interface GuideRenderOptions {
  /** AI 总开关。关掉时 `::: ai` 块整段去掉:术语表规定 AI 关闭后全站不出现 AI 相关的字样。默认 true */
  ai?: boolean
  /** 相对图片路径(`img/x.png`)的前缀。网页里是 `/guide/`;离线 HTML 用 resolveImage 换成内嵌图片 */
  imageBase?: string
  /** 完全自定义图片地址(优先于 imageBase);离线 HTML 用它把图片内嵌成 data URL */
  resolveImage?: (src: string) => string
}

export interface RenderedGuide {
  html: string
  /** 第一个一级标题 */
  title: string
  /** 目录:二、三级标题 */
  headings: GuideHeading[]
}

/** 网页里下载按钮指向的文件。磁盘上用 ASCII 文件名:内置静态服务按百分号编码的路径查文件,中文名会找不到。 */
export const GUIDE_FILES = {
  pdf: '/guide/knowledgeBase-user-guide.pdf',
  html: '/guide/knowledgeBase-user-guide.html',
} as const

/** 用户保存下来的文件名(`<a download>` 指定,同源时浏览器会采用)。 */
export const GUIDE_DOWNLOAD_NAMES = {
  pdf: 'knowledgeBase-用户操作指南.pdf',
  html: 'knowledgeBase-用户操作指南.html',
} as const

const FENCE = /^\s*(```|~~~)/

/**
 * 处理 `::: ai … :::` 块:AI 开着只去掉标记行,关着整块(含标记)去掉。
 * 代码块里的 `:::` 不是标记。块没闭合直接报错:静默吞掉后面的全部内容,比构建失败更难发现。
 */
export function stripAiBlocks(source: string, ai: boolean): string {
  const out: string[] = []
  let inFence = false
  let inAi = false
  for (const line of source.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence
    const mark = inFence ? '' : line.trim()
    if (!inAi && mark === '::: ai') {
      inAi = true
      continue
    }
    if (inAi && mark === ':::') {
      inAi = false
      continue
    }
    if (inAi && !ai) continue
    out.push(line)
  }
  if (inAi) throw new Error('指南里有没闭合的 ::: ai 块')
  return out.join('\n')
}

const ID_SUFFIX = /\s*\{#([A-Za-z0-9_-]+)\}\s*$/

/** 标题里去掉行内标记,只留给目录显示的纯文字 */
const plain = (text: string) => text.replace(/[`*_]/g, '').trim()

interface RenderEnv {
  options: GuideRenderOptions
  headings: GuideHeading[]
  title: string
}

function build(): MarkdownIt {
  // html: false(默认):源文里的任何原始 HTML 都按文字显示,不会进到页面里
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false })

  // 标题的显式锚点 `## 标题 {#id}`。放在 block 之后、inline 之前:这时标题内容还是一整段文字,
  // 切掉后缀再做行内解析,`{`、`}` 就不会被拆成几个文字节点
  md.core.ruler.after('block', 'guide_heading_ids', (state) => {
    const env = state.env as RenderEnv
    const used = new Set<string>()
    let auto = 0
    state.tokens.forEach((token, index) => {
      if (token.type !== 'heading_open') return
      const inline = state.tokens[index + 1]
      if (!inline || inline.type !== 'inline') return
      const found = ID_SUFFIX.exec(inline.content)
      if (found) inline.content = inline.content.replace(ID_SUFFIX, '')
      let id = found?.[1] ?? `sec-${(auto += 1)}`
      for (let n = 2; used.has(id); n += 1) id = `${found?.[1] ?? 'sec'}-${n}`
      used.add(id)
      token.attrSet('id', id)
      const level = Number(token.tag.slice(1))
      if (level === 1 && !env.title) env.title = plain(inline.content)
      if (level === 2 || level === 3) env.headings.push({ id, level, text: plain(inline.content) })
    })
  })

  md.core.ruler.after('inline', 'guide_blocks', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i] as Token
      // 只含一张图的段落:图片自己会变成 <figure>,外面不能再套 <p>
      if (token.type === 'paragraph_open') {
        const inline = tokens[i + 1]
        const close = tokens[i + 2]
        if (inline?.children?.length === 1 && inline.children[0]?.type === 'image' && close?.type === 'paragraph_close') {
          token.hidden = true
          close.hidden = true
        }
      }
      // 以「提示」「注意」加粗开头的引用块,画成提示框
      if (token.type === 'blockquote_open') {
        const text = tokens[i + 2]?.content ?? ''
        if (text.startsWith('**提示**')) token.attrJoin('class', 'kb-guide-note is-tip')
        else if (text.startsWith('**注意**')) token.attrJoin('class', 'kb-guide-note is-warn')
      }
    }
  })

  md.renderer.rules.image = (tokens, index, _options, env: RenderEnv) => {
    const token = tokens[index] as Token
    const src = token.attrGet('src') ?? ''
    const { resolveImage, imageBase = '/guide/' } = env.options
    const url = resolveImage ? resolveImage(src) : /^(?:[a-z]+:|\/)/i.test(src) ? src : `${imageBase}${src}`
    const alt = md.utils.escapeHtml(token.content)
    // 手机截图(文件名 phone-…)是 390 宽的竖图,拉伸到整栏宽度会比一页还高:样式里按手机的宽度显示
    const phone = /(?:^|\/)phone-[^/]*$/.test(src) ? ' is-phone' : ''
    return `<figure class="kb-guide-fig${phone}"><img src="${md.utils.escapeHtml(url)}" alt="${alt}" loading="lazy"><figcaption>${alt}</figcaption></figure>`
  }

  // 表格可能比屏幕宽(手机上尤其),放进自己的横向滚动容器,页面本身不出现横向滚动条
  // 能横向滚动的容器必须能被键盘聚焦(axe scrollable-region-focusable):否则只用键盘的人够不到被截掉的列;
  // 可聚焦的区域要有名字,所以带 role=region 和 aria-label
  md.renderer.rules.table_open = () => '<div class="kb-guide-table" tabindex="0" role="region" aria-label="表格,可左右滚动查看"><table>'
  md.renderer.rules.table_close = () => '</table></div>'

  // 代码块同理:太长的行在 <pre> 里横向滚动,给它 tabindex
  const focusablePre = (rule: ((...args: Parameters<NonNullable<typeof md.renderer.rules.fence>>) => string) | undefined) =>
    (...args: Parameters<NonNullable<typeof md.renderer.rules.fence>>) =>
      (rule ? rule(...args) : args[4].renderToken(args[0], args[1], args[2])).replace(/^<pre/, '<pre tabindex="0"')
  md.renderer.rules.fence = focusablePre(md.renderer.rules.fence)
  md.renderer.rules.code_block = focusablePre(md.renderer.rules.code_block)

  const baseLink = md.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index] as Token
    if (/^https?:\/\//i.test(token.attrGet('href') ?? '')) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    }
    return baseLink(tokens, index, options, env, self)
  }
  return md
}

let renderer: MarkdownIt | null = null

export function renderGuide(source: string, options: GuideRenderOptions = {}): RenderedGuide {
  renderer ??= build()
  const env: RenderEnv = { options, headings: [], title: '' }
  const html = renderer.render(stripAiBlocks(source, options.ai !== false), env)
  return { html, title: env.title, headings: env.headings }
}
