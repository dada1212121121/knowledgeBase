<script setup lang="ts">
// KbDocPreview:按格式渲染一个文件的结构化预览。
//
// 只组合 kb-ui 组件与 token 工具类,不硬编码任何颜色 / 字号 / 圆角。
// 位置(anchor)来自后端 `file_preview`:
// - pdf   → 页码(p.N)
// - sheet → 工作表 + 单元格(Sheet1!R3)
// - slide → 幻灯片页码
// - media → 时间段(mm:ss)
// - 其它  → 行号
//
// `highlight` 传命中的块 id,预览里对应的块会高亮(搜索 ↔ 预览双向联动)。
import { computed } from 'vue'
import KbBadge from './KbBadge.vue'
import KbEmpty from './KbEmpty.vue'

/** 位置锚点(与后端 `Anchor` 的 JSON 结构一致)。 */
export interface PreviewAnchor {
  kind: 'line' | 'page' | 'cell' | 'slide' | 'time'
  start?: number
  end?: number
  page?: number
  sheet?: string
  cell?: string
  slide?: number
  start_ms?: number
  end_ms?: number
}

/** 结构化块。 */
export interface PreviewBlock {
  anchor: PreviewAnchor | null
  kind: 'heading' | 'paragraph' | 'table' | 'code' | 'image' | 'media'
  text: string
}

/** 落库的块(带 id,供联动高亮)。 */
export interface PreviewChunk {
  id: string
  ordinal: number
  anchor: PreviewAnchor | null
  start_line: number | null
  end_line: number | null
  title: string | null
  text: string
}

const props = withDefaults(
  defineProps<{
    format: string
    blocks: PreviewBlock[]
    chunks?: PreviewChunk[]
    /** 命中的块 id(高亮用)。 */
    highlight?: string | null
    /** 是否显示落库块列表(默认显示)。 */
    showChunks?: boolean
  }>(),
  { chunks: () => [], highlight: null, showChunks: true },
)

const emit = defineEmits<{ (event: 'select', chunk: PreviewChunk): void }>()

/** 位置文字(页 / 单元格 / 幻灯片 / 时间)。 */
function anchorLabel(anchor: PreviewAnchor | null): string {
  if (!anchor) return ''
  switch (anchor.kind) {
    case 'page':
      return `p.${anchor.page ?? 1}`
    case 'cell':
      return `${anchor.sheet ?? ''}!${anchor.cell ?? ''}`
    case 'slide':
      return `第 ${anchor.slide ?? 1} 页`
    case 'time':
      return `${clock(anchor.start_ms ?? 0)}–${clock(anchor.end_ms ?? 0)}`
    case 'line':
      return `L${anchor.start ?? 1}${anchor.end && anchor.end !== anchor.start ? `-${anchor.end}` : ''}`
    default:
      return ''
  }
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const minutes = String(Math.floor(total / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

/** pdf / slide / image / media 用“分组视图”,表格类用表格视图,其余用块列表。 */
const mode = computed(() => {
  const format = props.format.toLowerCase()
  if (['pdf'].includes(format)) return 'paged'
  if (['pptx', 'ppt'].includes(format)) return 'paged'
  if (['xlsx', 'xls', 'csv', 'tsv'].includes(format)) return 'sheet'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'].includes(format)) return 'image'
  if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'mp4', 'mov', 'mkv', 'webm', 'avi'].includes(format))
    return 'media'
  return 'blocks'
})

/** 按 anchor 分组(paged / sheet 用)。 */
const groups = computed(() => {
  const buckets = new Map<string, { label: string; blocks: PreviewBlock[] }>()
  for (const block of props.blocks) {
    const label = anchorLabel(block.anchor) || '正文'
    const bucket = buckets.get(label) ?? { label, blocks: [] }
    bucket.blocks.push(block)
    buckets.set(label, bucket)
  }
  return [...buckets.values()]
})

/** 表格块解析成行列(块文本用 ` | ` 分隔)。 */
function tableRows(text: string): string[][] {
  return text
    .split('\n')
    .map((line) => line.split(' | ').map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean))
}

const isEmpty = computed(() => props.blocks.length === 0 && props.chunks.length === 0)
</script>

<template>
  <div class="kb-stack">
    <KbEmpty v-if="isEmpty" icon="doc" title="没有可预览的内容" description="这个文件没有抽取结果或还没索引" />

    <template v-else>
      <!-- PDF / 幻灯片:按页分组 -->
      <div v-if="mode === 'paged'" class="kb-stack">
        <div v-for="group in groups" :key="group.label" class="kb-card kb-stack kb-stack-tight">
          <div class="kb-row">
            <KbBadge tone="accent">{{ group.label }}</KbBadge>
            <span class="kb-spacer kb-hint">{{ group.blocks.length }} 块</span>
          </div>
          <p v-for="(block, index) in group.blocks" :key="index" class="kb-preview-text">
            {{ block.text }}
          </p>
        </div>
      </div>

      <!-- 表格:多表 + 行列 -->
      <div v-else-if="mode === 'sheet'" class="kb-stack">
        <div v-for="group in groups" :key="group.label" class="kb-card kb-stack kb-stack-tight">
          <KbBadge tone="accent">{{ group.label }}</KbBadge>
          <table v-for="(block, index) in group.blocks" :key="index" class="kb-preview-table">
            <tbody>
              <tr v-for="(row, rowIndex) in tableRows(block.text)" :key="rowIndex">
                <td v-for="(cell, cellIndex) in row" :key="cellIndex" :class="{ 'kb-preview-head': rowIndex === 0 }">
                  {{ cell }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 图片:OCR 文本 -->
      <div v-else-if="mode === 'image'" class="kb-card kb-stack kb-stack-tight">
        <KbBadge tone="warning">OCR 文本</KbBadge>
        <p v-for="(block, index) in blocks" :key="index" class="kb-preview-text">{{ block.text }}</p>
      </div>

      <!-- 音视频:转写时间轴 -->
      <div v-else-if="mode === 'media'" class="kb-card kb-stack kb-stack-tight">
        <KbBadge tone="accent">转写</KbBadge>
        <div v-for="(block, index) in blocks" :key="index" class="kb-row">
          <span class="kb-mono kb-hint">{{ anchorLabel(block.anchor) }}</span>
          <span class="kb-preview-text">{{ block.text }}</span>
        </div>
      </div>

      <!-- 其它:块列表 -->
      <div v-else class="kb-stack">
        <div
          v-for="(block, index) in blocks"
          :key="index"
          class="kb-card kb-stack kb-stack-tight"
        >
          <div class="kb-row">
            <KbBadge tone="neutral">{{ block.kind }}</KbBadge>
            <span class="kb-spacer kb-mono kb-hint">{{ anchorLabel(block.anchor) }}</span>
          </div>
          <p class="kb-preview-text">{{ block.text }}</p>
        </div>
      </div>

      <!-- 落库块列表(与检索结果联动) -->
      <div v-if="showChunks && chunks.length" class="kb-card kb-stack kb-stack-tight">
        <div class="kb-row">
          <span class="kb-hint">索引块</span>
          <span class="kb-spacer kb-mono">{{ chunks.length }}</span>
        </div>
        <button
          v-for="chunk in chunks"
          :key="chunk.id"
          type="button"
          class="kb-preview-chunk"
          :class="{ 'kb-preview-chunk-active': chunk.id === highlight }"
          @click="emit('select', chunk)"
        >
          <span class="kb-mono kb-hint">{{ anchorLabel(chunk.anchor) || `#${chunk.ordinal}` }}</span>
          <span class="kb-preview-text">{{ chunk.text }}</span>
        </button>
      </div>
    </template>
  </div>
</template>
