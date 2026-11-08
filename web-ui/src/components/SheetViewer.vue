<script setup lang="ts">
// 表格查看器:xlsx / xls / ods 等(SheetJS)/ csv / tsv → 虚拟滚动网格。
//   - 只渲染可见行(几十万行也不卡),行号列与表头粘住,列宽按内容估算;
//   - 多工作表:底部页签(像 Excel);「首行当表头」可开关(默认猜);
//   - 筛选框:只显示包含关键词的行(行号仍是原行号);点单元格,上方「编辑栏」显示完整内容(手机上单元格被截断时靠它);
//   - 命中联动:`hitSheet` + `hitRow` 切到工作表并滚到那一行、高亮。
// xls / ods 等老格式没有可靠的浏览器端解析器:由外层退回文字层视图。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { fetchOriginal, OriginalError } from '@/utils/fetchOriginal'
import { parseTableAsync } from '@/utils/csvParseAsync'
import { cellValue, rowFieldCount, type CsvTable } from '@/utils/csvText'
import {
  cellText,
  columnLetter,
  columnWidths,
  decodeText,
  looksLikeHeader,
  maxColumns,
} from '@/utils/tabular'

/**
 * 一张表的行：只暴露「有几行」和「取第 i 行」。
 * CSV / TSV 走紧凑解析（类型数组记每个字段的起止位置，值用到时才从原文切出来），5 万行的表同时只会真的取出屏幕上那几十行的文字；
 * 以前整份解析成 `string[][]`（40 万个字符串），5 MB 的表是 600 ms 的长任务。SheetJS 读出来的 xlsx / xls / ods 本来就是数组。
 */
interface RowSource {
  length: number
  at(index: number): string[]
}

interface Sheet {
  name: string
  rows: RowSource
  columns: number
  widths: number[]
  truncated: boolean
}

const arrayRows = (rows: string[][]): RowSource => ({ length: rows.length, at: (index) => rows[index] ?? [] })
/** 紧凑表的行视图：第 i 行的各个字段按需从原文里切出来 */
function tableRows(table: CsvTable, length: number): RowSource {
  return {
    length,
    at: (index) => {
      const count = rowFieldCount(table, index)
      const out = new Array<string>(count)
      for (let col = 0; col < count; col += 1) out[col] = cellValue(table, index, col)
      return out
    },
  }
}

const props = defineProps<{
  url: string
  /** xlsx | csv | tsv | xls | xlsb | xlsm | ods | numbers */
  format: string
  /** 文本类格式的原文(有就不用再拉一遍原件) */
  text?: string | null
  hitSheet?: string | null
  hitRow?: number | null
}>()
const emit = defineEmits<{ ready: [sheets: number]; error: [message: string] }>()

const MAX_ROWS = 200_000
/**
 * 这些格式走 SheetJS(csv / tsv 自己解析)。
 * xlsx 以前走 read-excel-file:它的解压(fflate 异步 unzip)和解析都会起 `blob:` Worker,
 * 生产 CSP 只放行同源脚本(`script-src 'self'`),解压后超过 512 KB 的工作表就被拦下、
 * 页面永远停在「正在解析表格…」(真实语料 35 份里 5 份)。SheetJS 全程同步、不起 Worker。
 * xlsx 预览默认是原生网格,这里只剩 xls / ods 等老格式与原生网格打不开时的回退会用到。
 */
const SHEETJS_FORMATS = new Set(['xlsx', 'xls', 'xlsb', 'xlsm', 'ods', 'fods', 'numbers'])
const MAX_COLUMNS = 500
const NUMBER_W = 56
const LETTER_H = 22
const OVERSCAN = 8

const scroller = ref<HTMLElement | null>(null)
/** 也写在根节点的 data-state 上：基线脚本据此确定长任务观测窗口的终点 */
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const progress = ref(0)
const sheets = shallowRef<Sheet[]>([])
const active = ref(0)
const useHeader = ref(true)
const filter = ref('')
const selected = ref<{ row: number; col: number } | null>(null)
const scrollTop = ref(0)
const viewportH = ref(400)
const rowH = ref(32)

const sheet = computed(() => sheets.value[active.value] ?? null)
const headerOn = computed(() => useHeader.value && !!sheet.value && sheet.value.rows.length > 1)
const headerRow = computed(() => (headerOn.value ? sheet.value!.rows.at(0) : null))
const headH = computed(() => LETTER_H + (headerOn.value ? rowH.value : 0))
/** 数据行的起点(源数组下标) */
const bodyStart = computed(() => (headerOn.value ? 1 : 0))
const totalW = computed(() => NUMBER_W + (sheet.value?.widths.reduce((sum, width) => sum + width, 0) ?? 0))

/** 筛选后的源行下标;没筛选时为 null(用恒等映射,不生成大数组) */
const matchedRows = computed<number[] | null>(() => {
  const query = filter.value.trim().toLowerCase()
  const current = sheet.value
  if (!query || !current) return null
  const out: number[] = []
  for (let at = bodyStart.value; at < current.rows.length; at += 1) {
    if (current.rows.at(at).some((cell) => cell.toLowerCase().includes(query))) out.push(at)
  }
  return out
})
const rowCount = computed(() => matchedRows.value?.length ?? Math.max(0, (sheet.value?.rows.length ?? 0) - bodyStart.value))
const sourceIndex = (viewIndex: number) => matchedRows.value?.[viewIndex] ?? bodyStart.value + viewIndex

const range = computed(() => {
  const first = Math.max(0, Math.floor(scrollTop.value / rowH.value) - OVERSCAN)
  const last = Math.min(rowCount.value, Math.ceil((scrollTop.value + viewportH.value) / rowH.value) + OVERSCAN)
  return { first, last }
})
const visible = computed(() => {
  const out: { view: number; source: number; cells: string[] }[] = []
  const rows = sheet.value?.rows
  for (let view = range.value.first; view < range.value.last; view += 1) {
    const source = sourceIndex(view)
    out.push({ view, source, cells: rows && source < rows.length ? rows.at(source) : [] })
  }
  return out
})
const bodyTop = computed(() => headH.value + range.value.first * rowH.value)
const canvasH = computed(() => headH.value + rowCount.value * rowH.value)

const columnsView = computed(() => {
  const current = sheet.value
  if (!current) return []
  let left = NUMBER_W
  return current.widths.map((width, index) => {
    const out = { index, width, left, letter: columnLetter(index) }
    left += width
    return out
  })
})

const hitView = computed(() => {
  if (!props.hitRow || !sheet.value) return -1
  const source = props.hitRow - 1
  if (headerOn.value && source === 0) return -1
  if (matchedRows.value) return matchedRows.value.indexOf(source)
  return source - bodyStart.value
})
const selectedText = computed(() => {
  const at = selected.value
  if (!at || !sheet.value) return ''
  return sheet.value.rows.at(at.row)[at.col] ?? ''
})
const selectedLabel = computed(() => (selected.value ? `${columnLetter(selected.value.col)}${selected.value.row + 1}` : ''))
const countLabel = computed(() => {
  const current = sheet.value
  if (!current) return ''
  const rows = rowCount.value
  return `${rows.toLocaleString()}${filter.value.trim() ? ` / ${Math.max(0, current.rows.length - bodyStart.value).toLocaleString()}` : ''} 行 × ${current.columns} 列`
})

/** SheetJS 读出来的数组表 */
function build(name: string, rows: string[][]): Sheet {
  const truncated = rows.length > MAX_ROWS
  const kept = truncated ? rows.slice(0, MAX_ROWS) : rows
  const columns = Math.min(MAX_COLUMNS, maxColumns(kept))
  return { name, rows: arrayRows(kept), columns, widths: columnWidths(kept, columns), truncated }
}

/** CSV / TSV 的紧凑表：列宽只看前 200 行（和数组表同一口径），不会把整表取成字符串 */
function buildFromTable(table: CsvTable): Sheet {
  const total = table.rows.length
  const truncated = total > MAX_ROWS
  const rows = tableRows(table, truncated ? MAX_ROWS : total)
  const sample: string[][] = []
  for (let at = 0; at < Math.min(rows.length, 500); at += 1) sample.push(rows.at(at))
  const columns = Math.min(MAX_COLUMNS, maxColumns(sample))
  return { name: '', rows, columns, widths: columnWidths(sample, columns), truncated }
}

let abort: AbortController | null = null
let disposed = false

async function load() {
  disposed = false
  abort?.abort()
  abort = new AbortController()
  phase.value = 'loading'
  progress.value = 0
  selected.value = null
  filter.value = ''
  try {
    const kind = props.format.toLowerCase()
    let out: Sheet[]
    if (SHEETJS_FORMATS.has(kind)) {
      // xlsx / xls / xlsb / xlsm / ods / numbers:交给 SheetJS(按需加载,~400 kB,同步解析不起 Worker)
      const [XLSX, buffer] = await Promise.all([
        import('@e965/xlsx'),
        fetchOriginal(props.url, { signal: abort.signal, onProgress: (done, total) => (progress.value = total ? done / total : 0) }),
      ])
      if (disposed) return
      let workbook
      try {
        workbook = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true, sheetRows: MAX_ROWS + 1 })
      } catch {
        throw new OriginalError('这份表格无法解析(可能已损坏或有密码)')
      }
      out = workbook.SheetNames.map((name) => {
        const sheet = workbook.Sheets[name]!
        const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: false }) as unknown[][]
        return build(name, rows.map((row) => row.map((cell) => cellText(cell))))
      })
    } else {
      let text = props.text ?? null
      if (text === null || text === '') {
        const buffer = await fetchOriginal(props.url, { signal: abort.signal, onProgress: (done, total) => (progress.value = total ? done / total : 0) })
        text = decodeText(buffer)
      }
      // 大表在 Worker 里解析（同源模块 Worker，不是 blob:），主线程只等结果；分隔符 / 引号 / 空行规则与表格编辑同一套
      const table = await parseTableAsync(text, kind === 'tsv')
      if (disposed) return
      out = [buildFromTable(table)]
    }
    if (disposed) return
    if (!out.length || out.every((item) => item.rows.length === 0)) {
      fail('表格是空的')
      return
    }
    sheets.value = out
    active.value = Math.max(0, out.findIndex((item) => item.name === props.hitSheet))
    useHeader.value = looksLikeHeader(out[active.value]?.rows.at(0))
    phase.value = 'ready'
    emit('ready', out.length)
    await nextTick()
    measure()
    jumpToHit()
  } catch (error) {
    if (disposed || (error as Error)?.name === 'AbortError') return
    fail(error instanceof OriginalError ? error.message : '这份表格解析失败(可能已损坏、加密或格式过旧)')
  }
}
function fail(message: string) {
  phase.value = 'error'
  errorMessage.value = message
  emit('error', message)
}

function measure() {
  const element = scroller.value
  if (!element) return
  viewportH.value = element.clientHeight
  const px = Number.parseFloat(getComputedStyle(element).getPropertyValue('--row-h'))
  if (Number.isFinite(px) && px > 0) rowH.value = px
}

let frame = 0
function onScroll() {
  if (frame) return
  frame = window.requestAnimationFrame(() => {
    frame = 0
    if (scroller.value) scrollTop.value = scroller.value.scrollTop
  })
}

function jumpToHit() {
  const element = scroller.value
  if (!element || hitView.value < 0) return
  const top = hitView.value * rowH.value
  element.scrollTop = Math.max(0, top - element.clientHeight / 2 + rowH.value)
  scrollTop.value = element.scrollTop
}

function pickSheet(index: number) {
  active.value = index
  filter.value = ''
  selected.value = null
  useHeader.value = looksLikeHeader(sheets.value[index]?.rows.at(0))
  if (scroller.value) scroller.value.scrollTo({ top: 0, left: 0 })
  scrollTop.value = 0
}
function select(source: number, col: number) {
  selected.value = { row: source, col }
}

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  void load()
  if (scroller.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(scroller.value)
  }
})
onBeforeUnmount(() => {
  disposed = true
  abort?.abort()
  resizeObserver?.disconnect()
  if (frame) window.cancelAnimationFrame(frame)
})
watch(() => props.url, () => void load())
watch([() => props.hitSheet, () => props.hitRow], () => {
  const target = sheets.value.findIndex((item) => item.name === props.hitSheet)
  if (target >= 0 && target !== active.value) pickSheet(target)
  void nextTick(jumpToHit)
})
watch([filter, useHeader], () => {
  if (scroller.value) scroller.value.scrollTop = 0
  scrollTop.value = 0
})
</script>

<template>
  <div class="kb-sg" :data-state="phase">
    <div class="kb-sg-bar" role="toolbar" aria-label="表格工具栏">
      <label class="kb-sg-check" :class="{ 'is-off': !sheet || sheet.rows.length < 2 }">
        <input v-model="useHeader" type="checkbox" :disabled="!sheet || sheet.rows.length < 2" />
        <span>首行表头</span>
      </label>
      <input v-model="filter" class="kb-sg-filter" type="search" placeholder="筛选行…" aria-label="筛选行" :disabled="phase !== 'ready'" />
      <span class="mono kb-sg-count">{{ countLabel }}</span>
      <span class="kb-spacer"></span>
      <slot name="tools" />
    </div>
    <div v-if="selected" class="kb-sg-fx">
      <span class="mono kb-sg-fx-ref">{{ selectedLabel }}</span>
      <span class="kb-sg-fx-text">{{ selectedText || '（空）' }}</span>
    </div>

    <div ref="scroller" class="kb-sg-scroll" tabindex="0" aria-label="表格内容" :style="{ '--sg-row-h': `${rowH}px` }" @scroll.passive="onScroll">
      <div v-if="sheet" class="kb-sg-canvas" :style="{ width: `${totalW}px`, height: `${canvasH}px` }">
        <div class="kb-sg-head" :style="{ width: `${totalW}px` }">
          <div class="kb-sg-letters">
            <div class="kb-sg-corner" :style="{ width: `${NUMBER_W}px` }"></div>
            <div v-for="column in columnsView" :key="column.index" class="kb-sg-letter" :style="{ width: `${column.width}px` }">{{ column.letter }}</div>
          </div>
          <div v-if="headerRow" class="kb-sg-labels">
            <div class="kb-sg-corner kb-sg-no" :style="{ width: `${NUMBER_W}px` }">1</div>
            <div v-for="column in columnsView" :key="column.index" class="kb-sg-label" :style="{ width: `${column.width}px` }" :title="headerRow[column.index]">{{ headerRow[column.index] ?? '' }}</div>
          </div>
        </div>
        <div class="kb-sg-body" :style="{ top: `${bodyTop}px`, width: `${totalW}px` }">
          <div v-for="row in visible" :key="row.source" class="kb-sg-row" :class="{ 'is-hit': row.view === hitView, 'is-odd': row.view % 2 === 1 }">
            <div class="kb-sg-no" :style="{ width: `${NUMBER_W}px` }">{{ row.source + 1 }}</div>
            <div
              v-for="column in columnsView"
              :key="column.index"
              class="kb-sg-cell"
              :class="{ 'is-selected': selected?.row === row.source && selected?.col === column.index }"
              :style="{ width: `${column.width}px` }"
              @click="select(row.source, column.index)"
            >{{ row.cells[column.index] ?? '' }}</div>
          </div>
        </div>
        <div v-if="!rowCount" class="kb-sg-none" :style="{ top: `${headH + 8}px` }">没有包含「{{ filter }}」的行</div>
      </div>
    </div>

    <div v-if="sheets.length > 1" class="kb-sg-tabs" role="tablist" aria-label="工作表">
      <button v-for="(item, at) in sheets" :key="at" type="button" role="tab" class="kb-sg-tab" :class="{ 'is-on': at === active }" :aria-selected="at === active" @click="pickSheet(at)">
        {{ item.name || `表 ${at + 1}` }}
      </button>
    </div>
    <div v-if="sheet?.truncated" class="kb-sg-note">只显示前 {{ MAX_ROWS.toLocaleString() }} 行（完整内容请下载原件）</div>

    <div v-if="phase === 'loading'" class="kb-sg-state" role="status">
      <div class="kb-sg-progress"><i :style="{ width: `${Math.max(6, Math.round(progress * 100))}%` }"></i></div>
      <span class="m">正在解析表格…</span>
    </div>
    <div v-else-if="phase === 'error'" class="kb-sg-state" role="alert"><span>{{ errorMessage }}</span></div>
  </div>
</template>

<style>
.kb-sg {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--surface-1);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  overflow: hidden;
}
.kb-sg-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  background: var(--surface-1);
  border-bottom: var(--hl) solid var(--b);
  overflow-x: auto;
  scrollbar-width: none;
}
.kb-sg-bar::-webkit-scrollbar {
  display: none;
}
.kb-sg-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  color: var(--t2);
  font-size: calc(12px * var(--fs));
  white-space: nowrap;
  cursor: pointer;
}
.kb-sg-check.is-off {
  opacity: 0.5;
  cursor: not-allowed;
}
.kb-sg-filter {
  flex: 1 1 120px;
  min-width: 96px;
  max-width: 260px;
  height: var(--ctl-h);
  padding: 0 8px;
  color: var(--t);
  background: var(--input-bg);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r1);
}
.kb-sg-filter:focus {
  outline: none;
  border-color: var(--ac);
}
.kb-sg-count {
  flex: none;
  color: var(--m);
  font-size: calc(12px * var(--fs));
  white-space: nowrap;
}
.kb-sg-fx {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 5px 10px;
  max-height: 84px;
  overflow: auto;
  background: var(--surface-2);
  border-bottom: var(--hl) solid var(--b);
  font-size: calc(13px * var(--fs));
}
.kb-sg-fx-ref {
  flex: none;
  color: var(--ac2);
}
.kb-sg-fx-text {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.kb-sg-scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  outline: none;
  font-size: calc(13px * var(--fs));
}
.kb-sg-canvas {
  position: relative;
}
.kb-sg-head {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--surface-2);
}
.kb-sg-letters,
.kb-sg-labels,
.kb-sg-row {
  display: flex;
}
.kb-sg-letters {
  height: 22px;
  border-bottom: var(--hl) solid var(--b);
}
.kb-sg-letter {
  flex: none;
  display: grid;
  place-items: center;
  color: var(--m);
  font-size: calc(11px * var(--fs));
  border-right: var(--hl) solid var(--b);
}
.kb-sg-labels {
  height: var(--sg-row-h);
  border-bottom: var(--hl) solid var(--b2);
}
.kb-sg-label {
  flex: none;
  padding: 0 10px;
  display: flex;
  align-items: center;
  color: var(--t);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-right: var(--hl) solid var(--b);
}
.kb-sg-corner,
.kb-sg-no {
  position: sticky;
  left: 0;
  z-index: 2;
  flex: none;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  color: var(--m);
  background: var(--surface-2);
  border-right: var(--hl) solid var(--b2);
  font-family: var(--mono);
  font-size: calc(11px * var(--fs));
}
.kb-sg-body {
  position: absolute;
  left: 0;
}
.kb-sg-row {
  height: var(--sg-row-h);
  border-bottom: var(--hl) solid var(--b);
}
.kb-sg-row.is-odd {
  background: color-mix(in srgb, var(--surface-2) 45%, transparent);
}
.kb-sg-row.is-hit {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  box-shadow: inset 2px 0 0 var(--accent);
}
.kb-sg-row.is-hit .kb-sg-no {
  color: var(--ac2);
}
.kb-sg-cell {
  flex: none;
  box-sizing: border-box;
  padding: 0 10px;
  display: flex;
  align-items: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-right: var(--hl) solid var(--b);
  cursor: cell;
}
.kb-sg-cell.is-selected {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: var(--accent-soft);
}
.kb-sg-none {
  position: absolute;
  left: 0;
  right: 0;
  padding: 24px;
  text-align: center;
  color: var(--m);
}
.kb-sg-tabs {
  display: flex;
  gap: 2px;
  padding: 4px 6px 0;
  overflow-x: auto;
  scrollbar-width: none;
  background: var(--surface-2);
  border-top: var(--hl) solid var(--b2);
}
.kb-sg-tabs::-webkit-scrollbar {
  display: none;
}
.kb-sg-tab {
  flex: none;
  max-width: 220px;
  height: var(--ctl-h);
  padding: 0 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--m);
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  font-size: calc(12px * var(--fs));
}
.kb-sg-tab:hover {
  color: var(--t);
}
.kb-sg-tab.is-on {
  color: var(--t);
  font-weight: 600;
  border-bottom-color: var(--accent);
}
.kb-sg-note {
  padding: 4px 10px;
  color: var(--status-warning-text, var(--y));
  background: var(--surface-2);
  border-top: var(--hl) solid var(--b);
  font-size: calc(12px * var(--fs));
}
.kb-sg-state {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  background: var(--surface-1);
}
.kb-sg-progress {
  width: min(240px, 60%);
  height: 4px;
  background: var(--chart-track);
  border-radius: var(--r-pill);
  overflow: hidden;
}
.kb-sg-progress i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width var(--dur-base) var(--ease-out);
}
@media (pointer: coarse) {
  .kb-sg-filter {
    min-height: 36px;
    font-size: calc(16px * var(--fs));
  }
  /* 页签是一整排紧挨着的,不能靠伪元素外扩(会盖住邻居),直接加高到 44px;复选框本体只有 22px,可点区域是外面的 label */
  .kb-sg-tab {
    min-height: 44px;
  }
  .kb-sg-check {
    min-height: 44px;
  }
}
@media (max-width: 520px) {
  .kb-sg-count {
    display: none;
  }
}
</style>
