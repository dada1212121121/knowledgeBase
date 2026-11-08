/**
 * 扩展注册表： 新增的注册点与可选字段的契约测试
 *
 * 新增（都是可选字段 / 新方法，api_version 仍是 1）：
 * - `registerStatusItem`：状态栏项（顶栏 / 底部状态栏的计数等）；
 * - `ToolbarItemSpec` 的 `formats` / `profile` / `placement` / `capability` / `compact`，以及按钮的 `children` / `choices` / `check` 等动作字段；
 * - `AIToolSpec.target = 'page'` 与 `HostApi.page`：宿主页面通道，只有内置扩展有。
 */
import { describe, expect, it } from 'vitest'
import { defineExtension } from '../api'
import type { EditorExtension, ExtensionContext, StatusState } from './api'
import { ExtensionRegistry, ExtensionRegistryError } from './registry'
import { fakeBinding, manifestFor, type ManifestInit } from './__fixtures__/testkit'

function makeRegistry() {
  const errors: unknown[] = []
  return { registry: new ExtensionRegistry({ onError: (_manifest, error) => errors.push(error) }), errors }
}

async function install(registry: ExtensionRegistry, init: ManifestInit, activate: (ctx: ExtensionContext) => void | Promise<void>, extra: Partial<EditorExtension> = {}) {
  await registry.install(manifestFor(init), defineExtension({ activate, ...extra }))
}

const STATE: StatusState = { kind: 'text', format: 'md', words: 5, unitLabel: '', readonly: false, dirty: false, phase: 'ready' }

describe('状态栏项（registerStatusItem）', () => {
  it('1. 注册 → 求值 → 卸载：按区域与内容面过滤，空文字不显示，卸载全部回收', async () => {
    const { registry } = makeRegistry()
    await install(
      registry,
      { id: 'kb.st', permissions: ['ui'], contributes: { toolbar: [{ id: 'kb.st.words' }, { id: 'kb.st.grid' }] } },
      (ctx) => {
        ctx.registerStatusItem({ id: 'kb.st.words', area: 'status', title: '字数', text: (state) => (state.words > 0 ? `${state.words} 词` : '') })
        ctx.registerStatusItem({ id: 'kb.st.grid', area: 'chrome', kinds: ['grid'], text: () => '表格' })
      },
    )
    expect(registry.statusTexts('text', 'status', STATE)).toEqual([{ id: 'kb.st.words', extensionId: 'kb.st', text: '5 词', title: '字数' }])
    // 顶栏区域只有 grid 的那一项；文本面不显示
    expect(registry.statusTexts('text', 'chrome', STATE)).toEqual([])
    expect(registry.statusTexts('grid', 'chrome', { ...STATE, kind: 'grid' }).map((item) => item.text)).toEqual(['表格'])
    // 文字为空串时这一项不显示
    expect(registry.statusTexts('text', 'status', { ...STATE, words: 0 })).toEqual([])
    expect(registry.statusItemsFor('text', 'status').map((entry) => entry.spec.id)).toEqual(['kb.st.words'])
    await registry.uninstall('kb.st')
    expect(registry.statusTexts('text', 'status', STATE)).toEqual([])
    expect(registry.statusItemsFor('grid', 'chrome')).toEqual([])
  })

  it('2. 需要 ui 权限；必须在清单 toolbar 里声明；没有 text 函数被拒', async () => {
    const { registry } = makeRegistry()
    await expect(install(registry, { id: 'kb.s1', contributes: { toolbar: [{ id: 'kb.s1.a' }] } }, (ctx) => void ctx.registerStatusItem({ id: 'kb.s1.a', text: () => 'x' }))).rejects.toMatchObject({
      cause: { name: 'PermissionDeniedError', permission: 'ui' },
    })
    await expect(install(registry, { id: 'kb.s2', permissions: ['ui'] }, (ctx) => void ctx.registerStatusItem({ id: 'kb.s2.a', text: () => 'x' }))).rejects.toMatchObject({
      cause: { code: 'undeclared' },
    })
    await expect(
      install(registry, { id: 'kb.s3', permissions: ['ui'], contributes: { toolbar: [{ id: 'kb.s3.a' }] } }, (ctx) => void ctx.registerStatusItem({ id: 'kb.s3.a' } as never)),
    ).rejects.toMatchObject({ cause: { code: 'invalid' } })
    expect(registry.list()).toEqual([])
  })

  it('3. 同 id 同区域的作用范围重叠才算冲突；不重叠（不同内容面 / 不同区域）可以并存', async () => {
    const { registry } = makeRegistry()
    await install(registry, { id: 'kb.s4', permissions: ['ui'], contributes: { toolbar: [{ id: 'kb.s4.a' }] } }, (ctx) => {
      ctx.registerStatusItem({ id: 'kb.s4.a', kinds: ['text'], text: () => 't' })
      ctx.registerStatusItem({ id: 'kb.s4.a', kinds: ['grid'], text: () => 'g' })
      expect(() => ctx.registerStatusItem({ id: 'kb.s4.a', kinds: ['text', 'code'], text: () => 'dup' })).toThrow(/已经被注册/)
      ctx.registerStatusItem({ id: 'kb.s4.a', area: 'chrome', kinds: ['text'], text: () => 'c' })
    })
    expect(registry.statusTexts('text', 'status', STATE).map((item) => item.text)).toEqual(['t'])
    expect(registry.statusTexts('text', 'chrome', STATE).map((item) => item.text)).toEqual(['c'])
  })

  it('4. text 抛错只让这一项不显示（记录错误），不拖垮其它项；refresh() 让界面重新取值', async () => {
    const { registry, errors } = makeRegistry()
    let counter = 0
    let handle: { refresh(): void } | undefined
    await install(
      registry,
      { id: 'kb.s5', permissions: ['ui'], contributes: { toolbar: [{ id: 'kb.s5.bad' }, { id: 'kb.s5.ok' }] } },
      (ctx) => {
        ctx.registerStatusItem({
          id: 'kb.s5.bad',
          text: () => {
            throw new Error('炸了')
          },
        })
        handle = ctx.registerStatusItem({ id: 'kb.s5.ok', text: () => `n=${counter}` })
      },
    )
    expect(registry.statusTexts('text', 'status', STATE).map((item) => item.text)).toEqual(['n=0'])
    expect(errors).toHaveLength(1)
    // 扩展自己的数据变了：refresh 让订阅者（界面）重新取值
    const before = registry.version
    counter = 3
    handle!.refresh()
    expect(registry.version).toBe(before + 1)
    expect(registry.statusTexts('text', 'status', STATE).map((item) => item.text)).toEqual(['n=3'])
  })

  it('5. 返回的句柄可以单独撤销；扩展卸载后 refresh 不再通知', async () => {
    const { registry } = makeRegistry()
    let handle: ReturnType<ExtensionContext['registerStatusItem']> | undefined
    await install(registry, { id: 'kb.s6', permissions: ['ui'], contributes: { toolbar: [{ id: 'kb.s6.a' }] } }, (ctx) => {
      handle = ctx.registerStatusItem({ id: 'kb.s6.a', text: () => 'x' })
    })
    handle!.dispose()
    handle!.dispose()
    expect(registry.statusTexts('text', 'status', STATE)).toEqual([])
    await registry.uninstall('kb.s6')
    const before = registry.version
    handle!.refresh()
    expect(registry.version).toBe(before)
  })
})

describe('工具栏按钮的新增可选字段', () => {
  const decl = (...ids: string[]) => ({ commands: [{ id: 'kb.t.run', title: 'r' }], toolbar: ids.map((id) => ({ id })) })

  it('6. formats / profile 限定按钮出现的格式与工具栏方案；placement 把按钮分到顶栏操作区', async () => {
    const { registry } = makeRegistry()
    await install(registry, { id: 'kb.t', permissions: ['ui'], contributes: decl('kb.t.csv', 'kb.t.edit', 'kb.t.bar') }, (ctx) => {
      ctx.registerCommand('kb.t.run', () => undefined)
      ctx.registerToolbarItem({ id: 'kb.t.csv', label: 'c', command: 'kb.t.run', kinds: ['grid'], formats: ['CSV', 'tsv'] })
      ctx.registerToolbarItem({ id: 'kb.t.edit', label: 'e', command: 'kb.t.run', kinds: ['page'], profile: 'edit' })
      ctx.registerToolbarItem({ id: 'kb.t.bar', label: 'b', command: 'kb.t.run', placement: 'bar', capability: 'export' })
    })
    const ids = (list: { spec: { id: string } }[]) => list.map((entry) => entry.spec.id)
    expect(ids(registry.toolbarItemsFor('grid', { format: 'csv' }))).toEqual(['kb.t.csv'])
    expect(ids(registry.toolbarItemsFor('grid', { format: '.TSV' }))).toEqual(['kb.t.csv'])
    expect(ids(registry.toolbarItemsFor('grid', { format: 'xlsx' }))).toEqual([])
    // 要求格式的按钮在不知道格式时不出现（宁可少显示，也不在不支持的格式上放会失败的按钮）
    expect(ids(registry.toolbarItemsFor('grid'))).toEqual([])
    expect(ids(registry.toolbarItemsFor('page'))).toEqual([])
    expect(ids(registry.toolbarItemsFor('page', { profile: 'edit' }))).toEqual(['kb.t.edit'])
    // 顶栏操作区的按钮不出现在格式工具栏里，反之亦然
    expect(ids(registry.toolbarItemsFor('text'))).toEqual([])
    expect(ids(registry.barItemsFor('text'))).toEqual(['kb.t.bar'])
    expect(ids(registry.barItemsFor('grid', { format: 'csv' }))).toEqual(['kb.t.bar'])
  })

  it('7. 同 id 可以为不重叠的范围各注册一次；范围重叠仍然冲突（内置的「查找」靠这个在各内容面上并存）', async () => {
    const { registry } = makeRegistry()
    await install(registry, { id: 'kb.t', permissions: ['ui'], contributes: decl('kb.t.a') }, (ctx) => {
      ctx.registerCommand('kb.t.run', () => undefined)
      ctx.registerToolbarItem({ id: 'kb.t.a', label: 'text', command: 'kb.t.run', kinds: ['text'] })
      ctx.registerToolbarItem({ id: 'kb.t.a', label: 'code', command: 'kb.t.run', kinds: ['code'] })
      ctx.registerToolbarItem({ id: 'kb.t.a', label: 'page-edit', command: 'kb.t.run', kinds: ['page'], profile: 'edit' })
      ctx.registerToolbarItem({ id: 'kb.t.a', label: 'page-default', command: 'kb.t.run', kinds: ['page'], profile: 'default' })
      ctx.registerToolbarItem({ id: 'kb.t.a', label: 'csv', command: 'kb.t.run', kinds: ['grid'], formats: ['csv'] })
      ctx.registerToolbarItem({ id: 'kb.t.a', label: 'xlsx', command: 'kb.t.run', kinds: ['grid'], formats: ['xlsx'] })
      ctx.registerToolbarItem({ id: 'kb.t.a', label: 'bar', command: 'kb.t.run', placement: 'bar' })
      expect(() => ctx.registerToolbarItem({ id: 'kb.t.a', label: 'dup', command: 'kb.t.run', kinds: ['text', 'pdf'] })).toThrow(/已经被注册/)
      expect(() => ctx.registerToolbarItem({ id: 'kb.t.a', label: 'dup2', command: 'kb.t.run' })).toThrow(/已经被注册/)
      expect(() => ctx.registerToolbarItem({ id: 'kb.t.a', label: 'dup3', command: 'kb.t.run', kinds: ['grid'] })).toThrow(/已经被注册/)
    })
    expect(registry.toolbarItemsFor('text').map((entry) => entry.spec.label)).toEqual(['text'])
    expect(registry.toolbarItemsFor('page', { profile: 'edit' }).map((entry) => entry.spec.label)).toEqual(['page-edit'])
    expect(registry.toolbarItemsFor('page').map((entry) => entry.spec.label)).toEqual(['page-default'])
    expect(registry.toolbarItemsFor('grid', { format: 'xlsx' }).map((entry) => entry.spec.label)).toEqual(['xlsx'])
  })

  it('8. 下拉子项也只能触发本扩展声明的命令；下拉只有一层；children 与 choices 不能同时有', async () => {
    const { registry } = makeRegistry()
    const base = { id: 'kb.t', permissions: ['ui' as const], contributes: decl('kb.t.drop') }
    const child = { id: 'kb.t.c1', label: '子', command: 'kb.t.run' }
    await expect(
      install(registry, base, (ctx) => {
        ctx.registerCommand('kb.t.run', () => undefined)
        ctx.registerToolbarItem({ id: 'kb.t.drop', label: '下拉', command: 'kb.t.run', children: [{ ...child, command: 'mark.toggle' }] })
      }),
    ).rejects.toMatchObject({ cause: { code: 'undeclared' } })
    await expect(
      install(registry, base, (ctx) => {
        ctx.registerCommand('kb.t.run', () => undefined)
        ctx.registerToolbarItem({ id: 'kb.t.drop', label: '下拉', command: 'kb.t.run', children: [{ ...child, children: [child] }] })
      }),
    ).rejects.toMatchObject({ cause: { code: 'invalid', message: expect.stringContaining('只支持一层') } })
    await expect(
      install(registry, base, (ctx) => {
        ctx.registerCommand('kb.t.run', () => undefined)
        ctx.registerToolbarItem({ id: 'kb.t.drop', label: '下拉', command: 'kb.t.run', children: [child, child] })
      }),
    ).rejects.toMatchObject({ cause: { code: 'invalid', message: expect.stringContaining('重复') } })
    await expect(
      install(registry, base, (ctx) => {
        ctx.registerCommand('kb.t.run', () => undefined)
        ctx.registerToolbarItem({ id: 'kb.t.drop', label: '下拉', command: 'kb.t.run', children: [child], choices: [{ label: 'x', args: 1 }] })
      }),
    ).rejects.toMatchObject({ cause: { code: 'invalid' } })
    // 合法：带子项的下拉
    await install(registry, base, (ctx) => {
      ctx.registerCommand('kb.t.run', () => undefined)
      ctx.registerToolbarItem({ id: 'kb.t.drop', label: '下拉', command: 'kb.t.run', children: [child] })
    })
    expect(registry.toolbarItemsFor('text')[0]!.spec.children).toEqual([child])
  })
})

describe('宿主页面通道（api.page）与 target: "page" 的 AI 工具：只有内置扩展', () => {
  it('9. 内置扩展的命令能经 api.page 把事件交给当前编辑器；第三方拿到的 api.page 是 undefined', async () => {
    const { registry } = makeRegistry()
    const received: unknown[] = []
    const binding = { ...fakeBinding(), emitToPage: (event: string, payload?: unknown) => void received.push([event, payload]) }
    registry.attachHost(binding)
    let seenByThird: unknown = 'unset'
    registry.installBuiltin(manifestFor({ id: 'kb.builtin.page-test', permissions: ['ui'] }), {
      activate: (ctx) => void ctx.registerCommand('page.test', (_args, api) => api.page?.emit('export', { n: 1 })),
    })
    await install(registry, { id: 'kb.third', permissions: ['ui'], contributes: { commands: [{ id: 'kb.third.run', title: 'r' }] } }, (ctx) => {
      ctx.registerCommand('kb.third.run', (_args, api) => {
        seenByThird = api.page
        api.page?.emit('export')
      })
    })
    expect(await registry.runCommand('page.test', undefined, binding)).toEqual({ ok: true })
    expect(received).toEqual([['export', { n: 1 }]])
    expect(await registry.runCommand('kb.third.run', undefined, binding)).toEqual({ ok: true })
    expect(seenByThird).toBeUndefined()
    expect(received).toHaveLength(1)
  })

  it('10. 没有编辑器时 emit 什么也不做，不抛', async () => {
    const { registry } = makeRegistry()
    registry.installBuiltin(manifestFor({ id: 'kb.builtin.page-test', permissions: ['ui'] }), {
      activate: (ctx) => void ctx.registerCommand('page.test', (_args, api) => api.page?.emit('comment')),
    })
    expect(await registry.runCommand('page.test', undefined, null)).toEqual({ ok: true })
  })

  it('11. target: "page" 的 AI 工具第三方不能注册；内置的可以，查询里带 target', async () => {
    const { registry } = makeRegistry()
    await expect(
      install(registry, { id: 'kb.ai', permissions: ['ai'], contributes: { aiTools: [{ id: 'kb.ai.t', title: '工具' }] } }, (ctx) => {
        ctx.registerAITool({ id: 'kb.ai.t', title: '工具', target: 'page', run: () => '' })
      }),
    ).rejects.toMatchObject({ cause: { code: 'invalid', message: expect.stringContaining('只有内置扩展可用') } })
    registry.installBuiltin(manifestFor({ id: 'kb.builtin.ai-test', permissions: ['ai', 'document.read'] }), {
      activate: (ctx) => void ctx.registerAITool({ id: 'polish', title: '润色', target: 'page', run: () => '' }),
    })
    await install(registry, { id: 'kb.ai2', permissions: ['ai'], contributes: { aiTools: [{ id: 'kb.ai2.t', title: '工具' }] } }, (ctx) => {
      ctx.registerAITool({ id: 'kb.ai2.t', title: '工具', run: () => 'x' })
    })
    expect(registry.aiTools().map((tool) => [tool.id, tool.target])).toEqual([
      ['polish', 'page'],
      ['kb.ai2.t', 'suggestion'],
    ])
  })

  it('12. 卸载后旧上下文里的 page 通道失效（和其它 API 一样抛 disposed）', async () => {
    const { registry } = makeRegistry()
    const binding = { ...fakeBinding(), emitToPage: () => undefined }
    registry.attachHost(binding)
    let leaked: ExtensionContext | undefined
    registry.installBuiltin(manifestFor({ id: 'kb.builtin.leak', permissions: ['ui'] }), {
      activate: (ctx) => {
        leaked = ctx
      },
    })
    await registry.uninstall('kb.builtin.leak')
    expect(() => leaked!.page?.emit('export')).toThrow(ExtensionRegistryError)
  })
})
