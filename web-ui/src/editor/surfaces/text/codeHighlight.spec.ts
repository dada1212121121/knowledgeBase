/**
 * 代码块语法高亮
 *
 * 高亮是叠在文本上的行内装饰：必须不改文档（保存的 Markdown 一字不变）、语言包异步加载完才上色、
 * 流程图 / 公式 / 纯文本 / 认不出的语言不上色、太长不上色。
 * 引擎（CodeMirror 语言表 + Lezer，约 100 KB gzip）是按需动态加载的：没有带语言的代码块就不下载（体积门禁的前提）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupText, mountText } from './textTestKit'
import { fenceLanguage, highlightEngineState, resetHighlightEngine } from './codeHighlight'
import { HIGHLIGHT_MAX_CHARS, languageForName } from './codeHighlightEngine'

afterEach(cleanupText)

const toks = (el: HTMLElement) => [...el.querySelectorAll('.kb-code-block code [class^="tok-"]')].map((n) => n.className)
const waitToks = async (el: HTMLElement) => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (toks(el).length) return toks(el)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return toks(el)
}

/** 围栏信息串 → 语言描述：外壳先排除不上色的类别，再由引擎查语言表（和插件里同一条路径） */
const languageForFence = (info: string) => {
  const name = fenceLanguage(info)
  return name ? languageForName(name) : null
}

describe('围栏语言名 → 语言包', () => {
  it('常见名字与别名都认得（js / ts / py / bash / json / rust / sql …）', () => {
    for (const name of ['js', 'javascript', 'ts', 'typescript', 'py', 'python', 'bash', 'sh', 'json', 'rust', 'sql', 'yaml', 'html', 'css', 'go']) {
      expect(languageForFence(name), name).not.toBeNull()
    }
  })

  it('大小写不敏感，信息串后面带的参数不影响（```js {1,3}）', () => {
    expect(fenceLanguage('JS')).toBe('js')
    expect(fenceLanguage('js {1,3}')).toBe('js')
    expect(languageForFence('JS')?.name).toBe(languageForFence('js')?.name)
    expect(languageForFence('js {1,3}')?.name).toBe(languageForFence('js')?.name)
  })

  it('不上色的：空、流程图、公式、纯文本、认不出的语言', () => {
    for (const name of ['', 'mermaid', 'LaTeX', 'math', 'text', 'plaintext', 'no-such-language-xyz']) {
      expect(languageForFence(name), name).toBeNull()
    }
  })
})

describe('按需加载引擎（笔记编辑增量 ≤ 150 KB gzip 的前提）', () => {
  it('没有带语言的代码块（正文 / 无语言块 / 流程图 / 公式 / 纯文本块）时，不加载引擎', async () => {
    resetHighlightEngine()
    const { el } = await mountText('# 标题\n\n正文\n\n```\nconst a = 1\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```text\nplain\n```\n\n$$\nE = mc^2\n$$')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(highlightEngineState()).toBe('idle')
    expect(toks(el)).toEqual([])
  })

  it('出现带语言的代码块才加载；加载前是纯文本，加载后只多了颜色，文字不变', async () => {
    resetHighlightEngine()
    const { el, view } = await mountText('```js\nconst a = "x" + 1\n```')
    // 刚挂载：引擎还在路上，代码块是纯文本，没有任何 tok- 节点
    expect(['loading', 'ready']).toContain(highlightEngineState())
    const before = el.querySelector('.kb-code-block code')?.textContent
    expect(before).toBe('const a = "x" + 1')
    const classes = await waitToks(el)
    expect(highlightEngineState()).toBe('ready')
    expect(classes.some((c) => c.includes('tok-keyword'))).toBe(true)
    expect(el.querySelector('.kb-code-block code')?.textContent).toBe(before)
    expect(view.state.doc.textContent).toBe('const a = "x" + 1')
  }, 20_000)

  it('正文里后来才加上带语言的代码块（用户给代码块选语言）也会触发加载', async () => {
    resetHighlightEngine()
    const { el, view } = await mountText('```\nlet a = 1\n```')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(highlightEngineState()).toBe('idle')
    view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { language: 'js', kbMath: false }))
    expect((await waitToks(el)).some((c) => c.includes('tok-keyword'))).toBe(true)
    expect(highlightEngineState()).toBe('ready')
  }, 20_000)
})

describe('编辑器里的代码块上色', () => {
  it('js 代码：语言包加载完后关键字 / 字符串 / 数字各有 tok- 类名', async () => {
    const { el } = await mountText('```js\nconst a = "x" + 1\n```')
    const classes = await waitToks(el)
    expect(classes.some((c) => c.includes('tok-keyword'))).toBe(true)
    expect(classes.some((c) => c.includes('tok-string'))).toBe(true)
    expect(classes.some((c) => c.includes('tok-number'))).toBe(true)
    // 颜色规则挂在 .kb-tok 下
    expect(el.querySelector('.kb-code-block')?.classList.contains('kb-tok')).toBe(true)
  }, 20_000)

  it('高亮不改文档：保存的 Markdown 与打开时一字不差，文字内容不变', async () => {
    const source = '```js\nconst a = "x" + 1\n```'
    const { el, surface, view } = await mountText(source)
    await waitToks(el)
    expect(view.state.doc.textContent).toBe('const a = "x" + 1')
    expect(await surface.query({ type: 'text' })).toBe(source)
  }, 20_000)

  it('改代码后重新上色（新输入的关键字也有颜色），改语言后跟着换', async () => {
    const { el, view } = await mountText('```js\nlet a\n```')
    await waitToks(el)
    view.dispatch(view.state.tr.insertText(' = 1', view.state.doc.content.size - 1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(toks(el).some((c) => c.includes('tok-number'))).toBe(true)
    // 改成不上色的语言：颜色全部去掉
    view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { language: 'text', kbMath: false }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(toks(el)).toEqual([])
  }, 20_000)

  it('流程图 / 公式块、无语言的块不上色', async () => {
    const { el } = await mountText('```mermaid\nflowchart LR\n  A --> B\n```\n\n```\nconst a = 1\n```\n\n$$\nE = mc^2\n$$')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(toks(el)).toEqual([])
  })

  it('太长的块不上色（避免卡输入）', async () => {
    const long = `${'let a = 1\n'.repeat(Math.ceil(HIGHLIGHT_MAX_CHARS / 9) + 10)}`
    const { el } = await mountText(`\`\`\`js\n${long}\`\`\``)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(toks(el)).toEqual([])
  }, 20_000)

  it('只读时也上色（阅读编辑同一份外观）', async () => {
    const { el } = await mountText('```py\ndef f():\n    return 1\n```', { readonly: true })
    expect((await waitToks(el)).some((c) => c.includes('tok-keyword'))).toBe(true)
  }, 20_000)
})
