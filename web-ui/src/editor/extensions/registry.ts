/**
 * 扩展注册表
 *
 * 职责：安装 / 卸载扩展，给每个扩展发一份按权限裁剪过的上下文，收下它注册的命令、工具栏、斜杠菜单、
 * 面板、Codec、内容面和 AI 工具，并把这些贡献以「查询接口」的形式交给 Host / Chrome。
 *
 * 几条不变量（测试逐条钉住）：
 * 1. **幂等**：同 id 重复安装先卸载旧的；重复卸载返回 false，不抛；Disposable 重复 dispose 无副作用。
 * 2. **卸载回收一切**：命令、工具栏、斜杠、面板、Codec、内容面、AI 工具、文档订阅、`subscriptions` 全部撤销，
 *    卸载后再用旧的 ctx 注册东西会抛 `ExtensionRegistryError(disposed)`。
 * 3. **权限最小**：清单没声明的权限，对应调用抛 `PermissionDeniedError`；`document.write` 即使声明了，
 *    第三方扩展第一次真正写文档时还要用户确认（`confirmWrite`），结果按扩展 id 记在本页面会话里。
 * 4. **贡献必须先声明**：第三方扩展注册的 id 必须在清单 `contributes` 里出现，且带扩展 id 前缀——
 *    所以第三方不可能覆盖内置命令，也不可能悄悄多注册一个管理员没看过的东西。内置扩展（随应用打包）不受这两条限制。
 * 5. **内置格式不可被覆盖**：扩展只能接管宿主不认识的扩展名。
 */
import {
  EDITOR_API_VERSION,
  type AIToolInput,
  type AIToolSpec,
  type ClipboardApi,
  type CodecContext,
  type CodecSpec,
  type CommandHandler,
  type Disposable,
  type DocumentApi,
  type DocumentSnapshot,
  type EditorExtension,
  type ExtensionContext,
  type ExtensionManifest,
  type HostApi,
  type PageChannel,
  type PageEvent,
  type PanelSpec,
  type Permission,
  type SlashItemSpec,
  type StatusArea,
  type StatusItemHandle,
  type StatusItemSpec,
  type StatusState,
  type SurfaceKindName,
  type SurfaceSpec,
  type ToolbarActionSpec,
  type ToolbarItemSpec,
} from './api'
import { PermissionDeniedError, assertPermission, assertPermissions } from './permissions'
import { isReadonlySafeCommand } from '../session/CommandBus'
import { registerSurface as registerSurfaceLoader, unregisterSurface as unregisterSurfaceLoader } from '../surfaces/registry'
import type { SurfaceFactory } from '../surfaces/registry'
import { normalizeFormat, resolveSurfaceKind } from '../types'
import type { CommandResult, DocumentSession, EditorCommand, EditorSource, Surface } from '../types'

/** 注册表自身的错误；`code` 供测试和界面区分原因。 */
export class ExtensionRegistryError extends Error {
  readonly code: 'disposed' | 'undeclared' | 'conflict' | 'invalid' | 'builtin_format' | 'no_host' | 'activation' | 'stale'
  readonly extensionId: string

  constructor(code: ExtensionRegistryError['code'], extensionId: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ExtensionRegistryError'
    this.code = code
    this.extensionId = extensionId
  }
}

/** Host 交给注册表的「当前打开的那个编辑器」。注册表不认识 Host 的内部，只通过它读写文档。 */
export interface HostBinding {
  readonly kind: SurfaceKindName
  readonly format: string
  isReadonly(): boolean
  /** 当前正文（协同里是大家正在改的版本）。 */
  readText(): Promise<string>
  /** 当前选区文字；没有选区是空串。 */
  selectionText(): string | Promise<string>
  /** 走 CommandBus 执行命令（只读 / 权限守卫在那里）。 */
  execute(command: EditorCommand): Promise<CommandResult>
  /** 把导出 / 评论 / AI 事件交给嵌入编辑器的页面（只有内置扩展经 `api.page` 用得到；不提供就什么也不做）。 */
  emitToPage?(event: PageEvent, payload?: unknown): void
}

export interface RegistryOptions {
  /** `document.write` 的确认回调：第三方扩展第一次写文档时调用，返回 true 才放行。缺省一律拒绝。 */
  confirmWrite?: (manifest: ExtensionManifest) => Promise<boolean> | boolean
  /** 扩展代码抛错时的出口（命令处理器、订阅回调、卸载回调）。缺省 console.error。 */
  onError?: (manifest: ExtensionManifest, error: unknown) => void
  /** 给用户一条提示（`notify` API）；缺省只写控制台。界面层接 toast。 */
  notify?: (message: string, tone: 'success' | 'warning' | 'danger') => void
  /** 注入剪贴板（测试用）；缺省 navigator.clipboard。 */
  clipboard?: { writeText(text: string): Promise<void>; readText(): Promise<string> }
  /** 注入 fetch（测试用）；缺省 globalThis.fetch。 */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  /** 页面来源，`network` 权限据此判断同源；缺省 location.origin。 */
  origin?: string
  /** `deactivate` 的等待上限（毫秒），防止一个卡住的扩展让卸载永远不返回。 */
  deactivateTimeoutMs?: number
}

interface Entry {
  readonly manifest: ExtensionManifest
  readonly builtin: boolean
  readonly extension: EditorExtension
  disposed: boolean
  /** 反向执行：后注册的先撤销。 */
  readonly disposers: Array<() => void>
}

interface CommandReg {
  entry: Entry
  handler: CommandHandler
}
interface ToolbarReg {
  entry: Entry
  spec: ToolbarItemSpec
}
interface SlashReg {
  entry: Entry
  spec: SlashItemSpec
}
interface StatusReg {
  entry: Entry
  spec: StatusItemSpec
}
interface PanelReg {
  entry: Entry
  spec: PanelSpec
}
interface AIToolReg {
  entry: Entry
  spec: AIToolSpec
}
interface CodecReg {
  entry: Entry
  spec: CodecSpec
  extensions: string[]
}
interface SurfaceReg {
  entry: Entry
  spec: SurfaceSpec
  extensions: string[]
  kind: SurfaceKindName
}
interface ChangeListener {
  entry: Entry
  listener: () => void
  /** 绑定到某个编辑器的订阅只收它的变化；null = 收「当前活动编辑器」的变化。 */
  binding: HostBinding | null
}

/** 工具栏按钮条目（查询结果）。 */
export interface ToolbarEntry {
  extensionId: string
  spec: ToolbarItemSpec
}
/** 斜杠菜单条目。 */
export interface SlashEntry {
  extensionId: string
  spec: SlashItemSpec
}
/** 状态栏项条目（查询结果）。 */
export interface StatusEntry {
  extensionId: string
  spec: StatusItemSpec
}
/** 状态栏项求值后的结果，Chrome / 状态栏直接渲染。 */
export interface StatusView {
  id: string
  extensionId: string
  text: string
  title?: string
}
/** 工具栏查询的范围：文件格式（小写扩展名）与页面选的工具栏方案。 */
export interface ToolbarScope {
  format?: string
  profile?: string
}
/** 面板条目（给 Chrome 画开关按钮用，不含 mount）。 */
export interface PanelInfo {
  /** `<扩展 id>:<面板 id>`，Chrome 用它做 key。 */
  key: string
  id: string
  extensionId: string
  title: string
  icon?: string
}
/** AI 工具条目。 */
export interface AIToolInfo {
  id: string
  extensionId: string
  title: string
  description?: string
  /** `page`：结果由嵌入编辑器的页面接管，宿主不显示建议条（内置的润色 / 总结 / 翻译） */
  target: 'suggestion' | 'page'
}
/** AI 工具跑出来的建议。 */
export interface AISuggestion {
  toolId: string
  extensionId: string
  /** 运行时的选区原文；接受时要核对选区没变。 */
  original: string
  text: string
  note?: string
}
/** 已安装扩展的摘要。 */
export interface InstalledInfo {
  manifest: ExtensionManifest
  builtin: boolean
}
/** Codec 查询结果：decode / encode 已套好权限闸门。 */
export interface CodecHandle {
  id: string
  extensionId: string
  /** 解码后交给哪个内容面。 */
  surface: SurfaceKindName
  decode(bytes: Uint8Array, ctx: CodecContext): Promise<EditorSource>
  encode(source: EditorSource, ctx: CodecContext): Promise<Uint8Array>
}

const EXT_KIND_PREFIX = 'ext:'
const DEFAULT_DEACTIVATE_TIMEOUT_MS = 3000
/** 工具栏 / 面板缺省的作用范围：所有内容面。 */
const SLASH_DEFAULT_KINDS: readonly SurfaceKindName[] = ['text']

/** 页面没选工具栏方案时用的方案名。 */
export const DEFAULT_PROFILE = 'default'

/** 两个条目的作用范围（内容面 / 格式 / 方案 / 放置位置）有没有交集；没限制 = 全部，必然和任何范围相交。 */
function scopesOverlap(
  a: Pick<ToolbarItemSpec, 'kinds' | 'formats' | 'profile' | 'placement'> | Pick<StatusItemSpec, 'kinds'>,
  b: Pick<ToolbarItemSpec, 'kinds' | 'formats' | 'profile' | 'placement'> | Pick<StatusItemSpec, 'kinds'>,
): boolean {
  const meet = (x: readonly string[] | undefined, y: readonly string[] | undefined): boolean => !x || !y || x.some((item) => y.includes(item))
  const ta = a as ToolbarItemSpec
  const tb = b as ToolbarItemSpec
  return (
    meet(ta.kinds, tb.kinds) &&
    meet(ta.formats, tb.formats) &&
    (ta.profile === undefined || tb.profile === undefined || ta.profile === tb.profile) &&
    (ta.placement === 'bar') === (tb.placement === 'bar')
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ExtensionRegistry {
  private readonly options: RegistryOptions
  private readonly entries = new Map<string, Entry>()
  private readonly commands = new Map<string, CommandReg>()
  private readonly toolbar: ToolbarReg[] = []
  private readonly slash: SlashReg[] = []
  private readonly statusRegs: StatusReg[] = []
  private readonly panelRegs: PanelReg[] = []
  private readonly aiToolRegs = new Map<string, AIToolReg>()
  private readonly codecRegs = new Map<string, CodecReg>()
  private readonly surfaceRegs = new Map<string, SurfaceReg>()
  private readonly changeListeners = new Set<ChangeListener>()
  private readonly listeners = new Set<() => void>()
  /** 编辑器栈：最后一个是「当前活动」的。 */
  private readonly hosts: HostBinding[] = []
  private readonly grants = new Map<string, Promise<boolean>>()
  private confirmWrite: RegistryOptions['confirmWrite']
  private versionCounter = 0

  constructor(options: RegistryOptions = {}) {
    this.options = options
    this.confirmWrite = options.confirmWrite
  }

  /** 贡献集合每变一次加一，界面据此重算（Vue 里放进一个 ref 即可）。 */
  get version(): number {
    return this.versionCounter
  }

  /** 设置 / 替换 `document.write` 的确认回调（界面层在启动时接上确认弹窗）。 */
  setConfirmWrite(confirm: RegistryOptions['confirmWrite']): void {
    this.confirmWrite = confirm
  }

  /** 订阅贡献集合的变化；返回退订函数。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 批量修改期间（卸载一个扩展会撤销几十项贡献）只通知一次，界面不必重算几十遍。 */
  private batchDepth = 0
  private batchDirty = false

  private batch(fn: () => void): void {
    this.batchDepth += 1
    try {
      fn()
    } finally {
      this.batchDepth -= 1
      if (this.batchDepth === 0 && this.batchDirty) {
        this.batchDirty = false
        this.notify()
      }
    }
  }

  private notify(): void {
    if (this.batchDepth > 0) {
      this.batchDirty = true
      return
    }
    this.versionCounter += 1
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('扩展注册表的订阅者抛错', error)
      }
    }
  }

  private report(entry: Entry, error: unknown): void {
    if (this.options.onError) this.options.onError(entry.manifest, error)
    else console.error(`扩展 ${entry.manifest.id} 出错`, error)
  }

  // ---------------------------------------------------------------- 安装 / 卸载

  /**
   * 安装并启动扩展。同 id 已安装时先卸载旧的（所以重复安装是幂等的，得到的永远是最后一次安装的那个）。
   * 启动失败会回滚它已经注册的一切并抛 `ExtensionRegistryError(activation)`。
   */
  async install(manifest: ExtensionManifest, extension: EditorExtension, options: { builtin?: boolean } = {}): Promise<void> {
    this.assertInstallable(manifest, extension)
    // 先把旧的同步摘干净，再等它的 deactivate；循环是因为等待期间别的调用可能又装进来一个
    for (let existing = this.entries.get(manifest.id); existing; existing = this.entries.get(manifest.id)) {
      await this.uninstall(manifest.id)
    }
    const entry = this.createEntry(manifest, extension, options.builtin === true)
    try {
      await extension.activate(this.createContext(entry))
    } catch (error) {
      this.disposeEntry(entry)
      throw new ExtensionRegistryError('activation', manifest.id, `扩展 ${manifest.id} 启动失败：${messageOf(error)}`, { cause: error })
    }
    if (entry.disposed) {
      // activate 期间被卸载 / 被同 id 的新安装顶掉了
      throw new ExtensionRegistryError('stale', manifest.id, `扩展 ${manifest.id} 在启动期间被卸载`)
    }
  }

  /** 同步安装内置扩展：`activate` 必须同步完成（内置贡献要在首次渲染前就位）。 */
  installBuiltin(manifest: ExtensionManifest, extension: EditorExtension): void {
    this.assertInstallable(manifest, extension)
    const existing = this.entries.get(manifest.id)
    if (existing) this.disposeEntry(existing)
    const entry = this.createEntry(manifest, extension, true)
    try {
      const result = extension.activate(this.createContext(entry))
      if (result instanceof Promise) {
        void result.catch((error) => this.report(entry, error))
        throw new Error('内置扩展的 activate 必须是同步的')
      }
    } catch (error) {
      this.disposeEntry(entry)
      throw new ExtensionRegistryError('activation', manifest.id, `内置扩展 ${manifest.id} 启动失败：${messageOf(error)}`, { cause: error })
    }
  }

  /** 卸载扩展；没装过返回 false（重复卸载安全）。 */
  async uninstall(id: string): Promise<boolean> {
    const entry = this.entries.get(id)
    if (!entry) return false
    // 先同步摘掉全部贡献（界面立刻不再显示），再慢慢等 deactivate；
    // 反过来的话，一个卡住的 deactivate 会让按钮一直挂在界面上
    this.disposeEntry(entry)
    await this.runDeactivate(entry)
    return true
  }

  /** 卸载所有第三方扩展（保留内置的）。 */
  async uninstallExternal(): Promise<void> {
    for (const entry of [...this.entries.values()]) if (!entry.builtin) await this.uninstall(entry.manifest.id)
  }

  isInstalled(id: string): boolean {
    return this.entries.has(id)
  }

  list(): InstalledInfo[] {
    return [...this.entries.values()].map((entry) => ({ manifest: entry.manifest, builtin: entry.builtin }))
  }

  private assertInstallable(manifest: ExtensionManifest, extension: EditorExtension): void {
    if (manifest.apiVersion !== EDITOR_API_VERSION) {
      throw new ExtensionRegistryError('invalid', manifest.id, `扩展 ${manifest.id} 的 api_version=${manifest.apiVersion} 不被支持（支持 ${EDITOR_API_VERSION}）`)
    }
    if (!extension || typeof extension.activate !== 'function') {
      throw new ExtensionRegistryError('invalid', manifest.id, `扩展 ${manifest.id} 没有 activate 函数`)
    }
  }

  private createEntry(manifest: ExtensionManifest, extension: EditorExtension, builtin: boolean): Entry {
    const entry: Entry = { manifest, builtin, extension, disposed: false, disposers: [] }
    this.entries.set(manifest.id, entry)
    return entry
  }

  /** 同步部分：撤销全部贡献、订阅，清掉写权限确认记录。 */
  private disposeEntry(entry: Entry): void {
    if (entry.disposed) return
    entry.disposed = true
    this.batch(() => {
      for (const dispose of entry.disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch (error) {
          this.report(entry, error)
        }
      }
      if (this.entries.get(entry.manifest.id) === entry) {
        this.entries.delete(entry.manifest.id)
        // 重装 = 可能是新代码：写权限要重新确认
        this.grants.delete(entry.manifest.id)
      }
      this.batchDirty = true
    })
  }

  private async runDeactivate(entry: Entry): Promise<void> {
    const deactivate = entry.extension.deactivate
    if (typeof deactivate !== 'function') return
    const timeoutMs = this.options.deactivateTimeoutMs ?? DEFAULT_DEACTIVATE_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(() => deactivate.call(entry.extension)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        }),
      ])
    } catch (error) {
      this.report(entry, error)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  // ---------------------------------------------------------------- 编辑器绑定

  /** Host 挂载时登记；返回的函数在卸载时调用。 */
  attachHost(binding: HostBinding): () => void {
    this.hosts.push(binding)
    return () => {
      const index = this.hosts.indexOf(binding)
      if (index >= 0) this.hosts.splice(index, 1)
      for (const item of [...this.changeListeners]) if (item.binding === binding) this.changeListeners.delete(item)
    }
  }

  /** 把某个编辑器标成「当前活动」（获得焦点时调用）。 */
  activateHost(binding: HostBinding): void {
    const index = this.hosts.indexOf(binding)
    if (index < 0 || index === this.hosts.length - 1) return
    this.hosts.splice(index, 1)
    this.hosts.push(binding)
  }

  get activeHost(): HostBinding | null {
    return this.hosts[this.hosts.length - 1] ?? null
  }

  /** Host 在正文变化（已防抖）时调用，把通知发给订阅了 `document.onChange` 的扩展。 */
  emitChange(binding: HostBinding): void {
    for (const item of [...this.changeListeners]) {
      if (item.entry.disposed) continue
      const target = item.binding ?? this.activeHost
      if (target !== binding) continue
      try {
        item.listener()
      } catch (error) {
        this.report(item.entry, error)
      }
    }
  }

  // ---------------------------------------------------------------- 上下文

  /** 把一个注册动作包装成 Disposable：撤销函数只执行一次，同时从扩展的回收清单里摘掉。 */
  private track(entry: Entry, undo: () => void): Disposable {
    let done = false
    const dispose = (): void => {
      if (done) return
      done = true
      const index = entry.disposers.indexOf(dispose)
      if (index >= 0) entry.disposers.splice(index, 1)
      undo()
      this.notify()
    }
    entry.disposers.push(dispose)
    this.notify()
    return { dispose }
  }

  private assertAlive(entry: Entry): void {
    if (entry.disposed) {
      throw new ExtensionRegistryError('disposed', entry.manifest.id, `扩展 ${entry.manifest.id} 已卸载，它的上下文不能再使用`)
    }
  }

  /** 第三方扩展注册的 id 必须在清单里声明过。 */
  private assertDeclared(entry: Entry, category: keyof ExtensionManifest['contributes'], id: string, label: string): void {
    if (entry.builtin) return
    const declared = entry.manifest.contributes[category] as readonly { id: string }[]
    if (!declared.some((item) => item.id === id)) {
      throw new ExtensionRegistryError(
        'undeclared',
        entry.manifest.id,
        `扩展 ${entry.manifest.id} 注册了${label}「${id}」，但 manifest.toml 的 [[contributes.${category === 'aiTools' ? 'ai_tools' : category}]] 里没有声明它`,
      )
    }
  }

  private assertNotTaken(entry: Entry, taken: boolean, id: string, label: string): void {
    if (taken) throw new ExtensionRegistryError('conflict', entry.manifest.id, `${label}「${id}」已经被注册，不能重复注册`)
  }

  private createContext(entry: Entry): ExtensionContext {
    const registry = this
    const api = this.createApi(entry, () => this.activeHost, null)
    const subscriptions = {
      add: (item: Disposable | (() => void)): void => {
        this.assertAlive(entry)
        const dispose = typeof item === 'function' ? item : () => item.dispose()
        entry.disposers.push(dispose)
      },
    }
    return {
      ...api,
      subscriptions,
      registerCommand(id, handler) {
        registry.assertAlive(entry)
        registry.assertDeclared(entry, 'commands', id, '命令')
        if (typeof handler !== 'function') throw new ExtensionRegistryError('invalid', entry.manifest.id, `命令「${id}」的处理器必须是函数`)
        registry.assertNotTaken(entry, registry.commands.has(id), id, '命令')
        registry.commands.set(id, { entry, handler })
        return registry.track(entry, () => {
          if (registry.commands.get(id)?.entry === entry) registry.commands.delete(id)
        })
      },
      registerToolbarItem(spec) {
        registry.assertAlive(entry)
        assertPermission(entry.manifest, 'ui', 'registerToolbarItem')
        registry.assertDeclared(entry, 'toolbar', spec.id, '工具栏按钮')
        registry.assertOwnCommand(entry, spec.command, `工具栏按钮「${spec.id}」`)
        registry.assertToolbarShape(entry, spec)
        // 同一个 id 可以为不同的内容面 / 格式 / 方案各注册一次（内置的「查找」在文本、代码、PDF 上文案不同），但作用范围不能重叠
        registry.assertNotTaken(entry, registry.toolbar.some((item) => item.spec.id === spec.id && scopesOverlap(item.spec, spec)), spec.id, '工具栏按钮')
        const reg: ToolbarReg = { entry, spec }
        registry.toolbar.push(reg)
        return registry.track(entry, () => removeItem(registry.toolbar, reg))
      },
      registerSlashItem(spec) {
        registry.assertAlive(entry)
        assertPermission(entry.manifest, 'ui', 'registerSlashItem')
        registry.assertDeclared(entry, 'slash', spec.id, '斜杠菜单项')
        registry.assertOwnCommand(entry, spec.command, `斜杠菜单项「${spec.id}」`)
        registry.assertNotTaken(entry, registry.slash.some((item) => item.spec.id === spec.id), spec.id, '斜杠菜单项')
        const reg: SlashReg = { entry, spec }
        registry.slash.push(reg)
        return registry.track(entry, () => removeItem(registry.slash, reg))
      },
      registerPanel(spec) {
        registry.assertAlive(entry)
        assertPermission(entry.manifest, 'ui', 'registerPanel')
        registry.assertDeclared(entry, 'panels', spec.id, '面板')
        if (typeof spec.mount !== 'function') throw new ExtensionRegistryError('invalid', entry.manifest.id, `面板「${spec.id}」缺少 mount 函数`)
        registry.assertNotTaken(entry, registry.panelRegs.some((item) => item.spec.id === spec.id), spec.id, '面板')
        const reg: PanelReg = { entry, spec }
        registry.panelRegs.push(reg)
        return registry.track(entry, () => removeItem(registry.panelRegs, reg))
      },
      registerCodec(spec) {
        registry.assertAlive(entry)
        // Codec 决定了某类文件怎么读、怎么写回，所以读写权限都要有（写仍要用户确认，见 encode）
        assertPermissions(entry.manifest, ['document.read', 'document.write'], 'registerCodec')
        registry.assertDeclared(entry, 'codecs', spec.id, 'Codec')
        const extensions = registry.claimedExtensions(entry, 'codecs', spec.id, spec.extensions, registry.codecRegs)
        const target = spec.surface ?? 'code'
        registry.assertCodecSurface(entry, target)
        if (typeof spec.decode !== 'function' || typeof spec.encode !== 'function') {
          throw new ExtensionRegistryError('invalid', entry.manifest.id, `Codec「${spec.id}」需要 decode 和 encode 两个函数`)
        }
        const reg: CodecReg = { entry, spec, extensions }
        for (const ext of extensions) registry.codecRegs.set(ext, reg)
        return registry.track(entry, () => {
          for (const ext of extensions) if (registry.codecRegs.get(ext) === reg) registry.codecRegs.delete(ext)
        })
      },
      registerSurface(spec) {
        registry.assertAlive(entry)
        assertPermissions(entry.manifest, ['ui', 'document.read'], 'registerSurface')
        registry.assertDeclared(entry, 'surfaces', spec.id, '内容面')
        const extensions = registry.claimedExtensions(entry, 'surfaces', spec.id, spec.extensions, registry.surfaceRegs)
        if (typeof spec.create !== 'function') throw new ExtensionRegistryError('invalid', entry.manifest.id, `内容面「${spec.id}」缺少 create 函数`)
        const kind: SurfaceKindName = `${EXT_KIND_PREFIX}${spec.id}`
        const reg: SurfaceReg = { entry, spec, extensions, kind }
        for (const ext of extensions) registry.surfaceRegs.set(ext, reg)
        // 接入内容面注册表：Host 照常用 loadSurface(kind) 取，不需要认识扩展
        registerSurfaceLoader(kind, async () => (() => registry.guardSurface(entry, spec.create())) as SurfaceFactory)
        return registry.track(entry, () => {
          for (const ext of extensions) if (registry.surfaceRegs.get(ext) === reg) registry.surfaceRegs.delete(ext)
          unregisterSurfaceLoader(kind)
        })
      },
      registerStatusItem(spec) {
        registry.assertAlive(entry)
        assertPermission(entry.manifest, 'ui', 'registerStatusItem')
        // 状态栏项和工具栏按钮都是「往编辑器外壳里加的条目」，共用 [[contributes.toolbar]] 声明
        registry.assertDeclared(entry, 'toolbar', spec.id, '状态栏项')
        if (typeof spec.text !== 'function') throw new ExtensionRegistryError('invalid', entry.manifest.id, `状态栏项「${spec.id}」缺少 text 函数`)
        const area: StatusArea = spec.area === 'chrome' ? 'chrome' : 'status'
        registry.assertNotTaken(
          entry,
          registry.statusRegs.some((item) => item.spec.id === spec.id && (item.spec.area === 'chrome' ? 'chrome' : 'status') === area && scopesOverlap(item.spec, spec)),
          spec.id,
          '状态栏项',
        )
        const reg: StatusReg = { entry, spec }
        registry.statusRegs.push(reg)
        const tracked = registry.track(entry, () => removeItem(registry.statusRegs, reg))
        return { dispose: () => tracked.dispose(), refresh: () => (reg.entry.disposed ? undefined : registry.notify()) }
      },
      registerAITool(spec) {
        registry.assertAlive(entry)
        assertPermission(entry.manifest, 'ai', 'registerAITool')
        registry.assertDeclared(entry, 'aiTools', spec.id, 'AI 工具')
        if (spec.target === 'page' && !entry.builtin) {
          throw new ExtensionRegistryError('invalid', entry.manifest.id, `AI 工具「${spec.id}」的 target: "page" 只有内置扩展可用`)
        }
        if (typeof spec.run !== 'function') throw new ExtensionRegistryError('invalid', entry.manifest.id, `AI 工具「${spec.id}」缺少 run 函数`)
        registry.assertNotTaken(entry, registry.aiToolRegs.has(spec.id), spec.id, 'AI 工具')
        const reg: AIToolReg = { entry, spec }
        registry.aiToolRegs.set(spec.id, reg)
        return registry.track(entry, () => {
          if (registry.aiToolRegs.get(spec.id) === reg) registry.aiToolRegs.delete(spec.id)
        })
      },
    }
  }

  /**
   * 工具栏按钮的下拉子项也是命令入口：和按钮本身一样只能触发本扩展声明的命令。
   * 下拉只支持一层（Chrome 的菜单里不再套菜单），所以子项带 children 直接拒绝。
   */
  private assertToolbarShape(entry: Entry, spec: ToolbarItemSpec): void {
    const label = `工具栏按钮「${spec.id}」`
    if (spec.children !== undefined && !Array.isArray(spec.children)) {
      throw new ExtensionRegistryError('invalid', entry.manifest.id, `${label}的 children 必须是数组`)
    }
    const seen = new Set<string>()
    for (const child of spec.children ?? []) {
      this.assertOwnCommand(entry, child.command, `${label}的子项「${child.id}」`)
      if (child.children !== undefined) {
        throw new ExtensionRegistryError('invalid', entry.manifest.id, `${label}的子项「${child.id}」不能再有 children（下拉只支持一层）`)
      }
      if (seen.has(child.id)) throw new ExtensionRegistryError('invalid', entry.manifest.id, `${label}里有重复的子项 id「${child.id}」`)
      seen.add(child.id)
    }
    if (spec.children !== undefined && spec.choices !== undefined) {
      throw new ExtensionRegistryError('invalid', entry.manifest.id, `${label}不能同时有 children 和 choices`)
    }
  }

  /** 第三方的工具栏 / 斜杠项只能触发自己声明的命令，不能借按钮触发内置的写命令绕过权限。 */
  private assertOwnCommand(entry: Entry, command: string, label: string): void {
    if (entry.builtin) return
    if (!entry.manifest.contributes.commands.some((item) => item.id === command)) {
      throw new ExtensionRegistryError('undeclared', entry.manifest.id, `${label}的 command「${command}」不是本扩展在 [[contributes.commands]] 里声明的命令`)
    }
  }

  /** 解析并核对 Codec / 内容面要接管的扩展名：必须是声明过的、不是内置格式、没被别人占。 */
  private claimedExtensions(
    entry: Entry,
    category: 'codecs' | 'surfaces',
    id: string,
    requested: readonly string[] | undefined,
    taken: Map<string, unknown>,
  ): string[] {
    const declared = entry.builtin ? undefined : entry.manifest.contributes[category].find((item) => item.id === id)?.extensions
    const wanted = (requested ?? declared ?? []).map((ext) => normalizeFormat(ext))
    if (wanted.length === 0) throw new ExtensionRegistryError('invalid', entry.manifest.id, `「${id}」没有指定要接管的扩展名`)
    const out: string[] = []
    for (const ext of wanted) {
      if (!ext) throw new ExtensionRegistryError('invalid', entry.manifest.id, `「${id}」里有空的扩展名`)
      if (declared && !declared.includes(ext)) {
        throw new ExtensionRegistryError('undeclared', entry.manifest.id, `「${id}」要接管 .${ext}，但清单里只声明了 ${declared.map((item) => `.${item}`).join('、')}`)
      }
      if (resolveSurfaceKind(ext) !== null) {
        throw new ExtensionRegistryError('builtin_format', entry.manifest.id, `.${ext} 是内置支持的格式，扩展不能接管它`)
      }
      if (taken.has(ext)) {
        throw new ExtensionRegistryError('conflict', entry.manifest.id, `.${ext} 已经被别的扩展接管`)
      }
      if (!out.includes(ext)) out.push(ext)
    }
    return out
  }

  /** Codec 解码后的内容面：内置 6 类之一，或本扩展自己声明的 `ext:<id>`。 */
  private assertCodecSurface(entry: Entry, target: SurfaceKindName): void {
    if (!target.startsWith(EXT_KIND_PREFIX)) return
    if (entry.builtin) return
    const id = target.slice(EXT_KIND_PREFIX.length)
    if (!entry.manifest.contributes.surfaces.some((item) => item.id === id)) {
      throw new ExtensionRegistryError('undeclared', entry.manifest.id, `Codec 指定的内容面「${target}」不是本扩展声明的内容面`)
    }
  }

  /** 给第三方内容面套权限：它拿到的会话在没有 `document.write`（及确认）时改不了文档。 */
  private async guardSurface(entry: Entry, created: Surface | Promise<Surface>): Promise<Surface> {
    const surface = await created
    const guard = (session: DocumentSession): DocumentSession =>
      new Proxy(session, {
        get: (target, prop) => {
          if (prop === 'execute') {
            return async (command: EditorCommand) => {
              if (!isReadonlySafeCommand(command)) await this.ensureWrite(entry, `session.execute(${command.type})`)
              return target.execute(command)
            }
          }
          if (prop === 'save' || prop === 'undo' || prop === 'redo') {
            return async (...args: unknown[]) => {
              await this.ensureWrite(entry, `session.${String(prop)}`)
              return (target[prop] as (...rest: unknown[]) => Promise<unknown>).apply(target, args)
            }
          }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    return {
      mount: (el, ctx) => surface.mount(el, { ...ctx, session: guard(ctx.session) }),
      unmount: () => surface.unmount(),
      resize: (size) => surface.resize(size),
      focus: () => surface.focus(),
      setReadonly: (value) => surface.setReadonly(value),
      command: (command) => surface.command(command),
      query: (query) => surface.query(query),
      capture: () => surface.capture(),
      restore: (state) => surface.restore(state),
      ...(surface.textNow ? { textNow: () => surface.textNow!() } : {}),
    }
  }

  // ---------------------------------------------------------------- 宿主 API（按扩展 + 编辑器绑定）

  private createApi(entry: Entry, resolve: () => HostBinding | null, fixed: HostBinding | null): HostApi {
    const registry = this
    const manifest = entry.manifest
    const need = (action: string): HostBinding => {
      const binding = resolve()
      if (!binding) throw new ExtensionRegistryError('no_host', manifest.id, `${action} 需要一个打开的文档，现在没有`)
      return binding
    }
    const document: DocumentApi = {
      async read(): Promise<DocumentSnapshot> {
        registry.assertAlive(entry)
        assertPermission(manifest, 'document.read', 'document.read')
        const binding = need('document.read')
        return {
          text: await binding.readText(),
          selection: await binding.selectionText(),
          format: binding.format,
          kind: binding.kind,
          readonly: binding.isReadonly(),
        }
      },
      onChange(listener) {
        registry.assertAlive(entry)
        assertPermission(manifest, 'document.read', 'document.onChange')
        // 绑定到调用时的编辑器；activate 里调用（还没有活动编辑器）则跟随「当前活动」
        const item: ChangeListener = { entry, listener, binding: fixed }
        registry.changeListeners.add(item)
        return registry.track(entry, () => registry.changeListeners.delete(item))
      },
      async replaceSelection(text) {
        await registry.writeText(entry, resolve, 'document.replaceSelection', text, true)
      },
      async insertText(text) {
        await registry.writeText(entry, resolve, 'document.insertText', text, false)
      },
    }
    const clipboard: ClipboardApi = {
      async writeText(text) {
        registry.assertAlive(entry)
        assertPermission(manifest, 'clipboard', 'clipboard.writeText')
        await registry.clipboardImpl().writeText(text)
      },
      async readText() {
        registry.assertAlive(entry)
        assertPermission(manifest, 'clipboard', 'clipboard.readText')
        return registry.clipboardImpl().readText()
      },
    }
    // 页面通道只给内置扩展：导出 / 评论 / AI 面板是宿主页面的事，第三方没有理由、也不该替页面触发它们
    const page: PageChannel | undefined = entry.builtin
      ? { emit: (event, payload) => (registry.assertAlive(entry), resolve()?.emitToPage?.(event, payload)) }
      : undefined
    return {
      manifest,
      document,
      clipboard,
      ...(page ? { page } : {}),
      fetch: (input, init) => registry.guardedFetch(entry, input, init),
      notify(message, tone = 'success') {
        registry.assertAlive(entry)
        assertPermission(manifest, 'ui', 'notify')
        if (registry.options.notify) registry.options.notify(String(message), tone)
        else console.warn(`[扩展 ${manifest.id}] ${String(message)}`)
      },
    }
  }

  private clipboardImpl(): NonNullable<RegistryOptions['clipboard']> {
    return this.options.clipboard ?? navigator.clipboard
  }

  private async guardedFetch(entry: Entry, input: string | URL, init?: RequestInit): Promise<Response> {
    this.assertAlive(entry)
    assertPermission(entry.manifest, 'network', 'fetch')
    const origin = this.options.origin ?? (typeof location === 'undefined' ? 'http://localhost' : location.origin)
    let url: URL
    try {
      url = new URL(String(input), origin)
    } catch {
      throw new PermissionDeniedError(entry.manifest.id, 'network', 'fetch', `无法解析地址：${String(input)}`)
    }
    let credentials: RequestCredentials
    if (url.origin === origin) {
      const own = `/api/v1/editor/extensions/${entry.manifest.id}/`
      if (!url.pathname.startsWith(own)) {
        throw new PermissionDeniedError(entry.manifest.id, 'network', 'fetch', `扩展 ${entry.manifest.id} 只能访问自己目录下的文件（${own}…），不能访问本站其它地址`)
      }
      credentials = 'same-origin'
    } else if (url.protocol === 'https:') {
      // 外部站点永远不带本站 cookie
      credentials = 'omit'
    } else {
      throw new PermissionDeniedError(entry.manifest.id, 'network', 'fetch', `只允许 https 地址，收到 ${url.protocol}//${url.host}`)
    }
    const doFetch = this.options.fetch ?? ((address: string, options?: RequestInit) => fetch(address, options))
    return doFetch(url.toString(), { ...init, credentials, redirect: 'error' })
  }

  /** 第三方扩展第一次写文档时向用户确认；结果按扩展 id 记着（同一页面会话内不再问）。 */
  private async ensureWrite(entry: Entry, action: string): Promise<void> {
    this.assertAlive(entry)
    assertPermission(entry.manifest, 'document.write', action)
    if (entry.builtin) return
    let decision = this.grants.get(entry.manifest.id)
    if (!decision) {
      const confirm = this.confirmWrite
      decision = confirm
        ? Promise.resolve()
            .then(() => confirm(entry.manifest))
            .then(Boolean, () => false)
        : Promise.resolve(false)
      this.grants.set(entry.manifest.id, decision)
    }
    if (!(await decision)) {
      throw new PermissionDeniedError(entry.manifest.id, 'document.write', action, `没有得到允许：扩展「${entry.manifest.name}」不能修改文档`)
    }
  }

  /** 该扩展的写权限现在是什么状态（界面和测试用）。 */
  async writeGrantState(id: string): Promise<'granted' | 'denied' | 'unasked'> {
    const decision = this.grants.get(id)
    if (!decision) return 'unasked'
    return (await decision) ? 'granted' : 'denied'
  }

  /** 忘掉某个扩展的写权限确认结果，下次写文档时重新问。 */
  resetWriteGrant(id: string): void {
    this.grants.delete(id)
  }

  private async writeText(entry: Entry, resolve: () => HostBinding | null, action: string, text: string, needSelection: boolean): Promise<void> {
    this.assertAlive(entry)
    assertPermission(entry.manifest, 'document.write', action)
    if (typeof text !== 'string' || text.length === 0) {
      throw new ExtensionRegistryError('invalid', entry.manifest.id, `${action} 的 text 必须是非空字符串`)
    }
    const binding = resolve()
    if (!binding) throw new ExtensionRegistryError('no_host', entry.manifest.id, `${action} 需要一个打开的文档，现在没有`)
    // 只读先于确认：对只读文档弹「是否允许修改」只会让人困惑
    if (binding.isReadonly()) {
      throw new PermissionDeniedError(entry.manifest.id, 'document.write', action, '文档当前是只读的，不能修改')
    }
    if (needSelection && (await binding.selectionText()).length === 0) {
      throw new ExtensionRegistryError('invalid', entry.manifest.id, `${action} 需要先选中一段文字`)
    }
    await this.ensureWrite(entry, action)
    const result = await binding.execute({ id: `ext_${entry.manifest.id}_${Date.now()}`, type: 'text.insert', args: { text }, source: 'api', origin: entry.manifest.id })
    if (!result.ok) throw new Error(`修改文档失败：${result.reason ?? '未知原因'}`)
  }

  // ---------------------------------------------------------------- 查询（给 Host / Chrome）

  /** 格式工具栏里的按钮（`placement` 缺省或 `toolbar`）。`scope` 过滤格式与工具栏方案，缺省只取不限格式 / 不限方案的。 */
  toolbarItemsFor(kind: SurfaceKindName, scope: ToolbarScope = {}): ToolbarEntry[] {
    return this.toolbarEntries(kind, scope, 'toolbar')
  }

  /** 顶栏右侧操作区里的按钮（`placement: 'bar'`）。 */
  barItemsFor(kind: SurfaceKindName, scope: ToolbarScope = {}): ToolbarEntry[] {
    return this.toolbarEntries(kind, scope, 'bar')
  }

  private toolbarEntries(kind: SurfaceKindName, scope: ToolbarScope, placement: 'toolbar' | 'bar'): ToolbarEntry[] {
    const format = scope.format === undefined ? undefined : normalizeFormat(scope.format)
    const profile = scope.profile ?? DEFAULT_PROFILE
    return this.toolbar
      .filter(({ spec }) => (spec.placement === 'bar' ? 'bar' : 'toolbar') === placement)
      .filter(({ spec }) => !spec.kinds || spec.kinds.includes(kind))
      .filter(({ spec }) => !spec.formats || (format !== undefined && spec.formats.map(normalizeFormat).includes(format)))
      .filter(({ spec }) => spec.profile === undefined || spec.profile === profile)
      .map((reg) => ({ extensionId: reg.entry.manifest.id, spec: reg.spec }))
  }

  /** 某内容面、某区域的状态栏项（按注册顺序）。 */
  statusItemsFor(kind: SurfaceKindName, area: StatusArea): StatusEntry[] {
    return this.statusRegs
      .filter(({ spec }) => (spec.area === 'chrome' ? 'chrome' : 'status') === area)
      .filter(({ spec }) => !spec.kinds || spec.kinds.includes(kind))
      .map((reg) => ({ extensionId: reg.entry.manifest.id, spec: reg.spec }))
  }

  /**
   * 求值：把状态交给每个状态栏项的 `text`，丢掉空文字。某个扩展的 `text` 抛错只让它自己这一项不显示（记一次错误），
   * 不能拖垮整个外壳的渲染。
   */
  statusTexts(kind: SurfaceKindName, area: StatusArea, state: StatusState): StatusView[] {
    const out: StatusView[] = []
    for (const reg of this.statusRegs) {
      const { spec } = reg
      if ((spec.area === 'chrome' ? 'chrome' : 'status') !== area || (spec.kinds && !spec.kinds.includes(kind))) continue
      try {
        const text = spec.text(state)
        if (typeof text === 'string' && text.length > 0) out.push({ id: spec.id, extensionId: reg.entry.manifest.id, text, ...(spec.title === undefined ? {} : { title: spec.title }) })
      } catch (error) {
        this.report(reg.entry, error)
      }
    }
    return out
  }

  slashItemsFor(kind: SurfaceKindName): SlashEntry[] {
    return this.slash
      .filter((reg) => (reg.spec.kinds ?? SLASH_DEFAULT_KINDS).includes(kind))
      .map((reg) => ({ extensionId: reg.entry.manifest.id, spec: reg.spec }))
  }

  panels(kind: SurfaceKindName): PanelInfo[] {
    return this.panelRegs
      .filter((reg) => !reg.spec.kinds || reg.spec.kinds.includes(kind))
      .map((reg) => ({
        key: `${reg.entry.manifest.id}:${reg.spec.id}`,
        id: reg.spec.id,
        extensionId: reg.entry.manifest.id,
        title: reg.spec.title,
        ...(reg.spec.icon === undefined ? {} : { icon: reg.spec.icon }),
      }))
  }

  /**
   * 把面板画进 `el`，返回清理函数（只会执行一次）。`mount` 抛错或异步失败时记录并返回空清理。
   * 面板拿到的 API 绑定在 `binding` 这个编辑器上。
   */
  async mountPanel(panel: PanelInfo, el: HTMLElement, binding: HostBinding | null): Promise<() => void> {
    const reg = this.panelRegs.find((item) => item.entry.manifest.id === panel.extensionId && item.spec.id === panel.id)
    if (!reg || reg.entry.disposed) return () => undefined
    let cleanup: (() => void) | undefined
    try {
      const result = await reg.spec.mount(el, this.createApi(reg.entry, () => binding, binding))
      if (typeof result === 'function') cleanup = result
    } catch (error) {
      this.report(reg.entry, error)
    }
    let done = false
    return () => {
      if (done) return
      done = true
      try {
        cleanup?.()
      } catch (error) {
        this.report(reg.entry, error)
      }
    }
  }

  hasCommand(id: string): boolean {
    return this.commands.has(id)
  }

  /** 执行扩展命令；找不到或处理器抛错都返回 `ok: false`，不向调用方抛。 */
  async runCommand(id: string, args: unknown, binding: HostBinding | null = this.activeHost): Promise<CommandResult> {
    const reg = this.commands.get(id)
    if (!reg) return { ok: false, reason: `unknown_command:${id}` }
    try {
      await reg.handler(args, this.createApi(reg.entry, () => binding, binding))
      return { ok: true }
    } catch (error) {
      this.report(reg.entry, error)
      return { ok: false, reason: messageOf(error) }
    }
  }

  aiTools(): AIToolInfo[] {
    return [...this.aiToolRegs.values()].map((reg) => ({
      id: reg.spec.id,
      extensionId: reg.entry.manifest.id,
      title: reg.spec.title,
      target: reg.spec.target === 'page' ? 'page' : 'suggestion',
      ...(reg.spec.description === undefined ? {} : { description: reg.spec.description }),
    }))
  }

  /** 对当前选区运行 AI 工具，结果是「建议」，不会自己改文档。 */
  async runAITool(id: string, binding: HostBinding | null = this.activeHost): Promise<AISuggestion> {
    const reg = this.aiToolRegs.get(id)
    if (!reg) throw new ExtensionRegistryError('invalid', '', `AI 工具「${id}」不存在或已卸载`)
    this.assertAlive(reg.entry)
    assertPermissions(reg.entry.manifest, ['ai', 'document.read'], `aiTool ${id}`)
    if (!binding) throw new ExtensionRegistryError('no_host', reg.entry.manifest.id, 'AI 工具需要一个打开的文档，现在没有')
    const input: AIToolInput = { text: await binding.selectionText(), format: binding.format, kind: binding.kind }
    const result = await reg.spec.run(input, this.createApi(reg.entry, () => binding, binding))
    const text = typeof result === 'string' ? result : result?.text
    if (typeof text !== 'string') {
      throw new ExtensionRegistryError('invalid', reg.entry.manifest.id, `AI 工具「${id}」没有返回文字结果`)
    }
    const note = typeof result === 'object' && result !== null ? result.note : undefined
    return { toolId: id, extensionId: reg.entry.manifest.id, original: input.text, text, ...(note === undefined ? {} : { note }) }
  }

  /** 用户接受建议：核对选区没变，再走 `document.replaceSelection`（需要 `document.write` + 确认）。 */
  async applySuggestion(suggestion: AISuggestion, binding: HostBinding | null = this.activeHost): Promise<void> {
    const entry = this.entries.get(suggestion.extensionId)
    if (!entry) throw new ExtensionRegistryError('stale', suggestion.extensionId, '提供这个建议的扩展已经卸载')
    if (!binding) throw new ExtensionRegistryError('no_host', entry.manifest.id, '没有打开的文档')
    if ((await binding.selectionText()) !== suggestion.original) {
      throw new ExtensionRegistryError('stale', entry.manifest.id, '选区已经变化，请重新运行这个工具')
    }
    await this.createApi(entry, () => binding, binding).document.replaceSelection(suggestion.text)
  }

  /** 某扩展名的 Codec（带权限闸门的 decode / encode）。 */
  codecFor(format: string): CodecHandle | null {
    const reg = this.codecRegs.get(normalizeFormat(format))
    if (!reg || reg.entry.disposed) return null
    const { entry, spec } = reg
    return {
      id: spec.id,
      extensionId: entry.manifest.id,
      surface: spec.surface ?? 'code',
      decode: async (bytes, ctx) => {
        this.assertAlive(entry)
        assertPermission(entry.manifest, 'document.read', `codec ${spec.id}.decode`)
        return spec.decode(bytes, ctx)
      },
      encode: async (source, ctx) => {
        await this.ensureWrite(entry, `codec ${spec.id}.encode`)
        return spec.encode(source, ctx)
      },
    }
  }

  /** 某扩展名的扩展内容面。 */
  surfaceFor(format: string): { kind: SurfaceKindName; extensionId: string; id: string } | null {
    const reg = this.surfaceRegs.get(normalizeFormat(format))
    if (!reg || reg.entry.disposed) return null
    return { kind: reg.kind, extensionId: reg.entry.manifest.id, id: reg.spec.id }
  }

  /**
   * 格式 → 内容面类型：内置映射优先（内置格式永远不会被扩展覆盖），其次扩展内容面，最后扩展 Codec。
   * 都不认识返回 null。
   */
  resolveKind(formatOrPath: string): SurfaceKindName | null {
    const builtin = resolveSurfaceKind(formatOrPath)
    if (builtin) return builtin
    const ext = normalizeFormat(formatOrPath)
    return this.surfaceFor(ext)?.kind ?? this.codecFor(ext)?.surface ?? null
  }

  /** 扩展 id 是否有写权限被用户允许（测试与诊断用）。 */
  permissionsOf(id: string): readonly Permission[] {
    return this.entries.get(id)?.manifest.permissions ?? []
  }
}

function removeItem<T>(list: T[], item: T): void {
  const index = list.indexOf(item)
  if (index >= 0) list.splice(index, 1)
}
