<script setup lang="ts">
/**
 * 统一编辑器宿主外壳（接入 Session / CommandBus / History / Anchors）
 *
 * 设计约束（设计规范）：
 * 1. 全应用唯一编辑器入口组件，按格式路由到 6 类 Surface；Surface 由调用方注入 loader 懒加载。
 * 2. 会话与 Surface 实例一律存于 `shallowRef`：文档树 / Canvas DisplayList / WASM 句柄若进入深层响应式，
 *    一次 `ref(doc)` 就会把整棵文档树做成 Proxy，几十万节点的表格会直接把主线程拖死。
 * 3. 挂载异常、缺 Surface、格式不支持都必须落进可视错误边界并给 legacy 回退入口，禁止白屏。
 * 4. 键盘：`Ctrl/⌘+S` 走保存，`Ctrl/⌘+Z` / `Ctrl/⌘+Shift+Z` 走会话撤销重做，
 *    且只在焦点位于编辑器内部时拦截，避免抢走页面其它输入框的快捷键。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import EditorChrome, { type AiSuggestionView, type FindUiState, type FormatState } from './EditorChrome.vue'
import type { AiWriterView } from './AiWriteBar.vue'
import EditorStatus from './EditorStatus.vue'
import TextPanels from './TextPanels.vue'
import { commandFeedback, isReadonlySafeToolbarCommand } from './commandFeedback'
import { useEditorHotkeys } from './useEditorHotkeys'
import { registerBuiltinSurfaces } from '../surfaces/builtin'
import { barActionsFor, contributionWith, visibleAiTools } from '../extensions/contributions'
import type { SurfaceContribution } from '../extensions/builtin/text'
import type { AISuggestion, CodecHandle, HostBinding, PanelInfo, StatusView } from '../extensions/registry'
import { defaultExtensionGate, ensureExtensionsLoaded, getExtensionRegistry, notifyExtensionProblem, watchExtensionConfig } from '../extensions/runtime'
import type { PageEvent, StatusState, SurfaceKindName } from '../extensions/api'
import { loadSurface as loadRegisteredSurface } from '../surfaces/registry'
import { CommandBus } from '../session/CommandBus'
import { EditorDocumentSession, type SessionTransport } from '../session/DocumentSession'
import { SessionRegistry } from '../session/SessionRegistry'
import {
  canExecuteCommand,
  normalizeFormat,
  type AiApplyMode,
  type AiWriteAction,
  type AiWriteRequest,
  type Anchor,
  type CollabRoomStatus,
  type CommandResult,
  type EditorCommand,
  type EditorOpenRequest,
  type SessionPhase,
  type Surface,
  type SurfaceKind,
  type SurfaceQuery,
  type TextHostBridge,
  type TextServices,
} from '../types'

const props = withDefaults(
  defineProps<{
    /** 打开文档的完整请求契约 */
    request: EditorOpenRequest
    /** 是否显示顶部 Chrome 栏 */
    showChrome?: boolean
    /**
     * 是否显示底部状态栏。页面把外壳当“阅读视图”用时（只读的笔记批注阅读）关掉：
     * 阅读页不该多出“只读 · N 字”这一行，字数页头已经有了
     */
    showStatus?: boolean
    /** 保存通道；不传时只能只读浏览（调用方负责给出正确实现） */
    transport?: SessionTransport
    /** 复用的会话注册表；不传则本实例自建一份并在卸载时销毁 */
    registry?: SessionRegistry
    /**
     * 内容面懒加载器：返回 null 表示该格式尚未接入新编辑器（落回退提示，不白屏）；
     * 不传时走内置注册表（每种格式各自一个动态 chunk，不把 ProseMirror 拖进首屏）
     */
    loadSurface?: (kind: SurfaceKindName, format?: string) => Promise<Surface | null>
    /** 图片上传通道：Chrome 的图片按钮挑完文件后走这里，返回可写进正文的地址 */
    uploadImage?: (file: File) => Promise<{ src: string; alt?: string } | null>
    /**
     * AI 写作通道（UI-3）：页面调后端（`ai_write`）后返回结果文字（Markdown）。不传就没有任何 AI 写作入口
     * （AI 总开关关了、账号没有 AI 助手、分享页都不传）。只在文本面生效
     */
    aiWrite?: (request: AiWriteRequest) => Promise<string>
    /** 宿主能力：AI / 评论入口只在页面真的接了对应动作时才显示 */
    capabilities?: { ai?: boolean; comment?: boolean; export?: boolean }
    /** 页面已有自己的标题时关掉 Chrome 里的标题，避免同一屏出现两遍 */
    chromeTitle?: boolean
    /** 页面自己管「完成 / 取消」时关掉 Chrome 的关闭按钮，避免两个语义重叠的入口 */
    chromeClose?: boolean
    /**
     * 页面自己有「保存」按钮时关掉 Chrome 的保存：同一屏两个「保存」语义不同（页面的保存还会存标题 / 标签、
     * 退出编辑），用户分不清。Ctrl/⌘+S 照常由 Host 处理，不受影响
     */
    chromeSave?: boolean
    /**
     * 显式指定工具栏贡献，整个覆盖注册表给的工具栏（兼容旧调用方；新代码请用 `toolbarProfile`）。
     * 覆盖后第三方扩展的按钮也不会出现在工具栏里；顶栏操作区的按钮、状态栏项、AI 菜单不受影响
     */
    contribution?: SurfaceContribution | null
    /**
     * 工具栏方案：Word 的只读预览和画布编辑同属 `page` 面，但工具栏不同（编辑面有格式 / 表格 / 插入）；
     * Host 看不出是哪一种，由页面按它挂的是哪个内容面来选（`edit` = 画布编辑，缺省 = 预览）。
     * 方案里的按钮是内置扩展 `kb.builtin.page` 注册的，第三方按钮照常并进来
     */
    toolbarProfile?: string
    /**
     * 笔记页面服务：引用笔记 / 文件选择器、图片与附件上传、链接体检、相对路径图片都靠它。
     * 不传就只做不依赖页面的编辑（单测、别处复用外壳时）；传了才渲染面板并给内容面一座桥
     */
    textServices?: TextServices
    /** 打开后把光标放进正文（进入编辑态时；标题还没填的新笔记不要，焦点留在标题上） */
    autofocus?: boolean
  }>(),
  {
    showChrome: true,
    showStatus: true,
    transport: undefined,
    registry: undefined,
    loadSurface: undefined,
    uploadImage: undefined,
    aiWrite: undefined,
    capabilities: undefined,
    chromeTitle: true,
    chromeClose: true,
    chromeSave: true,
    contribution: undefined,
    toolbarProfile: undefined,
    textServices: undefined,
    autofocus: false,
  },
)

const emit = defineEmits<{
  /** partsRemoved：保存后文件里少了的部件（Office 保存才有；外层据此提醒用户） */
  (e: 'saved', revision: number, sha256: string, partsRemoved?: string[]): void
  /** 未保存改动变化：外层据此决定关闭时是否提示「不保存」 */
  (e: 'dirty', dirty: boolean): void
  (e: 'close'): void
  /** 内容面已挂好、文档已载入，可以用了（页面据此从「刚才读的内容」交接到编辑器） */
  (e: 'ready'): void
  (e: 'fallback', reason: string): void
  (e: 'error', err: Error): void
  (e: 'export', payload: { text: string; name: string }): void
  (e: 'ai', payload: { action: string; text: string }): void
  (e: 'comment', payload: { text: string; anchor: unknown }): void
  /**
   * 正文变化（序列化后的完整文本）：
   * 页面需要把内容同步进自己的草稿 / v-model 时订阅它；这只是副本，保存仍以会话快照为准，
   * 所以不能靠它「回写」编辑器，否则会把用户正在输入的光标位置冲掉。
   */
  (e: 'change', text: string): void
  /** 大纲变化：页面自己的目录要用；数据来自 Surface 查询，不在页面里重复解析 markdown */
  (e: 'outline', items: { level: number; text: string; anchor: Anchor }[]): void
  /** 选中的文字变了（空串 = 没选中）：页面据此显示「已选 N 字」。只在内容真变了时发 */
  (e: 'selection-text', text: string): void
}>()

/** Surface 挂载容器 DOM 引用 */
const stageRef = ref<HTMLElement | null>(null)
/** 宿主根节点：快捷键的「编辑器内部」判定基准 */
const rootRef = ref<HTMLElement | null>(null)

/** 重型会话与 Surface 实例：只允许 shallowRef，禁止 Vue 递归劫持内部文档树或 WASM 句柄 */
const activeSession = shallowRef<EditorDocumentSession | null>(null)
const activeSurface = shallowRef<Surface | null>(null)

const phase = ref<SessionPhase>('idle')
const dirty = ref(false)
watch(dirty, (value) => emit('dirty', value))
const errorMessage = ref('')
/** 中性提示（非错误）：例如阶段 1 某格式的内容面还没接入，不能伪装成加载失败 */
const surfaceNotice = ref('')
/** 最近一次工具栏命令失败的原因（写给人看的中文）。非致命：不藏文档，可关闭，下一次命令成功自动清掉 */
const commandNotice = ref('')
const revision = ref(props.request.revision)
const wordCount = ref(0)
const unitLabel = ref('')
/** 工具栏高亮 / 大纲 / 查找状态：都由 Surface 查询得来，Host 不自己猜 */
const formatState = ref<FormatState | null>(null)
const outline = ref<{ level: number; text: string; anchor: Anchor }[]>([])
const findState = ref<FindUiState | null>(null)
const chromeRef = ref<InstanceType<typeof EditorChrome> | null>(null)
const panelsRef = ref<InstanceType<typeof TextPanels> | null>(null)
/** 笔记面板（选择器 / 上传）只在文本面且页面给了服务时出现 */
const showTextPanels = computed(() => surfaceKind.value === 'text' && !!props.textServices)
/** 底部面板（手机）的高度：光标要滚到它上面。选择器面板（TextPanels）与斜杠菜单（内容面）各报各的，取高的 */
const panelsSheet = ref(0)
const slashSheet = ref(0)
const sheetHeight = computed(() => Math.max(panelsSheet.value, slashSheet.value))
/** 贴键盘的工具栏：是否贴上、多高 */
const dock = ref({ docked: false, height: 0 })

/**
 * 把「压在内容底部的东西」的高度写成 CSS 变量，并告诉内容面让出光标滚动的余量：
 * --kbd-bar：贴键盘的工具栏高度（底部面板和往上展开的下拉菜单坐在它上面）；
 * --kbd-reserve：工具栏 + 底部面板的总高度（正文底部留白、光标滚动据此让位）。
 * 与旧编辑器写的是同一对变量，页面其它部分（外壳、聊天）读它们不用区分是哪个编辑器。
 */
function applyKeyboardReserve(before: number) {
  if (surfaceKind.value !== 'text') return
  const bar = dock.value.docked ? Math.max(0, Math.round(dock.value.height)) : 0
  const reserve = bar + sheetHeight.value
  const root = document.documentElement
  root.style.setProperty('--kbd-bar', `${bar}px`)
  root.style.setProperty('--kbd-reserve', `${reserve}px`)
  // 面板刚出现 / 变高后，光标行可能落在它后面：滚到它上面
  void executeCommand({ id: `reserve_${Date.now()}`, type: 'view.reserve', args: { reserve, reveal: sheetHeight.value > before }, source: 'api', readonlySafe: true })
}
let lastSheet = 0
watch(
  [dock, sheetHeight],
  () => {
    applyKeyboardReserve(lastSheet)
    lastSheet = sheetHeight.value
  },
  { flush: 'post', deep: true },
)
onBeforeUnmount(() => {
  document.documentElement.style.removeProperty('--kbd-bar')
  document.documentElement.style.removeProperty('--kbd-reserve')
})
/** 宿主能力：AI / 评论入口只在页面授权时才渲染，避免死按钮 */
const capabilities = computed(() => ({
  ai: props.capabilities?.ai ?? props.request.permissions.ai,
  comment: props.capabilities?.comment ?? props.request.permissions.comment,
  export: props.capabilities?.export ?? props.request.permissions.export,
}))

/** 规范化格式名与目标 SurfaceKind */
const normalizedFormat = computed(() =>
  normalizeFormat(props.request.format || props.request.source.name),
)

/**
 * 扩展注册表的变更计数：扩展装上 / 卸载后工具栏、面板、格式路由都要重算。
 * 注册表是页面级单例（所有编辑器共享），这里只订阅它的变化，不拥有它。
 */
const extensions = getExtensionRegistry()
const extensionsVersion = ref(extensions.version)
const stopExtensionsWatch = extensions.subscribe(() => (extensionsVersion.value = extensions.version))
/** 配置热更新时（管理员关掉扩展开关等）让页面里的扩展跟着变 */
const stopConfigWatch = watchExtensionConfig()

/** 格式 → 内容面：内置映射优先，其次扩展的内容面 / Codec（内置格式永远不会被扩展覆盖） */
const surfaceKind = computed<SurfaceKindName | null>(() => {
  void extensionsVersion.value
  const known = extensions.resolveKind(props.request.format || props.request.source.name)
  if (known) return known
  // 内置表和扩展都不认识：调用方声明是整份文本（plainText）才按纯文本进代码面，其余仍走「不支持」兜底，二进制不会被当文本打开
  return props.request.plainText && props.request.source.kind === 'text' ? 'code' : null
})

/**
 * 工具栏 / 斜杠菜单：全部来自注册表（内置扩展 + 第三方扩展）。
 * 页面显式传入 contribution 时它整个覆盖（兼容旧调用方，如以前 Word 编辑面传的 PAGE_EDIT_CONTRIBUTION）
 */
const contribution = computed(() => {
  void extensionsVersion.value
  if (props.contribution !== undefined) return props.contribution
  return surfaceKind.value ? contributionWith(surfaceKind.value, extensions, normalizedFormat.value, props.toolbarProfile) : null
})
/** 顶栏操作区的按钮（导出、评论…）：注册表里 `placement: 'bar'` 的贡献，页面没接入的能力不出现 */
const barActions = computed(() => {
  void extensionsVersion.value
  if (!surfaceKind.value) return []
  return barActionsFor(surfaceKind.value, extensions, capabilities.value, { format: normalizedFormat.value, ...(props.toolbarProfile === undefined ? {} : { profile: props.toolbarProfile }) })
})
/** 状态栏项能看到的宿主状态：字数 / 单位是内容面上报的，其余来自会话 */
const statusState = computed<StatusState | null>(() =>
  surfaceKind.value
    ? { kind: surfaceKind.value, format: normalizedFormat.value, words: wordCount.value, unitLabel: unitLabel.value, readonly: props.request.readonly, dirty: dirty.value, phase: phase.value }
    : null,
)
/** 状态栏项求值：顶栏操作区与底部状态栏各一份 */
const statusItems = computed<{ chrome: StatusView[]; status: StatusView[] }>(() => {
  void extensionsVersion.value
  const state = statusState.value
  return state ? { chrome: extensions.statusTexts(state.kind, 'chrome', state), status: extensions.statusTexts(state.kind, 'status', state) } : { chrome: [], status: [] }
})
const extensionPanels = computed<PanelInfo[]>(() => {
  void extensionsVersion.value
  return surfaceKind.value ? extensions.panels(surfaceKind.value) : []
})
/**
 * AI 菜单里的工具：内置的润色 / 总结 / 翻译由页面接管，页面接入了 AI 能力才有；
 * 第三方扩展的工具只在文档有 AI 权限时出现（和命令总线对 AI 来源命令的闸门一致）
 */
const extensionAiTools = computed(() => {
  void extensionsVersion.value
  return visibleAiTools(extensions, { page: capabilities.value.ai, suggestion: props.request.permissions.ai })
})

/** 会话注册表：外部注入优先，否则自建并在卸载时清空 */
const selfRegistry = new SessionRegistry({ maxSessions: 4 })
const registry = computed(() => props.registry ?? selfRegistry)

/** 房间连接状态（CSV / 笔记）：状态栏显示「连接中 / 已同步 / 离线」 */
const roomState = shallowRef<{ status: CollabRoomStatus; writable: boolean } | null>(null)
let roomOff: (() => void) | null = null
watch(
  () => props.request.collabStatus,
  (source) => {
    roomOff?.()
    roomOff = null
    roomState.value = source ? { ...source.getState() } : null
    if (source) roomOff = source.subscribe((state) => (roomState.value = { status: state.status, writable: state.writable }))
  },
  { immediate: true },
)
onBeforeUnmount(() => roomOff?.())

/** 正文在协同房间里（Office 房间 / CSV 文本房间 / 笔记富文本房间）：没有「本地保存」这回事，Chrome 不给保存按钮 */
const inRoom = computed(
  () => !!(props.request.collab || props.request.collabText || props.request.collabRich || props.request.collabProvider),
)

let unsubscribe: (() => void) | null = null
/** 内容变化通知的防抖计时器：页面草稿不需要每个按键都落盘 */
let changeTimer = 0

/**
 * 把正文副本推给页面（防抖）：序列化要遍历整棵文档，每键都做会拖慢输入；
 * 真正保存时 Session 直接从 Surface 的 snapshot 取，不依赖这条通道，所以这里晚一点没关系。
 */
function scheduleChange() {
  window.clearTimeout(changeTimer)
  changeTimer = window.setTimeout(() => {
    changeTimer = 0
    void flushText().then((text) => {
      emit('change', text)
      // 订阅了 document.onChange 的扩展（字数统计面板等）在这里收到通知
      if (extensionBinding) extensions.emitChange(extensionBinding)
    })
    // 字数跟着正文走：以前只在打开时算一次，编辑之后 Chrome 的字数一直停在打开时的数
    void refreshCounters()
  }, 150)
}

/**
 * 真正把命令落到内容面：
 * CommandBus 已做过只读/权限守卫，这里只负责转发并刷新会话状态。
 */
async function dispatchToSurface(command: EditorCommand): Promise<CommandResult> {
  const surface = activeSurface.value
  if (!surface) return { ok: false, reason: '编辑器内容面尚未就绪' }
  return surface.command(command)
}

/**
 * 统一命令派发入口：先过只读与权限守卫，再交给会话（会话内部再走 CommandBus 串行落地）
 */
async function executeCommand(command: EditorCommand): Promise<CommandResult> {
  const guard = canExecuteCommand(command, props.request.readonly, props.request.permissions)
  if (!guard.ok) return guard
  if (activeSession.value) return activeSession.value.execute(command)
  if (activeSurface.value) return activeSurface.value.command(command)
  return { ok: false, reason: '编辑器会话尚未就绪' }
}

/** 给人看的失败原因才显示（含中文）；`command_rejected` 之类的内部原因不弹 */
function surfaceFailure(result: CommandResult) {
  if (result.ok || !result.reason || !/[\u4e00-\u9fa5]/.test(result.reason)) return
  panelsRef.value?.say(result.reason)
}

function handleChromeCommand(type: string, args?: unknown) {
  // 扩展命令（工具栏按钮 / 斜杠菜单）：命名带扩展 id 前缀，不会和内置命令重名，命中就交给注册表
  if (extensions.hasCommand(type)) {
    void extensions.runCommand(type, args, extensionBinding).then((result) => {
      if (!result.ok) notifyExtensionProblem(`扩展命令没有执行成功：${result.reason ?? type}`)
    })
    return
  }
  // 工具栏上的非写动作（打印、导出、审阅开关）在只读文档里按钮是留着的，命令就必须放行——
  // 与按钮可见性用同一个判据（action.write），且用的是注册表合成后真正显示的那份工具栏
  const readonlySafe = isReadonlySafeToolbarCommand(contribution.value?.toolbar ?? [], type)
  // 执行完刷新一次按钮高亮：视图开关（代码面换行）不改正文、不改选区，没有别的事件会触发刷新
  void executeCommand({ id: `cmd_${Date.now()}`, type, args, source: 'user', ...(readonlySafe ? { readonlySafe: true } : {}) }).then((result) => {
    // 失败原因要让人看到：文本面有笔记面板时在面板里说（surfaceFailure），其余内容面（Word 画布等）用命令提示条
    surfaceFailure(result)
    commandNotice.value = panelsRef.value ? '' : commandFeedback(result)
    // 工具栏命令执行完把焦点还给正文（旧编辑器的 run 同样）：继续打字、Ctrl+Z 才有人接。
    // 打开面板 / AI 写作条 / 切源码 / 查找 / 跳转的命令自己管焦点（输入框要拿焦点），不在此列
    if (result.ok && !/^(text\.panel\.|text\.ai\.open|view\.|search\.|nav\.)/.test(type)) activeSurface.value?.focus()
    return refreshMeta()
  })
}

/** Chrome 的链接条要回填光标所在链接的地址 */
async function queryLink(): Promise<string> {
  const found = (await activeSurface.value?.query({ type: 'link' })) as { href?: string } | null | undefined
  return found?.href ?? ''
}

/* ---------------- 笔记面板（选择器 / 上传）与页面服务 ---------------- */

/** 面板里的选择结果交回内容面执行：和别的编辑走同一条 CommandBus（只读 / 权限守卫、撤销栈、协同） */
function panelExecute(type: string, args?: unknown): Promise<CommandResult> {
  return executeCommand({ id: `panel_${Date.now()}`, type, args, source: 'user', readonlySafe: type === 'view.focus' ? true : undefined })
}
async function panelCaret(): Promise<{ pos: number; left: number; top: number; bottom: number } | null> {
  const found = await activeSurface.value?.query({ type: 'caret' })
  return (found as { pos: number; left: number; top: number; bottom: number } | null) ?? null
}

/** 内容面 → 页面的桥；面板组件在 openDocument 时已经渲染（v-if 与 textServices 同时成立） */
function buildTextHost(): TextHostBridge | undefined {
  const services = props.textServices
  if (!services) return undefined
  return {
    services,
    openPanel: (panel, options) => panelsRef.value?.open(panel, options),
    uploadFiles: (files, pos) => void panelsRef.value?.uploadFiles(files, pos),
    notify: (message) => panelsRef.value?.say(message),
    aiAvailable: () => aiWriteAvailable.value,
    openAi: (options) => openAi(options),
  }
}

/* ---------------- AI 写作（UI-3） ---------------- */

/**
 * 页面接了 AI 写作、文档可写、是文本面才可用。调后端是页面的事（props.aiWrite），Host 只负责：
 * 让内容面记下目标区间并交出选中内容 / 上下文 → 调页面 → 把结果放进 AI 写作条 → 用户点了再让内容面写回。
 */
const aiWriteAvailable = computed(() => !!props.aiWrite && surfaceKind.value === 'text' && !props.request.readonly)
const aiWriter = ref<AiWriterView | null>(null)
/** 每次运行编号：停止 / 关闭 / 重新运行后，迟到的旧结果直接丢掉 */
let aiRun = 0

function openAi(options: { action?: AiWriteAction } = {}) {
  if (!aiWriteAvailable.value) return
  if (!aiWriter.value) aiWriter.value = { phase: 'idle', action: null, instruction: '', hasSelection: false, original: '', result: '', error: '' }
  if (options.action) void runAi(options.action)
  else chromeRef.value?.focusAiInput()
}

async function runAi(action: AiWriteAction, instruction?: string) {
  const aiWrite = props.aiWrite
  if (!aiWrite || !aiWriteAvailable.value) return
  const run = ++aiRun
  const previous = aiWriter.value
  const marked = await executeCommand({ id: `ai_mark_${run}`, type: 'text.ai.mark', source: 'user' })
  if (run !== aiRun) return
  if (!marked.ok) {
    aiWriter.value = { phase: 'error', action, instruction: instruction ?? previous?.instruction ?? '', hasSelection: false, original: '', result: '', error: marked.reason ?? '现在不能用 AI 写作' }
    return
  }
  const data = (marked.data ?? {}) as { text?: string; context?: string; hasSelection?: boolean }
  const text = data.text ?? ''
  const hasSelection = !!data.hasSelection && !!text.trim()
  const base = { action, instruction: instruction ?? previous?.instruction ?? '', hasSelection, original: text, result: '' }
  // 润色 / 总结 / 翻译都是「对选中的文字做」：没选中就先说清楚，不花一次额度
  if (!hasSelection && (action === 'polish' || action === 'summarize' || action === 'translate')) {
    aiWriter.value = { ...base, phase: 'error', error: '先选中要处理的文字，再点这个动作' }
    void executeCommand({ id: `ai_clear_${run}`, type: 'text.ai.clear', source: 'user', readonlySafe: true })
    return
  }
  aiWriter.value = { ...base, phase: 'running', error: '' }
  try {
    const result = (await aiWrite({ action, text: hasSelection ? text : '', context: data.context ?? '', ...(instruction ? { instruction } : {}) })).trim()
    if (run !== aiRun) return
    if (!result) throw new Error('AI 没有给出内容，请再试一次')
    aiWriter.value = { ...base, phase: 'ready', result, error: '' }
  } catch (err) {
    if (run !== aiRun) return
    aiWriter.value = { ...base, phase: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

async function applyAi(mode: AiApplyMode) {
  const state = aiWriter.value
  if (!state || state.phase !== 'ready') return
  const result = await executeCommand({ id: `ai_apply_${Date.now()}`, type: 'text.ai.apply', args: { markdown: state.result, mode }, source: 'user' })
  if (result.ok) {
    aiRun += 1
    aiWriter.value = null
    return
  }
  aiWriter.value = { ...state, phase: 'error', error: result.reason ?? '没能写进文档' }
}

function closeAi() {
  aiRun += 1
  aiWriter.value = null
  void executeCommand({ id: `ai_clear_${Date.now()}`, type: 'text.ai.clear', source: 'user', readonlySafe: true })
}

/** 页面的链接体检 / 集合列表等异步数据变了：让内容面重画装饰 */
async function refreshText(): Promise<void> {
  await executeCommand({ id: `refresh_${Date.now()}`, type: 'text.refresh', source: 'api', readonlySafe: true })
}

/** 「从库中选择」修坏引用：把正文里的旧地址换成新地址，返回改到的处数 */
async function replaceHref(oldHref: string, newHref: string): Promise<number> {
  const result = await executeCommand({ id: `href_${Date.now()}`, type: 'text.replaceHref', args: { oldHref, newHref }, source: 'user' })
  return (result.data as { count?: number } | undefined)?.count ?? 0
}

/* ---------------- 查找 ---------------- */

/** 把命令返回的命中信息同步到查找条；失败时清空数字，不保留过期结果 */
function applyFindResult(result: CommandResult, fallbackQuery = '') {
  if (!result.ok) {
    findState.value = { open: true, query: fallbackQuery, total: 0, index: -1 }
    return
  }
  const data = result.data as { query?: string; total?: number; index?: number } | undefined
  findState.value = {
    open: true,
    query: data?.query ?? fallbackQuery,
    total: data?.total ?? 0,
    index: data?.index ?? -1,
  }
}

async function handleFindChange(query: string) {
  const result = await executeCommand({
    id: `find_${Date.now()}`,
    type: 'search.set',
    args: { query },
    source: 'user',
    readonlySafe: true,
  })
  applyFindResult(result, query)
}

async function handleFindStep(direction: 1 | -1) {
  const result = await executeCommand({
    id: `find_${Date.now()}`,
    type: direction > 0 ? 'search.next' : 'search.prev',
    source: 'user',
    readonlySafe: true,
  })
  applyFindResult(result, findState.value?.query ?? '')
}

async function handleFindReplace(text: string) {
  const result = await executeCommand({
    id: `replace_${Date.now()}`,
    type: 'search.replace',
    args: { text },
    source: 'user',
  })
  applyFindResult(result, findState.value?.query ?? '')
}

async function handleFindReplaceAll(text: string) {
  const result = await executeCommand({
    id: `replace_all_${Date.now()}`,
    type: 'search.replaceAll',
    args: { text },
    source: 'user',
  })
  applyFindResult(result, findState.value?.query ?? '')
}

async function handleFindClose() {
  findState.value = null
  await executeCommand({ id: `find_close_${Date.now()}`, type: 'search.close', source: 'user', readonlySafe: true })
}

/* ---------------- 大纲 / 导出 / AI / 评论 / 图片 ---------------- */

async function handleOutlineJump(anchor: Anchor) {
  await executeCommand({ id: `nav_${Date.now()}`, type: 'nav.anchor', args: { anchor }, source: 'user', readonlySafe: true })
}

/** 导出交给页面：Host 只负责把「当前正文」序列化出来 */
async function handleExport() {
  const surface = activeSurface.value
  if (!surface) return
  try {
    const text = await surface.query({ type: 'text' })
    emit('export', { text: typeof text === 'string' ? text : '', name: props.request.source.name })
  } catch (err) {
    emit('error', err instanceof Error ? err : new Error(String(err)))
  }
}

/** 选区文字：AI / 评论都要它，统一从会话拿，避免和 Surface 各自维护一份 */
function selectedText(): { text: string; anchor: unknown } {
  const selection = activeSession.value?.getSelection() ?? null
  return { text: selection?.text ?? '', anchor: selection?.anchor ?? null }
}

function handleComment() {
  const { text, anchor } = selectedText()
  emit('comment', { text, anchor })
}

/**
 * 宿主页面通道：导出 / 评论 / AI 面板是嵌入编辑器的页面的事。内置扩展的命令和 AI 工具经 `api.page.emit` 走到这里，
 * Host 只负责补上页面要的数据（当前正文、选区与锚点）再抛出对应的 Vue 事件——不再认识任何按钮
 */
function emitToPage(event: PageEvent, payload?: unknown) {
  if (event === 'export') void handleExport()
  else if (event === 'comment') handleComment()
  else if (event === 'ai') {
    const data = (payload ?? {}) as { action?: unknown; text?: unknown }
    emit('ai', { action: String(data.action ?? ''), text: typeof data.text === 'string' ? data.text : selectedText().text })
  }
}

/** 图片：Chrome 挑文件 → 页面上传 → 拿回地址再插入正文（绝不用 base64 落库） */
async function handleImageRequest(file: File) {
  if (!props.uploadImage) {
    emit('error', new Error('当前文档不支持上传图片'))
    return
  }
  try {
    const uploaded = await props.uploadImage(file)
    if (!uploaded) return
    await executeCommand({
      id: `image_${Date.now()}`,
      type: 'insert.image',
      args: { src: uploaded.src, alt: uploaded.alt ?? file.name },
      source: 'user',
    })
  } catch (err) {
    emit('error', err instanceof Error ? err : new Error(String(err)))
  }
}

/** 供页面调用：把编辑器里最新的文本取出来（保存前 flush） */
async function flushText(): Promise<string> {
  const surface = activeSurface.value
  if (!surface) return ''
  try {
    const text = await surface.query({ type: 'text' })
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/** 供页面调用：打开查找条并聚焦输入框（Ctrl+F / 菜单「查找替换」） */
function openFind() {
  chromeRef.value?.openFind()
}

/* ---------------- 扩展：文档绑定 / 面板 / AI 工具 ---------------- */

/** 注册表通过它读写这个编辑器里的文档；Surface 就绪后才有，卸载时撤销 */
let extensionBinding: HostBinding | null = null
let detachExtensionBinding: (() => void) | null = null

function attachExtensionBinding(kind: SurfaceKindName, format: string, session: EditorDocumentSession) {
  detachExtensionBinding?.()
  const binding: HostBinding = {
    kind,
    format,
    isReadonly: () => session.readonly || props.request.readonly,
    readText: () => flushText(),
    // 完整选区文字向内容面要（跨块选区的 Selection.text 只有起始块那一段）；不支持的内容面退回会话里的选区文字
    selectionText: async () => {
      try {
        const text = await activeSurface.value?.query({ type: 'selectionText' })
        if (typeof text === 'string') return text
      } catch {
        // 内容面查询失败就用会话里的
      }
      return selectedText().text
    },
    execute: (command) => executeCommand(command),
    emitToPage,
  }
  extensionBinding = binding
  detachExtensionBinding = extensions.attachHost(binding)
}

function mountExtensionPanel(panel: PanelInfo, el: HTMLElement): Promise<() => void> {
  return extensions.mountPanel(panel, el, extensionBinding)
}

const aiSuggestion = ref<AiSuggestionView | null>(null)
/** 当前建议背后的原始结果（接受时用）；null = 还在生成或失败 */
let pendingSuggestion: AISuggestion | null = null

async function handleAiTool(id: string) {
  const tool = extensionAiTools.value.find((item) => item.id === id)
  const title = tool?.title ?? id
  pendingSuggestion = null
  // 由页面接管结果的工具（内置的润色 / 总结 / 翻译）：run 里已经把动作和选区交给页面，不显示「建议」条
  if (tool?.target === 'page') {
    aiSuggestion.value = null
    try {
      await extensions.runAITool(id, extensionBinding)
    } catch (err) {
      notifyExtensionProblem(err instanceof Error ? err.message : String(err))
    }
    return
  }
  aiSuggestion.value = { toolId: id, title, status: 'running', text: '' }
  try {
    const suggestion = await extensions.runAITool(id, extensionBinding)
    // 生成期间用户已经关掉或换了别的工具：丢弃这次结果
    if (aiSuggestion.value?.toolId !== id) return
    pendingSuggestion = suggestion
    aiSuggestion.value = { toolId: id, title, status: 'ready', text: suggestion.text, ...(suggestion.note === undefined ? {} : { note: suggestion.note }) }
  } catch (err) {
    if (aiSuggestion.value?.toolId !== id) return
    aiSuggestion.value = { toolId: id, title, status: 'error', text: '', error: err instanceof Error ? err.message : String(err) }
  }
}

async function handleAiToolAccept() {
  const suggestion = pendingSuggestion
  if (!suggestion) return
  try {
    await extensions.applySuggestion(suggestion, extensionBinding)
    pendingSuggestion = null
    aiSuggestion.value = null
  } catch (err) {
    // 写权限被拒 / 选区变了：建议留着，错误告诉用户原因，可以重试或拒绝
    notifyExtensionProblem(err instanceof Error ? err.message : String(err))
  }
}

function handleAiToolReject() {
  pendingSuggestion = null
  aiSuggestion.value = null
}

async function handleSave() {
  // 协同房间由服务端按 Yjs 更新落地（笔记由页面的落地调度提交）；本地再提交整份文本会越过房间编码，
  // 甚至用打开时的旧骨架覆盖正文
  if (props.request.collabText || props.request.collabRich || props.request.collabProvider) return
  const session = activeSession.value
  if (!session || session.readonly) return
  try {
    const res = await session.save({ reason: 'manual' })
    if (res.ok) {
      emit('saved', res.revision, res.sha256, res.partsRemoved)
      // 保存成功后补一次正文副本：页面若在防抖窗口内退出编辑，也不会把最后一拍内容留在草稿外
      void flushText().then((text) => emit('change', text))
    } else if (!res.conflict) {
      errorMessage.value = res.reason ?? '保存失败'
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    errorMessage.value = error.message
    emit('error', error)
  }
}

// 撤销/重做交给内容面自己的历史（ProseMirror / 引擎）：会话里的通用 History 只承载
// 不依赖引擎的步骤，文本面的输入合并、协同例外都由 ProseMirror 的 history 插件负责。
// 走 CommandBus 还能复用只读守卫，避免只读态从工具栏绕过。
async function handleUndo() {
  await executeCommand({ id: `undo_${Date.now()}`, type: 'undo', source: 'user' })
}

async function handleRedo() {
  await executeCommand({ id: `redo_${Date.now()}`, type: 'redo', source: 'user' })
}

/** 协同房间由服务端落地,本地「保存」是空操作:面板里别列一个点了没反应的命令 */
const paletteCollab = computed(() => !!(props.request.collabText || props.request.collabRich || props.request.collabProvider))

/**
 * ⌘K 命令面板的动作(UI-5):宿主动作(保存 / 撤销 / 重做)+ 工具栏命令。
 * 写操作只在可写、有改动时出现;撤销 / 重做按会话的真实历史栈决定,避免点不动还占一行。
 */
function paletteActions(): { id: string; label: string; hint?: string; keywords?: string; run: () => void | Promise<void> }[] {
  const list: { id: string; label: string; hint?: string; keywords?: string; run: () => void | Promise<void> }[] = []
  if (!props.request.readonly && dirty.value && !paletteCollab.value) {
    list.push({ id: 'save', label: '保存', hint: 'Ctrl+S', keywords: 'save 保存 写入', run: handleSave })
  }
  const session = activeSession.value
  if (session?.canUndo) list.push({ id: 'undo', label: '撤销', hint: 'Ctrl+Z', keywords: 'undo 撤销 回退', run: handleUndo })
  if (session?.canRedo) list.push({ id: 'redo', label: '重做', hint: 'Ctrl+Shift+Z', keywords: 'redo 重做 恢复', run: handleRedo })
  return [...list, ...(chromeRef.value?.paletteActions() ?? [])]
}

/** 面板只拿得到 id:执行时重新算一遍当前可用的动作,模态关闭后状态已经变了也不会执行到旧按钮 */
async function runPaletteAction(id: string) {
  await paletteActions().find((action) => action.id === id)?.run()
}

/**
 * 回退：区分「格式不支持」和「内容面运行时出错」两种原因，调用方据此决定
 * 是提示用户换个查看器，还是上报一次渲染故障。
 */
function handleFallback() {
  emit('fallback', surfaceKind.value ? `surface_error:${errorMessage.value}` : 'unsupported_format')
}

/** 字数/单位统计：由 Surface 上报，文本面必须实现，其它面可选 */
async function refreshCounters() {
  const surface = activeSurface.value
  if (!surface) return
  try {
    const stats = (await surface.query({ type: 'wordCount' })) as
      | { words?: number; unitLabel?: string }
      | number
      | null
    if (typeof stats === 'number') {
      wordCount.value = stats
      unitLabel.value = ''
    } else if (stats && typeof stats === 'object') {
      wordCount.value = stats.words ?? 0
      unitLabel.value = stats.unitLabel ?? ''
    }
  } catch {
    // 统计失败不影响编辑：静默保持上一次数值，不弹错误
  }
}

/** 刷新工具栏高亮 / 大纲：查询失败时保持上一次值，不把编辑打断 */
/**
 * 选中的文字：交给页面算「已选 N 字」（和页头总字数同一个算法）。空选区不查询内容面——光标每动一下都会走到这里，
 * 只有真选中了文字才取一次（取的是纯文字，不序列化）。和上一次一样就不发事件
 */
let lastSelectionText = ''
async function refreshSelectionText(session: EditorDocumentSession) {
  const surface = activeSurface.value
  const selection = session.getSelection()
  let text = ''
  if (surface && selection && !selection.isEmpty) {
    try {
      const value = await surface.query({ type: 'selectionText' })
      text = typeof value === 'string' ? value : ''
    } catch {
      text = ''
    }
  }
  if (text === lastSelectionText) return
  lastSelectionText = text
  emit('selection-text', text)
}

async function refreshMeta() {
  const surface = activeSurface.value
  if (!surface) return
  try {
    const [format, heads] = await Promise.all([
      surface.query({ type: 'formatState' }) as Promise<FormatState | null>,
      surface.query({ type: 'outline' }) as Promise<{ level: number; text: string; anchor: Anchor }[] | null>,
    ])
    formatState.value = format ?? null
    outline.value = Array.isArray(heads) ? heads : []
    emit('outline', outline.value)
  } catch {
    // 查询失败不影响编辑，保留上一次状态
  }
}

/** 扩展 Codec 解码：只处理二进制来源；文本来源本来就是可编辑的，不需要翻译 */
async function decodeWithCodec(codec: CodecHandle | null, source: EditorOpenRequest['source']): Promise<EditorOpenRequest['source']> {
  if (!codec || source.kind !== 'bytes') return source
  const decoded = await codec.decode(source.bytes, { name: source.name, format: normalizedFormat.value })
  // 校验和属于原文件，翻译后仍然沿用：乐观锁比的是服务端那份文件
  return source.sha256 === undefined ? decoded : { ...decoded, sha256: source.sha256 }
}

/** 保存时把编辑中的文本经 Codec 翻译回字节再交给页面的保存通道；翻译失败（含用户拒绝写权限）按保存失败处理 */
function codecTransport(codec: CodecHandle): SessionTransport | undefined {
  const base = props.transport
  if (!base) return undefined
  return {
    save: async (saveRequest) => {
      if (saveRequest.source.kind !== 'text') return base.save(saveRequest)
      try {
        const bytes = await codec.encode(saveRequest.source, { name: saveRequest.source.name, format: normalizedFormat.value })
        return await base.save({ ...saveRequest, source: { kind: 'bytes', bytes, name: saveRequest.source.name } })
      } catch (err) {
        return { ok: false, revision: saveRequest.revision, sha256: '', reason: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

/**
 * 打开文档：建会话 → 接命令总线 → 懒加载并挂载 Surface。
 * 任何一步失败都收敛成可见错误，不抛到全局。
 */
async function openDocument() {
  const kind = surfaceKind.value
  if (!kind) {
    phase.value = 'error'
    errorMessage.value = `暂不支持直接打开 .${normalizedFormat.value || 'unknown'} 格式`
    return
  }

  phase.value = 'loading'
  try {
    // 扩展 Codec：宿主不认识的格式先把字节翻译成可编辑的文本，保存时再翻译回去
    const codec = extensions.codecFor(normalizedFormat.value)
    const source = await decodeWithCodec(codec, props.request.source)
    const request = source === props.request.source ? props.request : { ...props.request, source }
    const session = await registry.value.open(request, (req) =>
      new EditorDocumentSession({ request: req, transport: codec ? codecTransport(codec) : props.transport }),
    )
    activeSession.value = session

    // 会话状态 → 组件状态（单向，组件不回写会话内部字段）
    unsubscribe?.()
    unsubscribe = session.subscribe((event) => {
      phase.value = event.phase
      dirty.value = event.dirty
      revision.value = event.revision
      // 选区/内容变化后刷新工具栏高亮与字数：查询很轻（不序列化），但不能在事件回调里同步 await
      if ((event.type === 'selection' || event.type === 'dirty') && event.phase === 'ready') {
        void refreshMeta()
        if (event.type === 'dirty') scheduleChange()
        if (event.type === 'selection') void refreshSelectionText(session)
      }
    })

    // 未注册的格式是合法中性态：显式提示，绝不静默空白
    const loader = props.loadSurface ?? loadRegisteredSurface
    const surface = await loader(kind, normalizedFormat.value)
    if (!surface) {
      session.markReady()
      surfaceNotice.value = '该格式的内容面尚未接入新编辑器'
      return
    }

    const commandBus = new CommandBus({
      readonly: () => session.readonly || session.phase === 'saving',
      permissions: () => props.request.permissions,
      dispatch: dispatchToSurface,
    })
    session.attachBus(commandBus)

    if (stageRef.value) {
      await surface.mount(stageRef.value, {
        session,
        document: {
          kind,
          format: normalizedFormat.value,
          revision: session.revision,
          // 首屏内容随请求一起进来，Surface 自己不再发请求，也不进响应式
          payload: source,
          // 检索命中 / 深链提示原样交给内容面，Host 不解释 page / text 的语义
          hint: props.request.initialHint,
        },
        permissions: props.request.permissions,
        readonly: session.readonly,
        collabText: props.request.collabText,
        remoteTable: props.request.remoteTable,
        collabWritable: props.request.collabWritable,
        collabRich: props.request.collabRich,
        collabProvider: props.request.collabProvider,
        textHost: buildTextHost(),
        onContentChange: () => scheduleChange(),
        // 斜杠菜单里的扩展命令：内容面自己执行命令时先问扩展
        runExtensionCommand: (type, args) => (extensions.hasCommand(type) ? extensions.runCommand(type, args, extensionBinding) : null),
        onSheetHeight: (height) => (slashSheet.value = height),
        onLinkRequest: () => void chromeRef.value?.openLink(),
        onSelectionChange: (selection) => session.setSelection(selection),
        // 每次正文变化都要把最新正文推给页面（草稿、页头字数靠它）；Session 只在脏标记翻转时发事件，不够用
        onDirtyChange: (value) => {
          session.markDirty(value)
          scheduleChange()
        },
        // 内容面（CodeMirror）会吞掉 Mod-s，必须把保存意图交回 Host，页面只认这一条保存通道
        onSaveRequest: () => void handleSave(),
        onFindRequest: () => openFind(),
        // PDF 页数要等 pdf.js 打开完才知道；Word 的大纲要等渲染和包元信息读完才有。加载完成后一并回填
        onStatsChange: () => void Promise.all([refreshCounters(), refreshMeta()]),
        onError: (err) => {
          errorMessage.value = err.message
          emit('error', err)
        },
      })
      activeSurface.value = surface
      session.attachSurface(surface)
      attachExtensionBinding(kind, normalizedFormat.value, session)
      surfaceNotice.value = ''
      commandNotice.value = ''
      await Promise.all([refreshCounters(), refreshMeta()])
      if (props.autofocus && !session.readonly) surface.focus()
    }
    session.markReady()
    emit('ready')
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    phase.value = 'error'
    errorMessage.value = error.message
    emit('error', error)
  }
}

// Ctrl/⌘+S 保存、Ctrl/⌘+Z 撤销、Ctrl/⌘+Shift+Z / Ctrl+Y 重做；
// 只有焦点在编辑器内部时才接管，避免抢走页面其它输入框的快捷键。
useEditorHotkeys({
  root: rootRef,
  onSave: () => void handleSave(),
  onUndo: () => void handleUndo(),
  onRedo: () => void handleRedo(),
  onFind: () => openFind(),
  // 快捷键一览只有笔记文本面有（代码面的 Ctrl+/ 是 CodeMirror 的切换注释，它自己先处理掉，这里收不到）
  onShortcuts: () => {
    if (surfaceKind.value === 'text') chromeRef.value?.toggleShortcuts()
  },
  readonly: () => activeSession.value?.readonly ?? props.request.readonly,
})

onMounted(() => {
  // 注册内置内容面：只是登记动态 import 工厂，不触发任何 chunk 下载
  registerBuiltinSurfaces()
  // 第三方扩展：每个页面只请求一次清单，装好后注册表通知本组件重算工具栏
  void ensureExtensionsLoaded(defaultExtensionGate)
  void openDocument()
})

watch(
  () => props.request.fileId,
  () => {
    // 换了文档：先彻底拆掉旧会话，避免两套 Worker/历史栈并存
    teardown()
    void openDocument()
  },
)

// 同一份文档里点了另一条搜索命中：只换定位目标，不重开文档（重开要重新下载并渲染）
watch(
  () => props.request.initialHint?.anchor,
  (anchor) => {
    if (anchor && phase.value === 'ready') {
      // 带上命中文字：幻灯片面要用它在目标页上高亮（其它内容面忽略多出来的参数）
      void executeCommand({ id: `nav_${Date.now()}`, type: 'nav.anchor', args: { anchor, text: props.request.initialHint?.text }, source: 'user', readonlySafe: true })
    }
  },
)

function teardown() {
  detachExtensionBinding?.()
  detachExtensionBinding = null
  extensionBinding = null
  aiSuggestion.value = null
  pendingSuggestion = null
  // 换文档 / 卸载：AI 写作条和还没回来的结果一起作废（结果不能写进别的文档）
  aiRun += 1
  aiWriter.value = null
  activeSurface.value?.unmount()
  activeSurface.value = null
  activeSession.value?.destroy()
  activeSession.value = null
  unsubscribe?.()
  unsubscribe = null
  window.clearTimeout(changeTimer)
  changeTimer = 0
  dirty.value = false
  wordCount.value = 0
  unitLabel.value = ''
  surfaceNotice.value = ''
  commandNotice.value = ''
  phase.value = 'idle'
}

onBeforeUnmount(() => {
  teardown()
  stopExtensionsWatch()
  stopConfigWatch()
  // 自建注册表要连带清空，外部注入的由调用方负责
  if (!props.registry) selfRegistry.closeAll()
})

defineExpose({
  surfaceKind,
  phase,
  dirty,
  revision,
  wordCount,
  outline,
  activeSession,
  activeSurface,
  executeCommand,
  save: handleSave,
  undo: handleUndo,
  redo: handleRedo,
  /** ⌘K 面板:列出 / 执行当前可用的编辑器命令 */
  paletteActions,
  runPaletteAction,
  flushText,
  refreshText,
  replaceHref,
  /** 同步取正文（多人编辑的落地调度在事件回调里要用）；内容面不支持时返回 null */
  currentText: (): string | null => activeSurface.value?.textNow?.() ?? null,
  openFind,
  /** 打开快捷键一览（页面「更多」菜单里的入口） */
  openShortcuts: () => chromeRef.value?.toggleShortcuts(true),
  /** 打开 AI 写作条（页面顶栏的「AI 写作」按钮）；页面没接 AI 写作时什么都不做 */
  openAi,
  /** AI 写作现在能不能用（页面据此决定显不显示自己的入口） */
  aiWriteAvailable,
  /** 直接问内容面（只读查询，不经命令总线）；没有内容面时是 null */
  query: (query: SurfaceQuery): Promise<unknown> => activeSurface.value?.query(query) ?? Promise.resolve(null),
  focus: () => activeSurface.value?.focus(),
})
</script>

<template>
  <section
    ref="rootRef"
    class="kb-editor-host"
    data-testid="editor-host"
    :data-surface-kind="surfaceKind ?? 'unsupported'"
    @focusin="extensionBinding && extensions.activateHost(extensionBinding)"
  >
    <EditorChrome
      v-if="showChrome && surfaceKind"
      ref="chromeRef"
      :title="request.source.name"
      :show-title="chromeTitle"
      :show-close="chromeClose"
      :show-save="chromeSave"
      :collab-state="inRoom ? 'connected' : null"
      :kind="surfaceKind"
      :format="normalizedFormat"
      :readonly="request.readonly"
      :dirty="dirty"
      :phase="phase"
      :revision="revision"
      :permissions="request.permissions"
      :contribution="contribution"
      :format-state="formatState"
      :outline="outline"
      :status-items="statusItems.chrome"
      :bar-actions="barActions"
      :find-state="findState"
      :panels="extensionPanels"
      :mount-panel="mountExtensionPanel"
      :ai-tools="extensionAiTools"
      :ai-suggestion="aiSuggestion"
      :ai-write-available="aiWriteAvailable"
      :ai-writer="aiWriter"
      :text-panels="showTextPanels"
      :dockable="surfaceKind === 'text'"
      :query-link="queryLink"
      @command="handleChromeCommand"
      @dock="dock = $event"
      @save="handleSave"
      @undo="handleUndo"
      @redo="handleRedo"
      @close="emit('close')"
      @find-change="handleFindChange"
      @find-next="handleFindStep(1)"
      @find-prev="handleFindStep(-1)"
      @find-replace="handleFindReplace"
      @find-replace-all="handleFindReplaceAll"
      @find-close="handleFindClose"
      @outline-jump="handleOutlineJump"
      @image-request="handleImageRequest"
      @ai-tool="handleAiTool"
      @ai-tool-accept="handleAiToolAccept"
      @ai-tool-reject="handleAiToolReject"
      @ai-write-run="runAi"
      @ai-write-apply="applyAi"
      @ai-write-close="closeAi"
    >
      <template #toolbar="slotProps">
        <slot name="toolbar" v-bind="slotProps" />
      </template>
    </EditorChrome>

    <TextPanels
      v-if="showTextPanels && textServices"
      ref="panelsRef"
      :services="textServices"
      :readonly="request.readonly"
      :execute="panelExecute"
      :caret="panelCaret"
      @sheet-height="panelsSheet = $event"
    />
    <p v-if="commandNotice" class="kb-editor-command-notice" role="alert" data-testid="editor-command-notice">
      <span>{{ commandNotice }}</span>
      <button type="button" class="btn sm" aria-label="关闭提示" data-testid="editor-command-notice-close" @click="commandNotice = ''">知道了</button>
    </p>

    <!-- 错误边界与不支持格式的降级兜底，保证绝不白屏 -->
    <div
      v-if="!surfaceKind || errorMessage"
      class="kb-editor-fallback"
      role="alert"
      data-testid="editor-fallback"
    >
      <p class="kb-editor-fallback-text">
        {{ errorMessage || `暂不支持直接打开 .${normalizedFormat || 'unknown'} 格式` }}
      </p>
      <button
        type="button"
        class="btn sm"
        data-testid="editor-fallback-btn"
        @click="handleFallback"
      >
        改用备用方式查看或下载原件
      </button>
    </div>

    <!-- 内容面挂载舞台 -->
    <div
      v-show="surfaceKind && !errorMessage"
      ref="stageRef"
      class="kb-editor-stage"
      data-testid="editor-stage"
    >
      <p v-if="surfaceNotice" class="kb-editor-notice" data-testid="editor-surface-notice">
        {{ surfaceNotice }}
      </p>
    </div>

    <EditorStatus
      v-if="surfaceKind && showStatus"
      :items="statusItems.status"
      :phase="phase"
      :dirty="dirty"
      :readonly="request.readonly"
      :collab-state="request.collab ? 'connecting' : null"
      :room="roomState"
    />
  </section>
</template>

<style>
.kb-editor-host {
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--surface-1);
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r2);
  overflow: hidden;
}
.kb-editor-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.kb-editor-fallback {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 16px;
  color: var(--text-primary);
  background: var(--surface-1);
}
.kb-editor-command-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 6px 12px;
  font-size: calc(12px * var(--fs));
  line-height: 1.5;
  color: var(--err, #b91c1c);
  background: color-mix(in srgb, var(--err, #b91c1c) 8%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--err, #b91c1c) 25%, transparent);
}
.kb-editor-command-notice span {
  flex: 1;
  min-width: 0;
}
.kb-editor-notice {
  margin: 0;
  padding: 12px 16px;
  color: var(--text-tertiary);
  font-size: calc(13px * var(--fs));
}
.kb-editor-fallback-text {
  margin: 0;
  color: var(--text-tertiary);
  font-size: calc(13px * var(--fs));
}
</style>
