// 阅读态 Markdown 的解析器配置 + 「按顶层块分段输出 HTML」。
//
// 为什么单独成文件：MarkdownRead.vue（主线程，小文档同步渲染）和 markdownChunks.worker.ts（大文档在 Worker 里解析）
// 必须用**同一套**解析规则，否则同一篇笔记会因为文档大小不同而渲染得不一样。这里不依赖 DOM / Vue，Worker 里可以直接用。
//
// 为什么分段：200 KB 的笔记整篇解析 + 清洗 + 插入 DOM + 布局是一条 300~400 ms 的长任务（4× 降速实测）。
// 解析放进 Worker 之后，主线程只剩「清洗一段、插入一段」，每段都很小，段与段之间让出主线程。
// 分段发生在 token 流上（整篇只解析一次），所以引用式链接定义、松散列表这类跨块语义和整篇渲染完全一致，
// 不会因为在源码上硬切而出错。
import MarkdownIt, { type StateInline } from 'markdown-it'
import { mathPlugin } from '@/utils/markdownMath'
import { colorHex, isHexColor, parsePaletteSpan } from '@/utils/colorPalette'

export interface MarkdownHeading {
  level: number
  text: string
}

export interface MarkdownChunks {
  /** 按顶层块切开的 HTML，依次拼接 = 整篇 `md.render(source)` 的结果 */
  chunks: string[]
  /** 文档里全部标题（含嵌在列表 / 引用里的），文档顺序 */
  headings: MarkdownHeading[]
  /** 到第 i 段为止（含）累计有多少个标题：跳到第 n 个标题时据此算出要先渲染到哪一段 */
  headingsThrough: number[]
}

/**
 * 颜色 / 字体 span（编辑器写进 Markdown 的 `<span style="color: #rrggbb">…</span>`）。
 *
 * 阅读态 `html: false` 是安全底线，不能为了颜色把原始 HTML 全开；这里只认编辑器和调色板写出的
 * 那一种极少量的 span（属性、颜色值都受 `parsePaletteSpan` 白名单约束），其余 HTML 照旧按文本转义。
 * 常用色仍用 `is-fg-*` / `is-bg-*` class（深浅色主题各取合适值），自定义色 / 字体写内联 style。
 */
function colorSpanRule(state: StateInline, silent: boolean): boolean {
  const source = state.src
  if (source.charCodeAt(state.pos) !== 0x3c /* < */) return false
  // 取到当前标签的 '>' 为止，交给与编辑器共用的 parsePaletteSpan 判断；不自己再写一份正则
  const end = source.indexOf('>', state.pos)
  if (end < 0) return false
  const tag = source.slice(state.pos, end + 1)
  const parsed = parsePaletteSpan(tag)
  const closing = /^<\/span\s*>$/i.test(tag)
  if (!parsed && !closing) return false

  if (closing) {
    let depth = 0
    for (const token of state.tokens) {
      if (token.type === 'kb_color_open') depth += 1
      else if (token.type === 'kb_color_close') depth -= 1
    }
    // 没有配对的开始标签：按普通文本转义，别放一个孤立的 </span> 进正文
    if (depth <= 0) return false
    if (silent) return true
    state.push('kb_color_close', 'span', -1)
    state.pos = end + 1
    return true
  }

  if (!parsed) return false
  if (silent) return true
  const token = state.push('kb_color_open', 'span', 1)
  const { prop, key } = parsed
  if (prop === 'font-family') {
    token.attrSet('style', `font-family: ${colorHex(prop, key) ?? ''}`)
  } else if (isHexColor(key)) {
    // 自定义色：key 本身就是 hex，直接内联（常用色走 class，才能随主题换对比合适的值）
    token.attrSet('class', 'kb-color is-custom')
    token.attrSet('style', `${prop}: ${colorHex(prop, key)}`)
  } else {
    token.attrSet('class', `kb-color is-${prop === 'color' ? 'fg' : 'bg'}-${key}`)
  }
  state.pos = end + 1
  return true
}

/** 阅读态的解析器：原始 HTML 一律不开，公式只做占位，`kb://` 协议放行（再由 resolveDocHref 校验） */
export function createMarkdownRenderer(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: false })
  md.use(mathPlugin)
  // 放在 html_inline 前：html_inline 在 html:false 时会被关闭，但颜色 span 是编辑器自己写的安全子集
  md.inline.ruler.before('html_inline', 'kb_color_span', colorSpanRule)
  // markdown-it 默认只放行 http(s)/mailto/ftp/相对地址，会把 `kb://` 协议连同 href 一起丢掉；
  // 知识库自己的协议由 `resolveDocHref` 再校验一遍(collection / 路径 / 笔记 id 都有白名单规则)。
  const defaultValidateLink = md.validateLink.bind(md)
  md.validateLink = (url: string) => /^kb:\/\//i.test(url.trim()) || defaultValidateLink(url)
  return md
}

/** 一段分段的目标大小（HTML 字符数）：够小，主线程一次只清洗 / 插入几 KB；够大，消息数量不至于成百上千 */
export const CHUNK_TARGET_CHARS = 3000
/**
 * 第一段更小：第一次把正文排进页面要付一笔和内容多少无关的预热开销（字体回退、字形缓存，4× 降速下 20~30 ms），
 * 第一帧里只放这么一点，预热落在小帧里，不和一整批正文叠在一起越过长任务线。
 */
export const FIRST_CHUNK_CHARS = 600

/** 标题的可见文字：和渲染后 DOM 的 textContent 同一口径（行内代码、公式占位保留文字，图片不算） */
function headingText(inline: { children?: { type: string; content: string }[] | null; content: string } | undefined): string {
  if (!inline) return ''
  const parts: string[] = []
  for (const child of inline.children ?? []) {
    if (child.type === 'text' || child.type === 'code_inline' || child.type === 'kb_math') parts.push(child.content)
    else if (child.type === 'softbreak') parts.push('\n')
  }
  return parts.join('').trim()
}

/**
 * 解析整篇，按顶层块分段输出 HTML。
 * 顶层块的边界：`level === 0` 且 `nesting <= 0` 的 token（块的关闭标签，或围栏代码 / 分割线 / 公式块这类自闭合块）。
 */
export function renderMarkdownChunks(md: MarkdownIt, source: string, targetChars = CHUNK_TARGET_CHARS): MarkdownChunks {
  const firstChars = Math.min(targetChars, FIRST_CHUNK_CHARS)
  const env = {}
  const tokens = md.parse(source, env)
  const chunks: string[] = []
  const headings: MarkdownHeading[] = []
  const headingsThrough: number[] = []
  let html = ''
  let start = 0
  const flush = () => {
    if (!html) return
    chunks.push(html)
    headingsThrough.push(headings.length)
    html = ''
  }
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at]!
    if (token.type === 'heading_open') headings.push({ level: Number(token.tag.slice(1)), text: headingText(tokens[at + 1]) })
    if (token.level === 0 && token.nesting <= 0) {
      html += md.renderer.render(tokens.slice(start, at + 1), md.options, env)
      start = at + 1
      if (html.length >= (chunks.length === 0 ? firstChars : targetChars)) flush()
    }
  }
  // 正常情况下 token 流以顶层块的结束收尾；万一有残留（规则插件的自闭合 inline 之类）也别丢
  if (start < tokens.length) html += md.renderer.render(tokens.slice(start), md.options, env)
  flush()
  return { chunks, headings, headingsThrough }
}
