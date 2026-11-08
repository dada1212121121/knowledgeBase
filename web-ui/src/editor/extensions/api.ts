/**
 * 编辑器扩展 API v1 的类型与常量
 *
 * 这个文件是「扩展作者能看到的全部契约」，经 `editor/api/index.ts` 对外导出。
 * 约束（设计规范）：
 * 1. 版本只有一个整数 `EDITOR_API_VERSION`：新增可选字段不升版本，破坏性变更才升 2；
 * 2. 扩展只能依赖本文件导出的东西，不能 import `editor/` 下的其它内部模块；
 * 3. 权限默认最小：清单没声明的权限，对应的 API 调用一律抛 `PermissionDeniedError`（不是返回 undefined）。
 *
 * 注意：权限是**协作式的 API 闸门**，不是安全沙箱——扩展脚本和页面在同一个 JS 环境里跑，
 * 恶意脚本绕得过去。真正的信任边界是「只加载管理员放进本地目录的扩展」，见 docs/EDITOR_EXTENSIONS.md。
 */
import type { CommandResult, EditorSource, SessionPhase, Surface } from '../types'

/** 扩展 API 版本。清单里的 `api_version` 必须等于它。 */
export const EDITOR_API_VERSION = 1 as const

/** 可声明的权限。 */
export type Permission = 'document.read' | 'document.write' | 'clipboard' | 'network' | 'ai' | 'ui'

/** 全部权限（清单校验、文档与测试共用同一份）。 */
export const PERMISSIONS: readonly Permission[] = ['document.read', 'document.write', 'clipboard', 'network', 'ai', 'ui']

/** 可撤销的注册句柄：重复 dispose 是安全的。 */
export interface Disposable {
  dispose(): void
}

/**
 * 内容面类型：内置 6 类 + 扩展自定义（`ext:<贡献 id>`）。
 * 扩展自己的内容面不会和内置类型重名，Host 看到 `ext:` 前缀就知道要去扩展注册表里找。
 */
export type BuiltinSurfaceKindName = 'text' | 'grid' | 'page' | 'slide' | 'code' | 'pdf'
export type SurfaceKindName = BuiltinSurfaceKindName | `ext:${string}`

// ---------------------------------------------------------------- 清单

/** 清单里声明的贡献：运行时注册的 id 必须先在这里出现过（内置扩展除外）。 */
export interface ManifestContributes {
  readonly commands: readonly { readonly id: string; readonly title: string }[]
  readonly toolbar: readonly { readonly id: string }[]
  readonly slash: readonly { readonly id: string }[]
  readonly panels: readonly { readonly id: string; readonly title: string; readonly icon?: string }[]
  readonly codecs: readonly { readonly id: string; readonly extensions: readonly string[] }[]
  readonly surfaces: readonly { readonly id: string; readonly extensions: readonly string[] }[]
  readonly aiTools: readonly { readonly id: string; readonly title: string }[]
}

/** 通过校验的清单（`manifest.toml` 经后端解析、前端 `parseManifest` 再校验一遍的结果）。 */
export interface ExtensionManifest {
  /** 小写字母 / 数字 / `.` / `-`，如 `kb.word-count`。 */
  readonly id: string
  readonly name: string
  /** semver。 */
  readonly version: string
  readonly apiVersion: number
  readonly description?: string
  /** 入口脚本（相对扩展目录），默认 `index.js`。 */
  readonly entry: string
  readonly permissions: readonly Permission[]
  readonly contributes: ManifestContributes
}

// ---------------------------------------------------------------- 文档与宿主 API

/** `document.read` 的返回。 */
export interface DocumentSnapshot {
  /** 当前正文（有人在协同编辑时是大家正在改的版本）。 */
  readonly text: string
  /** 当前选区文字；没有选区是空串。 */
  readonly selection: string
  /** 文件格式（小写扩展名）。 */
  readonly format: string
  /** 内容面类型。 */
  readonly kind: SurfaceKindName
  /** 文档当前是否只读。 */
  readonly readonly: boolean
}

/** 文档 API。读需要 `document.read`，写需要 `document.write`（且首次使用时用户确认）。 */
export interface DocumentApi {
  /** 读当前文档。 */
  read(): Promise<DocumentSnapshot>
  /** 正文变化时通知（宿主已防抖约 150 ms）；回调里再调 `read` 取最新内容。 */
  onChange(listener: () => void): Disposable
  /** 用 `text` 替换当前选区；没有选区时抛错（不猜光标）。只读文档直接拒绝。 */
  replaceSelection(text: string): Promise<void>
  /** 在光标处插入（有选区时和键盘输入一样替换选区）。只读文档直接拒绝。 */
  insertText(text: string): Promise<void>
}

/** 剪贴板 API（需要 `clipboard`）。 */
export interface ClipboardApi {
  writeText(text: string): Promise<void>
  readText(): Promise<string>
}

/**
 * 命令处理器 / 面板 / AI 工具运行时拿到的宿主 API：
 * 已经绑定到「触发它的那个编辑器」，同时打开多个文档时不会串。
 */
export interface HostApi {
  readonly manifest: ExtensionManifest
  readonly document: DocumentApi
  readonly clipboard: ClipboardApi
  /**
   * 受限的 fetch（需要 `network`）：只允许 https 地址，和本扩展自己目录下的文件；
   * 访问外部地址不带 cookie，一律不跟随重定向。
   */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>
  /** 给用户一条不打断编辑的提示（需要 `ui`）；命令执行完告诉用户结果用它。 */
  notify(message: string, tone?: 'success' | 'warning' | 'danger'): void
  /** 宿主页面通道，仅内置扩展可用（导出 / 评论 / AI 面板由页面实现，见 `PageChannel`）。 */
  readonly page?: PageChannel
}

// ---------------------------------------------------------------- 各类贡献的描述

/** 命令处理器。`args` 来自工具栏 / 斜杠菜单的 `args`，或调用方传入。 */
export type CommandHandler = (args: unknown, api: HostApi) => void | Promise<void>

/** 宿主页面可能接入的能力：页面没接的能力，依赖它的入口（导出、评论、AI）不显示，免得出现点了没反应的按钮。 */
export type HostCapability = 'ai' | 'comment' | 'export'

/** 开关 / 状态类按钮的高亮判定：内容面把当前状态上报给宿主，宿主逐项比对（见 `FormatState`）。 */
export type ToolbarCheckSpec =
  | { readonly kind: 'mark'; readonly name: string }
  | { readonly kind: 'block'; readonly block: 'paragraph' | 'heading' | 'code_block' | 'blockquote'; readonly level?: number }
  | { readonly kind: 'list'; readonly list: 'bullet_list' | 'ordered_list' | 'task_list' }
  /** 视图开关（源码、软换行…）：内容面在 formatState.toggles 里列出开着的名字 */
  | { readonly kind: 'toggle'; readonly name: string }
  /** 当前值判定（对齐方式、字号…）：内容面在 formatState.values 里给出当前值，相等则亮 */
  | { readonly kind: 'value'; readonly name: string; readonly value: string | number }

/** 带选项的按钮（字号、颜色、表格大小…）的一个选项：选中时用它的 `args` 执行按钮的命令。 */
export interface ToolbarChoiceSpec {
  readonly label: string
  readonly args: unknown
  /** 色块（CSS 颜色）；没有就只显示文字 */
  readonly swatch?: string
  /** 字体预览（CSS 字体栈）：菜单里这一项的文字用这个字体显示，选字体时所见即所得 */
  readonly font?: string
  /** 判定这一项是不是当前值（菜单里打勾），和 `ToolbarCheckSpec` 的 `value` 同一套 formatState.values */
  readonly current?: { readonly name: string; readonly value: string | number }
}

/**
 * 一个按钮动作的完整声明（下拉里的子项也是它）。
 * 新增的 `keywords` / `choices` / `children` / `slash` / `description` 都是可选字段，不升 api_version。
 */
export interface ToolbarActionSpec {
  /** 必须在清单 `[[contributes.toolbar]]` 里声明（子项除外，它跟着父按钮走）。 */
  readonly id: string
  /** 按钮文案，也是无障碍名称。 */
  readonly label: string
  /** 同一扩展注册的命令 id。 */
  readonly command: string
  readonly args?: unknown
  /** 单字符或无歧义的短符号。 */
  readonly icon?: string
  /** 命令会改文档：只读时整个按钮不显示。 */
  readonly write?: boolean
  readonly shortcut?: string
  /** 命令是 UI 类动作（宿主内置的 `search.open` 之类，仅内置扩展使用）。 */
  readonly ui?: boolean
  /** 高亮判定。`toggle` 是 加的，其余是 把内置工具栏迁进来时补齐的。 */
  readonly check?: ToolbarCheckSpec
  /** 命令面板 / 斜杠菜单检索用的关键词 */
  readonly keywords?: readonly string[]
  /** 带选项的按钮：点开列出选项，选中某项时用该项的 `args` 执行 `command` */
  readonly choices?: readonly ToolbarChoiceSpec[]
  /** 下拉按钮：自己不执行命令，点开列出子动作（只支持一层） */
  readonly children?: readonly ToolbarActionSpec[]
  /** 内置工具栏迁移到斜杠菜单时的显示策略（`always` 一定放、`never` 不放）；第三方请用 `registerSlashItem` */
  readonly slash?: 'always' | 'never'
  /** 比 `label` 更完整的说明：用作 `aria-label` / 悬停提示（放在顶栏操作区的按钮用得到，如「导出 Markdown」） */
  readonly description?: string
  /** 双击按钮时用这组参数执行同一个 `command`（内置格式刷：单击刷一次、双击连续刷）；不写就没有双击行为 */
  readonly doubleClickArgs?: unknown
}

/**
 * 工具栏按钮（需要 `ui`）。点击后执行同一扩展里已声明的命令。
 * 新增的 `formats` / `profile` / `placement` / `capability` / `compact` 都是可选字段，不升 api_version。
 */
export interface ToolbarItemSpec extends ToolbarActionSpec {
  /** 放进哪个分组：内置分组 id（`marks` / `blocks` / `lists` / `insert` / `view`）或自定义；缺省 `ext`（「扩展」）。 */
  readonly group?: string
  /** 自定义分组的显示名。 */
  readonly groupLabel?: string
  /** 只在这些内容面显示；缺省所有内容面。 */
  readonly kinds?: readonly SurfaceKindName[]
  /** 只在这些文件格式（小写扩展名，不带点）显示，如 CSV 的行操作只给 `csv` / `tsv`；缺省不限格式。 */
  readonly formats?: readonly string[]
  /**
   * 工具栏方案：同一内容面有多套工具栏时用它区分（Word 的只读预览与画布编辑）。
   * 缺省的按钮在所有方案里都显示；写了方案名的只在页面选了该方案时显示（页面没选 = `default`）。
   */
  readonly profile?: string
  /** 放在哪：`toolbar`（缺省，格式工具栏）或 `bar`（顶栏右侧操作区，带文字的小按钮，和面板开关、撤销 / 保存同一排）。 */
  readonly placement?: 'toolbar' | 'bar'
  /** 宿主页面接入了这项能力才显示。 */
  readonly capability?: HostCapability
  /** `hide`：手机上外壳压成一行时不显示（页头已经有同样的入口）。 */
  readonly compact?: 'hide'
}

/** 斜杠菜单项（需要 `ui`）。 */
export interface SlashItemSpec {
  readonly id: string
  readonly label: string
  readonly command: string
  readonly args?: unknown
  readonly icon?: string
  readonly keywords?: readonly string[]
  /** 缺省只在 `text`（Markdown 笔记）里出现。 */
  readonly kinds?: readonly SurfaceKindName[]
  readonly write?: boolean
}

/** 面板（需要 `ui`）。`mount` 往 `el` 里画 DOM，可返回清理函数，面板关闭或扩展卸载时调用。 */
export interface PanelSpec {
  readonly id: string
  readonly title: string
  readonly icon?: string
  readonly kinds?: readonly SurfaceKindName[]
  mount(el: HTMLElement, api: HostApi): void | (() => void) | Promise<void | (() => void)>
}

/** Codec 解码 / 编码时的上下文。 */
export interface CodecContext {
  readonly name: string
  readonly format: string
}

/** Codec：把宿主不认识的扩展名的字节翻译成可编辑的文本，保存时再翻译回字节（需要 `document.read` + `document.write`）。 */
export interface CodecSpec {
  readonly id: string
  /** 缺省取清单里声明的扩展名；写了必须是清单声明的子集。 */
  readonly extensions?: readonly string[]
  /** 解码后交给哪个内容面（`code` / `text` 或本扩展的 `ext:<id>`）；缺省 `code`。 */
  readonly surface?: SurfaceKindName
  decode(bytes: Uint8Array, ctx: CodecContext): EditorSource | Promise<EditorSource>
  encode(source: EditorSource, ctx: CodecContext): Uint8Array | Promise<Uint8Array>
}

/** 内容面（需要 `ui` + `document.read`）：接管一批宿主不认识的扩展名。 */
export interface SurfaceSpec {
  readonly id: string
  readonly extensions?: readonly string[]
  /** 每打开一个文档调用一次，返回内容面实例。 */
  create(): Surface | Promise<Surface>
}

/** AI 工具的输入：宿主把当前选区交给它。 */
export interface AIToolInput {
  readonly text: string
  readonly format: string
  readonly kind: SurfaceKindName
}

/** AI 工具的结果：一律作为「建议」展示，用户接受后才写回文档。 */
export type AIToolResult = string | { readonly text: string; readonly note?: string }

/** AI 工具（需要 `ai`；运行时要读选区所以还需要 `document.read`）。 */
export interface AIToolSpec {
  readonly id: string
  readonly title: string
  readonly description?: string
  /**
   * 结果怎么交付：`suggestion`（缺省）显示成「建议」条，用户接受后才写回文档；
   * `page` 由嵌入编辑器的页面接管（内置的润色 / 总结 / 翻译：`run` 里经 `api.page` 把动作和选区交给页面的 AI 面板，
   * 宿主不再显示建议条）。`page` 只有内置扩展可用。
   */
  readonly target?: 'suggestion' | 'page'
  run(input: AIToolInput, api: HostApi): AIToolResult | Promise<AIToolResult>
}

// ---------------------------------------------------------------- 状态栏

/** 状态栏项放在哪：`chrome` 顶栏操作区（紧挨面板开关），`status` 底部状态栏。 */
export type StatusArea = 'chrome' | 'status'

/** 状态栏项能看到的宿主状态（只读快照；字数 / 单位由内容面上报，文本是字数，表格是「行 × 列」）。 */
export interface StatusState {
  readonly kind: SurfaceKindName
  readonly format: string
  readonly words: number
  /** 内容面上报的计数单位，如「格」「页」；为空表示按「字」计 */
  readonly unitLabel: string
  readonly readonly: boolean
  readonly dirty: boolean
  readonly phase: SessionPhase
}

/** 状态栏项（需要 `ui`）。 */
export interface StatusItemSpec {
  /** 必须在清单 `[[contributes.toolbar]]` 里声明（状态栏项和工具栏按钮共用这一类声明）。 */
  readonly id: string
  /** 缺省 `status`（底部状态栏）。 */
  readonly area?: StatusArea
  /** 悬停提示。 */
  readonly title?: string
  /** 只在这些内容面显示；缺省所有内容面。 */
  readonly kinds?: readonly SurfaceKindName[]
  /** 返回要显示的文字，空串 / `null` 表示这一刻不显示。宿主在计数、状态或扩展调用 `refresh` 后重新取值。 */
  text(state: StatusState): string | null | undefined
}

/** `registerStatusItem` 的句柄：除了撤销，还能让宿主重新取一次文字（扩展自己的数据变了时调用）。 */
export interface StatusItemHandle extends Disposable {
  refresh(): void
}

// ---------------------------------------------------------------- 宿主页面通道（内置扩展）

/** 转交给嵌入编辑器的页面的事件：导出、评论、AI 面板。 */
export type PageEvent = 'export' | 'comment' | 'ai'

/** 宿主页面通道：只有内置扩展有（第三方扩展拿到的 `HostApi.page` 永远是 `undefined`）。 */
export interface PageChannel {
  /** 把事件交给页面；这个编辑器还没就绪时什么也不做（和以前点早了的导出按钮一样）。 */
  emit(event: PageEvent, payload?: unknown): void
}

// ---------------------------------------------------------------- 扩展本体

/**
 * `activate` 时拿到的上下文：`HostApi` 加上注册方法。
 * 它是按清单权限裁剪过的——没声明的权限，对应方法被调用时抛 `PermissionDeniedError`。
 */
export interface ExtensionContext extends HostApi {
  registerCommand(id: string, handler: CommandHandler): Disposable
  registerToolbarItem(spec: ToolbarItemSpec): Disposable
  registerSlashItem(spec: SlashItemSpec): Disposable
  registerPanel(spec: PanelSpec): Disposable
  registerCodec(spec: CodecSpec): Disposable
  registerSurface(spec: SurfaceSpec): Disposable
  registerAITool(spec: AIToolSpec): Disposable
  registerStatusItem(spec: StatusItemSpec): StatusItemHandle
  /** 放进来的 Disposable 会在扩展卸载时自动 dispose（订阅、定时器等）。 */
  readonly subscriptions: { add(disposable: Disposable | (() => void)): void }
}

/** 扩展入口模块的默认导出。 */
export interface EditorExtension {
  activate(ctx: ExtensionContext): void | Promise<void>
  /** 卸载前调用（此时 `ctx` 已失效，只适合做自己的收尾）。 */
  deactivate?(): void | Promise<void>
}

/** 命令执行的结果（和 CommandBus 同形）。 */
export type ExtensionCommandResult = CommandResult
