/**
 * 笔记文本面：Markdown 源码模式
 *
 * 旧编辑器工具栏最右边的“源码”开关：在所见即所得与 Markdown 源码之间切换。
 * 关键约束：看一眼源码不能改写文档；改了源码退出后文档按新源码重建，且能撤销。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupText, mountText } from './textTestKit'

afterEach(cleanupText)

const toggle = (surface: { command: (c: { id: string; type: string; source: 'user' }) => Promise<{ ok: boolean; reason?: string }> }) =>
  surface.command({ id: 's', type: 'view.toggleSource', source: 'user' })
const text = async (surface: { query: (q: { type: string }) => Promise<unknown> }) => ((await surface.query({ type: 'text' })) as string).trim()

describe('源码模式', () => {
  it('1. 进入：显示当前正文的 Markdown，所见即所得隐藏；工具栏状态里 toggles 有 source', async () => {
    const { el, surface, view } = await mountText('# 标题\n\n**粗**')
    expect((await toggle(surface)).ok).toBe(true)
    const area = el.querySelector<HTMLTextAreaElement>('textarea.kb-text-source')!
    expect(area.value.trim()).toBe('# 标题\n\n**粗**')
    expect(view.dom.style.display).toBe('none')
    expect(((await surface.query({ type: 'formatState' })) as { toggles: string[] }).toggles).toEqual(['source'])
  })

  it('2. 看一眼就退出：文档一个字节都没变，也不脏', async () => {
    const { surface, dirty, view } = await mountText('# 标题\n\n**粗**  \n后')
    const before = view.state.doc
    await toggle(surface)
    await toggle(surface)
    expect(view.state.doc).toBe(before)
    expect(view.dom.style.display).toBe('')
    expect(dirty.includes(true)).toBe(false)
  })

  it('3. 改源码退出：文档按新源码重建（标题出现），保存拿到新源码；可以撤销', async () => {
    const { el, surface, view } = await mountText('正文')
    await toggle(surface)
    const area = el.querySelector<HTMLTextAreaElement>('textarea.kb-text-source')!
    area.value = '## 新标题\n\n- 一\n- 二'
    area.dispatchEvent(new Event('input'))
    await toggle(surface)
    expect(view.dom.querySelector('h2')?.textContent).toBe('新标题')
    expect(view.dom.querySelectorAll('li')).toHaveLength(2)
    expect(await text(surface)).toBe('## 新标题\n\n- 一\n- 二')
    await surface.command({ id: 'u', type: 'undo', source: 'user' })
    expect(await text(surface)).toBe('正文')
  })

  it('4. 在源码模式里保存/导出拿到的是正在编辑的源码，并且已经算“有改动”', async () => {
    const { el, surface, snapshot, dirty } = await mountText('正文')
    await toggle(surface)
    const area = el.querySelector<HTMLTextAreaElement>('textarea.kb-text-source')!
    area.value = '改过的源码'
    area.dispatchEvent(new Event('input'))
    expect(dirty.at(-1)).toBe(true)
    expect(snapshot()).toEqual({ kind: 'text', text: '改过的源码', name: 'note.md' })
    // 改回原文：不再算改动
    area.value = '正文'
    area.dispatchEvent(new Event('input'))
    expect(dirty.at(-1)).toBe(false)
  })

  it('5. frontmatter 和 CRLF 换行跟着源码走', async () => {
    const { el, surface } = await mountText('---\ntitle: x\n---\n\n正文')
    await toggle(surface)
    const area = el.querySelector<HTMLTextAreaElement>('textarea.kb-text-source')!
    expect(area.value).toContain('title: x')
    area.value = '---\ntitle: y\n---\n\n新正文'
    area.dispatchEvent(new Event('input'))
    await toggle(surface)
    expect(await text(surface)).toBe('---\ntitle: y\n---\n\n新正文')
  })

  it('6. 源码模式下查找替换不可用，说明原因；关闭查找仍可', async () => {
    const { surface } = await mountText('abc')
    await toggle(surface)
    const found = await surface.command({ id: 'f', type: 'search.set', args: { query: 'a' }, source: 'user' })
    expect(found.ok).toBe(false)
    expect(found.reason).toContain('源码模式')
    expect((await surface.command({ id: 'c', type: 'search.close', source: 'user' })).ok).toBe(true)
  })

  it('7. 变成只读时自动退出源码模式', async () => {
    const { el, surface } = await mountText('abc')
    await toggle(surface)
    surface.setReadonly(true)
    expect(el.querySelector('textarea.kb-text-source')).toBeNull()
  })

  it('8. 文本框里的 Ctrl+Z / Ctrl+F 不冒泡到 Host（用文本框自己的撤销栈），Ctrl+S 照常冒泡', async () => {
    const { el, surface } = await mountText('abc')
    await toggle(surface)
    const area = el.querySelector<HTMLTextAreaElement>('textarea.kb-text-source')!
    const seen: string[] = []
    document.addEventListener('keydown', (e) => seen.push(e.key))
    for (const key of ['z', 'f', 's']) area.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }))
    expect(seen).toEqual(['s'])
  })

  it('9. 不可编辑时进不去源码模式', async () => {
    const { surface } = await mountText('abc', { readonly: true })
    expect((await toggle(surface)).ok).toBe(false)
  })
})
