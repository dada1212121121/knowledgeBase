import { describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { useDocLinks } from './useDocLinks'
import type { LinkContext } from '@/utils/links'

const ctx: LinkContext = {
  collection: 'proj',
  sourcePath: 'docs/a.md',
  rawUrl: (collection, path) => `/api/v1/raw?${new URLSearchParams({ collection, path }).toString()}`,
}

function mount(
  source: () => string,
  call: (name: string, args?: Record<string, unknown>, options?: { adminView?: string }) => Promise<unknown>,
  context: LinkContext = ctx,
  checkNotes = true,
) {
  const scope = effectScope()
  const result = scope.run(() => useDocLinks({ source, context: () => context, call, delay: 0, checkNotes }))!
  return { ...result, stop: () => scope.stop() }
}

describe('useDocLinks', () => {
  it('只把可解析的目标批量发出去,重复链接只查一次', async () => {
    const call = vi.fn(async () => ({
      items: [
        { collection: 'proj', path: 'docs/a.md', state: 'ok', size: 12, name: 'a.md' },
        { collection: 'proj', path: 'docs/b.md', state: 'missing' },
      ],
    }))
    const { report, stop } = mount(() => '[a](./a.md) [a again](./a.md) [b](./b.md)\n\n[外链](https://example.com)\n\n[D:\\x](D:\\x)', call)
    await vi.waitFor(() => expect(call).toHaveBeenCalled())
    expect(call).toHaveBeenCalledWith('check_links', {
      targets: [
        { collection: 'proj', path: 'docs/a.md' },
        { collection: 'proj', path: 'docs/b.md' },
      ],
    })
    expect(report.value.missing.map((item) => item.path)).toEqual(['docs/b.md'])
    // 回写坏引用需要原文,解析成目标后不能把 href 丢掉
    expect(report.value.missing[0].href).toBe('./b.md')
    expect(report.value.unsupported.map((item) => item.href)).toEqual(['D:\\x'])
    expect(report.value.checked).toBe(2)
    stop()
  })

  it('双链按 collection 根解析,笔记按 id 体检;管理员只读带 admin_view', async () => {
    const call = vi.fn(async () => ({
      items: [
        { kind: 'file', collection: 'proj', path: 'docs/规范.md', state: 'ok' },
        { kind: 'note', collection: 'proj', path: '', note_id: '01a19f63-f0ea-72fe-aa19-9998f6e2e5ad', state: 'missing', name: '旧笔记' },
      ],
    }))
    const admin = { ...ctx, adminView: 'alice' }
    const { report, stop } = mount(
      () => '[[docs/规范.md]] 和 [[01a19f63-f0ea-72fe-aa19-9998f6e2e5ad|旧笔记]]',
      call,
      admin,
    )
    await vi.waitFor(() => expect(report.value.checked).toBe(2))
    expect(call).toHaveBeenCalledWith(
      'check_links',
      {
        targets: [
          { collection: 'proj', path: 'docs/规范.md' },
          { note_id: '01a19f63-f0ea-72fe-aa19-9998f6e2e5ad' },
        ],
      },
      { adminView: 'alice' },
    )
    expect(report.value.missing.map((item) => item.noteId)).toEqual(['01a19f63-f0ea-72fe-aa19-9998f6e2e5ad'])
    expect(report.value.states['note\u000001a19f63-f0ea-72fe-aa19-9998f6e2e5ad']).toBe('missing')
    stop()
  })

  it('分享页不把笔记目标发出去', async () => {
    const call = vi.fn(async () => ({ items: [] }))
    const { report, stop } = mount(
      () => '[[docs/a.md]] 和 [[01a19f63-f0ea-72fe-aa19-9998f6e2e5ad]]',
      call,
      ctx,
      false,
    )
    await vi.waitFor(() => expect(report.value.checked).toBe(1))
    expect(call).toHaveBeenCalledWith('check_links', {
      targets: [{ collection: 'proj', path: 'docs/a.md' }],
    })
    stop()
  })

  it('后端没返回的目标记 unknown,不误报缺失', async () => {
    const call = vi.fn(async () => ({ items: [] }))
    const { report, stop } = mount(() => '[a](./a.md)', call)
    await vi.waitFor(() => expect(report.value.checked).toBe(1))
    expect(report.value.missing).toEqual([])
    expect(report.value.states[`proj\u0000docs/a.md`]).toBe('unknown')
    stop()
  })

  it('体检失败不抛出去,只记错误', async () => {
    const call = vi.fn(async () => {
      throw new Error('旧服务不支持')
    })
    const { report, stop } = mount(() => '[a](./a.md)', call)
    await vi.waitFor(() => expect(report.value.error).toContain('旧服务'))
    expect(report.value.missing).toEqual([])
    stop()
  })

  it('正文改成没有链接后,在途的旧结果不会把缺失横幅又带回来', async () => {
    let finish: ((value: unknown) => void) | undefined
    const call = vi.fn(() => new Promise((resolve) => (finish = resolve)))
    const source = ref('[a](./a.md)')
    const scope = effectScope()
    const { report } = scope.run(() => useDocLinks({ source: () => source.value, context: () => ctx, call, delay: 0 }))!
    await vi.waitFor(() => expect(call).toHaveBeenCalled())
    source.value = '没有链接了'
    await vi.waitFor(() => expect(report.value.checked).toBe(0))
    finish?.({ items: [{ collection: 'proj', path: 'docs/a.md', state: 'missing' }] })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(report.value.missing).toEqual([])
    scope.stop()
  })

  it('没有可检查的链接时不调用后端', async () => {
    const call = vi.fn(async () => ({ items: [] }))
    const { report, stop } = mount(() => '只有正文,没有链接', call)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(call).not.toHaveBeenCalled()
    expect(report.value.checked).toBe(0)
    stop()
  })
})
