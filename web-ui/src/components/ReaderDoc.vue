<script setup lang="ts">
// 通用阅读视图:把「已清洗的 HTML」按文章排版显示。老 Word / PPT、ODT / ODP、RTF、EPUB、邮件、网页转出来的内容都走它。
//   - 多节(章节 / 幻灯片 / 邮件):左侧目录(窄屏是抽屉)+ 上一节 / 下一节;节内容可以懒加载(EPUB 按章读);
//   - 字号 A− / A+(记住),命中句高亮(CSS Custom Highlight API,不支持就只滚动);
//   - 内容进主 DOM 前必须已经过 sanitizeDocHtml:这里只做 v-html,不再信任输入。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { KbIcon } from '@kb-ui/index'
import { clearHighlight, findTextRange, paintHighlight, revealRange } from '@/utils/domHighlight'
import { sanitizeDocHtml } from '@/utils/sanitizeHtml'

export interface ReaderSection {
  title: string
  /** 已有的 HTML(未清洗也行,这里会再过一遍) */
  html?: string
  /** 懒加载:点到才取 */
  load?: () => Promise<string>
}

const props = defineProps<{
  sections: ReaderSection[]
  /** 顶部提示条(例如「旧版 .doc 只显示文字」) */
  banner?: string
  hitText?: string
  /** 书名 / 文档名,放在目录顶部 */
  heading?: string
}>()
const emit = defineEmits<{ error: [message: string] }>()

const article = ref<HTMLElement | null>(null)
const pane = ref<HTMLElement | null>(null)
const index = ref(0)
const html = ref('')
const loading = ref(false)
const failure = ref('')
const railOpen = ref(false)
const compact = ref(false)
let railTouched = false
let token = 0
let observer: ResizeObserver | null = null

const SIZE_KEY = 'kb.reader.size'
const SIZES = [13, 14, 15, 16, 17, 19, 22]
const sizeAt = ref(readSize())
function readSize(): number {
  try {
    const stored = Number(localStorage.getItem(SIZE_KEY))
    return Number.isInteger(stored) && stored >= 0 && stored < SIZES.length ? stored : 2
  } catch {
    return 2
  }
}
function bump(delta: number) {
  sizeAt.value = Math.min(SIZES.length - 1, Math.max(0, sizeAt.value + delta))
  try {
    localStorage.setItem(SIZE_KEY, String(sizeAt.value))
  } catch {
    /* 隐私模式 */
  }
}
const fontPx = computed(() => `${SIZES[sizeAt.value]}px`)

const many = computed(() => props.sections.length > 1)
const current = computed(() => props.sections[index.value] ?? null)

const HIT = 'kb-hit'

async function show(at: number) {
  const section = props.sections[at]
  const mine = ++token
  clearHighlight(HIT)
  failure.value = ''
  if (!section) {
    html.value = ''
    return
  }
  index.value = at
  try {
    if (section.html === undefined && section.load) {
      loading.value = true
      section.html = await section.load()
    }
    if (mine !== token) return
    html.value = sanitizeDocHtml(section.html ?? '')
  } catch (error) {
    if (mine !== token) return
    failure.value = error instanceof Error ? error.message : '这一节读取失败'
    html.value = ''
    if (props.sections.length === 1) emit('error', failure.value)
  } finally {
    if (mine === token) loading.value = false
  }
  await nextTick()
  if (mine !== token) return
  pane.value?.scrollTo({ top: 0 })
  paint()
}

function plain(value: string): string {
  const template = document.createElement('template')
  template.innerHTML = value
  return template.content.textContent ?? ''
}

/** 有命中句时:先在已有 HTML 的节里找出第一处包含它的,再翻过去 */
function firstSectionWithHit(): number {
  const needle = (props.hitText ?? '').replace(/\s+/g, '').slice(0, 16).toLowerCase()
  if (!needle) return 0
  const found = props.sections.findIndex((section) => section.html !== undefined && plain(section.html).replace(/\s+/g, '').toLowerCase().includes(needle))
  return found >= 0 ? found : 0
}

function paint() {
  clearHighlight(HIT)
  const text = props.hitText?.trim()
  if (!text || !article.value) return
  const range = findTextRange(article.value, text)
  if (!range) return
  paintHighlight(HIT, range)
  revealRange(range)
}

function go(delta: number) {
  const next = index.value + delta
  if (next >= 0 && next < props.sections.length) void show(next)
}
function pick(at: number) {
  void show(at)
  if (compact.value) {
    railTouched = true
    railOpen.value = false
  }
}
function toggleRail() {
  railTouched = true
  railOpen.value = !railOpen.value
}

function measure() {
  const element = pane.value?.parentElement
  if (!element) return
  compact.value = element.clientWidth < 760
  if (!railTouched) railOpen.value = many.value && !compact.value
}

watch(
  () => props.sections,
  () => void show(firstSectionWithHit()),
  { immediate: true },
)
watch(() => props.hitText, () => void show(firstSectionWithHit()))
onMounted(() => {
  measure()
  const element = pane.value?.parentElement
  if (element && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    observer.observe(element)
  }
})
onBeforeUnmount(() => {
  observer?.disconnect()
  clearHighlight(HIT)
})
</script>

<template>
  <div class="kb-rd" :class="{ 'is-rail': railOpen && many, 'is-compact': compact }">
    <div class="kb-rd-bar" role="toolbar" aria-label="阅读工具栏">
      <button v-if="many" type="button" class="btn sm kb-rd-btn" :class="{ ac: railOpen }" :aria-pressed="railOpen" aria-label="目录" title="目录" @click="toggleRail">
        <KbIcon name="list" :size="12" />
      </button>
      <span v-if="many" class="kb-rd-group">
        <button type="button" class="btn sm kb-rd-btn" aria-label="上一节" :disabled="index <= 0" @click="go(-1)"><KbIcon name="chevron" :size="12" class="kb-rd-prev" /></button>
        <span class="mono kb-rd-no">{{ index + 1 }} / {{ sections.length }}</span>
        <button type="button" class="btn sm kb-rd-btn" aria-label="下一节" :disabled="index >= sections.length - 1" @click="go(1)"><KbIcon name="chevron" :size="12" class="kb-rd-next" /></button>
      </span>
      <span class="kb-rd-group">
        <button type="button" class="btn sm kb-rd-btn kb-rd-aa" aria-label="缩小字号" :disabled="sizeAt <= 0" @click="bump(-1)">A−</button>
        <button type="button" class="btn sm kb-rd-btn kb-rd-aa" aria-label="放大字号" :disabled="sizeAt >= SIZES.length - 1" @click="bump(1)">A+</button>
      </span>
      <span class="kb-spacer"></span>
      <slot name="tools" />
    </div>
    <div v-if="banner" class="kb-rd-banner">{{ banner }}</div>

    <div class="kb-rd-body">
      <aside v-if="many" v-show="railOpen" class="kb-rd-rail" aria-label="目录">
        <div v-if="heading" class="kb-rd-heading" :title="heading">{{ heading }}</div>
        <button v-for="(section, at) in sections" :key="at" type="button" class="kb-rd-item" :class="{ 'is-on': at === index }" :aria-current="at === index" @click="pick(at)">
          <span class="mono kb-rd-item-no">{{ at + 1 }}</span>
          <span class="kb-rd-item-title">{{ section.title || `第 ${at + 1} 节` }}</span>
        </button>
      </aside>
      <div v-if="many && railOpen && compact" class="kb-rd-scrim" @click="toggleRail"></div>

      <div ref="pane" class="kb-rd-pane" tabindex="0" :aria-label="current?.title || '文档'">
        <!-- eslint-disable-next-line vue/no-v-html -- 内容已过 sanitizeDocHtml -->
        <article ref="article" class="kb-rd-article" :style="{ fontSize: fontPx }" v-html="html"></article>
        <p v-if="loading" class="m kb-rd-state" role="status">正在读取…</p>
        <p v-else-if="failure" class="kb-rd-state is-error" role="alert">{{ failure }}</p>
        <p v-else-if="!html" class="m kb-rd-state">（这一节没有内容）</p>
        <nav v-if="many && !loading" class="kb-rd-pager" aria-label="翻页">
          <button type="button" class="btn sm" :disabled="index <= 0" @click="go(-1)">上一节</button>
          <button type="button" class="btn sm" :disabled="index >= sections.length - 1" @click="go(1)">下一节</button>
        </nav>
      </div>
    </div>
  </div>
</template>

<style>
.kb-rd {
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
.kb-rd-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: var(--hl) solid var(--b);
  overflow-x: auto;
  scrollbar-width: none;
}
.kb-rd-bar::-webkit-scrollbar {
  display: none;
}
.kb-rd-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.kb-rd-btn {
  flex: none;
  min-width: var(--ctl-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.kb-rd-prev {
  transform: rotate(90deg);
}
.kb-rd-next {
  transform: rotate(-90deg);
}
.kb-rd-no {
  min-width: 5ch;
  text-align: center;
  color: var(--t2);
  font-size: calc(12px * var(--fs));
}
.kb-rd-banner {
  padding: 6px 12px;
  color: var(--t2);
  background: color-mix(in srgb, var(--status-warning) 8%, var(--surface-1));
  border-bottom: var(--hl) solid color-mix(in srgb, var(--status-warning) 35%, transparent);
  font-size: calc(12px * var(--fs));
}
.kb-rd-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.kb-rd-rail {
  position: absolute;
  z-index: 3;
  top: 0;
  bottom: 0;
  left: 0;
  width: 220px;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--surface-2);
  border-right: var(--hl) solid var(--b);
}
.kb-rd.is-compact .kb-rd-rail {
  width: min(280px, 78%);
  box-shadow: var(--sh3);
}
.kb-rd-scrim {
  position: absolute;
  inset: 0;
  z-index: 2;
  background: rgba(var(--shade), 0.35);
}
.kb-rd-heading {
  padding: 4px 8px 8px;
  color: var(--t);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-rd-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px;
  text-align: left;
  color: var(--t2);
  background: transparent;
  border: 0;
  border-radius: var(--r1);
  cursor: pointer;
}
.kb-rd-item:hover {
  background: var(--hover);
  color: var(--t);
}
.kb-rd-item.is-on {
  color: var(--t);
  background: var(--accent-soft);
}
.kb-rd-item-no {
  flex: none;
  min-width: 2ch;
  color: var(--m);
  font-size: calc(11px * var(--fs));
}
.kb-rd-item-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(13px * var(--fs));
}
.kb-rd-pane {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 20px 24px 40px;
  outline: none;
}
.kb-rd.is-rail:not(.is-compact) .kb-rd-pane {
  margin-left: 220px;
}
.kb-rd-article {
  max-width: 46em;
  margin: 0 auto;
  color: var(--t);
  line-height: 1.8;
  overflow-wrap: anywhere;
  user-select: text;
}
.kb-rd-article h1,
.kb-rd-article h2,
.kb-rd-article h3,
.kb-rd-article h4,
.kb-rd-article h5,
.kb-rd-article h6 {
  margin: 1.4em 0 0.5em;
  line-height: 1.35;
  color: var(--t);
}
.kb-rd-article h1 {
  font-size: 1.6em;
}
.kb-rd-article h2 {
  font-size: 1.35em;
}
.kb-rd-article h3 {
  font-size: 1.15em;
}
.kb-rd-article > :first-child {
  margin-top: 0;
}
.kb-rd-article p {
  margin: 0.7em 0;
}
.kb-rd-article ul,
.kb-rd-article ol {
  padding-left: 1.5em;
}
.kb-rd-article img {
  max-width: 100%;
  height: auto;
  border-radius: var(--r1);
}
.kb-rd-article a {
  color: var(--ac2);
  text-decoration: underline;
}
.kb-rd-article blockquote {
  margin: 1em 0;
  padding: 0.2em 1em;
  color: var(--t2);
  border-left: 3px solid var(--accent);
  background: var(--accent-soft);
  border-radius: 0 var(--r1) var(--r1) 0;
}
.kb-rd-article hr {
  border: 0;
  border-top: var(--hl) solid var(--b2);
  margin: 1.2em 0;
}
.kb-rd-article pre,
.kb-rd-article code {
  font-family: var(--mono);
  font-size: 0.92em;
  background: var(--surface-3);
  border-radius: var(--r-xs);
}
.kb-rd-article code {
  padding: 0.1em 0.35em;
}
.kb-rd-article pre {
  padding: 0.8em 1em;
  overflow: auto;
}
.kb-rd-article pre code {
  padding: 0;
  background: none;
}
/* 表格:窄屏横向滚动,不撑破页面;全站手机端「表格变卡片」的规则在这里不适用 */
.kb-rd-article table {
  display: block !important;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 1em 0;
}
.kb-rd-article thead,
.kb-rd-article tbody {
  display: table-row-group !important;
}
.kb-rd-article tr {
  display: table-row !important;
  min-height: 0 !important;
  padding: 0 !important;
}
.kb-rd-article td,
.kb-rd-article th {
  display: table-cell !important;
  width: auto !important;
  min-width: 4em;
  padding: 6px 10px !important;
  border: var(--hl) solid var(--b2) !important;
  vertical-align: top;
}
.kb-rd-article th {
  background: var(--surface-2);
  font-weight: 600;
}
.kb-rd-state {
  text-align: center;
  padding: 24px;
}
.kb-rd-state.is-error {
  color: var(--status-danger-text, var(--r));
}
.kb-rd-pager {
  max-width: 46em;
  margin: 24px auto 0;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
@media (max-width: 520px) {
  .kb-rd-pane {
    padding: 14px 14px 32px;
  }
}
@media (pointer: coarse) {
  .kb-rd-btn {
    min-width: 36px;
    min-height: 36px;
  }
  /* 章节 / 邮件 / 幻灯片列表里的一行:整行都是按钮,直接加高到 44px */
  .kb-rd-item {
    align-items: center;
    min-height: 44px;
  }
}
</style>
