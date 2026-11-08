// 阅读态 Markdown 渲染:安全清洗、双链改写、目录标题、任务列表、表格、按需加载的公式 / 流程图。
// 这里不测性能(见 e2e/editor-bench.mjs),只守行为边界。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import MarkdownRead from './MarkdownRead.vue'
import { noteLinkKey, type LinkContext } from '@/utils/links'

const mermaidRender = vi.fn(async () => ({ svg: '<svg class="fake-mermaid"></svg>' }))
vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: mermaidRender },
}))
const katexRender = vi.fn((tex: string) => `<span class="katex">${tex}</span>`)
vi.mock('katex', () => ({ default: { renderToString: katexRender } }))

const ctx: LinkContext = {
  collection: 'proj_kb',
  sourcePath: 'docs/当前.md',
  rawUrl: (collection, path) => `/api/v1/raw?${new URLSearchParams({ collection, path }).toString()}`,
}
const NOTE_ID = '01a19f63-f0ea-72fe-aa19-9998f6e2e5ad'

function mountRead(props: Record<string, unknown> = {}) {
  return mount(MarkdownRead, { props: { source: '', ...props }, attachTo: document.body })
}

/** 等异步增强(动态 import + 渲染)落地;跑全量测试时机器忙,固定几轮 flush 会偶发不够 */
async function settle(ms = 60): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 轮询等某个条件成立(动态 import 的耗时不可预测,不能用固定等待) */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  for (;;) {
    await flushPromises()
    if (predicate()) return
    if (Date.now() > until) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  mermaidRender.mockClear()
  katexRender.mockClear()
})

describe('MarkdownRead 渲染', () => {
  it('渲染标题 / 段落 / 列表 / 表格 / 代码块 / 引用 / 分割线', async () => {
    const wrapper = mountRead({
      source: [
        '# 一级',
        '',
        '## 二级',
        '',
        '正文 **加粗** 与 `行内代码`。',
        '',
        '- 一',
        '- 二',
        '',
        '| 列 | 值 |',
        '|---|---|',
        '| a | 1 |',
        '',
        '```ts',
        'const x = 1',
        '```',
        '',
        '> 引用',
        '',
        '---',
      ].join('\n'),
    })
    await settle()
    const body = wrapper.find('.kb-md-read-body')
    expect(body.find('h1').text()).toBe('一级')
    expect(body.find('h2').text()).toBe('二级')
    expect(body.find('strong').text()).toBe('加粗')
    expect(body.findAll('li')).toHaveLength(2)
    expect(body.find('table th').text()).toBe('列')
    expect(body.find('pre code').text()).toContain('const x = 1')
    expect(body.find('blockquote').text()).toContain('引用')
    expect(body.find('hr').exists()).toBe(true)
    wrapper.unmount()
  })

  it('原始 HTML 不执行:脚本、事件属性、javascript 链接全部拦掉', async () => {
    const wrapper = mountRead({
      source: '<script>window.__xss=1</script>\n\n<img src=x onerror="window.__xss=1">\n\n[点我](javascript:window.__xss=1)',
      linkContext: ctx,
    })
    await settle()
    const win = window as Window & { __xss?: number }
    expect(win.__xss).toBeUndefined()
    expect(wrapper.find('script').exists()).toBe(false)
    // html:false → 原始 HTML 以文本形式显示,不会变成节点
    expect(wrapper.find('img').exists()).toBe(false)
    const anchor = wrapper.find('a')
    expect(anchor.exists() ? anchor.attributes('href') : '').not.toContain('javascript')
    wrapper.unmount()
  })

  it('编辑器写的颜色 span 正常渲染:常用色走主题 class,自定义色保留内联 style', async () => {
    const wrapper = mountRead({ source: '<span style="color: #E5484D">红</span> 与 <span style="background-color: #123456">自定义底</span>' })
    await settle()
    expect(wrapper.find('.kb-color.is-fg-red').text()).toBe('红')
    expect(wrapper.find('.kb-color.is-custom').attributes('style')).toContain('background-color')
    expect(wrapper.text()).not.toContain('<span')
    wrapper.unmount()
  })

  it('表格包一层横向滚动容器,手机上不撑破正文', async () => {
    const wrapper = mountRead({ source: '| a | b |\n|---|---|\n| 1 | 2 |' })
    await settle()
    expect(wrapper.find('.kb-table-scroll > table').exists()).toBe(true)
    wrapper.unmount()
  })

  it('任务列表把 [ ] / [x] 换成只读勾选框', async () => {
    const wrapper = mountRead({ source: '- [ ] 没做\n- [x] 做了' })
    await settle()
    const boxes = wrapper.findAll('.kb-task-box')
    expect(boxes).toHaveLength(2)
    expect(boxes[0].classes()).not.toContain('is-done')
    expect(boxes[1].classes()).toContain('is-done')
    expect(wrapper.find('.kb-task-item').text()).not.toContain('[ ]')
    wrapper.unmount()
  })
})

describe('MarkdownRead 链接', () => {
  it('双链变成可点节点,点击发 openNote / openAttachment', async () => {
    const wrapper = mountRead({
      source: `[[${NOTE_ID}|旧笔记]] 与 [规范](kb://proj_kb/docs/规范.md)`,
      linkContext: ctx,
    })
    await settle()
    await wrapper.find(`a[data-kb-note="${NOTE_ID}"]`).trigger('click')
    expect(wrapper.emitted('openNote')?.[0]).toEqual([NOTE_ID])
    const file = wrapper.find('a[data-kb-collection]')
    await file.trigger('click')
    expect(wrapper.emitted('openAttachment')?.[0]).toEqual([
      { collection: 'proj_kb', path: 'docs/规范.md', fragment: undefined },
    ])
    wrapper.unmount()
  })

  it('缺目标的链接点击时说明原因,不跳 404', async () => {
    const wrapper = mountRead({
      source: '[缺失](kb://proj_kb/docs/没有.md)',
      linkContext: ctx,
      linkStates: { 'proj_kb\u0000docs/没有.md': 'missing' },
    })
    await settle()
    const anchor = wrapper.find('a.kb-link-missing')
    expect(anchor.exists()).toBe(true)
    await anchor.trigger('click')
    expect(String(wrapper.emitted('linkError')?.[0]?.[0])).toContain('不在知识库里')
    wrapper.unmount()
  })

  it('分享页不允许跳笔记:双链只留文字', async () => {
    const wrapper = mountRead({ source: `[[${NOTE_ID}|旧笔记]]`, linkContext: ctx, allowNotes: false })
    await settle()
    expect(wrapper.find(`a[data-kb-note]`).exists()).toBe(false)
    expect(wrapper.find('span.kb-wikilink').text()).toBe('旧笔记')
    wrapper.unmount()
  })

  it('体检结果变化会重新标状态', async () => {
    const wrapper = mountRead({ source: '[目标](kb://proj_kb/docs/a.md)', linkContext: ctx })
    await settle()
    expect(wrapper.find('a.kb-link-missing').exists()).toBe(false)
    await wrapper.setProps({ linkStates: { 'proj_kb\u0000docs/a.md': 'outside' } })
    await settle()
    expect(wrapper.find('a.kb-link-missing').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('MarkdownRead 目录与按需增强', () => {
  it('渲染后按顺序发出标题列表,headingElements 与之一致', async () => {
    const wrapper = mountRead({ source: '# 甲\n\n正文\n\n### 乙\n\n##### 丙' })
    await settle()
    expect(wrapper.emitted('headings')?.[0]).toEqual([
      [
        { level: 1, text: '甲' },
        { level: 3, text: '乙' },
        { level: 5, text: '丙' },
      ],
    ])
    const api = wrapper.vm as unknown as { headingElements: () => HTMLElement[] }
    expect(api.headingElements().map((el) => el.textContent)).toEqual(['甲', '乙', '丙'])
    wrapper.unmount()
  })

  it('没有公式和流程图时不加载 katex / mermaid', async () => {
    const wrapper = mountRead({ source: '# 普通笔记\n\n只有文字。' })
    await settle()
    expect(katexRender).not.toHaveBeenCalled()
    expect(mermaidRender).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('出现公式时把占位节点换成 katex 输出', async () => {
    const wrapper = mountRead({ source: '质能方程 $E=mc^2$\n\n$$\na+b\n$$' })
    await waitFor(() => wrapper.findAll('.kb-math.is-rendered').length === 2)
    const rendered = wrapper.findAll('.kb-math.is-rendered')
    expect(rendered.length).toBe(2)
    expect(rendered[0].find('.katex').exists()).toBe(true)
    expect(katexRender).toHaveBeenCalledWith('E=mc^2', expect.objectContaining({ displayMode: false }))
    expect(katexRender).toHaveBeenCalledWith('a+b', expect.objectContaining({ displayMode: true }))
    wrapper.unmount()
  })

  it('出现 mermaid 代码块时换成图,语法错误只影响那一块', async () => {
    mermaidRender.mockImplementationOnce(async () => ({ svg: '<svg class="fake-mermaid"></svg>' }))
    mermaidRender.mockImplementationOnce(async () => {
      throw new Error('Parse error on line 2')
    })
    const wrapper = mountRead({ source: '```mermaid\ngraph TD;\nA-->B;\n```\n\n```mermaid\n坏图\n```' })
    await waitFor(() => wrapper.findAll('.kb-mermaid.is-error').length === 1)
    expect(wrapper.find('.kb-mermaid svg').exists()).toBe(true)
    const bad = wrapper.findAll('.kb-mermaid.is-error')
    expect(bad).toHaveLength(1)
    expect(bad[0].text()).toContain('流程图语法有误')
    // 坏图不影响正文其它内容继续渲染
    expect(mermaidRender).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('换成另一篇文档后旧的异步增强结果不会写进新 DOM', async () => {
    const wrapper = mountRead({ source: '```mermaid\ngraph TD;\nA-->B;\n```' })
    await wrapper.setProps({ source: '# 换了一篇' })
    await settle()
    expect(wrapper.find('.kb-mermaid').exists()).toBe(false)
    expect(wrapper.find('h1').text()).toBe('换了一篇')
    wrapper.unmount()
  })
})

describe('MarkdownRead 链接体检键', () => {
  it('笔记缺目标时标记为打不开', async () => {
    const wrapper = mountRead({
      source: `[[${NOTE_ID}|旧笔记]]`,
      linkContext: ctx,
      linkStates: { [noteLinkKey(NOTE_ID)]: 'missing' },
    })
    await settle()
    expect(wrapper.find(`a[data-kb-note="${NOTE_ID}"]`).classes()).toContain('kb-link-missing')
    wrapper.unmount()
  })
})

/** 超过渐进渲染阈值（16 000 字符）的长文：每节一个二级标题 + 一段正文 + 一个列表 */
function longSource(sections = 200): string {
  return Array.from({ length: sections }, (_, i) => `## 第 ${i + 1} 节\n\n这是第 ${i + 1} 节的正文，写得长一点让整篇超过阈值，带 **加粗** 和 \`代码\`。再多写几句凑够篇幅：稠密检索擅长语义近似，稀疏检索擅长专有名词，两路结果用倒数排名融合。\n\n- 要点甲 ${i + 1}\n- 要点乙 ${i + 1}\n`).join('\n')
}
const renderState = (wrapper: ReturnType<typeof mountRead>) => wrapper.find('.kb-md-read').attributes('data-render')

describe('MarkdownRead 大文档渐进渲染', () => {
  it('不开 progressive 时长文也同步一次渲染完（助手的流式回答走这条）', async () => {
    const wrapper = mountRead({ source: longSource() })
    await flushPromises()
    expect(renderState(wrapper)).toBe('done')
    expect(wrapper.findAll('.kb-md-read-body h2')).toHaveLength(200)
    wrapper.unmount()
  })

  it('开了 progressive：目录标题一次给全，内容分批长出来，最后和同步渲染的 DOM 逐字相同', async () => {
    const source = longSource()
    const sync = mountRead({ source })
    await flushPromises()
    const expected = sync.find('.kb-md-read-body').html()
    sync.unmount()

    const wrapper = mountRead({ source, progressive: true })
    await flushPromises()
    // 刚开始：页面框架先占一帧，正文还没挂，状态是渲染中
    expect(renderState(wrapper)).toBe('rendering')
    expect(wrapper.findAll('.kb-md-read-body h2')).toHaveLength(0)
    // 目录在框架之后、第一批正文之前发出，而且一次给全 200 项
    await waitFor(() => !!wrapper.emitted('headings'))
    expect(renderState(wrapper)).toBe('rendering')
    const first = wrapper.emitted('headings')?.[0]?.[0] as { level: number; text: string }[]
    expect(first).toHaveLength(200)
    expect(first[0]).toEqual({ level: 2, text: '第 1 节' })
    expect(wrapper.findAll('.kb-md-read-body h2').length).toBeLessThan(200)

    await waitFor(() => renderState(wrapper) === 'done')
    expect(wrapper.find('.kb-md-read-body').html()).toBe(expected)
    // 目录和真实 DOM 一致：不用再发第二次
    expect(wrapper.emitted('headings')).toHaveLength(1)
    wrapper.unmount()
  })

  it('ensureHeading：目标标题还没挂上就先渲染到那里，返回的是对应的标题元素', async () => {
    const wrapper = mountRead({ source: longSource(), progressive: true })
    await flushPromises()
    const api = wrapper.vm as unknown as { ensureHeading: (index: number) => Promise<HTMLElement | null>; headingElements: () => HTMLElement[] }
    const before = api.headingElements().length
    expect(before).toBeLessThan(150)
    const target = await api.ensureHeading(150)
    expect(target?.textContent).toBe('第 151 节')
    expect(api.headingElements().length).toBeGreaterThan(150)
    // 超出范围的序号不会卡住
    expect(await api.ensureHeading(9999)).toBeNull()
    await waitFor(() => renderState(wrapper) === 'done')
    wrapper.unmount()
  })

  it('flush：同步把剩下的内容挂完（打印前用），随后状态走到 done', async () => {
    const wrapper = mountRead({ source: longSource(), progressive: true })
    await flushPromises()
    const api = wrapper.vm as unknown as { flush: () => void }
    api.flush()
    expect(wrapper.findAll('.kb-md-read-body h2')).toHaveLength(200)
    await waitFor(() => renderState(wrapper) === 'done')
    wrapper.unmount()
  })

  it('beforeprint 事件也会把剩下的内容挂完', async () => {
    const wrapper = mountRead({ source: longSource(), progressive: true })
    await flushPromises()
    window.dispatchEvent(new Event('beforeprint'))
    expect(wrapper.findAll('.kb-md-read-body h2')).toHaveLength(200)
    wrapper.unmount()
  })

  it('渲染中途换了文档：旧文档剩下的段不会再往新 DOM 里挂', async () => {
    const wrapper = mountRead({ source: longSource(), progressive: true })
    await flushPromises()
    await wrapper.setProps({ source: '# 换了一篇\n\n短文' })
    await waitFor(() => renderState(wrapper) === 'done')
    await settle(300)
    expect(wrapper.findAll('.kb-md-read-body h2')).toHaveLength(0)
    expect(wrapper.find('.kb-md-read-body h1').text()).toBe('换了一篇')
    wrapper.unmount()
  })

  it('链接体检结果回来只重新标链接，不重渲整篇（节点还是原来那个）', async () => {
    const source = `[目标](kb://proj_kb/docs/a.md)\n\n${longSource(20)}`
    const wrapper = mountRead({ source, linkContext: ctx })
    await settle()
    const heading = wrapper.find('.kb-md-read-body h2').element
    expect(wrapper.find('a.kb-link-missing').exists()).toBe(false)
    await wrapper.setProps({ linkStates: { 'proj_kb\u0000docs/a.md': 'missing' } })
    await settle()
    expect(wrapper.find('a.kb-link-missing').exists()).toBe(true)
    expect(wrapper.find('.kb-md-read-body h2').element).toBe(heading)
    wrapper.unmount()
  })

  it('渐进渲染里的链接 / 任务列表 / 表格装饰和同步路径一样，相对图片在挂上之前就改好了地址', async () => {
    const filler = longSource(150)
    const source = `${filler}\n\n待办如下：\n\n- [x] 做完了\n\n| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n\n![图](img/a.png)\n\n[规范](kb://proj_kb/docs/规范.md)`
    const wrapper = mountRead({ source, linkContext: ctx, progressive: true })
    await waitFor(() => renderState(wrapper) === 'done')
    expect(wrapper.find('.kb-task-box.is-done').exists()).toBe(true)
    expect(wrapper.find('.kb-table-scroll table').exists()).toBe(true)
    expect(wrapper.find('img').attributes('src')).toContain('/api/v1/raw?')
    expect(wrapper.find('a[data-kb-collection]').attributes('data-kb-path')).toBe('docs/规范.md')
    wrapper.unmount()
  })
})
