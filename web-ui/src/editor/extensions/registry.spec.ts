/**
 * 扩展注册表
 *
 * 逐条钉住设计规范的契约测试要求：注册、命令、权限拒绝、卸载，
 * 外加幂等、回收、`document.write` 确认流程、AI 工具、Codec / 内容面的格式协商。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineExtension } from '../api'
import type { EditorExtension, ExtensionContext, Permission } from './api'
import { PermissionDeniedError } from './permissions'
import { ExtensionRegistry, ExtensionRegistryError } from './registry'
import { hasSurface, loadSurface, resetSurfaceRegistry } from '../surfaces/registry'
import type { Surface } from '../types'
import { fakeBinding, manifestFor, settle, type ManifestInit } from './__fixtures__/testkit'
import { overreachAttempts, overreachExtension } from './__fixtures__/overreach'

afterEach(() => resetSurfaceRegistry())

function makeRegistry(options: ConstructorParameters<typeof ExtensionRegistry>[0] = {}) {
  const errors: unknown[] = []
  const registry = new ExtensionRegistry({ onError: (_manifest, error) => errors.push(error), ...options })
  return { registry, errors }
}

/** 装一个只在 activate 里做点事的扩展 */
async function install(registry: ExtensionRegistry, init: ManifestInit, activate: (ctx: ExtensionContext) => void | Promise<void>, extra: Partial<EditorExtension> = {}) {
  const extension = defineExtension({ activate, ...extra })
  await registry.install(manifestFor(init), extension)
  return extension
}

const noop = () => undefined

// ---------------------------------------------------------------- 安装 / 卸载

describe('安装与卸载', () => {
  it('1. 注册的命令、工具栏、斜杠、面板、AI 工具都能从查询接口读到', async () => {
    const { registry } = makeRegistry()
    await install(
      registry,
      {
        id: 'kb.all',
        permissions: ['ui', 'ai', 'document.read'],
        contributes: {
          commands: [{ id: 'kb.all.run', title: '运行' }],
          toolbar: [{ id: 'kb.all.button' }],
          slash: [{ id: 'kb.all.slash' }],
          panels: [{ id: 'kb.all.panel', title: '面板', icon: '∑' }],
          aiTools: [{ id: 'kb.all.ai', title: '改写' }],
        },
      },
      (ctx) => {
        ctx.registerCommand('kb.all.run', noop)
        ctx.registerToolbarItem({ id: 'kb.all.button', label: '运行', command: 'kb.all.run' })
        ctx.registerSlashItem({ id: 'kb.all.slash', label: '运行', command: 'kb.all.run' })
        ctx.registerPanel({ id: 'kb.all.panel', title: '面板', icon: '∑', mount: noop })
        ctx.registerAITool({ id: 'kb.all.ai', title: '改写', run: () => 'x' })
      },
    )
    expect(registry.isInstalled('kb.all')).toBe(true)
    expect(registry.hasCommand('kb.all.run')).toBe(true)
    expect(registry.toolbarItemsFor('text').map((item) => item.spec.id)).toEqual(['kb.all.button'])
    expect(registry.slashItemsFor('text').map((item) => item.spec.id)).toEqual(['kb.all.slash'])
    expect(registry.panels('text')).toEqual([{ key: 'kb.all:kb.all.panel', id: 'kb.all.panel', extensionId: 'kb.all', title: '面板', icon: '∑' }])
    expect(registry.aiTools()).toEqual([{ id: 'kb.all.ai', extensionId: 'kb.all', title: '改写', target: 'suggestion' }])
    expect(registry.list().map((item) => [item.manifest.id, item.builtin])).toEqual([['kb.all', false]])
  })

  it('2. 卸载回收全部贡献：七类注册 + 文档订阅 + subscriptions，重复卸载返回 false', async () => {
    const { registry } = makeRegistry()
    const cleaned: string[] = []
    const binding = fakeBinding()
    registry.attachHost(binding)
    await install(
      registry,
      {
        id: 'kb.all',
        permissions: ['ui', 'ai', 'document.read', 'document.write'],
        contributes: {
          commands: [{ id: 'kb.all.run', title: '运行' }],
          toolbar: [{ id: 'kb.all.button' }],
          slash: [{ id: 'kb.all.slash' }],
          panels: [{ id: 'kb.all.panel', title: '面板' }],
          codecs: [{ id: 'kb.all.codec', extensions: ['foo'] }],
          surfaces: [{ id: 'kb.all.surface', extensions: ['bar'] }],
          aiTools: [{ id: 'kb.all.ai', title: '改写' }],
        },
      },
      (ctx) => {
        ctx.registerCommand('kb.all.run', noop)
        ctx.registerToolbarItem({ id: 'kb.all.button', label: '运行', command: 'kb.all.run' })
        ctx.registerSlashItem({ id: 'kb.all.slash', label: '运行', command: 'kb.all.run' })
        ctx.registerPanel({ id: 'kb.all.panel', title: '面板', mount: noop })
        ctx.registerCodec({ id: 'kb.all.codec', decode: () => ({ kind: 'text', text: '', name: 'a.foo' }), encode: () => new Uint8Array() })
        ctx.registerSurface({ id: 'kb.all.surface', create: () => ({}) as Surface })
        ctx.registerAITool({ id: 'kb.all.ai', title: '改写', run: () => 'x' })
        ctx.document.onChange(() => cleaned.push('change'))
        ctx.subscriptions.add(() => cleaned.push('sub-fn'))
        ctx.subscriptions.add({ dispose: () => cleaned.push('sub-obj') })
      },
    )
    expect(registry.codecFor('foo')).not.toBeNull()
    expect(registry.surfaceFor('bar')).not.toBeNull()
    expect(hasSurface('ext:kb.all.surface')).toBe(true)

    expect(await registry.uninstall('kb.all')).toBe(true)
    expect(registry.isInstalled('kb.all')).toBe(false)
    expect(registry.hasCommand('kb.all.run')).toBe(false)
    expect(registry.toolbarItemsFor('text')).toEqual([])
    expect(registry.slashItemsFor('text')).toEqual([])
    expect(registry.panels('text')).toEqual([])
    expect(registry.aiTools()).toEqual([])
    expect(registry.codecFor('foo')).toBeNull()
    expect(registry.surfaceFor('bar')).toBeNull()
    expect(registry.resolveKind('x.foo')).toBeNull()
    expect(hasSurface('ext:kb.all.surface')).toBe(false)
    expect(cleaned.sort()).toEqual(['sub-fn', 'sub-obj'])
    // 文档订阅也撤了：之后再发变更通知不会触达已卸载的扩展
    registry.emitChange(binding)
    expect(cleaned).not.toContain('change')

    expect(await registry.uninstall('kb.all')).toBe(false)
    expect(await registry.uninstall('kb.never')).toBe(false)
  })

  it('3. 同 id 重复安装是幂等的：先卸载旧的（含它的 deactivate），只留最后一次', async () => {
    const { registry } = makeRegistry()
    const calls: string[] = []
    const init: ManifestInit = { id: 'kb.dup', contributes: { commands: [{ id: 'kb.dup.run', title: '运行' }] } }
    for (const round of [1, 2, 3]) {
      await install(
        registry,
        init,
        (ctx) => {
          calls.push(`activate${round}`)
          ctx.registerCommand('kb.dup.run', () => {
            calls.push(`run${round}`)
          })
        },
        { deactivate: () => void calls.push(`deactivate${round}`) },
      )
    }
    expect(calls).toEqual(['activate1', 'deactivate1', 'activate2', 'deactivate2', 'activate3'])
    expect(registry.list()).toHaveLength(1)
    await registry.runCommand('kb.dup.run', undefined)
    expect(calls.at(-1)).toBe('run3')
  })

  it('4. 并发安装同一个 id：不会留下两份，旧的启动期间被顶掉会报 stale', async () => {
    const { registry } = makeRegistry()
    let release: () => void = noop
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const init: ManifestInit = { id: 'kb.race', contributes: { commands: [{ id: 'kb.race.run', title: '运行' }] } }
    const slow = registry.install(
      manifestFor(init),
      defineExtension({
        async activate(ctx) {
          await gate
          ctx.registerCommand('kb.race.run', noop) // 此时已被顶掉：必须失败，不能悄悄注册
        },
      }),
    )
    await settle()
    const fast = registry.install(manifestFor(init), defineExtension({ activate: (ctx) => void ctx.registerCommand('kb.race.run', noop) }))
    await settle()
    release()
    await expect(slow).rejects.toMatchObject({ code: 'activation' })
    await fast
    expect(registry.list()).toHaveLength(1)
    expect(registry.hasCommand('kb.race.run')).toBe(true)
  })

  it('5. 启动失败：回滚已注册的一切，抛 activation 错误，不留半个扩展', async () => {
    const { registry } = makeRegistry()
    await expect(
      install(
        registry,
        { id: 'kb.bad', permissions: ['ui'], contributes: { commands: [{ id: 'kb.bad.run', title: '运行' }], toolbar: [{ id: 'kb.bad.button' }] } },
        (ctx) => {
          ctx.registerCommand('kb.bad.run', noop)
          ctx.registerToolbarItem({ id: 'kb.bad.button', label: 'x', command: 'kb.bad.run' })
          throw new Error('启动炸了')
        },
      ),
    ).rejects.toMatchObject({ name: 'ExtensionRegistryError', code: 'activation' })
    expect(registry.isInstalled('kb.bad')).toBe(false)
    expect(registry.hasCommand('kb.bad.run')).toBe(false)
    expect(registry.toolbarItemsFor('text')).toEqual([])
  })

  it('6. 卸载后旧的 ctx 不能再用：注册、读文档、订阅都抛 disposed', async () => {
    const { registry } = makeRegistry()
    let saved: ExtensionContext | null = null
    await install(registry, { id: 'kb.old', permissions: ['document.read', 'ui'], contributes: { commands: [{ id: 'kb.old.run', title: '运行' }] } }, (ctx) => {
      saved = ctx
    })
    await registry.uninstall('kb.old')
    const ctx = saved as unknown as ExtensionContext
    expect(() => ctx.registerCommand('kb.old.run', noop)).toThrowError(/已卸载/)
    await expect(ctx.document.read()).rejects.toMatchObject({ code: 'disposed' })
    expect(() => ctx.document.onChange(noop)).toThrowError(ExtensionRegistryError)
    expect(() => ctx.subscriptions.add(noop)).toThrowError(ExtensionRegistryError)
    expect(registry.hasCommand('kb.old.run')).toBe(false)
  })

  it('7. deactivate 抛错只记录不阻断卸载；卡住的 deactivate 有超时', async () => {
    const { registry, errors } = makeRegistry({ deactivateTimeoutMs: 20 })
    await install(registry, { id: 'kb.throws' }, noop, {
      deactivate() {
        throw new Error('收尾炸了')
      },
    })
    expect(await registry.uninstall('kb.throws')).toBe(true)
    expect(errors.map((error) => (error as Error).message)).toEqual(['收尾炸了'])

    await install(registry, { id: 'kb.hangs' }, noop, { deactivate: () => new Promise<void>(() => undefined) })
    const started = Date.now()
    expect(await registry.uninstall('kb.hangs')).toBe(true)
    expect(Date.now() - started).toBeLessThan(1000)
    // 贡献在等 deactivate 之前就已经撤掉了
    expect(registry.isInstalled('kb.hangs')).toBe(false)
  })

  it('8. Disposable 重复 dispose 无副作用；单独 dispose 只撤那一项', async () => {
    const { registry } = makeRegistry()
    let button: { dispose(): void } | null = null
    await install(registry, { id: 'kb.disp', permissions: ['ui'], contributes: { commands: [{ id: 'kb.disp.run', title: '运行' }], toolbar: [{ id: 'kb.disp.button' }] } }, (ctx) => {
      ctx.registerCommand('kb.disp.run', noop)
      button = ctx.registerToolbarItem({ id: 'kb.disp.button', label: 'x', command: 'kb.disp.run' })
    })
    const handle = button as unknown as { dispose(): void }
    handle.dispose()
    handle.dispose()
    expect(registry.toolbarItemsFor('text')).toEqual([])
    expect(registry.hasCommand('kb.disp.run')).toBe(true)
    // 撤掉之后可以重新注册（不会被当成重复）
    expect(registry.isInstalled('kb.disp')).toBe(true)
  })

  it('9. 订阅者按批收到通知：卸载一个有很多贡献的扩展只通知一次', async () => {
    const { registry } = makeRegistry()
    await install(
      registry,
      { id: 'kb.many', permissions: ['ui'], contributes: { commands: [{ id: 'kb.many.a', title: 'a' }, { id: 'kb.many.b', title: 'b' }], toolbar: [{ id: 'kb.many.t1' }, { id: 'kb.many.t2' }] } },
      (ctx) => {
        ctx.registerCommand('kb.many.a', noop)
        ctx.registerCommand('kb.many.b', noop)
        ctx.registerToolbarItem({ id: 'kb.many.t1', label: '1', command: 'kb.many.a' })
        ctx.registerToolbarItem({ id: 'kb.many.t2', label: '2', command: 'kb.many.b' })
      },
    )
    const seen: number[] = []
    registry.subscribe(() => seen.push(registry.version))
    await registry.uninstall('kb.many')
    expect(seen).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- 声明与命名

describe('贡献必须先声明、带前缀、不重名', () => {
  it('10. 没在清单里声明的注册一律拒绝（七类各一条）', async () => {
    const { registry } = makeRegistry()
    const all: Permission[] = ['ui', 'ai', 'document.read', 'document.write']
    const undeclared = async (activate: (ctx: ExtensionContext) => void) =>
      expect(install(registry, { id: 'kb.und', permissions: all }, activate)).rejects.toMatchObject({ code: 'activation', cause: { code: 'undeclared' } })
    await undeclared((ctx) => void ctx.registerCommand('kb.und.run', noop))
    await undeclared((ctx) => void ctx.registerToolbarItem({ id: 'kb.und.b', label: 'x', command: 'kb.und.run' }))
    await undeclared((ctx) => void ctx.registerSlashItem({ id: 'kb.und.s', label: 'x', command: 'kb.und.run' }))
    await undeclared((ctx) => void ctx.registerPanel({ id: 'kb.und.p', title: 'x', mount: noop }))
    await undeclared((ctx) => void ctx.registerCodec({ id: 'kb.und.c', extensions: ['foo'], decode: () => ({ kind: 'text', text: '', name: 'a' }), encode: () => new Uint8Array() }))
    await undeclared((ctx) => void ctx.registerSurface({ id: 'kb.und.f', extensions: ['foo'], create: () => ({}) as Surface }))
    await undeclared((ctx) => void ctx.registerAITool({ id: 'kb.und.a', title: 'x', run: () => 'x' }))
  })

  it('11. 第三方的工具栏 / 斜杠项只能触发自己声明的命令（不能借按钮触发内置写命令）', async () => {
    const { registry } = makeRegistry()
    await expect(
      install(registry, { id: 'kb.sneaky', permissions: ['ui'], contributes: { toolbar: [{ id: 'kb.sneaky.b' }] } }, (ctx) => {
        ctx.registerToolbarItem({ id: 'kb.sneaky.b', label: '加粗', command: 'mark.toggle', args: { mark: 'strong' } })
      }),
    ).rejects.toMatchObject({ cause: { code: 'undeclared' } })
    expect(registry.toolbarItemsFor('text')).toEqual([])
  })

  it('12. 声明了的扩展名之外的格式不能接管', async () => {
    const { registry } = makeRegistry()
    await expect(
      install(registry, { id: 'kb.fmt', permissions: ['document.read', 'document.write'], contributes: { codecs: [{ id: 'kb.fmt.c', extensions: ['foo'] }] } }, (ctx) => {
        ctx.registerCodec({ id: 'kb.fmt.c', extensions: ['foo', 'bar'], decode: () => ({ kind: 'text', text: '', name: 'a' }), encode: () => new Uint8Array() })
      }),
    ).rejects.toMatchObject({ cause: { code: 'undeclared' } })
  })

  it('13. id 冲突：前缀有包含关系的两个扩展不能注册同一个 id', async () => {
    const { registry } = makeRegistry()
    // kb.a 可以声明 kb.a.b.run（前缀 kb.a.），而 kb.a.b 的 run 也是 kb.a.b.run
    await install(registry, { id: 'kb.a.b', contributes: { commands: [{ id: 'kb.a.b.run', title: '运行' }] } }, (ctx) => void ctx.registerCommand('kb.a.b.run', noop))
    await expect(
      install(registry, { id: 'kb.a', contributes: { commands: [{ id: 'kb.a.b.run', title: '运行' }] } }, (ctx) => void ctx.registerCommand('kb.a.b.run', noop)),
    ).rejects.toMatchObject({ cause: { code: 'conflict' } })
    expect(registry.isInstalled('kb.a')).toBe(false)
    expect(registry.isInstalled('kb.a.b')).toBe(true)
  })

  it('14. 内置扩展不受前缀 / 声明限制（随应用打包，名字就是内置名）', async () => {
    const { registry } = makeRegistry()
    registry.installBuiltin(
      manifestFor({ id: 'kb.builtin.demo', permissions: ['ui'] }),
      defineExtension({
        activate(ctx) {
          ctx.registerToolbarItem({ id: 'find', label: '查找', command: 'search.open', ui: true })
        },
      }),
    )
    expect(registry.toolbarItemsFor('text').map((item) => item.spec.command)).toEqual(['search.open'])
    expect(registry.list()[0]).toMatchObject({ builtin: true })
  })

  it('15. 内置扩展的 activate 必须同步', () => {
    const { registry } = makeRegistry()
    expect(() => registry.installBuiltin(manifestFor({ id: 'kb.builtin.async' }), { activate: async () => undefined })).toThrowError(/同步/)
    expect(registry.isInstalled('kb.builtin.async')).toBe(false)
  })

  it('16. api_version 不是 1 的清单、没有 activate 的扩展拒绝安装', async () => {
    const { registry } = makeRegistry()
    await expect(registry.install({ ...manifestFor({ id: 'kb.v2' }), apiVersion: 2 }, { activate: noop })).rejects.toMatchObject({ code: 'invalid' })
    await expect(registry.install(manifestFor({ id: 'kb.nope' }), {} as EditorExtension)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('17. 工具栏 / 面板 / 斜杠按 kinds 过滤；斜杠缺省只在文本面', async () => {
    const { registry } = makeRegistry()
    await install(
      registry,
      { id: 'kb.kinds', permissions: ['ui'], contributes: { commands: [{ id: 'kb.kinds.run', title: 'r' }], toolbar: [{ id: 'kb.kinds.all' }, { id: 'kb.kinds.code' }], slash: [{ id: 'kb.kinds.slash' }], panels: [{ id: 'kb.kinds.panel', title: 'p' }] } },
      (ctx) => {
        ctx.registerCommand('kb.kinds.run', noop)
        ctx.registerToolbarItem({ id: 'kb.kinds.all', label: 'a', command: 'kb.kinds.run' })
        ctx.registerToolbarItem({ id: 'kb.kinds.code', label: 'c', command: 'kb.kinds.run', kinds: ['code'] })
        ctx.registerSlashItem({ id: 'kb.kinds.slash', label: 's', command: 'kb.kinds.run' })
        ctx.registerPanel({ id: 'kb.kinds.panel', title: 'p', kinds: ['pdf'], mount: noop })
      },
    )
    expect(registry.toolbarItemsFor('text').map((i) => i.spec.id)).toEqual(['kb.kinds.all'])
    expect(registry.toolbarItemsFor('code').map((i) => i.spec.id)).toEqual(['kb.kinds.all', 'kb.kinds.code'])
    expect(registry.slashItemsFor('text')).toHaveLength(1)
    expect(registry.slashItemsFor('code')).toHaveLength(0)
    expect(registry.panels('text')).toEqual([])
    expect(registry.panels('pdf')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- 权限拒绝

describe('权限拒绝：没声明的权限，调用一律抛 PermissionDeniedError', () => {
  it('18. 故意越权的反例扩展：每一种越权调用都被拒，且错误指明缺哪项权限', async () => {
    const { registry } = makeRegistry()
    const binding = fakeBinding({ text: 'abc', selection: 'b' })
    registry.attachHost(binding)
    // 清单只申请了 ui —— 其余能力全是越权
    await registry.install(manifestFor({ id: 'kb.overreach', permissions: ['ui'] }), overreachExtension)
    expect(overreachAttempts.map((item) => item.api)).toEqual([
      'document.read',
      'document.onChange',
      'document.replaceSelection',
      'document.insertText',
      'clipboard.writeText',
      'clipboard.readText',
      'fetch',
      'registerAITool',
      'registerCodec',
    ])
    const needed: Record<string, Permission> = {
      'document.read': 'document.read',
      'document.onChange': 'document.read',
      'document.replaceSelection': 'document.write',
      'document.insertText': 'document.write',
      'clipboard.writeText': 'clipboard',
      'clipboard.readText': 'clipboard',
      fetch: 'network',
      registerAITool: 'ai',
      registerCodec: 'document.read',
    }
    for (const item of overreachAttempts) {
      expect(item.error, `${item.api} 应被拒`).toBeInstanceOf(PermissionDeniedError)
      expect((item.error as PermissionDeniedError).permission, item.api).toBe(needed[item.api])
      expect((item.error as PermissionDeniedError).extensionId).toBe('kb.overreach')
      expect((item.error as Error).message).toContain(needed[item.api])
    }
    // 越权没有产生任何副作用
    expect(binding.executed).toEqual([])
  })

  it('19. document.read：声明了才能读，读到正文 / 选区 / 格式 / 只读状态', async () => {
    const { registry } = makeRegistry()
    const binding = fakeBinding({ text: '# 标题\n正文', selection: '正文', format: 'md', readonly: true })
    registry.attachHost(binding)
    let ctx!: ExtensionContext
    await install(registry, { id: 'kb.read', permissions: ['document.read'] }, (c) => {
      ctx = c
    })
    expect(await ctx.document.read()).toEqual({ text: '# 标题\n正文', selection: '正文', format: 'md', kind: 'text', readonly: true })
    registry.attachHost(fakeBinding({ text: '另一个' }))
    expect((await ctx.document.read()).text).toBe('另一个') // 默认跟随当前活动的编辑器
  })

  it('20. 没有打开的文档：读文档抛 no_host，不是返回空', async () => {
    const { registry } = makeRegistry()
    let ctx!: ExtensionContext
    await install(registry, { id: 'kb.nohost', permissions: ['document.read'] }, (c) => {
      ctx = c
    })
    await expect(ctx.document.read()).rejects.toMatchObject({ code: 'no_host' })
  })

  it('21. clipboard：声明后走注入的剪贴板', async () => {
    const written: string[] = []
    const { registry } = makeRegistry({ clipboard: { writeText: async (text) => void written.push(text), readText: async () => '剪贴板内容' } })
    let ctx!: ExtensionContext
    await install(registry, { id: 'kb.clip', permissions: ['clipboard'] }, (c) => {
      ctx = c
    })
    await ctx.clipboard.writeText('复制我')
    expect(written).toEqual(['复制我'])
    expect(await ctx.clipboard.readText()).toBe('剪贴板内容')
  })

  it('22. network：只放行 https 和本扩展自己的文件；外站不带 cookie；不跟随重定向', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const { registry } = makeRegistry({
      origin: 'https://kb.example.com',
      fetch: async (url, init) => {
        calls.push({ url, init })
        return new Response('ok')
      },
    })
    let ctx!: ExtensionContext
    await install(registry, { id: 'kb.net', permissions: ['network'] }, (c) => {
      ctx = c
    })
    await ctx.fetch('https://api.example.org/v1/x?q=1', { method: 'POST' })
    await ctx.fetch('/api/v1/editor/extensions/kb.net/data.json')
    expect(calls[0]).toMatchObject({ url: 'https://api.example.org/v1/x?q=1', init: { method: 'POST', credentials: 'omit', redirect: 'error' } })
    expect(calls[1]).toMatchObject({ url: 'https://kb.example.com/api/v1/editor/extensions/kb.net/data.json', init: { credentials: 'same-origin' } })

    const denied = [
      'http://api.example.org/x', // 明文
      'data:text/plain,hi',
      'file:///etc/passwd',
      'ftp://x/y',
      '/api/v1/capabilities/list_items', // 本站的其它接口
      '/api/v1/editor/extensions/kb.other/index.js', // 别的扩展
      '/api/v1/editor/extensions/kb.net/../kb.other/index.js', // 穿越后落到别的扩展
      '/api/v1/editor/extensions/kb.net/%2e%2e/%2e%2e/capabilities/x',
      'https://kb.example.com/api/v1/me/prefs', // 同源的 https 也一样只给自己的目录
    ]
    for (const url of denied) {
      await expect(ctx.fetch(url), url).rejects.toBeInstanceOf(PermissionDeniedError)
    }
    expect(calls).toHaveLength(2)
  })

  it('23. ui：工具栏 / 斜杠 / 面板 / 内容面 / notify 都需要 ui', async () => {
    const { registry } = makeRegistry()
    const attempts: Array<[string, (ctx: ExtensionContext) => unknown]> = [
      ['registerToolbarItem', (ctx) => ctx.registerToolbarItem({ id: 'kb.noui.t', label: 'x', command: 'kb.noui.c' })],
      ['registerSlashItem', (ctx) => ctx.registerSlashItem({ id: 'kb.noui.s', label: 'x', command: 'kb.noui.c' })],
      ['registerPanel', (ctx) => ctx.registerPanel({ id: 'kb.noui.p', title: 'x', mount: noop })],
      ['registerSurface', (ctx) => ctx.registerSurface({ id: 'kb.noui.f', extensions: ['foo'], create: () => ({}) as Surface })],
      ['notify', (ctx) => ctx.notify('hi')],
    ]
    const contributes = {
      commands: [{ id: 'kb.noui.c', title: 'c' }],
      toolbar: [{ id: 'kb.noui.t' }],
      slash: [{ id: 'kb.noui.s' }],
      panels: [{ id: 'kb.noui.p', title: 'p' }],
      surfaces: [{ id: 'kb.noui.f', extensions: ['foo'] }],
    }
    for (const [name, run] of attempts) {
      let caught: unknown = null
      await install(registry, { id: 'kb.noui', permissions: ['document.read'], contributes }, (ctx) => {
        try {
          run(ctx)
        } catch (error) {
          caught = error
        }
      })
      expect(caught, name).toBeInstanceOf(PermissionDeniedError)
      expect((caught as PermissionDeniedError).permission, name).toBe('ui')
    }
  })

  it('24. ui：notify 经注入的出口给用户提示', async () => {
    const shown: Array<[string, string]> = []
    const { registry } = makeRegistry({ notify: (message, tone) => void shown.push([message, tone]) })
    let ctx!: ExtensionContext
    await install(registry, { id: 'kb.notify', permissions: ['ui'] }, (c) => {
      ctx = c
    })
    ctx.notify('完成了')
    ctx.notify('出错了', 'danger')
    expect(shown).toEqual([['完成了', 'success'], ['出错了', 'danger']])
  })

  it('25. ai：注册 AI 工具需要 ai；运行时还要 document.read（读选区）', async () => {
    const { registry } = makeRegistry()
    const binding = fakeBinding({ selection: '选中的字' })
    registry.attachHost(binding)
    await install(registry, { id: 'kb.aionly', permissions: ['ai'], contributes: { aiTools: [{ id: 'kb.aionly.t', title: 't' }] } }, (ctx) => {
      ctx.registerAITool({ id: 'kb.aionly.t', title: 't', run: () => 'x' })
    })
    // 注册成功了，但没有读文档权限，运行被拒
    await expect(registry.runAITool('kb.aionly.t', binding)).rejects.toMatchObject({ name: 'PermissionDeniedError', permission: 'document.read' })
  })
})

// ---------------------------------------------------------------- document.write

describe('document.write：声明之外还要用户确认', () => {
  const writer: ManifestInit = { id: 'kb.writer', name: '改稿助手', permissions: ['document.read', 'document.write'] }

  async function writerContext(registry: ExtensionRegistry, init: ManifestInit = writer) {
    let ctx!: ExtensionContext
    await install(registry, init, (c) => {
      ctx = c
    })
    return ctx
  }

  it('26. 首次写入弹确认（并发写入共用一次），允许后写文档并带上 source=api 与扩展 id；之后不再问', async () => {
    const asked: string[] = []
    const { registry } = makeRegistry({
      confirmWrite: async (manifest) => {
        asked.push(manifest.id)
        return true
      },
    })
    const binding = fakeBinding({ selection: '旧文字' })
    registry.attachHost(binding)
    const ctx = await writerContext(registry)
    expect(await registry.writeGrantState('kb.writer')).toBe('unasked')
    await Promise.all([ctx.document.replaceSelection('新文字A'), ctx.document.insertText('新文字B')])
    await ctx.document.replaceSelection('新文字C')
    expect(asked).toEqual(['kb.writer'])
    // 并发调用之间不保证顺序（replaceSelection 要先异步取选区），按文本排序后比较
    const sortedByText = [...binding.executed].sort((a, b) => String((a.args as { text: string }).text).localeCompare(String((b.args as { text: string }).text)))
    expect(sortedByText.map((command) => [command.type, command.args, command.source, command.origin])).toEqual([
      ['text.insert', { text: '新文字A' }, 'api', 'kb.writer'],
      ['text.insert', { text: '新文字B' }, 'api', 'kb.writer'],
      ['text.insert', { text: '新文字C' }, 'api', 'kb.writer'],
    ])
    expect(await registry.writeGrantState('kb.writer')).toBe('granted')
  })

  it('27. 用户拒绝：抛 PermissionDeniedError、文档不动、本次会话不再追问；reset 后重新问', async () => {
    const confirm = vi.fn(async () => false)
    const { registry } = makeRegistry({ confirmWrite: confirm })
    const binding = fakeBinding({ selection: '旧' })
    registry.attachHost(binding)
    const ctx = await writerContext(registry)
    await expect(ctx.document.replaceSelection('新')).rejects.toMatchObject({ name: 'PermissionDeniedError', permission: 'document.write' })
    await expect(ctx.document.insertText('新')).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(binding.executed).toEqual([])
    expect(await registry.writeGrantState('kb.writer')).toBe('denied')

    registry.resetWriteGrant('kb.writer')
    confirm.mockResolvedValueOnce(true)
    await ctx.document.replaceSelection('新')
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(binding.executed).toHaveLength(1)
  })

  it('28. 没有接确认回调 / 回调抛错：一律按拒绝处理（默认安全）', async () => {
    const binding = fakeBinding({ selection: '旧' })
    const first = makeRegistry()
    first.registry.attachHost(binding)
    await expect((await writerContext(first.registry)).document.replaceSelection('新')).rejects.toBeInstanceOf(PermissionDeniedError)
    const second = makeRegistry({
      confirmWrite: async () => {
        throw new Error('弹窗坏了')
      },
    })
    second.registry.attachHost(binding)
    await expect((await writerContext(second.registry)).document.insertText('新')).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(binding.executed).toEqual([])
  })

  it('29. 只读文档：直接拒绝，而且不弹确认', async () => {
    const confirm = vi.fn(async () => true)
    const { registry } = makeRegistry({ confirmWrite: confirm })
    const binding = fakeBinding({ selection: '旧', readonly: true })
    registry.attachHost(binding)
    const ctx = await writerContext(registry)
    await expect(ctx.document.replaceSelection('新')).rejects.toMatchObject({ name: 'PermissionDeniedError', message: expect.stringContaining('只读') })
    await expect(ctx.document.insertText('新')).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(confirm).not.toHaveBeenCalled()
    expect(binding.executed).toEqual([])
  })

  it('30. replaceSelection 没有选区抛错（不猜光标）；insertText 不需要选区；空文本拒绝', async () => {
    const { registry } = makeRegistry({ confirmWrite: async () => true })
    const binding = fakeBinding({ selection: '' })
    registry.attachHost(binding)
    const ctx = await writerContext(registry)
    await expect(ctx.document.replaceSelection('新')).rejects.toMatchObject({ code: 'invalid' })
    await ctx.document.insertText('新')
    await expect(ctx.document.insertText('')).rejects.toMatchObject({ code: 'invalid' })
    expect(binding.executed).toHaveLength(1)
  })

  it('31. CommandBus 拒绝（内容面不支持）时抛错带原因，而不是假装成功', async () => {
    const { registry } = makeRegistry({ confirmWrite: async () => true })
    const binding = fakeBinding({ selection: '旧' })
    binding.nextResult = { ok: false, reason: 'unsupported_command:text.insert' }
    registry.attachHost(binding)
    await expect((await writerContext(registry)).document.replaceSelection('新')).rejects.toThrowError(/unsupported_command:text\.insert/)
  })

  it('32. 内置扩展不需要确认；卸载后重装要重新确认（可能是新代码）', async () => {
    const confirm = vi.fn(async () => true)
    const { registry } = makeRegistry({ confirmWrite: confirm })
    const binding = fakeBinding({ selection: '旧' })
    registry.attachHost(binding)
    let builtinCtx!: ExtensionContext
    registry.installBuiltin(manifestFor({ id: 'kb.builtin.w', permissions: ['document.write'] }), {
      activate(ctx) {
        builtinCtx = ctx
      },
    })
    await builtinCtx.document.replaceSelection('新')
    expect(confirm).not.toHaveBeenCalled()

    const ctx = await writerContext(registry)
    await ctx.document.replaceSelection('A')
    await registry.uninstall('kb.writer')
    const again = await writerContext(registry)
    await again.document.replaceSelection('B')
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------- 文档订阅 / 命令 / 面板 / AI

describe('文档订阅', () => {
  it('33. onChange 只在对应编辑器变化时触发；activate 里订阅的跟随当前活动编辑器；编辑器卸载后不再收到', async () => {
    const { registry } = makeRegistry()
    const a = fakeBinding({ text: 'A' })
    const b = fakeBinding({ text: 'B' })
    const detachA = registry.attachHost(a)
    let ctx!: ExtensionContext
    const heard: string[] = []
    await install(registry, { id: 'kb.watch', permissions: ['document.read', 'ui'], contributes: { panels: [{ id: 'kb.watch.panel', title: 'p' }] } }, (c) => {
      ctx = c
      c.document.onChange(() => heard.push('active'))
      c.registerPanel({
        id: 'kb.watch.panel',
        title: 'p',
        mount: (_el, api) => {
          api.document.onChange(() => heard.push('panel'))
        },
      })
    })
    registry.emitChange(a)
    expect(heard).toEqual(['active'])

    registry.attachHost(b) // b 变成活动编辑器
    registry.emitChange(a)
    expect(heard).toEqual(['active']) // 不是活动编辑器了
    registry.emitChange(b)
    expect(heard).toEqual(['active', 'active'])

    // 面板绑定在挂载它的那个编辑器上，不管谁是活动的
    await registry.mountPanel(registry.panels('text')[0]!, document.createElement('div'), a)
    registry.emitChange(a)
    expect(heard.slice(2)).toEqual(['panel'])
    detachA()
    registry.emitChange(a)
    expect(heard.slice(2)).toEqual(['panel'])
    expect(ctx).toBeTruthy()
  })

  it('34. 订阅回调抛错只记录，不影响其它订阅者', async () => {
    const { registry, errors } = makeRegistry()
    const binding = fakeBinding()
    registry.attachHost(binding)
    const heard: string[] = []
    await install(registry, { id: 'kb.err', permissions: ['document.read'] }, (ctx) => {
      ctx.document.onChange(() => {
        throw new Error('回调炸了')
      })
      ctx.document.onChange(() => heard.push('second'))
    })
    registry.emitChange(binding)
    expect(heard).toEqual(['second'])
    expect(errors).toHaveLength(1)
  })
})

describe('命令', () => {
  it('35. runCommand 把参数和绑定到触发编辑器的 API 交给处理器；未知命令 / 抛错返回 ok:false', async () => {
    const { registry, errors } = makeRegistry()
    const binding = fakeBinding({ text: '正文' })
    registry.attachHost(binding)
    const seen: unknown[] = []
    await install(registry, { id: 'kb.cmd', permissions: ['document.read'], contributes: { commands: [{ id: 'kb.cmd.ok', title: 'ok' }, { id: 'kb.cmd.bad', title: 'bad' }] } }, (ctx) => {
      ctx.registerCommand('kb.cmd.ok', async (args, api) => {
        seen.push(args, (await api.document.read()).text, api.manifest.id)
      })
      ctx.registerCommand('kb.cmd.bad', () => {
        throw new Error('命令炸了')
      })
    })
    expect(await registry.runCommand('kb.cmd.ok', { n: 1 })).toEqual({ ok: true })
    expect(seen).toEqual([{ n: 1 }, '正文', 'kb.cmd'])
    expect(await registry.runCommand('kb.cmd.bad', undefined)).toEqual({ ok: false, reason: '命令炸了' })
    expect(await registry.runCommand('kb.cmd.unknown', undefined)).toEqual({ ok: false, reason: 'unknown_command:kb.cmd.unknown' })
    expect(errors).toHaveLength(1)

    // 指定别的编辑器时，API 读的是那个编辑器
    const other = fakeBinding({ text: '另一份' })
    seen.length = 0
    await registry.runCommand('kb.cmd.ok', undefined, other)
    expect(seen[1]).toBe('另一份')
  })
})

describe('面板', () => {
  it('36. mountPanel 把 el 与绑定好的 API 交给扩展，清理函数只执行一次', async () => {
    const { registry } = makeRegistry()
    const binding = fakeBinding({ text: '内容' })
    registry.attachHost(binding)
    const log: string[] = []
    await install(registry, { id: 'kb.panel', permissions: ['ui', 'document.read'], contributes: { panels: [{ id: 'kb.panel.p', title: '面板' }] } }, (ctx) => {
      ctx.registerPanel({
        id: 'kb.panel.p',
        title: '面板',
        async mount(el, api) {
          el.textContent = (await api.document.read()).text
          log.push('mounted')
          return () => log.push('cleaned')
        },
      })
    })
    const el = document.createElement('div')
    const cleanup = await registry.mountPanel(registry.panels('text')[0]!, el, binding)
    expect(el.textContent).toBe('内容')
    cleanup()
    cleanup()
    expect(log).toEqual(['mounted', 'cleaned'])
  })

  it('37. mount 抛错：记录并返回空清理，不让编辑器崩；扩展已卸载则什么也不做', async () => {
    const { registry, errors } = makeRegistry()
    await install(registry, { id: 'kb.panelbad', permissions: ['ui'], contributes: { panels: [{ id: 'kb.panelbad.p', title: '坏面板' }] } }, (ctx) => {
      ctx.registerPanel({
        id: 'kb.panelbad.p',
        title: '坏面板',
        mount() {
          throw new Error('画不出来')
        },
      })
    })
    const info = registry.panels('text')[0]!
    const cleanup = await registry.mountPanel(info, document.createElement('div'), null)
    expect(() => cleanup()).not.toThrow()
    expect(errors).toHaveLength(1)
    await registry.uninstall('kb.panelbad')
    const el = document.createElement('div')
    await registry.mountPanel(info, el, null)
    expect(el.childNodes).toHaveLength(0)
  })
})

describe('AI 工具', () => {
  const aiInit: ManifestInit = { id: 'kb.ai', name: 'AI 改写', permissions: ['ai', 'document.read', 'document.write'], contributes: { aiTools: [{ id: 'kb.ai.upper', title: '转大写' }] } }

  async function aiRegistry(options: ConstructorParameters<typeof ExtensionRegistry>[0] = {}, run?: (input: unknown) => unknown) {
    const made = makeRegistry(options)
    await install(made.registry, aiInit, (ctx) => {
      ctx.registerAITool({
        id: 'kb.ai.upper',
        title: '转大写',
        description: '把选中的文字转成大写',
        run: async (input) => (run ? (run(input) as string) : { text: input.text.toUpperCase(), note: '仅作建议' }),
      })
    })
    return made
  }

  it('38. 运行：把选区 / 格式 / 内容面交给工具，结果是带原文的「建议」，不会自己改文档', async () => {
    const { registry } = await aiRegistry()
    const binding = fakeBinding({ text: 'hello world', selection: 'hello', format: 'md' })
    registry.attachHost(binding)
    expect(registry.aiTools()).toEqual([{ id: 'kb.ai.upper', extensionId: 'kb.ai', title: '转大写', description: '把选中的文字转成大写', target: 'suggestion' }])
    const suggestion = await registry.runAITool('kb.ai.upper', binding)
    expect(suggestion).toEqual({ toolId: 'kb.ai.upper', extensionId: 'kb.ai', original: 'hello', text: 'HELLO', note: '仅作建议' })
    expect(binding.executed).toEqual([])
  })

  it('39. 工具可以直接返回字符串；返回别的东西报 invalid；不存在的工具报错', async () => {
    const { registry } = await aiRegistry({}, () => '直接返回')
    const binding = fakeBinding({ selection: 'x' })
    expect((await registry.runAITool('kb.ai.upper', binding)).text).toBe('直接返回')
    const bad = await aiRegistry({}, () => 42)
    await expect(bad.registry.runAITool('kb.ai.upper', binding)).rejects.toMatchObject({ code: 'invalid' })
    await expect(registry.runAITool('kb.ai.nope', binding)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('40. 接受建议：核对选区没变，再走 replaceSelection（需要 document.write 与确认）', async () => {
    const confirm = vi.fn(async () => true)
    const { registry } = await aiRegistry({ confirmWrite: confirm })
    const binding = fakeBinding({ selection: 'hello' })
    registry.attachHost(binding)
    const suggestion = await registry.runAITool('kb.ai.upper', binding)
    await registry.applySuggestion(suggestion, binding)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(binding.executed.map((command) => command.args)).toEqual([{ text: 'HELLO' }])
  })

  it('41. 选区变了 / 扩展已卸载 / 用户不允许写：接受失败且文档不动', async () => {
    const { registry } = await aiRegistry({ confirmWrite: async () => false })
    const binding = fakeBinding({ selection: 'hello' })
    registry.attachHost(binding)
    const suggestion = await registry.runAITool('kb.ai.upper', binding)

    binding.selection = '别的字'
    await expect(registry.applySuggestion(suggestion, binding)).rejects.toMatchObject({ code: 'stale' })
    binding.selection = 'hello'
    await expect(registry.applySuggestion(suggestion, binding)).rejects.toBeInstanceOf(PermissionDeniedError) // 不允许写
    expect(binding.executed).toEqual([])

    await registry.uninstall('kb.ai')
    await expect(registry.applySuggestion(suggestion, binding)).rejects.toMatchObject({ code: 'stale' })
  })
})

// ---------------------------------------------------------------- Codec / 内容面协商

describe('格式协商：Codec 与内容面', () => {
  const codecInit: ManifestInit = {
    id: 'kb.fmt',
    name: '格式扩展',
    permissions: ['document.read', 'document.write', 'ui'],
    contributes: {
      codecs: [{ id: 'kb.fmt.rot', extensions: ['rot'] }],
      surfaces: [{ id: 'kb.fmt.view', extensions: ['viz', 'rot'] }],
    },
  }
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  it('42. 内置格式永远优先：扩展不能接管 md / csv / pdf 等，注册即失败', async () => {
    const { registry } = makeRegistry()
    for (const ext of ['md', 'csv', 'pdf', 'docx', 'json', 'XLSX']) {
      await expect(
        install(registry, { id: 'kb.hijack', permissions: ['document.read', 'document.write'], contributes: { codecs: [{ id: 'kb.hijack.c', extensions: [ext.toLowerCase()] }] } }, (ctx) => {
          ctx.registerCodec({ id: 'kb.hijack.c', decode: () => ({ kind: 'text', text: '', name: 'a' }), encode: () => new Uint8Array() })
        }),
        ext,
      ).rejects.toMatchObject({ cause: { code: 'builtin_format' } })
    }
    expect(registry.resolveKind('notes.md')).toBe('text')
    expect(registry.resolveKind('data.csv')).toBe('grid')
  })

  it('43. Codec：不认识的扩展名走扩展 Codec，缺省交给 code 内容面；decode/encode 经权限闸门', async () => {
    const confirm = vi.fn(async () => true)
    const { registry } = makeRegistry({ confirmWrite: confirm })
    await install(registry, { ...codecInit, contributes: { codecs: codecInit.contributes!.codecs! } }, (ctx) => {
      ctx.registerCodec({
        id: 'kb.fmt.rot',
        decode: (bytes) => ({ kind: 'text', text: decoder.decode(bytes).split('').reverse().join(''), name: 'a.rot' }),
        encode: (source) => encoder.encode(source.kind === 'text' ? source.text.split('').reverse().join('') : ''),
      })
    })
    expect(registry.resolveKind('a.rot')).toBe('code')
    expect(registry.resolveKind('A.ROT')).toBe('code') // 大小写不敏感
    expect(registry.resolveKind('a.unknown')).toBeNull()
    const codec = registry.codecFor('rot')!
    expect(codec).toMatchObject({ id: 'kb.fmt.rot', extensionId: 'kb.fmt', surface: 'code' })
    const decoded = await codec.decode(encoder.encode('olleh'), { name: 'a.rot', format: 'rot' })
    expect(decoded).toMatchObject({ kind: 'text', text: 'hello' })
    expect(confirm).not.toHaveBeenCalled() // 解码不写文档，不弹确认
    expect(decoder.decode(await codec.encode({ kind: 'text', text: 'hello', name: 'a.rot' }, { name: 'a.rot', format: 'rot' }))).toBe('olleh')
    expect(confirm).toHaveBeenCalledTimes(1) // 编码会写回文件，首次要确认
  })

  it('44. Codec 的写回被用户拒绝：encode 抛 PermissionDeniedError', async () => {
    const { registry } = makeRegistry({ confirmWrite: async () => false })
    await install(registry, { ...codecInit, contributes: { codecs: codecInit.contributes!.codecs! } }, (ctx) => {
      ctx.registerCodec({ id: 'kb.fmt.rot', decode: () => ({ kind: 'text', text: '', name: 'a' }), encode: () => new Uint8Array([1]) })
    })
    await expect(registry.codecFor('rot')!.encode({ kind: 'text', text: 'x', name: 'a.rot' }, { name: 'a.rot', format: 'rot' })).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('45. 扩展内容面：优先于 Codec 的缺省内容面；kind 是 ext:<id>；接入内容面注册表可被加载', async () => {
    const { registry } = makeRegistry()
    let created = 0
    await install(registry, codecInit, (ctx) => {
      ctx.registerCodec({ id: 'kb.fmt.rot', decode: () => ({ kind: 'text', text: '', name: 'a' }), encode: () => new Uint8Array(), surface: 'ext:kb.fmt.view' })
      ctx.registerSurface({
        id: 'kb.fmt.view',
        create: () => {
          created += 1
          return fakeSurface()
        },
      })
    })
    expect(registry.surfaceFor('viz')).toEqual({ kind: 'ext:kb.fmt.view', extensionId: 'kb.fmt', id: 'kb.fmt.view' })
    expect(registry.resolveKind('x.viz')).toBe('ext:kb.fmt.view')
    expect(registry.resolveKind('x.rot')).toBe('ext:kb.fmt.view') // 内容面声明了 rot，优先于 Codec 的 surface
    expect(hasSurface('ext:kb.fmt.view')).toBe(true)
    const surface = await loadSurface('ext:kb.fmt.view', 'viz')
    expect(surface).not.toBeNull()
    expect(created).toBe(1)
    await loadSurface('ext:kb.fmt.view', 'viz')
    expect(created).toBe(2) // 每个文档一个实例
  })

  it('46. Codec 的 surface 只能是内置类型或本扩展声明的内容面', async () => {
    const { registry } = makeRegistry()
    await expect(
      install(registry, { ...codecInit, contributes: { codecs: codecInit.contributes!.codecs! } }, (ctx) => {
        ctx.registerCodec({ id: 'kb.fmt.rot', surface: 'ext:kb.other.view', decode: () => ({ kind: 'text', text: '', name: 'a' }), encode: () => new Uint8Array() })
      }),
    ).rejects.toMatchObject({ cause: { code: 'undeclared' } })
  })

  it('47. 两个扩展不能接管同一个扩展名', async () => {
    const { registry } = makeRegistry()
    const register = (id: string) => (ctx: ExtensionContext) =>
      void ctx.registerCodec({ id: `${id}.c`, decode: () => ({ kind: 'text', text: '', name: 'a' }), encode: () => new Uint8Array() })
    const make = (id: string): ManifestInit => ({ id, permissions: ['document.read', 'document.write'], contributes: { codecs: [{ id: `${id}.c`, extensions: ['same'] }] } })
    await install(registry, make('kb.one'), register('kb.one'))
    await expect(install(registry, make('kb.two'), register('kb.two'))).rejects.toMatchObject({ cause: { code: 'conflict' } })
    await registry.uninstall('kb.one')
    await install(registry, make('kb.two'), register('kb.two')) // 前一个卸载后可以接管
    expect(registry.codecFor('same')?.extensionId).toBe('kb.two')
  })

  it('48. 扩展内容面拿到的会话是受限的：读安全命令放行，写命令要 document.write 与确认', async () => {
    const confirm = vi.fn(async () => false)
    const { registry } = makeRegistry({ confirmWrite: confirm })
    const executed: string[] = []
    let mountedSession: { execute(command: { id: string; type: string; source: 'api' }): Promise<unknown>; save(): Promise<unknown> } | null = null
    await install(registry, { id: 'kb.surf', permissions: ['ui', 'document.read', 'document.write'], contributes: { surfaces: [{ id: 'kb.surf.s', extensions: ['surf'] }] } }, (ctx) => {
      ctx.registerSurface({
        id: 'kb.surf.s',
        create: () => ({ ...fakeSurface(), mount: async (_el, surfaceCtx) => void (mountedSession = surfaceCtx.session as never) }),
      })
    })
    const surface = (await loadSurface('ext:kb.surf.s', 'surf'))!
    const session = {
      execute: async (command: { type: string }) => {
        executed.push(command.type)
        return { ok: true }
      },
      save: async () => ({ ok: true }),
    }
    await surface.mount(document.createElement('div'), { session } as never)
    const guarded = mountedSession!
    await guarded.execute({ id: '1', type: 'search.set', source: 'api' }) // 只读安全命令
    expect(executed).toEqual(['search.set'])
    expect(confirm).not.toHaveBeenCalled()
    await expect(guarded.execute({ id: '2', type: 'text.insert', source: 'api' })).rejects.toBeInstanceOf(PermissionDeniedError)
    await expect(guarded.save()).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(executed).toEqual(['search.set'])
  })

  it('49. 只有 ui 没有 document.read 的内容面注册被拒', async () => {
    const { registry } = makeRegistry()
    await expect(
      install(registry, { id: 'kb.surfbad', permissions: ['ui'], contributes: { surfaces: [{ id: 'kb.surfbad.s', extensions: ['sb'] }] } }, (ctx) => {
        ctx.registerSurface({ id: 'kb.surfbad.s', create: () => fakeSurface() })
      }),
    ).rejects.toMatchObject({ cause: { name: 'PermissionDeniedError', permission: 'document.read' } })
  })
})

function fakeSurface(): Surface {
  return {
    mount: async () => undefined,
    unmount: () => undefined,
    resize: () => undefined,
    focus: () => undefined,
    setReadonly: () => undefined,
    command: async () => ({ ok: true }),
    query: async () => null,
    capture: () => ({ kind: 'code' }),
    restore: () => undefined,
  }
}
