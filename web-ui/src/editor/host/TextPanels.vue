<script setup lang="ts">
/**
 * 笔记文本面的页面级面板：「引用笔记」「引用文件 / 模板」选择器、图片 / 附件上传、上传进度与提示
 *
 * 为什么放在 Host 层而不是内容面里：这些是 Vue 面板（搜索框、列表、手机上的相机 / 相册选择），
 * 而内容面按约定是纯 TS、与 Vue 不耦合（见 TextSurface 文件头）。内容面只「请求」（弹哪个面板、传哪些文件），
 * 面板在这里渲染，选好后通过命令（text.wikilink.insert / text.markdown.insert）把结果交回内容面，
 * 所以撤销栈、协同、只读守卫都走和别的编辑一样的通道。
 *
 * 行为逐条对齐旧编辑器（已删除的 components/DocEditor.vue 里的 openPicker / openFilePicker / pickFiles / uploadFiles）：
 * 输入法组字时回车 / 方向键不被选择器吞掉（menuKeyOf）；失焦关闭；手机（宽 <600 或触屏）变贴键盘的底部面板；
 * 手机触屏上「上传图片」先问拍照还是从相册选；附件不问。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { KbSourceSheet, TOUCH_PHONE_QUERY, cameraFiles, useMedia, type SourceId, type SourceOption } from '@kb-ui/index'
import { useUploadStore } from '@/stores/upload'
import { IME_OWNED_KEYS, createImeGuard, menuKeyOf } from '@/utils/imeGuard'
import { menusAsSheet } from '@/utils/editorMobile'
import { attachmentMarkdown, imageMarkdown, isImageName } from '@/utils/attachments'
import { kbFileHref, relativeFileHref, type FileHit } from '@/utils/links'
import type { CommandResult, TextNoteHit, TextPanelName, TextServices } from '../types'
import { createTextUploader, uploadedNotice } from './textUpload'

const props = defineProps<{
  services: TextServices
  readonly: boolean
  /** 把结果交回内容面执行（走 CommandBus，只读 / 权限守卫照常生效） */
  execute: (type: string, args?: unknown) => Promise<CommandResult>
  /** 光标位置与屏幕坐标：选择器贴着光标弹出 */
  caret: () => Promise<{ pos: number; left: number; top: number; bottom: number } | null>
}>()

const emit = defineEmits<{
  /** 底部面板的高度（没开 / 不是面板模式是 0）：光标要滚到它上面 */
  (e: 'sheet-height', height: number): void
  (e: 'closed'): void
}>()

/* ---------------- 提示 + 上传 ---------------- */
const notice = ref('')
let noticeTimer = 0
function say(message: string) {
  notice.value = message
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => (notice.value = ''), 6000)
}
const uploader = createTextUploader({ services: () => props.services, notify: say })
const uploadStore = useUploadStore()

/** 编辑时由编辑器接管拖放（否则全局拖放遮罩会把文件传成新数据源）；只读时放开 */
watch(
  () => props.readonly,
  (readonly) => (uploadStore.captureDrops = !readonly),
  { immediate: true },
)

/** 依次上传，成功的作为块插回 pos（缺省为当前光标）；全部失败则什么都不插 */
async function uploadFiles(files: File[], pos?: number) {
  const pieces = await uploader.uploadAll(files)
  if (!pieces.length) return
  await props.execute('text.markdown.insert', { markdown: pieces.join('\n\n'), pos })
  say(uploadedNotice(files, pieces.length))
}

/* ---------------- 图片 / 附件选择 ---------------- */
const fileInput = ref<HTMLInputElement | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)
const cameraInput = ref<HTMLInputElement | null>(null)
// 手机触屏上「上传图片」先问一句：拍照 / 从相册选（与 KbDropzone 同一条判断：触屏且 <600 宽）。
// 「上传附件」不问：附件是文档、压缩包等，没有相机可言。电脑 / 平板（含触屏平板）保持直接选。
const touchPhone = useMedia(TOUCH_PHONE_QUERY)
const imageSheetOpen = ref(false)
const IMAGE_SOURCES: SourceOption[] = [
  { id: 'camera', title: '拍照', hint: '用相机拍一张,插入到文中' },
  { id: 'album', title: '从相册选', hint: '只选照片,可以多选' },
]
// 面板开着时屏幕转宽（旋转 / 分屏）就不再是手机，或编辑器变成只读：收起面板，免得点了「拍照」却没有对应的 input
watch(
  () => !touchPhone.value || props.readonly,
  (gone) => {
    if (gone) imageSheetOpen.value = false
  },
)

function pickFiles(kind: 'image' | 'file') {
  if (!props.services.collection()) {
    say('这里不能上传附件(没有目标集合)')
    return
  }
  if (kind === 'image' && touchPhone.value) {
    imageSheetOpen.value = true
    return
  }
  ;(kind === 'image' ? imageInput : fileInput).value?.click()
}
/** 面板里选了一项：先收面板再唤起系统选择器。input 在面板外面，面板卸载不影响它；click 仍在用户点击的同一次事件里，不会被浏览器拦。 */
function chooseImageSource(id: SourceId) {
  imageSheetOpen.value = false
  ;(id === 'camera' ? cameraInput : imageInput).value?.click()
}
function onPicked(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (files.length) void uploadFiles(files)
}
/** 相机拍的：iOS 一律叫 image.jpg，连拍会被当成同名文件，按拍摄时间改名后再走原来的插入流程 */
function onCameraPicked(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (files.length) void uploadFiles(cameraFiles(files))
}

/* ---------------- 窗口宽度 / 触屏 → 面板形态 ---------------- */
const viewportWidth = ref(typeof window === 'undefined' ? 1024 : window.innerWidth)
const onResize = () => (viewportWidth.value = window.innerWidth)
const coarse = useMedia('(pointer: coarse)')
const sheetMode = computed(() => !props.readonly && menusAsSheet({ width: viewportWidth.value, coarse: coarse.value }))

/* ---------------- 引用笔记选择器 ---------------- */
const picker = reactive({ open: false, query: '', from: 0, left: 0, top: 0, caretTop: 0, results: [] as TextNoteHit[], active: 0, loading: false })
const pickerEl = ref<HTMLElement | null>(null)
const pickerInput = ref<HTMLInputElement | null>(null)
let searchTimer = 0

async function openNotePicker(from?: number) {
  if (props.readonly) return
  let start = from
  if (start === undefined) {
    // 从工具栏 / 斜杠菜单打开：先在正文里写下 `[[`（选择器关掉时它就是普通文字，与旧编辑器一致）
    const inserted = await props.execute('text.insert', { text: '[[' })
    if (!inserted.ok) return
    const caret = await props.caret()
    if (!caret) return
    start = caret.pos - 2
  }
  const caret = await props.caret()
  picker.from = start
  Object.assign(picker, pickerAnchor(caret))
  picker.query = ''
  picker.results = []
  picker.active = 0
  picker.open = true
  void nextTick(() => pickerInput.value?.focus())
  searchNotes('')
}
function searchNotes(query: string) {
  window.clearTimeout(searchTimer)
  if (!props.services.searchNotes) return
  picker.loading = true
  searchTimer = window.setTimeout(async () => {
    try {
      picker.results = (await props.services.searchNotes!(query)).slice(0, 8)
      picker.active = 0
    } catch {
      picker.results = []
    } finally {
      picker.loading = false
    }
  }, 160)
}
watch(
  () => picker.query,
  (value) => searchNotes(value),
)
async function chooseNote(hit: TextNoteHit | undefined) {
  picker.open = false
  if (!hit) {
    await props.execute('view.focus')
    return
  }
  await props.execute('text.wikilink.insert', { from: picker.from, id: hit.id, title: hit.title })
}
/** 输入框失焦（点到别处）就关掉选择器；点列表项用的是 mousedown.prevent，不会先触发这里 */
function closePickerSoon() {
  window.setTimeout(() => {
    if (document.activeElement !== pickerInput.value) picker.open = false
  }, 120)
}
function onPickerKey(event: KeyboardEvent) {
  // 输入法占着的键（选词的↑↓、上屏的回车、取消组字的 Esc）menuKeyOf 返回 null，什么都不做，也不 preventDefault
  const action = menuKeyOf(event)
  if (action === 'next') {
    event.preventDefault()
    picker.active = Math.min(picker.results.length - 1, picker.active + 1)
  } else if (action === 'prev') {
    event.preventDefault()
    picker.active = Math.max(0, picker.active - 1)
  } else if (action === 'confirm') {
    event.preventDefault()
    void chooseNote(picker.results[picker.active])
  } else if (action === 'cancel') {
    event.preventDefault()
    picker.open = false
    void props.execute('view.focus')
  }
}

/* ---------------- 引用文件 / 模板选择器 ---------------- */
// 与「引用笔记」分开：笔记用 `[[id]]`（Obsidian 兼容），文件 / 模板要写 Markdown 链接，
// 插入位置和候选来源都不一样，共用一个面板反而容易把两种语法插错。
const filePicker = reactive({
  open: false,
  query: '',
  collection: '',
  results: [] as FileHit[],
  active: 0,
  loading: false,
  /** 多选：勾选后一次插入多条；单击结果仍然只插这一条，保持原来的手感 */
  selected: [] as FileHit[],
  left: 0,
  top: 0,
  caretTop: 0,
})
const filePickerEl = ref<HTMLElement | null>(null)
const filePickerInput = ref<HTMLInputElement | null>(null)
let fileSearchTimer = 0
const fileCollectionOptions = computed(() => {
  const names = props.services.fileCollections().map((item) => item.name)
  const current = props.services.collection()
  if (current && !names.includes(current)) names.unshift(current)
  return [...new Set(names)]
})
/**
 * 选择器的弹出位置：贴着光标。拿不到光标坐标（内容面在没有布局 / 光标不可见时回 0,0,0）时，
 * 以前直接用 (8, 6)，弹窗就落在整个窗口的左上角；现在放在窗口上方居中，和工具栏打开的其它面板一样看得见、够得着
 */
function pickerAnchor(caret: { left: number; top: number; bottom: number } | null): { left: number; top: number; caretTop: number } {
  const usable = !!caret && (caret.left !== 0 || caret.top !== 0 || caret.bottom !== 0)
  if (usable) return { left: Math.max(8, Math.min(caret.left, window.innerWidth - 328)), top: caret.bottom + 6, caretTop: caret.top }
  const top = Math.round(Math.max(72, window.innerHeight * 0.16))
  return { left: Math.max(8, Math.round((window.innerWidth - 320) / 2)), top, caretTop: top - 6 }
}
async function openFilePicker() {
  if (props.readonly) return
  if (!props.services.searchFiles) {
    say('这里不能浏览文件,请在知识库页面里再引用')
    return
  }
  const caret = await props.caret()
  Object.assign(filePicker, pickerAnchor(caret))
  filePicker.collection = props.services.collection() ?? fileCollectionOptions.value[0] ?? ''
  filePicker.query = ''
  filePicker.results = []
  filePicker.active = 0
  filePicker.selected = []
  filePicker.open = true
  void nextTick(() => filePickerInput.value?.focus())
  searchFileCandidates('')
}
function searchFileCandidates(query: string) {
  window.clearTimeout(fileSearchTimer)
  if (!props.services.searchFiles || !filePicker.collection) {
    filePicker.results = []
    return
  }
  filePicker.loading = true
  fileSearchTimer = window.setTimeout(async () => {
    try {
      filePicker.results = (await props.services.searchFiles!(query, filePicker.collection)).slice(0, 30)
      filePicker.active = 0
    } catch {
      filePicker.results = []
    } finally {
      filePicker.loading = false
    }
  }, 160)
}
watch(
  () => filePicker.query,
  (value) => searchFileCandidates(value),
)
watch(
  () => filePicker.collection,
  () => searchFileCandidates(filePicker.query),
)
/** 同集合优先相对路径（换域名 / 导出离线仍可用），跨集合或目标在根外用 `kb://`；模板一律带 download=1 */
function fileTargetHref(hit: FileHit): string {
  const same = props.services.collection() === hit.collection
  const relative = same ? relativeFileHref(props.services.sourcePath(), hit.path) : null
  const href = relative ?? kbFileHref(hit.collection, hit.path, { download: hit.template })
  if (!href) return ''
  if (hit.template && !href.includes('download=1')) return `${href}?download=1`
  return href
}
const pickKey = (hit: FileHit) => `${hit.collection}\u0000${hit.path}`
const isFilePicked = (hit: FileHit) => filePicker.selected.some((item) => pickKey(item) === pickKey(hit))
function toggleFileSelection(hit: FileHit) {
  const at = filePicker.selected.findIndex((item) => pickKey(item) === pickKey(hit))
  if (at >= 0) filePicker.selected.splice(at, 1)
  else filePicker.selected.push(hit)
}
/** 一条引用的 Markdown：图片按图片语法；其它文件用附件卡片（有大小才带尺寸，避免出现「0 B」），拿不到大小就是普通链接 */
function fileRefMarkdown(hit: FileHit): string {
  const href = fileTargetHref(hit)
  if (!href) return ''
  const name = hit.name.replace(/[[\]\n]/g, ' ').trim() || hit.path
  return isImageName(hit.name) ? imageMarkdown(hit.name, href) : hit.size ? attachmentMarkdown(hit.name, href, hit.size) : `[${name}](${href})`
}
async function insertFileRefs(hits: FileHit[]) {
  const parts = hits.map(fileRefMarkdown).filter(Boolean)
  if (!parts.length) {
    say('这些文件不能引用(路径不合法)')
    await props.execute('view.focus')
    return
  }
  // 多条之间用空行分开：图片 / 附件卡片叠在一起会难以辨认，分开后每一条都能单独删
  await props.execute('text.markdown.insert', { markdown: parts.join('\n\n') })
}
async function chooseFile(hit: FileHit | undefined) {
  filePicker.open = false
  if (!hit) {
    await props.execute('view.focus')
    return
  }
  await insertFileRefs([hit])
}
async function chooseSelectedFiles() {
  const hits = [...filePicker.selected]
  filePicker.open = false
  filePicker.selected = []
  if (hits.length) await insertFileRefs(hits)
}
function closeFilePickerSoon() {
  window.setTimeout(() => {
    if (document.activeElement !== filePickerInput.value) filePicker.open = false
  }, 120)
}
function onFilePickerKey(event: KeyboardEvent) {
  const action = menuKeyOf(event)
  if (action === 'next') {
    event.preventDefault()
    filePicker.active = Math.min(filePicker.results.length - 1, filePicker.active + 1)
  } else if (action === 'prev') {
    event.preventDefault()
    filePicker.active = Math.max(0, filePicker.active - 1)
  } else if (action === 'confirm') {
    event.preventDefault()
    void chooseFile(filePicker.results[filePicker.active])
  } else if (action === 'cancel') {
    event.preventDefault()
    filePicker.open = false
    void props.execute('view.focus')
  }
}

/* ---------------- 对外 ---------------- */
function open(panel: TextPanelName, options: { from?: number } = {}) {
  if (panel === 'wikilink') void openNotePicker(options.from)
  else if (panel === 'filelink') void openFilePicker()
  else if (panel === 'image') pickFiles('image')
  else pickFiles('file')
}

/**
 * 浮层贴着光标下方弹出；光标在窗口下半部分时放不下（旧编辑器同样有这个缺陷：选择器被挤出视口，够不着），
 * 放不下就翻到光标上方。要等渲染出来才知道高度，所以在 DOM 更新后量一次；结果多时列表增高会再触发。
 */
function keepInViewport(el: HTMLElement | null, state: { top: number; caretTop: number }) {
  if (!el || sheetMode.value) return
  const height = el.getBoundingClientRect().height
  if (!height) return
  const bottomLimit = window.innerHeight - 8
  // 下方放不下就翻到光标上方；光标本身在屏幕外时两边都不成立，最后统一夹进视口（至少看得到输入框和第一批结果）
  let top = state.top
  if (top + height > bottomLimit) top = state.caretTop - 6 - height
  state.top = Math.max(8, Math.min(top, bottomLimit - height))
}
watch(
  () => [picker.open, picker.results.length, picker.loading],
  () => void nextTick(() => keepInViewport(pickerEl.value, picker)),
  { flush: 'post' },
)
watch(
  () => [filePicker.open, filePicker.results.length, filePicker.loading, filePicker.selected.length],
  () => void nextTick(() => keepInViewport(filePickerEl.value, filePicker)),
  { flush: 'post' },
)

/* ---------------- 底部面板的高度（手机）：光标要滚到它上面 ---------------- */
let sheetObserver: ResizeObserver | null = null
function measureSheet() {
  const el = pickerEl.value ?? filePickerEl.value
  emit('sheet-height', sheetMode.value && el ? Math.round(el.getBoundingClientRect().height) : 0)
}
watch([pickerEl, filePickerEl], ([noteEl, fileEl], [prevNote, prevFile]) => {
  if (prevNote) sheetObserver?.unobserve(prevNote)
  if (prevFile) sheetObserver?.unobserve(prevFile)
  if (noteEl) sheetObserver?.observe(noteEl)
  if (fileEl) sheetObserver?.observe(fileEl)
  measureSheet()
})
watch(sheetMode, measureSheet)

/* ---------------- 输入法组字守卫 ---------------- */
// 组字过程中的回车 / 方向键 / Esc / Tab 是输入法在上屏、选词、取消，不是选择器或页面其它全局快捷键的命令（见 utils/imeGuard.ts）。
// 选择器自己的 onPickerKey 已经让路了，但事件还会冒泡到 window 上的全局监听（如 Esc 关掉整个页面）：
// 我们的监听在 window 的捕获阶段、先于它们挂上，对选择器里的组字按键直接截断。
const ime = createImeGuard()
const onCompositionStart = () => ime.start()
const onCompositionEnd = () => ime.end()
function swallowImeKeys(event: KeyboardEvent) {
  if (!IME_OWNED_KEYS.includes(event.key) || !ime.owns(event)) return
  const target = event.target
  if (!(target instanceof Node)) return
  if (pickerEl.value?.contains(target) || filePickerEl.value?.contains(target)) event.stopImmediatePropagation()
}

onMounted(() => {
  document.addEventListener('compositionstart', onCompositionStart, true)
  document.addEventListener('compositionend', onCompositionEnd, true)
  window.addEventListener('keydown', swallowImeKeys, true)
  window.addEventListener('resize', onResize)
  if (typeof ResizeObserver !== 'undefined') {
    // 面板高度变化要通知 Host 改全页的 CSS 变量（会改正文底部留白）：推迟到下一帧，免得在 ResizeObserver 回调里改布局
    let queued = 0
    sheetObserver = new ResizeObserver(() => {
      if (queued) return
      queued = window.requestAnimationFrame(() => {
        queued = 0
        measureSheet()
      })
    })
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('compositionstart', onCompositionStart, true)
  document.removeEventListener('compositionend', onCompositionEnd, true)
  window.removeEventListener('keydown', swallowImeKeys, true)
  window.removeEventListener('resize', onResize)
  window.clearTimeout(noticeTimer)
  window.clearTimeout(searchTimer)
  window.clearTimeout(fileSearchTimer)
  sheetObserver?.disconnect()
  uploadStore.captureDrops = false
})

defineExpose({ open, uploadFiles, say, pickerOpen: () => picker.open || filePicker.open })
</script>

<template>
  <div class="kb-text-panels" data-testid="text-panels">
    <Transition name="kb-fade">
    <p v-if="notice" class="kb-text-notice" role="status" data-testid="text-notice">{{ notice }}</p>
    </Transition>
    <Transition name="kb-fade">
    <ul v-if="uploader.tasks.length" class="kb-text-uploads" aria-live="polite" data-testid="text-uploads">
      <li v-for="task in uploader.tasks" :key="task.id" :class="{ 'is-error': task.error }">
        <span class="kb-text-upload-name">{{ task.name }}</span>
        <span v-if="task.error" class="kb-text-upload-state">{{ task.error }}</span>
        <template v-else>
          <span class="kb-text-upload-bar"><i :style="{ width: `${Math.max(4, task.percent)}%` }"></i></span>
          <span class="mono kb-text-upload-state">{{ task.percent }}%</span>
        </template>
      </li>
    </ul>
    </Transition>

    <input ref="imageInput" type="file" accept="image/*" multiple hidden data-testid="pick-image" @change="onPicked" />
    <input ref="fileInput" type="file" multiple hidden data-testid="pick-attach" @change="onPicked" />
    <!-- capture 在部分 iOS 版本被忽略(直接弹系统选择器):可以接受的降级,不做 UA 判断 -->
    <input v-if="touchPhone" ref="cameraInput" type="file" accept="image/*" capture="environment" hidden data-testid="pick-camera" @change="onCameraPicked" />
    <KbSourceSheet v-if="imageSheetOpen" title="上传图片" :options="IMAGE_SOURCES" @choose="chooseImageSource" @close="imageSheetOpen = false" />

    <Teleport to="body">
      <Transition :name="sheetMode ? 'kb-rise' : 'kb-menu'">
      <div
        v-if="picker.open"
        ref="pickerEl"
        class="kb-text-picker"
        :class="{ 'is-sheet': sheetMode }"
        role="dialog"
        aria-label="引用笔记"
        data-testid="note-picker"
        :style="sheetMode ? undefined : { left: `${picker.left}px`, top: `${picker.top}px` }"
      >
        <input ref="pickerInput" v-model="picker.query" class="kb-text-picker-input" type="search" placeholder="搜索笔记标题…" aria-label="搜索笔记" @keydown="onPickerKey" @blur="closePickerSoon" />
        <ul class="kb-text-picker-list" role="listbox">
          <li v-if="picker.loading && !picker.results.length" class="m kb-text-picker-empty">搜索中…</li>
          <li v-else-if="!picker.results.length" class="m kb-text-picker-empty">没有匹配的笔记</li>
          <li
            v-for="(hit, at) in picker.results"
            :key="hit.id"
            role="option"
            class="kb-text-picker-item"
            :class="{ 'is-on': at === picker.active }"
            :aria-selected="at === picker.active"
            data-testid="note-picker-item"
            @mousedown.prevent="chooseNote(hit)"
            @mouseenter="picker.active = at"
          >
            <span class="kb-text-picker-title">{{ hit.title || hit.id }}</span>
            <span v-if="hit.kind" class="kb-text-picker-kind">{{ hit.kind }}</span>
          </li>
        </ul>
      </div>
      </Transition>
      <Transition :name="sheetMode ? 'kb-rise' : 'kb-menu'">
      <div
        v-if="filePicker.open"
        ref="filePickerEl"
        class="kb-text-picker"
        :class="{ 'is-sheet': sheetMode }"
        role="dialog"
        aria-label="引用文件"
        data-testid="file-picker"
        :style="sheetMode ? undefined : { left: `${filePicker.left}px`, top: `${filePicker.top}px` }"
      >
        <select v-if="fileCollectionOptions.length > 1" v-model="filePicker.collection" class="kb-text-picker-select" aria-label="选择集合">
          <option v-for="name in fileCollectionOptions" :key="name" :value="name">{{ name }}</option>
        </select>
        <input ref="filePickerInput" v-model="filePicker.query" class="kb-text-picker-input" type="search" placeholder="搜索文件 / 模板…" aria-label="搜索文件" @keydown="onFilePickerKey" @blur="closeFilePickerSoon" />
        <ul class="kb-text-picker-list" role="listbox">
          <li v-if="filePicker.loading && !filePicker.results.length" class="m kb-text-picker-empty">搜索中…</li>
          <li v-else-if="!filePicker.results.length" class="m kb-text-picker-empty">没有匹配的文件</li>
          <li
            v-for="(hit, at) in filePicker.results"
            :key="hit.collection + ':' + hit.path"
            role="option"
            class="kb-text-picker-item"
            :class="{ 'is-on': at === filePicker.active }"
            :aria-selected="at === filePicker.active"
            :title="hit.path"
            data-testid="file-picker-item"
            @mousedown.prevent="chooseFile(hit)"
            @mouseenter="filePicker.active = at"
          >
            <!-- mousedown 必须 stop：整行的 mousedown 是“单击即插入并关闭”，勾选框的按下事件冒泡上去就会在勾选前把选择器关掉（多选永远用不了） -->
            <input type="checkbox" class="kb-text-picker-check" :checked="isFilePicked(hit)" :aria-label="`选择 ${hit.name}`" @mousedown.prevent.stop @click.stop="toggleFileSelection(hit)" />
            <span class="kb-text-picker-title">{{ hit.name }}</span>
            <span class="kb-text-picker-kind">{{ hit.template ? '模板' : hit.kind || '文件' }}</span>
          </li>
        </ul>
        <div v-if="filePicker.selected.length" class="kb-text-picker-foot">
          <span>已选 {{ filePicker.selected.length }} 个</span>
          <button type="button" class="btn sm pri" data-testid="file-picker-insert" @mousedown.prevent @click="chooseSelectedFiles">插入选中</button>
        </div>
      </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style>
.kb-text-panels {
  flex: none;
}
.kb-text-notice {
  margin: 0 0 10px;
  padding: 6px 10px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--status-warning) 10%, transparent);
  border-radius: var(--r1);
  font-size: calc(13px * var(--fs));
}

/* ======== 上传进度 ======== */
.kb-text-uploads {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kb-text-uploads li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: var(--surface-2);
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r2);
  font-size: calc(13px * var(--fs));
}
.kb-text-uploads li.is-error {
  border-color: color-mix(in srgb, var(--status-danger) 45%, transparent);
}
.kb-text-upload-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-text-upload-bar {
  flex: 0 0 120px;
  height: 4px;
  background: var(--chart-track);
  border-radius: var(--r-pill);
  overflow: hidden;
}
.kb-text-upload-bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width var(--dur-base) var(--ease-out);
}
.kb-text-upload-state {
  flex: none;
  color: var(--text-tertiary);
}
.kb-text-uploads li.is-error .kb-text-upload-state {
  color: var(--status-danger-text);
}

/* ======== 选择器（引用笔记 / 引用文件） ======== */
.kb-text-picker {
  position: fixed;
  z-index: 90;
  width: 320px;
  max-width: calc(100vw - 16px);
  padding: 6px;
  background: var(--surface-3);
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r2);
  box-shadow: var(--sh3);
}
.kb-text-picker-select {
  width: 100%;
  height: 28px;
  margin-bottom: 6px;
  padding: 0 8px;
  color: var(--text-secondary);
  background: var(--input-bg);
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r1);
  box-sizing: border-box;
}
.kb-text-picker-select:focus {
  outline: none;
  border-color: var(--accent);
}
.kb-text-picker-input {
  flex: none;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  color: var(--text-primary);
  background: var(--input-bg);
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r1);
  box-sizing: border-box;
}
.kb-text-picker-input:focus {
  outline: none;
  border-color: var(--accent);
}
.kb-text-picker-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  max-height: 280px;
  overflow-y: auto;
}
.kb-text-picker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--r1);
  cursor: pointer;
}
.kb-text-picker-item.is-on {
  background: var(--surface-hover);
}
.kb-text-picker-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-text-picker-kind {
  flex: none;
  padding: 0 6px;
  color: var(--accent-text);
  background: var(--accent-soft);
  border-radius: var(--r-pill);
  font-size: calc(11px * var(--fs));
}
.kb-text-picker-check {
  flex: none;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}
.kb-text-picker-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  padding: 6px 4px 2px;
  border-top: var(--hl) solid var(--border-default);
  color: var(--text-secondary);
  font-size: calc(12px * var(--fs));
}
.kb-text-picker-empty {
  padding: 10px;
}

/* ======== 手机（宽 <600 或触屏）：贴键盘上沿的底部面板 ========
   不抢焦点（不用 KbSheet），编辑器的键盘不收起；坐在贴键盘的工具栏之上（--kbd-bar）；
   最多占可视高度的 40%，横屏键盘弹出后可视高度太小，至少留 100px。
   可视高度 = 100dvh − 键盘占用：iOS 上布局视口不变要减，Android 上布局视口跟着缩、占用是 0。 */
.kb-text-picker.is-sheet {
  position: fixed !important;
  left: 0 !important;
  right: 0 !important;
  top: auto !important;
  bottom: calc(var(--kbd-inset, 0px) + var(--kbd-bar, 0px)) !important;
  z-index: 45;
  display: flex !important;
  flex-direction: column;
  box-sizing: border-box;
  width: auto;
  max-width: none;
  max-height: max(100px, calc((100vh - var(--kbd-inset, 0px)) * 0.4));
  max-height: max(100px, calc((100dvh - var(--kbd-inset, 0px)) * 0.4));
  margin: 0;
  padding-left: var(--safe-left, 0px);
  padding-right: var(--safe-right, 0px);
  border-width: var(--hl) 0 0;
  border-radius: var(--r4) var(--r4) 0 0;
  box-shadow: 0 -6px 20px rgba(var(--shade), 0.25);
}
/* 键盘没开（外接键盘的平板、触屏笔记本）时面板贴着屏幕底，让开底部横条 */
html:not([data-kbd='open']) .kb-text-picker.is-sheet {
  padding-bottom: var(--safe-bottom, 0px);
}
.kb-text-picker.is-sheet .kb-text-picker-input {
  min-height: 44px;
}
.kb-text-picker.is-sheet .kb-text-picker-list {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.kb-text-picker.is-sheet .kb-text-picker-item {
  min-height: 44px;
  box-sizing: border-box;
}
.kb-text-picker.is-sheet .kb-text-picker-empty {
  min-height: 44px;
  display: flex;
  align-items: center;
}

@media print {
  .kb-text-uploads {
    display: none !important;
  }
}
</style>
