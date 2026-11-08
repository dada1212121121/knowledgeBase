/**
 * Text Surface 可访问性契约
 *
 * 这里守的是「结构语义」，不是像素：
 * - 可编辑区必须是 textbox + 多行，读屏才知道这是正文；
 * - Markdown 的标题 / 表格表头 / 图片替代文本 / 任务复选框都要保留可访问语义；
 * - 复选框没有可见文字，必须有可访问名称，否则读屏只会念「复选框」。
 * 颜色对比、焦点顺序等整页问题交给 e2e 的 axe；这里用 jsdom 能稳定断言的部分做回归。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { TextSurface } from '@/editor/surfaces/text/TextSurface'
import type { DocumentSession, SurfaceContext } from '@/editor/types'

const surfaces: TextSurface[] = []

async function mount(text: string): Promise<HTMLElement> {
  const el = document.createElement('div')
  document.body.append(el)
  const session = { setSnapshotProvider: () => undefined } as unknown as DocumentSession
  const ctx: SurfaceContext = {
    session,
    document: { kind: 'text', format: 'md', revision: 1, payload: { kind: 'text', text, name: 'a11y.md' } },
    permissions: { read: true, write: true, comment: true, ai: true, export: true },
    readonly: false,
    onDirtyChange: () => undefined,
    onSelectionChange: () => undefined,
  }
  const surface = new TextSurface()
  surfaces.push(surface)
  await surface.mount(el, ctx)
  return el
}

afterEach(() => {
  for (const surface of surfaces) surface.unmount()
  surfaces.length = 0
  document.body.innerHTML = ''
})

describe('Text Surface 可访问性', () => {
  it('1. 可编辑区暴露 textbox / aria-multiline / 正文名称', async () => {
    const el = await mount('# 标题\n\n正文')
    const box = el.querySelector<HTMLElement>('[contenteditable="true"]')
    expect(box).not.toBeNull()
    expect(box?.getAttribute('role')).toBe('textbox')
    expect(box?.getAttribute('aria-multiline')).toBe('true')
    expect(box?.getAttribute('aria-label')).toBe('文档正文')
  })

  it('2. Markdown 标题保留 h1~h6 语义，不渲染成样式化的 div', async () => {
    const el = await mount('# 一级\n\n## 二级\n\n### 三级')
    expect(el.querySelector('h1')?.textContent).toBe('一级')
    expect(el.querySelector('h2')?.textContent).toBe('二级')
    expect(el.querySelector('h3')?.textContent).toBe('三级')
  })

  it('3. 表格保留 th / td 与表头单元格', async () => {
    const el = await mount('| 名称 | 值 |\n|---|---|\n| A | 1 |')
    expect(el.querySelectorAll('table th').length).toBe(2)
    expect(el.querySelectorAll('table td').length).toBe(2)
  })

  it('4. 图片带 alt 属性（无说明时是空字符串，读屏可跳过）', async () => {
    const el = await mount('![架构图](kb://img/a.png)\n\n![](kb://img/deco.png)')
    const images = [...el.querySelectorAll('img[src]')]
    expect(images.length).toBe(2)
    expect(images[0]?.getAttribute('alt')).toBe('架构图')
    expect(images[1]?.hasAttribute('alt')).toBe(true)
    expect(images[1]?.getAttribute('alt')).toBe('')
  })

  it('5. 任务复选框用条目正文做可访问名称，并暴露勾选状态', async () => {
    const el = await mount('- [x] 发布门禁\n- [ ] 补文档')
    const boxes = [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes.length).toBe(2)
    expect(boxes[0]?.getAttribute('aria-label')).toBe('发布门禁')
    expect(boxes[0]?.checked).toBe(true)
    expect(boxes[1]?.getAttribute('aria-label')).toBe('补文档')
    expect(boxes[1]?.checked).toBe(false)
  })
})
