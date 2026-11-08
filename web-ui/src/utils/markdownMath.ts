// Markdown 公式:`$...$` 行内、`$$...$$` 块级,渲染成占位节点,公式本体等 DOM 挂上去后再由 katex 换掉。
//
// 为什么不用现成插件:
// 阅读态首屏必须零公式成本——不出现公式的笔记不应该下载 katex(约 280 KB)。
// 所以这里只做「识别 + 占位」,真正的渲染由 MarkdownRead 在发现占位节点时动态 import katex 完成。
//
// 边界:
// 1. 代码块 / 行内代码里的 `$` 不当作公式(markdown-it 的 inline 规则天然只在 text 段里跑,
//    但 fence / code_inline 会先吃掉内容,所以顺序上要放在它们之后)。
// 2. 公式里允许出现转义的 `\$`;跨行行内公式不认(长公式请用 `$$` 块)。
// 3. 占位节点的文本就是 TeX 原文:katex 加载失败时用户看到的是公式源码,不是空白。
import type MarkdownIt from 'markdown-it'

export interface MathTokenMeta {
  display: boolean
}

/** 转义 HTML 文本(占位节点的可见内容,不信任任何输入)。 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 注册公式规则。只依赖 markdown-it 的公开规则接口(block / inline ruler + renderer),
 * 不碰内部状态字段,升级 markdown-it 时不用跟着改。
 */
export function mathPlugin(md: MarkdownIt): void {
  // 块级:`$$` 单独起一行,可以跨行,以 `$$` 收尾(允许单行 `$$x$$`)
  md.block.ruler.before('fence', 'kb_math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]
    const first = state.src.slice(start, max)
    if (!first.startsWith('$$')) return false
    // 缩进代码块由更靠前的 code 规则先吃掉,这里不用再判断缩进
    if (silent) return true

    let content = ''
    let next = startLine + 1
    if (first.length > 4 && first.trimEnd().endsWith('$$')) {
      content = first.trimEnd().slice(2, -2)
    } else {
      const rest = first.slice(2)
      let closed = false
      content = rest.trim() ? `${rest}\n` : ''
      for (; next < endLine; next += 1) {
        const lineStart = state.bMarks[next] + state.tShift[next]
        const lineEnd = state.eMarks[next]
        const text = state.src.slice(lineStart, lineEnd)
        const close = text.lastIndexOf('$$')
        if (close >= 0 && text.slice(close + 2).trim() === '') {
          content += text.slice(0, close)
          next += 1
          closed = true
          break
        }
        content += `${text}\n`
      }
      // 没有收尾的 `$$`:交回普通段落,避免把后面整篇文档吞进公式
      if (!closed) return false
    }
    if (!content.trim()) return false

    const token = state.push('kb_math', 'div', 0)
    token.block = true
    token.content = content.trim()
    token.meta = { display: true } satisfies MathTokenMeta
    token.map = [startLine, next]
    state.line = next
    return true
  })

  // 行内:成对的单个 `$`,不跨行,`\$` 视为普通字符
  md.inline.ruler.before('escape', 'kb_math_inline', (state, silent) => {
    const src = state.src
    const start = state.pos
    if (src[start] !== '$' || src[start + 1] === '$') return false
    // 中文笔记里「价格 $5 到 $9」这种写法很常见:币值不是公式。
    // 两条保守规则挡住它:开头紧跟空白、结尾前是空白、收尾的 `$` 后面紧跟数字,都不认。
    if (/\s/.test(src[start + 1] ?? '')) return false
    let index = start + 1
    while (index < state.posMax) {
      const char = src[index]
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '\n') return false
      if (char === '$') break
      index += 1
    }
    if (index >= state.posMax || src[index] !== '$') return false
    if (/\s/.test(src[index - 1] ?? '')) return false
    if (/\d/.test(src[index + 1] ?? '')) return false
    const tex = src.slice(start + 1, index).trim()
    if (!tex) return false
    if (!silent) {
      const token = state.push('kb_math', 'span', 0)
      token.content = tex
      token.meta = { display: false } satisfies MathTokenMeta
    }
    state.pos = index + 1
    return true
  })

  md.renderer.rules.kb_math = (tokens, index) => {
    const token = tokens[index]
    const display = (token.meta as MathTokenMeta | undefined)?.display === true
    const tag = display ? 'div' : 'span'
    const text = escapeHtml(token.content)
    return `<${tag} class="kb-math${display ? ' is-block' : ''}" data-tex="${escapeHtml(token.content)}">${text}</${tag}>`
  }
}
