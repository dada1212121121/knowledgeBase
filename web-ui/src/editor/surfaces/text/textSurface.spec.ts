/**
 * Text Surface 集成测试
 *
 * 这一层的价值是「把 codec 与会话接起来」：
 * - 未改动时保存必须拿到原始字符串（保真快速路径）；
 * - 改动后才走序列化，并且脏标记、撤销、字数、大纲都要跟着上下文走；
 * - 卸载必须解绑会话的快照提供者，否则下次保存会拿到已销毁视图的内容。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextSurface } from '@/editor/surfaces/text/TextSurface'
import type { DocumentSession, EditorSource, SurfaceContext } from '@/editor/types'

interface Harness {
  ctx: SurfaceContext
  /** 会话持有的快照提供者（模拟 Session.snapshot） */
  snapshot: () => EditorSource | null
  dirty: boolean[]
  selections: number
  el: HTMLElement
}

function makeHarness(text: string, options: { readonly?: boolean } = {}): Harness {
  let provider: (() => EditorSource | null) | null = null
  const dirty: boolean[] = []
  const session = {
    setSnapshotProvider(p: (() => EditorSource | null) | null) {
      provider = p
    },
  } as unknown as DocumentSession

  const el = document.createElement('div')
  document.body.append(el)

  const ctx: SurfaceContext = {
    session,
    document: { kind: 'text', format: 'md', revision: 1, payload: { kind: 'text', text, name: 'note.md' } },
    permissions: { read: true, write: !options.readonly, comment: true, ai: true, export: true },
    readonly: options.readonly ?? false,
    onDirtyChange: (value) => dirty.push(value),
    onSelectionChange: () => {
      harness.selections += 1
    },
  }

  const harness: Harness = {
    ctx,
    el,
    dirty,
    selections: 0,
    snapshot: () => (provider ? provider() : null),
  }
  return harness
}

const surfaces: TextSurface[] = []
async function mountSurface(text: string, options: { readonly?: boolean } = {}) {
  const harness = makeHarness(text, options)
  const surface = new TextSurface()
  surfaces.push(surface)
  await surface.mount(harness.el, harness.ctx)
  // 必须返回同一个对象：spread 会复制 selections 字段，回调自增就统计不到了
  return Object.assign(harness, { surface })
}

afterEach(() => {
  for (const surface of surfaces) surface.unmount()
  surfaces.length = 0
  document.body.innerHTML = ''
})

const SAMPLE = ['# 标题', '', '一段正文，带 `代码` 与 **加粗**。', '', '- 甲', '- 乙', ''].join('\n')

describe('挂载与渲染', () => {
  it('1. 按 Markdown 结构渲染出标题、段落、列表', async () => {
    const h = await mountSurface(SAMPLE)
    expect(h.el.querySelector('h1')?.textContent).toBe('标题')
    expect(h.el.querySelectorAll('li').length).toBe(2)
    expect(h.el.classList.contains('kb-text-surface')).toBe(true)
  })

  it('2. 二进制 payload 不抛异常，降级成空文档', async () => {
    const harness = makeHarness('')
    // payload 在契约里是只读的：测试里显式造一份新的上下文，而不是改字段
    const ctx = {
      ...harness.ctx,
      document: { ...harness.ctx.document, payload: { kind: 'bytes' as const, bytes: new Uint8Array([1]), name: 'x.docx' } },
    }
    harness.ctx = ctx
    const surface = new TextSurface()
    surfaces.push(surface)
    await expect(surface.mount(harness.el, harness.ctx)).resolves.toBeUndefined()
    expect(surface.editorState).not.toBeNull()
  })

  it('3. 只读时 contenteditable=false', async () => {
    const h = await mountSurface(SAMPLE, { readonly: true })
    const prose = h.el.querySelector('.kb-text-prose') as HTMLElement
    expect(prose.getAttribute('contenteditable')).toBe('false')
  })
})

describe('保真快速路径', () => {
  it('4. 未改动时快照就是原始字符串（CRLF 与多余空行都原样）', async () => {
    const source = '# 标题\r\n\r\n正文\r\n\r\n'
    const h = await mountSurface(source)
    expect(h.snapshot()).toMatchObject({ kind: 'text', text: source, name: 'note.md' })
  })

  it('5. 编辑后才走序列化，且风格仍按既定契约（列表用 `-`）', async () => {
    const h = await mountSurface('# 标题\n\n- 甲\n')
    await h.surface.command({ id: 'c1', source: 'user', type: 'text.insert', args: { text: '新增' } })
    const saved = h.snapshot()
    expect(saved?.kind).toBe('text')
    const text = (saved as { text: string }).text
    expect(text).toContain('新增')
    expect(text).toContain('- 甲')
  })

  it('6. 撤销回到初始状态后，快照又变回原文（脏标记也回落）', async () => {
    const source = '# 标题\n\n正文\n'
    const h = await mountSurface(source)
    await h.surface.command({ id: 'c1', source: 'user', type: 'text.insert', args: { text: 'X' } })
    expect(h.dirty.at(-1)).toBe(true)
    // 输入后先提交历史步骤，再撤销
    await h.surface.command({ id: 'c2', source: 'user', type: 'undo' })
    expect((h.snapshot() as { text: string }).text).toBe(source)
    expect(h.dirty.at(-1)).toBe(false)
  })
})

describe('命令与查询', () => {
  it('7. text.replaceAll 整体替换内容', async () => {
    const h = await mountSurface('旧内容\n')
    const result = await h.surface.command({ id: 'c1', source: 'user', type: 'text.replaceAll', args: { text: '## 新标题\n' } })
    expect(result).toEqual({ ok: true })
    expect(h.el.querySelector('h2')?.textContent).toBe('新标题')
  })

  it('8. 不支持的命令返回失败原因而不是抛异常', async () => {
    const h = await mountSurface('内容\n')
    const result = await h.surface.command({ id: 'c1', source: 'user', type: 'sheet.insertRow' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('unsupported_command')
  })

  it('9. 字数统计按 CJK 口径累加', async () => {
    const h = await mountSurface('中文四个字\n\nhello world\n')
    expect(await h.surface.query({ type: 'wordCount' })).toMatchObject({ words: 7 })
  })

  it('10. 大纲返回标题层级与锚点', async () => {
    const h = await mountSurface('# 一级\n\n正文\n\n## 二级\n')
    const outline = (await h.surface.query({ type: 'outline' })) as { level: number; text: string; anchor: { block: string } }[]
    expect(outline.map((item) => [item.level, item.text])).toEqual([
      [1, '一级'],
      [2, '二级'],
    ])
    expect(outline[1].anchor.block).toBe('2')
  })

  it('11. 选区查询返回块路径与块内偏移', async () => {
    const h = await mountSurface('第一段\n\n第二段\n')
    const selection = (await h.surface.query({ type: 'selection' })) as { anchor: { block: string; offset: number } }
    expect(selection.anchor).toMatchObject({ block: '0', offset: 0 })
  })

  it('12. 全文查询返回当前序列化结果', async () => {
    const h = await mountSurface('- 甲\n- 乙\n')
    expect(await h.surface.query({ type: 'text' })).toBe('- 甲\n- 乙\n')
  })
})

describe('生命周期', () => {
  it('13. capture / restore 保留滚动位置', async () => {
    const h = await mountSurface('内容\n')
    const prose = h.el.querySelector('.kb-text-prose') as HTMLElement
    prose.scrollTop = 42
    const captured = h.surface.capture()
    expect(captured.kind).toBe('text')
    prose.scrollTop = 0
    h.surface.restore(captured)
    expect(prose.scrollTop).toBe(42)
  })

  it('14. 卸载后解绑快照提供者并销毁视图', async () => {
    const h = await mountSurface('内容\n')
    h.surface.unmount()
    surfaces.length = 0
    expect(h.snapshot()).toBeNull()
    expect(h.el.querySelector('.ProseMirror')).toBeNull()
    expect(h.el.classList.contains('kb-text-surface')).toBe(false)
  })

  it('15. 未挂载时命令与查询都是安全失败', async () => {
    const surface = new TextSurface()
    expect(await surface.command({ id: 'c', source: 'user', type: 'undo' })).toEqual({ ok: false, reason: 'surface_not_mounted' })
    expect(await surface.query({ type: 'wordCount' })).toBeNull()
    expect(() => surface.unmount()).not.toThrow()
  })

  it('16. 选择变化会通知上下文（不再自己维护一份选区）', async () => {
    const h = await mountSurface('内容比较多的一段\n')
    await h.surface.command({ id: 'c1', source: 'user', type: 'view.selectAll' })
    expect(h.selections).toBeGreaterThan(0)
  })
})
