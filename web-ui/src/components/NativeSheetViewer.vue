<script setup lang="ts">
/**
 * 原生 XLSX 只读预览（默认预览）
 *
 * 文件预览只有「原件 URL」，而原生表格面要读字节。这里负责一次取件，
 * 再挂统一 EditorHost。任何一步失败（网络、引擎、Worker）都自动回退到
 * 旧 `SheetViewer`，保证新路径不会比旧路径更差。
 * FileViewer 通过 `#tools` 插槽塞进来的「文字层」切换按钮两条路径都要带上，
 * 否则换成原生网格后用户就再也回不到检索用的抽取结果。
 */
import { defineAsyncComponent, onBeforeUnmount, shallowRef, watch } from 'vue'
import EditorHost from '@/editor/host/EditorHost.vue'
import type { EditorOpenRequest } from '@/editor/types'

// 旧视图只在原生面打不开时才用到，不让它进原生预览的首屏 chunk
const SheetViewer = defineAsyncComponent(() => import('@/components/SheetViewer.vue'))

const props = withDefaults(
  defineProps<{
    url?: string
    format?: string
    name?: string
    text?: string | null
    hitSheet?: string
    hitRow?: number
  }>(),
  { url: '', format: 'xlsx', name: '', text: null, hitSheet: '', hitRow: undefined },
)

const emit = defineEmits<{ error: [message: string] }>()

const state = shallowRef<'loading' | 'ready' | 'legacy'>('loading')
const request = shallowRef<EditorOpenRequest | null>(null)
let controller: AbortController | null = null

async function load(): Promise<void> {
  if (!props.url) {
    state.value = 'legacy'
    return
  }
  controller?.abort()
  controller = new AbortController()
  state.value = 'loading'
  request.value = null
  try {
    // 与 PDF 的 range 读取不同，XLSX 引擎需要在 Worker 里整本打开；3 MB 以内的一次取件可接受
    const response = await fetch(props.url, { signal: controller.signal, credentials: 'same-origin' })
    if (!response.ok) throw new Error(`读取表格原件失败（HTTP ${response.status}）`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    request.value = {
      fileId: props.name || 'xlsx-preview',
      format: 'xlsx',
      source: { kind: 'bytes', bytes, name: props.name || 'workbook.xlsx' },
      readonly: true,
      revision: 0,
      permissions: { read: true, write: false, export: false, comment: false, ai: false },
      ...(props.hitSheet || typeof props.hitRow === 'number'
        ? {
            initialHint: {
              // 旧预览的 hitRow 是 1 基行号；原生网格只拿得到行，定位到该行 A 列
              anchor: { kind: 'cell', sheet: props.hitSheet, cell: `A${Math.max(1, props.hitRow ?? 1)}` },
            } as const,
          }
        : {}),
    }
    state.value = 'ready'
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') return
    // 新引擎打不开时优先用旧表格视图兜底；旧视图再失败才把错误交给 FileViewer 的文字层
    state.value = 'legacy'
  }
}

// 同一文件的不同检索命中要重新定位，因此 hint 变化也重新取件 / 挂载
watch(
  () => [props.url, props.hitSheet, props.hitRow] as const,
  () => void load(),
  { immediate: true },
)

onBeforeUnmount(() => controller?.abort())

function onLegacyError(message: string | Error): void {
  emit('error', typeof message === 'string' ? message : message.message)
}
</script>

<template>
  <div class="kb-nxs" data-testid="native-sheet">
    <div v-if="state === 'loading'" class="kb-nxs-loading" role="status">正在打开表格…</div>
    <Suspense v-else-if="state === 'ready' && request">
      <EditorHost
        :key="`native-sheet:${name}:${url}`"
        :request="request"
        :chrome-title="false"
        :chrome-close="false"
        :capabilities="{ export: false }"
        @fallback="state = 'legacy'"
        @error="state = 'legacy'"
      >
        <template #toolbar><slot name="tools" /></template>
      </EditorHost>
      <template #fallback><div class="kb-nxs-loading" role="status">正在加载表格组件…</div></template>
    </Suspense>
    <SheetViewer
      v-else
      :url="url"
      :format="format"
      :text="text"
      :hit-sheet="hitSheet"
      :hit-row="hitRow"
      @error="onLegacyError"
    >
      <template #tools><slot name="tools" /></template>
    </SheetViewer>
  </div>
</template>

<style>
.kb-nxs {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.kb-nxs-loading {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  color: var(--text-secondary, #52525b);
  font-size: calc(12px * var(--fs, 1));
}
</style>
