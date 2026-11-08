<script setup lang="ts">
// 底部弹层(设计规范:弹层与手势):手机上的筛选、分享面板、选择器用它。
//   - 从底部升起,顶部有把手;把手(或标题栏)向下拖超过阈值 / 速度够快就关闭——不依赖屏幕边缘手势;
//   - 点遮罩、按 Esc、点右上角关闭都能关;打开时焦点进弹层并在其中循环,关闭后还给打开前的元素;
//   - 底部留出刘海屏的安全区;高度不超过可视视口(软键盘弹出时跟着缩,输入框不会被挡住)。
// 桌面上的「对话框」用 KbDialog;窄屏上 KbDialog 自己也会变成贴底 sheet。KbSheet 是「任何宽度都从底部出」的版本。
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import KbIcon from './KbIcon.vue'
import { useSwipeDismiss } from '../composables/useSwipeDismiss'

// noAutofocus:弹层里有输入框但不该一打开就弹出软键盘(分享面板)时,只把焦点放在弹层上
const props = withDefaults(defineProps<{ title: string; closeOnScrim?: boolean; noAutofocus?: boolean }>(), { closeOnScrim: true, noAutofocus: false })
const emit = defineEmits<{ close: [] }>()

const card = ref<HTMLElement | null>(null)
const titleId = `kb-sheet-${Math.random().toString(36).slice(2, 8)}`
let opener: HTMLElement | null = null

const swipe = useSwipeDismiss(card, { onDismiss: () => emit('close') })

function focusables(): HTMLElement[] {
  return [...(card.value?.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? [])].filter((el) => !el.hasAttribute('disabled'))
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    // 弹层上面还压着别的东西时,Esc 留给它:展开的下拉菜单(菜单自己收)、确认框(自己取消),不连带关掉整个弹层
    if (document.querySelector('.kb-pop-layer[data-open="true"], .kb-confirm-wrap')) return
    event.stopPropagation()
    emit('close')
  } else if (event.key === 'Tab') {
    const items = focusables()
    if (!items.length) return
    const first = items[0]!
    const last = items[items.length - 1]!
    if (event.shiftKey && document.activeElement === first) (event.preventDefault(), last.focus())
    else if (!event.shiftKey && document.activeElement === last) (event.preventDefault(), first.focus())
  }
}
onMounted(async () => {
  opener = document.activeElement as HTMLElement | null
  await nextTick()
  const first = props.noAutofocus ? null : card.value?.querySelector<HTMLElement>('input,textarea,select')
  ;(first ?? card.value)?.focus({ preventScroll: true })
  document.addEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true)
  opener?.focus?.({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <Transition name="kb-sheet" appear>
      <div class="kb-sheet-wrap">
        <div class="kb-sheet-scrim" @click="props.closeOnScrim && emit('close')"></div>
        <section
          ref="card"
          class="kb-sheet"
          :class="{ 'is-dragging': swipe.dragging.value }"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
          data-testid="sheet"
          :style="swipe.offset.value ? { transform: `translateY(${swipe.offset.value}px)` } : undefined"
          style-allow="下滑关闭时弹层跟手移动"
        >
          <div class="kb-sheet-grab" data-testid="sheet-grab" v-bind="swipe.bind">
            <i class="kb-sheet-handle" aria-hidden="true"></i>
            <div class="kb-sheet-head">
              <b :id="titleId" class="kb-sheet-title">{{ title }}</b>
              <button type="button" class="kb-icon-btn" aria-label="关闭" @pointerdown.stop @click="emit('close')"><KbIcon name="close" :size="16" /></button>
            </div>
          </div>
          <div class="kb-sheet-body"><slot /></div>
          <footer v-if="$slots.footer" class="kb-sheet-foot"><slot name="footer" /></footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
