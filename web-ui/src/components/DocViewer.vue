<script setup lang="ts">
// 文件预览(设计稿):按格式把 `file_preview` 的结构化块摆成「文档」的样子。
//   pdf    → 页码 / 缩放 + 缩略图条 + 纸面(这一页的文字层,命中的句子用高亮标出)
//   xlsx   → 工作表页签 + 带行号 / 列字母的表格,命中的行高亮
//   pptx   → 幻灯片缩略图 + 大图(标题 + 要点 + 备注)
//   图片   → 左原件 / 右识别文本(OCR 还没有框坐标,只排文本)
//   音视频 → 播放器 + 波形 + 转写时间轴
//   其它   → 带行号的文本
// 图片与音视频会额外通过 `GET /api/v1/raw` 读**原件**;PDF 的页面图仍然没有渲染引擎,画的是文字层。
// 高亮:传命中的块 id(`highlight`),对应的句子 / 行 / 时间段会被框出来,并自动翻到那一页。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { KbIcon, type PreviewAnchor, type PreviewBlock, type PreviewChunk } from '@kb-ui/index'
import ImageViewer from '@/components/ImageViewer.vue'
import KbWaveform from '@/components/KbWaveform.vue'
import { IMAGE_FORMATS, MEDIA_FORMATS, SHEET_FORMATS, SLIDE_FORMATS } from '@/utils/files'

const props = defineProps<{
  format: string
  blocks: PreviewBlock[]
  chunks: PreviewChunk[]
  highlight: string | null
  /** 原件地址(图片 / 音频内联播放;没有就不显示) */
  rawUrl?: string | null
}>()
const emit = defineEmits<{ select: [chunk: PreviewChunk] }>()

const format = computed(() => props.format.toLowerCase())
/** 原件加载失败就不再显示(避免裂图占位) */
const rawBroken = ref(false)
watch(() => props.rawUrl, () => (rawBroken.value = false))
const isVideo = computed(() => ['mp4', 'webm', 'mov'].includes(format.value))
/** 音频元素(波形点击定位用) */
const audioEl = ref<HTMLAudioElement | null>(null)
/** 当前播放位置(毫秒):波形用它做 aria 与键盘步进的基准 */
const playPosition = ref(0)
// 换文件时位置归零(同一个 <audio> 换 src 时浏览器行为不完全一致,显式复位)
watch(
  () => props.rawUrl,
  () => (playPosition.value = 0),
)
function onTimeUpdate() {
  const element = audioEl.value
  playPosition.value = element ? Math.round(element.currentTime * 1000) : 0
}
/** 是否正在播(自定义播放按钮用;原生 <audio> 控件在深色主题里太扎眼) */
const playing = ref(false)
function togglePlay() {
  const element = audioEl.value
  if (!element) return
  if (element.paused) void startPlayback()
  else element.pause()
}
/** 解码出的真实时长(拿得到就优先用它,转写最后一段不一定是文件结尾) */
const mediaDuration = ref(0)
function onLoaded() {
  const element = audioEl.value
  mediaDuration.value = element && Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : 0
}
/** 转写块里的最后一个时间点(拿不到解码时长时当总长) */
const transcriptEnd = computed(() =>
  props.blocks.reduce((end, block) => Math.max(end, block.anchor?.end_ms ?? 0), 0),
)
function seekTo(ms: number, play = true) {
  const element = audioEl.value
  if (!element) return
  element.currentTime = ms / 1000
  playPosition.value = Math.round(ms)
  if (play) void startPlayback()
}
/** 播放失败(原件 404 / 解码不支持 / 自动播放被拒)要看得见,不能静默 */
const playError = ref('')
async function startPlayback() {
  const element = audioEl.value
  if (!element) return
  try {
    await element.play()
    playError.value = ''
  } catch {
    playError.value = '这段音频播放不了(原件不可读或格式不支持)'
  }
}
const mode = computed<'pdf' | 'sheet' | 'slide' | 'image' | 'media' | 'text'>(() => {
  if (format.value === 'pdf') return 'pdf'
  if (SHEET_FORMATS.has(format.value)) return 'sheet'
  if (SLIDE_FORMATS.has(format.value)) return 'slide'
  if (IMAGE_FORMATS.has(format.value)) return 'image'
  if (MEDIA_FORMATS.has(format.value)) return 'media'
  return 'text'
})

const clock = (ms: number) => {
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const part = (value: number) => String(value).padStart(2, '0')
  return `${hours ? `${part(hours)}:` : ''}${part(Math.floor((total % 3600) / 60))}:${part(total % 60)}`
}

/** 块所在的「页」:pdf=页码,幻灯片=序号,表格=工作表名 */
function pageKey(anchor: PreviewAnchor | null): string {
  if (!anchor) return ''
  if (anchor.kind === 'page') return String(anchor.page ?? 1)
  if (anchor.kind === 'slide') return String(anchor.slide ?? 1)
  if (anchor.kind === 'cell') return anchor.sheet ?? ''
  return ''
}

interface Page {
  key: string
  blocks: PreviewBlock[]
}
const pages = computed<Page[]>(() => {
  const map = new Map<string, Page>()
  for (const block of props.blocks) {
    const key = pageKey(block.anchor)
    const page = map.get(key) ?? { key, blocks: [] }
    page.blocks.push(block)
    map.set(key, page)
  }
  const list = [...map.values()]
  if (mode.value === 'pdf' || mode.value === 'slide') list.sort((left, right) => Number(left.key) - Number(right.key))
  return list
})

/** 命中的块:传进来的 chunk id 对应的落库块 */
const hitChunk = computed(() => props.chunks.find((chunk) => chunk.id === props.highlight) ?? null)

const index = ref(0)
watch(
  () => [props.highlight, pages.value.length],
  () => {
    const anchor = hitChunk.value?.anchor
    if (!anchor) return
    const found = pages.value.findIndex((page) => page.key === pageKey(anchor))
    if (found >= 0) index.value = found
  },
  { immediate: true },
)
watch(
  () => pages.value.length,
  (length) => {
    if (index.value >= length) index.value = Math.max(0, length - 1)
  },
)
const page = computed(() => pages.value[index.value] ?? null)
const lastPage = computed(() => {
  const numbers = pages.value.map((item) => Number(item.key)).filter(Number.isFinite)
  return numbers.length ? Math.max(...numbers) : pages.value.length
})

/** 缩略图条只显示当前页前后各 3 页(和真实阅读器一样);按页码取,不按出现顺序 */
const THUMB_SPAN = 3
const thumbs = computed(() => {
  const current = Number(page.value?.key)
  if (!Number.isFinite(current)) return pages.value.slice(0, THUMB_SPAN * 2 + 1)
  return pages.value.filter((item) => {
    const number = Number(item.key)
    return Number.isFinite(number) && Math.abs(number - current) <= THUMB_SPAN
  })
})

const squash = (text: string) => text.replace(/\s+/g, '')
/**
 * 命中块的比对串:先取前 24 个非空白字符;块跨段落 / 抽取时被截断的话往下退到 16 / 12 / 8,
 * 只要有任何一块包含它就算命中(退到 8 还不行就当没命中,不猜)。
 */
const hitNeedle = computed(() => {
  const hit = hitChunk.value
  if (!hit) return ''
  const text = squash(hit.text)
  for (const size of [24, 16, 12, 8]) {
    const needle = text.slice(0, size)
    if (needle && props.blocks.some((block) => squash(block.text).includes(needle))) return needle
  }
  // 反方向再找一次:命中块开头是短标题 / 短段落时,前缀会跨块,
  // 这时退成「哪个抽取块的文本被命中块包含」,取最长的那个(≥2 字才认)
  const contained = props.blocks
    .map((block) => squash(block.text))
    .filter((value) => value.length >= 2 && text.includes(value))
    .sort((left, right) => right.length - left.length)
  return contained[0] ?? ''
})
function isHit(block: PreviewBlock): boolean {
  return hitNeedle.value !== '' && squash(block.text).includes(hitNeedle.value)
}
const hitLabel = computed(() => {
  const hit = hitChunk.value
  if (!hit || !page.value) return ''
  const position = page.value.blocks.findIndex(isHit)
  const where = mode.value === 'pdf' ? `第 ${page.value.key} 页` : mode.value === 'slide' ? `第 ${page.value.key} 张` : page.value.key
  return `命中 · ${where}${position >= 0 ? ` ¶${position + 1}` : ''}`
})

/** 命中句在段落里的位置:命中句原文能对上就只高亮那一段(对不上就整段高亮) */
interface Part {
  text: string
  hit: boolean
}
function parts(text: string): Part[] {
  if (!isHit({ anchor: null, kind: 'paragraph', text })) return [{ text, hit: false }]
  const needle = (hitChunk.value?.text ?? '').trim()
  const at = needle ? text.indexOf(needle) : -1
  if (at < 0) return [{ text, hit: true }]
  const out: Part[] = []
  if (at > 0) out.push({ text: text.slice(0, at), hit: false })
  out.push({ text: needle, hit: true })
  const rest = text.slice(at + needle.length)
  if (rest) out.push({ text: rest, hit: false })
  return out
}

/* ---------------- PDF:缩略图与缩放 ---------------- */
/** 纸面基准宽度:100% 时 427px,110% 时正好是设计稿的 470px */
const PAPER_BASE = 427
const ZOOMS = [90, 100, 110, 125, 150]
const zoom = ref(110)
const paperWidth = computed(() => Math.round((PAPER_BASE * zoom.value) / 100))
/**
 * 舞台能给的宽度(px):纸面比它宽就会被 CSS 收缩,放大档位也就没效果了。
 * 所以只提供放得下的档位 —— 否则按钮写着 150% 而纸面纹丝不动。
 */
const stageEl = ref<HTMLElement | null>(null)
const stageWidth = ref(0)
let stageObserver: ResizeObserver | null = null
/** 量舞台宽度(挂载后与切换格式时各量一次;ResizeObserver 跟随窗口变化) */
function observeStage() {
  stageObserver?.disconnect()
  stageObserver = null
  const element = stageEl.value
  if (!element || typeof ResizeObserver === 'undefined') return
  stageObserver = new ResizeObserver((entries) => {
    stageWidth.value = Math.round(entries[0]?.contentRect.width ?? 0)
    measureChrome()
  })
  stageObserver.observe(element)
  stageWidth.value = Math.round(element.clientWidth)
  measureChrome()
}
/** 缩略图列宽与舞台 gap 每次量一次(窗口变化时 ResizeObserver 会再调) */
function measureChrome() {
  const element = stageEl.value
  thumbsWidth.value = Math.round(thumbsEl.value?.offsetWidth ?? 0)
  stageGap.value = element ? Math.round(Number.parseFloat(getComputedStyle(element).columnGap) || 0) : 0
}
onMounted(observeStage)
watch(mode, () => void nextTick(observeStage))
onBeforeUnmount(() => stageObserver?.disconnect())
/** 缩略图列宽与舞台间距:从 DOM 读,别把 CSS 里的 70px / 16px 抄进脚本 */
const thumbsEl = ref<HTMLElement | null>(null)
const thumbsWidth = ref(0)
const stageGap = ref(0)
/** 能放下的档位:纸面宽度 ≤ 舞台可用宽度(扣掉缩略图与间距);量不到就全给 */
const zoomOptions = computed(() => {
  const width = stageWidth.value
  if (!width) return ZOOMS
  const available = width - (thumbsWidth.value || 70) - (stageGap.value || 16)
  const fitting = ZOOMS.filter((value) => Math.round((PAPER_BASE * value) / 100) <= available)
  return fitting.length ? fitting : [ZOOMS[0]!]
})
watch(zoomOptions, (options) => {
  if (!options.includes(zoom.value)) zoom.value = options[options.length - 1] ?? 110
})
function cycleZoom() {
  const options = zoomOptions.value
  const at = options.indexOf(zoom.value)
  zoom.value = options[(at + 1) % options.length] ?? 110
}

/** 缩略图上的占位横条:用文字长度决定条数(只是示意,不是真实版面) */
function skeleton(item: Page): number[] {
  const total = item.blocks.reduce((sum, block) => sum + block.text.length, 0)
  const count = Math.max(3, Math.min(6, Math.round(total / 60)))
  const widths = [92, 100, 96, 88, 100, 70]
  return widths.slice(0, count).map((width, row) => (row === count - 1 ? Math.max(60, width - 20) : width))
}

const isHeading = (block: PreviewBlock) => block.kind === 'heading'
const isTable = (block: PreviewBlock) => block.kind === 'table'
const cells = (text: string) =>
  text
    .split('\n')
    .map((line) => line.split(' | ').map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean))

/* ---------------- 表格 ---------------- */
const letter = (column: number) => String.fromCharCode(65 + (column % 26))
const sheetRows = computed(() => (page.value?.blocks ?? []).filter(isTable).flatMap((block) => cells(block.text)))
const sheetHead = computed(() => sheetRows.value[0] ?? [])
const sheetBody = computed(() => sheetRows.value.slice(1))
/** 命中块的行号(锚点形如 R3 / Sheet1!R3) */
const hitRow = computed(() => {
  const cell = hitChunk.value?.anchor?.kind === 'cell' ? (hitChunk.value.anchor.cell ?? '') : ''
  const match = /R(\d+)/i.exec(cell)
  return match ? Number(match[1]) : null
})

/* ---------------- 幻灯片 ---------------- */
/** 备注块由抽取器写成 `备注:…`,单独放进「演讲者备注」卡片 */
const isRemark = (block: PreviewBlock) => block.text.startsWith('备注:')
/** 画布上的一行(可能来自块,也可能是块内按行拆出来的一行) */
interface SlideLine {
  text: string
  block: PreviewBlock
}
/**
 * 幻灯片画布的内容:标题 + 要点 + 备注。
 * 真实 pptx 抽取器**一页只产出一个段落块**(页内文字用 `\n` 分隔),所以没有标题块时按行拆:
 * 第一行当标题、其余行当要点;有标题块时其余块一律进要点(其余标题也不丢)。
 */
const slideParts = computed<{ title: string; titleBlock: PreviewBlock | null; points: SlideLine[]; remark: string }>(() => {
  const blocks = page.value?.blocks ?? []
  const heading = blocks.find(isHeading) ?? null
  const remark = blocks
    .filter(isRemark)
    .map((block) => block.text.replace(/^备注:\s*/, ''))
    .join('\n')
  const body = blocks.filter((block) => block !== heading && !isRemark(block))
  const lines = (block: PreviewBlock) =>
    block.text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  // 没有标题块、且首块是多行的(真实 pptx 一页一个段落):首行当标题、其余行当要点;
  // 后面若还有块,它们的首行也当标题位之外的内容,按行拆开进要点
  if (!heading && body.length >= 1) {
    const first = body[0]!
    const firstLines = lines(first)
    if (firstLines.length > 1) {
      return {
        title: firstLines[0]!,
        titleBlock: first,
        points: [
          ...firstLines.slice(1).map((text) => ({ text, block: first })),
          ...body.slice(1).flatMap((block) => lines(block).map((text) => ({ text, block }))),
        ],
        remark,
      }
    }
  }
  const titleBlock = heading ?? body[0] ?? null
  const points = (heading ? body : body.slice(1)).map((block) => ({ text: block.text, block }))
  return { title: titleBlock?.text ?? '', titleBlock, points, remark }
})

/* ---------------- 音视频 ---------------- */
const transcript = computed(() =>
  props.blocks.map((block) => ({
    block,
    time: block.anchor?.kind === 'time' ? clock(block.anchor.start_ms ?? 0) : '',
    hit: isHit(block),
  })),
)
const mediaTotal = computed(() => {
  const total = mediaDuration.value || transcriptEnd.value
  return total ? clock(total) : ''
})
/** 播放条左侧的时间:未播放时也显示 00:00,不要留空 */
const playClock = computed(() => clock(playPosition.value))

/* ---------------- 其它文本 ---------------- */
const lines = computed(() => props.blocks.flatMap((block) => block.text.split('\n')))

function selectBlock(block: PreviewBlock) {
  const needle = squash(block.text).slice(0, 24)
  const chunk = props.chunks.find((item) => needle && squash(item.text).includes(needle))
  if (chunk) emit('select', chunk)
}
</script>

<template>
  <div class="kb-dv" :class="`is-${mode}`">
    <div v-if="!blocks.length && !(rawUrl && (mode === 'image' || mode === 'media'))" class="kb-dv-empty m">没有可预览的内容(文件还没索引,或抽取结果为空)</div>

    <!-- PDF -->
    <template v-else-if="mode === 'pdf' && page">
      <div class="row kb-dv-bar">
        <button type="button" class="btn sm kb-dv-step" :disabled="index <= 0" aria-label="上一页" @click="index -= 1"><KbIcon name="chevron" :size="12" class="kb-dv-prev" /></button>
        <span class="mono kb-dv-no">第 {{ page.key }} / {{ lastPage }} 页</span>
        <button type="button" class="btn sm kb-dv-step" :disabled="index >= pages.length - 1" aria-label="下一页" @click="index += 1"><KbIcon name="chevron" :size="12" class="kb-dv-next" /></button>
        <button
          v-if="zoomOptions.length > 1"
          type="button"
          class="mono kb-dv-zoom"
          title="切换缩放"
          :aria-label="`当前缩放 ${zoom}%,点击切换`"
          @click="cycleZoom"
        >{{ zoom }}%</button>
        <span class="kb-dv-hit tag ac" :class="{ 'kb-none': !hitLabel }">{{ hitLabel }}</span>
      </div>
      <div ref="stageEl" class="kb-dv-stage">
        <div ref="thumbsEl" class="kb-dv-thumbs" role="tablist" aria-label="页面缩略图">
          <button
            v-for="item in thumbs"
            :key="item.key"
            type="button"
            class="kb-dv-thumb"
            :class="{ 'is-on': item.key === page.key }"
            role="tab"
            :aria-selected="item.key === page.key"
            @click="index = pages.indexOf(item)"
          >
            <span class="kb-dv-mini"><i v-for="(width, row) in skeleton(item)" :key="row" :style="{ width: `${width}%` }"></i></span>
            <span class="mono kb-dv-thumb-no">{{ item.key }}</span>
          </button>
        </div>
        <div class="kb-dv-paper" role="document" :style="{ width: `${paperWidth}px` }">
          <template v-for="(block, at) in page.blocks" :key="at">
            <h3 v-if="isHeading(block)" class="kb-dv-h" :class="{ 'kb-dv-hl': isHit(block) }" @click="selectBlock(block)">{{ block.text }}</h3>
            <table v-else-if="isTable(block)" class="kb-dv-tbl" :class="{ 'kb-dv-hl': isHit(block) }" @click="selectBlock(block)">
              <tbody>
                <tr v-for="(row, r) in cells(block.text)" :key="r"><td v-for="(cell, c) in row" :key="c">{{ cell }}</td></tr>
              </tbody>
            </table>
            <p v-else class="kb-dv-p" @click="selectBlock(block)">
              <span v-for="(part, part_at) in parts(block.text)" :key="part_at" :class="{ 'kb-dv-hl': part.hit }">{{ part.text }}</span>
            </p>
          </template>
        </div>
      </div>
    </template>

    <!-- 表格 -->
    <template v-else-if="mode === 'sheet' && page">
      <div class="row kb-dv-tabs">
        <button v-for="(item, at) in pages" :key="item.key" type="button" class="kb-dv-tab" :class="{ 'is-on': at === index }" @click="index = at">{{ item.key || '表格' }}</button>
        <span class="kb-spacer"></span>
        <span class="m">按「行」切块 · 表头随块写入</span>
      </div>
      <div class="kb-dv-sheet">
        <table class="kb-dv-grid">
          <thead>
            <tr>
              <th class="kb-dv-corner"></th>
              <th v-for="(cell, c) in sheetHead" :key="c">{{ letter(c) }} · {{ cell }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, r) in sheetBody" :key="r" :class="{ 'is-hit': hitRow === r + 1 }">
              <th class="kb-dv-rowno">{{ r + 1 }}</th>
              <td v-for="(cell, c) in row" :key="c" :class="{ mono: c > 0 }">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="hitChunk" class="kb-dv-peek"><span class="m">内容片段预览 · </span><span class="mono">{{ hitChunk.text }}</span></div>
    </template>

    <!-- 幻灯片 -->
    <template v-else-if="mode === 'slide' && page">
      <div class="kb-dv-stage kb-dv-slides">
        <div class="kb-dv-thumbs" role="tablist" aria-label="幻灯片缩略图">
          <button v-for="item in thumbs" :key="item.key" type="button" class="kb-dv-thumb is-slide" :class="{ 'is-on': item.key === page.key }" role="tab" :aria-selected="item.key === page.key" @click="index = pages.indexOf(item)">
            <span class="kb-dv-mini"><i v-for="(width, row) in skeleton(item).slice(0, 3)" :key="row" :style="{ width: `${width}%` }"></i></span>
            <span class="mono kb-dv-thumb-no">{{ item.key }}</span>
          </button>
        </div>
        <div class="kb-dv-slidecol">
          <div class="kb-dv-slide">
            <div class="mono kb-dv-eyebrow">{{ format.toUpperCase() }} · 第 {{ page.key }} 张</div>
            <div class="kb-dv-slide-title" @click="slideParts.titleBlock && selectBlock(slideParts.titleBlock)">{{ slideParts.title }}</div>
            <div class="kb-dv-slide-grid">
              <div v-for="(line, at) in slideParts.points" :key="at" class="kb-dv-slide-cell" :class="{ 'is-hit': isHit(line.block) }" @click="selectBlock(line.block)">{{ line.text }}</div>
            </div>
            <span class="mono kb-dv-slide-no">{{ page.key }} / {{ lastPage }}</span>
          </div>
          <div v-if="slideParts.remark" class="kb-dv-card">
            <div class="row">
              <b>演讲者备注</b>
              <span class="tag">已入索引</span>
            </div>
            <div class="m kb-dv-remark">{{ slideParts.remark }}</div>
          </div>
        </div>
      </div>
    </template>

    <!-- 图片:左原件 / 右识别文本 -->
    <template v-else-if="mode === 'image'">
      <div class="kb-dv-split">
        <div class="kb-dv-frame" :class="{ 'is-image': rawUrl && !rawBroken }">
          <ImageViewer v-if="rawUrl && !rawBroken" :src="rawUrl" alt="原件" @broken="rawBroken = true" />
          <span v-else class="m">原件不可读(只显示识别文本)</span>
        </div>
        <div class="kb-dv-col">
          <div class="row kb-dv-colhead">
            <b>识别文本</b>
            <span class="tag">OCR</span>
            <span class="m mono kb-dv-note">{{ blocks.length }} 段</span>
          </div>
          <div class="kb-dv-ocr">
            <p v-if="!blocks.length" class="m">没有识别出文字（图片里没有文字，或还没做 OCR）。</p>
            <p v-for="(block, at) in blocks" :key="at" class="kb-dv-ocr-line" :class="{ 'is-hit': isHit(block) }" @click="selectBlock(block)">{{ block.text }}</p>
          </div>
        </div>
      </div>
    </template>

    <!-- 音视频:播放器 + 波形 + 转写 -->
    <template v-else-if="mode === 'media'">
      <video v-if="rawUrl && isVideo" class="kb-dv-raw" :src="rawUrl" controls preload="none" />
      <div v-else-if="rawUrl" class="kb-dv-player">
        <!-- 没有 controls 的 <audio> 浏览器默认不显示,只用它解码与播放;可见控件是下面的按钮 + 波形 -->
        <audio
          ref="audioEl"
          class="kb-none"
          :src="rawUrl"
          preload="metadata"
          @timeupdate="onTimeUpdate"
          @seeked="onTimeUpdate"
          @loadedmetadata="onLoaded"
          @play="playing = true"
          @pause="playing = false"
          @ended="playing = false"
        />
        <button type="button" class="kb-dv-play" :aria-label="playing ? '暂停' : '播放'" @click="togglePlay">
          <KbIcon :name="playing ? 'pause' : 'play'" :size="14" />
        </button>
        <!-- 音频:音频画真实波形(从原件解码),点击定位到该时间 -->
        <KbWaveform
          v-if="!rawBroken"
          class="kb-dv-wave"
          :src="rawUrl"
          :duration-ms="transcriptEnd || null"
          :position-ms="playPosition"
          @seek="seekTo"
        />
        <span class="mono m kb-dv-note">{{ playClock }} / {{ mediaTotal }}</span>
      </div>
      <div v-if="playError" class="kb-dv-error m">{{ playError }}</div>
      <div class="row kb-dv-bar">
        <b>转写文本</b>
        <span class="tag">带时间戳</span>
        <span class="m kb-dv-note">点击时间戳跳转</span>
      </div>
      <div class="kb-dv-trans">
        <div v-for="(row, at) in transcript" :key="at" class="row kb-dv-trow" :class="{ 'is-hit': row.hit }" @click="selectBlock(row.block)">
          <button type="button" class="mono kb-dv-time" :disabled="!rawUrl" @click.stop="seekTo(row.block.anchor?.start_ms ?? 0)">{{ row.time }}</button>
          <span class="kb-dv-ttext">{{ row.block.text }}</span>
        </div>
      </div>
    </template>

    <!-- 其它:带行号的文本 -->
    <pre v-else class="kb-dv-code"><code><span v-for="(line, at) in lines" :key="at" class="kb-dv-line"><i>{{ at + 1 }}</i>{{ line }}
</span></code></pre>
  </div>
</template>
