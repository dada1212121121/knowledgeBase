<script setup lang="ts">
// 统一外壳的左侧导航:展开(图标 + 文字)/ 图标栏 / 隐藏 三态。
//
// 状态怎么来见 stores/nav.ts;这里只负责渲染、拖动边缘和键盘操作:
//   - 拖动边缘:松手时按宽度吸附(太窄 → 隐藏,较窄 → 图标栏,否则按宽度展开并记住);
//   - 边缘本身是 role=separator 的可聚焦控件:←/→ 微调宽度,Enter 在展开和图标栏之间切换,
//     所以不会拖动的人(键盘、读屏)也能改。拖动只是「快」,不是「唯一的路」。
//   - 浮层档位(600–1279)里「展开」盖在内容上,点遮罩 / 按 Esc / 跳转后收回。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSlider } from '@kb-ui/motion/useSlider'
import { KbIcon, KbNum } from '@kb-ui/index'
import { useNavStore } from '@/stores/nav'
import { SIDEBAR_MAX, SIDEBAR_MIN, useUiStore } from '@/stores/ui'
import { useViewport } from '@/composables/useViewport'
import { collapsedGroups } from './navModel'
import type { NavEntry, NavGroup } from './types'

const props = defineProps<{ groups: NavGroup[] }>()
defineEmits<{ search: [] }>()

const nav = useNavStore()
const ui = useUiStore()
const viewport = useViewport()
const route = useRoute()

const slotEl = ref<HTMLElement | null>(null)
const scrollEl = ref<HTMLElement | null>(null)

// 选中高亮是一块会滑动的底(切页时从旧项滑到新项)
const { style: pillStyle, ready: pillReady, update: updatePill } = useSlider(
  scrollEl,
  '.kb-nav-item',
  () => `${route.fullPath}|${nav.labelsVisible}`,
)

const isOverlay = computed(() => nav.overlayTier && nav.overlayOpen)
/** 图标栏形态:没有文字。浮层展开时一定有文字。 */
const isRail = computed(() => !nav.labelsVisible)
const isHidden = computed(() => nav.state === 'hidden' && !isOverlay.value)

// 浮层:Esc 收回;路由变化后收回(点了一个入口就该让出内容)
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && nav.overlayOpen) nav.closeOverlay()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
watch(() => route.fullPath, () => nav.closeOverlay())

// ---- 拖动边缘 ----
let dragStartX = 0
let dragStartWidth = 0
let dragging = false

function slotLeft() {
  return slotEl.value?.getBoundingClientRect().left ?? 0
}
function onPointerDown(event: PointerEvent) {
  if (event.button !== 0 && event.pointerType === 'mouse') return
  dragging = true
  dragStartX = event.clientX
  dragStartWidth = nav.slotWidth
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  nav.dragTo(dragStartWidth)
  event.preventDefault()
}
function onPointerMove(event: PointerEvent) {
  if (!dragging) return
  nav.dragTo(dragStartWidth + (event.clientX - dragStartX))
}
function onPointerUp(event: PointerEvent) {
  if (!dragging) return
  dragging = false
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId)
  // 没怎么拖(当作点击)就不改状态
  const moved = Math.abs(event.clientX - dragStartX) > 3
  const width = Math.max(0, event.clientX - slotLeft())
  if (moved) nav.commitDrag(width)
  else nav.dragTo(null)
}
function onPointerCancel() {
  dragging = false
  nav.dragTo(null)
}

function onResizerKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 48 : 16
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    if (nav.state !== 'expanded') nav.collapseOrExpand()
    else ui.setSidebarWidth(ui.sidebarWidth + step)
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    if (nav.state === 'expanded' && ui.sidebarWidth - step >= SIDEBAR_MIN) ui.setSidebarWidth(ui.sidebarWidth - step)
    else if (nav.state === 'expanded') nav.collapseOrExpand()
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    nav.collapseOrExpand()
  }
}

/**
 * 导航项的可访问名称,要求包含屏幕上看得见的文字(WCAG 2.5.3,axe label-content-name-mismatch)。
 * 以前图标栏里名称只有「审核收件箱」,可见的却是角标上的数字,语音控制念「7」点不到;角标又自带 aria-label,
 * 名称来源散在两处。现在由链接统一给名称「文字 + 待处理数」,角标只作视觉(aria-hidden):
 * 展开时可见文字(文字 + 灰字 + 数字)全在名称里;图标栏里文字被样式隐藏,可见的只剩数字,同样在名称里。
 * 没有数字且文字可见时返回 undefined,名称直接来自内容,不写多余的 aria-label。
 */
function itemName(item: NavEntry): string | undefined {
  if (!isRail.value && !item.count) return undefined
  const parts = [item.label]
  if (!isRail.value && item.text) parts.push(item.text)
  if (item.count) parts.push(`${item.count > 99 ? '99+' : item.count} 项待处理`)
  return parts.join(' ')
}

const slotStyle = computed(() => ({ '--nav-cur': `${nav.slotWidth}px`, '--nav-w': `${ui.sidebarWidth}px` }))

// ---- 分组折叠(目前只有「管理」)----
// 为什么要折叠:管理组 9 个入口,加上「我的」那几个,整列在平板横屏(≈787)和小窗口里放不下,
// 最后几个入口会被切在滚动区边缘——只露出半行按钮,看着就像排版挤坏了。
// 规则见 navModel.ts 的 collapsedGroups:用户点过听用户的,没点过则放不下才收,当前页在里面永远展开。
const autoCollapsed = ref<string[]>([])
const collapsedIds = computed(() =>
  collapsedGroups({ groups: props.groups, userCollapsed: ui.navCollapsed, autoCollapsed: autoCollapsed.value }),
)
/** 图标栏里没有分组标题,不收(收了就没有任何入口,连图标都点不到)。 */
function isCollapsed(group: NavGroup): boolean {
  return !isRail.value && collapsedIds.value.includes(group.id)
}
function itemsOf(group: NavGroup): NavEntry[] {
  return isCollapsed(group) ? [] : group.items
}
function toggleGroup(group: NavGroup) {
  // 从「此刻实际看到的状态」推下一步:点一下就是明确表态,以后不再自动收起 / 展开
  const next = new Set(collapsedIds.value)
  if (next.has(group.id)) next.delete(group.id)
  else next.add(group.id)
  ui.setNavCollapsed([...next])
}

/** 一行导航的实际占位(行高 + 列表 gap):收起一组能省下的高度 = 入口数 × 这个值。 */
function rowPitch(): number {
  const el = scrollEl.value
  const gap = el ? Number.parseFloat(getComputedStyle(el).rowGap) || 0 : 2
  const sample = el?.querySelector<HTMLElement>('[data-nav-id]')
  return (sample?.offsetHeight ?? (viewport.touch.value ? 44 : 36)) + gap
}

/**
 * 量一次「全部展开要多少高」,放不下就自动收起可折叠分组。
 * 只在用户没手动选过时起作用;量的是「当前高度 + 已收起省下的」,所以收起状态下再量也不会来回抖。
 */
function recheckFit() {
  const el = scrollEl.value
  if (!el || isRail.value || ui.navCollapsed) return
  const collapsible = props.groups.filter((group) => group.collapsible)
  if (!collapsible.length) {
    autoCollapsed.value = []
    return
  }
  const pitch = rowPitch()
  const saved = collapsedIds.value.reduce(
    (sum, id) => sum + (props.groups.find((group) => group.id === id)?.items.length ?? 0) * pitch,
    0,
  )
  // 全部展开要多少高(当前高度 + 已收起省下的);放得下就别动它
  const full = el.scrollHeight + saved
  autoCollapsed.value = full > el.clientHeight + 1 ? collapsible.map((group) => group.id) : []
}

onMounted(() => void recheckFit())
watch([() => viewport.height.value, () => nav.state, () => props.groups.length], () => void recheckFit())
const collapseLabel = computed(() => {
  if (isOverlay.value) return '收回导航'
  return nav.state === 'expanded' ? '收起为图标栏' : '展开侧栏'
})

function onTransitionEnd() {
  updatePill()
}
</script>

<template>
  <div
    v-if="nav.hasSidebar"
    ref="slotEl"
    class="kb-nav-slot"
    :class="{ 'is-dragging': nav.dragWidth !== null, 'is-hidden': isHidden, 'is-overlay-open': isOverlay }"
    :data-nav="nav.state"
    :style="slotStyle"
    style-allow="侧栏宽度由用户拖动 / 偏好决定,是运行时数据"
    @transitionend.self="onTransitionEnd"
  >
    <!-- 浮层展开时盖在内容上的遮罩;点它收回 -->
    <Transition name="kb-fade">
      <div v-if="isOverlay" class="kb-nav-scrim" aria-hidden="true" @click="nav.closeOverlay()"></div>
    </Transition>

    <aside
      class="kb-nav"
      :class="{ 'is-rail': isRail, 'is-overlay': isOverlay, 'has-pill': pillReady }"
      aria-label="导航"
      :aria-hidden="isHidden ? 'true' : undefined"
      :inert="isHidden"
      data-testid="nav"
    >
      <div class="kb-nav-brand">
        <img class="logo" src="/icons/icon-192.png" alt="kb" />
        <b class="kb-nav-name">knowledgeBase</b>
      </div>

      <nav ref="scrollEl" class="kb-nav-scroll" aria-label="主导航">
        <span class="kb-nav-pill" :style="pillStyle" aria-hidden="true" style-allow="高亮块位置由量出的选中项决定"></span>
        <template v-for="group in groups" :key="group.id">
          <button
            v-if="group.label && group.collapsible && !isRail"
            type="button"
            class="kb-nav-group kb-nav-group-toggle"
            :aria-expanded="!isCollapsed(group)"
            :data-group="group.id"
            data-testid="nav-group-toggle"
            @click="toggleGroup(group)"
          >
            <span class="kb-nl">{{ group.label }}</span>
            <KbIcon name="chevron" :size="12" class="kb-nav-group-caret" />
          </button>
          <div v-else-if="group.label" class="kb-nav-group" role="presentation">
            <span class="kb-nl">{{ group.label }}</span>
          </div>
          <RouterLink
            v-for="item in itemsOf(group)"
            :key="item.id"
            class="kb-nav-item"
            :class="{ on: item.active }"
            :data-active="item.active ? 'true' : 'false'"
            :data-nav-id="item.id"
            :to="item.to"
            :title="isRail ? item.label : undefined"
            :aria-label="itemName(item)"
            :aria-current="item.active ? 'page' : undefined"
          >
            <KbIcon :name="item.icon" />
            <span class="kb-nl">{{ item.label }}</span>
            <span v-if="item.text" class="n kb-nl"><KbNum :value="item.text" /></span>
            <em v-if="item.count" class="kb-nav-badge" aria-hidden="true">{{ item.count > 99 ? '99+' : item.count }}</em>
          </RouterLink>
        </template>
        <slot name="extra" />
      </nav>

      <div class="kb-nav-foot">
        <slot name="foot" />
        <button
          type="button"
          class="kb-nav-item kb-nav-collapse"
          :title="`${collapseLabel} (⌘B)`"
          :aria-label="isRail ? collapseLabel : undefined"
          data-testid="nav-collapse"
          @click="nav.collapseOrExpand()"
        >
          <KbIcon name="sidebar" />
          <span class="kb-nl">{{ collapseLabel }}</span>
          <span class="kbd kb-nav-kbd">⌘B</span>
        </button>
      </div>
    </aside>

    <!-- 拖动边缘:浮层档位和手机没有(那里「展开」是临时浮层,宽度不可调) -->
    <div
      v-if="!nav.overlayTier && nav.state !== 'hidden'"
      class="kb-nav-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      tabindex="0"
      :aria-valuemin="SIDEBAR_MIN"
      :aria-valuemax="SIDEBAR_MAX"
      :aria-valuenow="nav.state === 'expanded' ? ui.sidebarWidth : 0"
      data-testid="nav-resizer"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @keydown="onResizerKey"
    ></div>
  </div>

  <!-- 完全隐藏时,左上角留一个小把手,免得没有键盘的人找不回导航(没有顶栏的页面尤其需要) -->
  <button
    v-if="nav.hasSidebar && isHidden"
    type="button"
    class="kb-nav-reveal"
    aria-label="展开侧栏"
    title="展开侧栏 (⌘B)"
    data-testid="nav-reveal"
    @click="nav.toggle()"
  >
    <KbIcon name="sidebar" />
  </button>
</template>
