<script setup lang="ts">
// 文件查看器入口:任何文件都有出路。
//   1. 按格式(viewKindOf)挑查看器:PDF / Word / PPT / 表格 / 老 Word·PPT / ODT·ODP / RTF / EPUB / 邮件 / 笔记本 /
//      网页 / 压缩包 / Markdown / 代码与文本 / 图片 / 音视频;
//   2. 扩展名认不出来 → SniffGate 读内容判断(魔数 + 容器内部 + 文本特征),再按结论重新路由;
//   2b. 页面不认得的扩展名,管理员装了扩展并注册了 Codec / 内容面 → 用统一外壳(EditorHost)只读打开(扩展格式入口);
//   3. 查看器渲染不了(加密 / 损坏 / 太大 / 无权限 / chunk 拉取失败)→ 退回「文字层」(检索用的抽取结果),
//      连抽取结果都没有 → 原始内容(文本或十六进制)。顶部提示条可重试、可随时切换。
// 每个查看器都是异步 chunk,首屏不为它们付体积。
import { computed, defineAsyncComponent, ref, shallowRef, watch, type AsyncComponentLoader, type Component } from 'vue'
import type { PreviewBlock, PreviewChunk } from '@kb-ui/index'
import DocViewer from '@/components/DocViewer.vue'
import SniffGate from '@/components/SniffGate.vue'
import ViewerLoading from '@/components/ViewerLoading.vue'
import type { Resolved } from '@/utils/sniff'
import { deriveHit } from '@/utils/viewerHit'
import { fetchOriginal } from '@/utils/fetchOriginal'
import { extensionSourceOf, useExtensionFormat } from '@/composables/useExtensionFormat'
import { viewKindOf, type ViewKind } from '@/utils/viewKind'
import type { LinkContext, LinkState } from '@/utils/links'
import type { EditorOpenRequest, EditorSource } from '@/editor/types'
import { hitToPageAnchor } from '@/editor/surfaces/page/docx-anchors'

const props = defineProps<{
  format: string
  blocks: PreviewBlock[]
  chunks: PreviewChunk[]
  highlight: string | null
  /** 图片 / 音视频的内联地址(DocViewer 用) */
  rawUrl?: string | null
  /** 原件地址(任何格式都有;原貌渲染要靠它拿字节) */
  sourceUrl?: string | null
  /** 文本类文件的原文(`file_preview.content`,≤512 KB) */
  content?: string | null
  /** 文件名 / 路径:语法高亮按扩展名 */
  fileName?: string
  /** Markdown 预览里相对链接的解析上下文 */
  linkContext?: LinkContext | null
  /** 链接体检结果(Markdown 预览画缺失提示) */
  linkStates?: Record<string, LinkState>
  /** PDF 走统一外壳（仍复用 pdf.js 内核；文件页默认走外壳，分享页等不传时直接用 PdfViewer 组件） */
  native?: boolean
}>()
const emit = defineEmits<{
  select: [chunk: PreviewChunk]
  openAttachment: [target: { collection: string; path: string; fragment?: string }]
  openNote: [id: string]
  linkError: [message: string]
}>()

const failure = ref('')
function lazy(loader: AsyncComponentLoader): Component {
  return defineAsyncComponent({
    loader: () =>
      loader().catch((error) => {
        failure.value = '查看器组件加载失败(网络或版本更新),已改用文字层视图'
        throw error
      }),
    loadingComponent: ViewerLoading,
    delay: 150,
  })
}
const Viewers = {
  pdf: lazy(() => import('@/components/PdfViewer.vue')),
  // 新外壳只在 `native` 且 PDF 时加载；普通预览路径不为它付 chunk 体积
  nativeHost: lazy(() => import('@/editor/host/EditorHost.vue')),
  // 表格：xlsx 走 Worker 渲染的只读网格（nativeSheet）；xls / ods / xlsb 等 SheetJS 才能读的格式，
  // 以及网格打不开时的回退，用 SheetViewer（SheetJS 同步解析，不起 Worker）
  sheet: lazy(() => import('@/components/SheetViewer.vue')),
  nativeSheet: lazy(() => import('@/components/NativeSheetViewer.vue')),
  reader: lazy(() => import('@/components/DocReader.vue')),
  html: lazy(() => import('@/components/HtmlViewer.vue')),
  notebook: lazy(() => import('@/components/NotebookViewer.vue')),
  archive: lazy(() => import('@/components/ArchiveViewer.vue')),
  // Markdown 预览与笔记页共用一套渲染(md-editor-v3 已卸载)
  markdown: lazy(() => import('@/components/MarkdownRead.vue')),
  code: lazy(() => import('@/components/CodeEditor.vue')),
  text: lazy(() => import('@/components/TextFileViewer.vue')),
  binary: lazy(() => import('@/components/BinaryViewer.vue')),
}

/** 后端没给文本原文（二进制 / 超过 512 KB）时，扩展格式自己去取原件字节；重试时 epoch +1 重新取 */
const extBytes = shallowRef<Uint8Array | null>(null)
const extEpoch = ref(0)

/** 嗅探结论(扩展名认不出来的文件);切文件时清掉 */
const resolved = ref<Resolved | null>(null)
/** 文本查看器发现是二进制后改用十六进制 */
const forceBinary = ref(false)
const mode = ref<'rendered' | 'text'>('rendered')

watch(
  () => [props.sourceUrl, props.fileName, props.format],
  () => {
    resolved.value = null
    forceBinary.value = false
    mode.value = 'rendered'
    failure.value = ''
    extBytes.value = null
  },
)

/**
 * 扩展格式入口：页面不认得这个扩展名时问编辑器扩展注册表（只有管理员会加载扩展；没有扩展认领就是 null，
 * 下面的 kind 照旧走原来的查看器 / 嗅探 / 下载）。问的过程中先占住位置（pending），免得先闪出回退查看器再换掉。
 */
const extFormat = useExtensionFormat(() => (props.fileName ? props.fileName : props.format ? `x.${props.format}` : undefined))
const kind = computed<ViewKind>(() => {
  // 扩展认领了这个格式（或正在问）：先于所有按内容的判断，内置认得的格式根本不会走到这里（useExtensionFormat 已排除）
  if (extFormat.format.value || extFormat.pending.value) return 'extension'
  if (forceBinary.value) return 'binary'
  if (resolved.value) return resolved.value.binary ? 'binary' : viewKindOf(resolved.value.format, false, false)
  return viewKindOf(props.format, !!props.content, !!props.sourceUrl)
})
const format = computed(() => (resolved.value ? resolved.value.format : props.format).toLowerCase())
const ext = computed(() => (format.value.includes('.') ? format.value.split('.').pop()! : format.value))
const hit = computed(() => deriveHit(props.chunks, props.highlight))

/** 统一外壳的 PDF 请求：只读、不带保存通道；原件地址走 range 流式读取 */
const nativePdfRequest = computed<EditorOpenRequest | null>(() => {
  if (!props.native || !props.sourceUrl) return null
  const page = hit.value.page
  return {
    fileId: props.fileName || 'pdf-preview',
    format: 'pdf',
    source: { kind: 'text', text: '', name: props.fileName || 'document.pdf', url: props.sourceUrl },
    readonly: true,
    revision: 0,
    permissions: { read: true, write: false, export: false, comment: false, ai: false },
    initialHint: {
      text: hit.value.text,
      anchor: page ? { kind: 'pdf', page, rect: { x: 0, y: 0, width: 0, height: 0 } } : undefined,
    },
  }
})

/**
 * Word 只读预览走统一外壳的分页文档面。不看 `native` 属性：
 * 分享页、应用内预览等入口也该得到同一份阅读体验。
 */
const nativeDocxRequest = computed<EditorOpenRequest | null>(() => {
  if (!props.sourceUrl) return null
  const anchor = hitToPageAnchor(hit.value)
  return {
    fileId: props.fileName || 'docx-preview',
    format: 'docx',
    source: { kind: 'text', text: '', name: props.fileName || 'document.docx', url: props.sourceUrl },
    readonly: true,
    revision: 0,
    permissions: { read: true, write: false, export: false, comment: false, ai: false },
    initialHint: anchor ? { text: anchor.text, anchor } : undefined,
  }
})

/**
 * PowerPoint 预览走统一外壳的幻灯片面：引擎画布渲染，目录 / 备注 / 放映 / 查找 / 命中都在外壳里。
 * 引擎打不开时直接退回文字层（pptx-preview 已卸载，不再有中间一档）。
 * 和 xlsx / docx 一样不看 `native` 属性：分享页、应用内预览也该得到同一份体验。
 */
const nativePptxRequest = computed<EditorOpenRequest | null>(() => {
  if (!props.sourceUrl) return null
  const slide = hit.value.slide
  return {
    fileId: props.fileName || 'pptx-preview',
    format: 'pptx',
    source: { kind: 'text', text: '', name: props.fileName || 'deck.pptx', url: props.sourceUrl },
    readonly: true,
    revision: 0,
    permissions: { read: true, write: false, export: false, comment: false, ai: false },
    initialHint: hit.value.text || slide ? { text: hit.value.text, anchor: slide ? { kind: 'slide', slide } : undefined } : undefined,
  }
})

/** 扩展格式的来源：有文本原文就用它（带 Codec 时转成字节让外壳跑 decode）；否则用取回来的原件字节 */
const extSource = computed<EditorSource | null>(() => {
  const found = extFormat.format.value
  if (!found) return null
  const name = props.fileName || `file.${found.ext}`
  if (typeof props.content === 'string' && props.content !== '') return extensionSourceOf(props.content, name, found.hasCodec)
  return extBytes.value ? { kind: 'bytes', bytes: extBytes.value, name } : null
})

watch(
  () => [extFormat.format.value?.ext, props.content, props.sourceUrl, extEpoch.value] as const,
  ([ext, content, url], _old, onCleanup) => {
    if (!ext || (typeof content === 'string' && content !== '') || !url) return
    let stale = false
    onCleanup(() => (stale = true))
    fetchOriginal(url)
      .then((buffer) => {
        if (!stale) extBytes.value = new Uint8Array(buffer)
      })
      .catch((error: Error) => {
        if (!stale) failure.value = `${error.message || '读不到原件'},已改用文字层视图`
      })
  },
  { immediate: true },
)

/**
 * 扩展格式的只读请求：和 PDF / Word 预览一样走统一外壳，没有保存通道、没有写权限。
 * 要编辑走文件页的「编辑」（Browser 里的统一编辑通道），这里不开口子。
 */
const nativeExtRequest = computed<EditorOpenRequest | null>(() => {
  const found = extFormat.format.value
  const source = extSource.value
  if (!found || !source) return null
  return {
    fileId: props.fileName || `ext-preview.${found.ext}`,
    format: found.ext,
    source,
    readonly: true,
    revision: 0,
    permissions: { read: true, write: false, export: false, comment: false, ai: false },
  }
})

// 一知道要在幻灯片面里打开 pptx，就开始下载引擎的 WASM（1.6 MB，冷开的最长一段）：
// 此时幻灯片面和引擎的 JS 还没开始下载，链路是空的；等它们加载完再取，冷开就白白多等几百毫秒。
// 这个小模块不 import 引擎，只管下载与编译；失败吞掉，真正打开时会重新触发并报错。
// 注意要同时判断 kind：nativePptxRequest 只看开关和原件地址，二进制 / 文本等其它文件也会有值，不判断就会给每个文件预览都白下 1.6 MB。
watch(
  () => kind.value === 'pptx' && !!nativePptxRequest.value,
  (wanted) => {
    if (wanted) void import('@/editor/engines/pptxWasm').then((module) => module.prefetchPptxWasm()).catch(() => undefined)
  },
  { immediate: true },
)

/** 阅读视图的格式名归一(老扩展名 / 模板扩展名并入主格式) */
const readerFormat = computed(() => ({ pps: 'ppt', ott: 'odt', otp: 'odp' })[ext.value] ?? ext.value)

interface Plan {
  component: Component
  props: Record<string, unknown>
  /** 渲染失败时能不能退回文字层 / 原始内容 */
  rich: boolean
}

const plan = computed<Plan | null>(() => {
  const url = props.sourceUrl ?? ''
  const name = props.fileName ?? ''
  switch (kind.value) {
    case 'extension':
      // 还在问扩展 / 还在取字节：占位；取不到字节时 failure 会让整块退回文字层
      if (nativeExtRequest.value) {
        return {
          component: Viewers.nativeHost,
          props: { request: nativeExtRequest.value, chromeTitle: false, chromeClose: false, capabilities: { export: false } },
          rich: true,
        }
      }
      return { component: ViewerLoading, props: {}, rich: true }
    case 'pdf':
      if (nativePdfRequest.value) {
        return {
          component: Viewers.nativeHost,
          props: { request: nativePdfRequest.value, chromeTitle: false, chromeClose: false, capabilities: { export: false } },
          rich: true,
        }
      }
      return url ? { component: Viewers.pdf, props: { url, hitText: hit.value.text, hitPage: hit.value.page }, rich: true } : null
    case 'docx':
      if (nativeDocxRequest.value) {
        return {
          component: Viewers.nativeHost,
          props: { request: nativeDocxRequest.value, chromeTitle: false, chromeClose: false, capabilities: { export: false } },
          rich: true,
        }
      }
      return null
    case 'pptx':
      if (nativePptxRequest.value) {
        return {
          component: Viewers.nativeHost,
          props: { request: nativePptxRequest.value, chromeTitle: false, chromeClose: false, capabilities: { export: false } },
          rich: true,
        }
      }
      return null
    case 'sheet':
      // 只读原生网格只接 xlsx；xls / ods 等仍走 SheetViewer（SheetJS 宽格式支持）。
      // 不看 props.native：SheetViewer 遇到大表会被 CSP 拦下解压 Worker 而永远卡住
      if (url && ext.value === 'xlsx') {
        return {
          component: Viewers.nativeSheet,
          props: { url, format: ext.value, name, text: props.content, hitSheet: hit.value.sheet, hitRow: hit.value.row },
          rich: true,
        }
      }
      return url || props.content
        ? { component: Viewers.sheet, props: { url, format: ext.value, text: props.content, hitSheet: hit.value.sheet, hitRow: hit.value.row }, rich: true }
        : null
    case 'legacy-doc':
    case 'legacy-ppt':
    case 'odt':
    case 'odp':
    case 'rtf':
    case 'epub':
    case 'mail':
      return url ? { component: Viewers.reader, props: { url, format: readerFormat.value, hitText: hit.value.text }, rich: true } : null
    case 'html':
      return url ? { component: Viewers.html, props: { url, name, hitText: hit.value.text }, rich: true } : null
    case 'notebook':
      return url ? { component: Viewers.notebook, props: { url, hitText: hit.value.text }, rich: true } : null
    case 'archive':
      return url ? { component: Viewers.archive, props: { url, name }, rich: true } : null
    case 'binary':
      return url ? { component: Viewers.binary, props: { url, name }, rich: true } : null
    case 'markdown':
      if (props.content && !resolved.value) {
        return { component: Viewers.markdown, props: { source: props.content, linkContext: props.linkContext, linkStates: props.linkStates, progressive: true }, rich: true }
      }
      return url ? { component: Viewers.text, props: { url, name, highlightLines: hit.value.lines }, rich: true } : null
    case 'code':
      if (props.content && !resolved.value) {
        return { component: Viewers.code, props: { modelValue: props.content, filename: name, readonly: true, highlightLines: hit.value.lines, ariaLabel: '文件内容(只读)' }, rich: true }
      }
      return url ? { component: Viewers.text, props: { url, name, highlightLines: hit.value.lines }, rich: true } : null
    default:
      return null
  }
})

const needsSniff = computed(() => kind.value === 'sniff' && !!props.sourceUrl && mode.value === 'rendered' && !failure.value)
const showRich = computed(() => !!plan.value && mode.value === 'rendered' && !failure.value && !needsSniff.value)

/** 图片 / 音视频走 DocViewer;嗅探出来的图片没有 rawUrl,用原件地址 */
const inlineUrl = computed(() => props.rawUrl ?? (['image', 'media'].includes(kind.value) ? (props.sourceUrl ?? null) : null))

/** 文字层(检索用的抽取结果)有内容就用它;没有就看原始内容 */
const hasTextLayer = computed(() => props.blocks.length > 0)
const fallbackRaw = computed(() => !hasTextLayer.value && !!props.sourceUrl && !['image', 'media'].includes(kind.value))

function onFail(message: string | Error) {
  failure.value = (typeof message === 'string' ? message : message.message) || '渲染失败'
}
function onResolved(value: Resolved) {
  resolved.value = value
}
function onSniffFailed(message: string) {
  failure.value = message
}
function retry() {
  failure.value = ''
  extBytes.value = null
  extEpoch.value += 1
  mode.value = 'rendered'
  forceBinary.value = false
}
const canSwitch = computed(() => hasTextLayer.value)
</script>

<template>
  <div class="kb-fv" :class="[showRich && plan ? 'is-rich' : 'is-plain', `is-${kind}`]">
    <SniffGate v-if="needsSniff" :url="sourceUrl!" @resolved="onResolved" @failed="onSniffFailed" />

    <component
      :is="plan!.component"
      v-else-if="showRich && plan"
      v-bind="plan.props"
      :key="`${kind}:${sourceUrl}`"
      @error="onFail"
      @binary="forceBinary = true"
      @open-attachment="emit('openAttachment', $event)"
      @open-note="emit('openNote', $event)"
      @link-error="emit('linkError', $event)"
    >
      <template #tools>
        <button v-if="canSwitch" type="button" class="btn sm kb-fv-switch" title="切到检索用的文字层" @click="mode = 'text'">文字层</button>
      </template>
      <!-- 统一外壳的工具栏插槽：幻灯片预览也要有「文字层」入口（旧查看器有，不能少） -->
      <template #toolbar>
        <button v-if="canSwitch && kind === 'pptx'" type="button" class="btn sm kb-fv-switch" title="切到检索用的文字层" @click="mode = 'text'">文字层</button>
      </template>
    </component>

    <template v-else>
      <div v-if="plan || failure" class="kb-fv-strip" :class="{ 'is-warn': !!failure }">
        <span class="m">{{ failure || '正在看检索用的文字层（抽取结果）' }}</span>
        <span class="kb-spacer"></span>
        <button v-if="plan" type="button" class="btn sm" @click="retry">{{ failure ? '重试原貌' : '查看原貌' }}</button>
      </div>
      <DocViewer
        v-if="hasTextLayer || !fallbackRaw"
        :format="format"
        :blocks="blocks"
        :chunks="chunks"
        :highlight="highlight"
        :raw-url="inlineUrl"
        @select="emit('select', $event)"
      />
      <component :is="Viewers.text" v-else :url="sourceUrl!" :name="fileName ?? ''" @binary="forceBinary = true" />
    </template>
  </div>
</template>

<style>
.kb-fv {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 原貌渲染要吃满工作区高度(各查看器自己管滚动) */
.kb-fv.is-rich {
  padding: 12px;
  box-sizing: border-box;
}
.kb-fv-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: var(--hl) solid var(--b);
  border-radius: var(--r2);
  background: var(--surface-1);
}
.kb-fv-strip.is-warn {
  border-color: color-mix(in srgb, var(--status-warning) 45%, transparent);
  background: color-mix(in srgb, var(--status-warning) 8%, var(--surface-1));
}
</style>
