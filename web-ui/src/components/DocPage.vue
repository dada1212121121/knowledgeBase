<script setup lang="ts">
// 语雀式文档页:标题 + 元信息 + 正文(阅读走 MarkdownRead,编辑走统一编辑器外壳)+ 大纲。阅读和编辑是同一个页面,只切 readonly。
//   宽(≥ 900 px 容器):正文居中限宽 760 px,右侧悬浮大纲(留白放得下时默认展开,记住选择),滚动时高亮当前小节;
//   窄(平板竖屏 / 手机):大纲收进标签行里的「大纲」按钮,点开是底部抽屉;正文 16 px、左右 16 px 边距。
//   编辑时正文实时存本地草稿(防刷新 / 断网丢稿),再次进入编辑会提示恢复。
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { KbIcon } from '@kb-ui/index'
import FoldTransition from '@/components/FoldTransition.vue'
import { exportImageSizes } from '@/utils/imageSize'
import { blockKeysMatch, readerBlockKey } from '@/utils/blockKey'
import MarkdownRead from '@/components/MarkdownRead.vue'
// 编辑器内核按需加载:阅读态走 MarkdownRead,不需要把 ProseMirror 文本面带进首屏静态图。
// 骨架屏：编辑器 chunk 加载中、以及新外壳等多人编辑房间连上时占住版式
const DocSkeleton = defineAsyncComponent(() => import('@/components/DocSkeleton.vue').then((mod) => mod.default))
// 新编辑器外壳只在编辑态按需加载：阅读路径的静态图里不能出现它，
// 否则每次看笔记都要为「可能编辑」多下一份外壳与注册表。
const EditorHost = defineAsyncComponent({
  loader: () => import('@/editor/host/EditorHost.vue').then((mod) => mod.default),
  loadingComponent: DocSkeleton,
  delay: 120,
})
import type { SessionTransport } from '@/editor/session/DocumentSession'
import type { CommandResult, EditorCommand, EditorOpenRequest, SaveResult, TextNoteHit, TextServices } from '@/editor/types'
import type { QuoteItem } from '@/editor/surfaces/text/docPlugins'
import type { QuoteAnchor } from '@/utils/quoteAnchor'
import type { CollabProvider, CollabState } from '@/collab/provider'
import { useCollabKey } from '@/collab/useCollabKey'
import { useSessionStore } from '@/stores/session'
import { linkItemKey, linkItemLabel, useDocLinks } from '@/composables/useDocLinks'
import { useViewCall } from '@/composables/useViewCall'
import { downloadUrl as fileDownloadUrl, rawUrl as fileRawUrl } from '@/utils/attachments'
import { kbFileHref, relativeFileHref, type FileHit, type LinkCheckItem, type LinkContext } from '@/utils/links'
import { uploadFile } from '@/api/upload'
import { aiWrite } from '@/api/aiWrite'
import { useFeature } from '@/composables/useFeature'
import { useActiveDocStore, type EditorPaletteBridge } from '@/stores/activeDoc'
import { locateNeedle, selectTextIn } from '@/utils/locateText'
import {
  buildOutline,
  clearDraft,
  collabDraftFields,
  countWords,
  draftCarriesBody,
  draftWorthRestoring,
  loadDraft,
  outlineDepth,
  readingMinutes,
  leadingHeading,
  sameTitle,
  restoreMode,
  saveDraft,
  scopedDraftId,
  type Draft,
  type OutlineItem,
} from '@/utils/docText'

const props = withDefaults(
  defineProps<{
    title: string
    modelValue: string
    editing: boolean
    /** 标题能不能改(Markdown 文件的标题是文件名,不能在这里改) */
    titleEditable?: boolean
    titlePlaceholder?: string
    /** 草稿键(条目 id / 文件路径);不给就不存草稿 */
    draftId?: string | null
    /** 服务器上的原文(判断草稿是否值得恢复) */
    baseTitle?: string
    baseBody?: string
    /** 标题、正文之外要跟着草稿一起存的内容(标签、种类),调用方序列化成字符串;和服务器上的一份比较 */
    extra?: string
    baseExtra?: string
    /**
     * 草稿的正文能不能静默放回编辑器。单人编辑可以(草稿是在现在这一版上改的才放);
     * 能多人编辑的文档不行:正文以房间为准,编辑器也会忽略外部传入的正文。
     */
    silentRestore?: boolean
    /** 图片 / 附件上传到哪个集合 */
    collection?: string | null
    /** 这是集合里哪个文件(Markdown 文件才有):正文里的相对图片地址按它所在目录解析 */
    sourcePath?: string | null
    /** 管理员只读查看:图片 / 附件原件地址带上目标用户 */
    adminView?: string
    /** 笔记条目 id(链接体检只用于展示;文件文档不传) */
    noteId?: string | null
    /** 记住宽屏 / 目录偏好;管理员查看弹窗里关闭,不读也不写管理员自己的设置 */
    persistLayout?: boolean
    /** 选区批注:已有评论的摘录 / 聚焦的评论 / 能不能新建(透传给正文编辑器) */
    quotes?: QuoteItem[]
    activeQuote?: string | null
    annotatable?: boolean
    resolveTitles?: (ids: string[]) => Promise<Record<string, string>>
    searchNotes?: (query: string) => Promise<TextNoteHit[]>
    /** 多人在线编辑的连接;不给就是普通的单人编辑 */
    collab?: CollabProvider | null
    /** 正在建立协作连接:编辑器先只读,连上后(整个重建)才可输入 */
    /**
     * 是否显示页面大标题。默认不显示（阅读和编辑都不显示）：正文自己就有一级标题，页头再画一遍是重复。
     * 只有新建笔记要用：那时正文是空的，标题只能在这里填
     */
    showTitle?: boolean
    collabPending?: boolean
    /**
     * 编辑器外壳的保存通道：页面自己知道怎么落盘（create/edit/save_file），
     * 外壳只负责「把当前正文交出去」并拿回版本。不传（新建笔记的草稿页）时 Ctrl/⌘+S 等同页头的「保存」。
     */
    saveBody?: (text: string) => Promise<SaveResult>
  }>(),
  { quotes: () => [], saveBody: undefined, activeQuote: null, annotatable: false, collab: null, showTitle: false, sourcePath: null, adminView: '', persistLayout: true, collabPending: false, titleEditable: true, titlePlaceholder: '请输入标题', draftId: null, baseTitle: '', baseBody: '', extra: undefined, baseExtra: undefined, silentRestore: true, collection: null, noteId: null, resolveTitles: undefined, searchNotes: undefined },
)
const emit = defineEmits<{
  'update:title': [value: string]
  'update:modelValue': [value: string]
  /** 草稿里的附加内容(标签、种类)被放回来了 */
  restoreExtra: [value: string]
  /** 现在这份改动有没有安全地存在本机草稿里(界面据此写「草稿已自动保存」) */
  draftState: [stored: boolean]
  save: []
  openLink: [id: string]
  openAttachment: [target: { collection: string; path: string; fragment?: string }]
  linkError: [message: string]
  annotate: [anchor: QuoteAnchor]
  /** 阅读时双击了正文：页面能编辑就进入编辑（光标落在双击的地方，见 onEditorReady） */
  requestEdit: []
  quoteClick: [id: string]
  quotesLocated: [ids: string[]]
}>()

const host = ref<HTMLElement | null>(null)
const callCapability = useViewCall(() => props.adminView)
/**
 * 阅读态是否走轻量渲染。
 * 只读正文且没有批注 / 多人编辑连接时才换成 markdown-it 直接出 HTML 的管线（看笔记不为编辑器内核付体积）；
 * 要画批注高亮、挂选区「评论」入口、绑多人房间的阅读，需要 ProseMirror，走下面的编辑器外壳（只读打开）。
 * 默认就走轻量阅读。
 */
const lightRead = computed(() => !props.editing && !props.collab && !props.annotatable && props.quotes.length === 0)
/**
 * 正文是否交给编辑器外壳（多人编辑、笔记、批注 / 管理员巡检都走外壳；
 * 起旧编辑器与 `?editor=legacy` 回退已删除，外壳是唯一实现）。凡是不走轻量阅读的场景都在外壳里：
 * - 编辑；
 * - 带批注的阅读（高亮 + 选中文字的「评论」入口，由文本面的装饰与浮钮提供）；
 * - 管理员巡检别人的库：以只读打开（request.readonly + 没有写权限），能看、能选、不能改，不出现保存。
 * 新建笔记的草稿页没有保存通道（saveBody）：正文还没有落点，保存由页头的「保存」走 `save` 事件创建；
 * 外壳里按 Ctrl/⌘+S 时同样发 `save`。
 * 多人编辑：房间格式见 editor/surfaces/text/schema.ts（节点名与历史房间一致，已存在的房间内容照常打开）；
 * 房间还在连接时先显示骨架（nativePending），连上后带着房间挂载，不让人在单人文档上先写几个字再被房间内容盖掉。
 */
/**
 * 阅读 → 编辑的交接（见模板里的说明）：点「编辑」的那一刻如果正显示着读到的内容，就让它继续显示，
 * 编辑器在旁边（看不见、不占版面）起来，起来了（EditorHost 发 ready）再换。
 * 兜底 8 秒：编辑器一直起不来（出错、房间连不上）就别再拖，回到原来的骨架 / 错误提示。
 */
const holdRead = ref(false)
const heldSource = ref('')
let holdTimer = 0
function endHold() {
  window.clearTimeout(holdTimer)
  holdRead.value = false
}
const nativeWanted = computed(() => !lightRead.value)
/**
 * 多人编辑的连接还在建立、或已连上但文档内容还没就绪：外壳（工具栏、正文、状态栏）都不挂，只放骨架。
 * 以前只等到「连接对象建好」就挂外壳，之后到文档就绪之间会看到空的工具栏、空正文，
 * 和底部「正在连接协同…·只读」；而且空文档会把页面里的正文写成空（字数变 0、标题判断出错）。
 *
 * 什么时候放行（挂外壳）：
 * - 第一次同步成功（everSynced）；
 * - 服务端指定我来初始化这篇笔记的房间（initMarkdown 非空）：初始化要由编辑器把正文放进房间，房间才会就绪，
 *   这时不挂外壳就是死等；
 * - 连不上（被拒、断网、被终止）：让外壳以只读显示并说明原因，不能让人对着骨架一直等。
 * 放行后不再收回（闩锁）：之后断线、重连、初始化完成都不能把编辑器拆掉重装。
 */
const collabReleased = ref(false)
const collabWaiting = computed(() => !!props.collab && !collabReleased.value)
function releaseCollabWait(state: CollabState | null) {
  if (!state) return
  if (state.everSynced || state.initMarkdown !== null || state.end || state.status === 'offline' || state.status === 'closed') collabReleased.value = true
}
const nativePending = computed(() => nativeWanted.value && (props.collabPending || collabWaiting.value))
const nativeEdit = computed(() => nativeWanted.value && !nativePending.value)
/**
 * 外壳是不是只读打开：不在编辑，或管理员巡检（别人的库，任何情况下都不能改）。
 * 会话的只读在打开时定下来，所以编辑 ⇄ 阅读切换时靠 key 重建外壳（见模板），不在原地翻转
 */
const nativeReadonly = computed(() => !props.editing || !!props.adminView)
/** 选中文字能不能新建批注：只读巡检里不能（评论是对别人库的写操作） */
const canAnnotate = computed(() => props.annotatable && !props.adminView)
/** 草稿恢复 / 撤回会整体换正文；用 key 让外壳带着新正文重建，而不是在旧文档上打补丁 */
const nativeEpoch = ref(0)
const nativeHost = ref<{
  flushText: () => Promise<string>
  currentText: () => string | null
  openFind: () => void
  openShortcuts: () => void
  focus: () => void
  refreshText: () => Promise<void>
  replaceHref: (oldHref: string, newHref: string) => Promise<number>
  executeCommand: (command: EditorCommand) => Promise<CommandResult>
  query: (query: { type: string; args?: unknown }) => Promise<unknown>
  /** ⌘K 面板：列出 / 执行当前可用的编辑器命令（UI-5） */
  paletteActions: () => { id: string; label: string; hint?: string; keywords?: string }[]
  runPaletteAction: (id: string) => void | Promise<void>
  /** 打开 AI 写作条（UI-3） */
  openAi?: () => void
} | null>(null)
const nativeTransport: SessionTransport = {
  save: async (request) => {
    if (!props.saveBody) {
      // 新建笔记：没有可写回的文档，Ctrl/⌘+S 等同点页头的「保存」（页面先 flush 再创建）。
      // 外壳这边按“已提交”处理；创建失败时页面会自己提示，正文仍在编辑器里，不会丢
      emit('save')
      return { ok: true, revision: request.revision, sha256: '' }
    }
    try {
      return await props.saveBody(request.source.kind === 'text' ? request.source.text : '')
    } catch (err) {
      return {
        ok: false,
        revision: request.revision,
        sha256: '',
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  },
}
const nativeRequest = computed<EditorOpenRequest>(() => ({
  fileId: props.noteId ?? props.sourcePath ?? props.draftId ?? 'document',
  collection: props.collection ?? undefined,
  path: props.sourcePath ?? undefined,
  format: 'md',
  // 首屏内容只在 openDocument 时读一次；后续变化由外壳自己维护，不能因为 v-model 回写而重建文档
  source: { kind: 'text', text: props.modelValue, name: props.title || '未命名.md' },
  readonly: nativeReadonly.value,
  revision: 0,
  permissions: { read: true, write: !nativeReadonly.value, comment: canAnnotate.value, ai: false, export: true },
  // 多人编辑：正文以房间为准，外壳不走本地保存（标题 / 标签仍由页面保存，正文由落地调度提交）
  ...(props.collab ? { collabRich: props.collab, collabStatus: props.collab } : {}),
}))
// 链接体检:只提示「目标在不在」,不改正文。分享页走自己的 access.call,这里只服务自己的库。
const linkContext = computed<LinkContext | null>(() =>
  props.collection
    ? {
        collection: props.collection,
        sourcePath: props.sourcePath,
        adminView: props.adminView,
        rawUrl: (collection, path) => fileRawUrl(collection, path, props.adminView),
        downloadUrl: (collection, path) => fileDownloadUrl(collection, path, props.adminView),
      }
    : null,
)
const { report: linkReport, reload: linkReload } = useDocLinks({
  source: () => props.modelValue,
  context: () => linkContext.value,
  call: callCapability,
  noteId: () => props.noteId,
})
/* ---------------- 修坏引用:上传补上 / 从库中选择 ---------------- */
// 体检只提示,修复必须由人点:上传会写到断链解析出的目标路径,选择会替换正文里对应的
// href。两条路都不自动猜同名文件,避免把错误内容悄悄塞进用户的知识库。
const linkUploadInput = ref<HTMLInputElement | null>(null)
const linkUploadTarget = ref<LinkCheckItem | null>(null)
const linkUploading = ref(false)
function pickMissingUpload(item: LinkCheckItem) {
  if (!props.editing || props.adminView || item.kind === 'note' || !item.collection || !item.path) return
  linkUploadTarget.value = item
  linkUploadInput.value?.click()
}
async function onMissingUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const target = linkUploadTarget.value
  linkUploadTarget.value = null
  if (!file || !target) return
  linkUploading.value = true
  try {
    await uploadFile(file, { collection: target.collection, relPath: target.path })
    linkReload()
    notifyLinkError(`已补传 ${target.collection}/${target.path},引用体检会重新检查`)
  } catch (err) {
    notifyLinkError(`补传失败:${err instanceof Error ? err.message : String(err)}`)
  } finally {
    linkUploading.value = false
  }
}

const fixTarget = ref<LinkCheckItem | null>(null)
const fixQuery = ref('')
const fixResults = ref<FileHit[]>([])
const fixCollection = ref('')
const fixLoading = ref(false)
let fixTimer = 0
function startFix(item: LinkCheckItem) {
  if (!props.editing || item.kind === 'note' || !item.collection) return
  fixTarget.value = item
  fixCollection.value = item.collection
  fixQuery.value = (item.path.split('/').pop() ?? '').replace(/\.[^.]+$/, '')
  fixResults.value = []
  void searchFixFiles()
}
async function searchFixFiles() {
  if (!fixTarget.value) return
  fixLoading.value = true
  try {
    const hits = await searchFiles(fixQuery.value, fixCollection.value || props.collection || '')
    fixResults.value = hits.filter(
      (hit) => hit.collection !== fixTarget.value?.collection || hit.path !== fixTarget.value?.path,
    )
  } catch {
    fixResults.value = []
  } finally {
    fixLoading.value = false
  }
}
watch(fixQuery, () => {
  window.clearTimeout(fixTimer)
  fixTimer = window.setTimeout(() => void searchFixFiles(), 160)
})
function stopFix() {
  window.clearTimeout(fixTimer)
  fixTarget.value = null
  fixResults.value = []
}
function hrefForFix(hit: FileHit): string {
  const same = props.collection === hit.collection
  const relative = same ? relativeFileHref(props.sourcePath, hit.path) : null
  const href = relative ?? kbFileHref(hit.collection, hit.path, { download: hit.template })
  if (!href) return ''
  if (hit.template && !href.includes('download=1')) return `${href}?download=1`
  return href
}
async function chooseFix(hit: FileHit) {
  const target = fixTarget.value
  if (!target) return
  if (!target.href) {
    notifyLinkError('这条引用没有可回写的原始地址,请直接在正文里改')
    return
  }
  const href = hrefForFix(hit)
  if (!href) {
    notifyLinkError('这个文件不能引用(路径不合法)')
    return
  }
  // 走命令（进撤销栈、协同里同步给别人）
  const count = (await nativeHost.value?.replaceHref(target.href, href)) ?? 0
  if (!count) {
    notifyLinkError('正文里已经找不到这个旧地址,可能刚改过;请在正文里手动改')
    return
  }
  notifyLinkError(`已替换 ${count} 处,记得保存`)
  stopFix()
  linkReload()
}

const fileCollections = ref<{ name: string }[]>([])
/** 引用文件选择器的集合列表:失败就不弹集合切换,当前集合仍可搜 */
async function loadFileCollections() {
  try {
    const catalog = await callCapability<{ collections?: { name: string }[] }>('list_collections')
    fileCollections.value = catalog.collections ?? []
  } catch {
    fileCollections.value = []
  }
}
/** 目录扫描按关键词过滤;`list_files` 只返回当前用户能看到的集合 */
async function searchFiles(query: string, collection: string): Promise<FileHit[]> {
  const reply = await callCapability<{ items?: FileHit[] }>('list_files', {
    collection,
    q: query.trim() || undefined,
    page_size: 60,
  })
  return (reply.items ?? []).map((item) => ({ ...item, collection: item.collection || collection }))
}
onMounted(() => void loadFileCollections())
watch(
  () => props.collection,
  () => void loadFileCollections(),
)
/**
 * 新外壳文本面需要的页面数据与出口。全是「现读」函数：体检结果、集合列表异步回来、
 * 正文路径变化时，编辑器不用重建；数据变了通知它重画装饰即可（见下面的 watch）。
 */
const textServices: TextServices = {
  collection: () => props.collection ?? null,
  sourcePath: () => props.sourcePath ?? null,
  adminView: () => props.adminView,
  linkContext: () => linkContext.value,
  linkStates: () => linkReport.value.states,
  resolveTitles: props.resolveTitles ? (ids) => props.resolveTitles!(ids) : undefined,
  searchNotes: props.searchNotes ? (query) => props.searchNotes!(query) : undefined,
  searchFiles: (query, collection) => searchFiles(query, collection),
  fileCollections: () => fileCollections.value,
  // 选区批注：评论栏在 Browser 里，这里只做转接。列表 / 聚焦项现读，变了由下面的 watch 通知文本面重画高亮
  comments: {
    quotes: () => props.quotes,
    activeQuote: () => props.activeQuote,
    canAnnotate: () => canAnnotate.value,
    annotate: (quote) => emit('annotate', quote),
    quoteClick: (id) => emit('quoteClick', id),
    located: (ids) => emit('quotesLocated', ids),
  },
  openLink: (id) => emit('openLink', id),
  openAttachment: (target) => emit('openAttachment', target),
  linkError: (message) => notifyLinkError(message),
}
// 链接体检是异步回来的：结果到了就重画虚线 / 提示，不用重新加载正文
watch(
  () => [linkContext.value, linkReport.value.states],
  // Host 是异步组件：加载完成前 ref 上还没有暴露的方法，链接状态先变时不能报错
  () => void nativeHost.value?.refreshText?.(),
  { deep: true },
)
// 评论列表 / 聚焦项 / 能不能评论变了：让文本面重算高亮（只带 meta，不改文档、不进撤销栈）。
// 外壳还没挂好时不用管——它挂载时会现读最新的列表
watch(
  () => [props.quotes, props.activeQuote, canAnnotate.value],
  () => void nativeHost.value?.executeCommand?.({ id: `quotes_${Date.now()}`, type: 'text.quotes.refresh', source: 'api', readonlySafe: true }),
  { deep: true },
)
/** 引用图谱里的入链(谁引用了当前文档);只在需要时查一次,不参与保存 */
interface InboundLink {
  source_kind: string
  source_collection: string
  source_id: string
  source_title: string
  href: string
  line: number
}
const inbound = ref<InboundLink[]>([])
/**
 * 入链按来源文档归并:同一篇在一段里引用了两次时,服务端会回两行;清单是「哪些文档引用了它」,
 * 不是「几处链接」,所以只列一次,把处数记在 count 里(行号取第一处)。
 */
interface InboundGroup extends InboundLink {
  count: number
}
const inboundGroups = computed<InboundGroup[]>(() => {
  const groups = new Map<string, InboundGroup>()
  for (const link of inbound.value) {
    const key = `${link.source_kind}:${link.source_collection}:${link.source_id}`
    const found = groups.get(key)
    if (found) found.count += 1
    else groups.set(key, { ...link, count: 1 })
  }
  return [...groups.values()]
})
const linkPanelOpen = ref(false)
async function loadInbound() {
  if (!props.collection) return
  try {
    const reply = await callCapability<{ inbound?: InboundLink[] }>('doc_links', {
      ...(props.noteId ? { note_id: props.noteId } : { collection: props.collection, path: props.sourcePath ?? '' }),
      direction: 'to',
      limit: 50,
    })
    inbound.value = reply.inbound ?? []
  } catch {
    // 链接图谱是辅助信息:旧服务没有这个能力时静默隐藏,不影响阅读
    inbound.value = []
  }
}
onMounted(() => void loadInbound())
watch(
  () => [props.collection, props.sourcePath, props.noteId],
  () => {
    linkPanelOpen.value = false
    void loadInbound()
  },
)
function openInbound(link: InboundLink) {
  if (link.source_kind === 'note') emit('openLink', link.source_id)
  else emit('openAttachment', { collection: link.source_collection, path: link.source_id })
}
function openOutbound(link: { kind?: 'file' | 'note'; collection: string; path: string; noteId?: string }) {
  if (link.kind === 'note' && link.noteId) emit('openLink', link.noteId)
  else if (link.collection && link.path) emit('openAttachment', { collection: link.collection, path: link.path })
}
const linkProblems = computed(() => linkReport.value.missing.length + linkReport.value.outside.length + linkReport.value.unsupported.length)
const linkListOpen = ref(false)
const copiedLinks = ref(false)
const linkNotice = ref('')
let linkNoticeTimer = 0
function notifyLinkError(message: string) {
  linkNotice.value = message
  window.clearTimeout(linkNoticeTimer)
  linkNoticeTimer = window.setTimeout(() => (linkNotice.value = ''), 6000)
}
async function copyLinkProblems() {
  const lines = [
    ...linkReport.value.missing.map((item) => `未找到：${linkItemLabel(item)}`),
    ...linkReport.value.outside.map((item) => `没有访问权限：${linkItemLabel(item)}`),
    ...linkReport.value.unsupported.map((item) => `原电脑路径：${item.href}`),
  ]
  try {
    await navigator.clipboard.writeText(lines.join('\n'))
    copiedLinks.value = true
    window.setTimeout(() => (copiedLinks.value = false), 3000)
  } catch {
    linkListOpen.value = true
  }
}
const collabKey = useCollabKey(() => props.collab)
const reader = ref<InstanceType<typeof MarkdownRead> | null>(null)
// 点「编辑」时武装交接；退出编辑（保存 / 取消）或换文档就结束。reader 此刻还挂着 = 正显示着读到的内容
watch(
  () => props.editing,
  (now, was) => {
    if (now && !was && reader.value && props.modelValue.trim() !== '') {
      heldSource.value = props.modelValue
      holdRead.value = true
      window.clearTimeout(holdTimer)
      holdTimer = window.setTimeout(endHold, 8000)
    } else if (!now) {
      endHold()
    }
    // 阅读也用编辑器外壳（Markdown 文件开着批注）：没有「继续显示读到的内容」这一段，旧外壳马上要换成可编辑的。
    // 趁它还在先问它正看着哪一块（查询在调用时同步算完，返回的只是包着结果的 Promise）
    if (now && !was && !reader.value && nativeHost.value) captureHostPlan(nativeHost.value)
  },
)
/* ---------------- 阅读 → 编辑：位置不跳、光标就位 ---------------- */
// 以前点「编辑」之后正文停在哪全凭运气：编辑器里多了吸顶的工具栏，块与块的间距也和阅读页不完全一样，
// 长文越往下差得越多（读到第 60 节，进编辑后顶上是第 56 节），而且光标在文档开头、屏幕外面，得再点一下才能打字。
// 现在交接那一刻（编辑器就绪、读到的内容还显示着）记下屏幕上正看着的那一块和它离屏幕顶的距离，
// 换成编辑器后把同一块滚回同一个位置（被吸顶工具栏挡住时往下让一点），光标放在那一块开头；
// 双击正文进来的，光标落在双击的那个字上。块怎么对应见 utils/blockKey.ts
/** 双击正文时记下的位置：哪一块、点在块里的哪儿（相对块左上角，期间页面滚了也不受影响） */
let pendingCaret: { block: HTMLElement; dx: number; dy: number; at: number } | null = null
/** 双击了这些东西不算「要编辑」：链接、按钮、图片、公式 / 流程图（它们有自己的双击 / 点击行为） */
const DBLCLICK_IGNORE = 'a, button, input, textarea, select, summary, img, video, audio, iframe, svg, .katex, .kb-mermaid, .kb-math, [contenteditable]'
function onReaderDblclick(event: MouseEvent) {
  if (props.editing || props.adminView) return
  const target = event.target instanceof Element ? event.target : null
  if (!target || target.closest(DBLCLICK_IGNORE)) return
  const blocks = reader.value?.blockElements() ?? []
  const block = blocks.find((el) => el.contains(target))
  if (!block) return
  const rect = block.getBoundingClientRect()
  pendingCaret = { block, dx: event.clientX - rect.left, dy: event.clientY - rect.top, at: Date.now() }
  emit('requestEdit')
}

interface HandoffPlan {
  key: string
  occurrence: number
  /** 那一块此刻离视口顶的距离（px） */
  top: number
  /** 双击的位置（视口坐标）：光标放到这里 */
  caret?: { x: number; y: number }
}

/** 正文滚动区的上沿（视口坐标）：阅读时没有吸顶的东西，滚动区上沿就是能看到的最上面 */
function visibleTop(): number {
  const box = scroller && typeof (scroller as HTMLElement).getBoundingClientRect === 'function' ? (scroller as HTMLElement).getBoundingClientRect().top : 0
  return Math.max(0, box)
}

/** 交接那一刻在阅读页上找「正看着的那一块」：双击进来的就是双击的那块，否则是屏幕上第一块认得出文字的块 */
function planHandoff(): HandoffPlan | null {
  const blocks = reader.value?.blockElements() ?? []
  const clicked = pendingCaret && Date.now() - pendingCaret.at < 15_000 ? pendingCaret : null
  pendingCaret = null
  if (!blocks.length) return null
  const keys = blocks.map(readerBlockKey)
  const occurrence = (index: number) => keys.slice(0, index).filter((key) => blockKeysMatch(key, keys[index]!)).length
  const planFor = (index: number, caret?: { x: number; y: number }): HandoffPlan => ({
    key: keys[index]!,
    occurrence: occurrence(index),
    top: blocks[index]!.getBoundingClientRect().top,
    ...(caret ? { caret } : {}),
  })
  if (clicked) {
    const index = blocks.indexOf(clicked.block)
    if (index >= 0 && keys[index]) {
      const rect = blocks[index]!.getBoundingClientRect()
      return planFor(index, { x: rect.left + clicked.dx, y: rect.top + clicked.dy })
    }
  }
  const top = visibleTop()
  const bottom = window.innerHeight
  let partial = -1
  for (let index = 0; index < blocks.length; index += 1) {
    const rect = blocks[index]!.getBoundingClientRect()
    if (rect.bottom <= top) continue
    if (rect.top >= bottom) break
    if (!keys[index]) continue
    // 优先整块都在屏幕里的第一块；一整屏只有一块很长的（代码块、长表格）时退而用露出一半的那块
    if (rect.top >= top - 1) return planFor(index)
    if (partial < 0) partial = index
  }
  return partial >= 0 ? planFor(partial) : null
}

/** 阅读走编辑器外壳时，双击记下的视口坐标（外壳自己能按坐标找到块和字） */
let pendingHostPoint: { x: number; y: number; at: number } | null = null
/** 从只读外壳那里拿到的交接计划，等可编辑的外壳就绪后用 */
let hostPlan: HandoffPlan | null = null
function onHostDblclick(event: MouseEvent) {
  if (props.editing || props.adminView || !nativeHost.value) return
  const target = event.target instanceof Element ? event.target : null
  if (!target || target.closest(DBLCLICK_IGNORE) || !target.closest('.kb-text-prose')) return
  pendingHostPoint = { x: event.clientX, y: event.clientY, at: Date.now() }
  emit('requestEdit')
}
function captureHostPlan(api: NonNullable<typeof nativeHost.value>) {
  const point = pendingHostPoint && Date.now() - pendingHostPoint.at < 15_000 ? { x: pendingHostPoint.x, y: pendingHostPoint.y } : undefined
  pendingHostPoint = null
  hostPlan = null
  void api.query({ type: 'viewAnchor', args: { top: visibleTop(), point } }).then((plan) => {
    if (plan && typeof plan === 'object' && typeof (plan as HandoffPlan).key === 'string') hostPlan = plan as HandoffPlan
  })
}

/** 编辑器就绪：先记下阅读页上的位置，再换成编辑器，最后在编辑器里把同一块滚回原位、放光标 */
async function onEditorReady() {
  const plan = props.editing ? (holdRead.value ? planHandoff() : hostPlan) : null
  hostPlan = null
  endHold()
  if (!props.editing) return
  await nextTick()
  await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)))
  if (!props.editing) return
  if (!plan) {
    // 找不到对应的块（空文档、整屏都是图）：至少让光标进正文，点「编辑」之后可以直接打字。
    // 和外壳的 autofocus 同一个条件：标题还空着（新笔记）时焦点留给标题；焦点已经在别处（标签输入）也不抢
    const active = document.activeElement
    if ((!active || active === document.body) && !props.adminView && props.title) nativeHost.value?.focus()
    return
  }
  // 编辑时标签行和工具栏吸在顶上：那一块不能被它们盖住
  const chrome = host.value?.querySelector<HTMLElement>('.kb-editor-chrome')
  const minTop = chrome ? chrome.getBoundingClientRect().bottom + 8 : visibleTop()
  await nativeHost.value?.executeCommand({ id: `handoff_${Date.now()}`, type: 'view.alignBlock', args: { ...plan, minTop }, source: 'user', readonlySafe: true })
}

const titleBox = ref<HTMLTextAreaElement | null>(null)
const wide = ref(false)
/** 悬浮目录能不能放在版心外面的留白里(见 measure) */
const tocOutside = ref(false)
/** 宽屏模式:正文不限 760 px(表格多、代码长的文档用);记住选择 */
const WIDE_KEY = 'kb.doc.fullwidth'
const fullWidth = ref(props.persistLayout ? readFullWidth() : false)
function readFullWidth(): boolean {
  try {
    return localStorage.getItem(WIDE_KEY) === '1'
  } catch {
    return false
  }
}
function toggleFullWidth() {
  fullWidth.value = !fullWidth.value
  if (!props.persistLayout) return
  try {
    localStorage.setItem(WIDE_KEY, fullWidth.value ? '1' : '0')
  } catch {
    /* 隐私模式 */
  }
}

/** 导出 Markdown:标题作一级标题写在最前面(正文里已经有同名 h1 就不重复) */
function exportMarkdown() {
  // 下载：带宽度的图片换成通用的 <img width>，到别的软件里大小不变（存库的内容不动）
  const body = exportImageSizes(props.modelValue)
  // 正文开头已经有同名标题（全角 / 半角括号、前面有提示块都算）就不再补一行：页面不显示大标题后，标题只在正文里
  const heading = props.title && props.titleEditable && !sameTitle(props.title, leadingHeading(props.modelValue) ?? '') ? `# ${props.title}\n\n` : ''
  const blob = new Blob([heading + body], { type: 'text/markdown;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${(props.title || 'document').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}${props.titleEditable ? '.md' : ''}`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}
async function copyMarkdown(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(props.modelValue)
    return true
  } catch {
    return false
  }
}
/** 打印 / 存为 PDF:打印样式只留标题和正文(见 browser.css 的 @media print) */
function printDoc() {
  document.documentElement.classList.add('kb-printing')
  const done = () => {
    document.documentElement.classList.remove('kb-printing')
    window.removeEventListener('afterprint', done)
  }
  window.addEventListener('afterprint', done)
  window.print()
  window.setTimeout(done, 1500)
}
const tocOpen = ref(false)
/**
 * 宽屏上的悬浮大纲:不占版面(浮在正文右侧,不再单独留一列),点标签行里的「大纲」按钮开合;记住选择。
 * 叫「大纲」不叫「目录」:知识库页左边那一栏(文件夹树)叫「目录」,编辑器工具栏上的同一份标题列表也叫「大纲」,三处说法要一致。
 * 没选过时:版心右边的留白放得下大纲卡片(不压正文,见 tocOutside)就默认展开——1920 宽的屏上右边空着五六百像素,
 * 收着反而要多点一下;放不下时默认收起,免得盖住正文。用户点过一次就按他的选择来。
 * 编辑时不显示这一份:编辑器工具栏上有「大纲」按钮,同一份标题列表浮在工具栏下面,两处并存是重复入口
 */
const TOC_KEY = 'kb.doc.toc.collapsed'
/** '1' 收起 / '0' 展开 / null 没选过（跟着留白宽度走）；不记住布局的页面（分享页）默认收起 */
const tocPref = ref<'0' | '1' | null>(props.persistLayout ? readTocPref() : '1')
const tocCollapsed = computed(() => (tocPref.value === null ? !tocOutside.value : tocPref.value === '1'))
function readTocPref(): '0' | '1' | null {
  try {
    const stored = localStorage.getItem(TOC_KEY)
    return stored === '0' || stored === '1' ? stored : null
  } catch {
    return '1'
  }
}
function toggleToc() {
  const next = tocCollapsed.value ? '0' : '1'
  tocPref.value = next
  if (!props.persistLayout) return
  try {
    localStorage.setItem(TOC_KEY, next)
  } catch {
    /* 隐私模式 */
  }
}
const tocNav = ref<HTMLElement | null>(null)
const headings = ref<{ level: number; text: string }[]>([])
const activeIndex = ref(-1)
const outline = computed<OutlineItem[]>(() => buildOutline(headings.value))
const depth = computed(() => outlineDepth(outline.value))
const showToc = computed(() => outline.value.length >= 2)
/**
 * 页面不画大标题，名字跟着正文开头的一级标题走；可正文开头没有一级标题的笔记（例如以「## 背景」开头），
 * 页面上就只剩面包屑里一行小字能看出它叫什么。这种笔记把名字画成只读的大标题：
 * 阅读和编辑都显示、位置一样（进出编辑版面不跳）；不是输入框——改名仍按「正文开头的一级标题」这一条规则，
 * 在正文第一行写上一级标题，这一行就让位给正文。新建笔记（showTitle）和文件（名字是文件名）不走这里。
 */
const virtualTitle = computed(() => !props.showTitle && props.titleEditable && !!props.title?.trim() && leadingHeading(props.modelValue) === null)
const words = computed(() => countWords(props.modelValue))
/** 编辑时选中的文字有多少字（0 = 没选中）：页头字数前面显示「已选 N 字」，和总字数同一个算法 */
const selectedWords = ref(0)
function onSelectionText(text: string) {
  selectedWords.value = text ? countWords(text) : 0
}
watch(
  () => props.editing,
  () => (selectedWords.value = 0),
)
/**
 * 页面不再显示大标题后，文档标题就是正文开头的一级标题：编辑时改这一行，文档标题（列表、面包屑里的名字）跟着改。
 * 只在「这一行被改了」时跟随（前后都有标题且不同）：刚进编辑、房间内容同步进来（前一刻还没有标题）不算，
 * 否则标题和正文标题本来就不一样的笔记，一打开编辑就被悄悄改名。正文里没有一级标题的笔记，名字不变
 */
watch(
  () => props.modelValue,
  (body, previous) => {
    // 显示着标题框（新建笔记）时标题就是用户自己填的，不跟正文
    if (!props.editing || !props.titleEditable || props.showTitle || previous === undefined) return
    const before = leadingHeading(previous)
    const after = leadingHeading(body)
    if (before !== null && after !== null && !sameTitle(before, after)) emit('update:title', after)
  },
)

/* ---------------- 标题:编辑态是自动长高的 textarea(长标题在手机上换行,不横向滚) ---------------- */
function fitTitle() {
  const box = titleBox.value
  if (!box) return
  box.style.height = 'auto'
  box.style.height = `${box.scrollHeight}px`
}
function onTitleInput(event: Event) {
  emit('update:title', (event.target as HTMLTextAreaElement).value.replace(/\n/g, ' '))
  fitTitle()
}
function onTitleKey(event: KeyboardEvent) {
  // 回车跳进正文(标题不允许换行)
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault()
    nativeHost.value?.focus()
  }
}
watch(() => [props.title, props.editing], () => void nextTick(fitTitle))

/* ---------------- 目录:点击跳转 + 滚动跟随 ---------------- */
let scroller: HTMLElement | Window | null = null
function scrollParent(element: HTMLElement | null): HTMLElement | Window {
  let node = element?.parentElement ?? null
  while (node) {
    const style = getComputedStyle(node)
    // 只看样式,不看当前是否溢出:挂载时正文可能还没加载出来
    if (/(auto|scroll)/.test(style.overflowY)) return node
    node = node.parentElement
  }
  return window
}
/** 标题元素来自当前真正在渲染正文的那个组件(编辑器外壳 / 轻量阅读 MarkdownRead) */
function headingElements(): HTMLElement[] {
  if (nativeEdit.value) {
    // 编辑器外壳：目录条目是文本面的顶层标题（outline 查询只数顶层），元素按同一口径取，下标才对得上
    const prose = host.value?.querySelector('.kb-text-prose')
    return prose ? ([...prose.children] as HTMLElement[]).filter((el) => /^H[1-6]$/.test(el.tagName)) : []
  }
  return reader.value?.headingElements() ?? []
}
async function jump(item: OutlineItem) {
  let target: HTMLElement | undefined = headingElements()[item.index]
  // 阅读态的大文档是分段渐进渲染的：目录是完整的，目标标题可能还没挂上，先渲染到那里再滚
  if (!target && !nativeEdit.value) target = (await reader.value?.ensureHeading(item.index)) ?? undefined
  if (!target) return
  target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  activeIndex.value = item.index
  tocOpen.value = false
}
let spyFrame = 0
function spy() {
  if (spyFrame) return
  spyFrame = window.requestAnimationFrame(() => {
    spyFrame = 0
    const elements = headingElements()
    // 用「有没有 getBoundingClientRect」判断是不是元素,不要用 instanceof Window:
    // 无头环境(jsdom)里 window 是个代理对象,instanceof 会失手并抛错。
    const top = scroller && typeof (scroller as HTMLElement).getBoundingClientRect === 'function'
      ? (scroller as HTMLElement).getBoundingClientRect().top
      : 0
    let current = -1
    for (const item of outline.value) {
      const element = elements[item.index]
      if (element && element.getBoundingClientRect().top - top <= 96) current = item.index
    }
    activeIndex.value = current >= 0 ? current : (outline.value[0]?.index ?? -1)
  })
}
function bindScroll() {
  scroller?.removeEventListener('scroll', spy)
  scroller = scrollParent(host.value)
  scroller.addEventListener('scroll', spy, { passive: true })
  spy()
}
/** 正文滚动时当前小节会变:目录很长时让它在目录自己的滚动区里保持可见(只动目录,不带动整页) */
watch(activeIndex, () =>
  void nextTick(() => {
    const nav = tocNav.value
    const current = nav?.querySelector<HTMLElement>('.is-on')
    if (!nav || !current) return
    const box = nav.getBoundingClientRect()
    const item = current.getBoundingClientRect()
    if (item.top < box.top) nav.scrollTop -= box.top - item.top
    else if (item.bottom > box.bottom) nav.scrollTop += item.bottom - box.bottom
  }),
)
function onOutline(value: { level: number; text: string }[]) {
  headings.value = value
  void nextTick(spy)
}

/* ---------------- 草稿 ----------------
 * 编辑中的标题 / 正文 / 标签随时存在本机,关页面、切文档、断网、崩溃都不丢,下次打开自动接着写。
 * 单人编辑:草稿是在现在这一版上改的(base 一致)就静默放回,只在顶上留一条可以撤销的提示;
 *   服务器上的内容在草稿之后变过,静默覆盖会丢掉别人的改动,所以弹条让人选。
 * 多人编辑:正文以服务端房间为准,房间里已有的内容不需要本地草稿(它本来就在服务器上、别人也看得到),
 *   所以只在「离线 / 只读期间改了、还没发出去」(pendingLocal)时才存正文,而且永远不静默写回——
 *   编辑器连上房间后会忽略外部传入的正文,硬写只会和别人的修改打架。让人选「复制出来」还是丢弃。
 *   标题和标签不在 Yjs 里,按单人编辑的规则处理。
 */
const session = useSessionStore()
/**
 * AI 写作（UI-3）：账号有 AI 助手（已含 AI 总开关）、正在编辑、不是管理员巡检时，才把调用通道交给编辑器；
 * 不交时编辑器里没有任何 AI 入口。后端照样按功能点检查，这里只决定显不显示
 */
const canAiWrite = useFeature('ai.assistant')
const aiWriteService = computed(() => (canAiWrite.value && props.editing && !props.adminView ? aiWrite : undefined))

/**
 * 告诉 AI 助手「现在开着哪篇文档」：助手显示标题、提问时附上引用；正在编辑时再登记「插进正文」，
 * 助手的回答能一键插到光标处（走和斜杠菜单插入同一条命令，一步撤销）。管理员巡检别人的文档时不登记
 */
const activeDoc = useActiveDocStore()
let unregisterDoc: (() => void) | null = null
watch(
  () => [props.title, props.noteId, props.editing, props.adminView] as const,
  () => {
    unregisterDoc?.()
    unregisterDoc = null
    if (props.adminView) return
    const insert = props.editing
      ? async (markdown: string) => {
          const result = await nativeHost.value?.executeCommand({ id: `assistant_insert_${Date.now()}`, type: 'text.markdown.insert', args: { markdown }, source: 'user' })
          return !!result?.ok
        }
      : null
    unregisterDoc = activeDoc.register({ noteId: props.noteId ?? null, title: props.title }, insert)
  },
  { immediate: true },
)
onBeforeUnmount(() => unregisterDoc?.())

/**
 * ⌘K 面板里的编辑器命令（UI-5）：正在编辑且外壳已经起来时才登记。
 * 命令列表是函数，面板每次打开都向编辑器要最新的过滤结果（只读 / 源码模式 / 撤销栈都会变）。
 */
const paletteBridge = computed<EditorPaletteBridge | null>(() => {
  const host = nativeHost.value
  if (!props.editing || props.adminView || !host) return null
  return { commands: host.paletteActions, run: host.runPaletteAction }
})
let unregisterPalette: (() => void) | null = null
watch(
  paletteBridge,
  (bridge) => {
    unregisterPalette?.()
    unregisterPalette = null
    if (bridge) unregisterPalette = activeDoc.registerEditor(bridge)
  },
  { immediate: true },
)
onBeforeUnmount(() => unregisterPalette?.())

const scopedId = computed(() => (props.draftId ? scopedDraftId(session.user?.id, props.draftId) : null))
const serverState = computed(() => ({ title: props.baseTitle, body: props.baseBody, extra: props.baseExtra }))
const pendingDraft = ref<Draft | null>(null)
/** plain:单人(或多人没连上)整份恢复;collab-body:多人且有没同步的正文;collab-fields:多人且只有标题 / 标签 */
const pendingKind = ref<'plain' | 'collab-body' | 'collab-fields'>('plain')
const restoredNote = ref<{ at: number } | null>(null)
const copiedBody = ref(false)
const copyFailed = ref(false)
let draftTimer = 0

/** 多人编辑连接的状态(要看 pendingLocal:有没有离线期间改的、还没发出去的内容) */
const collabState = ref<CollabState | null>(null)
let offCollab: (() => void) | null = null
watch(
  () => props.collab,
  (provider) => {
    offCollab?.()
    offCollab = null
    collabReleased.value = false
    collabState.value = provider ? provider.getState() : null
    if (!provider) return
    releaseCollabWait(collabState.value)
    offCollab = provider.subscribe((state) => {
      const had = collabState.value?.pendingLocal
      collabState.value = state
      releaseCollabWait(state)
      // 重连同步完:之前存的「没同步的正文」已经进了房间,草稿可以清掉了
      if (had && !state.pendingLocal) scheduleDraft(0)
    })
  },
  { immediate: true },
)

function applyFields(draft: Draft) {
  if (props.titleEditable) emit('update:title', draft.title)
  if (draft.extra !== undefined) emit('restoreExtra', draft.extra)
}
function applyDraft(draft: Draft) {
  applyFields(draft)
  // 多人编辑留下的「已同步」草稿不带正文(见 draftCarriesBody),只放回标题和标签,正文保持现在这样
  if (draftCarriesBody(draft)) {
    nativeEpoch.value += 1
    emit('update:modelValue', draft.body)
  }
}
function checkDraft() {
  pendingDraft.value = null
  restoredNote.value = null
  copiedBody.value = false
  copyFailed.value = false
  const id = scopedId.value
  // 多人连接还在建立:编辑器此刻只读,等连上(或确认连不上)再判断
  if (!id || !props.editing || props.collabPending) return
  const draft = loadDraft(id)
  if (!draft) return
  if (props.collab) {
    // 正文的镜子(还没落地):服务器上的正文在草稿之后变过,房间会按新正文重建,这份镜子作废
    if (draft.room === true && draft.base.trimEnd() !== props.baseBody.trimEnd()) {
      clearDraft(id)
      return
    }
    const parts = collabDraftFields(draft, serverState.value)
    if (parts.fields === 'silent') {
      applyFields(draft)
      restoredNote.value = { at: draft.savedAt }
    }
    if (parts.bodyUnsynced || parts.fields === 'ask') {
      pendingDraft.value = draft
      pendingKind.value = parts.bodyUnsynced ? 'collab-body' : 'collab-fields'
    } else if (parts.fields === 'none' && draft.room !== true) {
      clearDraft(id)
    }
    return
  }
  const mode = restoreMode(draft, serverState.value, props.silentRestore)
  if (mode === 'silent') {
    applyDraft(draft)
    restoredNote.value = { at: draft.savedAt }
  } else if (mode === 'ask') {
    pendingDraft.value = draft
    pendingKind.value = 'plain'
  } else {
    clearDraft(id)
  }
}
function restoreDraft() {
  const draft = pendingDraft.value
  if (!draft) return
  if (pendingKind.value === 'plain') applyDraft(draft)
  else applyFields(draft)
  pendingDraft.value = null
  restoredNote.value = { at: draft.savedAt }
}
function discardDraft() {
  if (scopedId.value) clearDraft(scopedId.value)
  pendingDraft.value = null
  restoredNote.value = null
  emit('draftState', false)
}
/** 撤销静默恢复:标题 / 标签 / 正文都回到服务器上保存的那一版 */
function revertRestored() {
  if (props.titleEditable) emit('update:title', props.baseTitle)
  if (props.baseExtra !== undefined) emit('restoreExtra', props.baseExtra)
  // 多人编辑:正文以房间为准，别的编辑器收到的 modelValue 只是副本。所以先让房间里的正文换回服务器上那一版
  // （走命令总线，经协同同步给所有人，不点保存就不落地），再让外壳按这一版重建
  const rebuild = () => {
    nativeEpoch.value += 1
  }
  if (props.collab && nativeHost.value) {
    void nativeHost.value
      .executeCommand({ id: `revert_${Date.now()}`, type: 'text.replaceAll', args: { text: props.baseBody }, source: 'user' })
      .catch((err: unknown) => notifyLinkError(`房间里的正文没能撤回：${err instanceof Error ? err.message : String(err)}`))
      .finally(rebuild)
  } else {
    rebuild()
  }
  emit('update:modelValue', props.baseBody)
  discardDraft()
}
async function copyDraftBody() {
  const body = pendingDraft.value?.body ?? ''
  try {
    await navigator.clipboard.writeText(body)
    copiedBody.value = true
    copyFailed.value = false
  } catch {
    // 非 https 页面或浏览器拒绝剪贴板:把内容摊开,让人手动选中复制
    copyFailed.value = true
  }
}
/** 此刻编辑器里的标题(直接读输入框,比等 v-model 回写一轮更新更准) */
const liveTitle = () => (props.titleEditable ? (titleBox.value?.value ?? props.title) : props.title)

/**
 * 把此刻的改动存进本机草稿。返回:
 * - true:改动已经安全了(存进草稿,或者和服务器上一样 / 已在房间里,没有什么会丢);
 * - false:存不进去(存储已满 / 隐私模式),或者弹条里还压着一份没处理的旧草稿——这时离开会丢东西;
 * - null:这个文档没有草稿功能(没给 draftId)。
 */
function persistNow(): boolean | null {
  const id = scopedId.value
  if (!id) return null
  if (!props.editing) {
    // 没在编辑:只剩标签这类附加内容可能有改动,它没有草稿,有变化就得让调用方拦一下
    return props.extra === undefined || props.baseExtra === undefined || props.extra === props.baseExtra
  }
  const body = props.modelValue
  const title = liveTitle()
  const unsynced = !!props.collab && !!collabState.value?.pendingLocal
  const extraChanged = props.extra !== undefined && props.baseExtra !== undefined && props.extra !== props.baseExtra
  // 多人编辑:正文还没落地就是「草稿」,本机留一份镜子(刷新后能接着看、能撤回);权威仍在房间
  const bodyChanged = body.trimEnd() !== props.baseBody.trimEnd()
  const worth = props.collab
    ? unsynced || bodyChanged || title !== props.baseTitle || extraChanged
    : draftWorthRestoring({ title, body, base: props.baseBody, extra: props.extra, savedAt: 0 }, serverState.value)
  if (pendingDraft.value) {
    // 弹条里压着一份没处理的旧草稿:它就是那份「安全副本」,别用新内容覆盖它;但用户在它上面又改了,这些新改动没处可存
    return !worth || (title === pendingDraft.value.title && body.trimEnd() === pendingDraft.value.body.trimEnd())
  }
  if (!worth) {
    clearDraft(id)
    // 多人编辑:正文不在本机草稿里,它在房间里(守护进程上、别人也看得到),也算「草稿已自动保存」
    emit('draftState', props.collab ? body.trimEnd() !== props.baseBody.trimEnd() : false)
    return true
  }
  const stored = saveDraft(id, {
    title,
    // 多人编辑:没发出去的正文要存;已同步但还没落地的正文存一份镜子;和服务器一致就不存
    body: props.collab && !unsynced && !bodyChanged ? '' : body,
    base: props.baseBody,
    baseTitle: props.baseTitle,
    extra: props.extra,
    baseExtra: props.baseExtra,
    unsynced: props.collab ? unsynced : undefined,
    room: props.collab && !unsynced ? true : undefined,
  })
  emit('draftState', stored)
  return stored
}
function scheduleDraft(delay = 500) {
  window.clearTimeout(draftTimer)
  if (!scopedId.value || !props.editing) return
  draftTimer = window.setTimeout(persistNow, delay)
}
watch(() => [props.modelValue, props.title, props.extra], () => scheduleDraft())
watch(() => [props.editing, scopedId.value, !!props.collab, props.collabPending], checkDraft, { immediate: true })
// 关页面 / 切到后台时立刻落盘:防抖的计时器在页面被杀时不会等到触发,手机浏览器切应用就可能直接回收页面
function persistOnHide() {
  if (document.visibilityState === 'hidden' || document.visibilityState === undefined) persistNow()
}
function persistOnPageHide() {
  persistNow()
}
onMounted(() => {
  document.addEventListener('visibilitychange', persistOnHide)
  window.addEventListener('pagehide', persistOnPageHide)
})
function ageText(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`
}
const draftAge = computed(() => (pendingDraft.value ? ageText(pendingDraft.value.savedAt) : ''))
const restoredAge = computed(() => (restoredNote.value ? ageText(restoredNote.value.at) : ''))
/** 新建的内容没有「服务器上的那一版」可退回,撤销就是清空 */
const revertLabel = computed(() => (props.baseBody === '' && props.baseTitle === '' ? '清空这些内容' : '放弃这些修改'))

/* ---------------- 宽窄 ---------------- */
let observer: ResizeObserver | null = null
/** 吸顶的标签行（状态栏）：阅读和编辑都吸在顶上；编辑时工具栏还要排在它下面，所以要知道它有多高（折行时会变） */
const metaBar = ref<HTMLElement | null>(null)
const metaHeight = ref(0)
let metaObserver: ResizeObserver | null = null
onMounted(() => {
  const measure = () => {
    const outer = host.value?.parentElement?.clientWidth ?? 0
    wide.value = outer >= 900
    // 版心右边的留白放得下目录卡片(220px + 两侧各 8px)就浮在留白里,不压正文;放不下才浮在正文右上角
    tocOutside.value = (outer - (host.value?.offsetWidth ?? outer)) / 2 >= 236
  }
  measure()
  if (host.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    observer.observe(host.value.parentElement ?? host.value)
  }
  if (metaBar.value) {
    metaHeight.value = metaBar.value.offsetHeight
    if (typeof ResizeObserver !== 'undefined') {
      metaObserver = new ResizeObserver(() => (metaHeight.value = metaBar.value?.offsetHeight ?? 0))
      metaObserver.observe(metaBar.value)
    }
  }
  bindScroll()
  fitTitle()
})
onBeforeUnmount(() => {
  window.clearTimeout(holdTimer)
  observer?.disconnect()
  metaObserver?.disconnect()
  scroller?.removeEventListener('scroll', spy)
  window.cancelAnimationFrame(spyFrame)
  // 防抖还没到点就切走了文档:先把最后一笔存下来,再清计时器(否则切走前 500 ms 内敲的字会丢)
  if (draftTimer) persistNow()
  window.clearTimeout(draftTimer)
  window.clearTimeout(linkNoticeTimer)
  window.clearTimeout(fixTimer)
  document.removeEventListener('visibilitychange', persistOnHide)
  window.removeEventListener('pagehide', persistOnPageHide)
  offCollab?.()
})

function onNativeChange(text: string) {
  emit('update:modelValue', text)
}

defineExpose({
  /** 滚到某条评论的高亮;找不到(原文已改动)返回 false。走命令总线，所以可能是 Promise */
  scrollToQuote: (id: string): boolean | Promise<boolean> => {
    if (!nativeEdit.value) return false
    return (
      nativeHost.value
        ?.executeCommand({ id: `reveal_${Date.now()}`, type: 'view.revealQuote', args: { id }, source: 'api', readonlySafe: true })
        .then((result) => result.ok) ?? Promise.resolve(false)
    )
  },
  /** 保存成功后调用:清掉本地草稿。`force` = 正文已经和服务器一致,别再留着房间镜子 */
  saved: (force = false) => {
    window.clearTimeout(draftTimer)
    draftTimer = 0
    pendingDraft.value = null
    restoredNote.value = null
    // 多人编辑里还有离线期间改的、没发出去的正文:保存只存了标题和标签,这份正文唯一的副本就是草稿,不能清
    if (!force && props.collab && collabState.value?.pendingLocal) {
      persistNow()
      return
    }
    if (scopedId.value) clearDraft(scopedId.value)
    emit('draftState', false)
  },
  /** 把此刻的改动存进本机草稿,返回是否安全(见 persistNow);离开前调用 */
  persistDraft: persistNow,
  /** 撤回这次编辑:标题 / 正文 / 标签都回到服务器上保存的那一版,并清掉本机草稿 */
  revertToSaved: revertRestored,
  focus: () => nativeHost.value?.focus(),
  /**
   * 保存前调用:把编辑器里还没同步的最新内容推给父级。同步取当前正文(多人编辑的落地调度在事件回调里要用,
   * 等不了 Promise);外壳还没挂好时返回 undefined,调用方按「编辑器没准备好」处理
   */
  flush: () => {
    if (!nativeEdit.value) return undefined
    // 只读阅读（批注 / 巡检）没有可同步的改动：不把正文再回写给上层，免得把阅读态的 v-model 弄脏
    if (nativeReadonly.value) return props.modelValue
    const text = nativeHost.value?.currentText() ?? undefined
    if (text !== undefined) emit('update:modelValue', text)
    return text
  },
  /** 异步 flush：保存前 await 它，避免拿上一拍的正文落盘 */
  flushAsync: async (): Promise<string | undefined> => {
    if (!nativeEdit.value || !nativeHost.value) return undefined
    if (nativeReadonly.value) return props.modelValue
    const text = await nativeHost.value.flushText()
    emit('update:modelValue', text)
    return text
  },
  openFind: () => nativeHost.value?.openFind(),
  openShortcuts: () => nativeHost.value?.openShortcuts(),
  /** 打开编辑器里的 AI 写作条（页面顶栏的「AI 写作」按钮） */
  openAi: () => nativeHost.value?.openAi?.(),
  /**
   * 在正文里找到一段原文（AI 修改建议的「在正文里找到」）：编辑器里选中并滚过去；阅读页用浏览器选区标出来。
   * 返回找没找到，由页面决定怎么提示
   */
  locateText: async (text: string): Promise<boolean> => {
    const needle = locateNeedle(text)
    if (!needle) return false
    if (nativeEdit.value && nativeHost.value) {
      const result = await nativeHost.value.executeCommand({ id: `locate_${Date.now()}`, type: 'text.locate', args: { text: needle }, source: 'user', readonlySafe: true })
      return !!result?.ok
    }
    const root = host.value?.querySelector('.kb-md-read-body')
    return root ? selectTextIn(root, needle) : false
  },
  /** 现在能不能用 AI 写作（在编辑、账号有 AI 助手） */
  aiWriteReady: () => !!aiWriteService.value,
  exportMarkdown,
  copyMarkdown,
  print: printDoc,
  toggleFullWidth,
  isFullWidth: () => fullWidth.value,
})
</script>

<template>
  <div ref="host" class="kb-dp" :class="{ 'is-wide': wide && showToc, 'is-toc-out': tocOutside, 'is-editing': editing, 'is-full': fullWidth }" :style="{ '--kb-dp-meta-h': `${metaHeight}px` }">
    <article class="kb-dp-main">
      <!-- 大标题默认不显示（见 showTitle）。标签行不放在它里面：标签行编辑时要吸顶，
           sticky 的范围是父元素，放在只有一两行高的 header 里就吸不住 -->
      <header v-if="showTitle" class="kb-dp-head">
        <textarea
          v-if="editing && titleEditable"
          ref="titleBox"
          class="kb-dp-title kb-dp-title-input"
          rows="1"
          :value="title"
          :placeholder="titlePlaceholder"
          aria-label="标题"
          @input="onTitleInput"
          @keydown="onTitleKey"
        ></textarea>
        <h1 v-else class="kb-dp-title">{{ title || '无标题' }}</h1>
      </header>
      <header v-else-if="virtualTitle" class="kb-dp-head is-virtual" data-testid="doc-virtual-title">
        <h1 class="kb-dp-title" :title="editing ? '正文开头没有一级标题，这里显示的是笔记的名字；在正文第一行写上一级标题，就以它为准' : undefined">{{ title }}</h1>
      </header>
      <div ref="metaBar" class="kb-dp-metabar">
        <div class="kb-dp-meta">
          <!-- 多人在线编辑的状态:并进元信息行(正常时只是「● 已同步」一小段),不再单独占标题上方的一整行 -->
          <slot name="collab" />
          <slot name="meta" />
          <span class="kb-dp-stat" data-testid="doc-stat"><template v-if="editing && selectedWords"><b class="kb-dp-stat-sel">已选 {{ selectedWords }} 字</b> · </template>{{ words }} 字 · 约 {{ readingMinutes(words) }} 分钟</span>
          <button v-if="linkReport.items.length || inboundGroups.length" type="button" class="kb-dp-links-btn" :aria-expanded="linkPanelOpen" data-testid="doc-links-button" @click="linkPanelOpen = !linkPanelOpen">
            引用 {{ linkReport.items.length + inboundGroups.length }}
          </button>
          <!-- 大纲开关:宽屏开合悬浮卡片,窄屏打开底部抽屉。编辑时不显示(工具栏上有同名的「大纲」按钮) -->
          <button
            v-if="showToc && !editing"
            type="button"
            class="kb-dp-toc-btn"
            :class="{ 'is-on': wide && !tocCollapsed }"
            :aria-expanded="wide ? !tocCollapsed : tocOpen"
            data-testid="toc-toggle"
            @click="wide ? toggleToc() : (tocOpen = true)"
          >
            <KbIcon name="list" :size="12" /> 大纲
          </button>
        </div>
      </div>

      <FoldTransition :open="linkPanelOpen">
      <div v-if="linkPanelOpen" class="kb-dp-links is-panel" data-testid="doc-links-panel">
        <div class="kb-dp-links-head">
          <strong>引用</strong>
          <span class="m">出链 {{ linkReport.items.length }} · 入链 {{ inboundGroups.length }}</span>
          <span class="kb-spacer"></span>
          <button type="button" class="btn sm kb-ghost" aria-label="关闭引用清单" @click="linkPanelOpen = false">收起</button>
        </div>
        <div v-if="linkReport.items.length" class="kb-dp-links-group">
          <div class="kb-dp-links-title">这篇文档引用了</div>
          <ul>
            <li v-for="item in linkReport.items" :key="`out:${linkItemKey(item)}`">
              <button type="button" class="kb-dp-link-open" @click="openOutbound(item)">
                <code>{{ linkItemLabel(item) }}</code>
              </button>
              <span :data-state="item.state">{{ item.state === 'ok' ? '可打开' : item.state === 'missing' ? '未找到' : item.state === 'outside' ? '没有权限' : '未知' }}</span>
              <template v-if="editing && !adminView && item.state === 'missing' && item.kind !== 'note'">
                <button type="button" class="btn sm" :disabled="linkUploading" data-testid="doc-link-upload" @click="pickMissingUpload(item)">上传补上</button>
                <button type="button" class="btn sm" data-testid="doc-link-choose" @click="startFix(item)">从库中选择</button>
              </template>
            </li>
          </ul>
        </div>
        <div v-if="inboundGroups.length" class="kb-dp-links-group">
          <div class="kb-dp-links-title">引用了这篇文档</div>
          <ul>
            <li v-for="item in inboundGroups" :key="`in:${item.source_kind}:${item.source_collection}:${item.source_id}`">
              <button type="button" class="kb-dp-link-open" :title="item.source_id" @click="openInbound(item)">
                {{ item.source_title || item.source_id }}
              </button>
              <span v-if="item.line">第 {{ item.line }} 行<template v-if="item.count > 1">,等 {{ item.count }} 处</template></span>
            </li>
          </ul>
        </div>
      </div>
      </FoldTransition>

      <!-- 链接体检:正文里的相对链接指向的文件不在了 / 不在分享范围 / 是原电脑路径。
           只提示,不自动改正文,也不自动猜同名文件。 -->
      <FoldTransition :open="!!linkProblems">
      <div v-if="linkProblems" class="kb-dp-links" role="status" data-testid="doc-link-report">
        <span>
          正文里有 {{ linkReport.missing.length }} 个链接指向的目标不在知识库里<template v-if="linkReport.outside.length">,{{ linkReport.outside.length }} 个没有访问权限</template><template v-if="linkReport.unsupported.length">,{{ linkReport.unsupported.length }} 个是原电脑路径</template>。
        </span>
        <span class="kb-spacer"></span>
        <button type="button" class="btn sm" :aria-expanded="linkListOpen" @click="linkListOpen = !linkListOpen">
          {{ linkListOpen ? '收起清单' : '查看清单' }}
        </button>
        <button type="button" class="btn sm kb-ghost" @click="copyLinkProblems">{{ copiedLinks ? '已复制' : '复制清单' }}</button>
        <ul v-if="linkListOpen" class="kb-dp-links-list">
          <li v-for="item in linkReport.missing" :key="`m:${linkItemKey(item)}`"><code>{{ linkItemLabel(item) }}</code> <span>未找到</span></li>
          <li v-for="item in linkReport.outside" :key="`o:${linkItemKey(item)}`"><code>{{ linkItemLabel(item) }}</code> <span>没有访问权限</span></li>
          <li v-for="item in linkReport.unsupported" :key="`u:${item.href}`"><code>{{ item.href }}</code> <span>{{ item.reason }}</span></li>
        </ul>
      </div>
      </FoldTransition>
      <FoldTransition :open="!!linkNotice">
      <div v-if="linkNotice" class="kb-dp-links is-notice" role="alert" data-testid="doc-link-notice">
        <span>{{ linkNotice }}</span>
        <span class="kb-spacer"></span>
        <button type="button" class="btn sm kb-ghost" aria-label="知道了" @click="linkNotice = ''">知道了</button>
      </div>
      </FoldTransition>

      <!-- 修坏引用:只在编辑时出现;选中的目标会替换正文里的旧 href,由用户再保存 -->
      <FoldTransition :open="!!fixTarget">
      <div v-if="fixTarget" class="kb-dp-fix" role="dialog" aria-label="从库中选择要引用的文件" data-testid="doc-link-fix">
        <div class="kb-dp-fix-head">
          <strong>替换引用</strong>
          <code>{{ fixTarget.path }}</code>
          <span class="kb-spacer"></span>
          <button type="button" class="btn sm kb-ghost" @click="stopFix">关闭</button>
        </div>
        <input v-model="fixQuery" class="kb-dp-fix-input" type="search" placeholder="搜索文件 / 模板…" aria-label="搜索要替换成的文件" />
        <ul class="kb-dp-fix-list">
          <li v-if="fixLoading">搜索中…</li>
          <li v-else-if="!fixResults.length" class="m">没有匹配的文件</li>
          <li v-for="hit in fixResults" :key="`${hit.collection}:${hit.path}`">
            <button type="button" class="kb-dp-link-open" :title="hit.path" @click="chooseFix(hit)">
              <code>{{ hit.path }}</code>
              <span class="m">{{ hit.collection }}</span>
            </button>
          </li>
        </ul>
      </div>
      </FoldTransition>

      <!-- 需要人来选的草稿:服务器上的内容在草稿之后变过(静默覆盖会丢别人的改动),或多人编辑时有没同步出去的正文 -->
      <FoldTransition :open="!!pendingDraft">
      <div v-if="pendingDraft" class="kb-dp-draft" role="status" :data-kind="pendingKind" data-testid="draft-ask">
        <span v-if="pendingKind === 'collab-body'">你在 {{ draftAge }}离线时写的内容没来得及同步到多人编辑的文档里。多人编辑时文档以大家共享的内容为准,不会自动把它写回去,以免盖掉别人的修改。</span>
        <span v-else-if="pendingKind === 'collab-fields'">有一份 {{ draftAge }}改过的标题或标签,而文档在这之后被改动过。</span>
        <span v-else>有一份 {{ draftAge }}没保存的草稿,而文档在这之后被改动过。恢复会盖掉那些新改动。</span>
        <span class="kb-spacer"></span>
        <template v-if="pendingKind === 'collab-body'">
          <button type="button" class="btn sm pri" data-testid="draft-copy" @click="copyDraftBody">{{ copiedBody ? '已复制' : '复制出来' }}</button>
          <button v-if="pendingDraft.title !== baseTitle || (pendingDraft.extra !== undefined && pendingDraft.extra !== baseExtra)" type="button" class="btn sm" @click="restoreDraft">恢复标题和标签</button>
        </template>
        <button v-else type="button" class="btn sm pri" data-testid="draft-restore" @click="restoreDraft">{{ pendingKind === 'collab-fields' ? '恢复标题和标签' : '恢复草稿' }}</button>
        <button type="button" class="btn sm" data-testid="draft-discard" @click="discardDraft">丢弃</button>
        <textarea v-if="copyFailed" class="kb-dp-draft-text" readonly rows="6" aria-label="没写完的内容,可手动复制" :value="pendingDraft.body" @focus="($event.target as HTMLTextAreaElement).select()"></textarea>
      </div>
      </FoldTransition>
      <!-- 已经自动放回编辑器的草稿:不打扰,只留一句说明和一个撤销 -->
      <FoldTransition :open="!pendingDraft && !!restoredNote">
      <div v-if="!pendingDraft && restoredNote" class="kb-dp-draft is-quiet" role="status" data-testid="draft-restored">
        <span>已恢复 {{ restoredAge }}没写完的内容。</span>
        <span class="kb-spacer"></span>
        <button type="button" class="btn sm" data-testid="draft-revert" @click="revertRestored">{{ revertLabel }}</button>
        <button type="button" class="btn sm kb-ghost" aria-label="知道了" @click="restoredNote = null">知道了</button>
      </div>
      </FoldTransition>

      <!-- 正文区：
           ① 阅读 → 编辑：编辑器在后台起来（挂载、多人编辑时还要等房间同步）要几百毫秒，这段时间继续显示刚才读的内容（holdRead），
              起来后再换。以前是读到的内容先整块消失、页面缩成一条骨架（2751px → 152px，滚动位置也丢），编辑器好了才又撑开，
              看起来就是「排版缩一下又恢复」
           ② 换了一篇笔记（页面重新挂载）时内容淡入（appear）；离场不做，新内容直接盖上去 -->
      <Transition name="kb-fade" appear>
        <!-- 阅读态:markdown-it 直接出 HTML,不建 ProseMirror(首屏不为阅读付编辑器内核的钱) -->
        <MarkdownRead
          v-if="lightRead || holdRead"
          class="kb-md-read-doc"
          ref="reader"
          :source="holdRead && !lightRead ? heldSource : modelValue"
          :link-context="linkContext"
          :link-states="linkReport.states"
          progressive
          @headings="onOutline"
          @open-attachment="emit('openAttachment', $event)"
          @open-note="emit('openLink', $event)"
          @link-error="notifyLinkError"
          @dblclick="onReaderDblclick"
        />
      </Transition>
      <!-- 外壳等房间连上：只放骨架，不先挂一个单人文档（交接期间不放，继续显示刚才读的内容） -->
      <DocSkeleton v-if="!lightRead && !holdRead && nativePending" data-testid="native-collab-pending" />
      <!-- 编辑器外壳：标题仍由本页的表头负责，外壳只接管正文、工具栏与保存。
           外壳自己的「导出」不放（export: false）：页头「更多」里已经有「导出 Markdown」，省下的位置给格式刷 / 清除格式。
           阅读（批注 / 巡检）时不显示工具栏和状态栏，看起来仍是阅读页，只多了批注高亮与选中文字的「评论」入口。
           房间换代（docEpoch）/ 编辑 ⇄ 阅读切换时整个重建：y-prosemirror 绑的是旧 Y.Doc，会话的只读也在打开时定下来 -->
      <Transition name="kb-fade" appear>
        <EditorHost
          v-if="!lightRead && !nativePending"
          ref="nativeHost"
          :key="`native:${nativeRequest.fileId}:${nativeEpoch}:${collabKey}:${nativeReadonly ? 'r' : 'w'}`"
          :request="nativeRequest"
          :transport="nativeReadonly ? undefined : nativeTransport"
          :show-chrome="editing"
          :show-status="false"
          :chrome-title="false"
          :chrome-close="false"
          :chrome-save="false"
          :text-services="textServices"
          :autofocus="editing && !adminView && !!title"
          :class="{ 'is-reading': !editing, 'is-held': holdRead }"
          :capabilities="{ ai: false, comment: false, export: false }"
          :ai-write="aiWriteService"
          @change="onNativeChange"
          @outline="onOutline"
          @export="exportMarkdown"
          @selection-text="onSelectionText"
          @dblclick="onHostDblclick"
          @ready="onEditorReady"
          @error="notifyLinkError($event.message)"
        />
      </Transition>

      <!-- 反向链接:谁引用了这篇。阅读时放在正文末尾——看完正文顺带知道上下文;
           编辑时不显示,编辑态的引用清单在页头「引用」按钮里(那里带缺失状态和补链操作,不重复摆两套)。
           数据与页头清单同一份(doc_links 入链),只是那里按“文档”归并了一次。 -->
      <section v-if="!editing && inboundGroups.length" class="kb-dp-backlinks" aria-label="引用了这篇文档" data-testid="doc-backlinks">
        <h2 class="kb-dp-backlinks-title">引用了这篇文档 <span>{{ inboundGroups.length }}</span></h2>
        <ul>
          <li v-for="item in inboundGroups" :key="`back:${item.source_kind}:${item.source_collection}:${item.source_id}`">
            <KbIcon :name="item.source_kind === 'note' ? 'note' : 'dir'" :size="13" />
            <button type="button" class="kb-dp-backlink" :title="item.source_id" @click="openInbound(item)">
              {{ item.source_title || item.source_id }}
            </button>
            <span class="kb-dp-backlink-meta">
              {{ item.source_kind === 'note' ? '笔记' : '文件' }}<template v-if="item.line"> · 第 {{ item.line }} 行</template><template v-if="item.count > 1"> · 等 {{ item.count }} 处</template>
            </span>
          </li>
        </ul>
      </section>
    </article>

    <Transition name="kb-menu"><aside v-if="wide && showToc && !editing && !tocCollapsed" class="kb-dp-toc" aria-label="大纲" data-testid="doc-toc">
      <div class="kb-dp-toc-card">
        <div class="kb-dp-toc-head">
          <span class="kb-dp-toc-title">大纲</span>
          <button type="button" class="kb-dp-toc-fold" aria-label="收起大纲" title="收起大纲" :aria-expanded="true" data-testid="toc-collapse" @click="toggleToc">
            <KbIcon name="minus" :size="12" />
          </button>
        </div>
        <nav ref="tocNav" class="kb-dp-toc-nav">
          <button
            v-for="item in outline"
            :key="item.index"
            type="button"
            class="kb-dp-toc-item"
            :class="{ 'is-on': item.index === activeIndex }"
            :aria-current="item.index === activeIndex ? 'location' : undefined"
            :style="{ paddingLeft: `${10 + depth(item) * 14}px` }"
            :title="item.text"
            @click="jump(item)"
          >{{ item.text }}</button>
        </nav>
      </div>
    </aside></Transition>

    <Teleport to="body">
      <div v-if="tocOpen" class="kb-dp-sheet-scrim" @click="tocOpen = false"></div>
      <div v-if="tocOpen" class="kb-dp-sheet" role="dialog" aria-label="大纲">
        <div class="kb-dp-sheet-head">
          <b>大纲</b>
          <button type="button" class="btn sm" aria-label="关闭大纲" @click="tocOpen = false"><KbIcon name="close" :size="12" /></button>
        </div>
        <nav class="kb-dp-sheet-list">
          <button
            v-for="item in outline"
            :key="item.index"
            type="button"
            class="kb-dp-toc-item"
            :class="{ 'is-on': item.index === activeIndex }"
            :style="{ paddingLeft: `${12 + depth(item) * 16}px` }"
            @click="jump(item)"
          >{{ item.text }}</button>
        </nav>
      </div>
    </Teleport>
  </div>
</template>

<style>
.kb-dp {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  justify-content: center;
  gap: 56px;
  width: 100%;
  max-width: 840px;
  margin: 0 auto;
  padding: 20px 40px 96px;
  box-sizing: border-box;
}
/* is-wide 只表示「宽屏、有目录」:目录是浮层(见 .kb-dp-toc),不再在版心右边单独占 200px 一列 */
.kb-dp.is-full {
  max-width: none;
}
.kb-dp-main {
  position: relative;
  min-width: 0;
}
/* 阅读 → 编辑的交接期间：编辑器在后台起来，不占版面、看不见、点不到（刚才读的内容还在原位）；起来后这个类去掉，一次换上 */
.kb-dp .kb-editor-host.is-held {
  position: absolute;
  width: 100%;
  opacity: 0;
  pointer-events: none;
}
.kb-dp-head {
  margin: 0;
}
.kb-dp-title {
  display: block;
  width: 100%;
  margin: 0;
  padding: 0;
  color: var(--t);
  background: transparent;
  border: 0;
  font-family: var(--sans);
  font-size: calc(28px * var(--fs));
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: 0;
  word-break: break-word;
}
.kb-dp-title-input {
  resize: none;
  overflow: hidden;
  outline: none;
}
.kb-dp-title-input::placeholder {
  color: var(--m2);
}
/* 批注 / 巡检的阅读：新外壳去掉编辑框的描边与内边距，看起来仍是阅读页（只多了批注高亮与选中文字的「评论」入口） */
.kb-dp .kb-editor-host.is-reading {
  height: auto;
  background: transparent;
  border: 0;
  border-radius: 0;
  overflow: visible;
}
.kb-dp .kb-editor-host.is-reading .kb-editor-stage {
  overflow: visible;
}
.kb-dp .kb-editor-host.is-reading .kb-text-surface {
  height: auto;
  background: transparent;
}
.kb-dp .kb-editor-host.is-reading .kb-text-prose {
  overflow: visible;
  padding: 0 0 48px;
}
/* 编辑态（笔记 / Markdown）：和阅读态同一个版心，不再套一张带描边的卡片。
   卡片的描边 + 正文 16px 内边距让正文比标题往里缩一截、两侧又各丢一块宽度，看起来挤；
   去掉后标题、元信息、工具栏、正文的左缘对齐在同一条线上 */
.kb-dp .kb-editor-host:not(.is-reading) {
  height: auto;
  /* 工具栏要吸顶，外框不能裁剪（sticky 被最近的 overflow 非 visible 祖先截住） */
  overflow: visible;
  background: transparent;
  border: 0;
  border-radius: 0;
}
.kb-dp .kb-editor-host:not(.is-reading) .kb-editor-stage {
  overflow: visible;
}
.kb-dp .kb-editor-host:not(.is-reading) .kb-text-surface {
  height: auto;
  background: transparent;
}
.kb-dp .kb-editor-host:not(.is-reading) .kb-text-prose {
  overflow: visible;
  padding: 20px 0 calc(120px + var(--kbd-reserve, 0px));
}
/* 工具栏到第一块的距离统一由上面的 20px 决定：第一块自带的上外边距（提示块、表格、代码块都有）不再叠加，
   否则正文以提示块开头时比以段落开头时多空出一截 */
.kb-dp .kb-editor-host:not(.is-reading) .kb-text-prose > :first-child,
.kb-dp .kb-editor-host:not(.is-reading) .kb-text-prose > .ProseMirror-widget:first-child + * {
  margin-top: 0;
}
/* 工具栏吸在工作区滚动容器顶上：长文往下写时格式按钮不跑出视野。
   左右各外扩 7px（工具按钮的内边距），第一个图标正好落在正文左缘。
   阅读和编辑的标签行都吸顶，所以所有宽度下工具栏都排在它下面（top 取标签行的实际高度，折行时跟着变）；
   手机上软键盘打开时由 EditorChrome 把工具栏贴到键盘上沿，这条 top 只在非贴键盘状态下起作用 */
.kb-dp .kb-editor-host:not(.is-reading) .kb-editor-chrome {
  position: sticky;
  top: var(--kb-dp-meta-h, 0px);
  z-index: 20;
  margin: 0 -7px;
  padding: 0 0 4px;
  background: var(--bg);
}
/* 取色器在矮屏上会变成居中浮层，可能盖过吸顶的标签行；标签行 z-index 21、
   工具栏 z-index 20，浮层作为工具栏子元素会被标签行压住。菜单打开时把工具栏提到标签行之上，
   菜单收起就恢复（正常滚动时工具栏本来就排在标签行下面，不会互相遮挡） */
.kb-dp .kb-editor-host:not(.is-reading) .kb-editor-chrome:has(.kb-editor-chrome-menu) {
  z-index: 30;
}
/* 页头已经有文档类型、同步状态和字数：外壳里的「文档 · 已就绪」和字数在这里是重复信息，收起。
   用 display:none 而不是不渲染，状态文字仍在 DOM 里给读屏和 e2e 读 */
.kb-dp .kb-editor-host:not(.is-reading) .kb-editor-chrome-meta,
.kb-dp .kb-editor-host:not(.is-reading) .kb-editor-chrome-count {
  display: none;
}
/* 版心够宽时工具栏和「撤销 / 重做」并成一行，少占一行高度；不够宽时工具栏独占一行，操作区折到它上面一行。
   规则是常用按钮先占满一行，不能为了并行把它们挤进「更多」。
   做法：工具栏的 flex-basis 定成全部按钮的宽度（约 680px，见 EditorChrome 的按钮 / 竖线尺寸），放不下就整体换行；
   wrap-reverse 让先排的工具栏落在下面那行、折出去的操作区在上面。
   不用容器查询：container-type 会让外壳成为 fixed 定位的包含块，手机上贴键盘的工具栏就定不到视口底部了。
   basis 是定值、不随「更多」收起多少而变，量宽度收按钮时不会和换行互相牵动 */
.kb-dp .kb-editor-host:not(.is-reading) .kb-editor-chrome-row {
  flex-wrap: wrap-reverse;
}
.kb-dp .kb-editor-host:not(.is-reading) .kb-editor-chrome.is-stacked .kb-editor-chrome-tools {
  order: 0;
  flex: 1 1 680px;
}
/* 工具栏「大纲」打开的标题列表：浮在工具栏右下方（工具栏是 sticky 定位，这里相对它绝对定位，滚动时跟着工具栏走），
   不再插在工具栏和正文之间把正文往下推。默认收起，点工具栏上的大纲按钮开合 */
.kb-dp .kb-editor-host:not(.is-reading) .kb-editor-chrome-outline {
  position: absolute;
  top: calc(100% + 6px);
  right: 7px;
  z-index: 30;
  width: 240px;
  max-height: min(60vh, 480px);
  padding: 6px;
  background: var(--surface-2);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r3);
  box-shadow: var(--sh3);
}
.kb-dp .kb-editor-host:not(.is-reading) .kb-editor-chrome-outline-head {
  padding: 0 2px 4px 8px;
}
/* 底部状态栏（「有未保存的改动 / 0 字」）不再显示：保存状态在顶栏（草稿已自动保存 / 未保存 / 保存中…），
   同步状态在页头标签行（CollabBar），字数在标签行里。三处信息各只出现一次 */
/* 触屏上 device.css 给所有 textarea 写了 font-size: max(16px, 1em) !important（防 iOS 聚焦时放大页面），
   1em 取的是父元素字号，编辑态的标题框因此从 28px 掉到 16px，比正文的一级标题还小。
   标题本来就大于 16px，不会触发放大，这里把字号拿回来（两条都是 !important，选择器更具体的这条生效） */
@media (pointer: coarse) {
  .kb-dp .kb-dp-title-input {
    font-size: calc(28px * var(--fs)) !important;
  }
}
@media (pointer: coarse) and (max-width: 640px) {
  .kb-dp .kb-dp-title-input {
    font-size: calc(23px * var(--fs)) !important;
  }
}
/* 标签行是页头第二行（标题在上面时），和标题隔 8px；标题不渲染时它就是第一行。
   阅读 / 编辑都吸顶：长文滚动时字数、同步状态、引用与目录入口一直在视野里。
   背景必须不透明，正文才会从它下面滚过去而不是透出来；z-index 比编辑器工具栏高一级 */
.kb-dp-metabar {
  position: sticky;
  top: 0;
  z-index: 21;
  /* 间距放在内边距里：metaHeight 用 offsetHeight 量，工具栏吸顶的 top 才能把这 8px 也算进去 */
  margin-bottom: 0;
  padding-bottom: 8px;
  background: var(--bg);
}
.kb-dp-head + .kb-dp-metabar {
  margin-top: 8px;
}
/* 桌面 / 平板：标签行左右外扩 7px，和下面的编辑器工具栏对齐；吸顶逻辑在上面的基础规则里 */
@media (min-width: 641px) {
  /* 标签行的位置、宽度、高度阅读和编辑完全一样，点「编辑」时它不挪一下。
     左右外扩 7px 和工具栏对齐；上面不留内边距：吸顶时标签行要紧贴顶栏，不能在它和顶栏之间空出一截，
     行内的呼吸感由 .kb-dp-meta 的最小高度提供，页面顶部的留白由 .kb-dp 的 padding-top 负责 */
  .kb-dp {
    padding-top: 24px;
  }
  .kb-dp-metabar {
    margin: 0 -7px;
    padding: 0 7px 8px;
  }
  .kb-dp-meta {
    min-height: 28px;
  }
  .kb-dp-head + .kb-dp-metabar {
    margin-top: 2px;
  }
}
.kb-dp-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  color: var(--m);
  font-size: calc(13px * var(--fs));
}
.kb-dp-stat {
  white-space: nowrap;
  /* 字数会随着输入实时变化，等宽数字避免元信息行左右抖动 */
  font-variant-numeric: tabular-nums;
}
/* 编辑时选中了文字：字数前面的「已选 N 字」用强调色，一眼看得到是选区的数 */
.kb-dp-stat-sel {
  color: var(--ac2);
  font-weight: 500;
}
.kb-dp-toc-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 11px;
  color: var(--t2);
  background: var(--surface-2);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r-pill);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.kb-dp-links-btn:hover,
.kb-dp-toc-btn:hover {
  background: var(--surface-3);
  border-color: var(--b3);
  color: var(--t);
}
/* 引用面板展开时按钮保持激活态，和目录按钮的开合状态一致 */
.kb-dp-links-btn[aria-expanded='true'] {
  color: var(--ac);
  border-color: color-mix(in srgb, var(--ac) 45%, transparent);
  background: var(--acbg);
}
/* 触屏:视觉仍是 28px 的小药丸,可点区域用伪元素外扩到 44px(与 device.css 里 .btn.sm 同一做法) */
@media (pointer: coarse) {
  .kb-dp-toc-btn::before,
  .kb-dp-links-btn::before {
    content: '';
    position: absolute;
    inset: -8px 0;
  }
}
.kb-dp-draft {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  padding: 8px 12px;
  color: var(--t2);
  background: color-mix(in srgb, var(--status-warning) 9%, var(--surface-1));
  border: var(--hl) solid color-mix(in srgb, var(--status-warning) 35%, transparent);
  border-radius: var(--r2);
  font-size: calc(13px * var(--fs));
}
.kb-dp-links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  padding: 8px 12px;
  color: var(--t2);
  background: color-mix(in srgb, var(--status-warning) 8%, var(--surface-1));
  border: var(--hl) solid color-mix(in srgb, var(--status-warning) 30%, transparent);
  border-radius: var(--r2);
  font-size: calc(13px * var(--fs));
}
.kb-dp-links.is-notice {
  background: var(--surface-2);
  border-color: var(--b2);
}
/* 引用清单:默认收起,点标题栏的数字才展开;它不参与体检,所以用中性底色 */
.kb-dp-links.is-panel {
  align-items: stretch;
  flex-direction: column;
  gap: 10px;
  background: var(--surface-2);
  border-color: var(--b2);
}
.kb-dp-links-head,
.kb-dp-links-group ul li {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.kb-dp-links-head {
  width: 100%;
}
.kb-dp-links-head .m {
  opacity: 0.75;
}
.kb-dp-links-group {
  width: 100%;
}
.kb-dp-links-title {
  margin-bottom: 4px;
  color: var(--m);
  font-size: calc(12px * var(--fs));
}
.kb-dp-links-group ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.kb-dp-links-group li {
  padding: 3px 0;
}
.kb-dp-link-open {
  min-width: 0;
  padding: 0;
  color: var(--t);
  background: none;
  border: 0;
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.kb-dp-link-open:hover {
  color: var(--accent);
  text-decoration: underline;
}
/* 正文末尾的反向链接:用一条细线和正文分开,标题是小字——别让读者以为这是文章的一节 */
.kb-dp-backlinks {
  margin-top: var(--sp-6);
  padding-top: var(--sp-4);
  border-top: var(--hl) solid var(--border-subtle);
}
.kb-dp-backlinks-title {
  margin: 0 0 var(--sp-2);
  color: var(--text-secondary);
  font-size: var(--text-13);
  font-weight: var(--fw-title);
}
.kb-dp-backlinks-title span {
  margin-left: var(--sp-1);
  color: var(--text-tertiary);
  font-weight: var(--fw-regular);
  font-variant-numeric: tabular-nums;
}
.kb-dp-backlinks ul {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
.kb-dp-backlinks li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
}
.kb-dp-backlinks li svg {
  flex: none;
  stroke: var(--text-tertiary);
  transform: translateY(1px);
}
.kb-dp-backlink {
  min-width: 0;
  padding: 0;
  color: var(--text-primary);
  background: none;
  border: 0;
  font: inherit;
  font-size: var(--text-14);
  line-height: var(--lh-body);
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.kb-dp-backlink:hover {
  color: var(--accent);
  text-decoration: underline;
}
.kb-dp-backlink-meta {
  color: var(--text-tertiary);
  font-size: var(--text-12);
  white-space: nowrap;
}
.kb-dp-links-btn {
  position: relative;
  height: 28px;
  padding: 0 11px;
  color: var(--t2);
  background: var(--surface-2);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r-pill);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.kb-dp-links-list {
  flex: 1 1 100%;
  max-height: 220px;
  margin: 4px 0 0;
  padding: 6px 0 0;
  overflow-y: auto;
  list-style: none;
  border-top: var(--hl) solid var(--b);
  font-size: calc(12px * var(--fs));
}
.kb-dp-fix {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  background: var(--surface-2);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  box-sizing: border-box;
}
.kb-dp-fix-head,
.kb-dp-fix-head .kb-dp-link-open {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.kb-dp-fix-head code {
  overflow-wrap: anywhere;
}
.kb-dp-fix-input {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  color: var(--t);
  background: var(--input-bg);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r1);
  box-sizing: border-box;
}
.kb-dp-fix-input:focus {
  outline: none;
  border-color: var(--ac);
}
.kb-dp-fix-list {
  max-height: 220px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.kb-dp-fix-list li {
  padding: 4px 0;
}
.kb-dp-fix-list .kb-dp-link-open {
  display: flex;
  gap: 8px;
  width: 100%;
}
.kb-dp-file-input {
  display: none;
}
.kb-dp-links-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
}
.kb-dp-links-list code {
  min-width: 0;
  overflow-wrap: anywhere;
}
.kb-dp-links-list span {
  flex: none;
  opacity: 0.75;
}
/* 已自动恢复的提示:不是警告,用中性底色,比「需要你选」的那条安静 */
.kb-dp-draft.is-quiet {
  background: var(--surface-2);
  border-color: var(--b2);
}
.kb-dp-draft-text {
  flex: 1 1 100%;
  min-height: 6em;
  padding: 8px 10px;
  color: var(--t);
  background: var(--surface-sunken);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r1);
  font: inherit;
  resize: vertical;
}
/* 悬浮目录:粘在视口右侧,不占正文的位置;右列宽度固定,折叠成小圆钮时正文不会跳 */
/* 悬浮目录:绝对定位、不占版面。外层铺满 .kb-dp 的高度只是给里面的卡片当 sticky 的轨道,
   本身不接收点击(pointer-events: none),不会挡住它下面的正文。
   选择器限定在 .kb-dp 的直接子元素:分享页(SharedDoc)复用了 .kb-dp-toc 这个类名,但仍是自己的两列版面 */
.kb-dp > .kb-dp-toc {
  position: absolute;
  top: 24px;
  bottom: 0;
  right: 12px;
  z-index: 15;
  width: 220px;
  pointer-events: none;
}
/* 版心右边留白够宽:浮在留白里,完全不压正文 */
.kb-dp > .kb-dp-toc {
  --origin: top right;
}
.kb-dp.is-toc-out > .kb-dp-toc {
  --origin: top left;
  right: auto;
  left: calc(100% + 8px);
}
.kb-dp > .kb-dp-toc > .kb-dp-toc-card {
  position: sticky;
  top: 16px;
  pointer-events: auto;
}
.kb-dp-toc-card {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 140px);
  padding: 6px;
  background: var(--surface-2);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r3);
  box-shadow: var(--sh3);
}
/* 目录开关按钮展开时的状态 */
.kb-dp-toc-btn.is-on {
  color: var(--ac);
  border-color: color-mix(in srgb, var(--ac) 45%, transparent);
  background: var(--acbg);
}
.kb-dp-toc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 2px 4px 10px;
}
.kb-dp-toc-title {
  color: var(--m);
  font-size: calc(12px * var(--fs));
  font-weight: 600;
}
.kb-dp-toc-nav {
  min-height: 0;
  overflow-y: auto;
}
.kb-dp-toc-fold,
.kb-dp-toc-fab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--t2);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.kb-dp-toc-fold {
  width: 24px;
  height: 24px;
  border-radius: var(--r1);
}
.kb-dp-toc-fold:hover,
.kb-dp-toc-fab:hover {
  color: var(--t);
  background: var(--hover);
}
.kb-dp-toc-fab {
  width: 32px;
  height: 32px;
  background: var(--surface-2);
  border: var(--hl) solid var(--b2);
  border-radius: 50%;
  box-shadow: var(--sh2);
}
/* 触屏:视觉尺寸不变,可点区域外扩到 44px */
@media (pointer: coarse) {
  .kb-dp-toc-fold,
  .kb-dp-toc-fab {
    position: relative;
  }
  .kb-dp-toc-fold::before,
  .kb-dp-toc-fab::before {
    content: '';
    position: absolute;
    inset: -10px;
  }
}
.kb-dp-toc-item {
  display: block;
  width: 100%;
  padding: 5px 10px;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--t2);
  background: transparent;
  border: 0;
  border-radius: var(--r1);
  font-size: calc(13px * var(--fs));
  line-height: 1.5;
  cursor: pointer;
}
.kb-dp-toc-item:hover {
  color: var(--t);
  background: var(--hover);
}
.kb-dp-toc-item.is-on {
  color: var(--ac2);
  background: var(--accent-soft);
}
.kb-dp-sheet-scrim {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(var(--shade), 0.45);
}
.kb-dp-sheet {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 81;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--surface-2);
  border-top: var(--hl) solid var(--b2);
  border-radius: var(--r4) var(--r4) 0 0;
  box-shadow: var(--sh3);
  padding-bottom: var(--safe-bottom);
}
.kb-dp-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: var(--hl) solid var(--b);
}
.kb-dp-sheet-list {
  overflow-y: auto;
  padding: 8px;
}
.kb-dp-sheet-list .kb-dp-toc-item {
  padding-top: 10px;
  padding-bottom: 10px;
  font-size: calc(15px * var(--fs));
  white-space: normal;
}

@media (max-width: 900px) {
  .kb-dp {
    padding: 24px 24px 80px;
  }
}
@media (max-width: 640px) {
  /* 手机上正文起点是稀缺的(设计稿):头部各块的间距压紧,标签收成一行可横滑 */
  .kb-dp {
    padding: 8px 16px 72px;
  }
  .kb-dp-title {
    font-size: calc(23px * var(--fs));
  }
  .kb-dp-head {
    margin-bottom: 0;
  }
  .kb-dp-head + .kb-dp-metabar {
    margin-top: 4px;
  }
  .kb-dp-meta {
    gap: 6px 10px;
  }
  /* 字数和阅读时间:小一档、淡一点 */
  .kb-dp-stat {
    font-size: calc(11px * var(--fs));
    opacity: 0.8;
  }
  /* 标签编辑器(插槽里的 span.row):order:2 把它排到字数后面、独占下一行,字数才能挤进第一行的空位(DOM 里字数在标签行之后);
     放不下横向滑动,滚动条藏起来,不压在正文上 */
  .kb-dp-meta > .row {
    order: 2;
    flex: 1 1 100%;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .kb-dp-meta > .row::-webkit-scrollbar {
    display: none;
  }
  .kb-dp-toc-btn {
    order: 1;
  }
}
</style>
