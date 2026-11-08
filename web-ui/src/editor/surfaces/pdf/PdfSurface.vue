<script setup lang="ts">
/**
 * PDF Surface 视图层
 *
 * 渲染、文字层、虚拟化、缩放全部复用 `components/PdfViewer.vue`；这里只负责：
 *  - 把 PDF 的「页码 + rect」选区翻译成 Anchor 事件；
 *  - 把 Host 查找栏的 find/next/prev 转给 pdf.js；
 *  - 暴露跳页 / 缩放 / 锚点恢复给命令层。
 * PDF 永远只读：不提供编辑、保存、撤销，避免了「看起来能改、其实写不回去」的假编辑入口。
 */
import { ref } from 'vue'
import PdfViewer from '@/components/PdfViewer.vue'

const props = withDefaults(
  defineProps<{
    url: string
    hitText?: string
    hitPage?: number | null
  }>(),
  { hitText: '', hitPage: null },
)

const emit = defineEmits<{
  ready: [pages: number]
  error: [message: string]
  page: [page: number]
  selection: [payload: { anchor: { kind: 'pdf'; page: number; rect: { x: number; y: number; width: number; height: number } }; text: string; isEmpty: boolean }]
}>()

const viewer = ref<InstanceType<typeof PdfViewer> | null>(null)

function emitSelection() {
  const info = viewer.value?.selectionInfo()
  if (info) emit('selection', info)
}
function focus() {
  const root = document.querySelector('.kb-pdf-surface .kb-pv-container') as HTMLElement | null
  root?.focus()
}

defineExpose({
  find: (query: string) => viewer.value?.find(query) ?? Promise.resolve({ total: 0, index: -1 }),
  findStep: (previous = false) => viewer.value?.findStep(previous) ?? Promise.resolve({ total: 0, index: -1 }),
  clearFind: () => viewer.value?.clearFind(),
  getFindState: () => viewer.value?.getFindState() ?? { query: '', total: 0, index: -1 },
  selectAnchor: (anchor: { kind: 'pdf'; page: number; rect?: { x: number; y: number; width: number; height: number } }) =>
    viewer.value?.selectAnchor(anchor) ?? false,
  goTo: (page: number) => viewer.value?.goTo(page),
  getPage: () => viewer.value?.getPage() ?? 1,
  getPages: () => viewer.value?.getPages() ?? 0,
  zoomBy: (factor: number) => viewer.value?.zoomBy(factor),
  fit: () => viewer.value?.fit(),
  focus,
})
</script>

<template>
  <div class="kb-pdf-surface" data-testid="pdf-surface" @mouseup="emitSelection" @keyup="emitSelection">
    <PdfViewer
      ref="viewer"
      :url="url"
      :hit-text="hitText"
      :hit-page="hitPage"
      hide-find
      @ready="emit('ready', $event)"
      @error="emit('error', $event)"
      @page="emit('page', $event)"
    />
  </div>
</template>

<style>
.kb-pdf-surface {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.kb-pdf-surface .kb-pv {
  border: 0;
  border-radius: 0;
}
</style>
