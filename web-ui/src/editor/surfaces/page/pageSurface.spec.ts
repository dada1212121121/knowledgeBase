/**
 * Page Surface 控制器测试（设计规范）
 *
 * docx-preview 换成一个把固定 DOM 写进容器的替身（它的版式要真浏览器才有意义，e2e 里用真文件验）；
 * 其余——取字节、读包元信息、命令、查询、选区、大纲、批注——全是真实代码。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import JSZip from 'jszip'
import type { DocumentSession, EditorCommand, SurfaceContext } from '../../types'
import { PageSurface } from './surface'

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const PAGES_HTML = `<div class="kbdocx-wrapper">
  <section class="kbdocx"><header><p>页眉</p></header>
    <p class="kbdocx_heading1">第一章 总则</p><p>合同双方约定如下：合同条款一。</p><footer><p>页脚 1</p></footer></section>
  <section class="kbdocx"><p class="kbdocx_heading2">1.1 范围</p><p>第二页的合同条款二。</p></section>
  <section class="kbdocx"><p>第三页没有标题，但有合同条款三。</p></section>
</div>`

async function docxBytes(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file(
    'word/styles.xml',
    `<w:styles ${NS}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`,
  )
  zip.file('word/comments.xml', `<w:comments ${NS}><w:comment w:id="3" w:author="李四" w:date="2025-06-01T00:00:00Z"><w:p><w:r><w:t>这里要改</w:t></w:r></w:p></w:comment></w:comments>`)
  zip.file('word/document.xml', `<w:document ${NS}><w:body><w:p><w:commentRangeStart w:id="3"/><w:r><w:t>合同条款二</w:t></w:r><w:commentRangeEnd w:id="3"/></w:p></w:body></w:document>`)
  return zip.generateAsync({ type: 'arraybuffer' })
}

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('@/utils/fetchOriginal', () => ({
  fetchOriginal: fetchMock,
  OriginalError: class OriginalError extends Error {},
}))
vi.mock('docx-preview', () => ({
  renderAsync: vi.fn(async (_buffer: ArrayBuffer, host: HTMLElement) => {
    host.innerHTML = PAGES_HTML
  }),
}))

interface Harness {
  surface: PageSurface
  el: HTMLElement
  stats: ReturnType<typeof vi.fn>
  selections: unknown[]
  errors: Error[]
}

let scrolled: Element[] = []

async function mountSurface(hint?: SurfaceContext['document']['hint']): Promise<Harness> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const stats = vi.fn()
  const selections: unknown[] = []
  const errors: Error[] = []
  const ctx = {
    session: { getSelection: () => null, setSnapshotProvider: () => undefined } as unknown as DocumentSession,
    document: { kind: 'page', format: 'docx', revision: 0, payload: { kind: 'text', text: '', name: 'a.docx', url: '/raw/a.docx' }, hint },
    permissions: { read: true, write: false, comment: false, ai: false, export: false },
    readonly: true,
    onStatsChange: stats,
    onSelectionChange: (selection: unknown) => selections.push(selection),
    onError: (error: Error) => errors.push(error),
  } as unknown as SurfaceContext
  const surface = new PageSurface()
  await surface.mount(el, ctx)
  await flushPromises()
  // 包元信息（JSZip）是渲染之后异步读的
  await vi.waitFor(() => expect(stats.mock.calls.length).toBeGreaterThanOrEqual(2))
  return { surface, el, stats, selections, errors }
}

const cmd = (type: string, args?: unknown): EditorCommand => ({ id: `t_${type}`, type, args, source: 'user' })

beforeEach(async () => {
  scrolled = []
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this)
  }
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(await docxBytes())
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('PageSurface', () => {
  it('1. 挂载：渲染 3 页；页数进状态栏；渲染完成和元信息读完各通知一次', async () => {
    const { surface, stats } = await mountSurface()
    expect(await surface.query({ type: 'wordCount' })).toEqual({ words: 3, unitLabel: '页' })
    expect(stats.mock.calls.length).toBe(2)
  })

  it('2. 大纲来自标题样式，带页码；页眉不进大纲；点大纲条目翻到那一页', async () => {
    const { surface } = await mountSurface()
    const outline = (await surface.query({ type: 'outline' })) as { level: number; text: string; anchor: { kind: string; page: number; text: string } }[]
    expect(outline.map((item) => [item.level, item.text, item.anchor.page])).toEqual([
      [1, '第一章 总则', 1],
      [2, '1.1 范围', 2],
    ])
    const result = await surface.command(cmd('nav.anchor', { anchor: outline[1]!.anchor }))
    expect(result.ok).toBe(true)
    expect(scrolled.at(-1)?.textContent).toContain('1.1 范围')
  })

  it('3. 批注：作者、被批注原文；点命令按原文定位', async () => {
    const { surface } = await mountSurface()
    const comments = (await surface.query({ type: 'comments' })) as { author: string; quote: string; text: string }[]
    expect(comments).toEqual([expect.objectContaining({ author: '李四', quote: '合同条款二', text: '这里要改' })])
    const result = await surface.command(cmd('nav.anchor', { anchor: { kind: 'page', page: 0, text: comments[0]!.quote } }))
    expect(result.ok).toBe(true)
    expect(scrolled.at(-1)?.textContent).toContain('第二页的合同条款二')
  })

  it('4. 查找：总数、当前序号、上一个 / 下一个循环；关闭后清空', async () => {
    const { surface } = await mountSurface()
    const first = (await surface.command(cmd('search.set', { query: '合同条款' }))).data as { total: number; index: number; anchors: unknown[] }
    expect(first.total).toBe(3)
    expect(first.index).toBe(0)
    expect(first.anchors).toHaveLength(1)
    expect(((await surface.command(cmd('search.next'))).data as { index: number }).index).toBe(1)
    expect(((await surface.command(cmd('search.next'))).data as { index: number }).index).toBe(2)
    expect(((await surface.command(cmd('search.next'))).data as { index: number }).index).toBe(0)
    expect(((await surface.command(cmd('search.prev'))).data as { index: number }).index).toBe(2)
    const closed = (await surface.command(cmd('search.close'))).data as { total: number }
    expect(closed.total).toBe(0)
    expect(await surface.query({ type: 'search' })).toEqual({ query: '', total: 0, index: -1 })
  })

  it('5. 查找从当前页往后找第一处；没有命中时总数为 0', async () => {
    const { surface } = await mountSurface()
    await surface.command(cmd('page.next'))
    await surface.command(cmd('page.next'))
    const result = (await surface.command(cmd('search.set', { query: '合同条款' }))).data as { index: number }
    expect(result.index).toBe(2)
    const none = (await surface.command(cmd('search.set', { query: '不存在的词' }))).data as { total: number; index: number }
    expect(none).toMatchObject({ total: 0, index: -1 })
  })

  it('6. 打开时带命中句子（搜索结果跳转）：滚到那一句所在的页', async () => {
    await mountSurface({ text: '第三页没有标题', anchor: { kind: 'page', page: 3, text: '第三页没有标题' } })
    expect(scrolled.at(-1)?.textContent).toContain('第三页没有标题')
  })

  it('7. 缩放与翻页：放大缩小改变比例，适应宽度恢复；翻页命令更新页码并限制在范围内', async () => {
    const { surface } = await mountSurface()
    const before = surface.capture().zoom!
    await surface.command(cmd('zoom.in'))
    expect(surface.capture().zoom!).toBeGreaterThan(before)
    await surface.command(cmd('zoom.out'))
    await surface.command(cmd('zoom.out'))
    expect(surface.capture().zoom!).toBeLessThan(before)
    await surface.command(cmd('zoom.fit'))
    await surface.command(cmd('page.next'))
    expect(surface.capture().extra?.page).toBe(2)
    await surface.command(cmd('page.next'))
    await surface.command(cmd('page.next'))
    expect(surface.capture().extra?.page).toBe(3)
    await surface.command(cmd('page.prev'))
    expect(surface.capture().extra?.page).toBe(2)
  })

  it('8. 永远只读：编辑类命令一律拒绝，不会有假编辑入口', async () => {
    const { surface } = await mountSurface()
    for (const type of ['text.insert', 'mark.toggle', 'history.undo', 'doc.save']) {
      expect(await surface.command(cmd(type))).toMatchObject({ ok: false, reason: `readonly_command:${type}` })
    }
    expect(await surface.query({ type: 'text' })).toBe('')
    // 只读预览没有格式状态：不报任何文字 / 段落 / 列表格式（否则工具栏会亮出假的格式高亮），只报视图开关（缩略图栏）
    expect(await surface.query({ type: 'formatState' })).toEqual({ marks: [], block: '', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, toggles: ['thumbs'] })
  })

  it('9. 选中文字：上报页码 + 原文锚点；Ctrl+A 只选文档不选整个界面', async () => {
    const { surface, el, selections } = await mountSurface()
    const scroller = el.querySelector<HTMLElement>('.kb-pgs-scroll')!
    scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))
    const text = window.getSelection()!.toString()
    expect(text).toContain('第一章 总则')
    expect(text).toContain('第三页没有标题')
    expect(text).not.toContain('Word 工具栏')
    scroller.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(selections.at(-1)).toMatchObject({ kind: 'page', isEmpty: false, anchor: { kind: 'page', page: 1 } })
    expect(await surface.query({ type: 'selection' })).toMatchObject({ kind: 'page' })
  })

  it('10. 复制：选中正文时剪贴板里没有页眉页脚', async () => {
    const { el } = await mountSurface()
    const scroller = el.querySelector<HTMLElement>('.kb-pgs-scroll')!
    const page = scroller.querySelector('section.kbdocx')!
    const range = document.createRange()
    range.setStartBefore(page.querySelector('p.kbdocx_heading1')!)
    range.setEndAfter(page.querySelector('footer')!)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const data = new Map<string, string>()
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => data.set(type, value) } })
    scroller.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(data.get('text/plain')).toBe('第一章 总则\n合同双方约定如下：合同条款一。')
    expect(data.get('text/html')).not.toContain('页脚')
  })

  it('11. 原件取不到：通过 onError 上报，状态是错误而不是白屏', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('原件下载失败'), { name: 'OriginalError' }))
    const el = document.createElement('div')
    document.body.appendChild(el)
    const errors: Error[] = []
    const surface = new PageSurface()
    await surface.mount(el, {
      session: { setSnapshotProvider: () => undefined } as unknown as DocumentSession,
      document: { kind: 'page', format: 'docx', revision: 0, payload: { kind: 'text', text: '', name: 'a.docx', url: '/raw/a.docx' } },
      permissions: { read: true, write: false, comment: false, ai: false, export: false },
      readonly: true,
      onError: (error: Error) => errors.push(error),
    } as unknown as SurfaceContext)
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(el.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('12. 没有原件地址：挂载直接失败，交给 Host 回退', async () => {
    const surface = new PageSurface()
    await expect(
      surface.mount(document.createElement('div'), {
        session: { setSnapshotProvider: () => undefined } as unknown as DocumentSession,
        document: { kind: 'page', format: 'docx', revision: 0, payload: { kind: 'text', text: '', name: 'a.docx' } },
        permissions: { read: true, write: false, comment: false, ai: false, export: false },
        readonly: true,
      } as unknown as SurfaceContext),
    ).rejects.toThrow('原件地址')
  })
})
