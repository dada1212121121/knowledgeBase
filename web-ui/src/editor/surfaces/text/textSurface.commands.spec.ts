/**
 * Text Surface 的 Chrome 命令集成测试
 *
 * 这里验证「Chrome 发出的命令 → 文档真的变了」这条链路：
 * 工具按钮、斜杠菜单、快捷键最终都调 `surface.command`，所以只要这一层覆盖到，
 * 换入口不会换行为。查找/替换还会读 Surface 的命中数据，确保 Chrome 上显示的数字不是编的。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { TextSurface } from '@/editor/surfaces/text/TextSurface'
import { TEXT_SLASH_ACTIONS } from '@/editor/extensions/builtin/text'
import type { CommandResult, DocumentSession, EditorSource, SurfaceContext } from '@/editor/types'

interface Harness {
  surface: TextSurface
  snapshot: () => string
  el: HTMLElement
  ctx: SurfaceContext
}

function makeHarness(text: string, options: { readonly?: boolean } = {}): Harness {
  let provider: (() => EditorSource | null) | null = null
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
  }
  const surface = new TextSurface({ slashActions: TEXT_SLASH_ACTIONS })
  return {
    surface,
    el,
    ctx,
    snapshot: () => {
      const source = provider?.()
      return source?.kind === 'text' ? source.text : ''
    },
  }
}

const surfaces: TextSurface[] = []

async function mount(text: string, options: { readonly?: boolean } = {}) {
  const harness = makeHarness(text, options)
  surfaces.push(harness.surface)
  await harness.surface.mount(harness.el, harness.ctx)
  return harness
}

afterEach(() => {
  for (const surface of surfaces) surface.unmount()
  surfaces.length = 0
  document.body.innerHTML = ''
})

/** 把光标放到文档开头（第一个文本块内） */
function caretStart(surface: TextSurface): void {
  const view = (surface as unknown as { view: import('prosemirror-view').EditorView }).view
  view.dispatch(view.state.tr.setSelection((view.state.selection.constructor as typeof import('prosemirror-state').TextSelection).create(view.state.doc, 1)))
  view.focus()
}

function cmd(surface: TextSurface, type: string, args?: unknown): Promise<CommandResult> {
  return surface.command({ id: `t_${type}`, type, args, source: 'user' })
}

describe('格式命令', () => {
  it('1. 加粗按钮 → 正文出现 ** 标记（序列化契约不变）', async () => {
    const h = await mount('正文')
    const view = (h.surface as unknown as { view: import('prosemirror-view').EditorView }).view
    view.dispatch(view.state.tr.setSelection((view.state.selection.constructor as typeof import('prosemirror-state').TextSelection).create(view.state.doc, 1, 3)))
    expect((await cmd(h.surface, 'mark.toggle', { mark: 'strong' })).ok).toBe(true)
    expect(h.snapshot()).toContain('**正文**')
  })

  it('2. 二级标题按钮 → formatState 立即反映，保存序列化为 ##', async () => {
    const h = await mount('正文')
    caretStart(h.surface)
    expect((await cmd(h.surface, 'block.setHeading', { level: 2 })).ok).toBe(true)
    const state = (await h.surface.query({ type: 'formatState' })) as { block: string; level?: number }
    expect(state.block).toBe('heading')
    expect(state.level).toBe(2)
    expect(h.snapshot().split('\n')[0]).toBe('## 正文')
  })

  it('3. 任务列表按钮 → 序列化成 `- [ ]`', async () => {
    const h = await mount('待办')
    caretStart(h.surface)
    expect((await cmd(h.surface, 'block.toggleTaskList')).ok).toBe(true)
    expect(h.snapshot()).toContain('- [ ]')
  })

  it('4. 表格按钮 → 生成管道表格；代码块按钮 → 围栏代码块', async () => {
    const h = await mount('正文')
    caretStart(h.surface)
    expect((await cmd(h.surface, 'block.insertTable', { rows: 2, cols: 2 })).ok).toBe(true)
    expect(h.snapshot()).toMatch(/\|\s*-{3,}\s*\|/)
    const h2 = await mount('正文')
    caretStart(h2.surface)
    expect((await cmd(h2.surface, 'block.insertCodeBlock')).ok).toBe(true)
    expect(h2.snapshot()).toContain('```')
  })

  it('5. 链接 / 图片命令写进正文', async () => {
    const h = await mount('正文')
    const view = (h.surface as unknown as { view: import('prosemirror-view').EditorView }).view
    view.dispatch(view.state.tr.setSelection((view.state.selection.constructor as typeof import('prosemirror-state').TextSelection).create(view.state.doc, 1, 3)))
    expect((await cmd(h.surface, 'text.link.apply', { href: './a.md' })).ok).toBe(true)
    expect(h.snapshot()).toContain('[正文](./a.md)')
    const h2 = await mount('正文')
    caretStart(h2.surface)
    expect((await cmd(h2.surface, 'insert.image', { src: './p.png', alt: '图' })).ok).toBe(true)
    expect(h2.snapshot()).toContain('![图](./p.png)')
  })
})

describe('查找 / 替换', () => {
  const DOC = ['甲甲甲', '', '乙甲', ''].join('\n')

  it('6. 查找上报真实总数与当前下标，next/prev 循环', async () => {
    const h = await mount(DOC)
    const first = (await cmd(h.surface, 'search.set', { query: '甲' })).data as { total: number; index: number }
    expect(first).toEqual({ query: '甲', total: 4, index: 0 })
    const next = (await cmd(h.surface, 'search.next')).data as { total: number; index: number }
    expect(next.index).toBe(1)
    const prev = (await cmd(h.surface, 'search.prev')).data as { index: number }
    expect(prev.index).toBe(0)
    // 从第一条再往前 → 绕到最后一条
    const wrapped = (await cmd(h.surface, 'search.prev')).data as { index: number }
    expect(wrapped.index).toBe(3)
  })

  it('7. 查找无结果时如实报 0，不保留旧命中', async () => {
    const h = await mount(DOC)
    await cmd(h.surface, 'search.set', { query: '甲' })
    const none = (await cmd(h.surface, 'search.set', { query: '丙' })).data as { total: number; index: number }
    expect(none).toEqual({ query: '丙', total: 0, index: -1 })
    expect((await h.surface.query({ type: 'search' })) as { total: number }).toMatchObject({ total: 0 })
  })

  it('8. 单次替换 → 只改一条，命中数减一', async () => {
    const h = await mount(DOC)
    await cmd(h.surface, 'search.set', { query: '甲' })
    const replaced = (await cmd(h.surface, 'search.replace', { text: '丙' })).data as { total: number }
    expect(replaced.total).toBe(3)
    expect(h.snapshot()).toBe('丙甲甲\n\n乙甲\n')
  })

  it('9. 全部替换 → 四条全改，查询串保留', async () => {
    const h = await mount(DOC)
    await cmd(h.surface, 'search.set', { query: '甲' })
    expect((await cmd(h.surface, 'search.replaceAll', { text: '丙' })).ok).toBe(true)
    expect(h.snapshot()).toBe('丙丙丙\n\n乙丙\n')
    const info = (await h.surface.query({ type: 'search' })) as { query: string; total: number }
    expect(info.query).toBe('甲')
    expect(info.total).toBe(0)
  })

  it('10. 没有命中时替换返回失败而不是静默成功', async () => {
    const h = await mount('正文')
    const result = await cmd(h.surface, 'search.replace', { text: 'x' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no_match')
  })
})

describe('斜杠菜单', () => {
  it('11. 行首输入 / 唤出菜单，继续输入会过滤', async () => {
    const h = await mount('')
    caretStart(h.surface)
    const view = (h.surface as unknown as { view: import('prosemirror-view').EditorView }).view
    view.dispatch(view.state.tr.insertText('/'))
    const all = (await h.surface.query({ type: 'slash' })) as { active: boolean; items: unknown[] }
    expect(all.active).toBe(true)
    expect(all.items.length).toBeGreaterThan(8)
    view.dispatch(view.state.tr.insertText('表'))
    const filtered = (await h.surface.query({ type: 'slash' })) as { query: string; items: { id: string }[] }
    expect(filtered.query).toBe('表')
    // 「表」会命中所有「列表」类动作；名字以它开头的「表格」排在最前面（回车选中的就是最像的那个）
    expect(filtered.items.map((item) => item.id)).toEqual(['table', 'bullet', 'ordered', 'task'])
    expect(filtered.query).toBe('表')
  })

  it('中文标点下的顿号「、」同样唤出菜单；拼音 / 首字母也能搜到', async () => {
    const h = await mount('')
    caretStart(h.surface)
    const view = (h.surface as unknown as { view: import('prosemirror-view').EditorView }).view
    view.dispatch(view.state.tr.insertText('、'))
    expect(((await h.surface.query({ type: 'slash' })) as { active: boolean }).active).toBe(true)
    view.dispatch(view.state.tr.insertText('bg'))
    const byInitials = (await h.surface.query({ type: 'slash' })) as { items: { id: string }[] }
    expect(byInitials.items[0]?.id).toBe('table')
    view.dispatch(view.state.tr.delete(2, 4).insertText('daima', 2))
    const byPinyin = (await h.surface.query({ type: 'slash' })) as { items: { id: string }[] }
    expect(byPinyin.items[0]?.id).toBe('codeblock')
    // 正文里的顿号（不在段首）不弹菜单
    const other = await mount('苹果')
    const otherView = (other.surface as unknown as { view: import('prosemirror-view').EditorView }).view
    otherView.dispatch(otherView.state.tr.insertText('、'))
    expect(((await other.surface.query({ type: 'slash' })) as { active: boolean }).active).toBe(false)
  })

  it('12. 执行菜单项：删掉 `/查询` 再插入内容', async () => {
    const h = await mount('')
    caretStart(h.surface)
    const view = (h.surface as unknown as { view: import('prosemirror-view').EditorView }).view
    view.dispatch(view.state.tr.insertText('/h2'))
    expect((await cmd(h.surface, 'slash.run', { id: 'heading.2' })).ok).toBe(true)
    expect(h.snapshot()).toBe('##\n')
    expect((await h.surface.query({ type: 'slash' })) as { active: boolean }).toMatchObject({ active: false })
  })

  it('13. 只在行首触发：正文中间的 / 不弹菜单', async () => {
    const h = await mount('正文')
    const view = (h.surface as unknown as { view: import('prosemirror-view').EditorView }).view
    view.dispatch(view.state.tr.insertText('/'))
    expect((await h.surface.query({ type: 'slash' })) as { active: boolean }).toMatchObject({ active: false })
  })

  it('14. 只读时菜单不可用', async () => {
    const h = await mount('', { readonly: true })
    const view = (h.surface as unknown as { view: import('prosemirror-view').EditorView }).view
    view.dispatch(view.state.tr.insertText('/'))
    expect((await h.surface.query({ type: 'slash' })) as { active: boolean }).toMatchObject({ active: false })
  })
})

describe('大纲跳转', () => {
  it('15. nav.anchor 把选区放到对应标题上', async () => {
    const h = await mount('# 一\n\n正文\n\n## 二\n\n尾')
    const outline = (await h.surface.query({ type: 'outline' })) as { level: number; text: string; anchor: unknown }[]
    expect(outline.map((item) => item.text)).toEqual(['一', '二'])
    expect((await cmd(h.surface, 'nav.anchor', { anchor: outline[1].anchor })).ok).toBe(true)
    const selection = (await h.surface.query({ type: 'selection' })) as { anchor: { block: string } }
    const blockStart = outline[1].anchor as { block: string }
    expect(selection.anchor.block.startsWith(blockStart.block)).toBe(true)
  })
})
