<script setup lang="ts">
// 打开别人的一篇文档(笔记或文件):阅读、(可编辑时)源码编辑、评论。
// 「共享给我」和公开分享页共用,内容怎么取全部经 ShareAccess(带 X-KB-Space 的能力调用,或链接的 /share/{token}/call)。
//
// 编辑先用 Markdown / 纯文本源码(在线协作编辑是 F5)。笔记的保存要带乐观锁版本 `version`,
// 但后端 get_item 不返回它(只有 list_items 有,而只拿到单篇授权的人调不了 list_items):
// 能用 item_history 的登录协作者从版本链里取;取不到(通过链接)只能退回 1,笔记改过几次之后保存会 409。
// 这是后端要补的字段,界面不绕过,遇到冲突就如实说「内容刚被别人改过」。
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { KbBadge, KbButton, KbEmpty, KbIcon, KbInput, KbSkeleton, useConfirm, useToast } from '@kb-ui/index'
import DocComments from './DocComments.vue'
import InAppDownloadNote from '@/components/InAppDownloadNote.vue'
import CollabBar from '@/components/CollabBar.vue'
import CollabAvatars from '@/components/CollabAvatars.vue'
import type { CollabProvider } from '@/collab/provider'
import { useCollabKey } from '@/collab/useCollabKey'
import { collabKindOf } from '@/collab/resourceKey'
import { useFeature } from '@/composables/useFeature'
import { useDocLinks } from '@/composables/useDocLinks'
import type { ShareAccess, ShareTarget } from '@/api/share'
import { INLINE_FORMATS } from '@/utils/files'
import { relativeTime, shareErrorText } from '@/utils/share'
import type { LinkContext } from '@/utils/links'
import type { EditorOpenRequest, TextServices } from '@/editor/types'
import { buildOutline, outlineDepth, type OutlineItem } from '@/utils/docText'
import type { PreviewBlock, PreviewChunk } from '@kb-ui/index'

// 阅读用轻量渲染(markdown-it + DOMPurify,与笔记页同一条管线);协作编辑用统一编辑器外壳,都按需加载
const MarkdownRead = defineAsyncComponent(() => import('@/components/MarkdownRead.vue'))
const CodeEditor = defineAsyncComponent(() => import('@/components/CodeEditor.vue'))
const FileViewer = defineAsyncComponent(() => import('@/components/FileViewer.vue'))
const EditorHost = defineAsyncComponent(() => import('@/editor/host/EditorHost.vue'))
const EditProposals = defineAsyncComponent(() => import('@/components/EditProposals.vue'))
const OfficeEditor = defineAsyncComponent(() => import('@/components/OfficeEditor.vue'))

const props = withDefaults(
  defineProps<{
    /** 一篇笔记(insight)或一个文件(file) */
    target: ShareTarget
    access: ShareAccess
    myId?: string | null
    /** 微信 / QQ 里下载按钮旁给「在浏览器中打开」的提示。公开分享页在页面顶上已经说过,那里传 false 免得重复 */
    inAppNote?: boolean
  }>(),
  { myId: undefined, inAppNote: true },
)
const emit = defineEmits<{ loaded: [title: string]; changed: []; dirty: [value: boolean] }>()

const toast = useToast()
const confirmer = useConfirm()

interface NoteItem {
  id: string
  collection: string
  title: string | null
  text: string
  tags: string[]
  updated_at: number
  version?: number
}
interface FilePreview {
  format: string
  blocks: PreviewBlock[]
  chunks: PreviewChunk[]
  content?: string
  editable?: boolean
}

const isNote = computed(() => props.target.kind === 'insight')
/** 协作房间是富文本(笔记、Markdown 文件）:用所见即所得编辑器,并由客户端落地成 Markdown */
const richRoom = computed(() => isNote.value || collabKindOf({ file: props.target.path ?? '' }) === 'rich')
const collection = computed(() => props.target.collection ?? '')
const path = computed(() => props.target.path ?? '')
/** 评论挂在哪:笔记用 `insight:<id>`,文件用集合内相对路径(后端 add_annotation 的 source) */
const commentSource = computed(() => (isNote.value ? `insight:${props.target.id}` : path.value))

const status = ref<'loading' | 'ready' | 'error'>('loading')
const errorText = ref('')
const note = ref<NoteItem | null>(null)
const file = ref<FilePreview | null>(null)

const editing = ref(false)
const draftTitle = ref('')
const draftBody = ref('')
const saving = ref(false)
const saveError = ref('')
const conflict = ref(false)

/* ---------------- 悬浮目录 (TOC) ---------------- */
const host = ref<HTMLElement | null>(null)
const tocNav = ref<HTMLElement | null>(null)
const wide = ref(false)
const tocOpen = ref(false)
const activeIndex = ref(-1)

const TOC_KEY = 'kb.doc.toc.collapsed'
const tocCollapsed = ref(readTocCollapsed())
function readTocCollapsed(): boolean {
  try {
    return localStorage.getItem(TOC_KEY) === '1'
  } catch {
    return false
  }
}
function toggleToc() {
  tocCollapsed.value = !tocCollapsed.value
  try {
    localStorage.setItem(TOC_KEY, tocCollapsed.value ? '1' : '0')
  } catch {
    /* 隐私模式 */
  }
}

function extractHeadingsFromText(markdown: string): { level: number; text: string }[] {
  if (!markdown) return []
  const list: { level: number; text: string }[] = []
  let inFence = false
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line)
    if (m) {
      list.push({ level: m[1].length, text: m[2].trim() })
    }
  }
  return list
}

const textHeadings = computed<{ level: number; text: string }[]>(() => {
  if (isNote.value && note.value?.text) {
    return extractHeadingsFromText(note.value.text)
  }
  if (file.value?.content) {
    return extractHeadingsFromText(file.value.content)
  }
  if (file.value?.blocks?.length) {
    const list: { level: number; text: string }[] = []
    for (const b of file.value.blocks) {
      if (b.kind === 'heading') {
        const t = b.text.replace(/^#+\s*/, '').trim()
        if (t) {
          const m = /^(#{1,6})\s/.exec(b.text)
          list.push({ level: m ? m[1].length : 2, text: t })
        }
      }
    }
    if (list.length > 0) return list
  }
  return []
})

const domHeadings = ref<{ level: number; text: string }[]>([])

function normalizeText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

function cleanText(text: string): string {
  return normalizeText(text)
    .replace(/^[#\d.\-、\s]+/, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function parseHeadingLevel(el: HTMLElement): number {
  const tagMatch = /^h([1-6])$/i.exec(el.tagName)
  if (tagMatch) return Number(tagMatch[1])
  const aria = el.getAttribute('aria-level')
  if (aria && !Number.isNaN(Number(aria))) return Number(aria)
  const classMatch = /heading[_\-]?([1-6])/i.exec(el.className)
  if (classMatch) return Number(classMatch[1])
  return 2
}

function headingElements(): HTMLElement[] {
  const root = host.value
  if (!root) return []
  const candidates = [
    ...root.querySelectorAll<HTMLElement>(
      'h1, h2, h3, h4, h5, h6, [class*="_heading"], [class*="-heading"], [class*="Heading"], [class*="heading"], [role="heading"]',
    ),
  ].filter((el) => {
    if (el.closest('.kb-dp-toc') || el.closest('.kb-sdoc-head') || el.closest('.kb-dp-sheet') || el.closest('.kb-comments')) {
      return false
    }
    return !!el.textContent?.trim()
  })

  return candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el)))
}

function findHeadingElement(item: OutlineItem, elements: HTMLElement[]): HTMLElement | undefined {
  if (elements.length === 0) return undefined
  const itemNorm = normalizeText(item.text)
  let target = elements.find((el) => normalizeText(el.textContent ?? '') === itemNorm)
  if (target) return target

  if (itemNorm.length >= 2) {
    target = elements.find((el) => {
      const elNorm = normalizeText(el.textContent ?? '')
      return elNorm.includes(itemNorm) || itemNorm.includes(elNorm)
    })
    if (target) return target
  }

  const itemClean = cleanText(item.text)
  if (itemClean.length >= 2) {
    target = elements.find((el) => {
      const elClean = cleanText(el.textContent ?? '')
      return elClean.length >= 2 && (elClean === itemClean || elClean.includes(itemClean) || itemClean.includes(elClean))
    })
    if (target) return target
  }

  return elements[item.index]
}

function updateDomHeadings() {
  const elements = headingElements()
  if (elements.length > 0) {
    domHeadings.value = elements.map((el) => ({
      level: parseHeadingLevel(el),
      text: el.textContent?.trim() ?? '',
    }))
  }
}

const headings = computed(() => (textHeadings.value.length > 0 ? textHeadings.value : domHeadings.value))
const outline = computed<OutlineItem[]>(() => buildOutline(headings.value))
const depth = computed(() => outlineDepth(outline.value))
const showToc = computed(() => outline.value.length >= 2)

let scroller: HTMLElement | Window | null = null
function scrollParent(element: HTMLElement | null): HTMLElement | Window {
  let node = element?.parentElement ?? null
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY)) return node
    node = node.parentElement
  }
  return window
}

function jump(item: OutlineItem) {
  const elements = headingElements()
  const target = findHeadingElement(item, elements)
  if (target) {
    const container = scrollParent(target)
    const isWin = !container || container === window || typeof (container as HTMLElement).getBoundingClientRect !== 'function'
    if (!isWin && (container as HTMLElement).scrollTo) {
      const cRect = (container as HTMLElement).getBoundingClientRect()
      const tRect = target.getBoundingClientRect()
      const offsetTop = tRect.top - cRect.top + (container as HTMLElement).scrollTop
      try {
        (container as HTMLElement).scrollTo({ top: Math.max(0, offsetTop - 12), behavior: 'smooth' })
      } catch {
        (container as HTMLElement).scrollTop = Math.max(0, offsetTop - 12)
      }
      try {
        (container as HTMLElement).scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
      } catch {
        // ignore
      }
    } else {
      try {
        target.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      } catch {
        target.scrollIntoView?.()
      }
    }
  }
  activeIndex.value = item.index
  tocOpen.value = false
}

let spyFrame = 0
function spy() {
  if (spyFrame) return
  spyFrame = window.requestAnimationFrame(() => {
    spyFrame = 0
    const elements = headingElements()
    if (elements.length === 0 || outline.value.length === 0) return
    const firstEl = elements[0]
    const container = firstEl ? scrollParent(firstEl) : scroller
    const isWin = !container || container === window || typeof (container as HTMLElement).getBoundingClientRect !== 'function'
    const top = isWin ? 0 : (container as HTMLElement).getBoundingClientRect().top
    let current = -1
    for (const item of outline.value) {
      const element = findHeadingElement(item, elements)
      if (element) {
        const elTop = element.getBoundingClientRect().top - top
        if (elTop <= 96) current = item.index
      }
    }
    activeIndex.value = current >= 0 ? current : (outline.value[0]?.index ?? -1)
  })
}

function bindScroll() {
  scroller?.removeEventListener('scroll', spy)
  scroller = scrollParent(host.value)
  scroller.addEventListener('scroll', spy, { passive: true })
  window.addEventListener('scroll', spy, { capture: true, passive: true })
  spy()
}

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

let resizeObserver: ResizeObserver | null = null
let mutationObserver: MutationObserver | null = null
onMounted(() => {
  const measure = () => (wide.value = (host.value?.parentElement?.clientWidth ?? host.value?.clientWidth ?? 0) >= 900)
  measure()
  if (host.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(host.value.parentElement ?? host.value)
  }
  if (host.value && typeof MutationObserver !== 'undefined') {
    mutationObserver = new MutationObserver(() => {
      updateDomHeadings()
      spy()
    })
    mutationObserver.observe(host.value, { childList: true, subtree: true })
  }
  bindScroll()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  mutationObserver?.disconnect()
  scroller?.removeEventListener('scroll', spy)
  window.removeEventListener('scroll', spy, { capture: true })
  window.cancelAnimationFrame(spyFrame)
})

/* ---------------- 在线协作编辑 ---------------- */
const collabFeature = useFeature('collab.edit')
const collab = shallowRef<CollabProvider | null>(null)
/** 正在建立协作连接:这段时间不显示任何编辑器,免得用户往临时的单人编辑器里输入、连上后又被整个换掉 */
const collabPending = ref(false)
const collabKey = useCollabKey(() => collab.value)
const richEditor = ref<{ currentText: () => string | null } | null>(null)
const codeEditor = ref<{ getView: () => { state: { doc: { toString: () => string } } } | null } | null>(null)
let stopLanding: (() => void) | null = null
/** 这个入口支持协作、且账号有「多人在线编辑」(游客没有账号,由链接授权决定) */
const collabAvailable = computed(() => !!props.access.collab && (props.access.guest || collabFeature.value))
function stopCollab() {
  stopLanding?.()
  stopLanding = null
  collab.value?.destroy()
  collab.value = null
}
async function startCollab() {
  const cfg = props.access.collab
  if (!cfg) return
  const [{ openCollab }, { startLanding }] = await Promise.all([import('@/collab/session'), import('@/collab/landing')])
  const provider = openCollab({
    spaceId: cfg.spaceId,
    collection: collection.value,
    doc: isNote.value ? { insight: props.target.id ?? '' } : { file: path.value },
    ...(cfg.linkToken ? { linkToken: cfg.linkToken } : {}),
  })
  collab.value = provider
  // 笔记正文是 Yjs 结构,由落地者序列化成 Markdown 提交;文本文件服务端自己能取出字符串,不用客户端落地
  if (richRoom.value) stopLanding = startLanding(provider, { getMarkdown: () => richEditor.value?.currentText() ?? null })
}
watch(editing, (value) => {
  if (!value) stopCollab()
})
onBeforeUnmount(stopCollab)

const title = computed(() => (isNote.value ? (note.value?.title ?? '无标题') : (path.value.split('/').pop() ?? path.value)))
const dirty = computed(() => {
  if (!editing.value) return false
  // 协作编辑:正文随时同步到房间,没有「还没保存的正文」;笔记只有标题可能还没提交
  if (collab.value) return isNote.value && draftTitle.value !== (note.value?.title ?? '')
  if (isNote.value) return draftTitle.value !== (note.value?.title ?? '') || draftBody.value.trimEnd() !== (note.value?.text ?? '').trimEnd()
  return draftBody.value.trimEnd() !== (file.value?.content ?? '').trimEnd()
})
watch(dirty, (value) => emit('dirty', value))

const canEditHere = computed(() => props.access.can.edit && (isNote.value || !!file.value?.editable))
/** Word / Excel / PowerPoint:登录的协作者在对方的知识库里多人协同编辑(游客的链接还不支持;单人编辑只在自己的知识库里) */
const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx'])
const isOffice = computed(() => !isNote.value && OFFICE_EXTS.has(path.value.split('.').pop()?.toLowerCase() ?? ''))
const canEditOffice = computed(() => isOffice.value && props.access.can.edit && !props.access.guest && !!props.access.collab && collabFeature.value)
const officeEditing = ref(false)
function closeOffice() {
  officeEditing.value = false
  void load()
}
/** 文件能在线编辑的前提是后端给了文本原文;能改权限但格式不支持时要说一声 */
const editHint = computed(() => (props.access.can.edit && !isNote.value && file.value && !file.value.editable && !canEditOffice.value ? '这种格式不能在线编辑,可以下载后修改。' : ''))

const fileSource = computed(() => props.access.rawUrl(collection.value, path.value))
/** 下载走流式接口(无 64 MB 上限,支持 Range);旧入口没给 downloadUrl 时退回 raw。 */
const fileDownload = computed(() => (props.access.downloadUrl ? props.access.downloadUrl(collection.value, path.value) : fileSource.value))
const rawUrl = computed(() => (file.value && INLINE_FORMATS.has(file.value.format.toLowerCase()) ? fileSource.value : null))
const linkContext = computed<LinkContext | null>(() =>
  collection.value
    ? {
        collection: collection.value,
        sourcePath: isNote.value ? undefined : path.value,
        rawUrl: (name, target) => props.access.rawUrl(name, target),
        downloadUrl: (name, target) => (props.access.downloadUrl ? props.access.downloadUrl(name, target) : props.access.rawUrl(name, target)),
      }
    : null,
)
// 链接体检失败不阻塞正文:报告为空只是没有提示
const { report: linkReport } = useDocLinks({
  source: () => (isNote.value ? (note.value?.text ?? '') : (file.value?.content ?? '')),
  context: () => linkContext.value,
  call: (capability, args) => props.access.call(capability, args),
  // 笔记不在分享 root 里:体检只查文件,避免把分享者私有笔记的存在性暴露给游客
  checkNotes: false,
})
function onLinkError(message: string) {
  toast.push(message, 'warning')
}

/** 分享页里点正文中的文件链接:能下载就下载,不能下载就开原件预览(权限仍由分享链接决定) */
function openSharedAttachment(target: { collection: string; path: string; fragment?: string }) {
  if (!target?.path) return
  const builder = props.access.can.download && props.access.downloadUrl ? props.access.downloadUrl : props.access.rawUrl
  window.open(builder(target.collection, target.path), '_blank', 'noopener,noreferrer')
}

/**
 * 协作编辑（笔记 / Markdown 文件）交给统一编辑器外壳的打开请求。
 * 正文以房间为准（collabRich），这里的原文只在房间还空着时垫底；保存不走外壳的通道（没有 transport），
 * 笔记正文由落地者提交、文件由服务端写盘，所以 Ctrl/⌘+S 在这里不触发任何额外保存。
 */
const richRequest = computed<EditorOpenRequest>(() => ({
  fileId: isNote.value ? (props.target.id ?? 'shared-note') : path.value,
  collection: collection.value || undefined,
  path: isNote.value ? undefined : path.value,
  format: 'md',
  source: { kind: 'text', text: draftBody.value, name: isNote.value ? `${title.value}.md` : path.value },
  readonly: false,
  revision: 0,
  permissions: { read: true, write: true, comment: false, ai: false, export: false },
  ...(collab.value ? { collabRich: collab.value, collabStatus: collab.value } : {}),
}))
/**
 * 外壳需要的页面服务。分享页是别人的库：不能上传（collection 为 null，粘贴图片 / 附件会提示不能上传，
 * 而不是把文件悄悄写进自己的库），没有「引用笔记」搜索（分享范围外的笔记不该露出），也没有评论栏；
 * 链接体检、点附件和提示沿用本页原来的处理。
 */
const richServices: TextServices = {
  collection: () => null,
  sourcePath: () => (isNote.value ? null : path.value),
  adminView: () => '',
  linkContext: () => linkContext.value,
  linkStates: () => linkReport.value.states,
  fileCollections: () => [],
  openLink: () => undefined,
  openAttachment: (target) => openSharedAttachment(target),
  linkError: (message) => onLinkError(message),
}

async function load() {
  status.value = 'loading'
  errorText.value = ''
  editing.value = false
  officeEditing.value = false
  saveError.value = ''
  conflict.value = false
  try {
    if (isNote.value) {
      const result = await props.access.call<{ item: NoteItem }>('get_item', { id: props.target.id })
      note.value = result.item
      file.value = null
      emit('loaded', result.item.title ?? '无标题')
    } else {
      file.value = await props.access.call<FilePreview>('file_preview', { collection: collection.value, path: path.value })
      note.value = null
      emit('loaded', title.value)
    }
    status.value = 'ready'
    void nextTick(updateDomHeadings)
  } catch (err) {
    errorText.value = shareErrorText(err, '这篇文档没有打开。检查网络后重试。')
    status.value = 'error'
  }
}
onMounted(() => void load())
watch(
  () => [props.target.kind, props.target.id, props.target.collection, props.target.path],
  () => void load(),
)

async function startEdit() {
  saveError.value = ''
  conflict.value = false
  if (isNote.value) {
    draftTitle.value = note.value?.title ?? ''
    draftBody.value = note.value?.text ?? ''
  } else {
    draftBody.value = file.value?.content ?? ''
  }
  editing.value = true
  if (collabAvailable.value) {
    collabPending.value = true
    try {
      await startCollab()
    } finally {
      collabPending.value = false
    }
  }
}

/** 协作编辑的「完成」:落地最后的正文(笔记)、有改标题就提交标题,再回到阅读 */
async function finishCollab() {
  if (saving.value) return
  if (isNote.value && !draftTitle.value.trim()) {
    saveError.value = '标题不能为空。'
    return
  }
  saving.value = true
  saveError.value = ''
  conflict.value = false
  try {
    const provider = collab.value
    // 退出前先记下我编辑器里的最终内容
    const finalText = richRoom.value ? (richEditor.value?.currentText() ?? null) : (codeEditor.value?.getView()?.state.doc.toString() ?? null)
    const wasLander = provider?.getState().lander ?? false
    if (provider && richRoom.value) {
      const { landAndWait } = await import('@/collab/landing')
      await landAndWait(provider, () => finalText)
    }
    if (isNote.value && draftTitle.value.trim() !== (note.value?.title ?? '')) {
      await props.access.call('edit_item', { id: props.target.id, version: await noteVersion(), title: draftTitle.value.trim() })
    }
    toast.push('已保存')
    emit('changed')
    stopCollab()
    await load()
    // 我不是落地者时,落地由房间里另一个人在他那边安静后完成,刚读到的可能还是旧内容:先显示我自己编辑器里的最终内容
    // 文本文件由服务端在安静后写盘,没有客户端落地者,所以一律先显示本地内容
    if ((!richRoom.value || !wasLander) && finalText !== null) {
      if (note.value) note.value = { ...note.value, text: finalText }
      if (file.value) file.value = { ...file.value, content: finalText }
    }
  } catch (err) {
    if ((err as { status?: number }).status === 409) {
      conflict.value = true
      saveError.value = '内容刚被别人改过(版本冲突),标题没有保存。请重新载入后再改。'
    } else {
      saveError.value = shareErrorText(err, '保存没有成功,请稍后再试。')
    }
  } finally {
    saving.value = false
  }
}

async function cancelEdit() {
  if (dirty.value) {
    const ok = await confirmer.ask({ title: '放弃未保存的修改?', message: '这篇文档的改动不会保留。', confirmText: '放弃修改', cancelText: '继续编辑', tone: 'danger' })
    if (!ok) return
  }
  editing.value = false
  saveError.value = ''
  conflict.value = false
}

/** 乐观锁版本:get_item 带了就用(后端补字段后自动生效);否则登录协作者从版本链取;再不行只能是 1。 */
async function noteVersion(): Promise<number> {
  const given = note.value?.version
  if (typeof given === 'number') return given
  try {
    const history = await props.access.call<{ items: { id: string; version: number }[] }>('item_history', { id: props.target.id })
    const mine = history.items.find((entry) => entry.id === props.target.id)
    if (mine) return mine.version
  } catch {
    // 通过链接访问不开放版本历史:没有别的办法拿到版本
  }
  return 1
}

async function save() {
  if (saving.value || !dirty.value) return
  if (isNote.value && !draftTitle.value.trim()) {
    saveError.value = '标题不能为空。'
    return
  }
  if (!draftBody.value.trim()) {
    saveError.value = '正文不能为空。'
    return
  }
  saving.value = true
  saveError.value = ''
  conflict.value = false
  try {
    if (isNote.value) {
      await props.access.call('edit_item', { id: props.target.id, version: await noteVersion(), title: draftTitle.value.trim(), body: draftBody.value })
    } else {
      let expected: number | undefined
      try {
        const versions = await props.access.call<{ versions: { version: number }[] }>('file_versions', { collection: collection.value, path: path.value })
        expected = versions.versions[0]?.version
      } catch {
        // 通过链接看不到版本历史:不带乐观锁,以最后一次保存为准
      }
      await props.access.call('save_file', { collection: collection.value, path: path.value, content: draftBody.value, ...(expected !== undefined ? { expected_version: expected } : {}) })
    }
    toast.push('已保存')
    emit('changed')
    await load()
  } catch (err) {
    if ((err as { status?: number }).status === 409) {
      conflict.value = true
      saveError.value = '内容刚被别人改过(版本冲突),你的修改没有保存。请先把修改复制下来,再点「重新载入」。'
    } else {
      saveError.value = shareErrorText(err, '保存没有成功,请稍后再试。')
    }
  } finally {
    saving.value = false
  }
}

defineExpose({ dirty, reload: load })
</script>

<template>
  <article ref="host" class="kb-sdoc" :class="{ 'is-wide': wide && showToc }" data-testid="shared-doc">
    <KbSkeleton v-if="status === 'loading'" variant="card" :lines="6" />
    <KbEmpty v-else-if="status === 'error'" icon="failed" title="这篇文档没有打开" :description="errorText" data-testid="shared-doc-error">
      <template #action><KbButton size="sm" @click="load">重试</KbButton></template>
    </KbEmpty>

    <template v-else>
      <div class="kb-sdoc-layout">
        <div class="kb-sdoc-main">
          <header class="kb-sdoc-head">
            <KbInput v-if="editing && isNote" v-model="draftTitle" aria-label="标题" placeholder="标题" data-testid="shared-doc-title-input" />
            <h2 v-else class="kb-sdoc-title" data-testid="shared-doc-title">{{ title }}</h2>
            <div class="kb-sdoc-actions">
              <button v-if="showToc && !wide" type="button" class="kb-dp-toc-btn" :aria-expanded="tocOpen" data-testid="toc-btn-mobile" @click="tocOpen = true">
                <KbIcon name="list" :size="12" /> 大纲
              </button>
              <template v-if="editing && collabPending"></template>
              <template v-else-if="editing && collab">
                <CollabAvatars :provider="collab" />
                <KbButton size="sm" variant="primary" :disabled="saving" data-testid="shared-doc-finish" @click="finishCollab">{{ saving ? '保存中…' : '完成' }}</KbButton>
              </template>
              <template v-else-if="editing">
                <KbButton size="sm" :disabled="saving" data-testid="shared-doc-cancel" @click="cancelEdit">取消</KbButton>
                <KbButton size="sm" variant="primary" :disabled="saving || !dirty" data-testid="shared-doc-save" @click="save">{{ saving ? '保存中…' : '保存' }}</KbButton>
              </template>
              <template v-else>
                <a v-if="file && access.can.download" class="btn sm" :href="fileDownload" download data-testid="shared-doc-download">下载原件</a>
                <KbButton v-if="canEditHere" size="sm" variant="primary" data-testid="shared-doc-edit" @click="startEdit">编辑</KbButton>
                <KbButton v-if="canEditOffice && !officeEditing" size="sm" variant="primary" data-testid="shared-doc-office-edit" @click="officeEditing = true">在线编辑</KbButton>
              </template>
            </div>
          </header>
          <InAppDownloadNote v-if="file && access.can.download && !editing && inAppNote" class="kb-sdoc-inapp" />
          <p v-if="note && !editing" class="kb-sdoc-meta">更新于 {{ relativeTime(note.updated_at) }}<template v-if="note.tags.length"> · </template><KbBadge v-for="tag in note.tags" :key="tag" tone="neutral">#{{ tag }}</KbBadge></p>
          <p v-if="editHint" class="kb-sdoc-meta" data-testid="shared-doc-edit-hint">{{ editHint }}</p>
          <!-- AI 的修改建议:能编辑的登录协作者也能看、能接受;经公开链接打开的没有这项(游客、登录用户都一样:
               链接白名单不含 doc_proposals,请求只会白挨一个 403) -->
          <EditProposals
            v-if="access.can.edit && !access.guest && !access.viaLink"
            :call="access.call"
            :collection="isNote ? undefined : collection"
            :path="isNote ? undefined : path"
            :note-id="isNote ? (target.id ?? undefined) : undefined"
            @applied="(live: boolean) => { if (!live && !editing) void load() }"
          />

          <div v-if="saveError" class="kb-sdoc-error" role="alert" data-testid="shared-doc-save-error">
            {{ saveError }}
            <KbButton v-if="conflict" size="sm" data-testid="shared-doc-reload" @click="load">重新载入</KbButton>
          </div>

          <!-- Word / Excel / PowerPoint:对方知识库里的多人协同 -->
          <!-- 编辑器按父元素的高度铺满(在知识库页里由工作区给高度);这里文档是一列往下排的,要给它一个确定的高度,否则高度是 0、表格引擎一直打不开 -->
          <div v-if="officeEditing && access.collab" class="kb-sdoc-office" data-testid="shared-doc-office">
            <OfficeEditor :collection="collection" :path="path" :space-id="access.collab.spaceId" @close="closeOffice" />
          </div>

          <!-- 编辑:Markdown / 纯文本源码 -->
          <div v-else-if="editing && collabPending" class="kb-sdoc-editor" data-testid="shared-doc-connecting">
            <div class="kb-hint" role="status">正在连接多人编辑…</div>
          </div>
          <div v-else-if="editing && collab" class="kb-sdoc-editor is-collab" data-testid="shared-doc-editor">
            <CollabBar :provider="collab" />
            <Suspense>
              <!-- 打开请求里的原文必须是笔记 / 文件的当前正文，不能是空串：外壳以房间内容为准，原文只在房间还空着时垫底，
                   传空串会让「没动正文就点完成」时落地者把空正文提交成笔记正文 -->
              <EditorHost
                v-if="richRoom"
                ref="richEditor"
                :key="collabKey"
                :request="richRequest"
                :show-chrome="true"
                :show-status="true"
                :chrome-title="false"
                :chrome-close="false"
                :chrome-save="false"
                :text-services="richServices"
                :capabilities="{ ai: false, comment: false, export: false }"
              />
              <CodeEditor v-else ref="codeEditor" :key="collabKey" model-value="" :filename="path" :collab="collab" aria-label="文件内容(多人编辑)" />
              <template #fallback><div class="kb-hint">加载编辑器…</div></template>
            </Suspense>
          </div>
          <div v-else-if="editing" class="kb-sdoc-editor" data-testid="shared-doc-editor">
            <Suspense>
              <CodeEditor v-model="draftBody" :filename="isNote ? 'note.md' : path" aria-label="正文源码" @save="save" />
              <template #fallback><div class="kb-hint">加载编辑器…</div></template>
            </Suspense>
          </div>

          <!-- 阅读 -->
          <div v-else-if="note" class="kb-sdoc-body" data-testid="shared-doc-body">
            <Suspense>
              <MarkdownRead
                class="kb-md-read-doc"
                :source="note.text"
                :link-context="linkContext"
                :link-states="linkReport.states"
                :open-in-new-tab="true"
                :allow-notes="false"
                @link-error="onLinkError"
              />
              <template #fallback><div class="kb-hint">加载中…</div></template>
            </Suspense>
          </div>
          <div v-else-if="file" class="kb-sdoc-body is-file" data-testid="shared-doc-body">
            <FileViewer
              :format="file.format"
              :blocks="file.blocks"
              :chunks="file.chunks"
              :highlight="null"
              :raw-url="rawUrl"
              :source-url="access.can.download ? fileDownload : null"
              :content="file.content"
              :file-name="path"
              :link-context="linkContext"
              :link-states="linkReport.states"
              @open-attachment="openSharedAttachment"
              @link-error="onLinkError"
            />
          </div>

          <DocComments v-if="!editing" :access="access" :collection="collection" :source="commentSource" :my-id="myId" />
        </div>

        <!-- 悬浮大纲（与文档页同名：「目录」只指文件夹树） -->
        <aside v-if="wide && showToc" class="kb-dp-toc" aria-label="大纲" data-testid="doc-toc">
          <button v-if="tocCollapsed" type="button" class="kb-dp-toc-fab" aria-label="展开大纲" title="展开大纲" :aria-expanded="false" data-testid="toc-expand" @click="toggleToc">
            <KbIcon name="list" :size="14" />
          </button>
          <div v-else class="kb-dp-toc-card">
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
        </aside>
      </div>

      <!-- 移动端 / 窄屏底部抽屉大纲 -->
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
    </template>
  </article>
</template>

<style>
.kb-sdoc { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; width: 100%; box-sizing: border-box; }
.kb-sdoc-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-4); width: 100%; box-sizing: border-box; }
.kb-sdoc.is-wide .kb-sdoc-layout { grid-template-columns: minmax(0, 1fr) 200px; gap: 32px; }
.kb-sdoc-main { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-3); }

.kb-sdoc-head { display: flex; align-items: flex-start; gap: var(--sp-3); flex-wrap: wrap; min-width: 0; }
.kb-sdoc-head .kb-input { flex: 1; min-width: 0; font-size: var(--text-20); font-weight: var(--fw-title); }
.kb-sdoc-title { flex: 1; min-width: 0; margin: 0; font-size: var(--text-24); font-weight: var(--fw-title); line-height: var(--lh-tight); overflow-wrap: anywhere; }
.kb-sdoc-actions { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
.kb-sdoc-actions .btn { text-decoration: none; }
.kb-sdoc-meta { margin: 0; color: var(--text-tertiary); font-size: var(--text-12); display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.kb-sdoc-error { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; padding: var(--sp-2) var(--sp-3); border-radius: var(--r2); background: color-mix(in oklab, var(--status-danger) 12%, transparent); color: var(--status-danger-text); font-size: var(--text-13); line-height: var(--lh-body); }
.kb-sdoc-editor { min-height: 320px; display: flex; flex-direction: column; min-width: 0; }
.kb-sdoc-office { height: 75vh; min-height: 420px; display: flex; flex-direction: column; min-width: 0; }
.kb-sdoc-body { min-width: 0; overflow-wrap: anywhere; }
.kb-sdoc-body.is-file { min-height: 520px; height: calc(100vh - 160px); display: flex; flex-direction: column; }
@media (max-width: 600px) {
  .kb-sdoc-body.is-file { height: calc(100dvh - 120px); min-height: 420px; }
}

/* 悬浮目录:粘在视口右侧,不占正文的位置;右列宽度固定,折叠成小圆钮时正文不会跳 */
.kb-sdoc .kb-dp-toc {
  position: sticky;
  top: 24px;
  z-index: 2;
  align-self: start;
}
.kb-sdoc .kb-dp-toc-card {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 140px);
  padding: 6px;
  background: var(--surface-2);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r3);
  box-shadow: var(--sh2);
}
.kb-sdoc .kb-dp-toc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 2px 4px 10px;
}
.kb-sdoc .kb-dp-toc-title {
  color: var(--m);
  font-size: calc(12px * var(--fs));
  font-weight: 600;
}
.kb-sdoc .kb-dp-toc-nav {
  min-height: 0;
  overflow-y: auto;
}
.kb-sdoc .kb-dp-toc-fold,
.kb-sdoc .kb-dp-toc-fab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--t2);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.kb-sdoc .kb-dp-toc-fold {
  width: 24px;
  height: 24px;
  border-radius: var(--r1);
}
.kb-sdoc .kb-dp-toc-fold:hover,
.kb-sdoc .kb-dp-toc-fab:hover {
  color: var(--t);
  background: var(--hover);
}
.kb-sdoc .kb-dp-toc-fab {
  width: 32px;
  height: 32px;
  background: var(--surface-2);
  border: var(--hl) solid var(--b2);
  border-radius: 50%;
  box-shadow: var(--sh2);
}
@media (pointer: coarse) {
  .kb-sdoc .kb-dp-toc-fold,
  .kb-sdoc .kb-dp-toc-fab {
    position: relative;
  }
  .kb-sdoc .kb-dp-toc-fold::before,
  .kb-sdoc .kb-dp-toc-fab::before {
    content: '';
    position: absolute;
    inset: -10px;
  }
}
.kb-sdoc .kb-dp-toc-item {
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
.kb-sdoc .kb-dp-toc-item:hover {
  color: var(--t);
  background: var(--hover);
}
.kb-sdoc .kb-dp-toc-item.is-on {
  color: var(--ac2);
  background: var(--accent-soft);
}
.kb-sdoc .kb-dp-toc-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  color: var(--t2);
  background: var(--surface-2);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r-pill);
  cursor: pointer;
}
@media (pointer: coarse) {
  .kb-sdoc .kb-dp-toc-btn::before {
    content: '';
    position: absolute;
    inset: -10px 0;
  }
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
</style>
