<script setup lang="ts">
import FoldTransition from '@/components/FoldTransition.vue'
import { mergeStableOrder } from '@/utils/stableOrder'
import { clockText, dateTimeText, daysAgo, isToday, localeDateTime, monthDayText, stampText } from '@/utils/time'
// 浏览器 / 编辑器(浏览器编辑器设计稿): 双栏工作台 极简可拖拽双栏工作台 (类似 VS Code / Obsidian)。
// 左侧导航栏与右侧工作区分界线支持鼠标拖拽随意调宽窄；支持一键收起目录栏 (⌘\)；
// 右侧工作区享受超大宽屏阅读与编辑空间；元数据与分块按需展开为右侧抽屉；支持无缝切换至全量数据表格视图。
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import FileViewer from '@/components/FileViewer.vue'
import { wikilinkIds, type QuoteItem } from '@/editor/surfaces/text/docPlugins'
import { isNoteLinkId } from '@/utils/links'
import type { QuoteAnchor } from '@/utils/quoteAnchor'
import { displayName, downloadUrl as fileDownloadUrl, rawUrl as fileRawUrl } from '@/utils/attachments'
import { scrollToFragment, type LinkContext } from '@/utils/links'
import { useDocLinks } from '@/composables/useDocLinks'
import { noteTargetIds, splitRelations, type DocLinksReply, type DocRelation } from '@/utils/docRelations'
import { INLINE_FORMATS, anchorText, canEditAsMarkdown, copyEditNotice, extractorLabel, fileChip, fileLayers, markdownCopyPath } from '@/utils/files'
import { blocksByPage, chunkPositionLabel, fileCountLabel, previewNotice, srtForFile } from '@/utils/preview'
import {
  KbSubmitButton,
  KbBadge,
  KbBatchBar,
  KbButton,
  KbCard,
  KbChain,
  KbDataTable,
  KbDialog,
  KbEmpty,
  KbFilterBar,
  KbIcon,
  KbInput,
  KbPager,
  KbSegmented,
  KbSelect,
  KbSkeleton,
  KbTabs,
  KbTagEditor,
  KbTreeRow,
  useConfirm,
  useLongPress,
  useToast,
  type ChainEvent,
  type Column,
  type FilterChip,
  type PreviewAnchor,
  type PreviewBlock,
  type PreviewChunk,
  type TabItem,
  isComposing,
} from '@kb-ui/index'
import {
  CapabilityError,
  type CollectionStats,
  type ItemDetail,
  type ItemList,
  type ItemSummary,
  type RecordRow,
} from '@/api/client'
import { useShellStore } from '@/stores/shell'
import { useNavStore } from '@/stores/nav'
import { useViewport } from '@/composables/useViewport'
import InAppDownloadNote from '@/components/InAppDownloadNote.vue'
import FileActionMenu from '@/components/fileops/FileActionMenu.vue'
import RowActionMenu, { type RowMenuState } from '@/components/fileops/RowActionMenu.vue'
import FileActionSheet from '@/components/fileops/FileActionSheet.vue'
import FileDeleteDialog from '@/components/fileops/FileDeleteDialog.vue'
import FileMoveDialog from '@/components/fileops/FileMoveDialog.vue'
import { useFileActions } from '@/composables/useFileActions'
import type { FileTarget } from '@/components/fileops/types'
import { isInAppBrowser } from '@/utils/inApp'
import { carryPaneState, inspectorDefaultOpen, inspectorDocks, workbenchLayout } from '@/utils/workbenchLayout'
import { useFeature, useFeatures } from '@/composables/useFeature'
import { extensionSourceOf, saveTextOf, useExtensionFormat } from '@/composables/useExtensionFormat'
import { useQueryHighlight } from '@/composables/useQueryHighlight'
import { queryTerms } from '@/utils/queryTerms'
import { failureOf, type Failure } from '@/utils/loadState'
import { KIND_TEXT } from '@/utils/review'
import DocComments from '@/components/share/DocComments.vue'
import CollabBar from '@/components/CollabBar.vue'
import VersionHistory from '@/components/VersionHistory.vue'
import VersionDiff from '@/components/VersionDiff.vue'
import CollabAvatars from '@/components/CollabAvatars.vue'
import type { EditorOpenRequest, SaveResult } from '@/editor/types'
// 不 import 引擎、只有一个资源地址的小模块：悬停「在线编辑」时同步发起 WASM 下载（见 warmWordEditor）
import { prefetchDocxWasm } from '@/editor/engines/docxWasm'
import { createCsvRemoteBackend } from '@/utils/csvRemoteBackend'
import type { SessionTransport } from '@/editor/session'
import type { CollabProvider } from '@/collab/provider'
import type { DocRefInput } from '@/collab/resourceKey'
import { useCollabKey } from '@/collab/useCollabKey'
import { bestCovering } from '@/utils/shareKey'
import { ownAccess } from '@/api/share'
import { useSessionStore } from '@/stores/session'
import type { ShareTarget, SharedWithMeItem } from '@/api/share'
import { useViewCall } from '@/composables/useViewCall'
import { targetKey } from '@/utils/share'
import { hasResumableDraft, loadDraft, scopedDraftId, clearDraft } from '@/utils/docText'
import { MAX_SELECTION, pick, selectAll, type SelectionState } from '@/utils/selection'
import { useSharedWithMe } from '@/composables/useSharedWithMe'
import SharedSidebar from '@/components/share/SharedSidebar.vue'
import { PATHS } from '@/router/paths'

/**
 * 管理员只读查看(`embedded`)时复用本页:
 * - 不挂 AppShell,由弹窗提供标题与页签;
 * - 不读写 URL、不恢复本机草稿、不显示任何写入口;
 * - 所有能力调用带上目标用户(`viewAs`),后端按只读白名单放行。
 */
const props = withDefaults(
  defineProps<{
    embedded?: boolean
    readonly?: boolean
    /** 目标用户 id(`usr_…`);普通页面不传。 */
    viewAs?: string
    /** 嵌入时的初始集合;不传就选第一个有内容的集合。 */
    initialCollection?: string
  }>(),
  { embedded: false, readonly: false, viewAs: '', initialCollection: '' },
)
const callCapability = useViewCall(() => props.viewAs)

// 编辑器内核都很大,只在编辑时才加载
const CodeEditor = defineAsyncComponent(() => import('@/components/CodeEditor.vue'))
/** 语雀式文档页(所见即所得编辑 + 阅读 + 目录):经验条目与 Markdown 文件共用 */
const DocPage = defineAsyncComponent(() => import('@/components/DocPage.vue'))
/** 统一编辑器外壳：代码 / 配置 / 文本文件与 CSV·TSV 表格的编辑都走它 */
const EditorHost = defineAsyncComponent(() => import('@/editor/host/EditorHost.vue'))
const OfficeEditor = defineAsyncComponent(() => import('@/components/OfficeEditor.vue'))
const EditProposals = defineAsyncComponent(() => import('@/components/EditProposals.vue'))
type DocPageApi = {
  saved: (force?: boolean) => void
  /** 把此刻的改动存进本机草稿:true 安全;false 存不进去或还压着一份没处理的旧草稿;null 这个文档没有草稿功能 */
  persistDraft: () => boolean | null
  /** 撤回这次编辑:标题 / 正文 / 标签回到服务器上保存的那一版,并清掉本机草稿 */
  revertToSaved: () => void
  /** 新外壳走命令总线，所以可能是 Promise */
  scrollToQuote: (id: string) => boolean | Promise<boolean>
  focus: () => void
  flush: () => string | undefined
  /** 新编辑器（`?editor=next`）的异步 flush：保存前 await，拿到最新正文 */
  flushAsync?: () => Promise<string | undefined>
  openFind: () => void
  /** 编辑器的快捷键一览（Ctrl+/） */
  openShortcuts: () => void
  exportMarkdown: () => void
  copyMarkdown: () => Promise<boolean>
  print: () => void
  toggleFullWidth: () => void
  /** 打开编辑器里的 AI 写作条（UI-3） */
  openAi?: () => void
  /** 在正文里找到一段原文（AI 修改建议的「在正文里找到」） */
  locateText?: (text: string) => Promise<boolean>
}
const docPage = ref<DocPageApi | null>(null)
/**
 * 顶栏的「AI 写作」按钮：编辑笔记 / Markdown 文件时、账号有 AI 助手（已含 AI 总开关）才显示。
 * 它不放进编辑器工具栏：1366 宽起工具栏只剩约 30px，再加一颗会把「大纲」挤进「更多」
 */
const canAiWriteHere = useFeature('ai.assistant')
const aiWriteButton = computed(() => !props.readonly && canAiWriteHere.value && ((isInsight.value && editExpanded.value) || (fileEditing.value && isMarkdownFile.value)))
/** 分享面板(协作者 + 链接):只在点「分享」时才加载 */
const SharePanel = defineAsyncComponent(() => import('@/components/share/SharePanel.vue'))
/** 打开别人分享给我的内容(阅读 / 编辑 / 评论 / 申请权限):只在切到「共享给我」时才加载 */
const SharedWorkspace = defineAsyncComponent(() => import('@/components/share/SharedWorkspace.vue'))

const route = useRoute()
const router = useRouter()
const toast = useToast()
const confirmer = useConfirm()
const shell = useShellStore()

/* ------------------------------------------------------------------ 状态 */
const collections = ref<CollectionStats[]>([])
const collection = ref('')
const kind = ref('')
/** insight 子类型(decision / pitfall …),需要后端 item_facets 能力;没有时整个功能隐藏 */
const insightKind = ref('')
const status = ref('active')
const tag = ref('')
const dir = ref('')
const q = ref('')
const filterText = ref('')
const sort = ref('updated_at:desc')
const page = ref(1)
const pageSize = ref(props.embedded ? 16 : (Number(localStorage.getItem('kb.browser.pageSize')) || 16))
const list = ref<ItemList | null>(null)
const listLoading = ref(false)
const kindCounts = ref<Record<string, number>>({})
interface Facet {
  kind: string
  count: number
  dirs?: { dir: string; count: number }[]
}
const facets = ref<Facet[] | null>(null)
/** 全部目录前缀(含多级),移动弹窗的下拉用;旧后端没有这个字段时退回分类里的一级目录。 */
const facetDirs = ref<string[]>([])
const facetOpen = ref<Record<string, boolean>>({})
/** 目录树的分类数据(类型计数 + 分面)正在读取:展开的集合下面显示占位,而不是一片空白 */
const treeLoading = ref(false)
const RECORD_KINDS = ['insight', 'code', 'doc', 'external', 'summary']
const expanded = ref<Record<string, boolean>>({})

const selected = ref<ItemDetail | null>(null)
const selectedId = ref<string | null>(null)
const detailLoading = ref(false)
const history = ref<{ id: string; title: string; version: number; status: string; at?: number; note?: string }[]>([])
const tab = ref('content')
// 切到「历史版本」页签时重新取一次:协作保存点是服务端异步落的,列表可能还差最后一条
watch(tab, (value) => {
  if (value === 'chain') void loadVersions()
})
const showRendered = ref(true)
const creating = ref(false)
const newTitle = ref('')
const newBody = ref('')
const newKind = ref('note')
const newTags = ref<string[]>([])
const error = ref('')
/**
 * 读取失败的三处各记一份(两句话:发生了什么 + 怎么办),和保存等操作失败用的 `error` 分开:
 * 以前列表 / 打开文档 / 读原件失败都只是静默清空,界面上和「没有内容」「什么都没选」一模一样,用户不知道出了错,也没有重试。
 */
const listFailure = ref<Failure | null>(null)
const detailFailure = ref<Failure | null>(null)
const previewFailure = ref<Failure | null>(null)
const saving = ref(false)
const savedAt = ref(0)

/* ------------------------------------------------------------------ 双栏工作台: 视窗模式与可拖拽侧边栏 */
// 视图模式: 'dual' (双栏工作台, 默认) | 'table' (全量数据表格)
// 弹窗里默认工作台:不继承管理员自己的表格偏好,否则一打开就是「没有返回入口」的表格
const viewMode = ref<'dual' | 'table'>(props.embedded ? 'dual' : ((localStorage.getItem('kb.browser.viewMode') as 'dual' | 'table') || 'dual'))
function setViewMode(mode: 'dual' | 'table') {
  viewMode.value = mode
  if (!props.embedded) localStorage.setItem('kb.browser.viewMode', mode)
}

// 侧边栏宽度与折叠状态
const DEFAULT_SIDEBAR_WIDTH = 280
const MIN_SIDEBAR_WIDTH = 190
const MAX_SIDEBAR_WIDTH = 560
const sidebarWidth = ref(props.embedded ? DEFAULT_SIDEBAR_WIDTH : (Number(localStorage.getItem('kb.browser.sidebarW')) || DEFAULT_SIDEBAR_WIDTH))
/* 目录栏窄(<320)时顶栏那行放不下:集合名只剩个图标、「新建」抢走大半宽度、搜索框占位符被切成半截字。
 * 按「目录栏自己的宽度」而不是窗口宽度判(目录栏可拖,窗口宽也不代表目录栏宽) */
const sidebarTight = computed(() => sidebarWidth.value < 320)
const sidebarCollapsed = ref(!props.embedded && localStorage.getItem('kb.browser.sidebarCollapsed') === '1')

/* 版面按「可用宽度」分三种(utils/workbenchLayout.ts):
 *   single <600:列表 / 文档整屏二选一,文档里有「返回列表」;
 *   two 600–839:目录栏 + 文档两栏,目录栏可收起,选中文档后自动收起;
 *   full ≥840:目录栏 + 文档(+ 右侧栏)。
 * 窗口大小变化(旋转、分屏、拖窗口)时实时切换;文档组件一直挂着,所以正在看 / 编辑的内容不会丢。 */
const viewport = useViewport()
const layout = computed(() => workbenchLayout(viewport.width.value))
/** 单栏(手机):沿用旧名,模板和样式里的 narrow 都指这一种 */
const narrow = computed(() => layout.value === 'single')
const twoPane = computed(() => layout.value === 'two')
const mobileDetail = ref(false)
/** 两栏版面下目录栏是否收起;只在本次会话里有效,不写进宽屏版面记住的 sidebarCollapsed */
const foldCollapsed = ref(false)
/** 目录栏现在是否被收起(单栏版面里列表本身就是一屏,不存在收起) */
const sidebarHidden = computed(() => (narrow.value ? false : twoPane.value ? foldCollapsed.value : sidebarCollapsed.value))
// 告诉外壳:单栏已进入文档详情、或两栏版面(自带文档顶栏)时,全局顶栏让位给文档自己的顶栏(单栏的列表页仍保留全局顶栏)
const navStore = useNavStore()
watch(
  [mobileDetail, layout],
  () => (navStore.workbenchDetail = layout.value === 'two' || (layout.value === 'single' && mobileDetail.value)),
  { immediate: true },
)
onBeforeUnmount(() => (navStore.workbenchDetail = false))
/** 是否有正在看的文档(含新建中和共享的文档) */
const docOpen = computed(() => !!(selectedId.value || creating.value || sharedActive.value))
watch(layout, (next, prev) => {
  const carried = carryPaneState(prev, next, {
    mobileDetail: mobileDetail.value,
    foldCollapsed: foldCollapsed.value,
    hasDoc: docOpen.value,
    sidebarCollapsed: sidebarCollapsed.value,
  })
  mobileDetail.value = carried.mobileDetail
  foldCollapsed.value = carried.foldCollapsed
})
/** 进入一篇文档:单栏切到文档屏;两栏收起目录栏,把宽度让给阅读(只在换了文档时,保存后的重新加载不动版面) */
function enterDoc(changed = true) {
  mobileDetail.value = true
  if (twoPane.value && changed) foldCollapsed.value = true
}
/** 回到目录 / 列表:单栏回到列表屏,两栏展开目录栏 */
function showList() {
  mobileDetail.value = false
  if (twoPane.value) foldCollapsed.value = false
}
function backToList() {
  showList()
}

function toggleSidebar() {
  if (narrow.value) {
    mobileDetail.value = !mobileDetail.value
    return
  }
  if (twoPane.value) {
    foldCollapsed.value = !foldCollapsed.value
    return
  }
  sidebarCollapsed.value = !sidebarCollapsed.value
  if (!props.embedded) localStorage.setItem('kb.browser.sidebarCollapsed', sidebarCollapsed.value ? '1' : '0')
}

// 拖拽调整侧边栏宽度
const isDragging = ref(false)
let dragStartX = 0
let dragStartWidth = 0

function onResizerMouseDown(e: MouseEvent) {
  isDragging.value = true
  dragStartX = e.clientX
  dragStartWidth = sidebarWidth.value
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  window.addEventListener('mousemove', onResizerMouseMove)
  window.addEventListener('mouseup', onResizerMouseUp)
}

function onResizerMouseMove(e: MouseEvent) {
  if (!isDragging.value) return
  const delta = e.clientX - dragStartX
  const nextWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, dragStartWidth + delta))
  sidebarWidth.value = nextWidth
}

function onResizerMouseUp() {
  if (!isDragging.value) return
  isDragging.value = false
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  window.removeEventListener('mousemove', onResizerMouseMove)
  window.removeEventListener('mouseup', onResizerMouseUp)
  if (!props.embedded) localStorage.setItem('kb.browser.sidebarW', String(sidebarWidth.value))
}

// 侧边栏内导航切换: 'files' (当前条目列表) | 'tree' (集合与分类目录)
const sidebarTab = ref<'files' | 'tree'>('files')
/**
 * 左侧「列表 / 目录」两个页签共用的滚动容器（同一时间只渲染一个）。
 * 切页签会把另一个销毁重建，滚动位置跟着丢（列表滚到一半，切去目录再回来又回到最顶上）：
 * 切走前记下各自的位置，切回来后放回去。结果集变了（翻页 / 换筛选）才回到顶部，见 resetListScroll
 */
const sidebarBody = ref<HTMLElement | null>(null)
const tabScroll = { files: 0, tree: 0 }
watch(sidebarTab, async (now, was) => {
  // 默认 flush: pre，这时旧页签的容器还在
  if (sidebarBody.value) tabScroll[was] = sidebarBody.value.scrollTop
  await nextTick()
  if (sidebarBody.value) sidebarBody.value.scrollTop = tabScroll[now]
})
/** 列表换了一批结果（翻页 / 换筛选）：新的一批从头看，不要停在上一批滚到的位置 */
function resetListScroll() {
  tabScroll.files = 0
  if (sidebarTab.value === 'files' && sidebarBody.value) sidebarBody.value.scrollTop = 0
}

// 右侧栏 (Inspector panel:属性 / 评论 / 分块 / 历史)
// ≥1024 并排成一栏(平板横屏和小笔记本就是「目录 | 文档 | 右侧栏」三栏),更窄时盖在文档上。
//   inspectorPref:用户点按钮明确选过的开合,记住;null = 没选过,按版面给默认(平板档默认展开)
//   inspectorTemp:本次会话临时的开合(Esc 收起、通知深链打开),优先于记住的值但不写盘
const storedInspector = props.embedded ? null : localStorage.getItem('kb.browser.inspectorOpen')
const inspectorPref = ref<boolean | null>(storedInspector === '1' ? true : storedInspector === '0' ? false : null)
const inspectorTemp = ref<boolean | null>(null)
const inspectorDocked = computed(() => inspectorDocks(viewport.width.value))
const inspectorOpen = computed(() => {
  // 浮层只在明确打开时出现:记住的「展开」不能让它一进来就盖住文档
  if (!inspectorDocked.value) return inspectorTemp.value === true
  return inspectorTemp.value ?? inspectorPref.value ?? inspectorDefaultOpen(viewport.width.value)
})
function toggleInspector() {
  const next = !inspectorOpen.value
  if (!inspectorDocked.value) {
    inspectorTemp.value = next
    return
  }
  inspectorTemp.value = null
  inspectorPref.value = next
  if (!props.embedded) localStorage.setItem('kb.browser.inspectorOpen', next ? '1' : '0')
}

// 微信 / QQ 内置浏览器里下载会被拦住、点了没反应:先弹一个说明(怎么在浏览器里打开 + 复制链接),
// 但留一个「仍然尝试下载」,安卓的一些内置浏览器其实能下,不能替用户断定下不了
const inAppBrowser = typeof navigator !== 'undefined' && isInAppBrowser(navigator.userAgent)
const inAppDownloadOpen = ref(false)
/** 内置浏览器里拦下默认的下载动作改为弹说明;其它浏览器照常下载。返回是否拦下了 */
function interceptInAppDownload(event?: Event): boolean {
  if (!inAppBrowser) return false
  event?.preventDefault()
  inAppDownloadOpen.value = true
  return true
}

// 全屏专注阅读模式
const zenMode = ref(false)
function toggleZen() {
  zenMode.value = !zenMode.value
}

// 双栏对比编辑模式
/** 经验条目是否在编辑态;默认只读渲染,点「编辑」进入,切换条目时退出 */
const editExpanded = ref(false)
/** 多人在线编辑的连接(笔记进入编辑时建立);有它,正文由协作连接保存,不走 edit_item */
const collab = shallowRef<CollabProvider | null>(null)
/** 正在建立协作连接:编辑器暂时只读,免得输入落在马上就要被换掉的单人编辑器里 */
const collabPending = ref(false)

/** 右栏编辑草稿:和已保存值比较得到「编辑中」状态 */
const draftTitle = ref('')
const draftBody = ref('')
const draftTags = ref<string[]>([])

/** 预览面板(按格式渲染) */
const preview = ref<{
  format: string
  blocks: PreviewBlock[]
  chunks: PreviewChunk[]
  extractor?: string | null
  read_error?: string | null
  editable?: boolean
  content?: string
  /** Office 文件的来源:upload(上传到知识库的)/ project(项目目录里的)/ source;决定能不能在线编辑 */
  origin?: string | null
} | null>(null)

const downloadUrl = computed(() => {
  const item = current.value
  if (!item || !itemCollection.value) return null
  return fileDownloadUrl(itemCollection.value, item.source, props.viewAs)
})

const rawUrl = computed(() => {
  const info = preview.value
  const item = current.value
  if (!info || !item || !itemCollection.value) return null
  if (!INLINE_FORMATS.has(info.format.toLowerCase())) return null
  return fileRawUrl(itemCollection.value, item.source, props.viewAs)
})

/** 文件编辑 */
const fileDraft = ref('')
const fileEditing = ref(false)
/** 每次进入文件编辑 +1：Host 以 fileId 为维度复用会话，重新进入时必须换 key 才能拿到新草稿 */
const fileEditEpoch = ref(0)
/** 原生代码编辑器的 Host 引用（保存 / 脏状态都从它拿） */
const nativeFileHost = ref<{ save: () => Promise<void>; dirty: boolean } | null>(null)
/**
 * CSV / TSV 走统一外壳的「服务端分页」路径：文件超过 512 KB 或不是 UTF-8（GBK / UTF-16…），
 * 整份读不进浏览器编辑，网格按页向服务端取行、按操作列表保存（服务端按原编码逐字节写回）。
 * 和 fileEditing 同时为真：沿用文件编辑的头部按钮与离开保护，但不连多人编辑房间、不用页面草稿。
 */
const csvRemote = ref(false)
/** 服务端分页表格是否有没保存的改动（来自 Host 的 dirty 事件；页面草稿 fileDraft 在这条路径里不用） */
const remoteDirty = ref(false)
/** Office 文档(目前 Excel)的在线编辑:引擎是浏览器里的编辑器,保存时新内容替换原文件 */
const officeEditing = ref(false)
const officeEditor = ref<{ dirty: boolean } | null>(null)
/** 在线编辑的文档有没有没保存的改动(存不进本机草稿,所以离开前一定要确认) */
const dirtyOffice = computed(() => officeEditing.value && !!officeEditor.value?.dirty)

// ---- 从检索结果点进来:整篇文档里命中的词都高亮(地址里的 `hq` 是检索页带来的查询,只用来高亮)
const contentEl = ref<HTMLElement | null>(null)
const hqText = computed(() => (props.embedded ? '' : typeof route.query.hq === 'string' ? route.query.hq : ''))
const hqTerms = computed(() => queryTerms(hqText.value))
useQueryHighlight({
  root: contentEl,
  terms: hqTerms,
  docKey: selectedId,
  // 正在编辑 / 新建时不画:高亮是给阅读用的
  enabled: computed(() => !creating.value && !fileEditing.value && !editExpanded.value),
})
// 打开的是检索命中的那篇;之后换去别的文档,就不再带着上一次的查询词
let hqOwner: string | null = null
watch(selectedId, (id) => {
  if (!hqText.value) {
    hqOwner = null
    return
  }
  if (!id) return
  if (hqOwner === null) hqOwner = id
  else if (id !== hqOwner) {
    hqOwner = null
    const { hq: _dropped, ...rest } = route.query
    void router.replace({ query: rest })
  }
})
const fileSaving = ref(false)
const versions = ref<{ id: string; version: number; author: string | null; created_at: number; size: number; preview: string }[]>([])
const annotations = ref<{ id: string; body: string; author: string | null; anchor: PreviewAnchor | null; created_at: number }[]>([])
const copying = ref(false)
const previewLoading = ref(false)
const highlight = ref<string | null>(null)

/** 最近查看 */
interface Recent {
  id: string
  title: string
}
const recent = ref<Recent[]>(readRecent())
function readRecent(): Recent[] {
  if (props.embedded) return []
  try {
    return (JSON.parse(localStorage.getItem('kb.browser.recent') ?? '[]') as Recent[]).slice(0, 5)
  } catch {
    return []
  }
}
function pushRecent(entry: Recent) {
  if (props.embedded) return
  recent.value = [entry, ...recent.value.filter((item) => item.id !== entry.id)].slice(0, 5)
  localStorage.setItem('kb.browser.recent', JSON.stringify(recent.value))
}

/* ------------------------------------------------------------------ 派生 */
const current = computed(() => selected.value?.item ?? null)
const isInsight = computed(() => current.value?.kind === 'insight')
// 当前文档真正所在的集合。左侧筛选框的 collection 不一定是它:从首页、搜索结果、「全部」,
// 或者别的集合里的链接点进来时,筛选值还是上一次的集合。按件调用的能力(版本、预览、批注、
// 下载、保存、转 Markdown)一律用它,否则会去错的集合里找 —— 表现出来的就是「详情里的版本
// 列表是空的、文件预览打不开」,而数据其实一直在。
const itemCollection = computed(() => current.value?.collection || collection.value)
const total = computed(() => list.value?.total ?? 0)

/** 除经验条目外,任何文件都走文件模式(查看器自己按格式 / 内容挑渲染方式,认不出的也有十六进制兜底) */
const isMarkdownFile = computed(() => {
  const ext = (current.value?.source ?? '').split('.').pop()?.toLowerCase() ?? ''
  return ['md', 'markdown', 'mdown', 'mdx'].includes(ext)
})
/**
 * 扩展注册的新格式（编辑器扩展的 Codec / 内容面）：内置不认识的扩展名，管理员装了扩展并开着开关时才有值。
 * 阅读由 FileViewer 用同一个判断走外壳；这里管编辑：沿用文本文件的编辑 / 保存 / 版本检查通道，
 * 只是请求里带上 Codec 需要的字节来源，并且不连多人编辑房间（房间里是原文，扩展内容面看到的是解码后的清单）。
 */
const { format: extFormat, pending: extPending } = useExtensionFormat(() => (current.value && !isInsight.value ? current.value.source : undefined))
const isCsvFile = computed(() => {
  const ext = (current.value?.source ?? '').split('.').pop()?.toLowerCase() ?? ''
  return ext === 'csv' || ext === 'tsv'
})
/** 能表格编辑:是 CSV / TSV,没在做别的编辑(能协同时表格也进同一个文本房间,见 collabFile) */
const canEditCsv = computed(() => !props.readonly && !!current.value && !isInsight.value && !creating.value && isCsvFile.value && !fileEditing.value)
/** 在线编辑 Office 文件要同时具备「编辑」和「上传」两个功能点(后端对每次保存照样检查,这里只是不给没权限的人看一个点了会失败的按钮) */
const canEditFilesBase = useFeatures(['docs.edit_text', 'docs.upload'])
const canEditFiles = computed(() => !props.readonly && canEditFilesBase.value)
/** 能在线编辑的 Office 格式(docx 等对应的编辑器接进来再加) */
const ONLINE_EDIT_EXTS = new Set(['xlsx', 'pptx', 'docx'])
/** 能在线编辑:是上面这些格式、文件是上传到知识库的(项目目录里的归代码仓库管),没在做别的编辑,也不在多人协作里 */
const canEditOffice = computed(() => {
  const ext = (current.value?.source ?? '').split('.').pop()?.toLowerCase() ?? ''
  return (
    !!current.value &&
    !isInsight.value &&
    !creating.value &&
    canEditFiles.value &&
    ONLINE_EDIT_EXTS.has(ext) &&
    preview.value?.origin === 'upload' &&
    !fileEditing.value &&
    !officeEditing.value &&
    !collab.value
  )
})
/**
 * 悬停 / 聚焦「在线编辑」时，空闲预取 Word 引擎（wasm 解压后 34 MB）：用户多半马上点，点完少等几秒。
 * 只对 docx 预取——xlsx / pptx 不能触发 Word 引擎的下载。
 *
 * 引擎入口要动态引入（这个页面的首屏 chunk 不能背上 Word 引擎的代码），但那一步要先下 72 KB 的 chunk，
 * 点击后约 0.5 s 才轮到发 WASM 请求；所以 WASM 下载由一个不依赖引擎的小模块（docxWasm.ts，只有一个资源地址）同步发起，
 * 和动态引入、建 Worker 并行。
 */
async function warmWordEditor() {
  const ext = (current.value?.source ?? '').split('.').pop()?.toLowerCase() ?? ''
  if (ext !== 'docx') return
  prefetchDocxWasm()
  try {
    ;(await import('@/editor/engines/docx')).prefetchDocxEngine()
    // 点开后马上要用的代码块（约 35 KB）一起取：编辑面、保存通道；只在悬停之后，不在打开 Word 预览时
    void import('@/editor/surfaces/page/edit/docxEditSurface').catch(() => undefined)
    void import('@/editor/codecs/docx').catch(() => undefined)
  } catch {
    // 预取只是优化：失败了点击时照常打开，错误由那条路径如实报告
  }
}
async function coolWordEditor() {
  try {
    ;(await import('@/editor/engines/docx')).releaseDocxPrefetch()
  } catch {
    // 同上
  }
}
/** 接受了一条 AI 建议:并进了正在编辑的房间时编辑器自己会刷新;改的是存储里的正文就重新加载 */
/** AI 修改建议的「在正文里找到」：正文里选中这段原文并滚过去；找不到时说清楚可能的原因 */
async function locateProposal(text: string) {
  const found = await docPage.value?.locateText?.(text)
  if (!found) toast.push('正文里没找到这段原文：可能已经被改过，或者在还没显示出来的后半篇里')
}

async function onProposalApplied(live: boolean) {
  const item = current.value
  if (live || !item) return
  if (isInsight.value) {
    if (!editExpanded.value) await openItem(item.id, { skipGuard: true, track: false })
  } else {
    await Promise.all([loadPreview(), loadVersions()])
  }
}

async function finishOfficeEdit() {
  officeEditing.value = false
  await loadPreview()
  await loadVersions()
}
const showRenderedMarkdown = ref(true)
// 只用整份文件的内容:不能退回 `current.text`——那只是向量库里的某一个片段,当成文档显示就丢了内容
const markdownSource = computed(() => preview.value?.content ?? '')
// Markdown 文件预览(FileViewer 里的 MarkdownRead)也要认识相对链接;笔记正文由 DocPage 自己算。
const fileLinkContext = computed<LinkContext | null>(() =>
  current.value
    ? {
        collection: current.value.collection ?? collection.value,
        sourcePath: current.value.source,
        adminView: props.viewAs,
        rawUrl: (name, path) => fileRawUrl(name, path, props.viewAs),
        downloadUrl: (name, path) => fileDownloadUrl(name, path, props.viewAs),
      }
    : null,
)
const { report: fileLinkReport } = useDocLinks({
  source: () => (isMarkdownFile.value ? markdownSource.value : ''),
  context: () => fileLinkContext.value,
  call: callCapability,
})
const fileMode = computed(() => !!current.value && !isInsight.value && !creating.value)
const fileName = computed(() => (current.value?.source ?? '').split('/').pop() || current.value?.title || '')
const fileBadge = computed(() => fileChip(fileName.value))
const fileTab = ref<'chunks' | 'notes' | 'history'>('chunks')
const commentTotal = ref(0)
const fileTabs = computed<TabItem[]>(() => [
  { value: 'chunks', label: '内容片段', count: preview.value?.chunks.length },
  { value: 'notes', label: '评论', count: commentTotal.value || annotations.value.length },
  { value: 'history', label: '历史版本', count: versions.value.length },
])

const fileMetaRows = computed(() => {
  const info = preview.value
  if (!info) return [] as { label: string; value: string; mono?: boolean }[]
  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: '类型', value: `${info.format.toUpperCase()} · ${fileLayers(info.format)}` },
  ]
  const count = fileCountLabel(info.format, info.blocks, info.chunks.length)
  if (count.value) rows.push({ label: count.label || '内容', value: count.value })
  if (info.extractor) rows.push({ label: '抽取器', value: extractorLabel(info.extractor), mono: true })
  const embedder = collections.value.find((item) => item.name === current.value?.collection)?.embedder_id
  if (embedder) rows.push({ label: '索引模型', value: embedder, mono: true })
  return rows
})

const metaOpen = ref(false)
const srtContent = computed(() => srtForFile(preview.value?.format ?? '', preview.value?.blocks ?? []))
function exportSrt() {
  if (!srtContent.value) return
  const blob = new Blob([srtContent.value], { type: 'text/plain;charset=utf-8' })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = `${fileName.value.replace(/\.[^.]+$/, '')}.srt`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 1000)
  toast.push('已导出 .srt')
}

const pageIndex = computed(() => blocksByPage(preview.value?.blocks ?? []))
function chunkLabel(chunk: PreviewChunk): string {
  return chunkPositionLabel(chunk, preview.value?.blocks ?? [], pageIndex.value)
}

async function saveMeta() {
  if (props.readonly) return
  if (await save()) metaOpen.value = false
}
function closeMeta() {
  if (!saving.value) {
    draftTags.value = [...(current.value?.tags ?? [])]
    error.value = ''
  }
  metaOpen.value = false
}

/** 属性面板里「状态」的中文值(原来直接显示 active / superseded) */
const STATUS_TEXT: Record<string, string> = { active: '有效', superseded: '已被取代', deprecated: '已弃用' }
const statusLabel = computed(() => {
  const value = current.value?.status
  if (!value) return { text: '', tone: 'success' as const }
  if (value === 'superseded') return { text: '已被取代', tone: 'warning' as const }
  if (value === 'deprecated') return { text: '已弃用', tone: 'danger' as const }
  return { text: isInsight.value ? '已转正' : '有效', tone: 'success' as const }
})

const dirty = computed(() => {
  const item = current.value
  if (!item) return false
  const sameTags = draftTags.value.join('\u0000') === item.tags.join('\u0000')
  if (!isInsight.value) return !sameTags
  // 正文改了没落地也算脏:多人编辑里「保存」才是提交到正文的那一下
  const bodyChanged = draftBody.value.trimEnd() !== item.text.trimEnd()
  return draftTitle.value !== (item.title ?? '') || bodyChanged || !sameTags
})
/** 笔记还有没保存到服务器的改动(正文 / 标题 / 标签):编辑态和阅读态都要提示成草稿 */
const noteDraftDirty = computed(() => isInsight.value && dirty.value)
/** 只有标签变了:正文和标题还是服务器上那一版 */
const tagsOnlyDirty = computed(() => {
  const item = current.value
  if (!item || !dirty.value) return false
  if (!isInsight.value) return true
  const sameTags = draftTags.value.join('\u0000') === item.tags.join('\u0000')
  const bodyChanged = draftBody.value.trimEnd() !== item.text.trimEnd()
  return !sameTags && !bodyChanged && draftTitle.value === (item.title ?? '')
})
const dirtyNewInsight = computed(() => creating.value && (newTitle.value.trim() !== '' || newBody.value.trim() !== ''))
/** 正在编辑的文件有没有改动(Markdown 文件与代码文件都算) */
// 协作中的文本文件内容随时同步到房间,没有「还没保存」的内容
const dirtyFile = computed(() => {
  if (!fileEditing.value) return false
  // 服务端分页的表格：改动记在网格的草稿里，由 Host 告诉我们脏不脏
  if (csvRemote.value) return remoteDirty.value
  // 扩展格式的内容面编辑的是 Codec 解码后的文本，和页面里的原文没法逐字比：脏不脏以外壳会话为准
  if (extFormat.value) return remoteDirty.value
  return !collab.value && fileDraft.value.trimEnd() !== (preview.value?.content ?? '').trimEnd()
})
/**
 * 文本 / 代码 / CSV 编辑进外壳的准入条件：拿到整份文件 + 非 Markdown / Office / PDF。
 * 读不到全文（editable=false）绝不进编辑，避免把片段保存成整个文件。
 * 协同：文本文件和小 CSV 复用页面已连好的纯文本房间；服务端分页的 CSV 不连房间（见 collabFile）。
 */
/** 外壳只接文本/代码与 CSV；Office/PDF 各有自己的 viewer，不能误落进表格面后报「尚未接入」 */
const NON_NATIVE_FILE_EXTS = new Set(['xlsx', 'xls', 'ods', 'et', 'docx', 'doc', 'odt', 'rtf', 'wps', 'pptx', 'ppt', 'odp', 'dps', 'pdf'])
const nativeFileEdit = computed(() => {
  const ext = (current.value?.source ?? '').split('.').pop()?.toLowerCase() ?? ''
  return (
    fileEditing.value &&
    !isMarkdownFile.value &&
    !NON_NATIVE_FILE_EXTS.has(ext) &&
    !!current.value &&
    // 整份读到的文本（editable），或服务端分页的 CSV（超过 512 KB / 非 UTF-8，不需要整份文本）
    (!!preview.value?.editable || csvRemote.value) &&
    // 房间还在连接时先不挂（连上后带着房间挂载，不让人在单人文档上先写几个字再被房间内容盖掉）
    !collabPending.value
  )
})
/** Host 的打开请求：source 是进入编辑那一刻的完整草稿，后续正文以 Host 会话为准 */
const nativeFileRequest = computed<EditorOpenRequest | null>(() => {
  const item = current.value
  const previewValue = preview.value
  if (!item || !(previewValue?.editable || csvRemote.value)) return null
  const ext = item.source.split('.').pop()?.toLowerCase() ?? previewValue?.format ?? 'csv'
  if (csvRemote.value) {
    return {
      fileId: `${item.collection}:${item.source}`,
      collection: item.collection,
      path: item.source,
      format: ext,
      // 正文不在页面里：网格按页向服务端取行
      source: { kind: 'text', text: '', name: item.source },
      readonly: false,
      revision: Number(versions.value[0]?.version ?? 0),
      permissions: { read: true, write: true, export: false, comment: false, ai: false },
      remoteTable: createCsvRemoteBackend(callCapability, item.collection, item.source),
    }
  }
  return {
    fileId: `${item.collection}:${item.source}`,
    collection: item.collection,
    path: item.source,
    format: ext,
    // 扩展带了 Codec 时给字节：外壳只对字节来源跑 Codec 的 decode（保存时的 encode 结果在下面的通道里按 UTF-8 文本落盘）
    source: extFormat.value ? extensionSourceOf(fileDraft.value, item.source, extFormat.value.hasCodec) : { kind: 'text', text: fileDraft.value, name: item.source },
    // 走到这里的一定是服务端整份读到的可编辑文本（nativeFileEdit 要求 editable）：.cs / .rb / .php 这类宿主格式表里没有的扩展名
    // 也要能编辑，旧编辑器本来就行（回归见 e2e 的 edit-any），不能让它们落进「暂不支持」死胡同
    plainText: true,
    readonly: false,
    revision: Number(versions.value[0]?.version ?? 0),
    permissions: { read: true, write: true, export: false, comment: false, ai: false },
    // CSV/TSV 的协同房间已经由页面连好（fileEditing 触发同一间纯文本房），网格只借用 Y.Text
    ...(isCsvFile.value && collab.value
      ? { collabText: collab.value.text, collabWritable: () => collab.value?.getState().writable ?? false, collabStatus: collab.value }
      : {}),
    // 代码 / 文本文件的房间：代码面里的 CodeEditor 直接绑 CollabProvider（和旧路径同一个组件）
    ...(!isCsvFile.value && collab.value ? { collabProvider: collab.value, collabStatus: collab.value } : {}),
  }
})
/** 保存通道：Host 的快照已经是最终文本（含原文件 BOM / 行尾），直接交给页面保存 */
const nativeFileTransport: SessionTransport = {
  save: async (request) => {
    // 扩展 Codec 编码出来的是字节：必须是合法 UTF-8 才能按文本保存，否则拒绝（原文件不动），绝不拿空串去覆盖整个文件
    const saved = saveTextOf(request.source)
    if (!saved.ok) return { ok: false, revision: request.revision, sha256: '', reason: saved.reason }
    return saveFileContent(saved.text, request.revision)
  },
}
/** 外壳报告的正文：扩展格式里它是 Codec 解码后的清单文本，不是文件原文，不能当页面草稿 */
function onNativeChange(text: string) {
  if (!extFormat.value) fileDraft.value = text
}
/** 文档页右上角的保存状态 */
const saveState = computed<'saving' | 'dirty' | 'saved' | ''>(() => {
  if (saving.value || fileSaving.value) return 'saving'
  // 没保存的笔记改动在阅读态也提示成草稿(否则「取消」回到阅读后看不出内容还没落库)
  if (dirty.value || dirtyFile.value || dirtyNewInsight.value || dirtyOffice.value) return 'dirty'
  if (savedAt.value && Date.now() - savedAt.value < 8000) return 'saved'
  return ''
})
/** 当前这份改动是否已经安全地存在本机草稿里(DocPage 每次落盘后告诉我们);换文档 / 新建时重置 */
// 不在进出编辑时重置:「取消」退出编辑后草稿还在,阅读态要继续显示「草稿已自动保存」
const draftStored = ref(false)
watch([selectedId, creating, fileEditing], () => (draftStored.value = false))
const saveStateText = computed(() => {
  // 有草稿兜底时不说吓人的「未保存」:改动不会因为关页面、断网或崩溃而丢
  if (saveState.value === 'dirty' && draftStored.value) return '草稿已自动保存'
  return ({ saving: '保存中…', dirty: '未保存', saved: '已保存', '': '' })[saveState.value]
})

const columns: Column[] = [
  { key: 'dot', label: '', width: '20px' },
  { key: 'id', label: 'ID', cellClass: 'mono m' },
  { key: 'title', label: '标题', clip: true },
  { key: 'kind', label: '类型' },
  { key: 'score', label: '置信', cellClass: 'mono' },
  { key: 'updated', label: '更新', cellClass: 'm' },
]
const hasConfidence = computed(() => (list.value?.items ?? []).some((row) => row.confidence != null))
const listColumns = computed(() => columns.map((column) => (column.key === 'score' ? { ...column, label: hasConfidence.value ? '置信' : '版本' } : column)))

const sortOptions = [
  { value: 'updated_at:desc', label: '更新时间 ↓' },
  { value: 'updated_at:asc', label: '更新时间 ↑' },
  { value: 'source:asc', label: '路径 A→Z' },
  { value: 'kind:asc', label: '类型' },
]
const statusOptions = [
  { value: 'active', label: '有效' },
  { value: 'all', label: '全部状态' },
  { value: 'superseded', label: '已被取代' },
  { value: 'deprecated', label: '已弃用' },
]
/**
 * 内容类型 / 笔记种类的中文名。界面不露 insight、pitfall 这些英文键名(术语表:笔记、文档);
 * 笔记种类的叫法沿用审核收件箱的 KIND_TEXT,保证两个页面说的一样。
 */
const KIND_LABEL: Record<string, string> = { ...KIND_TEXT, pattern: '模式', insight: '笔记', doc: '文档', code: '代码', external: '外部', summary: '摘要', note: '笔记' }
const kindText = (value: string | null | undefined) => (value ? (KIND_LABEL[value] ?? value) : '')
const insightKinds = ['decision', 'pitfall', 'howto', 'convention', 'note'].map((value) => ({ value, label: kindText(value) }))

const chips = computed<FilterChip[]>(() => {
  const res: FilterChip[] = []
  if (insightKind.value || kind.value) res.push({ key: 'kind', label: `kind:${insightKind.value || kind.value}` })
  if (dir.value) res.push({ key: 'dir', label: `dir:${dir.value}` })
  if (tag.value) res.push({ key: 'tag', label: `tag:${tag.value}` })
  if (status.value !== 'active') res.push({ key: 'status', label: `status:${status.value}` })
  if (q.value) res.push({ key: 'q', label: `“${q.value}”` })
  return res
})
const filterCount = computed(() => chips.value.length)

const collectionOptions = computed(() =>
  collections.value.map((entry) => ({ value: entry.name, label: `${entry.name} (${compact(entry.items)})` }))
)
const maxPage = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const categoryPills = computed(() => [
  { value: '', label: '全部', count: kindCounts.value.code + kindCounts.value.doc + kindCounts.value.insight || total.value },
  ...(kindCounts.value.insight ? [{ value: 'insight', label: '笔记', count: kindCounts.value.insight }] : []),
  ...(kindCounts.value.doc ? [{ value: 'doc', label: '文档', count: kindCounts.value.doc }] : []),
  ...(kindCounts.value.code ? [{ value: 'code', label: '代码', count: kindCounts.value.code }] : []),
])
function setCategoryPill(val: string) {
  setKind(val)
  sidebarTab.value = 'files'
}
function clearAllFilters() {
  filterText.value = ''
  q.value = ''
  kind.value = ''
  insightKind.value = ''
  dir.value = ''
  tag.value = ''
  status.value = 'active'
}

const kindRows = computed(() =>
  [
    { value: 'insight', label: 'insight' },
    { value: 'code', label: 'code' },
    { value: 'doc', label: 'doc' },
  ].filter((entry) => kindCounts.value[entry.value] !== undefined && kindCounts.value[entry.value]! > 0),
)
const topTags = computed(() => {
  const counts = new Map<string, number>()
  for (const row of list.value?.items ?? []) for (const value of row.tags) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8).map(([value]) => value)
})

const crumbs = computed(() => {
  const parts = collection.value ? collection.value.split('/') : []
  if (fileMode.value) return { trail: [...parts, fileName.value], leaf: '' }
  if (insightKind.value || kind.value) parts.push(insightKind.value || kind.value)
  const leaf = dir.value || (tag.value ? `#${tag.value}` : '')
  if (leaf) parts.push(leaf)
  return { trail: parts.length ? parts : ['工作台'], leaf }
})

// 评论:自己的知识库里,笔记和文件共用分享场景下的同一个评论组件(回复 / @ / 已解决)
const session = useSessionStore()
const canComment = useFeature('docs.annotate')
const myAccess = computed(() => {
  const base = ownAccess(canComment.value && !props.readonly)
  if (!props.readonly) return base
  // 只读查看:评论组件仍要能读列表,但不能显示编辑 / 下载入口,原件也要带目标用户
  return {
    ...base,
    // 评论列表也要读目标用户的库:调用同样带 X-KB-Admin-View,不能落回管理员自己的库
    call: <T,>(capability: string, args: Record<string, unknown> = {}) => callCapability<T>(capability, args),
    rawUrl: (name: string, path: string) => fileRawUrl(name, path, props.viewAs),
    downloadUrl: (name: string, path: string) => fileDownloadUrl(name, path, props.viewAs),
    can: { ...base.can, edit: false, comment: false, download: false },
  }
})
const insightComments = ref(0)
const commentFocus = computed(() => (props.embedded ? null : typeof route.query.comment === 'string' ? route.query.comment : null))
// 从通知点进来(?comment=评论 id):直接打开评论页签
watch(commentFocus, (id) => {
  if (!id) return
  tab.value = 'comments'
  fileTab.value = 'notes'
  inspectorTemp.value = true
}, { immediate: true })

// ---- 多人在线编辑(笔记):进入编辑就连上房间,退出 / 换条目 / 离开页面就断开 ----
const canCollab = useFeature('collab.edit')
const canCollabNow = computed(() => canCollab.value && !props.readonly)
/** 这个账号进入编辑会不会连多人编辑房间(决定草稿的正文能不能静默放回:多人编辑时以房间为准,不能) */
const collabCapable = computed(() => canCollabNow.value && !!session.user?.space_id)

/* ---- 草稿的附加内容(标签 / 种类)与「继续写」入口 ---- */
const draftScope = (id: string) => scopedDraftId(session.user?.id, id)
const insightExtra = (tags: string[]) => JSON.stringify({ tags })
const newNoteBaseExtra = JSON.stringify({ kind: 'note', tags: [] })
const newNoteExtra = computed(() => JSON.stringify({ kind: newKind.value, tags: newTags.value }))
const insightExtraNow = computed(() => insightExtra(draftTags.value))
const insightBaseExtra = computed(() => insightExtra(current.value?.tags ?? []))
function parseExtra(value: string): { kind?: string; tags?: string[] } {
  try {
    const parsed = JSON.parse(value) as { kind?: unknown; tags?: unknown }
    return {
      kind: typeof parsed.kind === 'string' ? parsed.kind : undefined,
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    }
  } catch {
    return {}
  }
}
function restoreNewExtra(value: string) {
  const { kind: restoredKind, tags } = parseExtra(value)
  if (restoredKind && insightKinds.some((entry) => entry.value === restoredKind)) newKind.value = restoredKind
  if (tags) newTags.value = tags
}
function restoreInsightExtra(value: string) {
  const { tags } = parseExtra(value)
  if (tags) draftTags.value = tags
}
/** 没写完的新笔记(标题或正文有内容):侧栏顶上给一个「继续写」入口,点了由 DocPage 把内容静默放回 */
const draftTick = ref(0)
const pendingNewDraft = computed(() => {
  void draftTick.value
  if (props.readonly || creating.value || !collection.value) return null
  const draft = loadDraft(draftScope(`new:${collection.value}`))
  return draft && (draft.title.trim() || draft.body.trim()) ? draft : null
})
// 退出新建时 DocPage 卸载前才把最后一笔写进草稿:等这一轮渲染完再重新读,否则入口会晚一步出现
watch(creating, async () => {
  await nextTick()
  draftTick.value += 1
})
watch(collection, () => (draftTick.value += 1))
function discardNewDraft() {
  clearDraft(draftScope(`new:${collection.value}`))
  draftTick.value += 1
}
let stopLanding: (() => void) | null = null
const collabKey = useCollabKey(() => collab.value)
function stopCollab() {
  stopLanding?.()
  stopLanding = null
  collab.value?.destroy()
  collab.value = null
}
async function startCollab(doc: DocRefInput, itemCollection: string, stillEditing: () => boolean) {
  const spaceId = session.user?.space_id
  if (!canCollabNow.value || !spaceId) return
  const [{ openCollab }, { startLanding }] = await Promise.all([import('@/collab/session'), import('@/collab/landing')])
  // 加载期间用户可能已经退出编辑或换了条目
  if (!stillEditing() || collab.value) return
  const provider = openCollab({ spaceId, collection: itemCollection, doc })
  collab.value = provider
  // 笔记和 Markdown 文件的正文是富文本结构,服务端不认识节点树:落地者把编辑器里的 Markdown 提交上去。
  // 其它文本文件的房间服务端自己能取出字符串,不需要客户端落地
  if (provider.kind === 'rich') {
    // 房间里只有自己时正文先不进库:安静后 / land_now / 关页面都不自动落地,点「保存」才提交。
    // 有别人在场时照旧实时落地(多人协作要的就是这个)。
    const { peersOf } = await import('@/collab/status')
    // 只算「别人」:自己刚刷新时,上一次连接的在线状态可能还没过期,不能当成有人陪着编辑
    const alone = () => {
      const me = provider.getState().me?.id
      return !peersOf(provider.awareness.getStates(), provider.doc.clientID).some((peer) => peer.id !== me)
    }
    stopLanding = startLanding(provider, { getMarkdown: () => docPage.value?.flush() ?? null, auto: () => !alone() })
  }
}
// 文件编辑都参与协作:Markdown 文件和笔记一样是富文本房间(页面用所见即所得编辑),其它文件是纯文本房间
// 服务端分页的 CSV 不连房间：它的保存是提交操作列表，和房间里的纯文本落地是两条路，混在一起会互相覆盖
const collabFile = computed(() => fileEditing.value && !csvRemote.value && !extFormat.value)
watch(
  () => [isInsight.value, editExpanded.value, collabFile.value, current.value?.id] as const,
  ([insight, editing, plainFile, id]) => {
    stopCollab()
    collabPending.value = false
    const item = current.value
    if (!id || !item) return
    const begin = (doc: DocRefInput, still: () => boolean) => {
      if (!canCollabNow.value || !session.user?.space_id) return
      collabPending.value = true
      void startCollab(doc, item.collection, still).finally(() => (collabPending.value = false))
    }
    if (insight && editing) begin({ insight: id }, () => isInsight.value && editExpanded.value && current.value?.id === id)
    // 小 CSV 的表格编辑也在这里：和源码编辑同一个纯文本房间(表格只是另一种视图),表格里改的和别人源码里改的实时合并
    else if (plainFile) begin({ file: item.source }, () => collabFile.value && current.value?.id === id)
  },
)
onBeforeUnmount(stopCollab)

// 关系页签的数据来自 `doc_links`(文档链接图谱):出链含文件和笔记,入链是「谁引用了这篇」。
// 不能再只用正文里的 [[双链]]:那只有笔记 id,文件引用和入链都看不到。
// 图谱是保存时重建的索引,所以在 current.id / selected.version 变化时拉取——保存后自动刷新,和旧的正文双链列表同一个时机。
const relations = ref<{ outbound: DocRelation[]; inbound: DocRelation[] } | null>(null)
// 旧服务没有 doc_links 时退回正文双链,界面别空着;提示一句让人知道看到的不全
const relationsFallback = ref(false)
let relationsSeq = 0

// 正文里的 [[双链]]——只作计数垫底和旧服务退回用;图谱区分笔记/文件,退回模式只能按笔记处理
const wikilinks = computed(() => wikilinkIds(current.value?.text ?? '').filter(isNoteLinkId))

async function loadRelations(): Promise<void> {
  const item = current.value
  if (!isInsight.value || !item) {
    relationsSeq += 1
    relations.value = null
    relationsFallback.value = false
    return
  }
  const seq = ++relationsSeq
  try {
    const reply = await callCapability<DocLinksReply>('doc_links', {
      note_id: item.id,
      direction: 'both',
      // 侧栏是导航,不需要全量;100 条足够覆盖绝大多数笔记
      limit: 100,
    })
    // 笔记出链先用链接文字垫底,再用 get_item 补真实标题(和正文双链的显示规则一致)
    const ids = noteTargetIds(reply.outbound ?? [])
    const titles = ids.length ? await resolveTitles(ids) : {}
    if (seq !== relationsSeq) return
    relations.value = splitRelations(reply, titles)
    relationsFallback.value = false
  } catch {
    if (seq !== relationsSeq) return
    // 查不到就退回正文双链。这里不弹错:关系是辅助信息,正文和编辑都不受影响
    const ids = wikilinks.value
    const titles: Record<string, string> = ids.length ? await resolveTitles(ids).catch(() => ({})) : {}
    if (seq !== relationsSeq) return
    relations.value = {
      outbound: ids.map((id) => ({
        kind: 'note' as const,
        collection: item.collection,
        id,
        title: titles[id] || id,
        line: 0,
        count: 1,
      })),
      inbound: [],
    }
    relationsFallback.value = true
  }
}

// 换一篇就清掉上一组,避免切回来时先闪一眼别人的关系
watch(
  () => current.value?.id,
  () => {
    relationsSeq += 1
    relations.value = null
    relationsFallback.value = false
  },
)
// 只在真的打开「关系」页签时查:标题要逐篇 get_item,不打开就不花这笔钱。
// 保存后(selected.version 变)在页签上时自动刷新;换笔记清空后重新查。
watch(
  () => [isInsight.value, current.value?.id, selected.value?.version, tab.value] as const,
  ([insight, id, , currentTab]) => {
    if (!insight || !id || currentTab !== 'relations') return
    void loadRelations()
  },
  { immediate: true },
)

/** 关系行:笔记走条目,文件走附件预览(文件行里带的是它自己的 collection) */
function openRelation(row: DocRelation): void {
  if (row.kind === 'note') void openItem(row.id)
  else if (row.collection) void openAttachment({ collection: row.collection, path: row.id })
}

// 关系页签的计数:加载中先用正文双链垫着,加载完就是图谱里的总数(出 + 入)
const relationsCount = computed(() =>
  relations.value ? relations.value.outbound.length + relations.value.inbound.length : wikilinks.value.length,
)
const tabs = computed<TabItem[]>(() => {
  if (isInsight.value) {
    return [
      // 右侧栏只有 260–320 宽:第一页签原来叫「正文 · Markdown」,实际显示的就是属性表(和「元数据」页签是同一块内容),
      // 占掉半行,把「评论」挤出可视区。合成一个「信息」,评论一眼可见
      { value: 'content', label: '信息' },
      { value: 'relations', label: '关系', count: relationsCount.value },
      // 这个页签里渲染的是正文版本(item_versions),计数必须用 versions:用 history(演化链)会显示成别的数
      { value: 'chain', label: '历史版本', count: versions.value.length },
      { value: 'comments', label: '评论', count: insightComments.value || undefined },
    ]
  }
  return [
    { value: 'content', label: '正文' },
    { value: 'preview', label: '预览' },
    { value: 'meta', label: '元数据' },
  ]
})
const chain = computed<ChainEvent[]>(() =>
  history.value.map((entry, index) => ({
    time: entry.at ? fmtStamp(entry.at) : undefined,
    text: entry.note ?? `v${entry.version} · ${entry.title}`,
    tone: index === history.value.length - 1 ? 'ok' : entry.status === 'superseded' ? 'warn' : 'neutral',
    id: entry.id === current.value?.id ? undefined : entry.id,
  })),
)
const embedInfo = computed(() => {
  const stats = collections.value.find((entry) => entry.name === collection.value)
  const at = current.value?.embedded_at ?? current.value?.updated_at
  if (!stats || !at) return ''
  return `${stats.embedder_id.replace(/^fastembed:/, '').replace(/-int8$/, '')}@${stats.dim} · ${fmtStamp(at, true)}`
})

/* ------------------------------------------------------------------ 格式化 */
function fmtUpdated(at: number) {
  if (isToday(at)) return clockText(at)
  if (daysAgo(at) === 1) return '昨天'
  return monthDayText(at)
}
function fmtStamp(at: number, withYear = false) {
  return withYear ? dateTimeText(at) : stampText(at)
}
function rowTitle(row: ItemSummary): string {
  if (row.title) return row.title
  if (row.symbol) return row.symbol
  const src = row.source || ''
  const idx = Math.max(src.lastIndexOf('/'), src.lastIndexOf('/'))
  if (idx !== -1 && idx < src.length - 1) {
    return src.slice(idx + 1)
  }
  return src
}
function rowPathDir(row: ItemSummary): string {
  if (row.title || row.symbol) return ''
  const src = row.source || ''
  const idx = Math.max(src.lastIndexOf('/'), src.lastIndexOf('/'))
  if (idx > 0) {
    return src.slice(0, idx)
  }
  return ''
}
const statusDot = (row: ItemSummary) => (row.status === 'active' ? 'var(--g)' : row.status === 'superseded' ? 'var(--y)' : 'var(--r)')
const compact = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value))

/* ------------------------------------------------------------------ 取数 */
let listSeq = 0
async function loadCollections() {
  const catalog = await callCapability<{ collections: CollectionStats[] }>('list_collections')
  collections.value = catalog.collections
  const fromQuery = props.embedded ? props.initialCollection : route.query.collection
  // 默认选一个**有内容**的集合:优先 URL 指定的,其次第一个有行的(避免一进来就停在空的
  // _global 上,看起来像“知识库是空的”),最后才退回第一个。
  const preferred =
    (typeof fromQuery === 'string'
      ? collections.value.find((item) => item.name === fromQuery)
      : undefined) ??
    collections.value.find((item) => item.rows > 0) ??
    collections.value[0]
  collection.value = preferred?.name ?? ''
  // 嵌入在弹窗里时不能改地址栏:会把用户列表的筛选 / 翻页冲掉
  if (!props.embedded && collection.value && fromQuery !== collection.value) {
    void router.replace({ query: { ...route.query, collection: collection.value } })
  }
}

async function loadKindCounts() {
  if (!collection.value) return
  const name = collection.value
  // 按文件算(和列表的总数一致):后端对「只按种类 / 状态过滤」的请求共用同一份缓存,这三问不会各扫一遍表
  const base = { collection: name, status: status.value, page: 1, page_size: 1, group_by_file: true }
  const [insight, code, doc] = await Promise.all(
    ['insight', 'code', 'doc'].map((entry) =>
      callCapability<ItemList>('list_items', { ...base, kind: entry }).then((result) => result.total).catch(() => 0),
    ),
  )
  if (name === collection.value) kindCounts.value = { insight: insight ?? 0, code: code ?? 0, doc: doc ?? 0 }
}

let facetsUnsupported = false
async function loadFacets() {
  if (facetsUnsupported || !collection.value) {
    facets.value = null
    facetDirs.value = []
    return
  }
  const name = collection.value
  try {
    const result = await callCapability<{ kinds: Facet[]; dirs?: string[] }>('item_facets', { collection: name, status: status.value })
    if (name === collection.value) {
      facets.value = result.kinds
      facetDirs.value = result.dirs ?? []
    }
  } catch (err) {
    if (err instanceof CapabilityError && err.status === 404) facetsUnsupported = true
    if (name === collection.value) {
      facets.value = null
      facetDirs.value = []
    }
  }
}

/**
 * 读取目录树下面的分类数据。切换集合时先清掉旧集合的计数和分面:
 * 否则展开新集合的瞬间,树里还是上一个集合的内容,点上去的筛选对不上,看起来就是「点了没反应」。
 * 同一时刻只认最后一次调用的结果,避免快速切换时先发的慢请求把「读取中」提前关掉。
 */
let treeSeq = 0
async function loadTree(options: { reset?: boolean } = {}) {
  const seq = ++treeSeq
  if (options.reset) {
    kindCounts.value = {}
    facets.value = null
    facetDirs.value = []
    facetOpen.value = {}
  }
  treeLoading.value = true
  try {
    await Promise.all([loadKindCounts(), loadFacets()])
  } finally {
    if (seq === treeSeq) treeLoading.value = false
  }
}

/**
 * 读列表。keepOrder：保存 / 编辑后的刷新用——已经在这一屏里的行留在原位只更新内容，
 * 不因为「更新时间变了」就跑到最前面（见 utils/stableOrder.ts）；翻页 / 换筛选 / 其它刷新照服务端顺序
 */
async function loadItems({ keepOrder = false }: { keepOrder?: boolean } = {}) {
  if (!collection.value) return
  const seq = ++listSeq
  listFailure.value = null
  listLoading.value = true
  const [sortKey, order] = sort.value.split(':')
  try {
    const result = await callCapability<ItemList>('list_items', {
      collection: collection.value,
      // 一个文件一行:向量库里一份文档被切成很多块,那是检索的单位,浏览的单位是文件
      group_by_file: true,
      ...(kind.value ? { kind: kind.value } : {}),
      ...(insightKind.value ? { insight_kind: insightKind.value } : {}),
      status: status.value,
      ...(tag.value ? { tag: tag.value } : {}),
      ...(dir.value ? { path_prefix: dir.value } : {}),
      ...(q.value ? { q: q.value } : {}),
      sort: sortKey,
      order,
      page: page.value,
      page_size: pageSize.value,
    })
    if (seq === listSeq) {
      const previous = list.value
      list.value =
        keepOrder && previous && previous.page === result.page
          ? { ...result, items: mergeStableOrder(previous.items, result.items, result.page_size) }
          : result
    }
  } catch (err) {
    if (seq === listSeq) listFailure.value = failureOf(err, '读取列表')
  } finally {
    if (seq === listSeq) listLoading.value = false
  }
}

function resetDraft(detail: ItemDetail) {
  draftTitle.value = detail.item.title ?? ''
  draftBody.value = detail.item.text
  draftTags.value = [...detail.item.tags]
}

async function openItem(id: string, { skipGuard = false, track = true, keepEditing = false } = {}) {
  if (!skipGuard && id !== selectedId.value && !(await confirmDiscard())) return
  creating.value = false
  if (!keepEditing) error.value = ''
  // 保存后重新加载(keepEditing)不算「换文档」:正在编辑时版面不能动
  enterDoc(!keepEditing)
  selectedId.value = id
  // 切到另一篇时先把上一篇从版面上摘掉:留着旧内容、旧标题,用户会觉得「点了没反应、还是那篇」,
  // 而骨架屏(模板里的 kb-doc-loading)只在 current 为空时才显示
  if (!keepEditing && selected.value?.item.id !== id) selected.value = null
  const fromQuery = props.embedded ? undefined : route.query.highlight
  highlight.value = typeof fromQuery === 'string' ? fromQuery : null
  detailLoading.value = true
  detailFailure.value = null
  // 文档详情读到之后,后面的历史 / 预览失败都不该把已经显示的文档撤掉:只有详情本身读不到才算「打不开」
  let loaded = false
  try {
    // item_history 只需要 id,和 get_item 并行发:以前是串行两个往返,点开笔记要等两倍。
    // 保存后重载(keepEditing)不算换文档:演化链不会因为一次保存就变,省掉这次查询
    const chainPromise = keepEditing ? null : callCapability<{ items: typeof history.value }>('item_history', { id }).catch(() => null)
    const detail = await callCapability<ItemDetail>('get_item', { id })
    if (selectedId.value !== id) return
    loaded = true
    const continuing = keepEditing && editExpanded.value
    const typed = draftBody.value
    selected.value = detail
    resetDraft(detail)
    // 保存后继续编辑:服务器回来的正文只差末尾换行时,保留编辑器里的值(否则会重置光标)
    if (continuing && typed.trimEnd() === detail.item.text.trimEnd()) draftBody.value = typed
    // 从评论通知点进来(?comment=…)时直接停在评论页签,不回到正文
    tab.value = commentFocus.value ? 'comments' : 'content'
    if (commentFocus.value) {
      fileTab.value = 'notes'
      inspectorTemp.value = true
    }
    showRendered.value = true
    if (!continuing) editExpanded.value = false
    // 上次没写完的内容还在本机草稿里:直接回到编辑态接着写,草稿由 DocPage 放回去(不用先点「编辑」再点「恢复」)
    if (
      !continuing &&
      !keepEditing &&
      !props.readonly &&
      !commentFocus.value &&
      detail.item.kind === 'insight' &&
      hasResumableDraft(
        draftScope(detail.item.id),
        { title: detail.item.title ?? '', body: detail.item.text, extra: insightExtra(detail.item.tags) },
        collabCapable.value,
      )
    ) {
      editExpanded.value = true
    }
    history.value = []
    // 版本列表必须跟着文档一起清:不清的话切到下一篇时面板上还挂着上一篇的版本,
    // 第一行又标着「当前」,看起来就像「所有版本都是最新那版」
    versions.value = []
    preview.value = null
    csvRemote.value = false
    fileEditing.value = false
    officeEditing.value = false
    if (track && !props.embedded) pushRecent({ id, title: detail.item.title ?? detail.item.symbol ?? detail.item.source })
    if (!props.embedded) void router.replace({ query: { ...route.query, item: id } })
    if (detail.item.kind !== 'insight') {
      resetQuoteState()
      void loadPreview()
      void loadVersions()
      void loadAnnotations()
    } else {
      const chainResult = chainPromise ? await chainPromise : null
      if (chainResult && selectedId.value === id) history.value = chainResult.items
      // 笔记也有正文版本历史(item_versions):能翻回任意一版、对比每次改动
      void loadVersions()
    }
  } catch (err) {
    if (selectedId.value === id) {
      if (loaded || keepEditing) {
        // 文档还在屏幕上(保存后重新载入、或只是历史读不到):用提示条说一声,不撤掉正在看 / 编辑的内容
        error.value = failureOf(err, loaded ? '读取历史版本' : '重新载入文档').message
        if (loaded) history.value = []
      } else {
        selected.value = null
        detailFailure.value = failureOf(err, '打开文档')
      }
    }
  } finally {
    if (selectedId.value === id) detailLoading.value = false
  }
}

/**
 * 现在离开会不会丢东西:
 * - none:没有改动;
 * - drafted:有改动,但已经存进本机草稿(下次打开自动接着写),离开不用拦;
 * - unsafe:有改动而且存不下来(存储已满、代码文件没有草稿、标签这类不进草稿的改动、压着没处理的旧草稿)。
 * 多人编辑时正文在房间里,「dirty」不看正文;但离线期间改的、还没发出去的正文(pendingLocal)也算一处改动。
 */
function leaveRisk(): 'none' | 'drafted' | 'unsafe' {
  const bodyPending = !!collab.value?.getState().pendingLocal
  const anyDirty = dirty.value || dirtyNewInsight.value || dirtyFile.value || dirtyOffice.value || bodyPending
  if (!anyDirty) return 'none'
  const stored = docPage.value?.persistDraft() ?? null
  if (stored !== true) return 'unsafe'
  // 草稿只管标题 / 正文 / 标签(种类);其它文件类型(代码)没有 DocPage,上面已经算 unsafe
  return 'drafted'
}

async function confirmDiscard(): Promise<boolean> {
  docPage.value?.flush()
  // 让编辑器刚推上来的内容进到 dirty 的计算里,再判断
  await nextTick()
  const risk = leaveRisk()
  if (risk === 'none') return true
  if (risk === 'drafted') {
    toast.push('改动已自动存为草稿,下次打开会接着写')
    return true
  }
  return confirmer.ask({
    title: '放弃未保存的修改?',
    message: '这些改动没法自动保存,离开后不会保留。',
    confirmText: '放弃修改',
    cancelText: '继续编辑',
    tone: 'danger',
  })
}

async function loadPreview() {
  const item = current.value
  const col = itemCollection.value
  if (!item || !col) return
  previewLoading.value = true
  previewFailure.value = null
  try {
    preview.value = await callCapability<{ format: string; blocks: PreviewBlock[]; chunks: PreviewChunk[]; content?: string; editable?: boolean; origin?: string | null }>('file_preview', {
      collection: col,
      path: item.source,
    })
  } catch (err) {
    preview.value = null
    previewFailure.value = failureOf(err, '读取文件内容')
  } finally {
    previewLoading.value = false
  }
}

/** CSV 的「编辑」：进统一外壳的表格（保持编码 / 分隔符 / 引号 / 换行，只提交改动过的格子） */
function startCsvEdit() {
  if (!isCsvFile.value) return
  // 预览还没回来时不知道是 UTF-8 小文件还是要分页的大文件，等一下（按钮在这期间是禁用的）
  if (previewLoading.value) return
  // UTF-8 且不超过 512 KB：整份文本读进来，本地适配器（有多人协同房间时借用房间文本）
  if (preview.value?.editable) {
    startFileEdit()
    return
  }
  // 超过 512 KB、或不是 UTF-8（GBK / UTF-16…）、或空文件：按页向服务端取行，保存时由服务端按原编码写回
  startCsvRemoteEdit()
}

function startCsvRemoteEdit() {
  if (props.readonly) return
  fileDraft.value = ''
  remoteDirty.value = false
  csvRemote.value = true
  fileEditEpoch.value += 1
  fileEditing.value = true
}

/**
 * 统一外壳打不开这份文件（读第一页失败、内容面加载失败等）：退出编辑回到预览，并如实提示。
 * 服务端分页的 CSV 退出时由下面的 watch 复位状态并重读预览。
 */
function onNativeFallback() {
  fileEditing.value = false
  error.value = '该文件暂时无法在编辑器里打开，已回到预览，请稍后重试'
}

/** 退出服务端分页的表格编辑：状态复位，重读预览与版本（保存过的话正文已经变了） */
watch(fileEditing, (editing) => {
  if (editing || !csvRemote.value) return
  csvRemote.value = false
  remoteDirty.value = false
  void loadPreview()
  void loadVersions()
})

/** 阅读时双击正文：和点「编辑」一样进入编辑（DocPage 负责把光标放到双击的地方）；不能编辑时什么也不做 */
function requestNoteEdit() {
  if (!isInsight.value || props.readonly || editExpanded.value) return
  editExpanded.value = true
  showRendered.value = true
}
function requestFileEdit() {
  if (fileEditing.value || !preview.value?.editable || props.readonly || extPending.value) return
  startFileEdit()
}

function startFileEdit() {
  if (props.readonly) return
  // 只有整份文件都读到了(editable)才能编辑;绝不拿一个片段当全文,保存时会把整个文件覆盖成那一段
  if (!preview.value?.editable) return
  fileDraft.value = preview.value.content ?? ''
  remoteDirty.value = false
  fileEditEpoch.value += 1
  fileEditing.value = true
}

/**
 * Markdown 文件保存（新外壳也走这里）：显式正文优先，其次异步 flush 编辑器，最后才用本机草稿。
 * 返回带版本 / 冲突细节的结果，供 Session 决定是回到 ready 还是进入 conflict。
 */
async function saveFileText(explicitText?: string): Promise<SaveResult> {
  if (props.readonly) return { ok: false, revision: 0, sha256: '', reason: '只读模式不能保存' }
  const flushed = explicitText ?? (await docPage.value?.flushAsync?.())
  if (flushed !== undefined) fileDraft.value = flushed
  return saveFileContent(fileDraft.value)
}

/**
 * 文件正文保存的唯一落点（旧 CodeMirror / 新 Host / Markdown 文件共用）。
 * 新 Host 的 SnapshotProvider 已经把正文编码好，这里只负责版本、冲突与保存后的重载；
 * 任何一条路径都不允许绕过 `expected_version`，否则冲突会被静默覆盖。
 */
async function saveFileContent(content: string, expectedRevision?: number): Promise<SaveResult> {
  if (props.readonly) return { ok: false, revision: 0, sha256: '', reason: '只读模式不能保存' }
  fileDraft.value = content
  const item = current.value
  const col = itemCollection.value
  const latest = expectedRevision ?? versions.value[0]?.version ?? 0
  if (!item || !col) return { ok: false, revision: latest, sha256: '', reason: '没有可保存的文件' }
  if (!dirtyFile.value) return { ok: true, revision: latest, sha256: '' }
  fileSaving.value = true
  try {
    const result = await callCapability<{ version: number; embedded: number; chunks: number }>('save_file', {
      collection: col,
      path: item.source,
      content: fileDraft.value,
      expected_version: latest,
    })
    toast.push(`已保存 v${result.version},重新建立了 ${result.embedded} 个内容片段的索引`)
    savedAt.value = Date.now()
    docPage.value?.saved()
    // 保存后留在编辑态(和语雀一样:保存不打断写作);「完成」才回到阅读
    await loadPreview()
    await loadVersions()
    return { ok: true, revision: result.version, sha256: '' }
  } catch (err) {
    const conflict = err instanceof CapabilityError && err.isConflict
    const message =
      conflict
        ? '这个文件刚被别人保存过(版本冲突)。请刷新页面载入最新内容后再改。'
        : failureOf(err, '保存').message
    error.value = message
    return {
      ok: false,
      revision: latest,
      sha256: '',
      reason: message,
      conflict: conflict ? { serverRevision: latest, message } : undefined,
    }
  } finally {
    fileSaving.value = false
  }
}
async function saveFileEdit(): Promise<boolean> {
  // 新 Host 自己维护正文与历史，必须让它走 session.save（Ctrl+S / 工具栏按钮同一条路），
  // 不能再从页面草稿取正文，否则撤销后的内容可能还没同步到 fileDraft。
  if (nativeFileEdit.value) {
    const host = nativeFileHost.value
    if (!host) return false
    await host.save()
    return !host.dirty
  }
  return (await saveFileText()).ok
}
async function finishFileEdit() {
  docPage.value?.flush()
  if (nativeFileEdit.value) {
    if (!(await saveFileEdit())) return
    fileEditing.value = false
    return
  }
  if (dirtyFile.value && !(await saveFileEdit())) return
  if (collab.value) {
    // 协作:内容在房间里,文件由服务端在大家安静后写盘。此刻重读可能还是旧内容,所以先显示编辑器里的最终内容
    const finalText = fileDraft.value
    fileEditing.value = false
    await loadPreview()
    if (preview.value) preview.value = { ...preview.value, content: finalText }
    return
  }
  fileEditing.value = false
}

async function loadVersions() {
  const item = current.value
  const col = itemCollection.value
  if (!item || !col) return
  try {
    const listed = await callCapability<{
      versions: { id: string; version: number; author: string | null; created_at: number; size: number; preview: string; binary?: boolean }[]
    }>('file_versions', { collection: col, path: item.source })
    versions.value = listed.versions
  } catch {
    versions.value = []
  }
}

/** 对比窗口:左边旧版、右边新版。 */
const diffOpen = ref(false)
const diffLoading = ref(false)
const diffError = ref('')
const diffBefore = ref<{ label: string; text: string } | null>(null)
const diffAfter = ref<{ label: string; text: string } | null>(null)

async function versionBody(version: { id: string; version: number; author: string | null }): Promise<{ label: string; text: string }> {
  const detail = await callCapability<{ body: string; binary: boolean }>('file_version', { version_id: version.id })
  return {
    label: `v${version.version}${version.author ? ` · ${version.author}` : ''}`,
    text: detail.binary ? '(二进制文件,不能逐行对比)' : detail.body,
  }
}

/** 对比第 index 版和它的上一版(「这次改了什么」)。 */
async function compareVersion(index: number) {
  const newer = versions.value[index]
  const older = versions.value[index + 1]
  if (!newer || !older) return
  diffOpen.value = true
  diffLoading.value = true
  diffError.value = ''
  diffBefore.value = null
  diffAfter.value = null
  try {
    const [before, after] = await Promise.all([versionBody(older), versionBody(newer)])
    diffBefore.value = before
    diffAfter.value = after
  } catch (err) {
    diffError.value = failureOf(err, '对比历史版本').message
  } finally {
    diffLoading.value = false
  }
}

/** 编辑中不让恢复:编辑器里的草稿会盖回恢复后的正文。 */
const historyLocked = computed(() => (isInsight.value ? editExpanded.value : fileEditing.value))

async function restoreVersion(id: string) {
  if (props.readonly || historyLocked.value) return
  // 恢复会改正文(并且本身记成一个新版本),先说清楚,免得手滑把刚写的盖掉
  const row = versions.value.find((version) => version.id === id)
  const ok = await confirmer.ask({
    title: `恢复到 v${row?.version ?? '?'}?`,
    message: '现在的标题、正文和标签会先存成一个版本,恢复错了还能再恢复回来。',
    confirmText: '恢复这一版',
    cancelText: '取消',
  })
  if (!ok) return
  try {
    const result = await callCapability<{ version: number; id?: string }>('restore_file_version', { version_id: id })
    toast.push(`已恢复到 v${result.version}`)
    if (isInsight.value && current.value) {
      await openItem(current.value.id, { skipGuard: true, track: false })
      // 恢复完停在「历史版本」:刚产生的那一条就在最上面,能立刻核对恢复对没对
      tab.value = 'chain'
    } else {
      await loadPreview()
    }
    await loadVersions()
  } catch (err) {
    error.value = failureOf(err, '恢复历史版本').message
  }
}

async function loadAnnotations() {
  const item = current.value
  const col = itemCollection.value
  if (!item || !col) return
  try {
    const listed = await callCapability<{ annotations: typeof annotations.value }>('list_annotations', {
      collection: col,
      source: item.source,
    })
    annotations.value = listed.annotations
  } catch {
    annotations.value = []
  }
}

/* ---------------- 选区批注:正文里选一段文字评论,评论和正文高亮互相定位 ---------------- */
/** 选中并点了「评论」、还没发出去的那段文字;发出去或取消后清掉 */
const pendingQuote = ref<QuoteAnchor | null>(null)
/** 正文里加重显示的那条评论(点评论里的引用 / 点正文高亮时设置) */
const activeQuote = ref<string | null>(null)
/** 现在正文里还能找到摘录的评论 id;null = 不知道(正文没显示出来) */
const locatedIds = ref<ReadonlySet<string> | null>(null)
/** 已有评论里锚定到文字的(顶层评论才有锚点;回复沿用不单独画) */
const quotes = computed<QuoteItem[]>(() =>
  (annotations.value as unknown as { id: string; parent_id?: string | null; resolved_at?: number | null; anchor: (QuoteAnchor & { kind: string }) | null }[])
    .filter((entry) => !entry.parent_id && entry.anchor?.kind === 'quote')
    .map((entry) => ({ id: entry.id, text: entry.anchor!.text, prefix: entry.anchor!.prefix, suffix: entry.anchor!.suffix, resolved: !!entry.resolved_at })),
)
/** Markdown 文档页现在显示着(模板里同一个条件):没显示时不判断"原文已改动" */
const quotePageShown = computed(() => !creating.value && isMarkdownFile.value && (fileEditing.value || (showRenderedMarkdown.value && !!preview.value?.content)))
function openCommentsPanel() {
  fileTab.value = 'notes'
  inspectorTemp.value = true
}
function onAnnotate(anchor: QuoteAnchor) {
  pendingQuote.value = anchor
  openCommentsPanel()
}
function onQuoteClick(id: string) {
  activeQuote.value = id
  openCommentsPanel()
  // 评论面板刚打开时才挂载:等一帧再让它滚到那条评论
  void nextTick(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-comment-id]')) {
      if (el.dataset.commentId === id) el.scrollIntoView?.({ block: 'center' })
    }
  })
}
async function locateComment(id: string) {
  activeQuote.value = id
  if (!(await docPage.value?.scrollToQuote(id))) toast.push('正文里没找到这段话,原文可能已经改动', 'warning')
}
function resetQuoteState() {
  pendingQuote.value = null
  activeQuote.value = null
  locatedIds.value = null
}

function currentAnchor(): PreviewAnchor | null {
  const chunk = preview.value?.chunks.find((entry) => entry.id === highlight.value)
  return chunk?.anchor ?? null
}


/** 点「编辑」转出副本后要自动进编辑态的那个副本路径;副本打开、预览读完(才知道能不能编辑)再进 */
const pendingEdit = ref<string | null>(null)
/** 办公文档 / PDF 这类不能直接改的文件:「编辑」改的是转出来的 Markdown 副本 */
const canCopyEdit = computed(
  () => !props.readonly && !!current.value && !isInsight.value && !creating.value && !officeEditing.value && !!preview.value && !preview.value.editable && !isMarkdownFile.value && canEditAsMarkdown(current.value.source),
)

async function findItemId(source: string): Promise<string | null> {
  const found = await callCapability<ItemList>('list_items', {
    collection: itemCollection.value,
    group_by_file: true,
    path_prefix: source,
    status: 'active',
    page: 1,
    page_size: 20,
  })
  return found.items.find((entry) => entry.source === source)?.id ?? null
}

/**
 * 编辑办公文档 / PDF:已经有副本就直接打开它(不重新转换,免得盖掉改过的内容);没有就先说清楚会发生什么,
 * 确认后转换,转完自动打开副本并进入编辑。改的是 Markdown 副本,原文件不动。
 */
async function editAsMarkdown() {
  if (props.readonly) return
  const item = current.value
  if (!item || !itemCollection.value || copying.value) return
  const copy = markdownCopyPath(item.source)
  copying.value = true
  try {
    let id = await findItemId(copy)
    if (id) {
      toast.push('这个文件已经有 Markdown 副本,直接打开它')
    } else {
      const ok = await confirmer.ask({
        title: '转成 Markdown 副本再编辑',
        message: copyEditNotice(item.source),
        confirmText: '生成副本并编辑',
        cancelText: '取消',
      })
      if (!ok) return
      const result = await callCapability<{ path: string; chunks: number; images?: number; exported_images?: number }>('convert_to_markdown', {
        collection: itemCollection.value,
        path: item.source,
      })
      const shots = result.exported_images ? `,${result.exported_images} 张图片已保留` : ''
      toast.push(`已生成副本 ${result.path}${shots}`)
      await loadItems()
      id = await findItemId(result.path)
    }
    if (!id) {
      toast.push('副本已生成,但没在列表里找到,请刷新后再打开', 'warning')
      return
    }
    pendingEdit.value = copy
    await openItem(id)
    // 没打开成(比如放弃了未保存的修改):别让标记留着,以后手动打开这个副本时被自动拉进编辑
    if (selectedId.value !== id) pendingEdit.value = null
  } catch (err) {
    pendingEdit.value = null
    error.value = failureOf(err, '转换为 Markdown').message
  } finally {
    copying.value = false
  }
}
watch(preview, (value) => {
  const want = pendingEdit.value
  if (!want || !value || current.value?.source !== want) return
  pendingEdit.value = null
  if (value.editable) startFileEdit()
  else toast.push('这份副本太大,不能在这里直接编辑', 'warning')
})

async function convertToMarkdown() {
  if (props.readonly) return
  const item = current.value
  if (!item || !itemCollection.value) return
  copying.value = true
  try {
    const result = await callCapability<{ path: string; chunks: number }>('convert_to_markdown', {
      collection: itemCollection.value,
      path: item.source,
    })
    toast.push(`已生成副本 ${result.path}(${result.chunks} 个内容片段)`)
    await loadItems()
  } catch (err) {
    error.value = failureOf(err, '转换为 Markdown').message
  } finally {
    copying.value = false
  }
}

/**
 * 乐观锁要的版本号。`get_item` 详情里带 insight 的版本,优先用它;
 * 老服务端没有这个字段时退回列表,再退回按标题回查——拿兜底的 1 去提交只会换来版本冲突。
 */
async function itemVersion(item: RecordRow): Promise<number> {
  const fromDetail = selected.value?.version
  if (fromDetail) return fromDetail
  const cached = list.value?.items.find((row) => row.id === item.id)?.version
  if (cached) return cached
  try {
    const page = await callCapability<ItemList>('list_items', { collection: item.collection, q: item.title ?? undefined, page_size: 50 })
    return page.items.find((row) => row.id === item.id)?.version ?? 1
  } catch {
    return 1
  }
}

/**
 * 保存笔记（新外壳与旧编辑器共用）：显式正文优先（新外壳把序列化结果直接交过来），
 * 否则先异步 flush 编辑器，避免拿到上一拍的正文。
 */
async function saveText(explicitText?: string): Promise<SaveResult> {
  if (props.readonly) return { ok: false, revision: 0, sha256: '', reason: '只读模式不能保存' }
  const flushed = explicitText ?? (await docPage.value?.flushAsync?.())
  if (flushed !== undefined) draftBody.value = flushed
  const item = current.value
  if (!item) return { ok: false, revision: 0, sha256: '', reason: '没有打开的条目' }
  if (!dirty.value || saving.value) {
    return { ok: false, revision: 0, sha256: '', reason: saving.value ? '正在保存' : '没有需要保存的改动' }
  }
  saving.value = true
  error.value = ''
  try {
    if (isInsight.value) {
      const updated = await callCapability<{ id: string; version: number; job_id: string | null }>('edit_item', {
        id: item.id,
        version: await itemVersion(item),
        title: draftTitle.value,
        // 协作中的正文由协作连接落地;这里再带上 body 会和房间里的内容打架(后端也会因为房间忙而拒绝)
        ...(collab.value ? {} : { body: draftBody.value }),
        tags: draftTags.value,
      })
      toast.push(`已保存,版本 ${updated.version}${updated.job_id ? ' · 正在重新建立索引' : ''}`)
      savedAt.value = Date.now()
      docPage.value?.saved()
      // 列表刷新和正文重载互不依赖:并行发,少等一个往返(保存后的「要等一会才更新」主要来自这里)
      await Promise.all([loadItems({ keepOrder: true }), openItem(item.id, { skipGuard: true, keepEditing: true })])
      return { ok: true, revision: updated.version, sha256: '' }
    }
    await callCapability('edit_item', { id: item.id, tags: draftTags.value })
    toast.push('标签已保存')
    savedAt.value = Date.now()
    await Promise.all([loadItems({ keepOrder: true }), openItem(item.id, { skipGuard: true, keepEditing: true })])
    return { ok: true, revision: 0, sha256: '' }
  } catch (err) {
    const conflict = err instanceof CapabilityError && err.isConflict
    if (conflict) {
      error.value = '这篇笔记刚被别人改过(版本冲突)。请刷新页面载入最新内容后再改。'
      toast.push(error.value, 'danger')
    } else {
      error.value = failureOf(err, '保存').message
    }
    return {
      ok: false,
      revision: 0,
      sha256: '',
      reason: error.value,
      conflict: conflict ? { serverRevision: 0, message: error.value } : undefined,
    }
  } finally {
    saving.value = false
  }
}
async function save(): Promise<boolean> {
  return (await saveText()).ok
}
/** 轮询：库里这篇笔记的正文是否已经等于 text（忽略末尾空白）；超时返回 false */
async function waitStoredBody(id: string, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const want = text.trimEnd()
  while (Date.now() < deadline) {
    try {
      const detail = await callCapability<ItemDetail>('get_item', { id })
      if (detail.item.text.trimEnd() === want) return true
    } catch {
      // 读不到就继续等，超时统一处理
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}
/** 「保存」:有改动先保存,保存成功再回到阅读视图(唯一的提交入口) */
async function finishEditing() {
  docPage.value?.flush()
  if (collab.value && current.value) {
    // 协作:正文由落地者提交。先落地并等服务端确认,再重新读条目,否则读到的是落地之前的旧正文
    const id = current.value.id
    const { landAndWait } = await import('@/collab/landing')
    const finalText = docPage.value?.flush() ?? null
    const room = collab.value
    const wasLander = room.getState().lander
    // 我不是落地者（同一篇笔记的另一个窗口 / 另一台设备是）：请它立刻提交，并等库里的正文变成我编辑器里的内容。
    // 以前这里直接当作成功：落地者认为只有自己在、把请求当草稿忽略，正文根本没进库，
    // 页面却回到阅读、显示旧内容（删掉的块「保存后又出现了」）
    if (!wasLander && finalText !== null) {
      room.requestSave()
      saving.value = true
      const stored = await waitStoredBody(id, finalText, 10_000).finally(() => (saving.value = false))
      if (!stored) {
        toast.push('正文没有保存到库里：这篇笔记在另一个窗口也开着，但那边没有响应。内容还在这里，请关掉其他窗口后再点保存', 'danger')
        return
      }
    }
    const landed = await landAndWait(room, () => finalText)
    // 点「保存」就是存一个版本：趁连接还在发出去（以前放在最后，那时连接已经被清掉，这一步从来没发出过）
    if (landed) room.savePoint()
    // 落地之后先把条目读回来:正文已经进库,再拿落地前的旧正文比「脏」会白跑一次保存(还会撞版本冲突)
    await loadItems({ keepOrder: true })
    await openItem(id, { skipGuard: true, keepEditing: true })
    const titleChanged = draftTitle.value !== (current.value?.title ?? '')
    const tagsChanged = draftTags.value.join('\u0000') !== (current.value?.tags ?? []).join('\u0000')
    if (titleChanged || tagsChanged) {
      if (!(await save())) return
    }
    // 落地没成功(掉线 / 有人正在写):正文还在房间里,本机也有草稿,不能当成已经保存
    if (!landed && dirty.value) toast.push('正文还没落到库里,先留在协作房间和本机草稿里', 'danger')
    // 点「保存」= 把正文交给房间:落地成功(含「我不是落地者、由房间里另一个人接续落地」)就清掉本机那份
    // 「房间镜子」,否则下次打开会被当成没写完的草稿又拉进编辑态。不能拿 dirty 当条件:我不是落地者时
    // 读回来的还是落地前的旧正文,比出来的「脏」永远为真,镜子反而会一直留着(真实 e2e 的分享步骤就这么红过)。
    // 强制清是安全的:land 发出去的是编辑器此刻的整篇 Markdown,正文已经在守护进程的房间里。
    if (landed) docPage.value?.saved(true)
    // 我不是落地者时,落地由房间里另一个人在他那边安静后完成,此刻读到的可能还是旧正文:先显示我自己编辑器里的内容
    if (!wasLander && finalText !== null && selected.value) selected.value = { ...selected.value, item: { ...selected.value.item, text: finalText } }
  } else if (dirty.value && !(await save())) return
  editExpanded.value = false
  showRendered.value = true
  // 保存就是新版本:右栏的历史版本列表跟着刷新。协作的保存点由服务端异步落库,晚一拍再取一次
  void loadVersions()
  if (collab.value) setTimeout(() => void loadVersions(), 800)
}
async function cancelFileEdit() {
  docPage.value?.flush()
  if (collab.value) {
    // 协作中改动已经同步给大家了,没有「放弃」可言:直接退出编辑
    await finishFileEdit()
    return
  }
  if (dirtyFile.value) {
    const ok = await confirmer.ask({ title: '放弃未保存的修改?', message: '这个文件的改动不会保留。', confirmText: '放弃修改', cancelText: '继续编辑', tone: 'danger' })
    if (!ok) return
  }
  fileEditing.value = false
}

/** 「取消」:不提交服务器,只退出编辑;改动留在本机草稿里,下次点「编辑」自动接着改 */
async function cancelNoteEdit() {
  docPage.value?.flush()
  // 多人编辑:改动已经同步到房间里(存在守护进程上,别人也看得到),退出编辑不会丢,但也不落地
  await nextTick()
  if (collab.value) {
    // 立刻把镜子写进本机草稿(别等防抖),刷新后还能接着看
    docPage.value?.persistDraft()
  } else if (!(await confirmDiscard())) return
  editExpanded.value = false
  showRendered.value = true
}

/**
 * 「放弃修改」:标题 / 正文 / 标签都回到服务器上保存的那一版,并清掉本机草稿。
 * 和正文工具栏的「撤销」不同——撤销是一步一步回退刚才敲的字,放弃修改是一键回到上次保存的样子。
 */
async function revertNoteEdit() {
  if (!current.value || !isInsight.value || !dirty.value || saving.value) return
  const itemId = current.value.id
  // 阅读态:没保存的正文在协作房间里(退出编辑时房间已经销毁),得回房间把内容换回保存版
  const viaRoom = !editExpanded.value && collabCapable.value
  const ok = await confirmer.ask({
    title: '放弃没保存的修改?',
    message: viaRoom
      ? '标题、正文和标签都回到上次保存的版本,本机草稿也一起清掉。会先进一下编辑把房间里的正文换回保存版(不会写成新版本)。放弃后没法再找回。'
      : '标题、正文和标签都回到上次保存的版本,本机草稿也一起清掉,放弃后没法再找回。',
    confirmText: '放弃修改',
    cancelText: '继续编辑',
    tone: 'danger',
  })
  if (!ok) return
  if (viaRoom) {
    editExpanded.value = true
    showRendered.value = false
    const ready = await waitCollabReady()
    // 等房间的这会儿用户可能已经换了文档
    if (current.value?.id !== itemId) return
    docPage.value?.revertToSaved()
    if (ready) {
      // 等这一笔 Yjs 更新发到守护进程,再退出(退出会关掉房间连接)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    void cancelNoteEdit()
    toast.push('已放弃修改,回到上次保存的版本')
    return
  }
  docPage.value?.revertToSaved()
  toast.push('已放弃修改,回到上次保存的版本')
}

/** 等协作房间连上并拿到内容(最多 6 秒);等不到就按单人处理 */
async function waitCollabReady(): Promise<boolean> {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const provider = collab.value
    if (provider && !collabPending.value) {
      const state = provider.getState()
      if (state.ready || state.everSynced) return true
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  return false
}

async function startCreate() {
  if (props.readonly) return
  // 已经在写新笔记:再点「新建」不该清空正在写的内容(草稿也会跟着被清掉)
  if (creating.value) return
  if (!(await confirmDiscard())) return
  creating.value = true
  enterDoc()
  selectedId.value = null
  selected.value = null
  newTitle.value = ''
  newBody.value = ''
  newTags.value = []
  newKind.value = 'note'
}
async function createInsight() {
  if (props.readonly) return
  docPage.value?.flush()
  if (!newTitle.value.trim() || !newBody.value.trim()) return
  try {
    const created = await callCapability<{ id: string }>('create_item', {
      collection: collection.value,
      title: newTitle.value.trim(),
      body: newBody.value,
      kind: newKind.value,
      tags: newTags.value,
    })
    docPage.value?.saved()
    creating.value = false
    await Promise.all([loadItems(), loadKindCounts()])
    toast.push('已新建笔记,正在建立索引')
    void shell.refresh(true)
    if (created?.id) await openItem(created.id, { skipGuard: true })
  } catch (err) {
    error.value = failureOf(err, '新建笔记').message
  }
}
async function remove() {
  if (props.readonly) return
  const item = current.value
  if (!item) return
  const ok = await confirmer.ask({
    title: '删除这篇笔记?',
    message: '可以在「审计 / 批次」里撤销。',
    confirmText: '删除',
    tone: 'danger',
    doneText: '已删除',
    action: () => callCapability('delete_item', { id: item.id }),
  })
  if (!ok) return
  selected.value = null
  selectedId.value = null
  await Promise.all([loadItems(), loadKindCounts()])
  toast.push('已删除(可在审计页撤销)')
}

function exportList() {
  if (props.readonly) return
  const rows = list.value?.items ?? []
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${collection.value.replace(/[^\w-]+/g, '_') || 'items'}-p${page.value}.json`
  link.click()
  URL.revokeObjectURL(link.href)
  toast.push(`已导出 ${rows.length} 条`)
}

/* ------------------------------------------------------------------ 过滤输入 */
function applyFilterText(complete: boolean) {
  let text = filterText.value
  const tokens = [...text.matchAll(/(?:^|\s)(kind|tag|dir|status):(\S+)(?=\s|$)/g)]
  const trailingOpen = !complete && !/\s$/.test(text)
  for (const match of tokens) {
    const isLast = match.index! + match[0].length === text.length
    if (isLast && trailingOpen) continue
    const [whole, key, val] = match as unknown as [string, string, string]
    if (key === 'kind') setKind(val)
    else if (key === 'tag') tag.value = val
    else if (key === 'dir') dir.value = val
    else if (key === 'status') status.value = val
    text = text.replace(whole, ' ')
  }
  filterText.value = text.replace(/\s+/g, ' ').trimStart()
  const free = filterText.value.trim()
  if (free !== q.value && (complete || !/\S+:\S*$/.test(free))) q.value = free
}
function setKind(val: string) {
  if (!val || RECORD_KINDS.includes(val)) {
    kind.value = val
    insightKind.value = ''
  } else {
    insightKind.value = val
  }
}
function removeChip(key: string) {
  if (key === 'kind') {
    kind.value = ''
    insightKind.value = ''
    dir.value = ''
  } else if (key === 'dir') dir.value = ''
  else if (key === 'tag') tag.value = ''
  else if (key === 'status') status.value = 'active'
  else if (key === 'q') {
    q.value = ''
    filterText.value = ''
  }
}

let filterTimer: number | undefined
watch(filterText, () => {
  window.clearTimeout(filterTimer)
  filterTimer = window.setTimeout(() => applyFilterText(false), 300)
})

/* ------------------------------------------------------------------ 联动 */
async function selectCollection(name: string) {
  if (name === collection.value && !kind.value && !insightKind.value && !dir.value) {
    expanded.value[name] = !expanded.value[name]
    return
  }
  if (!(await confirmDiscard())) return
  collection.value = name
  kind.value = ''
  insightKind.value = ''
  dir.value = ''
  expanded.value[name] = true
  // 同步到 URL:深链可分享,悬浮管家也能据此知道当前项目;嵌入在弹窗里时不能改地址栏
  if (!props.embedded) void router.replace({ query: { ...route.query, collection: name } })
}
function selectKind(val: string) {
  kind.value = kind.value === val ? '' : val
  sidebarTab.value = 'files'
}
/** 点集合左边的箭头:当前集合只切换展开;别的集合要先切过去,因为分类数据只有当前集合才有 */
function toggleCollection(name: string) {
  if (name === collection.value) expanded.value[name] = !expanded.value[name]
  else void selectCollection(name)
}
/**
 * 点「类型」行(decision / pitfall …)。
 * 有子目录:留在树里原地展开,让人继续往下选目录,不跳走(以前一点就跳到列表,子目录根本看不到);
 * 没有子目录:没什么可展开的,直接去看这一类的文档。
 * 再点一次已展开的这一类是收起并取消筛选;没有子目录的叶子不做「取消」,取消靠筛选条上的 ✕。
 */
function selectFacet(facet: Facet) {
  const hasDirs = !!facet.dirs?.length
  const same = insightKind.value === facet.kind && !dir.value
  const collapse = hasDirs && same && !!facetOpen.value[facet.kind]
  insightKind.value = collapse ? '' : facet.kind
  dir.value = ''
  kind.value = ''
  facetOpen.value[facet.kind] = hasDirs && !collapse
  if (!hasDirs) sidebarTab.value = 'files'
}
function selectFacetDir(facetKind: string, val: string) {
  insightKind.value = facetKind
  dir.value = val
  kind.value = ''
  sidebarTab.value = 'files'
}

let ready = false
watch([collection], () => {
  if (!ready) return
  void loadTree({ reset: true })
  tag.value = ''
  q.value = ''
  filterText.value = ''
})
watch([collection, kind, insightKind, status, tag, dir, q, sort, pageSize], () => {
  if (!ready) return
  page.value = 1
  if (!props.embedded) localStorage.setItem('kb.browser.pageSize', String(pageSize.value))
  void loadItems().then(resetListScroll)
  if (props.embedded) return
  const next: Record<string, string> = {}
  if (collection.value) next.collection = collection.value
  if (insightKind.value || kind.value) next.kind = insightKind.value || kind.value
  if (dir.value) next.dir = dir.value
  void router.replace({ query: next })
})
watch(page, () => ready && void loadItems().then(resetListScroll))
watch(status, () => {
  if (!ready) return
  void loadTree()
})
watch(
  () => [route.query.collection, route.query.kind],
  ([nextCollection, nextKind]) => {
    if (props.embedded) return
    if (typeof nextCollection === 'string' && nextCollection !== collection.value) {
      const hit = collections.value.find((entry) => entry.name === nextCollection)
      if (hit) collection.value = hit.name
    }
    const wanted = typeof nextKind === 'string' ? nextKind : ''
    if (wanted !== (insightKind.value || kind.value)) setKind(wanted)
  },
)

async function openFromQuery() {
  const path = route.query.path
  if (typeof path !== 'string' || !collection.value) return false
  try {
    const found = await callCapability<ItemList>('list_items', {
      collection: collection.value,
      status: 'all',
      q: path,
      page: 1,
      page_size: 20,
    })
    const match = found.items.find((item) => item.source === path) ?? found.items[0]
    if (match) {
      await openItem(match.id, { skipGuard: true })
      tab.value = 'preview'
      return true
    }
  } catch {
    // 忽略
  }
  return false
}

/**
 * 已经在知识库页时,通知 / 助手里的文档引用会把地址换成另一篇文档(?item= 或 ?path=):文档也要跟着换。
 * 以前只在页面挂载时读一次这两个参数,所以地址变了、屏幕上还是原来那篇。
 * openItem 自己会 router.replace 把 item 写回地址,值和当前文档一致,不会再触发打开。
 */
watch(
  () => [route.query.item, route.query.path],
  ([nextItem, nextPath]) => {
    if (!ready || props.embedded) return
    if (typeof nextItem === 'string' && nextItem) {
      if (nextItem !== selectedId.value) void openItem(nextItem)
    } else if (typeof nextPath === 'string' && nextPath && nextPath !== current.value?.source) {
      void openFromQuery()
    }
  },
)

/* ------------------------------------------------------------------ 文档顶栏 */
const crumbCollection = computed(() => (creating.value ? collection.value : (current.value?.collection ?? collection.value)) || '知识库')
const crumbMiddle = computed(() => {
  const item = current.value
  if (creating.value || !item) return []
  if (isInsight.value) return [kindText(item.insight_kind) || '笔记']
  const parts = item.source.split('/').slice(0, -1)
  if (parts[0] === '_attachments') return ['附件']
  return parts.length > 2 ? ['…', parts[parts.length - 1]!] : parts
})
/**
 * 文档顶栏的位置（集合 / 种类或目录）：文档所在的集合就是工作台顶栏里正在浏览的那个时，集合不再写第二遍
 * （宽屏上两行紧挨着都是「knowledgeBase/insights」）；从搜索、别的集合打开的文档照常写出集合，免得认错位置。
 */
const crumbTrail = computed(() => {
  const own = creating.value ? collection.value : (current.value?.collection ?? collection.value)
  const showCollection = !collection.value || own !== collection.value
  return [...(showCollection ? [{ text: crumbCollection.value, col: true }] : []), ...crumbMiddle.value.map((text) => ({ text, col: false }))]
})
const crumbLeaf = computed(() => {
  if (creating.value) return newTitle.value.trim() || '未命名笔记'
  const item = current.value
  if (!item) return ''
  if (isInsight.value) return draftTitle.value.trim() || item.title || '无标题'
  return item.source.startsWith('_attachments/') ? displayName(item.source) : fileName.value || item.title || item.source
})

const moreOpen = ref(false)
// 弹窗里不读管理员自己的宽屏偏好,也不在切换时写回去
const fullWidthOn = ref(!props.embedded && localStorage.getItem('kb.doc.fullwidth') === '1')
interface MoreEntry {
  label?: string
  hint?: string
  run?: () => void
  danger?: boolean
  checked?: boolean
  sep?: boolean
}
const hasDocPage = computed(() => creating.value || isInsight.value || (isMarkdownFile.value && (fileEditing.value || showRenderedMarkdown.value)))
const moreItems = computed<MoreEntry[]>(() => {
  const items: MoreEntry[] = []
  // 只读查看:不给导出 / 下载 / 转换 / 移动 / 删除;属性和历史照样能看
  if (props.readonly) {
    if (hasDocPage.value) {
      items.push({ label: '宽屏模式', checked: fullWidthOn.value, run: () => { docPage.value?.toggleFullWidth(); fullWidthOn.value = !fullWidthOn.value } })
      items.push({ sep: true })
    }
    if (current.value) items.push({ label: inspectorOpen.value ? '收起属性面板' : '属性、内容片段与历史', run: toggleInspector })
    if (current.value && !narrow.value) items.push({ label: zenMode.value ? '退出专注' : '专注模式', hint: '隐藏目录栏', run: toggleZen })
    items.push({ sep: true })
    items.push({ label: '切换到数据表格', run: () => setViewMode('table') })
    return items
  }
  const editingDoc = (isInsight.value && editExpanded.value) || fileEditing.value || creating.value
  if (hasDocPage.value && editingDoc) items.push({ label: '查找替换', hint: 'Ctrl+F', run: () => docPage.value?.openFind() })
  if (hasDocPage.value && editingDoc) items.push({ label: '快捷键一览', hint: 'Ctrl+/', run: () => docPage.value?.openShortcuts() })
  if (isInsight.value && !editExpanded.value) items.push({ label: showRendered.value ? '查看 Markdown 源码' : '回到文档', run: () => (showRendered.value = !showRendered.value) })
  if (isMarkdownFile.value && !fileEditing.value) items.push({ label: showRenderedMarkdown.value ? '查看 Markdown 源码' : '回到文档', run: () => (showRenderedMarkdown.value = !showRenderedMarkdown.value) })
  if (hasDocPage.value) {
    items.push({ label: '宽屏模式', checked: fullWidthOn.value, run: () => { docPage.value?.toggleFullWidth(); fullWidthOn.value = !fullWidthOn.value } })
    items.push({ sep: true })
    items.push({ label: '导出 Markdown', run: () => docPage.value?.exportMarkdown() })
    items.push({ label: '复制 Markdown', run: async () => toast.push((await docPage.value?.copyMarkdown()) ? '已复制 Markdown' : '复制失败(浏览器不允许访问剪贴板)') })
    items.push({ label: '打印 / 存为 PDF', run: () => docPage.value?.print() })
  }
  if (current.value && !isInsight.value) {
    items.push({ sep: true })
    if (downloadUrl.value) items.push({ label: '下载原件', run: () => (interceptInAppDownload() ? undefined : window.open(downloadUrl.value!, '_blank', 'noopener')) })
    if (!preview.value?.editable && !isMarkdownFile.value && preview.value) items.push({ label: copying.value ? '转换中…' : '转为 Markdown 副本编辑', run: () => void (canCopyEdit.value ? editAsMarkdown() : convertToMarkdown()) })
  }
  if (current.value && !creating.value) {
    items.push({ sep: true })
    items.push({ label: inspectorOpen.value ? '收起属性面板' : '属性、内容片段与历史', run: toggleInspector })
    if (!narrow.value) items.push({ label: zenMode.value ? '退出专注' : '专注模式', hint: '隐藏目录栏', run: toggleZen })
  }
  items.push({ sep: true })
  if (current.value && !isInsight.value && current.value.source) {
    items.push({ label: '移动文件…', run: () => openCurrentFileAction('move') })
    items.push({ label: '删除文件…', danger: true, run: () => openCurrentFileAction('delete') })
  }
  items.push({ label: '切换到数据表格', run: () => setViewMode('table') })
  if (isInsight.value && current.value) items.push({ label: '删除这条笔记', danger: true, run: () => void remove() })
  // 去掉首尾 / 连续的分隔线
  return items.filter((entry, at, all) => !entry.sep || (at > 0 && at < all.length - 1 && !all[at - 1]!.sep))
})
function closeMore(event: MouseEvent) {
  if (rowMenu.value && !(event.target as HTMLElement).closest('.kb-row-menu')) rowMenu.value = null
  if (!moreOpen.value) return
  if ((event.target as HTMLElement).closest('.kb-more')) return
  moreOpen.value = false
}

/** 通知跳转地址里的文档位置 → 资源(只认文档:笔记或文件) */
function targetFromQuery(space: string, query: Record<string, unknown>): ShareTarget | null {
  const collection = typeof query.collection === 'string' ? query.collection : ''
  if (!collection) return null
  if (typeof query.item === 'string' && query.item) return { kind: 'insight', space_id: space, collection, id: query.item }
  if (typeof query.path === 'string' && query.path) return { kind: 'file', space_id: space, collection, path: query.path }
  return null
}

/* ------------------------------------------------------------------ 我的知识库 / 共享给我 */
// 接收分享不需要功能点,所以切换条对所有人显示。共享的内容读写都带 X-KB-Space 走对方的知识库,
// 与我自己的知识库(下面所有的 callCapability)互不相干,所以「共享给我」整个是独立的侧栏 + 工作区。
const scope = ref<'mine' | 'shared'>(!props.embedded && route.query.scope === 'shared' ? 'shared' : 'mine')
const shared = useSharedWithMe()
const sharedActive = ref<SharedWithMeItem | null>(null)
/** 从通知点进来时要在共享内容里直接打开的那篇文档(授权可能是它的上级目录 / 集合) */
const sharedFocus = ref<ShareTarget | null>(null)
const scopeOptions = computed(() => [
  { value: 'mine', label: '我的知识库' },
  { value: 'shared', label: shared.count.value ? `共享给我 ${shared.count.value}` : '共享给我' },
])
function setScope(value: string) {
  scope.value = value === 'shared' ? 'shared' : 'mine'
  if (props.embedded) return
  const query = { ...route.query }
  if (scope.value === 'shared') query.scope = 'shared'
  else {
    delete query.scope
    delete query.open
  }
  void router.replace({ query })
  if (scope.value === 'shared') void shared.load()
  // 单栏 / 两栏版面里列表可能不在眼前:切换范围总是先回到列表,让人看到新范围的内容
  showList()
}
function openShared(item: SharedWithMeItem) {
  if (props.embedded) return
  if (sharedActive.value?.key !== item.key) sharedFocus.value = null
  const changed = sharedActive.value?.key !== item.key
  sharedActive.value = item
  enterDoc(changed)
  void router.replace({ query: { ...route.query, scope: 'shared', open: item.key } })
}
async function hideShared(items: SharedWithMeItem[], hidden: boolean) {
  const { done, failed } = await shared.setHidden(items.map((item) => item.target), hidden)
  const verb = hidden ? '移出' : '放回'
  if (failed) toast.push(`${done} 项已${verb},${failed} 项没有成功,请再试一次`, 'danger')
  else toast.push(hidden ? `已移出 ${done} 项。只是不再显示,授权还在,随时可以放回` : `已放回 ${done} 项`)
  // 正在看的那份被移出了(且不显示已移出的):回到列表
  if (hidden && !shared.showHidden.value && sharedActive.value && items.some((item) => item.key === sharedActive.value?.key)) {
    sharedActive.value = null
    showList()
  }
}
function backFromShared() {
  showList()
}
// 深链:/kb?scope=shared&open=<资源键>(通知里「收到分享」可以直接跳进来)
onMounted(async () => {
  // 弹窗里不碰分享:目标库的分享列表不在只读白名单里,也不该把管理员的分享混进来
  if (props.embedded) return
  await shared.load()
  const wanted = route.query.open
  if (scope.value === 'shared' && typeof wanted === 'string') {
    const found = shared.items.value.find((item) => item.key === wanted)
    if (found) openShared(found)
  } else if (scope.value === 'shared' && typeof route.query.space === 'string') {
    // 通知里别人知识库的文档:用地址里的 space + 位置找覆盖它的授权。找不到就说明授权已被收回(对陌生人也是同一句话,不泄露文档存不存在)
    const doc = targetFromQuery(route.query.space, route.query)
    const found = doc ? bestCovering(shared.items.value, doc) : null
    if (found && doc) {
      sharedFocus.value = doc
      openShared(found)
    } else {
      toast.push('没有找到分享给你的这篇文档,可能已经被取消分享了', 'warning')
    }
  }
})

/* ------------------------------------------------------------------ 多选（设计规范） */
// 目录和文件可以混选、可以跨集合、一次最多 500 项;选中后批量分享 / 生成合集链接。
// 入口:点「选择」、Ctrl/⌘ + 点击、Shift + 点击连选,触屏长按。只有能分享的账号才有多选(它只服务于分享)。
const sel = ref<SelectionState>({ selected: [], anchor: null, selecting: false })
/** 选过的项的资源和名字(跨页、跨集合也记得住) */
const selMeta = new Map<string, { target: ShareTarget; title: string }>()
const selectingNow = computed(() => sel.value.selecting || sel.value.selected.length > 0)
const selectedTargets = computed(() => sel.value.selected.map((key) => selMeta.get(key)).filter((entry): entry is { target: ShareTarget; title: string } => !!entry))

/** 列表里一行对应的资源;网页来源这类造不出资源键的返回 null(不能选) */
function rowShareTarget(row: ItemSummary): ShareTarget | null {
  if (row.kind === 'insight') return { kind: 'insight', collection: row.collection, id: row.id }
  if (!row.source || /^[a-z][a-z0-9+.-]*:\/\//i.test(row.source)) return null
  return { kind: 'file', collection: row.collection, path: row.source }
}
/** 当前可见的列表顺序(同一个文件的多块只算一项):Shift 连选按它算 */
const listOrder = computed(() => {
  const keys: string[] = []
  for (const row of list.value?.items ?? []) {
    const target = rowShareTarget(row)
    if (target && !keys.includes(targetKey(target))) keys.push(targetKey(target))
  }
  return keys
})
// 看到过的每一行都记下它的资源和名字:Shift 连选 / 全选会一次选中很多行,没点过的行也要能找到它的资源
watch(
  () => list.value?.items,
  (rows) => {
    for (const row of rows ?? []) {
      const target = rowShareTarget(row)
      if (target) selMeta.set(targetKey(target), { target, title: rowTitle(row) })
    }
  },
  { immediate: true },
)
const collectionTarget = (name: string): ShareTarget => ({ kind: 'collection', collection: name })
const dirTarget = (col: string, path: string): ShareTarget => ({ kind: 'dir', collection: col, path })
const collectionOrder = computed(() => collections.value.map((entry) => targetKey(collectionTarget(entry.name))))

function applySelection(result: ReturnType<typeof pick>) {
  sel.value = { selected: result.selected, anchor: result.anchor, selecting: result.selecting }
  if (result.dropped) toast.push(`一次最多选 ${MAX_SELECTION} 项,多出的 ${result.dropped} 项没有选上`, 'danger')
}
function clearSelection() {
  sel.value = { selected: [], anchor: null, selecting: false }
}
function toggleSelecting() {
  if (selectingNow.value) clearSelection()
  else sel.value = { ...sel.value, selecting: true }
}
function selectAllVisible() {
  const result = selectAll(listOrder.value)
  sel.value = { selected: result.selected, anchor: result.selected[0] ?? null, selecting: true }
  if (result.dropped) toast.push(`一次最多选 ${MAX_SELECTION} 项,多出的 ${result.dropped} 项没有选上`, 'danger')
}

const rowPress = useLongPress(() => {
  const row = pressedRow
  if (!row || props.readonly) return
  // 手机长按文件:先给文件操作(第一项是多选),不再直接进选择模式;
  // 笔记没有文件操作,保持原来的「长按多选」。
  if (row.kind !== 'insight' && row.source && !/^[a-z][a-z0-9+.-]*:\/\//i.test(row.source) && !selectingNow.value) {
    fileActions.openSheet({ collection: row.collection, path: row.source, name: rowTitle(row) })
    return
  }
  const target = rowShareTarget(row)
  if (!target || !canShare.value) return
  const key = targetKey(target)
  selMeta.set(key, { target, title: rowTitle(row) })
  applySelection(pick(listOrder.value, sel.value, key, { ctrl: true, shift: false, selecting: true }))
})
let pressedRow: ItemSummary | null = null
function rowPressStart(event: PointerEvent, row: ItemSummary) {
  if (!canShare.value && row.kind === 'insight') return
  pressedRow = row
  rowPress.start(event)
}

function onRowClick(event: MouseEvent | KeyboardEvent, row: ItemSummary) {
  if (rowPress.consumeClick()) return
  const target = canShare.value ? rowShareTarget(row) : null
  if (!target) {
    // 选择模式下点到不能分享的内容:不要顺手把它打开(用户以为自己在勾选)
    if (!(canShare.value && selectingNow.value)) void openItem(row.id)
    return
  }
  const key = targetKey(target)
  selMeta.set(key, { target, title: rowTitle(row) })
  const result = pick(listOrder.value, sel.value, key, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey, selecting: sel.value.selecting })
  if (result.handled) applySelection(result)
  else void openItem(row.id)
}
function onCollectionClick(event: MouseEvent | KeyboardEvent | undefined, name: string) {
  if (canShare.value) {
    const target = collectionTarget(name)
    const key = targetKey(target)
    selMeta.set(key, { target, title: name })
    const result = pick(collectionOrder.value, sel.value, key, { ctrl: !!(event?.ctrlKey || event?.metaKey), shift: !!event?.shiftKey, selecting: sel.value.selecting })
    if (result.handled) {
      applySelection(result)
      return
    }
  }
  void selectCollection(name)
}
const isSelected = (target: ShareTarget | null) => !!target && sel.value.selected.includes(targetKey(target))

function shareSelected(tab: 'people' | 'link') {
  const entries = selectedTargets.value
  if (!entries.length) return
  openShare(
    entries.map((entry) => entry.target),
    Object.fromEntries(entries.map((entry) => [targetKey(entry.target), entry.title])),
    tab,
  )
}

/* ------------------------------------------------------------------ 分享 */
// 入口按功能点显示(没有 collab.share 的账号看不到);隐藏只是体验,后端对每次授权照样检查
const canShareBase = useFeature('collab.share')
const canShare = computed(() => !props.readonly && canShareBase.value)

/* ------------------------------------------------------------------ 文件操作(删除 / 移动) */
// 右键 / Shift+F10 / 手机长按都走同一套动作:先问服务端能不能做,再确认。
// 删除 / 移动成功后刷新树与列表;当前打开的就是被改动的文件(或它所在的文件夹)时,退回列表,
// 避免屏幕上还留着一份已经不存在的文档。
function insideOrSame(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`)
}
const fileActions = useFileActions({
  onChanged: async (changed: FileTarget) => {
    if (current.value && !isInsight.value && insideOrSame(current.value.source, changed.path)) {
      selected.value = null
      selectedId.value = null
      creating.value = false
      void router.replace({ path: PATHS.kb, query: { collection: collection.value } })
    }
    await loadTree()
    await loadItems()
  },
})
// 模板里访问组合式函数内部的 ref 需要先拿到顶层绑定(Vue 只自动解包顶层 ref)
const fileMenu = fileActions.menu
const fileDialog = fileActions.dialog
const fileTarget = fileActions.target
const fileActionsInfo = fileActions.actions
const fileBusy = fileActions.busy
const fileResult = fileActions.result
const fileError = fileActions.error
/** 可移动到的目标目录:优先用服务端返回的全部目录前缀;旧后端退回分类里的一级目录。 */
const moveDirs = computed(() => {
  const fromServer = facetDirs.value
  const fallback = (facets.value ?? []).flatMap((facet) => (facet.dirs ?? []).map((entry) => entry.dir))
  return [...new Set(fromServer.length ? fromServer : fallback)].sort()
})
function openFileMenu(event: MouseEvent, row: ItemSummary) {
  if (props.readonly || row.kind === 'insight' || selectingNow.value) return
  if (!row.source || /^[a-z][a-z0-9+.-]*:\/\//i.test(row.source)) return
  const target = { collection: row.collection, path: row.source, name: rowTitle(row) }
  fileActions.openAt(event, target)
}
function openDirMenuByKeyboard(collectionName: string, path: string) {
  openDirMenu(new MouseEvent('contextmenu', { clientX: 48, clientY: 180 }), collectionName, path)
}
function openDirMenu(event: MouseEvent, collectionName: string, path: string) {
  if (props.readonly || selectingNow.value) return
  fileActions.openAt(event, { collection: collectionName, path, name: path, folder: true })
}

/* ------------------------------------------------------------------ 非文件行的右键菜单 */
// 文件走 FileActionMenu(移动 / 删除原件);笔记、集合这些没有原件可动,以前右键直接 return,
// 桌面端看起来就是「右键没反应」。这里按行类型给一份各自能做的事,和手机长按的反馈对齐。
const rowMenu = ref<RowMenuState | null>(null)
function openRowMenu(event: MouseEvent, title: string, subtitle: string, entries: RowMenuState['entries']) {
  if (props.readonly || selectingNow.value || !entries.length) return
  event.preventDefault()
  rowMenu.value = { x: event.clientX, y: event.clientY, title, subtitle, entries }
}
/** 笔记行:打开 / 分享 / 属性与历史 / 删除 */
function openNoteMenu(event: MouseEvent, row: ItemSummary) {
  const target = rowShareTarget(row)
  openRowMenu(event, rowTitle(row), row.kind === 'insight' ? '笔记' : '文档', [
    { label: '打开', run: () => void openItem(row.id) },
    ...(target && canShare.value
      ? [{ label: '分享…', run: () => openShare([target], { [targetKey(target)]: rowTitle(row) }) }]
      : []),
    {
      label: '属性、历史版本',
      run: () => {
        // 先把它打开:属性面板展示的是 current,点名右键的必须是这一篇
        void openItem(row.id).then(() => {
          if (!inspectorOpen.value) toggleInspector()
        })
      },
    },
    { label: '删除…', danger: true, run: () => void openItem(row.id).then(() => remove()) },
  ])
}
/** 集合行:分享集合 / 新建笔记(在这个集合里)/ 导入文件 */
function openCollectionMenu(event: MouseEvent, name: string) {
  openRowMenu(event, name, '集合', [
    { label: '分享集合…', run: () => shareCollection(name) },
    {
      label: '在这个集合里新建笔记',
      run: () => {
        // 已经在别的集合 / 带筛选时先切过去;已经正好停在这个集合就别再调 selectCollection(它会把树节点收起来)
        void (async () => {
          if (collection.value !== name || kind.value || insightKind.value || dir.value) await selectCollection(name)
          void startCreate()
        })()
      },
    },
    { label: '导入文件到这儿…', run: () => void router.push({ path: PATHS.import, query: { collection: name } }) },
  ])
}
/** 统一入口:文件行照旧走文件菜单,笔记 / 别的行走行菜单(readonly 与多选态都不弹) */
function openRowContextMenu(event: MouseEvent, row: ItemSummary) {
  if (props.readonly || selectingNow.value) return
  if (row.kind !== 'insight' && row.source && !/^[a-z][a-z0-9+.-]*:\/\//i.test(row.source)) {
    openFileMenu(event, row)
    return
  }
  openNoteMenu(event, row)
}
/** 键盘等价物(Shift+F10):位置给一个固定点,和文件菜单一致 */
function openRowContextMenuByKeyboard(row: ItemSummary) {
  openRowContextMenu(new MouseEvent('contextmenu', { clientX: 48, clientY: 180 }), row)
}
/** 顶栏「更多」里直接进入文件动作 */
function openCurrentFileAction(kind: 'delete' | 'move') {
  const item = current.value
  if (!item || isInsight.value || !item.source) return
  moreOpen.value = false
  void fileActions.openAnd(kind, { collection: item.collection, path: item.source, name: fileName.value || item.source })
}
function pickSelectFromMenu() {
  const state = fileActions.menu.value
  fileActions.closeMenu()
  if (!state) return
  const target: ShareTarget = state.actions.folder
    ? { kind: 'dir', collection: state.target.collection, path: state.target.path }
    : { kind: 'file', collection: state.target.collection, path: state.target.path }
  const key = targetKey(target)
  selMeta.set(key, { target, title: state.target.name })
  applySelection(pick(listOrder.value, sel.value, key, { ctrl: true, shift: false, selecting: true }))
}
function closeFileMenu() {
  fileActions.closeMenu()
}
/** 正在分享的资源;null = 面板没开。每次打开都重新挂载,所以总是读到最新的协作者 */
const shareTargets = ref<ShareTarget[] | null>(null)
const shareTitles = ref<Record<string, string>>({})
const shareTab = ref<'people' | 'link'>('people')

/**
 * 当前文档对应的分享资源:笔记按 id,文件按集合内的相对路径。
 * 网页来源这类「路径」其实是网址的内容,后端造不出资源键,也就不能分享:不显示入口,比点了再报错好。
 */
const docShareTarget = computed<ShareTarget | null>(() => {
  const item = current.value
  if (!item || creating.value) return null
  if (item.kind === 'insight') return { kind: 'insight', collection: item.collection, id: item.id }
  if (!item.source || /^[a-z][a-z0-9+.-]*:\/\//i.test(item.source)) return null
  return { kind: 'file', collection: item.collection, path: item.source }
})
function openShare(targets: ShareTarget[], titles: Record<string, string> = {}, tab: 'people' | 'link' = 'people') {
  shareTitles.value = titles
  shareTab.value = tab
  shareTargets.value = targets
}
function closeShare() {
  shareTargets.value = null
  // 批量分享做完就收起批量条:选中的那些已经处理过了
  if (sel.value.selected.length) clearSelection()
}
function shareDoc() {
  const target = docShareTarget.value
  if (!target) return
  openShare([target], { [targetKey(target)]: current.value?.title || '' })
}
function shareCollection(name: string) {
  openShare([{ kind: 'collection', collection: name }])
}
function shareDir(col: string, dirPath: string) {
  openShare([{ kind: 'dir', collection: col, path: dirPath }], { [`dir:${col}/${dirPath}`]: dirPath })
}

/* ------------------------------------------------------------------ 文档里的双链 / 附件 */
/** 双链标题:逐个 get_item(双链通常就几个);取不到的留空,编辑器会显示 id */
async function resolveTitles(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    ids.map(async (id) => {
      try {
        const detail = await callCapability<ItemDetail>('get_item', { id })
        out[id] = detail.item.title ?? detail.item.symbol ?? detail.item.source
      } catch {
        out[id] = ''
      }
    }),
  )
  return out
}
/** 「引用笔记」选择器:在当前集合的笔记里按标题搜 */
async function searchNotes(query: string) {
  const found = await callCapability<ItemList>('list_items', {
    collection: (current.value?.collection ?? collection.value) || collection.value,
    kind: 'insight',
    q: query.trim() || undefined,
    page: 1,
    page_size: 8,
  })
  return found.items.filter((item) => item.id !== current.value?.id).map((item) => ({ id: item.id, title: item.title ?? item.source, kind: KIND_LABEL[item.insight_kind ?? ''] ?? '笔记' }))
}
/** 正文里的链接目标不可用:只提示,不改正文 */
function onLinkError(message: string) {
  toast.push(message, 'warning')
}
/** 点开附件:切到它所在的集合,按路径打开(文件查看器负责按格式渲染) */
async function openAttachment(target: { collection: string; path: string; fragment?: string }) {
  if (!(await confirmDiscard())) return
  if (target.collection !== collection.value) collection.value = target.collection
  try {
    // 先按文件名缩小范围,再按 `source` 精确比对:路径里的目录 / 中文 / 空格不能被模糊匹配带偏。
    const name = target.path.split('/').pop() ?? target.path
    const found = await callCapability<ItemList>('list_items', { collection: target.collection, status: 'all', q: name, page: 1, page_size: 50 })
    const match = found.items.find((item) => item.source === target.path)
    if (match) {
      await openItem(match.id, { skipGuard: true })
      await nextTick()
      scrollToFragment(target.fragment)
      return
    }
  } catch {
    /* 落到下面:直接下载 */
  }
  toast.push('文件还没有索引好,先下载原件')
  window.open(fileDownloadUrl(target.collection, target.path, props.viewAs), '_blank', 'noopener')
}

/* ------------------------------------------------------------------ 快捷键 */
function onKeydown(event: KeyboardEvent) {
  // 在「共享给我」里时,Esc / ⌘S 属于我自己的文档(被 v-show 藏起来了),不能在这里生效;⌘\ 收起目录栏仍然有效
  const mine = scope.value === 'mine'
  // 「更多操作」菜单开着时,Esc 先关菜单并把焦点还给按钮(以前只有点菜单外面才关,Esc 会去关别的东西,比如属性面板)
  if (event.key === 'Escape' && rowMenu.value) {
    event.preventDefault()
    rowMenu.value = null
    return
  }
  if (event.key === 'Escape' && moreOpen.value) {
    event.preventDefault()
    moreOpen.value = false
    document.querySelector<HTMLElement>('.kb-more-trigger')?.focus()
    return
  }
  if (event.key === 'Escape' && mine) {
    if (selectingNow.value && !shareTargets.value) {
      event.preventDefault()
      clearSelection()
      return
    }
    if (zenMode.value) {
      event.preventDefault()
      zenMode.value = false
      return
    }
    if (inspectorOpen.value) {
      event.preventDefault()
      inspectorTemp.value = false
      return
    }
  }
  // 目录栏的收起 / 展开用 ⌘\;⌘B 归外壳的全局侧栏(每个页面一致)
  if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
    event.preventDefault()
    toggleSidebar()
    return
  }
  // 新编辑器外壳自己接管编辑器内部的 Ctrl/⌘+S（Host 的快捷键只认根节点内部）；
  // 页面再拦一次会把同一份正文发成两次 save：第二次撞上「正在保存」，外壳被误标成加载出错。
  const inNativeEditor = event.target instanceof Element && !!event.target.closest('[data-testid="editor-host"]')
  if (!inNativeEditor && mine && !props.readonly && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    if (creating.value) void createInsight()
    else if (fileEditing.value) void saveFileEdit()
    else void save()
  }
}
function onBeforeUnload(event: BeforeUnloadEvent) {
  docPage.value?.flush()
  // 能存进草稿的改动不拦关页面(草稿是同步写的,这里就写好了);只有存不下来的才让浏览器问一句
  if (leaveRisk() === 'unsafe') event.preventDefault()
}

onMounted(async () => {
  document.addEventListener('mousedown', closeMore)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', onBeforeUnload)
  if (props.embedded) {
    // 弹窗里:不走 URL、不恢复草稿、不打开别人的最近记录,只把这一库的列表和树铺开
    await loadCollections()
    expanded.value[collection.value] = true
    if (insightKind.value) facetOpen.value[insightKind.value] = true
    await Promise.all([loadItems(), loadTree()])
    await nextTick()
    ready = true
    const first = list.value?.items[0]
    if (first) await openItem(first.id, { skipGuard: true, track: false })
    return
  }
  const wantedKind = typeof route.query.kind === 'string' ? route.query.kind : ''
  const wantedDir = typeof route.query.dir === 'string' ? route.query.dir : ''
  await loadCollections()
  if (wantedKind) setKind(wantedKind)
  if (wantedDir) dir.value = wantedDir
  expanded.value[collection.value] = true
  if (insightKind.value) facetOpen.value[insightKind.value] = true
  await Promise.all([loadItems(), loadTree()])
  await nextTick()
  ready = true
  const opened = await openFromQuery()
  const wantedItem = route.query.item
  // 首页的「新建笔记」带 ?new=1 过来:直接进入新建表单,不先打开列表第一条(打开了又丢弃只会闪一下)
  const wantNew = route.query.new === '1'
  if (!opened && typeof wantedItem === 'string') await openItem(wantedItem, { skipGuard: true })
  else if (!opened && !wantNew && layout.value === 'full' && list.value?.items[0]) await openItem(list.value.items[0].id, { skipGuard: true, track: false })
  if (wantNew) {
    // 用完就把参数去掉:刷新或点后退不会再次弹出空白的新建表单
    const { new: _new, ...rest } = route.query
    void router.replace({ query: rest })
    await startCreate()
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', closeMore)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.clearTimeout(filterTimer)
})
</script>

<template>
  <!-- 嵌入管理员查看弹窗时不套外壳:弹窗已经有标题栏和页签,URL 也不改 -->
  <component :is="embedded ? 'div' : AppShell" v-bind="embedded ? {} : { bare: true }" :class="{ 'kb-embed-page': embedded }">
    <template #breadcrumb>
      <template v-for="(part, index) in crumbs.trail" :key="`${part}-${index}`">
        <span v-if="index < crumbs.trail.length - 1">{{ part }}</span>
        <span v-if="index < crumbs.trail.length - 1">/</span>
        <b v-else :class="{ mono: !!crumbs.leaf }">{{ part }}</b>
      </template>
    </template>
    <template #actions>
      <div class="kb-viewmode-switch">
        <button
          type="button"
          class="kb-viewmode-btn"
          :class="{ 'is-active': viewMode === 'dual' }"
          title="双栏极简工作台视图 (类似 VS Code / Obsidian)"
          @click="setViewMode('dual')"
        >
          <KbIcon name="doc" :size="12" /> <span>工作台</span>
        </button>
        <button
          type="button"
          class="kb-viewmode-btn"
          :class="{ 'is-active': viewMode === 'table' }"
          title="全量数据表格筛选与导出"
          @click="setViewMode('table')"
        >
          <KbIcon name="list" :size="12" /> <span>数据表格</span>
        </button>
      </div>
      <button v-if="!readonly" type="button" class="btn" :disabled="!list?.items.length" @click="exportList">导出</button>
    </template>

    <!-- 弹窗里没有外壳顶栏:工作台 / 数据表格的切换放在页面自己顶部,表格视图才有路回来 -->
    <div v-if="embedded" class="kb-embed-bar" data-testid="kb-embed-viewmode">
      <KbSegmented
        :model-value="viewMode"
        :options="[{ value: 'dual', label: '工作台' }, { value: 'table', label: '数据表格' }]"
        @update:model-value="(value: string) => setViewMode(value === 'table' ? 'table' : 'dual')"
      />
    </div>

    <!-- ==================== 双栏工作台: 双栏极简工作台 (默认) ==================== -->
    <div
      v-if="viewMode === 'dual'"
      class="kb-workbench-dual"
      :class="{ 'is-zen': zenMode, 'is-detail': mobileDetail }"
      :style="{ '--sidebar-w': `${sidebarWidth}px` }"
      style-allow="动态拖拽侧栏宽度"
    >
      <!-- 左侧导航侧边栏 -->
      <aside class="kb-sidebar" :class="{ 'is-collapsed': sidebarHidden, 'is-narrow': narrow, 'is-tight': sidebarTight }" role="navigation" aria-label="资源导航">
        <!-- 范围:我的知识库 / 共享给我(接收分享不需要功能点,所以人人都有) -->
        <div v-if="!embedded" class="kb-scope" data-testid="scope-switch">
          <KbSegmented :model-value="scope" :options="scopeOptions" @update:model-value="setScope" />
          <!-- 手机:「新建」和范围切换同一行(原来单占一行,右边大片空白);桌面 / 平板的在下面的页头里 -->
          <button v-if="narrow && !readonly && scope === 'mine'" type="button" class="btn sm pri kb-new-btn" title="新建笔记" aria-label="新建笔记" @click="startCreate">
            <KbIcon name="plus" :size="12" /> <span>新建</span>
          </button>
        </div>
        <SharedSidebar
          v-if="!embedded && scope === 'shared'"
          :groups="shared.groups.value"
          :status="shared.status.value"
          :error-text="shared.errorText.value"
          :active-key="sharedActive?.key ?? null"
          :show-hidden="shared.showHidden.value"
          :hidden-count="shared.hiddenCount.value"
          @select="openShared"
          @retry="shared.load"
          @update:show-hidden="(value: boolean) => (shared.showHidden.value = value)"
          @hide="hideShared"
        />
        <template v-else>
        <!-- 侧栏顶部控制区 -->
        <div v-if="!narrow" class="kb-sidebar-head">
          <KbSelect
            v-if="collections.length > 1"
            v-model="collection"
            :options="collectionOptions"
            size="sm"
            icon="database"
            plain
            :display="collection || '切换集合'"
            align="start"
            class="kb-sidebar-title"
          />
          <span v-else class="kb-sidebar-title" :title="collection || '知识库'">{{ collection || '知识库' }}</span>
          <div class="kb-sidebar-ctrls">
            <template v-if="!readonly">
              <button type="button" class="btn sm pri kb-new-btn" title="新建笔记" aria-label="新建笔记" @click="startCreate">
                <KbIcon name="plus" :size="12" /> <span>新建</span>
              </button>
              <RouterLink
                class="btn sm kb-ghost"
                :to="{ path: PATHS.import, query: collection ? { collection } : undefined }"
                title="导入文件到当前集合"
                aria-label="导入文件"
              >
                <KbIcon name="upload" :size="13" />
              </RouterLink>
              <RouterLink class="btn sm kb-ghost" :to="PATHS.projects" title="管理项目与集合" aria-label="管理项目与集合"><KbIcon name="settings" :size="13" /></RouterLink>
            </template>
            <button
              type="button"
              class="btn sm kb-ghost"
              title="收起目录栏 (⌘\)"
              aria-label="收起侧栏"
              @click="toggleSidebar"
            >
              <KbIcon name="chevron" :size="12" class="kb-tree-collapse-icon" />
            </button>
          </div>
        </div>

        <!-- 侧栏搜索与筛选控制行 -->
        <div class="kb-sidebar-search-row">
          <div class="kb-sidebar-search-wrap">
            <KbIcon name="search" :size="12" class="kb-sidebar-search-icon" />
            <input
              v-model="filterText"
              class="kb-sidebar-search-input"
              type="text"
              :placeholder="narrow || sidebarTight ? '搜索' : '搜索笔记、文件、标签…'"
              enterkeyhint="search"
              aria-label="搜索笔记和文件"
              @keydown.enter="!isComposing($event) && applyFilterText(true)"
            />
            <button
              v-if="filterText"
              type="button"
              class="kb-sidebar-search-clear"
              title="清空搜索"
              @click="filterText = ''; applyFilterText(true)"
            >
              ✕
            </button>
          </div>
          <KbSelect
            v-model="sort"
            :options="sortOptions"
            size="sm"
            icon="sort"
            plain
            align="end"
            aria-label="排序方式"
            title="排序方式"
          />
          <KbSelect
            v-model="status"
            :options="statusOptions"
            size="sm"
            icon="filter"
            plain
            align="end"
            aria-label="状态筛选"
            title="状态筛选"
          />
        </div>

        <!-- 上次没写完的新笔记:一键接着写(内容在本机草稿里,点了自动放回) -->
        <div v-if="!readonly && pendingNewDraft" class="kb-resume" data-testid="resume-draft">
          <button type="button" class="kb-resume-main" @click="startCreate">
            <KbIcon name="edit" :size="12" /> <span class="kb-resume-text">继续写「{{ pendingNewDraft.title.trim() || '无标题' }}」</span>
          </button>
          <button type="button" class="kb-resume-x" aria-label="丢弃这份没写完的笔记" title="丢弃这份没写完的笔记" @click="discardNewDraft">
            <KbIcon name="close" :size="12" />
          </button>
        </div>

        <!-- 快捷分类药丸 Pills。手机上集合选择和药丸同一行(原来页头单占一行);
             只有一种内容时「全部」和那一种的数字一样,药丸点了没有任何区别,手机上不画 -->
        <div class="kb-sidebar-pills">
          <template v-if="narrow">
            <KbSelect
              v-if="collections.length > 1"
              v-model="collection"
              :options="collectionOptions"
              size="sm"
              icon="database"
              plain
              :display="collection || '切换集合'"
              align="start"
              class="kb-sidebar-title"
            />
            <span v-else class="kb-sidebar-title" :title="collection || '知识库'">{{ collection || '知识库' }}</span>
          </template>
          <div v-if="!narrow || categoryPills.length > 2" class="kb-sidebar-pill-list">
            <button
              v-for="pill in categoryPills"
              :key="pill.value"
              type="button"
              class="kb-sidebar-pill"
              :class="{ 'is-active': (kind === pill.value && !insightKind) || (!pill.value && !kind && !insightKind) }"
              @click="setCategoryPill(pill.value)"
            >
              {{ pill.label }}<span class="kb-pill-count">{{ compact(pill.count ?? 0) || pill.count }}</span>
            </button>
          </div>
        </div>

        <!-- 激活的筛选 Chip 标签 -->
        <div v-if="chips.length" class="kb-sidebar-chips">
          <span
            v-for="chip in chips"
            :key="chip.key"
            class="tag ac sm"
            @click="removeChip(chip.key)"
          >
            {{ chip.label }} <i class="kb-chip-x">✕</i>
          </span>
          <button
            type="button"
            class="kb-link sm m"
            @click="clearAllFilters"
          >
            全部清空
          </button>
        </div>

        <!-- 侧栏模式切换 -->
        <div class="kb-sidebar-nav-tabs">
          <button
            type="button"
            class="kb-sidebar-tab-btn"
            :class="{ 'is-active': sidebarTab === 'files' }"
            @click="sidebarTab = 'files'"
          >
            列表 <span class="mono m">{{ total }}</span>
          </button>
          <button
            type="button"
            class="kb-sidebar-tab-btn"
            :class="{ 'is-active': sidebarTab === 'tree' }"
            @click="sidebarTab = 'tree'"
          >
            目录
          </button>
          <button
            v-if="canShare"
            type="button"
            class="kb-sidebar-tab-btn kb-sel-toggle"
            :class="{ 'is-active': selectingNow }"
            :aria-pressed="selectingNow"
            title="选择多项,一起分享或生成合集链接(也可以按住 Ctrl / ⌘ 点击,Shift 连选,触屏长按)"
            data-testid="select-toggle"
            @click="toggleSelecting"
          >
            {{ selectingNow ? '完成' : '选择' }}
          </button>
        </div>

        <!-- 侧栏条目列表 -->
        <div v-if="sidebarTab === 'files'" ref="sidebarBody" class="kb-sidebar-body">
          <KbSkeleton v-if="listLoading && !list?.items.length" variant="list" :lines="5" class="kb-sidebar-pad" data-testid="kb-list-loading" />
          <!-- 读取失败不能伪装成「没有内容」:说清原因,能重试的给重试(没开通功能的重试没有意义) -->
          <KbEmpty v-else-if="listFailure" icon="failed" size="sm" title="没能读取列表" :description="listFailure.message" data-testid="kb-list-error">
            <template v-if="listFailure.phase === 'error'" #action><KbButton size="sm" :disabled="listLoading" @click="loadItems">重试</KbButton></template>
          </KbEmpty>
          <KbEmpty v-else-if="!list?.items.length && filterCount" icon="search" size="sm" title="没有符合条件的内容" description="换个关键词,或者清除筛选再看看。" data-testid="kb-list-empty">
            <template #action><KbButton size="sm" @click="clearAllFilters">清除筛选</KbButton></template>
          </KbEmpty>
          <KbEmpty v-else-if="!list?.items.length" icon="note" size="sm" title="这里还没有内容" :description="readonly ? '这个集合里还没有文档。' : '新建第一篇笔记,或者导入已有的文件。'" data-testid="kb-list-empty">
            <template v-if="!readonly" #action>
              <KbButton size="sm" variant="primary" @click="startCreate">新建笔记</KbButton>
              <KbButton size="sm" @click="router.push({ path: PATHS.import, query: collection ? { collection } : undefined })">导入文件</KbButton>
            </template>
          </KbEmpty>
          <template v-else>
            <div
              v-for="row in list?.items ?? []"
              :key="row.id"
              class="kb-sidebar-item"
              :class="{ 'is-active': !narrow && selectedId === row.id, 'is-note': row.kind === 'insight', 'is-selected': isSelected(rowShareTarget(row)) }"
              tabindex="0"
              :aria-selected="selectingNow && canShare ? isSelected(rowShareTarget(row)) : undefined"
              :data-testid="`list-row-${row.id}`"
              @click="onRowClick($event, row)"
              @keydown.enter="onRowClick($event, row)"
              @pointerdown="rowPressStart($event, row)"
              @pointermove="rowPress.move"
              @pointerup="rowPress.end"
              @pointercancel="rowPress.end"
              @contextmenu="openRowContextMenu($event, row)"
              @keydown.shift.f10.prevent="openRowContextMenuByKeyboard(row)"
            >
              <span v-if="selectingNow && canShare" class="kb-sel-mark" :class="{ 'is-on': isSelected(rowShareTarget(row)) }" aria-hidden="true"><KbIcon v-if="isSelected(rowShareTarget(row))" name="check" :size="12" /></span>
              <span v-if="row.kind === 'insight'" class="kb-item-icon is-note" aria-hidden="true">
                <svg viewBox="0 0 16 16"><path d="M4 2h6l3 3v9H4z" /><path d="M6 8h5M6 11h3.5" /></svg>
              </span>
              <span v-else class="kb-fmt mono kb-item-fmt" :class="'is-' + fileChip(row.source).tone">{{ fileChip(row.source).label }}</span>
              <span class="kb-sidebar-item-title" :title="row.title ?? row.source">
                <span class="kb-sidebar-item-name">{{ row.source.startsWith('_attachments/') && !row.title ? displayName(row.source) : rowTitle(row) }}</span>
                <span class="kb-sidebar-item-dir">
                  <template v-if="row.kind === 'insight'">{{ row.tags.slice(0, 2).map((tag) => `#${tag}`).join(' ') || '笔记' }}</template>
                  <template v-else>{{ rowPathDir(row) || KIND_LABEL[row.kind] || row.kind }}</template>
                  <template v-if="row.chunks && row.chunks > 1"><span class="kb-item-dot">·</span>{{ row.chunks }} 段</template>
                  <span class="kb-item-dot">·</span>{{ fmtUpdated(row.updated_at) }}
                </span>
              </span>
            </div>
          </template>
        </div>

        <!-- 侧栏集合目录树 -->
        <div v-else ref="sidebarBody" class="kb-sidebar-body" role="tree" aria-label="集合">
          <template v-for="item in collections" :key="item.name">
            <KbTreeRow
              :label="item.name"
              :count="compact(item.items)"
              :depth="0"
              :open="collection === item.name && !!expanded[item.name]"
              :active="collection === item.name && !kind && !insightKind && !dir"
              @select="onCollectionClick($event, item.name)"
              @toggle="toggleCollection(item.name)"
              @contextmenu.prevent="openCollectionMenu($event, item.name)"
            >
              <template v-if="canShare" #actions>
                <span v-if="selectingNow" class="kb-sel-mark" :class="{ 'is-on': isSelected(collectionTarget(item.name)) }" aria-hidden="true"><KbIcon v-if="isSelected(collectionTarget(item.name))" name="check" :size="12" /></span>
                <button v-else type="button" class="kb-icon-btn kb-tree-share" :aria-label="`分享集合「${item.name}」`" :data-testid="`tree-share-${item.name}`" @click.stop="shareCollection(item.name)">
                  <KbIcon name="share" :size="14" />
                </button>
              </template>
            </KbTreeRow>
            <!-- 展开 / 收起带高度动画：以前是一帧出现 / 消失，下面的行整体跳一下 -->
            <FoldTransition :open="collection === item.name && !!expanded[item.name]">
              <!-- 分类数据还在路上:给占位,不要让展开的集合下面是一片空白 -->
              <KbSkeleton v-if="treeLoading && !facets?.length && !kindRows.length" :lines="3" class="kb-tree-wait" data-testid="tree-loading" />
              <template v-else-if="facets?.length">
                <template v-for="facet in facets" :key="facet.kind">
                  <!-- 没有子目录的类型不给展开箭头(以前给了,点开却什么都没有) -->
                  <KbTreeRow
                    :label="kindText(facet.kind)"
                    :count="compact(facet.count)"
                    :depth="1"
                    :open="facet.dirs?.length ? !!facetOpen[facet.kind] : undefined"
                    :active="insightKind === facet.kind && !dir"
                    :data-testid="`tree-facet-${facet.kind}`"
                    @select="selectFacet(facet)"
                    @toggle="facetOpen[facet.kind] = !facetOpen[facet.kind]"
                  />
                  <FoldTransition :open="!!facetOpen[facet.kind]">
                    <KbTreeRow
                      v-for="entry in facet.dirs ?? []"
                      :key="entry.dir"
                      :label="entry.dir"
                      :count="compact(entry.count)"
                      :depth="2"
                      :active="insightKind === facet.kind && dir === entry.dir"
                      :data-testid="`tree-dir-${entry.dir}`"
                      mono
                      @select="selectFacetDir(facet.kind, entry.dir)"
                      @contextmenu.prevent="openDirMenu($event, item.name, entry.dir)"
                      @keydown.shift.f10.prevent="openDirMenuByKeyboard(item.name, entry.dir)"
                    >
                      <template v-if="canShare" #actions>
                        <span v-if="selectingNow" class="kb-sel-mark" :class="{ 'is-on': isSelected(dirTarget(item.name, entry.dir)) }" aria-hidden="true"><KbIcon v-if="isSelected(dirTarget(item.name, entry.dir))" name="check" :size="12" /></span>
                        <button v-else type="button" class="kb-icon-btn kb-tree-share" :aria-label="`分享文件夹「${entry.dir}」`" :data-testid="`tree-share-${entry.dir}`" @click.stop="shareDir(item.name, entry.dir)">
                          <KbIcon name="share" :size="14" />
                        </button>
                      </template>
                    </KbTreeRow>
                  </FoldTransition>
                </template>
              </template>
              <template v-else-if="kindRows.length">
                <KbTreeRow
                  v-for="entry in kindRows"
                  :key="entry.value"
                  :label="kindText(entry.value)"
                  :count="compact(kindCounts[entry.value] ?? 0)"
                  :depth="1"
                  :active="kind === entry.value"
                  @select="selectKind(entry.value)"
                />
              </template>
              <div v-else class="kb-tree-empty" data-testid="tree-empty">这里没有可展开的分类</div>
            </FoldTransition>
          </template>
          <!-- 提示放在树的最下面（吸底）：选中筛选后它才出现，放在最上面会把所有行往下顶一截，点下去的那一行自己跑了 -->
          <div v-if="kind || insightKind" class="kb-tree-switch-hint">
            <button
              type="button"
              class="btn sm pri"
              @click="sidebarTab = 'files'"
            >
              查看 {{ kind || insightKind }} 的全部文档 ({{ total }} 篇) ›
            </button>
          </div>
        </div>

        <!-- 多选后的批量操作条 -->
        <KbBatchBar v-if="canShare" :count="sel.selected.length" :total="listOrder.length" @clear="clearSelection" @all="selectAllVisible">
          <KbButton size="sm" variant="primary" data-testid="batch-share" @click="shareSelected('people')">分享</KbButton>
          <KbButton v-if="sel.selected.length > 1" size="sm" data-testid="batch-link" @click="shareSelected('link')">合集链接</KbButton>
        </KbBatchBar>

        <!-- 侧栏分页控制器:只有一页时没有任何可翻的东西(「1 / 1 (9条) 16条▾」占约 90px),不画;出现第二页时自动出现 -->
        <div v-if="maxPage > 1" class="kb-sidebar-pager">
          <div class="kb-sidebar-pager-btns">
            <button
              type="button"
              class="btn sm"
              :disabled="page <= 1"
              title="上一页"
              aria-label="上一页"
              @click="page = Math.max(1, page - 1)"
            >
              ‹
            </button>
            <button
              type="button"
              class="btn sm"
              :disabled="page >= maxPage"
              title="下一页"
              aria-label="下一页"
              @click="page = page + 1"
            >
              ›
            </button>
          </div>
          <span class="mono kb-sidebar-pager-info">
            {{ page }} / {{ maxPage }} ({{ total }}条)
          </span>
          <KbSelect
            :model-value="pageSize"
            :options="[
              { value: 16, label: '16条' },
              { value: 32, label: '32条' },
              { value: 64, label: '64条' },
              { value: 100, label: '100条' },
            ]"
            size="sm"
            plain
            up
            align="end"
            @update:model-value="(val) => (pageSize = Number(val))"
          />
        </div>
        </template>
      </aside>

      <!-- 侧边栏拖拽手柄 -->
      <div
        v-if="!sidebarHidden && !narrow && !twoPane"
        class="kb-resizer"
        :class="{ 'is-active': isDragging }"
        title="拖拽调节侧栏宽度"
        @mousedown="onResizerMouseDown"
      />

      <!-- 右侧超大主工作区 -->
      <!-- 共享给我:别人分享给我的内容(阅读 / 编辑 / 评论 / 申请权限) -->
      <main v-if="scope === 'shared'" class="kb-workspace-main" role="main" data-testid="shared-main">
        <SharedWorkspace v-if="sharedActive" :key="sharedActive.key" :item="sharedActive" :focus="sharedFocus" :narrow="narrow || sidebarHidden" @back="backFromShared" @hide="(item: SharedWithMeItem) => hideShared([item], true)" />
        <div v-else class="kb-split-empty">
          <KbEmpty icon="users" title="从左侧选一份共享给你的内容" description="别人分享给你的笔记、文件和文件夹会按分享人列在左侧,你的权限显示在每一项旁边。" />
        </div>
      </main>

      <!-- 我的知识库:切到「共享给我」时只是藏起来(v-show),没保存的编辑不会丢 -->
      <main v-show="scope === 'mine'" class="kb-workspace-main" role="main">
        <!-- 文档顶栏(语雀式:返回 / 面包屑 / 保存状态 ……… 主操作 + 更多) -->
        <div class="kb-workspace-bar">
          <div class="kb-workspace-bar-left">
            <button v-if="narrow" type="button" class="btn sm kb-back-btn" aria-label="返回列表" @click="backToList">
              <KbIcon name="chevron" :size="12" class="kb-back-icon" /> <span class="kb-wide-only">列表</span>
            </button>
            <!-- 目录栏收起后的找回按钮;两栏版面里它是回到列表的唯一入口,所以带文字、放在最左。文字写「列表」:在两栏版面里它找回的就是文档列表 -->
            <button
              v-if="sidebarHidden && !narrow"
              type="button"
              class="btn sm"
              :class="twoPane ? 'kb-dir-btn' : 'kb-ghost'"
              data-testid="dir-toggle"
              :title="twoPane ? '展开文档列表' : '展开目录栏 (⌘\\)'"
              :aria-label="twoPane ? '展开列表' : '展开目录'"
              @click="toggleSidebar"
            >
              <KbIcon name="sidebar" :size="14" /><span v-if="twoPane">列表</span>
            </button>
            <nav v-if="creating || current" class="kb-crumb" aria-label="位置">
              <template v-for="(part, index) in crumbTrail" :key="`${index}:${part.text}`">
                <span v-if="index > 0" class="kb-crumb-sep">/</span>
                <span class="kb-crumb-part" :class="{ 'kb-crumb-col': part.col }">{{ part.text }}</span>
              </template>
              <span v-if="crumbTrail.length" class="kb-crumb-sep">/</span>
              <b class="kb-crumb-part kb-crumb-leaf" :title="isInsight ? crumbLeaf : current?.source">{{ crumbLeaf }}</b>
            </nav>
            <KbBadge v-if="current && !creating && statusLabel.text && statusLabel.text !== '已转正' && statusLabel.text !== '有效'" :tone="statusLabel.tone">{{ statusLabel.text }}</KbBadge>
            <span v-if="saveStateText" class="kb-save-state" :class="`is-${saveState}`" aria-live="polite">{{ saveStateText }}</span>
          </div>

          <div class="kb-workspace-bar-right">
            <!-- 谁在这篇文档里(腾讯文档式头像堆,我排第一);只在多人编辑连接存在时出现 -->
            <CollabAvatars v-if="collab && (editExpanded || fileEditing)" :provider="collab" />
            <!-- 按钮用词按术语表：「退出编辑」只是离开编辑、改动还在本机草稿里；「放弃修改」才会丢掉改动（要确认）；
                 「保存」存成新版本并重建索引，新建笔记也叫「保存」。不用「取消」：它会让人以为改动被丢了 -->
            <template v-if="creating">
              <button type="button" class="btn sm" title="退出编辑,写了一半的内容留在本机草稿里,下次新建接着写" @click="creating = false">退出编辑</button>
              <KbSubmitButton label="保存" done-label="已保存" :disabled="!newTitle.trim() || !newBody.trim()" @click="createInsight" />
            </template>
            <template v-else-if="fileEditing">
              <button v-if="aiWriteButton" type="button" class="btn sm kb-wide-only" data-testid="doc-ai-write" title="AI 写作：润色、总结、翻译选中的文字，或按要求写一段" @click="docPage?.openAi?.()"><KbIcon name="sparkles" :size="12" /> AI 写作</button>
              <button type="button" class="btn sm kb-wide-only" title="退出编辑;有没保存的改动时会先问要不要放弃" @click="cancelFileEdit">退出编辑</button>
              <button type="button" class="btn sm pri" :disabled="fileSaving" title="保存并回到阅读 (Ctrl/⌘ S)" @click="finishFileEdit">保存</button>
            </template>
            <template v-else-if="current && isInsight && editExpanded">
              <button v-if="aiWriteButton" type="button" class="btn sm kb-wide-only" data-testid="doc-ai-write" title="AI 写作：润色、总结、翻译选中的文字，或按要求写一段" @click="docPage?.openAi?.()"><KbIcon name="sparkles" :size="12" /> AI 写作</button>
              <button type="button" class="btn sm" title="退出编辑,没保存的改动留在本机草稿里,下次点「编辑」接着改" @click="cancelNoteEdit">退出编辑</button>
              <button type="button" class="btn sm" data-testid="note-revert" :disabled="!dirty || saving" title="放弃这次的修改:回到上次保存的版本,并清掉本机草稿" @click="revertNoteEdit">放弃修改</button>
              <button type="button" class="btn sm pri" data-testid="note-save" :disabled="saving" title="保存并回到阅读 (Ctrl/⌘ S)" @click="finishEditing">保存</button>
            </template>
            <template v-else-if="current">
              <button v-if="noteDraftDirty && !readonly" type="button" class="btn sm" data-testid="note-revert" title="回到上次保存的版本,清掉没保存的改动" @click="revertNoteEdit">放弃修改</button>
              <KbSubmitButton v-if="tagsOnlyDirty && !readonly" label="保存标签" done-label="已保存" :busy="saving" :done-at="savedAt" @click="save" />
              <button v-if="canShare && docShareTarget" type="button" class="btn sm" data-testid="doc-share" aria-label="分享" title="分享给协作者,或生成分享链接" @click="shareDoc">
                <KbIcon name="share" :size="12" /> <span class="kb-wide-only">分享</span>
              </button>
              <button v-if="canEditOffice" type="button" class="btn sm pri" data-testid="office-edit-open" title="在页面里直接改,保存后替换原文件;旧内容留在版本历史里" @pointerenter="warmWordEditor" @focus="warmWordEditor" @pointerleave="coolWordEditor" @blur="coolWordEditor" @click="officeEditing = true">
                <KbIcon name="edit" :size="12" /> 在线编辑
              </button>
              <button v-else-if="canCopyEdit" type="button" class="btn sm pri" :disabled="copying" title="转成 Markdown 副本后编辑,原文件不会被改动" data-testid="edit-as-markdown" @click="editAsMarkdown">
                <KbIcon name="edit" :size="12" /> {{ copying ? '转换中…' : '编辑' }}
              </button>
              <button v-if="canEditCsv" type="button" class="btn sm pri" data-testid="csv-edit-open" :disabled="previewLoading" title="像表格一样改格子、增删行;保持原来的编码、分隔符和换行" @click="startCsvEdit">
                <KbIcon name="edit" :size="12" /> 表格编辑
              </button>
              <button v-if="isInsight && !readonly" type="button" class="btn sm pri" title="编辑（也可以双击正文，从双击的地方开始改）" @click="editExpanded = true; showRendered = true">
                <KbIcon name="edit" :size="12" /> 编辑
              </button>
              <button v-else-if="preview?.editable && !readonly" type="button" class="btn sm pri" :disabled="extPending" title="编辑（也可以双击正文，从双击的地方开始改）" @click="startFileEdit">
                <KbIcon name="edit" :size="12" /> 编辑
              </button>
              <a v-else-if="downloadUrl && !readonly" class="btn sm" :href="downloadUrl" :download="fileName" aria-label="下载原件" data-testid="file-download" @click="interceptInAppDownload"><KbIcon name="download" :size="12" /> <span class="kb-wide-only">下载</span></a>
              <button
                type="button"
                class="btn sm kb-ghost kb-wide-only"
                :class="{ ac: inspectorOpen }"
                :title="isInsight ? '属性、关系与历史' : '属性、内容片段、评论与历史'"
                aria-label="属性"
                @click="toggleInspector"
              >
                <KbIcon name="doc" :size="13" />
              </button>
            </template>
            <div v-if="current || creating" class="kb-more">
              <button type="button" class="btn sm kb-ghost kb-more-trigger" aria-label="更多操作" :aria-expanded="moreOpen" aria-haspopup="menu" @click="moreOpen = !moreOpen">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /><circle cx="12.5" cy="8" r="1.3" fill="currentColor" /></svg>
              </button>
              <div v-if="moreOpen" class="kb-more-menu" role="menu" @click="moreOpen = false">
                <template v-for="(entry, at) in moreItems" :key="at">
                  <div v-if="entry.sep" class="kb-more-sep"></div>
                  <button v-else type="button" role="menuitem" class="kb-more-item" :class="{ 'is-danger': entry.danger }" @click="entry.run?.()">
                    <span>{{ entry.label }}</span>
                    <span v-if="entry.hint" class="m kb-more-hint">{{ entry.hint }}</span>
                    <span v-if="entry.checked" class="kb-more-check">✓</span>
                  </button>
                </template>
              </div>
            </div>
          </div>
        </div>

        <!-- 保存 / 恢复 / 新建等操作失败的提示:以前只写进 error 而界面不渲染(旧分栏视图才有),失败了用户什么也看不到 -->
        <div v-if="error" class="row kb-error kb-split-note" role="alert" data-testid="kb-error">
          <span>{{ error }}</span>
          <KbButton size="sm" @click="error = ''">知道了</KbButton>
        </div>

        <!-- AI 经 MCP 提的修改建议:接受后并进正在编辑的房间,或直接改正文 -->
        <EditProposals
          v-if="!readonly && current && !creating && (isInsight || collection)"
          :collection="isInsight ? undefined : collection"
          :path="isInsight ? undefined : current.source"
          :note-id="isInsight ? current.id : undefined"
          @applied="onProposalApplied"
          @locate="locateProposal"
        />

        <!-- 工作区内容视窗 -->
        <div class="kb-workspace-body">
          <div ref="contentEl" class="kb-workspace-content">
            <!-- 新建经验 / 笔记:语雀式文档页 -->
            <DocPage
              v-if="creating"
              ref="docPage"
              :persist-layout="!embedded"
              v-model:title="newTitle"
              v-model="newBody"
              :editing="true"
              show-title
              title-placeholder="请输入标题"
              :draft-id="`new:${collection}`"
              :extra="newNoteExtra"
              :base-extra="newNoteBaseExtra"
              :collection="collection"
              :resolve-titles="resolveTitles"
              :search-notes="searchNotes"
              @restore-extra="restoreNewExtra"
              @draft-state="draftStored = $event"
              @save="createInsight"
              @open-attachment="openAttachment"
              @link-error="onLinkError"
            >
              <template #meta>
                <KbSelect v-model="newKind" :options="insightKinds" size="sm" aria-label="种类" />
                <KbTagEditor v-model="newTags" />
              </template>
            </DocPage>

            <!-- Markdown 文件:阅读与编辑同一个文档页(标题是文件名,不能在这里改) -->
            <DocPage
              v-else-if="isMarkdownFile && (fileEditing || (showRenderedMarkdown && preview?.content))"
              ref="docPage"
              :persist-layout="!embedded"
              :title="fileName"
              :title-editable="false"
              :model-value="fileEditing ? fileDraft : markdownSource"
              :editing="fileEditing"
              :collab="fileEditing ? collab : null"
              :collab-pending="fileEditing && collabPending"
              :silent-restore="!collabCapable"
              :draft-id="props.embedded || !current ? null : `file:${itemCollection}:${current.source}`"
              :base-title="fileName"
              :base-body="preview?.content ?? ''"
              :collection="itemCollection"
              :source-path="current?.source"
              :admin-view="viewAs"
              :quotes="quotes"
              :active-quote="activeQuote"
              :annotatable="!fileEditing && !readonly && canComment"
              :resolve-titles="resolveTitles"
              :search-notes="searchNotes"
              @annotate="onAnnotate"
              @quote-click="onQuoteClick"
              @quotes-located="locatedIds = new Set($event)"
              @draft-state="draftStored = $event"
              @request-edit="requestFileEdit"
              @update:model-value="fileDraft = $event"
              :save-body="saveFileText"
              @save="saveFileEdit"
              @open-link="openItem"
              @open-attachment="openAttachment"
              @link-error="onLinkError"
            >
              <template v-if="fileEditing && collab" #collab>
                <CollabBar :provider="collab" />
              </template>
              <template #meta>
                <span class="mono kb-doc-path" :title="current?.source">{{ current?.source }}</span>
                <span v-if="versions[0]">v{{ versions[0].version }}</span>
              </template>
            </DocPage>

            <!-- 其它文件编辑(代码 / 配置 / 文本 / CSV 表格):统一外壳 -->
            <div v-else-if="nativeFileEdit && nativeFileRequest" class="kb-workspace-reader">
              <!-- 多人编辑的头像 / 名单；CSV 表格另有自己的协同状态栏 -->
              <CollabBar v-if="collab && !isCsvFile" :provider="collab" />
              <div class="kb-md-editor-host" data-testid="file-native-editor">
                <Suspense>
                  <EditorHost
                    ref="nativeFileHost"
                    :key="`native-file:${current?.source}:${fileEditEpoch}:${collabKey}`"
                    :request="nativeFileRequest"
                    :transport="nativeFileTransport"
                    :chrome-title="false"
                    :chrome-close="false"
                    :chrome-save="false"
                    :capabilities="{ export: false }"
                    @change="onNativeChange"
                    @saved="void loadVersions()"
                    @dirty="remoteDirty = $event"
                    @error="(err: Error) => (error = err.message)"
                    @fallback="onNativeFallback"
                  />
                  <template #fallback><div class="kb-hint" style-allow="加载提示">加载编辑器…</div></template>
                </Suspense>
              </div>
            </div>
            <!-- 协同连接建立期间的只读占位（连上后才挂外壳，不让人先在单人文档里敲几个字再被房间内容盖掉） -->
            <div v-else-if="fileEditing" class="kb-workspace-reader">
              <CollabBar v-if="collab" :provider="collab" />
              <div class="kb-md-editor-host">
                <Suspense>
                  <CodeEditor :key="collabKey" v-model="fileDraft" :filename="current?.source ?? ''" :collab="collab" :readonly="collabPending" aria-label="文件内容" @save="saveFileEdit" />
                  <template #fallback><div class="kb-hint" style-allow="加载提示">加载编辑器…</div></template>
                </Suspense>
              </div>
            </div>

            <!-- 经验条目 · 源码视图(只读) -->
            <div v-else-if="isInsight && current && !editExpanded && !showRendered" class="kb-workspace-reader">
              <div class="kb-md-editor-host">
                <Suspense>
                  <CodeEditor :model-value="draftBody" filename="insight.md" :readonly="true" aria-label="Markdown 源码(只读)" />
                  <template #fallback><div class="kb-hint" style-allow="加载提示">加载编辑器…</div></template>
                </Suspense>
              </div>
            </div>

            <!-- 经验条目:语雀式文档页(阅读 / 编辑同一页,点「编辑」原地切换) -->
            <DocPage
              v-else-if="isInsight && current"
              ref="docPage"
              :persist-layout="!embedded"
              v-model:title="draftTitle"
              v-model="draftBody"
              :editing="editExpanded"
              :draft-id="props.embedded ? null : current.id"
              :base-title="current.title ?? ''"
              :base-body="current.text"
              :extra="insightExtraNow"
              :base-extra="insightBaseExtra"
              :silent-restore="!collabCapable"
              :collection="current.collection"
              :note-id="current.id"
              :admin-view="viewAs"
              :resolve-titles="resolveTitles"
              :search-notes="searchNotes"
              :collab="collab"
              :collab-pending="collabPending"
              @restore-extra="restoreInsightExtra"
              @draft-state="draftStored = $event"
              @request-edit="requestNoteEdit"
              :save-body="saveText"
              @save="save"
              @open-link="openItem"
              @open-attachment="openAttachment"
              @link-error="onLinkError"
            >
              <template v-if="collab" #collab>
                <CollabBar :provider="collab" />
              </template>
              <template #meta>
                <span class="kb-doc-kind">{{ kindText(current.insight_kind ?? current.kind) }}</span>
                <span v-if="current.updated_at">更新于 {{ fmtUpdated(current.updated_at) }}</span>
                <KbTagEditor v-if="editExpanded" v-model="draftTags" />
                <template v-else>
                  <span v-for="label in current.tags" :key="label" class="kb-doc-tag">#{{ label }}</span>
                </template>
              </template>
            </DocPage>

            <!-- Office 文档在线编辑(Excel) -->
            <OfficeEditor
              v-else-if="officeEditing && current && itemCollection"
              ref="officeEditor"
              :collection="itemCollection"
              :path="current.source"
              @saved="void loadVersions()"
              @close="finishOfficeEdit"
            />

            <!-- 读不到原件时把原因摆出来:语雀式改版时漏掉了这一行,导致只剩一个空的查看器 -->
            <div v-else-if="previewNotice(preview)" class="kb-error kb-preview-notice" role="alert" data-testid="preview-notice">{{ previewNotice(preview) }}</div>

            <!-- 原生 DocViewer 视窗 (PDF / Office / 音视频 / 代码) -->
            <FileViewer
              v-else-if="preview"
              :format="preview.format"
              :blocks="preview.blocks"
              :chunks="preview.chunks"
              :highlight="highlight"
              :raw-url="rawUrl"
              :source-url="downloadUrl"
              :content="preview.content"
              :file-name="current?.source"
              :link-context="fileLinkContext"
              :link-states="fileLinkReport.states"
              native
              @select="(c: PreviewChunk) => (highlight = c.id)"
              @open-attachment="openAttachment"
              @link-error="onLinkError"
            />

            <!-- 打开文档:读取中 / 打不开(带重试)。以前这两种都落到下面的「知识工作台」占位,看起来像什么都没选 -->
            <div v-else-if="selectedId && !current && detailLoading" class="kb-split-empty" data-testid="kb-doc-loading">
              <KbSkeleton variant="card" :lines="4" class="kb-doc-skel" />
            </div>
            <div v-else-if="selectedId && !current && detailFailure" class="kb-split-empty" data-testid="kb-doc-error">
              <KbEmpty icon="failed" title="没能打开这篇文档" :description="detailFailure.message">
                <template v-if="detailFailure.phase === 'error'" #action><KbButton size="sm" variant="primary" @click="openItem(selectedId, { skipGuard: true })">重试</KbButton></template>
              </KbEmpty>
            </div>

            <!-- 文档打开了但读不到文件内容(预览失败)/ 还在读 -->
            <div v-else-if="current && previewLoading" class="kb-split-empty" data-testid="kb-preview-loading">
              <KbSkeleton variant="card" :lines="4" class="kb-doc-skel" />
            </div>
            <div v-else-if="current && previewFailure" class="kb-split-empty" data-testid="kb-preview-error">
              <KbEmpty icon="failed" title="没能读取这个文件的内容" :description="previewFailure.message">
                <template v-if="previewFailure.phase === 'error'" #action><KbButton size="sm" variant="primary" @click="loadPreview">重试</KbButton></template>
              </KbEmpty>
            </div>

            <!-- 空白状态 -->
            <div v-else class="kb-split-empty">
              <KbEmpty
                icon="doc"
                title="知识工作台"
                description="从左侧列表选择文档，或按 ⌘\ 随时展开/收起目录栏享受 100% 独占视窗"
              />
            </div>
          </div>

          <!-- 右侧抽屉面板: 属性、分块与批注 (Inspector Drawer) -->
          <aside v-if="inspectorOpen && current" class="kb-inspector-panel">
            <div class="kb-inspector-panel-head">
              <span>属性与详情</span>
              <button type="button" class="btn sm kb-ghost" title="收起右侧栏 (Esc)" aria-label="收起右侧栏" data-testid="inspector-close" @click="toggleInspector">
                <KbIcon name="close" :size="12" />
              </button>
            </div>

            <!-- 文件模式: 分块 / 批注 / 历史 -->
            <template v-if="fileMode">
              <KbTabs v-model="fileTab" :tabs="fileTabs" flush />
              <div v-if="fileTab === 'chunks'" class="kb-fm-list kb-scroll-y kb-fill">
                <button
                  v-for="chunk in preview?.chunks ?? []"
                  :key="chunk.id"
                  type="button"
                  class="kb-fm-chunk"
                  :class="{ 'is-on': chunk.id === highlight }"
                  @click="highlight = chunk.id"
                >
                  <span class="mono m kb-fm-anchor">{{ chunkLabel(chunk) }}<template v-if="chunk.title"> · {{ chunk.title }}</template></span>
                  <span class="kb-fm-text">{{ chunk.text }}</span>
                </button>
                <div v-if="!preview?.chunks.length" class="m kb-vw-note">还没有内容片段。文件建好索引后会出现在这里。</div>
              </div>
              <div v-else-if="fileTab === 'notes'" class="kb-scroll-y kb-fill">
                <DocComments
                  :key="`${itemCollection}:${current?.source}`"
                  panel
                  :deletable="!readonly"
                  :access="myAccess"
                  :collection="itemCollection"
                  :source="current?.source ?? ''"
                  :my-id="session.user?.id"
                  :focus="commentFocus ?? activeQuote"
                  :anchor="currentAnchor"
                  :pending-quote="pendingQuote"
                  :located-ids="quotePageShown ? locatedIds : null"
                  @counted="(total: number) => (commentTotal = total)"
                  @posted="loadAnnotations"
                  @clear-quote="pendingQuote = null"
                  @locate="locateComment"
                />
              </div>
              <div v-else class="kb-scroll-y kb-fill">
                <VersionHistory
                  :versions="versions"
                  :readonly="readonly || historyLocked"
                  @compare="compareVersion"
                  @restore="restoreVersion"
                />
                <div v-if="historyLocked && versions.length > 1" class="m kb-vw-note kb-ver-lock">正在编辑:先保存或取消,再恢复历史版本</div>
              </div>
            </template>

            <!-- Insight 模式: 关系 / 进化链 / 详细属性 -->
            <template v-else-if="isInsight">
              <KbTabs v-model="tab" :tabs="tabs" flush>
                <template v-if="!readonly" #actions>
                  <button type="button" class="btn sm kb-ghost" title="删除这篇笔记" aria-label="删除" @click="remove">
                    <KbIcon name="trash" :size="14" />
                  </button>
                </template>
              </KbTabs>
              <div v-if="tab === 'relations'" class="kb-scroll-y kb-fill kb-rel" data-testid="doc-relations">
                <template v-if="relations">
                  <div v-if="relationsFallback" class="m kb-vw-note">链接图谱暂时读不到，只显示正文里的双链。</div>
                  <div v-if="relations.outbound.length" class="kb-rel-group">
                    <div class="sec kb-rel-title">这篇引用了 {{ relations.outbound.length }}</div>
                    <button
                      v-for="row in relations.outbound"
                      :key="`out:${row.kind}:${row.collection}:${row.id}`"
                      type="button"
                      class="ni kb-rel-row"
                      :title="row.id"
                      @click="openRelation(row)"
                    >
                      <KbIcon :name="row.kind === 'note' ? 'note' : 'dir'" />
                      <span class="kb-rel-name">{{ row.title }}</span>
                      <span v-if="row.line || row.count > 1" class="cnt">
                        <template v-if="row.line">第 {{ row.line }} 行</template><template v-if="row.count > 1"><template v-if="row.line"> · </template>{{ row.count }} 处</template>
                      </span>
                    </button>
                  </div>
                  <div v-if="relations.inbound.length" class="kb-rel-group">
                    <div class="sec kb-rel-title">引用了这篇 {{ relations.inbound.length }}</div>
                    <button
                      v-for="row in relations.inbound"
                      :key="`in:${row.kind}:${row.collection}:${row.id}`"
                      type="button"
                      class="ni kb-rel-row"
                      :title="row.id"
                      @click="openRelation(row)"
                    >
                      <KbIcon :name="row.kind === 'note' ? 'note' : 'dir'" />
                      <span class="kb-rel-name">{{ row.title }}</span>
                      <span v-if="row.line || row.count > 1" class="cnt">
                        <template v-if="row.line">第 {{ row.line }} 行</template><template v-if="row.count > 1"><template v-if="row.line"> · </template>{{ row.count }} 处</template>
                      </span>
                    </button>
                  </div>
                  <KbEmpty
                    v-if="!relations.outbound.length && !relations.inbound.length"
                    icon="link"
                    title="没有关联"
                    description="正文里用 [[笔记]] 或链接引用别的文档，就会出现在这里；别的文档引用这篇时也会列在「引用了这篇」"
                  />
                </template>
                <div v-else class="m kb-vw-note">正在读取关系…</div>
              </div>
              <div v-else-if="tab === 'chain'" class="kb-scroll-y kb-fill">
                <!-- 正文版本历史:每次保存一条,能对比「这次改了什么」、能恢复 -->
                <VersionHistory
                  :versions="versions"
                  :readonly="readonly || historyLocked"
                  empty-text="这篇笔记还没有保存过版本"
                  @compare="compareVersion"
                  @restore="restoreVersion"
                />
                <div v-if="historyLocked && versions.length > 1" class="m kb-vw-note kb-ver-lock">正在编辑:先保存或取消,再恢复历史版本</div>
                <template v-if="chain.length > 1">
                  <div class="m kb-ver-chain-title">笔记的演化链</div>
                  <KbChain :events="chain" @select="(event) => event.id && openItem(event.id)" />
                </template>
              </div>
              <div v-else-if="tab === 'comments'" class="kb-scroll-y kb-fill">
                <DocComments
                  :key="current?.id"
                  panel
                  :deletable="!readonly"
                  :access="myAccess"
                  :collection="current?.collection ?? collection"
                  :source="`insight:${current?.id}`"
                  :my-id="session.user?.id"
                  :focus="commentFocus"
                  @counted="(total: number) => (insightComments = total)"
                />
              </div>
              <div v-else class="kb-form kb-scroll-y kb-fill">
                <label>编号</label><span class="kb-mono">{{ current.id }}</span>
                <label>集合</label><span class="kb-mono">{{ current.collection }}</span>
                <label>状态</label><span>{{ STATUS_TEXT[current.status] ?? current.status }}</span>
                <label>更新时间</label><span class="kb-mono">{{ localeDateTime(current.updated_at, { hour12: false }) }}</span>
              </div>
            </template>
          </aside>
        </div>
      </main>
    </div>

    <!-- ==================== 双栏工作台 附属: 全量数据表格视图 ==================== -->
    <div v-else class="kb-split">
      <div class="pane-list kb-split-list" style-allow="数据表格独占全屏">
        <div class="row kb-split-bar">
          <KbFilterBar v-model="filterText" :chips="chips" placeholder="筛选笔记和文件…" @submit="applyFilterText(true)" @remove="removeChip" />
          <KbSelect v-model="sort" :options="sortOptions" size="sm" icon="sort" display="更新时间" :caret="false" align="end" />
          <KbSelect v-model="status" :options="statusOptions" size="sm" icon="filter" :display="`筛选 ${filterCount}`" :caret="false" align="end" />
          <RouterLink v-if="!readonly" class="btn sm" :to="PATHS.projects" title="添加、编辑或删除项目和集合">管理</RouterLink>
          <button v-if="!readonly" type="button" class="btn sm pri" @click="startCreate; setViewMode('dual')">+ 新建</button>
        </div>
        <div v-if="listFailure" class="row kb-error kb-split-note" role="alert" data-testid="kb-list-error">
          <span>{{ listFailure.message }}</span>
          <KbButton v-if="listFailure.phase === 'error'" size="sm" :disabled="listLoading" @click="loadItems">重试</KbButton>
        </div>
        <div class="kb-split-body" :aria-busy="listLoading">
          <KbDataTable
            class="kb-list-table"
            :columns="listColumns"
            :rows="list?.items ?? []"
            :selectable="true"
            :selected="selectedId"
            :empty="collections.length ? '没有符合条件的内容' : '知识库还是空的。新建笔记,或到「导入」页添加文件。'"
            @select="(row) => { openItem((row as ItemSummary).id); setViewMode('dual'); }"
            @menu="(row, _index, event) => openRowContextMenu(event, row as ItemSummary)"
          >
            <template #dot="{ row }"><span class="dot" :style="{ background: statusDot(row as ItemSummary) }" style-allow="状态点颜色来自数据"></span></template>
            <template #id="{ row }">{{ (row as ItemSummary).id }}</template>
            <template #title="{ row }"><span :title="(row as ItemSummary).source">{{ rowTitle(row as ItemSummary) }}</span></template>
            <template #kind="{ row }"><span class="tag">{{ kindText((row as ItemSummary).insight_kind ?? (row as ItemSummary).kind) }}</span></template>
            <template #score="{ row }">{{ hasConfidence ? ((row as ItemSummary).confidence ?? 0).toFixed(2) : (row as ItemSummary).version ? `v${(row as ItemSummary).version}` : '—' }}</template>
            <template #updated="{ row }">{{ fmtUpdated((row as ItemSummary).updated_at) }}</template>
          </KbDataTable>
        </div>
        <KbPager v-model:page="page" v-model:page-size="pageSize" :total="total" />
      </div>
    </div>

    <!-- 标签 / 元数据对话框 -->
    <KbDialog v-if="metaOpen && current" title="标签 / 元数据" :subtitle="fileName" plain @close="closeMeta">
      <div v-if="error" class="kb-error">{{ error }}</div>
      <div class="kb-dlg-meta kb-form">
        <template v-for="row in fileMetaRows" :key="row.label">
          <label>{{ row.label }}</label><span :class="{ mono: row.mono }">{{ row.value }}</span>
        </template>
        <label>路径</label><span class="mono">{{ current.source }}</span>
        <label>集合</label><span class="mono">{{ current.collection }}</span>
        <label>标签</label><KbTagEditor v-model="draftTags" />
      </div>
      <div class="row kb-dlg-foot">
        <button type="button" class="btn sm" @click="closeMeta">关闭</button>
        <KbSubmitButton label="保存" done-label="已保存" :busy="saving" :done-at="savedAt" :disabled="!dirty" @click="saveMeta" />
      </div>
    </KbDialog>

    <!-- 两版正文的逐行对比 -->
    <VersionDiff
      v-if="diffOpen"
      :before="diffBefore"
      :after="diffAfter"
      :loading="diffLoading"
      :error="diffError"
      @close="diffOpen = false"
    />

    <!-- 微信 / QQ 里点了「下载」:说明怎么在浏览器里打开(手机上 KbDialog 自己是贴底的弹层) -->
    <KbDialog v-if="inAppDownloadOpen" title="请在浏览器中打开" width="420px" @close="inAppDownloadOpen = false">
      <InAppDownloadNote />
      <template #footer>
        <a v-if="downloadUrl" class="btn sm" :href="downloadUrl" :download="fileName" data-testid="inapp-try-download" @click="inAppDownloadOpen = false">仍然尝试下载</a>
        <KbButton size="sm" variant="primary" @click="inAppDownloadOpen = false">知道了</KbButton>
      </template>
    </KbDialog>

    <!-- 文件右键菜单 / 手机长按弹层:同一份动作,只是呈现方式不同 -->
    <RowActionMenu v-if="rowMenu" :state="rowMenu" @close="rowMenu = null" />
    <FileActionMenu
      v-if="fileMenu && fileMenu.point"
      :state="fileMenu"
      :selectable="canShare"
      @close="closeFileMenu"
      @pick="fileActions.start"
      @select="pickSelectFromMenu"
    />
    <FileActionSheet
      v-else-if="fileMenu"
      :state="fileMenu"
      :selectable="canShare"
      @close="closeFileMenu"
      @pick="fileActions.start"
      @select="pickSelectFromMenu"
    />
    <FileDeleteDialog
      v-if="fileDialog === 'delete' && fileTarget && fileActionsInfo"
      :actions="fileActionsInfo"
      :busy="fileBusy"
      :error="fileError"
      :result="fileResult"
      @close="fileActions.closeDialog"
      @confirm="fileActions.confirmDelete"
    />
    <FileMoveDialog
      v-if="fileDialog === 'move' && fileTarget && fileActionsInfo"
      :actions="fileActionsInfo"
      :dirs="moveDirs"
      :collections="collections.map((item) => item.name)"
      :busy="fileBusy"
      :error="fileError"
      :result="fileResult"
      @close="fileActions.closeDialog"
      @confirm="fileActions.confirmMove"
    />

    <!-- 分享面板:电脑是对话框,手机是底部弹层 -->
    <SharePanel v-if="shareTargets" :targets="shareTargets" :titles="shareTitles" :initial-tab="shareTab" @close="closeShare" />
  </component>
</template>

<style scoped>
/* 历史版本:编辑中不许恢复的提示 / 演化链小标题 */
.kb-ver-lock { padding: 2px 8px 8px; color: var(--t2); }
.kb-ver-chain-title { margin: 10px 8px 4px; color: var(--t2); }
/* 弹窗里的根节点:填满 KbDialog 的正文区,内部双栏/表格继续按 flex 分配高度 */
.kb-embed-page { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; overflow: hidden; }
.kb-embed-page :deep(.kb-workbench-dual), .kb-embed-page :deep(.kb-split) { flex: 1 1 auto; min-height: 0; }
.kb-embed-bar { display: flex; justify-content: flex-end; flex: none; padding: 6px 12px; border-bottom: var(--hl) solid var(--b); }
/* 「关系」页签:一组出链、一组入链。行是按钮(能键盘打开),样子沿用侧栏 .ni;
   标题单行省略——右侧栏只有 260–320 宽,长笔记名不能把「第 N 行」挤出可视区 */
.kb-rel-group + .kb-rel-group { margin-top: var(--sp-2); }
.kb-rel-row { appearance: none; width: 100%; border: 0; background: transparent; font: inherit; font-size: var(--text-13); line-height: 20px; text-align: left; }
.kb-rel-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-rel-row .cnt { flex: none; margin-left: var(--sp-1); }
.kb-rel .kb-vw-note { padding: var(--sp-3) var(--sp-2); }
</style>
