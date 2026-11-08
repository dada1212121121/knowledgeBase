<script setup lang="ts">
// 下拉选择(参考 uilab「按钮弹出菜单」):
//   - 菜单从按钮中心缩放长出(0.6→1,180ms),选项一项接一项落位;收回更快(120ms)、选项一起淡出;
//   - 菜单渲染在 body 上(position:fixed 跟着按钮),不会被卡片的 overflow 裁掉;
//   - 下方放不下而上方更宽裕时自动往上弹;
//   - 键盘:↑↓ 移动,Home/End,Enter/空格选中,Esc 关闭并还焦点,Tab 关闭;点外面关闭。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import KbIcon from './KbIcon.vue'
import type { IconName } from './icons'

export interface SelectOption {
  value: string | number
  label: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string | number
    options: SelectOption[]
    /** 按钮上的前缀,例如「状态:」 */
    prefix?: string
    size?: 'md' | 'sm'
    /** 菜单对齐方向 */
    align?: 'start' | 'end'
    /** 强制向上展开(分页条在底部时);不设则按可用空间自动判断 */
    up?: boolean
    /** 按钮文案覆盖(例如分页的「12 / 页」) */
    display?: string
    /** 去掉按钮边框,只当作文字+箭头 */
    plain?: boolean
    icon?: IconName
    caret?: boolean
    /** 主按钮样式(「+ 新任务」) */
    primary?: boolean
    /** 触发按钮的名字:按钮上只有当前值(「可查看」)时,读屏软件需要知道它是哪一项的(「张三 的角色」) */
    ariaLabel?: string
  }>(),
  { prefix: '', size: 'md', align: 'start', up: false, display: '', plain: false, icon: undefined, caret: true, primary: false, ariaLabel: '' },
)
const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>()

const open = ref(false)
const side = ref<'bottom' | 'top'>('bottom')
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const active = ref(0)
const box = ref({ top: 0, left: 0, width: 0, height: 0 })
const uid = `kb-sel-${Math.random().toString(36).slice(2, 8)}`

const current = computed(() => props.options.find((option) => option.value === props.modelValue))
const text = computed(() => props.display || `${props.prefix}${current.value?.label ?? ''}`)
const GAP = 6

function measure() {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  box.value = { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}
function chooseSide() {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  const need = (panel.value?.scrollHeight ?? props.options.length * 30 + 12) + GAP + 8
  const below = window.innerHeight - rect.bottom
  const above = rect.top
  side.value = props.up ? 'top' : below < need && above > below ? 'top' : 'bottom'
}

let raf = 0
function follow() {
  measure()
  raf = requestAnimationFrame(follow)
}

async function openMenu() {
  if (open.value) return
  measure()
  chooseSide()
  active.value = Math.max(0, props.options.findIndex((option) => option.value === props.modelValue))
  open.value = true
  await nextTick()
  chooseSide()
  raf = requestAnimationFrame(follow)
  focusItem(active.value)
}
function closeMenu(restoreFocus = false) {
  if (!open.value) return
  open.value = false
  cancelAnimationFrame(raf)
  if (restoreFocus) trigger.value?.focus()
}
function toggle() {
  open.value ? closeMenu() : void openMenu()
}
function choose(option: SelectOption) {
  emit('update:modelValue', option.value)
  closeMenu(true)
}
function focusItem(index: number) {
  active.value = index
  void nextTick(() => panel.value?.querySelectorAll<HTMLElement>('[role=option]')[index]?.focus({ preventScroll: true }))
}
function onTriggerKey(event: KeyboardEvent) {
  if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
    event.preventDefault()
    void openMenu().then(() => {
      if (event.key === 'ArrowUp') focusItem(props.options.length - 1)
    })
  }
}
function onPanelKey(event: KeyboardEvent) {
  const last = props.options.length - 1
  if (event.key === 'Escape') {
    event.preventDefault()
    closeMenu(true)
  } else if (event.key === 'Tab') {
    closeMenu()
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    focusItem(active.value >= last ? 0 : active.value + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    focusItem(active.value <= 0 ? last : active.value - 1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    focusItem(0)
  } else if (event.key === 'End') {
    event.preventDefault()
    focusItem(last)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    const option = props.options[active.value]
    if (option) choose(option)
  }
}
function onOutside(event: Event) {
  const target = event.target as Node
  if (trigger.value?.contains(target) || panel.value?.contains(target)) return
  closeMenu()
}
watch(open, (value) => {
  if (value) {
    document.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('resize', measure)
  } else {
    document.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('resize', measure)
  }
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  document.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('resize', measure)
})

/** 面板相对「按钮大小的层」的定位 */
const layerStyle = computed(() => ({
  top: `${box.value.top}px`,
  left: `${box.value.left}px`,
  width: `${box.value.width}px`,
  height: `${box.value.height}px`,
}))
</script>

<template>
  <span class="kb-select" :data-open="open">
    <button
      ref="trigger"
      type="button"
      class="btn"
      :class="{ sm: size === 'sm', pri: primary, 'kb-select-plain': plain, 'is-open': open }"
      :aria-label="ariaLabel ? `${ariaLabel}:${text}` : undefined"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="uid"
      @click="toggle"
      @keydown="onTriggerKey"
    >
      <KbIcon v-if="icon" :name="icon" :size="14" class="kb-select-icon" />
      <span>{{ text }}</span>
      <KbIcon v-if="caret" name="chevron" :size="12" class="kb-select-caret" :class="{ 'is-open': open }" />
    </button>
    <Teleport to="body">
      <!-- 一直挂在 DOM 里,开合只切 data-open,交给 CSS 过渡(收回时才能播动画) -->
      <div class="kb-pop-layer" :data-open="open" :data-side="side" :data-align="align" :style="layerStyle" style-allow="跟随触发按钮的位置">
        <div :id="uid" ref="panel" class="kb-pop-panel" role="listbox" tabindex="-1" @keydown="onPanelKey">
          <button
            v-for="(option, index) in options"
            :key="option.value"
            type="button"
            role="option"
            class="kb-pop-item"
            :class="{ 'is-on': option.value === modelValue }"
            :style="{ '--i': index, '--ri': options.length - 1 - index }"
            style-allow="落位先后序号"
            :aria-selected="option.value === modelValue"
            :tabindex="index === active ? 0 : -1"
            @mouseenter="active = index"
            @click="choose(option)"
          >
            <span>{{ option.label }}</span>
            <KbIcon v-if="option.value === modelValue" name="check" :size="14" />
          </button>
        </div>
      </div>
    </Teleport>
  </span>
</template>
