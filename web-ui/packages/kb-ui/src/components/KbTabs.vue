<script setup lang="ts">
// 通用选项卡导航(设计规范):下划线是一根会滑动、会变宽的条(参考 uilab「顶部标签页」),
// 不是各页签各自画下划线。← → 切换,Home / End;只有选中页签在 Tab 序列里。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSlider } from '../motion/useSlider'
import KbIcon from './KbIcon.vue'
import KbNum from './KbNum.vue'

export interface TabItem {
  value: string
  label: string
  count?: number | string
  tone?: string
}

const props = defineProps<{
  modelValue: string
  tabs: TabItem[]
  /** 嵌在面板里用:去掉页面级内边距 / 背景(03 浏览器详情的页签) */
  flush?: boolean
  /** 页签多到放不下时:最多直接显示这么多个(含「更多」),其余收进「更多」菜单;当前页签永远可见 */
  maxVisible?: number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const root = ref<HTMLElement | null>(null)

// ---- 「更多」:超过 maxVisible 的页签收进菜单。当前页签在菜单里时,把它换到可见区(换掉最后一个可见的),不让人看不到自己在哪 ----
const split = computed(() => {
  const limit = props.maxVisible
  if (!limit || props.tabs.length <= limit) return { shown: props.tabs, hidden: [] as TabItem[] }
  const slots = Math.max(1, limit - 1)
  let shown = props.tabs.slice(0, slots)
  let hidden = props.tabs.slice(slots)
  const active = hidden.find((tab) => tab.value === props.modelValue)
  if (active) {
    const swapped = shown[shown.length - 1]!
    shown = [...shown.slice(0, -1), active]
    hidden = [swapped, ...hidden.filter((tab) => tab !== active)]
  }
  return { shown, hidden }
})
const moreOpen = ref(false)
const moreBtn = ref<HTMLButtonElement | null>(null)
const moreMenu = ref<HTMLElement | null>(null)
const morePos = ref<Record<string, string>>({})
async function toggleMore() {
  if (moreOpen.value) {
    moreOpen.value = false
    return
  }
  const box = moreBtn.value?.getBoundingClientRect()
  if (!box) return
  morePos.value = { top: `${Math.round(box.bottom + 4)}px`, right: `${Math.max(8, Math.round(window.innerWidth - box.right))}px` }
  moreOpen.value = true
  // 菜单放不下(页签条靠近屏幕底部)就翻到按钮上方,上方也放不下就贴着屏幕底边——不能有选项落在屏幕外点不到
  await nextTick()
  const menu = moreMenu.value?.getBoundingClientRect()
  if (!menu || menu.bottom <= window.innerHeight - 8) return
  const above = box.top - menu.height - 4
  const top = above >= 8 ? above : Math.max(8, window.innerHeight - menu.height - 8)
  morePos.value = { ...morePos.value, top: `${Math.round(top)}px` }
}
function pickMore(value: string) {
  moreOpen.value = false
  emit('update:modelValue', value)
}
const closeMore = (event: Event) => {
  if (moreOpen.value && !moreBtn.value?.contains(event.target as Node) && !(event.target as HTMLElement).closest?.('.kb-tabs-menu')) moreOpen.value = false
}

// ---- 横向滑动的渐隐提示:左 / 右还有被藏起来的页签时,对应一侧渐隐,提醒「还能滑」 ----
const fade = ref({ left: false, right: false })
/** 内容比容器宽(要滑动)。只有这时才把容器设成可滚动:不然 overflow 会裁掉页签的焦点环 */
const scrollable = ref(false)
function measureFade() {
  const bar = root.value
  if (!bar) return
  scrollable.value = bar.scrollWidth > bar.clientWidth + 1
  fade.value = { left: bar.scrollLeft > 2, right: bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2 }
}
let observer: ResizeObserver | null = null
onMounted(() => {
  measureFade()
  if (root.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measureFade)
    observer.observe(root.value)
  }
  document.addEventListener('pointerdown', closeMore, true)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  document.removeEventListener('pointerdown', closeMore, true)
})
watch(() => props.tabs, () => void nextTick(measureFade), { deep: true })

const { style, ready } = useSlider(root, '.tab', () => props.modelValue)

// 页签行在手机 / 平板上可以横向滑动(放不下时):选中项如果在可视区外,把它滚进来,
// 否则深链进来时看不到当前是哪个页签。
//
// 只改页签容器自己的 `scrollLeft`:**不要**用 `scrollIntoView` —— 它会连带滚动祖先,
// 挂载时就把详情面板整体挪几像素(质量检查 N-02:五个视口的 browser-editor 因此同时漂移 0.03–0.10)。
function revealActive() {
  const bar = root.value
  const active = bar?.querySelector<HTMLElement>('.tab.on')
  if (!bar || !active) return
  if (bar.scrollWidth <= bar.clientWidth) return
  const left = active.offsetLeft
  const right = left + active.offsetWidth
  if (left < bar.scrollLeft) bar.scrollLeft = left
  else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth
}
onMounted(() => requestAnimationFrame(revealActive))
watch(() => props.modelValue, () => requestAnimationFrame(revealActive))

function select(val: string) {
  emit('update:modelValue', val)
}
function move(delta: number) {
  const list = props.tabs
  const index = list.findIndex((tab) => tab.value === props.modelValue)
  const next = list[(index + delta + list.length) % list.length]
  if (!next) return
  emit('update:modelValue', next.value)
  requestAnimationFrame(() => root.value?.querySelector<HTMLElement>('.tab.on')?.focus())
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowRight') (event.preventDefault(), move(1))
  else if (event.key === 'ArrowLeft') (event.preventDefault(), move(-1))
  else if (event.key === 'Home') (event.preventDefault(), move(-props.tabs.length))
  else if (event.key === 'End') (event.preventDefault(), move(props.tabs.length - 1))
}
</script>

<template>
  <div
    ref="root"
    class="tabs kb-tabs"
    :class="{ 'tabs-flush': flush, 'is-ready': ready, 'is-scroll': scrollable, 'has-fade-left': fade.left, 'has-fade-right': fade.right }"
    role="tablist"
    @keydown="onKey"
    @scroll.passive="measureFade"
  >
    <button
      v-for="t in split.shown"
      :key="t.value"
      type="button"
      role="tab"
      :aria-selected="t.value === modelValue"
      :tabindex="t.value === modelValue ? 0 : -1"
      :data-active="t.value === modelValue"
      :class="['tab', { on: t.value === modelValue }]"
      @click="select(t.value)"
    >
      <span>{{ t.label }}</span>
      <span v-if="t.count !== undefined" :class="flush ? 'kb-tab-count' : 'mono kb-muted'"><KbNum :value="t.count" /></span>
    </button>
    <button
      v-if="split.hidden.length"
      ref="moreBtn"
      type="button"
      class="tab kb-tabs-more"
      aria-haspopup="menu"
      :aria-expanded="moreOpen"
      data-testid="tabs-more"
      @click="toggleMore"
    >
      <span>更多</span><KbIcon name="chevron" :size="12" />
    </button>
    <Teleport to="body">
      <div v-if="moreOpen" ref="moreMenu" class="kb-tabs-menu" role="menu" :style="morePos" style-allow="菜单位置由按钮实际位置决定">
        <button v-for="t in split.hidden" :key="t.value" type="button" role="menuitem" class="kb-tabs-menu-item" @click="pickMore(t.value)">
          {{ t.label }}<span v-if="t.count !== undefined" class="m mono"><KbNum :value="t.count" /></span>
        </button>
      </div>
    </Teleport>
    <span class="kb-tab-bar" :style="style" aria-hidden="true" style-allow="下划线位置由量出的选中页签决定"></span>
    <div v-if="$slots.actions" class="tabs-actions">
      <slot name="actions" />
    </div>
  </div>
</template>
