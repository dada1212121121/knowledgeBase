<script setup lang="ts">
/**
 * 编辑器统一顶栏 / 查找条 / 大纲 / 状态（骨架， 功能对齐）
 *
 * 设计约束：
 * 1. 所有按钮只发语义事件（`command` / `find-*` / `outline-jump` / `ai-tool`…），
 *    绝不 import 任何 Surface 或直接改文档——统一由 EditorHost 转交 CommandBus。
 * 导出 / 评论 / AI 入口、字数不再写死在这里：它们是内置扩展的贡献，由 Host 从注册表取出后
 *    以 `barActions`（顶栏操作区按钮）、`statusItems`（计数）、`aiTools`（AI 菜单）三个 prop 交进来，Chrome 只管渲染。
 * 2. 写操作按钮由贡献数据里的 `write` 标记驱动：只读或无写权限时整颗按钮不渲染，
 *    避免出现「看得见、点了报错」的假入口。
 * 3. 图标：认得的动作 id 画 16×16 线性 SVG（toolIcons.ts，与全站 KbIcon 同一画法），认不得的（第三方扩展）退回动作自带的短字符；
 *    不引图标字体。放不下的按钮收进「更多」，不依赖 hover 才能看到内容。
 * 4. 颜色 / 字号 / 圆角一律用全站 CSS 变量，深色浅色自动跟随。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fitToolbar, type ToolbarItemWidth } from './toolbarFit'
import type { Anchor, CollabConnectionState, EditorPermissions, SessionPhase, SurfaceKind } from '../types'
import { AI_WRITE_COMMAND, flattenActions, TEXT_EXTRA_SHORTCUTS, TEXT_MARKDOWN_INPUTS, type ActionChoice, type EditorAction, type SurfaceContribution } from '../extensions/builtin/text'
import AiWriteBar, { type AiWriterView } from './AiWriteBar.vue'
import type { AiApplyMode, AiWriteAction } from '../types'
import type { SurfaceKindName } from '../extensions/api'
import type { MergedContribution } from '../extensions/contributions'
import type { AIToolInfo, PanelInfo, StatusView } from '../extensions/registry'
import ExtensionPanel from './ExtensionPanel.vue'
import ToolIcon from './ToolIcon.vue'
import ColorPanel from './ColorPanel.vue'
import TableGridPicker from './TableGridPicker.vue'
import TableToolsBar from './TableToolsBar.vue'
import ShortcutsPanel, { type ShortcutSection } from './ShortcutsPanel.vue'
import { ariaShortcut, shortcutLabel } from './shortcutLabel'
import FoldTransition from '@/components/FoldTransition.vue'
import { namedToolIcon, toolIcon } from './toolIcons'
import { BACKGROUND_COLORS, TEXT_COLORS, isHexColor, normalizeColorHex } from '@/utils/colorPalette'
import '@/styles/kbColor.css'
import { keyboardState, useVisualViewport } from '@/composables/useVisualViewport'
import { shouldDockToolbar } from '@/utils/editorMobile'

/** 工具栏高亮所需的当前格式状态（由 Surface 的 formatState 查询上报） */
export interface FormatState {
  marks: string[]
  block: string
  level?: number
  inBlockquote: boolean
  lists: { bullet: boolean; ordered: boolean; task: boolean }
  /** 光标在表格里（笔记）：工具栏下面出现表格工具条 */
  inTable?: boolean
  /** 开着的视图开关（代码面的 wrap 等） */
  toggles?: string[]
  /** 当前值（Word：对齐 / 字号 / 字体 / 样式…），供 `check.kind === 'value'` 与菜单打勾比对 */
  values?: Record<string, string | number | null>
  /** 现在不能执行的命令及原因（命令类型 → 中文原因）：按钮置灰并把原因放进 title，而不是点了再报错 */
  unavailable?: Record<string, string>
}

/** 扩展 AI 工具的建议条：结果只作为建议展示，用户接受后才写回文档 */
export interface AiSuggestionView {
  toolId: string
  title: string
  status: 'running' | 'ready' | 'error'
  text: string
  note?: string
  error?: string
}

/** 查找条状态（数字来自 Surface 的真实命中，不在前端猜） */
export interface FindUiState {
  open: boolean
  query: string
  total: number
  index: number
}

const props = withDefaults(
  defineProps<{
    /** 文档显示名称 */
    title?: string
    /** 当前内容面类型（内置 6 类或扩展的 `ext:<id>`） */
    kind: SurfaceKindName
    /** 文件扩展名/格式 */
    format: string
    /** 是否只读 */
    readonly?: boolean
    /** 是否有未保存改动 */
    dirty?: boolean
    /** 当前会话阶段 */
    phase?: SessionPhase
    /** 文档版本号 */
    revision?: number
    /** 细粒度权限 */
    permissions?: EditorPermissions
    /** 协同连接状态 */
    collabState?: CollabConnectionState | null
    /** 当前内容面的工具栏贡献（null = 只显示通用按钮） */
    contribution?: MergedContribution | null
    /** 当前格式状态，用于按钮高亮 */
    formatState?: FormatState | null
    /** 大纲条目（标题跳转） */
    outline?: { level: number; text: string; anchor: Anchor }[]
    /** 顶栏状态栏项求值后的文字（字数 / 计数单位等，来自内置的 `kb.builtin.stats` 或第三方扩展） */
    statusItems?: StatusView[]
    /** 顶栏操作区的按钮（导出、评论…），已经按宿主页面的能力过滤过；点击发 `command` 事件 */
    barActions?: EditorAction[]
    /** 查找条状态（由 Host 从 Surface 查询后回填） */
    findState?: FindUiState | null
    /** 页面标题已经在外面显示时关掉这里的标题 */
    showTitle?: boolean
    /** 页面自己处理完成 / 关闭时隐藏这里的按钮 */
    showClose?: boolean
    /** 页面自带保存时关掉这里的保存按钮（见 EditorHost 的 chromeSave） */
    showSave?: boolean
    /** 扩展注册的面板：每个面板在操作区有一个开关按钮 */
    panels?: PanelInfo[]
    /** 把面板画进 el 并返回清理函数（Host 绑定了当前编辑器）；不传则不显示面板入口 */
    mountPanel?: (panel: PanelInfo, el: HTMLElement) => Promise<() => void>
    /** 扩展注册的 AI 工具：列在 AI 菜单里 */
    aiTools?: AIToolInfo[]
    /** AI 工具的建议条 */
    aiSuggestion?: AiSuggestionView | null
    /** 页面接了 AI 写作（UI-3）：「插入 → AI 写作…」等入口才显示 */
    aiWriteAvailable?: boolean
    /** AI 写作条的状态；null = 没打开 */
    aiWriter?: AiWriterView | null
    /**
     * 笔记页面面板（选择器 / 上传 / 相机）已由 Host 接管：图片按钮不再用 Chrome 自带的单图 input，
     * 改发 `text.panel.open`，走和粘贴 / 拖入同一条上传流水线（进度、大小上限、附件卡片）。
     * 与扩展面板 `panels` 是两回事，所以叫 textPanels
     */
    textPanels?: boolean
    /**
     * 手机上软键盘弹出时，格式工具栏贴在键盘上沿（对应旧编辑器的 is-docked）。
     * 只有笔记文本面传 true：顶部的粘性工具栏离拇指太远、横屏时还吃掉可视高度。其它内容面保持原样
     */
    dockable?: boolean
    /** 读光标所在链接的地址（编辑已有链接时回填输入框）；没有就总是空白起步 */
    queryLink?: () => Promise<string>
  }>(),
  {
    title: '',
    readonly: true,
    dirty: false,
    phase: 'idle',
    revision: 0,
    permissions: () => ({
      read: true,
      write: false,
      comment: false,
      ai: false,
      export: true,
    }),
    collabState: null,
    contribution: null,
    formatState: null,
    outline: () => [],
    statusItems: () => [],
    barActions: () => [],
    findState: null,
    showTitle: true,
    showClose: true,
    showSave: true,
    panels: () => [],
    mountPanel: undefined,
    aiTools: () => [],
    aiSuggestion: null,
    aiWriteAvailable: false,
    aiWriter: null,
    textPanels: false,
    dockable: false,
    queryLink: undefined,
  },
)

const emit = defineEmits<{
  (e: 'command', type: string, args?: unknown): void
  (e: 'save'): void
  (e: 'undo'): void
  (e: 'redo'): void
  (e: 'close'): void
  (e: 'find-change', query: string): void
  (e: 'find-next'): void
  (e: 'find-prev'): void
  (e: 'find-replace', text: string): void
  (e: 'find-replace-all', text: string): void
  (e: 'find-close'): void
  (e: 'outline-jump', anchor: Anchor): void
  (e: 'image-request', file: File): void
  (e: 'ai-tool', id: string): void
  (e: 'ai-tool-accept'): void
  (e: 'ai-tool-reject'): void
  (e: 'ai-write-run', action: AiWriteAction, instruction?: string): void
  (e: 'ai-write-apply', mode: AiApplyMode): void
  (e: 'ai-write-close'): void
  /** 工具栏贴键盘状态变化：Host 据此写 --kbd-bar / --kbd-reserve（选择器面板坐在工具栏上面、光标滚动让出位置） */
  (e: 'dock', state: { docked: boolean; height: number }): void
}>()

/** 内容面中文名称映射 */
const KIND_LABELS: Readonly<Record<string, string>> = {
  text: '文档',
  grid: '表格',
  page: 'Word',
  slide: '演示文稿',
  code: '代码',
  pdf: 'PDF',
}

const surfaceLabel = computed(() => KIND_LABELS[props.kind] ?? (props.kind.startsWith('ext:') ? '扩展文档' : '文档'))

/** 是否允许执行写操作（非只读、有写权限且处于 ready 状态） */
const canWrite = computed(
  () => !props.readonly && props.permissions.write && props.phase === 'ready',
)

/**
 * 是否允许触发保存。
 * 版本冲突（409）和保存失败之后会话停在 conflict / error 阶段：此时用户的改动还在编辑器里（脏态保留），
 * 唯一的出路就是重试保存（别人的修改已合并、网络恢复了）。如果这里要求 phase === 'ready'，保存按钮会灰掉，
 * 用户只能关掉编辑器丢改动。会话层的 save 在这两个阶段本来就允许重试，按钮要和它一致。
 */
const canSave = computed(
  () => !props.readonly && props.permissions.write && props.dirty && (props.phase === 'ready' || props.phase === 'conflict' || props.phase === 'error'),
)

/** 状态提示文案 */
const statusText = computed(() => {
  if (props.phase === 'loading') return '正在打开…'
  if (props.phase === 'checking') return '正在检查无损兼容性…'
  if (props.phase === 'saving') return '正在保存…'
  if (props.phase === 'conflict') return '版本冲突'
  if (props.phase === 'error') return '加载出错'
  if (props.readonly) return '只读'
  if (props.dirty) return '有未保存的改动'
  return '已就绪'
})

/** 源码模式：Surface 上报 toggles 里有 source */
const inSource = computed(() => props.formatState?.toggles?.includes('source') === true)

/** 按写权限过滤工具栏：只读时写操作整颗按钮消失（不是禁用后点了报错） */
/** AI 写作入口（`text.ai.open`）只在页面接了 AI 写作时出现；下拉里的子项同样过滤 */
function offered(action: EditorAction): boolean {
  return action.command !== AI_WRITE_COMMAND || props.aiWriteAvailable
}
function withOffered(action: EditorAction): EditorAction {
  return action.children ? { ...action, children: action.children.filter(offered) } : action
}

const toolbarGroups = computed(() => {
  const contribution = props.contribution
  if (!contribution) return []
  return contribution.toolbar
    .map((group) => ({
      ...group,
      // 源码模式下只剩“切回所见即所得”：格式按钮作用在看不见的文档上，留着只会让人困惑（旧编辑器同样收起）
      actions: group.actions
        .filter((action) => (action.write ? canWrite.value && (!inSource.value || action.id === 'source') : !inSource.value || action.check?.kind === 'toggle' || action.id === 'find'))
        .filter(offered)
        .map(withOffered),
    }))
    .filter((group) => group.actions.length > 0)
})

/* ---------------- 工具栏放不下时收进「更多」 ---------------- */
/** 按显示顺序排平的工具栏条目：分组之间插一根竖线 */
type ToolbarEntry = { kind: 'sep'; key: string } | { kind: 'action'; key: string; action: EditorAction }
const toolbarEntries = computed<ToolbarEntry[]>(() =>
  toolbarGroups.value.flatMap((group, index) => [
    ...(index > 0 ? [{ kind: 'sep' as const, key: `sep:${group.id}` }] : []),
    ...group.actions.map((action) => ({ kind: 'action' as const, key: action.id, action })),
  ]),
)
const toolsEl = ref<HTMLElement | null>(null)

/* ---------------- 手机：工具栏贴键盘 ---------------- */
// 软键盘一弹出，顶部的粘性工具栏离拇指太远、横屏时还吃掉可视高度。键盘打开时把它改成贴在键盘上沿：
// 位置靠 --kbd-inset（useVisualViewport 写的：iOS 上布局视口不变、Android 上布局视口跟着缩，两种都对）；
// 平板和桌面保持原样（判断见 utils/editorMobile.ts 的 shouldDockToolbar，与旧编辑器同一条线）。
if (props.dockable) useVisualViewport() // 外壳也在用；监听只装一份
const viewportWidth = ref(typeof window === 'undefined' ? 1024 : window.innerWidth)
const screenShortSide = typeof screen === 'undefined' ? Number.POSITIVE_INFINITY : Math.min(screen.width, screen.height) || Number.POSITIVE_INFINITY
const onViewportResize = () => (viewportWidth.value = window.innerWidth)
/**
 * 手机上（视口 <600）笔记编辑器的外壳压成一行：状态 / 字数 / 导出这些信息页头已经有（字数、草稿状态），
 * 撤销 / 重做挪进工具栏最前面。否则外壳占两行（≈100px），第一行正文被挤到屏高的三分之一以下（设计规范：≤30%）。
 * 只对文本面生效（dockable）；其它内容面的外壳不变。
 */
const compactRow = computed(() => props.dockable && viewportWidth.value < 600)
const docked = computed(
  () =>
    props.dockable &&
    !props.readonly &&
    shouldDockToolbar({ keyboardOpen: keyboardState.open, width: viewportWidth.value, screenShortSide }),
)
/** 工具栏自身的高度；贴键盘前在文档流里占的高度（原位放同样高的占位，正文不会因为键盘弹出而往上跳） */
const barHeight = ref(0)
const slotHeight = ref(0)
function measureDock() {
  const el = toolsEl.value
  if (!el) return
  barHeight.value = el.offsetHeight
  if (!docked.value) slotHeight.value = el.offsetHeight
}
watch(docked, () => nextTick(measureDock), { flush: 'post' })
watch(
  [docked, barHeight],
  () => emit('dock', { docked: docked.value, height: docked.value ? barHeight.value : 0 }),
  { immediate: true, flush: 'post' },
)
/** 前多少个条目留在工具栏上；其余进「更多」菜单。Infinity = 全部显示（还没量过 / 量不出来） */
const visibleCount = ref(Number.POSITIVE_INFINITY)
// 收进「更多」的下拉动作要平铺成它的子项：菜单里再套一层下拉在手机上没法用
const overflowActions = computed(() =>
  toolbarEntries.value
    .slice(Number.isFinite(visibleCount.value) ? visibleCount.value : toolbarEntries.value.length)
    .flatMap((entry) => (entry.kind === 'action' ? flattenActions([entry.action]) : [])),
)
/** 当前展开的工具栏下拉（动作 id）；同一时间只开一个 */
const dropdownOpen = ref('')
const moreOpen = ref(false)
/** 「更多」菜单里展开了选项的那个动作（字体、字号…）；菜单收起时一起收起，下次打开从头看 */
const moreChoicesOpen = ref('')
watch(moreOpen, (open) => {
  if (!open) moreChoicesOpen.value = ''
})
/**
 * 按钮多（文本面二十多个）时工具栏单独占第二行、铺满宽度：和状态 / 撤销 / 导出挤在一行时只剩三百来像素，
 * 一大半按钮要进「更多」。只有一两个按钮（PDF / 表格的查找）时仍和状态同一行，不白占一行高度。
 */
const STACK_THRESHOLD = 6
const stacked = computed(() => toolbarEntries.value.filter((entry) => entry.kind === 'action').length > STACK_THRESHOLD)
/** 每个条目的宽度：收进菜单的按钮量不到，用它显示时量到的值 */
const widthCache = new Map<string, number>()
const MORE_WIDTH_FALLBACK = 56

function measureToolbar() {
  const el = toolsEl.value
  if (!el) return
  measureDock()
  for (const node of el.querySelectorAll<HTMLElement>('[data-entry]')) {
    if (node.offsetWidth) widthCache.set(node.dataset.entry ?? '', node.offsetWidth)
  }
  const entries = toolbarEntries.value
  const widths: ToolbarItemWidth[] = entries.map((entry) => ({ kind: entry.kind, width: widthCache.get(entry.key) ?? 0 }))
  // 没有布局（jsdom、隐藏的标签页）：量不出来就全部显示，不能把按钮全藏掉
  if (!el.clientWidth || widths.some((item) => item.kind === 'action' && !item.width)) {
    visibleCount.value = Number.POSITIVE_INFINITY
    return
  }
  const style = getComputedStyle(el)
  const gap = Number.parseFloat(style.columnGap || style.gap || '0') || 0
  // 插槽里的页面按钮（如表格的「文字层」）一直显示，先从可用宽度里扣掉
  let fixed = 0
  for (const node of el.querySelectorAll<HTMLElement>(':scope > :not([data-entry]):not([data-more])')) fixed += node.offsetWidth + gap
  const more = el.querySelector<HTMLElement>('[data-more]')?.offsetWidth || MORE_WIDTH_FALLBACK
  const fit = fitToolbar(widths, el.clientWidth - fixed, more, gap)
  visibleCount.value = fit >= entries.length ? Number.POSITIVE_INFINITY : fit
}

let resizeObserver: ResizeObserver | null = null
/** 点菜单外面收起「更多」和工具栏下拉（按钮自己的点击由它的 @click 切换，不在这里处理） */
function closeMoreOnOutside(event: PointerEvent) {
  const target = event.target instanceof Node ? event.target : null
  if (moreOpen.value) {
    const wrap = toolsEl.value?.querySelector('[data-more]')
    if (!(wrap && target && wrap.contains(target))) moreOpen.value = false
  }
  if (dropdownOpen.value) {
    const wrap = toolsEl.value?.querySelector(`[data-dropdown="${dropdownOpen.value}"]`)
    if (!(wrap && target && wrap.contains(target))) dropdownOpen.value = ''
  }
  if (pop.value) {
    const wrap = toolsEl.value?.querySelector(`[data-panel-wrap="${pop.value.id}"]`)
    const more = toolsEl.value?.querySelector('[data-more]')
    const inside = (el: Element | null | undefined) => !!(el && target && el.contains(target))
    if (!(pop.value.source === 'tool' ? inside(wrap) : inside(more))) closePop()
  }
}
onMounted(() => {
  document.addEventListener('pointerdown', closeMoreOnOutside)
  document.addEventListener('pointerdown', closeChoicesOnOutside)
  document.addEventListener('pointerdown', closeShortcutsOnOutside)
  document.addEventListener('keydown', closeShortcutsOnEsc)
  window.addEventListener('resize', onViewportResize)
  measureDock()
  if (typeof ResizeObserver === 'undefined' || !toolsEl.value) return
  // ResizeObserver 回调里不能同步改被观察元素的布局（收进 / 展开「更多」会改工具栏宽度）：
  // WebKit 会报 "ResizeObserver loop completed with undelivered notifications"。推迟到下一帧并合并多次通知
  let queued = 0
  resizeObserver = new ResizeObserver(() => {
    if (queued) return
    queued = window.requestAnimationFrame(() => {
      queued = 0
      measureToolbar()
    })
  })
  resizeObserver.observe(toolsEl.value)
  measureToolbar()
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeMoreOnOutside)
  document.removeEventListener('pointerdown', closeChoicesOnOutside)
  document.removeEventListener('pointerdown', closeShortcutsOnOutside)
  document.removeEventListener('keydown', closeShortcutsOnEsc)
  window.removeEventListener('resize', onViewportResize)
  resizeObserver?.disconnect()
})
// 按钮集合变了（只读切换、换内容面）：先全部显示量一遍宽度，再决定收哪些
watch(
  () => toolbarEntries.value.map((entry) => entry.key).join('|'),
  async () => {
    visibleCount.value = Number.POSITIVE_INFINITY
    await nextTick()
    measureToolbar()
  },
)

/**
 * 下拉 / 「更多」菜单不能伸出屏幕：靠右的按钮（手机上的「更多」）展开后菜单会越过右边缘，靠左的反之。
 * 渲染后量一次，横向平移到屏内；没有布局（jsdom）时矩形全 0，不动。
 */
function clampMenuX(el: HTMLElement) {
  // 用独立的 translate 属性而不是 transform：菜单进场动画正在改 transform（缩放），两者共用会互相盖掉
  el.style.translate = ''
  const width = el.offsetWidth
  if (!width) return
  // 进场动画的 scale 会让 getBoundingClientRect 偏小：量到的是动画中间态，算出来的右边距不够，
  // 动画结束后菜单仍会伸出屏幕。offsetWidth / offsetLeft 是布局尺寸，不受 transform 影响。
  const parent = el.offsetParent as HTMLElement | null
  const left = parent ? parent.getBoundingClientRect().left + el.offsetLeft : el.offsetLeft
  const right = left + width
  const max = window.innerWidth - 8
  let shift = 0
  if (right > max) shift = max - right
  if (left + shift < 8) shift = 8 - left
  if (shift) el.style.translate = `${Math.round(shift)}px 0`
}
const vClampX = { mounted: clampMenuX, updated: clampMenuX }

/**
 * 点工具栏按钮不能把焦点从正文抢走（旧编辑器所有工具栏按钮都 mousedown.prevent）：
 * 否则点一下「加粗」再接着打字，字会打不进去；点标题下拉里的项之后菜单关闭，焦点掉到 body，Ctrl+Z 也没人接。
 * 键盘操作（Tab 到按钮、回车）不受影响——焦点本来就在按钮上。输入框（查找、链接）在工具栏容器之外，不会被拦。
 */
function keepEditorFocus(event: MouseEvent) {
  if (event.target instanceof Element && event.target.closest('button')) event.preventDefault()
}

function runOverflowAction(action: EditorAction) {
  moreOpen.value = false
  // 颜色面板挂在「更多」按钮下面（按钮自己已经被收进菜单了，没有它的位置可挂）
  if (action.command === 'text.color.open') return togglePop('color', 'more')
  if (action.id === 'table') return togglePop('table', 'more')
  runAction(action)
}

/** 「正文」段落：标题下拉里的默认项，菜单里照常打勾，但不让下拉按钮本身高亮 */
function isDefaultBlock(action: EditorAction): boolean {
  return action.check?.kind === 'block' && action.check.block === 'paragraph'
}

/** 按钮是否处于激活态（与 Surface 上报的格式状态一一对应） */
function isActive(action: EditorAction): boolean {
  // 下拉按钮：任何一个子项处于激活态（当前是标题 → “标题”下拉高亮）。
  // 「正文」是默认状态，不算：否则光标在普通段落里时标题按钮一直亮着，看不出现在是不是标题
  if (action.children) return action.children.some((child) => !isDefaultBlock(child) && isActive(child)) || dropdownOpen.value === action.id
  // 大纲是开关：面板开着时按钮高亮，用户知道再点一下就收起
  if (action.command === 'view.toggleOutline') return outlineOpen.value
  const check = action.check
  const state = props.formatState
  if (!check || !state) return false
  // 假 Surface / 尚未上报时字段可能缺失：按「未激活」处理，不能让渲染抛错
  if (check.kind === 'mark') return (state.marks ?? []).includes(check.name)
  if (check.kind === 'block') {
    if (check.block === 'blockquote') return state.inBlockquote === true
    if (check.block === 'heading') return state.block === 'heading' && state.level === check.level
    return state.block === check.block && !state.inBlockquote
  }
  if (check.kind === 'toggle') return (state.toggles ?? []).includes(check.name)
  if (check.kind === 'value') return state.values?.[check.name] === check.value
  if (check.kind === 'list') {
    const lists = state.lists ?? { bullet: false, ordered: false, task: false }
    if (check.list === 'task_list') return lists.task === true
    if (check.list === 'bullet_list') return lists.bullet === true && lists.task !== true
    return lists.ordered === true
  }
  return false
}

/**
 * 下拉按钮上显示什么：子项里有一个（不是默认的「正文」）正生效时，显示它的图标——光标在二级标题里按钮就是「H2」、
 * 在引用里就是引用的图标，不用点开也看得出现在是什么样式（飞书的段落样式按钮同样显示当前样式）。没有就显示下拉自己的图标
 */
function dropdownFace(action: EditorAction): { paths: readonly string[] | null; text: string; label: string } | null {
  const active = action.children?.find((child) => !isDefaultBlock(child) && isActive(child))
  if (!active) return null
  return { paths: toolIcon(active.id), text: active.icon ?? '', label: active.label }
}

/**
 * 下拉按钮的可访问名称：以按钮上看得见的字开头（WCAG 2.5.3「名称包含可见文字」——按钮上显示「H2」时，
 * 读屏和语音控制要能用「H2」叫到它），后面接下拉的名字和光标处现在的样式。
 * 按钮上画的是 SVG 图标时没有可见文字，名称里也就不带图标字符
 */
function dropdownAriaLabel(action: EditorAction): string {
  const face = dropdownFace(action)
  const visible = face ? (face.paths ? '' : face.text) : toolIcon(action.id) ? '' : (action.icon ?? '')
  return `${visible} ${action.label}${face ? `：${face.label}` : ''}`.trim()
}

/** 按钮的悬停提示：不可用的原因优先，否则是说明（或名字）加快捷键，macOS 上快捷键写成 ⌘⌥⇧ */
function actionTitle(action: EditorAction): string {
  const reason = unavailableReason(action)
  if (reason) return reason
  const base = action.description ?? action.label
  return action.shortcut ? `${base}（${shortcutLabel(action.shortcut)}）` : base
}

/** 双击按钮：动作声明了双击参数（格式刷的「连续刷」）才有反应 */
function runDouble(action: EditorAction) {
  if (action.doubleClickArgs === undefined || unavailableReason(action)) return
  emit('command', action.command, action.doubleClickArgs)
}

/* ---------------- 快捷键一览（Ctrl+/） ---------------- */
// 只有笔记文本面有：内容来自工具栏数据（按钮自己的快捷键）+ 工具栏之外的键 + Markdown 快捷输入。
// 不抢焦点（开着也能接着打字）；Esc、再按一次 Ctrl+/、点面板外面都会关掉
const shortcutsOpen = ref(false)
const shortcutSections = computed<ShortcutSection[]>(() => {
  const groups = props.contribution?.toolbar ?? []
  const sections: ShortcutSection[] = groups
    .map((group) => ({
      title: group.label,
      items: flattenActions(group.actions)
        .filter((action) => !!action.shortcut)
        .map((action) => ({ label: action.label, keys: action.shortcut! })),
    }))
    .filter((section) => section.items.length > 0)
  return [...sections, { title: '编辑', items: TEXT_EXTRA_SHORTCUTS }, { title: 'Markdown 快捷输入', items: TEXT_MARKDOWN_INPUTS, typed: true }]
})
/** 打开 / 关上快捷键一览；force 指定状态。不是笔记文本面时什么也不做 */
function toggleShortcuts(force?: boolean) {
  if (props.kind !== 'text') return
  shortcutsOpen.value = force ?? !shortcutsOpen.value
  if (shortcutsOpen.value) outlineOpen.value = false
}
function closeShortcutsOnOutside(event: PointerEvent) {
  if (!shortcutsOpen.value) return
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('[data-testid="editor-shortcuts"]')) return
  shortcutsOpen.value = false
}
function closeShortcutsOnEsc(event: KeyboardEvent) {
  if (shortcutsOpen.value && event.key === 'Escape' && !event.isComposing) shortcutsOpen.value = false
}

/* ---------------- 查找条 ---------------- */

// 初始展开状态跟随 Host 传入的 findState（?find=1 或恢复上次查找时直接是开的）
const findOpen = ref(props.findState?.open === true)
const findQuery = ref('')
const replaceOpen = ref(false)
const replaceText = ref('')
const findInput = ref<HTMLInputElement | null>(null)

/** 把查找请求交给 Host（真正的匹配在 Surface 内完成） */
function emitFindQuery() {
  emit('find-change', findQuery.value)
}

function openFind() {
  findOpen.value = true
  void nextTick(() => findInput.value?.focus())
}

function closeFind() {
  findOpen.value = false
  replaceOpen.value = false
  emit('find-close')
}

/** 查找条内键盘：Enter 下一个、Shift+Enter 上一个、Esc 关闭（与桌面编辑器一致） */
/**
 * 输入法组字中的 Enter / Esc / Tab 是上屏、取消组字、选词，不是查找条 / 链接条的命令
 * （旧编辑器的 swallowImeKeys 对编辑器里的所有输入框都让路；这里的输入框在外壳里，自己判断）
 */
function isImeKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
}

function onFindKeydown(event: KeyboardEvent) {
  if (isImeKey(event)) return
  if (event.key === 'Enter') {
    event.preventDefault()
    if (event.shiftKey) emit('find-prev')
    else emit('find-next')
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    closeFind()
    return
  }
  if (event.key === 'Tab' && !replaceOpen.value) {
    // Tab 展开替换行，不让焦点跑出查找条后用户找不到替换入口
    event.preventDefault()
    toggleReplace()
  }
}

function toggleReplace() {
  replaceOpen.value = !replaceOpen.value
}

/* ---------------- 大纲 ---------------- */

const outlineOpen = ref(false)
const hasOutline = computed(() => props.outline.length > 0)

function jumpOutline(anchor: Anchor) {
  emit('outline-jump', anchor)
}

/* ---------------- 扩展面板 ---------------- */

const openPanels = ref<string[]>([])
const dockedPanels = computed(() => props.panels.filter((panel) => openPanels.value.includes(panel.key)))

function isPanelOpen(panel: PanelInfo): boolean {
  return openPanels.value.includes(panel.key)
}

function togglePanel(panel: PanelInfo) {
  openPanels.value = isPanelOpen(panel) ? openPanels.value.filter((key) => key !== panel.key) : [...openPanels.value, panel.key]
}

// 扩展被卸载后它的面板不在列表里了：同步清掉「已打开」记录，免得重装后面板自己弹出来
watch(
  () => props.panels.map((panel) => panel.key).join('|'),
  () => {
    openPanels.value = openPanels.value.filter((key) => props.panels.some((panel) => panel.key === key))
  },
)

/* ---------------- 链接 / 图片 ---------------- */

const linkOpen = ref(false)
const linkHref = ref('')
const linkInput = ref<HTMLInputElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

/** 光标所在的已有链接的地址（空 = 在新建链接）：有它才显示「打开 / 复制」 */
const linkExisting = ref('')
async function openLink() {
  closePop()
  linkOpen.value = true
  linkHref.value = ''
  linkExisting.value = ''
  void nextTick(() => linkInput.value?.focus())
  // 光标在已有链接里：把它的地址填进来，改地址 / 移除链接都不用先选中整段文字
  try {
    const existing = await props.queryLink?.()
    if (existing && linkOpen.value) {
      linkExisting.value = existing
      if (!linkHref.value) linkHref.value = existing
    }
  } catch {
    // 读不到就空白起步，不影响插入
  }
}

/* ---------------- 字色 / 底色 ---------------- */
// 悬浮面板（文字颜色、表格大小共用）：鼠标悬停在按钮上稍等就弹出，点击固定住（触屏没有悬停，点一下弹出）；
// 点面板外面、选了之后、按 Esc 收起。按钮被收进「更多」时（宽度不够），面板挂在「更多」下面
type PanelId = 'color' | 'table'
const pop = ref<{ id: PanelId; source: 'tool' | 'more'; pinned: boolean } | null>(null)
let panelTimer = 0
const canHover = () => typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover)').matches
const isPopOpen = (id: PanelId, source: 'tool' | 'more') => pop.value?.id === id && pop.value.source === source
function closePop() {
  window.clearTimeout(panelTimer)
  pop.value = null
}
function hoverPop(id: PanelId, on: boolean) {
  if (!canHover() || pop.value?.pinned) return
  window.clearTimeout(panelTimer)
  // 进入稍等一下（鼠标只是路过工具栏不弹），离开多留一会儿（从按钮挪到面板的路上不要关）
  panelTimer = window.setTimeout(
    () => {
      if (on) {
        linkOpen.value = false
        pop.value = { id, source: 'tool', pinned: false }
      } else pop.value = null
    },
    on ? 80 : 220,
  )
}
function togglePop(id: PanelId, source: 'tool' | 'more' = 'tool') {
  window.clearTimeout(panelTimer)
  linkOpen.value = false
  if (pop.value?.id === id && pop.value.pinned && pop.value.source === source) return closePop()
  pop.value = { id, source, pinned: true }
}
/** 光标在表格里（且能写、不在源码模式）才显示表格工具条 */
const showTableTools = computed(() => props.kind === 'text' && canWrite.value && !inSource.value && props.formatState?.inTable === true)
/** 光标处现在的字色 / 底色（调色板 key 或自定义 hex），传给面板标出当前色块与取色器初始值 */
const colorFg = computed(() => (props.formatState?.values?.noteColor as string | null | undefined) ?? null)
const colorBg = computed(() => (props.formatState?.values?.noteBg as string | null | undefined) ?? null)
/** 工具栏按钮上显示的「当前字色」小条的类名（没设过字色就是默认灰） */
const colorBarClass = computed(() => {
  const key = props.formatState?.values?.noteColor
  // 自定义色没有 is-fg-* 类，改由下面的 style 直接上色；hex 进 class 也不是合法类名
  return typeof key === 'string' && key && !isHexColor(key) ? `kb-color is-fg-${key}` : ''
})
const colorBarStyle = computed(() => {
  const key = props.formatState?.values?.noteColor
  return typeof key === 'string' && isHexColor(key) ? { color: normalizeColorHex(key)! } : undefined
})
/** key 为 null = 清除该种颜色；选区为空时内容面会回一句提示，由 Host 显示 */
function pickColor(prop: 'color' | 'background-color', key: string | null) {
  emit('command', 'mark.color', { prop, key })
  closePop()
}
/** 表格大小面板里选了 rows × cols：插入表格 */
function pickTable(rows: number, cols: number) {
  emit('command', 'block.insertTable', { rows, cols })
  closePop()
}

function onLinkKeydown(event: KeyboardEvent) {
  if (isImeKey(event)) return
  if (event.key === 'Enter') {
    event.preventDefault()
    applyLink()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    linkOpen.value = false
  }
}

function applyLink() {
  const href = linkHref.value.trim()
  if (!href) return
  emit('command', 'text.link.apply', { href })
  linkOpen.value = false
}

function openExistingLink() {
  emit('command', 'text.link.open-href', { href: linkExisting.value })
}
const linkCopied = ref(false)
async function copyExistingLink() {
  try {
    await navigator.clipboard?.writeText(linkExisting.value)
    linkCopied.value = true
    window.setTimeout(() => (linkCopied.value = false), 1500)
  } catch {
    // 剪贴板不可用（非安全上下文）：地址就在输入框里，用户可以手动复制
  }
}

function removeLink() {
  emit('command', 'text.link.apply', { href: '' })
  linkOpen.value = false
}

function pickImage() {
  fileInput.value?.click()
}

function onImagePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) emit('image-request', file)
}

/* ---------------- AI 菜单 ---------------- */

const aiOpen = ref(false)

/**
 * AI 菜单里的每一项都是一个 AI 工具（`registerAITool`）：内置的润色 / 总结 / 翻译与第三方的没有区别，
 * Chrome 只发 `ai-tool` 事件，由 Host 取选区、运行、决定是展示建议还是交给页面。
 */
function runAiTool(id: string) {
  aiOpen.value = false
  emit('ai-tool', id)
}

/* ---------------- 带选项的动作（字号 / 颜色 / 表格大小…） ---------------- */

/** 当前展开的选项菜单（动作 id）；同一时间只开一个 */
const choiceOpen = ref<string | null>(null)

/** 这个动作现在不可用的原因（没有 = 可用） */
function unavailableReason(action: EditorAction): string | undefined {
  return props.formatState?.unavailable?.[action.command]
}

function isCurrentChoice(choice: ActionChoice): boolean {
  const current = choice.current
  if (!current) return false
  // 没有值（null / 未上报）和空串等价：「默认字体」这一项在没设过字体时打勾
  const value = props.formatState?.values?.[current.name]
  return (value ?? '') === current.value
}

/** 选项动作当前选中的那一项的文字（「更多」里那一行右侧显示，例如「字体　楷体」）；没有可比对的当前值返回空 */
function currentChoiceLabel(action: EditorAction): string {
  return action.choices?.find((choice) => isCurrentChoice(choice))?.label ?? ''
}

function toggleChoices(action: EditorAction) {
  if (unavailableReason(action)) return
  choiceOpen.value = choiceOpen.value === action.id ? null : action.id
}

function pickChoice(action: EditorAction, choice: ActionChoice) {
  choiceOpen.value = null
  moreOpen.value = false
  emit('command', action.command, choice.args)
}

/** 点菜单外面收起选项菜单 */
function closeChoicesOnOutside(event: PointerEvent) {
  if (!choiceOpen.value) return
  if (event.target instanceof Element && event.target.closest('[data-choices]')) return
  choiceOpen.value = null
}

/* ---------------- 动作分发 ---------------- */

/** UI 类动作（需要额外输入）在 Chrome 内处理，其余一律走 CommandBus */
function runAction(action: EditorAction) {
  if (unavailableReason(action)) return
  if (action.children) {
    dropdownOpen.value = dropdownOpen.value === action.id ? '' : action.id
    return
  }
  dropdownOpen.value = ''
  if (action.command === 'text.link.open') return void openLink()
  if (action.command === 'text.color.open') return togglePop('color', 'tool')
  if (action.id === 'table') return togglePop('table', 'tool')
  if (action.command === 'text.image.open') {
    if (props.textPanels) return emit('command', 'text.panel.open', { panel: 'image' })
    return pickImage()
  }
  if (action.command === 'search.open') return openFind()
  if (action.command === 'view.toggleOutline') {
    outlineOpen.value = !outlineOpen.value
    if (outlineOpen.value) shortcutsOpen.value = false
    return
  }
  emit('command', action.command, action.args)
}

/** 顶栏操作区的按钮：不需要 Chrome 内的 UI，直接把命令交给 Host（导出 / 评论经注册表命令转给页面） */
function runBarAction(action: EditorAction) {
  emit('command', action.command, action.args)
}

/** 命令面板能直接执行的视图动作：需要弹出 Chrome 自己的面板，但执行完不依赖工具栏按钮的位置 */
const PALETTE_UI_COMMANDS = new Set(['search.open', 'view.toggleOutline'])

/**
 * ⌘K 命令面板里的编辑器命令(UI-5):直接复用工具栏的动作定义,不另抄一份标签 / 命令名。
 *  - 有子项的菜单(插入、标题)摊平后逐项列出,面板里输「代码块」也能直接命中;
 *  - 需要额外输入的 UI 动作(链接 / 图片 / 颜色 / 表格尺寸)不列:面板已经关了,再弹出一个挂在工具栏上的浮层没人接得住;
 *  - 只读时工具栏已经过滤掉写操作,这里拿到的是同一份 `toolbarGroups`,不会列出打不出去的命令。
 */
function paletteActions(): { id: string; label: string; hint?: string; keywords?: string; run: () => void }[] {
  const list: { id: string; label: string; hint?: string; keywords?: string; run: () => void }[] = []
  const seen = new Set<string>()
  const add = (action: EditorAction) => {
    if (action.children) {
      action.children.forEach(add)
      return
    }
    if (seen.has(action.id) || unavailableReason(action)) return
    // 表格按钮在工具栏里是「选几行几列」的浮层;在面板里没有位置可挂,列出来只会静默失败
    if (action.id === 'table') return
    if (action.ui && !PALETTE_UI_COMMANDS.has(action.command)) return
    seen.add(action.id)
    list.push({
      id: action.id,
      label: action.label,
      hint: action.shortcut,
      keywords: [action.label, ...(action.keywords ?? [])].join(' '),
      run: () => runAction(action),
    })
  }
  for (const group of toolbarGroups.value) group.actions.forEach(add)
  return list
}

/** AI 写作条：没指定动作就打开时，焦点放进「写下要求」输入框 */
const aiBar = ref<InstanceType<typeof AiWriteBar> | null>(null)
function focusAiInput() {
  void nextTick(() => aiBar.value?.focusInput())
}

defineExpose({ openFind, closeFind, openLink, toggleShortcuts, focusAiInput, paletteActions })

/** 不属于任何动作的固定按钮图标（撤销 / 重做 / 更多 / 下拉箭头） */
const ICON_UNDO = namedToolIcon('undo')
const ICON_REDO = namedToolIcon('redo')
const ICON_MORE = namedToolIcon('more')
const ICON_CARET = namedToolIcon('caret')

// 没有 mountPanel（独立挂载的 Chrome、旧调用方）就不显示面板入口：有开关按钮却画不出内容是死入口
const panelsEnabled = computed(() => typeof props.mountPanel === 'function')
// 有可用的 AI 工具（内置的需要页面接入 AI 能力，第三方的需要文档有 AI 权限，由 Host 过滤）才有 AI 按钮
const showAiButton = computed(() => props.aiTools.length > 0)
/** 操作区按钮：写操作只读时不显示；手机上压成一行时，标了 `compact: 'hide'` 的收起（页头已有） */
const visibleBarActions = computed(() =>
  props.barActions.filter((action) => (!action.write || canWrite.value) && !(compactRow.value && action.compact === 'hide')),
)

// 外部（Ctrl+F）打开查找条：由 Host 把 find.open 传进来
watch(
  () => props.findState?.open,
  (open) => {
    if (open) openFind()
    else findOpen.value = false
  },
)

// 命中数变化时同步输入框（例如上一/下一跳转后 Surface 回填了查询串）
watch(
  () => props.findState?.query,
  (query) => {
    if (typeof query === 'string' && query !== findQuery.value) findQuery.value = query
  },
)
</script>

<template>
  <header
    class="kb-editor-chrome"
    :class="{ 'is-stacked': stacked, 'is-docked': docked, 'is-compact': compactRow }"
    data-testid="editor-chrome"
    role="toolbar"
    :aria-label="`${surfaceLabel}工具栏`"
  >
    <div class="kb-editor-chrome-row">
      <div class="kb-editor-chrome-meta">
        <span class="kb-editor-chrome-badge" data-testid="editor-surface-kind">{{ surfaceLabel }}</span>
        <span v-if="title && showTitle" class="kb-editor-chrome-title" :title="title">{{ title }}</span>
        <span class="kb-editor-chrome-status" data-testid="editor-status">{{ statusText }}</span>
        <span v-if="revision > 0" class="kb-editor-chrome-rev" data-testid="editor-revision">v{{ revision }}</span>
      </div>

      <!-- 工具栏贴到键盘上后，原位放同样高的占位 -->
      <div v-if="docked" class="kb-editor-chrome-spacer" aria-hidden="true" :style="{ height: `${slotHeight}px` }"></div>
      <!-- 内容面贡献出来的工具栏：分组之间用竖线隔开；放不下的从某一个开始全部收进「更多」 -->
      <div ref="toolsEl" class="kb-editor-chrome-tools" data-testid="editor-toolbar-slot" @mousedown="keepEditorFocus">
        <!-- 手机压成一行时，撤销 / 重做在工具栏最前面（桌面它们在右上角的动作区） -->
        <template v-if="compactRow && !readonly && permissions.write">
          <button type="button" class="kb-editor-tool" :disabled="!canWrite" aria-label="撤销" title="撤销" data-testid="editor-undo" @click="emit('undo')"><ToolIcon :paths="ICON_UNDO" /></button>
          <button type="button" class="kb-editor-tool" :disabled="!canWrite" aria-label="重做" title="重做" data-testid="editor-redo" @click="emit('redo')"><ToolIcon :paths="ICON_REDO" /></button>
          <span class="kb-editor-chrome-sep" aria-hidden="true"></span>
        </template>
        <template v-for="(entry, index) in toolbarEntries" :key="entry.key">
          <template v-if="index < visibleCount">
            <span v-if="entry.kind === 'sep'" class="kb-editor-chrome-sep" aria-hidden="true" :data-entry="entry.key"></span>
            <span v-else-if="entry.action.choices" class="kb-editor-chrome-menu-wrap" data-choices :data-entry="entry.key">
              <button
                type="button"
                class="kb-editor-tool"
                :class="{ 'is-active': choiceOpen === entry.action.id }"
                aria-haspopup="menu"
                :aria-expanded="choiceOpen === entry.action.id"
                :aria-label="entry.action.label"
                :disabled="!!unavailableReason(entry.action)"
                :title="unavailableReason(entry.action) ?? entry.action.label"
                :data-action="entry.action.id"
                @click="toggleChoices(entry.action)"
                @keydown.esc="choiceOpen = null"
              >
                <ToolIcon v-if="toolIcon(entry.action.id)" :paths="toolIcon(entry.action.id)!" />
                <span v-else-if="entry.action.icon" aria-hidden="true">{{ entry.action.icon }}</span>
                <template v-else>{{ entry.action.label }}</template>
                <ToolIcon class="kb-editor-caret" :paths="ICON_CARET" :size="10" />
              </button>
              <Transition name="kb-menu">
              <div v-if="choiceOpen === entry.action.id" class="kb-editor-chrome-menu is-left" role="menu" :aria-label="entry.action.label" :data-testid="`choices-${entry.action.id}`">
                <button
                  v-for="choice in entry.action.choices"
                  :key="choice.label"
                  type="button"
                  role="menuitem"
                  class="kb-editor-chrome-menu-item"
                  :class="{ 'is-active': isCurrentChoice(choice) }"
                  :data-choice="choice.label"
                  @click="pickChoice(entry.action, choice)"
                >
                  <span v-if="choice.swatch" class="kb-editor-swatch" :style="{ background: choice.swatch }" aria-hidden="true"></span>
                  <span :style="choice.font ? { fontFamily: choice.font } : undefined">{{ choice.label }}</span>
                </button>
              </div>
              </Transition>
            </span>
            <!-- 文字颜色：按钮上带当前字色的小条；悬停弹出常用颜色面板，点击固定，触屏点一下弹出 -->
            <span
              v-else-if="entry.action.command === 'text.color.open'"
              class="kb-editor-chrome-menu-wrap"
              data-panel-wrap="color"
              :data-entry="entry.key"
              @mouseenter="hoverPop('color', true)"
              @mouseleave="hoverPop('color', false)"
            >
              <button
                type="button"
                class="kb-editor-tool kb-color-btn"
                :class="{ 'is-active': isPopOpen('color', 'tool') }"
                aria-haspopup="menu"
                :aria-expanded="isPopOpen('color', 'tool')"
                :aria-label="entry.action.label"
                :title="entry.action.label"
                :disabled="!!unavailableReason(entry.action)"
                :data-action="entry.action.id"
                @click="togglePop('color', 'tool')"
                @keydown.esc="closePop"
              >
                <ToolIcon :paths="toolIcon('color')!" />
                <i class="kb-color-bar" :class="colorBarClass" :style="colorBarStyle" aria-hidden="true"></i>
              </button>
              <Transition name="kb-menu">
                <ColorPanel
                  v-if="isPopOpen('color', 'tool')"
                  v-clamp-x
                  class="kb-editor-chrome-menu is-left kb-color-menu"
                  :fg="colorFg"
                  :bg="colorBg"
                  @pick="pickColor"
                />
              </Transition>
            </span>
            <!-- 表格：悬停弹出 8 × 8 的大小选择（像 Word），点一格就按那个大小插入；触屏点一下弹出 -->
            <span
              v-else-if="entry.action.id === 'table'"
              class="kb-editor-chrome-menu-wrap"
              data-panel-wrap="table"
              :data-entry="entry.key"
              @mouseenter="hoverPop('table', true)"
              @mouseleave="hoverPop('table', false)"
            >
              <button
                type="button"
                class="kb-editor-tool"
                :class="{ 'is-active': isPopOpen('table', 'tool') }"
                aria-haspopup="menu"
                :aria-expanded="isPopOpen('table', 'tool')"
                :aria-label="entry.action.label"
                :title="entry.action.label"
                :disabled="!!unavailableReason(entry.action)"
                :data-action="entry.action.id"
                @click="togglePop('table', 'tool')"
                @keydown.esc="closePop"
              >
                <ToolIcon :paths="toolIcon(entry.action.id)!" />
              </button>
              <Transition name="kb-menu">
                <TableGridPicker v-if="isPopOpen('table', 'tool')" v-clamp-x class="kb-editor-chrome-menu is-left kb-color-menu" @pick="pickTable" />
              </Transition>
            </span>
            <div v-else-if="entry.action.children" class="kb-editor-chrome-menu-wrap" :data-entry="entry.key" :data-dropdown="entry.action.id">
              <button
                type="button"
                class="kb-editor-tool"
                :class="{ 'is-active': isActive(entry.action) }"
                aria-haspopup="menu"
                :aria-expanded="dropdownOpen === entry.action.id"
                :aria-label="dropdownAriaLabel(entry.action)"
                :title="dropdownFace(entry.action) ? `${entry.action.label}：${dropdownFace(entry.action)!.label}` : entry.action.label"
                :data-action="entry.action.id"
                @click="runAction(entry.action)"
                @keydown.esc="dropdownOpen = ''"
              >
                <!-- 显示光标处现在的样式（H2、引用…）；没有就是下拉自己的图标 -->
                <ToolIcon v-if="dropdownFace(entry.action)?.paths" :paths="dropdownFace(entry.action)!.paths!" />
                <span v-else-if="dropdownFace(entry.action)?.text" class="kb-editor-tool-face" aria-hidden="true">{{ dropdownFace(entry.action)!.text }}</span>
                <ToolIcon v-else-if="toolIcon(entry.action.id)" :paths="toolIcon(entry.action.id)!" />
                <span v-else-if="entry.action.icon" aria-hidden="true">{{ entry.action.icon }}</span>
                <ToolIcon class="kb-editor-caret" :paths="ICON_CARET" :size="10" />
              </button>
              <Transition name="kb-menu">
              <div v-if="dropdownOpen === entry.action.id" v-clamp-x class="kb-editor-chrome-menu is-left" role="menu" :aria-label="entry.action.label" :data-testid="`editor-dropdown-${entry.action.id}`" @keydown.esc="dropdownOpen = ''">
                <button
                  v-for="child in entry.action.children"
                  :key="child.id"
                  type="button"
                  :role="child.check ? 'menuitemradio' : 'menuitem'"
                  :aria-checked="child.check ? isActive(child) : undefined"
                  class="kb-editor-chrome-menu-item"
                  :class="{ 'is-active': isActive(child) }"
                  :data-action="child.id"
                  :aria-keyshortcuts="child.shortcut ? ariaShortcut(child.shortcut) : undefined"
                  @click="runAction(child)"
                >
                  <ToolIcon v-if="toolIcon(child.id)" class="kb-editor-chrome-menu-icon" :paths="toolIcon(child.id)!" />
                  <span v-else-if="child.icon" class="kb-editor-chrome-menu-icon" aria-hidden="true">{{ child.icon }}</span>
                  {{ child.label }}
                  <kbd v-if="child.shortcut" class="kb-editor-menu-kbd" aria-hidden="true">{{ shortcutLabel(child.shortcut) }}</kbd>
                </button>
              </div>
              </Transition>
            </div>
            <button
              v-else
              type="button"
              class="kb-editor-tool"
              :class="{ 'is-active': isActive(entry.action) }"
              :aria-label="entry.action.icon ? `${entry.action.icon} ${entry.action.label}` : entry.action.label"
              :aria-pressed="entry.action.check ? isActive(entry.action) : undefined"
              :aria-keyshortcuts="entry.action.shortcut ? ariaShortcut(entry.action.shortcut) : undefined"
              :disabled="!!unavailableReason(entry.action)"
              :title="actionTitle(entry.action)"
              :data-action="entry.action.id"
              :data-entry="entry.key"
              @click="runAction(entry.action)"
              @dblclick="runDouble(entry.action)"
            >
              <ToolIcon v-if="toolIcon(entry.action.id)" :paths="toolIcon(entry.action.id)!" />
              <span v-else-if="entry.action.icon" aria-hidden="true">{{ entry.action.icon }}</span>
              <template v-else>{{ entry.action.label }}</template>
            </button>
          </template>
        </template>
        <div v-if="overflowActions.length" class="kb-editor-chrome-menu-wrap" data-more>
          <button
            type="button"
            class="kb-editor-tool kb-editor-more"
            aria-haspopup="menu"
            :aria-expanded="moreOpen"
            aria-label="更多工具"
            title="更多工具"
            data-testid="editor-toolbar-more"
            @click="moreOpen = !moreOpen"
            @keydown.esc="moreOpen = false"
          >
            <ToolIcon :paths="ICON_MORE" />
          </button>
          <Transition name="kb-menu">
          <div v-if="moreOpen" v-clamp-x class="kb-editor-chrome-menu is-left" role="menu" aria-label="更多工具" data-testid="editor-toolbar-more-menu" @keydown.esc="moreOpen = false">
            <template v-for="action in overflowActions" :key="action.id">
              <!-- 带选项的动作（字体、字号、颜色…）在「更多」里只占一行，点开才列出选项：
                   全部平铺时手机上前八项都是字体，列表、任务这些常用项被挤到最后，Word 的字号更是十五项 -->
              <template v-if="action.choices">
                <button
                  type="button"
                  role="menuitem"
                  class="kb-editor-chrome-menu-item kb-editor-menu-group"
                  :aria-expanded="moreChoicesOpen === action.id"
                  :disabled="!!unavailableReason(action)"
                  :title="unavailableReason(action)"
                  :data-action="action.id"
                  @click="moreChoicesOpen = moreChoicesOpen === action.id ? '' : action.id"
                >
                  <ToolIcon v-if="toolIcon(action.id)" class="kb-editor-chrome-menu-icon" :paths="toolIcon(action.id)!" />
                  <span v-else-if="action.icon" class="kb-editor-chrome-menu-icon" aria-hidden="true">{{ action.icon }}</span>
                  {{ action.label }}
                  <span v-if="currentChoiceLabel(action)" class="kb-editor-menu-current">{{ currentChoiceLabel(action) }}</span>
                  <ToolIcon class="kb-editor-menu-chevron" :class="{ 'is-open': moreChoicesOpen === action.id, 'is-alone': !currentChoiceLabel(action) }" :paths="ICON_CARET" :size="10" />
                </button>
                <template v-if="moreChoicesOpen === action.id">
                  <button
                    v-for="choice in action.choices"
                    :key="`${action.id}:${choice.label}`"
                    type="button"
                    role="menuitem"
                    class="kb-editor-chrome-menu-item kb-editor-menu-sub"
                    :class="{ 'is-active': isCurrentChoice(choice) }"
                    :data-action="action.id"
                    :data-choice="choice.label"
                    @click="pickChoice(action, choice)"
                  >
                    <span v-if="choice.swatch" class="kb-editor-swatch" :style="{ background: choice.swatch }" aria-hidden="true"></span>
                    <span :style="choice.font ? { fontFamily: choice.font } : undefined">{{ choice.label }}</span>
                  </button>
                </template>
              </template>
              <button
                v-if="!action.choices"
                type="button"
                role="menuitem"
                class="kb-editor-chrome-menu-item"
                :class="{ 'is-active': isActive(action) }"
                :disabled="!!unavailableReason(action)"
                :title="unavailableReason(action)"
                :data-action="action.id"
                @click="runOverflowAction(action)"
              >
                <ToolIcon v-if="toolIcon(action.id)" class="kb-editor-chrome-menu-icon" :paths="toolIcon(action.id)!" />
                <span v-else-if="action.icon" class="kb-editor-chrome-menu-icon" aria-hidden="true">{{ action.icon }}</span>
                {{ action.label }}
                <kbd v-if="action.shortcut" class="kb-editor-menu-kbd" aria-hidden="true">{{ shortcutLabel(action.shortcut) }}</kbd>
              </button>
            </template>
          </div>
          </Transition>
          <Transition name="kb-menu">
            <ColorPanel
              v-if="isPopOpen('color', 'more')"
              v-clamp-x
              class="kb-editor-chrome-menu is-left kb-color-menu"
              :fg="colorFg"
              :bg="colorBg"
              @pick="pickColor"
            />
          </Transition>
          <Transition name="kb-menu">
            <TableGridPicker v-if="isPopOpen('table', 'more')" v-clamp-x class="kb-editor-chrome-menu is-left kb-color-menu" @pick="pickTable" />
          </Transition>
        </div>
        <slot name="toolbar" :can-write="canWrite" />
      </div>

      <div class="kb-editor-chrome-actions">
        <!-- 状态栏项（字数等）：手机压成一行时页头已有，收起 -->
        <span
          v-for="item in compactRow ? [] : statusItems"
          :key="item.extensionId + ':' + item.id"
          class="kb-editor-chrome-count"
          :title="item.title"
          :data-testid="`editor-chrome-${item.id}`"
        >{{ item.text }}</span>
        <button
          v-for="panel in panelsEnabled ? panels : []"
          :key="panel.key"
          type="button"
          class="btn sm"
          :class="{ 'is-on': isPanelOpen(panel) }"
          :aria-pressed="isPanelOpen(panel)"
          :aria-label="panel.icon ? `${panel.icon} ${panel.title}` : panel.title"
          :data-ext-panel-toggle="panel.key"
          @click="togglePanel(panel)"
        >
          <span v-if="panel.icon" aria-hidden="true">{{ panel.icon }}</span>
          {{ panel.title }}
        </button>
        <!-- 内置扩展 / 第三方扩展贡献的操作区按钮（导出、评论…） -->
        <button
          v-for="action in visibleBarActions"
          :key="action.id"
          type="button"
          class="btn sm"
          :aria-label="action.description ?? action.label"
          :data-bar-action="action.id"
          :data-testid="`editor-${action.id}`"
          @click="runBarAction(action)"
        >
          {{ action.label }}
        </button>
        <div v-if="showAiButton" class="kb-editor-chrome-menu-wrap">
          <button
            type="button"
            class="btn sm"
            aria-label="AI 改写"
            :aria-expanded="aiOpen"
            data-testid="editor-ai"
            @click="aiOpen = !aiOpen"
          >
            AI
          </button>
          <Transition name="kb-menu">
          <div v-if="aiOpen" class="kb-editor-chrome-menu" role="menu" data-testid="editor-ai-menu">
            <button
              v-for="tool in aiTools"
              :key="tool.id"
              type="button"
              role="menuitem"
              class="kb-editor-chrome-menu-item"
              :title="tool.description"
              :data-ai-tool="tool.id"
              @click="runAiTool(tool.id)"
            >
              {{ tool.title }}
            </button>
          </div>
          </Transition>
        </div>
        <!-- 撤销 / 重做：图标按钮，和工具栏同一套样式；文字放进 title / aria-label -->
        <button
          v-if="!readonly && permissions.write && !compactRow"
          type="button"
          class="kb-editor-tool"
          :disabled="!canWrite"
          aria-label="撤销"
          :title="`撤销（${shortcutLabel('Ctrl+Z')}）`"
          data-testid="editor-undo"
          @click="emit('undo')"
        >
          <ToolIcon :paths="ICON_UNDO" />
        </button>
        <button
          v-if="!readonly && permissions.write && !compactRow"
          type="button"
          class="kb-editor-tool"
          :disabled="!canWrite"
          aria-label="重做"
          :title="`重做（${shortcutLabel('Ctrl+Shift+Z')}）`"
          data-testid="editor-redo"
          @click="emit('redo')"
        >
          <ToolIcon :paths="ICON_REDO" />
        </button>
        <button
          v-if="showSave && !readonly && permissions.write && !collabState"
          type="button"
          class="btn sm pri"
          :disabled="!canSave"
          aria-label="保存文档"
          data-testid="editor-save"
          @click="emit('save')"
        >
          {{ phase === 'saving' ? '保存中…' : '保存' }}
        </button>
        <button
          v-if="showClose"
          type="button"
          class="btn sm"
          aria-label="关闭编辑器"
          data-testid="editor-close"
          @click="emit('close')"
        >
          {{ dirty ? '不保存，关闭' : '完成' }}
        </button>
      </div>
    </div>

    <!-- 链接输入（点击工具栏链接按钮出现） -->
    <FoldTransition :open="linkOpen">
    <div class="kb-editor-chrome-sub" data-testid="editor-link-bar" role="group" aria-label="插入链接">
      <input
        ref="linkInput"
        v-model="linkHref"
        class="kb-editor-chrome-input"
        type="text"
        inputmode="url"
        placeholder="https://… 或 ./相对路径"
        aria-label="链接地址"
        data-testid="editor-link-input"
        @keydown="onLinkKeydown"
      />
      <button type="button" class="btn sm pri" data-testid="editor-link-apply" @click="applyLink">确定</button>
      <!-- 光标在已有链接上：打开 / 复制 / 移除都在这里（以前是跟着光标飘的链接卡） -->
      <template v-if="linkExisting">
        <button type="button" class="btn sm" data-testid="editor-link-open" @click="openExistingLink">打开</button>
        <button type="button" class="btn sm" data-testid="editor-link-copy" @click="copyExistingLink">{{ linkCopied ? '已复制' : '复制地址' }}</button>
      </template>
      <button type="button" class="btn sm" data-testid="editor-link-remove" @click="removeLink">移除链接</button>
      <button type="button" class="btn sm" aria-label="取消插入链接" @click="linkOpen = false">取消</button>
    </div>
    </FoldTransition>

    <!-- 表格工具：光标在表格里时出现在工具栏下面（不再是跟着光标飘的浮动工具条），离开表格收起 -->
    <FoldTransition :open="showTableTools">
      <TableToolsBar @run="(type, args) => emit('command', type, args)" />
    </FoldTransition>

    <!-- 查找替换条：数字来自 Surface 的真实命中 -->
    <FoldTransition :open="findOpen">
    <div class="kb-editor-chrome-sub" data-testid="editor-find-bar" role="group" aria-label="查找替换">
      <input
        ref="findInput"
        v-model="findQuery"
        class="kb-editor-chrome-input"
        type="search"
        placeholder="查找"
        aria-label="查找内容"
        data-testid="editor-find-input"
        @input="emitFindQuery"
        @keydown="onFindKeydown"
      />
      <span class="kb-editor-chrome-hint" data-testid="editor-find-count">
        {{ findState?.total ? `${(findState?.index ?? 0) + 1}/${findState.total}` : '无匹配' }}
      </span>
      <button type="button" class="btn sm" aria-label="上一个匹配" data-testid="editor-find-prev" @click="emit('find-prev')">↑</button>
      <button type="button" class="btn sm" aria-label="下一个匹配" data-testid="editor-find-next" @click="emit('find-next')">↓</button>
      <button
        type="button"
        class="btn sm"
        :aria-expanded="replaceOpen"
        data-testid="editor-find-toggle-replace"
        @click="toggleReplace"
      >
        替换
      </button>
      <template v-if="replaceOpen">
        <input
          v-model="replaceText"
          class="kb-editor-chrome-input"
          type="text"
          placeholder="替换为"
          aria-label="替换为"
          data-testid="editor-find-replace-input"
        />
        <button type="button" class="btn sm" data-testid="editor-find-replace" @click="emit('find-replace', replaceText)">替换</button>
        <button type="button" class="btn sm" data-testid="editor-find-replace-all" @click="emit('find-replace-all', replaceText)">全部替换</button>
      </template>
      <button type="button" class="btn sm kb-ghost" aria-label="关闭查找" data-testid="editor-find-close" @click="closeFind">✕</button>
    </div>
    </FoldTransition>

    <!-- 大纲：来自 Surface 的 outline 查询，点击跳锚点 -->
    <Transition name="kb-menu">
    <div v-if="outlineOpen" class="kb-editor-chrome-outline" data-testid="editor-outline" role="group" aria-label="大纲">
      <div class="kb-editor-chrome-outline-head">
        <span>大纲</span>
        <button type="button" class="btn sm kb-ghost" aria-label="收起大纲" @click="outlineOpen = false">收起</button>
      </div>
      <p v-if="!hasOutline" class="kb-editor-chrome-hint">这篇文档还没有标题。</p>
      <button
        v-for="(item, index) in outline"
        :key="`${index}-${item.anchor.kind === 'text' ? item.anchor.block : index}`"
        type="button"
        class="kb-editor-outline-item"
        :class="`is-h${item.level}`"
        :title="item.text"
        @click="jumpOutline(item.anchor)"
      >
        {{ item.text }}
      </button>
    </div>
    </Transition>

    <!-- 快捷键一览（Ctrl+/）：浮在工具栏右下方，不把正文往下推 -->
    <Transition name="kb-menu">
      <ShortcutsPanel v-if="shortcutsOpen" :sections="shortcutSections" @close="shortcutsOpen = false" />
    </Transition>

    <!-- 扩展面板停靠区：与大纲同层级，互不影响 -->
    <ExtensionPanel v-for="panel in panelsEnabled ? dockedPanels : []" :key="panel.key" :panel="panel" :mount="props.mountPanel!" @close="togglePanel(panel)" />

    <!-- AI 写作条（UI-3）：工具栏下面的二级条；结果点了「替换 / 插入」才写进文档 -->
    <FoldTransition :open="!!aiWriter">
      <AiWriteBar
        v-if="aiWriter"
        ref="aiBar"
        :state="aiWriter"
        @run="(action, instruction) => emit('ai-write-run', action, instruction)"
        @apply="(mode) => emit('ai-write-apply', mode)"
        @close="emit('ai-write-close')"
      />
    </FoldTransition>

    <!-- 扩展 AI 工具的建议：接受后才写回文档 -->
    <FoldTransition :open="!!aiSuggestion">
    <div v-if="aiSuggestion" class="kb-editor-chrome-sub kb-editor-ai-suggestion" role="group" aria-label="AI 工具建议" data-testid="editor-ai-suggestion">
      <span class="kb-editor-chrome-hint">{{ aiSuggestion.title }}</span>
      <span v-if="aiSuggestion.status === 'running'" class="kb-editor-chrome-hint" role="status">正在生成…</span>
      <p v-else-if="aiSuggestion.status === 'error'" class="kb-editor-ai-text" role="alert" data-testid="editor-ai-suggestion-error">{{ aiSuggestion.error }}</p>
      <template v-else>
        <pre class="kb-editor-ai-text" data-testid="editor-ai-suggestion-text">{{ aiSuggestion.text }}</pre>
        <span v-if="aiSuggestion.note" class="kb-editor-chrome-hint">{{ aiSuggestion.note }}</span>
        <button v-if="permissions.write && !readonly" type="button" class="btn sm pri" data-testid="editor-ai-suggestion-accept" @click="emit('ai-tool-accept')">接受</button>
      </template>
      <button type="button" class="btn sm" data-testid="editor-ai-suggestion-reject" @click="emit('ai-tool-reject')">{{ aiSuggestion.status === 'ready' ? '拒绝' : '关闭' }}</button>
    </div>
    </FoldTransition>

    <!-- 图片选择：真正的上传交给 Host / 页面，Chrome 只负责挑文件 -->
    <input
      ref="fileInput"
      class="kb-editor-chrome-file"
      type="file"
      accept="image/*"
      tabindex="-1"
      aria-hidden="true"
      data-testid="editor-image-input"
      @change="onImagePicked"
    />
  </header>
</template>

<style>
/* 色板（字色 / 底色）：色块的颜色来自 styles/kbColor.css 的 .kb-color.is-fg-* / is-bg-* */
.kb-editor-swatch {
  width: 26px;
  height: 26px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  font-weight: 700;
  background: transparent;
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r1);
  cursor: pointer;
}
.kb-editor-swatch:hover {
  border-color: var(--accent);
}
.kb-editor-swatch.is-none {
  color: var(--text-secondary);
}
/* 颜色按钮：A 下面一条当前字色的小横线（没设过就是灰的） */
.kb-color-btn {
  position: relative;
}
.kb-color-bar {
  position: absolute;
  left: 50%;
  bottom: 6px;
  width: 14px;
  height: 3px;
  border-radius: 2px;
  background: currentColor;
  color: var(--text-tertiary);
  transform: translateX(-50%);
  pointer-events: none;
}
.kb-color-menu {
  padding: 0;
  min-width: 0;
  width: max-content;
}
/* 下拉菜单项右侧的快捷键 */
.kb-editor-menu-kbd {
  margin-left: auto;
  padding-left: 16px;
  color: var(--text-tertiary);
  font-family: var(--font-sans);
  font-size: calc(12px * var(--fs));
  white-space: nowrap;
}
/* 手机 / 平板触屏没有键盘可按，快捷键提示只占地方（术语表：手机上不显示快捷键提示） */
@media (pointer: coarse) {
  .kb-editor-menu-kbd {
    display: none;
  }
}
/* 「更多」里带选项的动作：一行显示名字和当前值，点开在下面列出选项 */
.kb-editor-menu-current {
  margin-left: auto;
  padding-left: 12px;
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
  white-space: nowrap;
}
.kb-editor-menu-chevron {
  flex: 0 0 auto;
  margin-left: 6px;
  color: var(--text-tertiary);
  transition: transform var(--dur-fast) var(--ease-out);
}
/* 没有当前值可显示时箭头自己靠右（不用 :has，见 SHELL.md 新特性兜底） */
.kb-editor-menu-chevron.is-alone {
  margin-left: auto;
}
.kb-editor-menu-chevron.is-open {
  transform: rotate(180deg);
}
.kb-editor-menu-sub {
  padding-left: 36px;
}
/* 下拉按钮显示的当前样式（H1–H6 这种文字图标）：占和 16px 图标一样的宽度，按钮宽度不跟着变 */
.kb-editor-tool-face {
  display: inline-block;
  min-width: 16px;
  /* 这是文字（「H2」），按正文的对比度要求（≥4.5:1）取次要文字色；按钮本身的弱化色只够图标用的 3:1 */
  color: var(--text-secondary);
  font-size: calc(12px * var(--fs));
  /* 设计规范：全站字重只用到 600 */
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  letter-spacing: -0.02em;
}
.kb-editor-tool.is-active .kb-editor-tool-face {
  color: var(--accent-text);
}
.kb-editor-chrome {
  /* 快捷键一览等浮层相对外壳定位（文档页里外壳是吸顶的 sticky，同样是定位元素） */
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 8px;
  background: var(--surface-1);
  border-bottom: var(--hl) solid var(--border-subtle);
}
.kb-editor-chrome-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
/* 工具栏放到第二行：状态在左、动作在右的第一行不变 */
.kb-editor-chrome.is-stacked .kb-editor-chrome-tools {
  order: 3;
  flex: 1 0 100%;
}
/* ======== 工具栏贴键盘上沿（手机，键盘打开时；） ======== */
/* 键盘占用高度 --kbd-inset 由 useVisualViewport 写：iOS 上布局视口不变，fixed 元素要自己抬高；Android 上布局视口跟着缩，值是 0 */
.kb-editor-chrome.is-docked .kb-editor-chrome-tools {
  position: fixed;
  left: 0;
  right: 0;
  bottom: var(--kbd-inset, 0px);
  z-index: 40;
  order: 0;
  box-sizing: border-box;
  padding: 2px max(8px, var(--safe-right, 0px)) 2px max(8px, var(--safe-left, 0px));
  background: var(--surface-1);
  border-top: var(--hl) solid var(--border-subtle);
}
.kb-editor-chrome-spacer {
  order: 3;
  flex: 1 0 100%;
}
/* 贴键盘时下拉菜单往上展开，太高就在菜单内部滚 */
.kb-editor-chrome.is-docked .kb-editor-chrome-menu {
  top: auto;
  bottom: calc(100% + 4px);
  max-height: calc(100vh - var(--kbd-inset, 0px) - var(--kbd-bar, 0px) - 16px);
  max-height: calc(100dvh - var(--kbd-inset, 0px) - var(--kbd-bar, 0px) - 16px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.kb-editor-chrome.is-compact .kb-editor-chrome-meta {
  display: none;
}
.kb-editor-chrome.is-compact .kb-editor-chrome-actions:empty {
  display: none;
}
.kb-editor-chrome-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.kb-editor-chrome-badge {
  padding: 1px 6px;
  border-radius: var(--r1);
  background: var(--surface-sunken);
  color: var(--text-secondary);
  font-size: calc(11px * var(--fs));
  line-height: 1.6;
  white-space: nowrap;
}
.kb-editor-chrome-title {
  color: var(--text-primary);
  font-size: calc(13px * var(--fs));
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}
.kb-editor-chrome-status,
.kb-editor-chrome-rev {
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
  white-space: nowrap;
}
.kb-editor-chrome-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  /* 放不下的按钮收进「更多」，不再横向滚动（滚动条细得看不见，用户不知道后面还有按钮）；
     菜单要能溢出到工具栏外面，所以不能 overflow: hidden */
  overflow: visible;
}
.kb-editor-more {
  white-space: nowrap;
}
.kb-editor-chrome-menu.is-left {
  left: 0;
  right: auto;
}
/* 菜单从触发它的按钮那一侧长出来（进场动画见 kb-ui motion-ui.css 的 .kb-menu-*）：右对齐的 AI 菜单从右上，贴键盘时从下方 */
.kb-editor-chrome-menu:not(.is-left) {
  --origin: top right;
}
.kb-editor-chrome.is-docked .kb-editor-chrome-menu {
  --origin: bottom left;
}
.kb-editor-chrome-outline {
  --origin: top right;
}
.kb-editor-chrome-menu-item.is-active {
  color: var(--accent);
  background: var(--accent-soft);
}
/* 菜单项前的图标：SVG 与退回的短字符占同一宽度，文字才能竖直对齐 */
.kb-editor-chrome-menu-icon {
  flex: 0 0 16px;
  display: inline-grid;
  place-items: center;
  min-width: 16px;
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
}
.kb-editor-chrome-menu-item.is-active .kb-editor-chrome-menu-icon {
  color: var(--accent);
}
/* 分组竖线：只画中间 16px，满高的线在 32px 的按钮旁边太重。
   两侧留白算在元素自身宽度里（13px 宽、线画在正中），不用 margin：
   收进「更多」的计算量的是 offsetWidth，不含 margin，用 margin 会少算、多留一颗按钮把「更多」挤出工具栏 */
.kb-editor-chrome-sep {
  flex: 0 0 9px;
  align-self: center;
  height: 16px;
  background: linear-gradient(var(--border-default), var(--border-default)) center / var(--hl) 100% no-repeat;
}
.kb-editor-tool {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 1px;
  min-width: 30px;
  /* 桌面 32px 高：比旧版 30px 多 2px 呼吸，宽度仍由 min-width 30 定住，工具栏一行放得下 */
  height: 32px;
  padding: 0 6px;
  /* 不画边框（激活态也只用底色）：省下的 2px × 十几颗按钮，正好让 1440 宽、开着列表和目录时工具栏仍一行放下 */
  border: 0;
  border-radius: var(--r1);
  background: transparent;
  color: var(--text-secondary);
  font-size: calc(13px * var(--fs));
  line-height: 1;
  cursor: pointer;
  /* 和项目的 .btn 同一手感：悬停 / 激活变色，按下缩一点点再弹回（--press-scale 随动效档位变，「减少」档为 1） */
  transition:
    transform var(--dur-instant) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.kb-editor-tool:active:not(:disabled) {
  transform: scale(var(--press-scale, 0.97));
}
.kb-tool-icon {
  display: block;
  flex: none;
}
/* 下拉箭头：小一号、淡一点，按钮右侧收窄，看起来是一个整体而不是「图标 + 字符」 */
.kb-editor-tool .kb-editor-caret {
  opacity: 0.6;
}
.kb-editor-tool:has(.kb-editor-caret) {
  padding-right: 4px;
}
@media (pointer: coarse) {
  /* 触屏：工具按钮与「更多」的可点区域 ≥44px */
  .kb-editor-tool {
    min-width: 44px;
    height: 44px;
  }
}
.kb-editor-tool:hover:not(:disabled) {
  background: var(--surface-sunken);
  color: var(--text-primary);
}
/* 激活态：浅强调底 + 强调色图标，不再画描边框（描边在一排按钮里像被选中的输入框） */
.kb-editor-tool.is-active {
  background: var(--accent-soft);
  color: var(--accent);
}
.kb-editor-tool:focus-visible,
.kb-editor-chrome-actions .btn:focus-visible,
.kb-editor-outline-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.kb-editor-chrome-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  flex-wrap: wrap;
}
/* 操作区的文字按钮（导出 / AI / 扩展面板 / 完成）和工具按钮同一个重量：无边框，悬停才出底色；主按钮（保存）不动 */
.kb-editor-chrome-actions .btn:not(.pri) {
  height: 32px;
  padding: 0 10px;
  border-color: transparent;
  background: transparent;
  color: var(--text-secondary);
  box-shadow: none;
}
.kb-editor-chrome-actions .btn:not(.pri):hover:not(:disabled) {
  background: var(--surface-sunken);
  color: var(--text-primary);
}
.kb-editor-chrome-count {
  padding: 0 8px;
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.kb-editor-chrome-sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 0 2px;
  border-top: var(--hl) solid var(--border-subtle);
}
.kb-editor-chrome-input {
  flex: 1 1 160px;
  min-width: 120px;
  height: 28px;
  padding: 0 8px;
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r1);
  background: var(--surface-sunken);
  color: var(--text-primary);
  font-size: calc(13px * var(--fs));
}
.kb-editor-chrome-hint {
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
  white-space: nowrap;
}
.kb-editor-chrome-outline {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow: auto;
  padding: 4px 0 2px;
  border-top: var(--hl) dashed var(--border-default);
}
.kb-editor-chrome-outline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
}
.kb-editor-outline-item {
  padding: 4px 8px;
  border: 0;
  border-radius: var(--r1);
  background: transparent;
  color: var(--text-secondary);
  font-size: calc(13px * var(--fs));
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-editor-outline-item {
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.kb-editor-outline-item:hover {
  background: var(--surface-sunken);
}
.kb-editor-outline-item.is-h1 {
  font-weight: 600;
  padding-left: 8px;
}
.kb-editor-outline-item.is-h2 {
  padding-left: 20px;
}
.kb-editor-outline-item.is-h3 {
  padding-left: 32px;
}
.kb-editor-outline-item.is-h4 {
  padding-left: 44px;
}
.kb-editor-chrome-menu-wrap {
  position: relative;
}
.kb-editor-chrome-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 70;
  min-width: 176px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--surface-3);
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r2);
  box-shadow: var(--sh3);
}
.kb-editor-chrome-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r1);
  background: transparent;
  color: var(--text-primary);
  font-size: calc(13px * var(--fs));
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
/* 触屏：下拉 / 「更多」菜单里的项也 ≥44px。必须写在上面这条基础规则之后——同样的选择器，后写的赢，
   写在前面会被 30px 盖掉（手机上菜单项只有 30px 高） */
@media (pointer: coarse) {
  .kb-editor-chrome-menu-item {
    min-height: 44px;
  }
}
.kb-editor-chrome-menu-item {
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.kb-editor-chrome-menu-item:hover:not(:disabled) {
  background: var(--surface-sunken);
}
.kb-editor-chrome-menu-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.kb-editor-ai-text {
  flex: 1 1 100%;
  margin: 0;
  max-height: 140px;
  overflow: auto;
  white-space: pre-wrap;
  color: var(--text-primary);
  font: inherit;
  font-size: calc(13px * var(--fs));
}
.kb-editor-chrome-actions .btn.is-on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.kb-editor-chrome-file {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
/* 选项菜单里的小色块（字色 / 底色的 choices）；色板条里的按钮是 26px，见文件开头那条，这里限定在菜单项内，免得互相覆盖 */
.kb-editor-chrome-menu-item .kb-editor-swatch {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  margin-right: 0;
  border: var(--hl) solid var(--border-subtle);
  border-radius: 2px;
}
.kb-editor-tool:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
