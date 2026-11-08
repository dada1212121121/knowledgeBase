<script setup lang="ts">
// Jupyter 笔记本(.ipynb):Markdown 单元格渲染成文章,代码单元格带语法高亮,输出(文本 / 图片 / HTML / 报错)按原样展示。
// 不执行任何代码。HTML 输出和 Markdown 渲染结果都过 sanitizeDocHtml;图片只认 data: URL。
import MarkdownIt from 'markdown-it'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ViewerLoading from '@/components/ViewerLoading.vue'
import ViewerToolbar from '@/components/ViewerToolbar.vue'
import { fetchOriginal, OriginalError } from '@/utils/fetchOriginal'
import { sanitizeDocHtml } from '@/utils/sanitizeHtml'
import { highlightToHtml } from '@/utils/staticHighlight'
import { decodeBytes } from '@/utils/sniff'

const props = defineProps<{ url: string; hitText?: string }>()
const emit = defineEmits<{ error: [message: string] }>()

interface Output {
  kind: 'text' | 'html' | 'image' | 'error'
  text?: string
  html?: string
  src?: string
  stream?: string
}
interface Cell {
  type: 'markdown' | 'code' | 'raw'
  count: number | null
  html: string
  outputs: Output[]
}

const PAGE = 150
const cells = ref<Cell[]>([])
const language = ref('python')
const shown = ref(PAGE)
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const message = ref('')
let abort: AbortController | null = null

const md = new MarkdownIt({ html: false, linkify: true, breaks: false })
const EXT: Record<string, string> = { python: 'py', r: 'r', julia: 'jl', javascript: 'js', typescript: 'ts', scala: 'scala', rust: 'rs', bash: 'sh', sql: 'sql', ruby: 'rb', go: 'go' }
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

const asText = (value: unknown): string => (Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : '')

function outputsOf(raw: unknown): Output[] {
  if (!Array.isArray(raw)) return []
  const out: Output[] = []
  for (const item of raw as Record<string, unknown>[]) {
    const type = item.output_type
    if (type === 'stream') {
      out.push({ kind: 'text', text: asText(item.text), stream: String(item.name ?? 'stdout') })
    } else if (type === 'error') {
      out.push({ kind: 'error', text: [String(item.ename ?? ''), String(item.evalue ?? ''), asText(item.traceback)].filter(Boolean).join('\n').replace(ANSI, '') })
    } else if (type === 'execute_result' || type === 'display_data') {
      const data = (item.data ?? {}) as Record<string, unknown>
      const png = asText(data['image/png'])
      const jpeg = asText(data['image/jpeg'])
      if (png) out.push({ kind: 'image', src: `data:image/png;base64,${png.replace(/\s+/g, '')}` })
      else if (jpeg) out.push({ kind: 'image', src: `data:image/jpeg;base64,${jpeg.replace(/\s+/g, '')}` })
      else if (data['text/html']) out.push({ kind: 'html', html: sanitizeDocHtml(asText(data['text/html'])) })
      else if (data['text/plain']) out.push({ kind: 'text', text: asText(data['text/plain']).replace(ANSI, ''), stream: 'result' })
    }
  }
  return out
}

async function load() {
  abort?.abort()
  abort = new AbortController()
  phase.value = 'loading'
  try {
    const buffer = await fetchOriginal(props.url, { signal: abort.signal })
    let notebook: { cells?: Record<string, unknown>[]; worksheets?: { cells?: Record<string, unknown>[] }[]; metadata?: Record<string, unknown> }
    try {
      notebook = JSON.parse(decodeBytes(new Uint8Array(buffer)))
    } catch {
      throw new OriginalError('笔记本不是有效的 JSON（文件可能已损坏）')
    }
    const raw = notebook.cells ?? notebook.worksheets?.[0]?.cells
    if (!Array.isArray(raw)) throw new OriginalError('笔记本里没有单元格')
    const info = (notebook.metadata?.language_info ?? notebook.metadata?.kernelspec ?? {}) as Record<string, unknown>
    language.value = String(info.name ?? info.language ?? 'python').toLowerCase()
    const file = `cell.${EXT[language.value] ?? language.value}`
    const out: Cell[] = []
    for (const cell of raw) {
      const type = (cell.cell_type === 'markdown' || cell.cell_type === 'code' ? cell.cell_type : 'raw') as Cell['type']
      const source = asText(cell.source ?? cell.input)
      let html: string
      if (type === 'markdown') html = sanitizeDocHtml(md.render(source))
      else if (type === 'code') html = await highlightToHtml(source, file)
      else html = source.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!)
      out.push({ type, count: typeof cell.execution_count === 'number' ? cell.execution_count : null, html, outputs: outputsOf(cell.outputs) })
    }
    if (!out.length) throw new OriginalError('笔记本是空的')
    cells.value = out
    shown.value = Math.max(PAGE, props.hitText ? out.findIndex((cell) => cell.html.replace(/<[^>]+>/g, '').includes(props.hitText!.slice(0, 20))) + 1 : 0)
    phase.value = 'ready'
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return
    phase.value = 'error'
    message.value = error instanceof Error ? error.message : '笔记本读取失败'
    emit('error', message.value)
  }
}

const visible = computed(() => cells.value.slice(0, shown.value))
onMounted(() => void load())
watch(() => props.url, () => void load())
onBeforeUnmount(() => abort?.abort())
</script>

<template>
  <ViewerLoading v-if="phase === 'loading'" label="正在解析笔记本…" />
  <div v-else-if="phase === 'error'" class="kb-dr-error" role="alert">{{ message }}</div>
  <div v-else class="kb-nb" tabindex="0" aria-label="Jupyter 笔记本">
    <ViewerToolbar aria-label="笔记本工具栏">
      <template #start>
        <span class="tag">{{ language }}</span>
        <span class="m">{{ cells.length }} 个单元格</span>
      </template>
      <template #tools>
        <slot name="tools" />
      </template>
    </ViewerToolbar>
    <div class="kb-nb-cells">
      <section v-for="(cell, at) in visible" :key="at" class="kb-nb-cell" :class="`is-${cell.type}`">
        <!-- eslint-disable vue/no-v-html -- 内容已转义 / 清洗 -->
        <div v-if="cell.type === 'markdown'" class="kb-rd-article kb-nb-md" v-html="cell.html"></div>
        <template v-else>
          <div class="kb-nb-in">
            <span class="mono kb-nb-label">{{ cell.type === 'code' ? `In [${cell.count ?? ' '}]` : 'Raw' }}</span>
            <pre class="kb-nb-code kb-tok mono" v-html="cell.html"></pre>
          </div>
          <div v-for="(output, index) in cell.outputs" :key="index" class="kb-nb-out">
            <span class="mono kb-nb-label">{{ output.stream === 'result' ? `Out [${cell.count ?? ' '}]` : '' }}</span>
            <pre v-if="output.kind === 'text' || output.kind === 'error'" class="kb-nb-text mono" :class="{ 'is-error': output.kind === 'error', 'is-stderr': output.stream === 'stderr' }">{{ output.text }}</pre>
            <img v-else-if="output.kind === 'image'" class="kb-nb-img" :src="output.src" alt="输出图片" />
            <div v-else class="kb-rd-article kb-nb-html" v-html="output.html"></div>
          </div>
        </template>
        <!-- eslint-enable vue/no-v-html -->
      </section>
      <button v-if="shown < cells.length" type="button" class="btn sm kb-nb-more" @click="shown += PAGE">再显示 {{ Math.min(PAGE, cells.length - shown) }} 个（共 {{ cells.length }}）</button>
    </div>
  </div>
</template>

<style>
.kb-nb {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  background: var(--surface-1);
  overflow: hidden;
  outline: none;
}
.kb-nb-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: var(--hl) solid var(--b);
}
.kb-nb-cells {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.kb-nb-cell {
  min-width: 0;
}
.kb-nb-md {
  max-width: none;
  margin: 0;
}
.kb-nb-in,
.kb-nb-out {
  display: flex;
  gap: 10px;
  min-width: 0;
}
.kb-nb-label {
  flex: none;
  width: 6.5em;
  padding-top: 8px;
  text-align: right;
  color: var(--m);
  font-size: calc(11px * var(--fs));
}
.kb-nb-code,
.kb-nb-text {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 8px 12px;
  overflow: auto;
  background: var(--surface-sunken);
  border: var(--hl) solid var(--b);
  border-radius: var(--r1);
  font-size: calc(13px * var(--fs));
  line-height: 1.6;
  white-space: pre;
}
.kb-nb-out {
  margin-top: 4px;
}
.kb-nb-text {
  background: transparent;
  border-color: transparent;
}
.kb-nb-text.is-error {
  color: var(--status-danger-text, var(--r));
  background: color-mix(in srgb, var(--status-danger, var(--r)) 8%, transparent);
}
.kb-nb-text.is-stderr {
  background: color-mix(in srgb, var(--status-warning) 8%, transparent);
}
.kb-nb-img {
  max-width: 100%;
  height: auto;
  background: #fff; /* tokens-allow: 图表输出按白底画的 */
  border-radius: var(--r1);
}
.kb-nb-html {
  flex: 1;
  min-width: 0;
  max-width: none;
  margin: 0;
  overflow: auto;
}
.kb-nb-more {
  align-self: center;
}
@media (max-width: 520px) {
  .kb-nb-in,
  .kb-nb-out {
    flex-direction: column;
    gap: 2px;
  }
  .kb-nb-label {
    width: auto;
    padding-top: 0;
    text-align: left;
  }
}
</style>
