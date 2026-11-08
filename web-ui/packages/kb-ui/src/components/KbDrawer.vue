<script setup lang="ts">
// 抽屉(设计规范):从右侧滑入(spring-soft 曲线),遮罩淡入;Esc / 点遮罩关闭。
// 它是模态的(aria-modal):打开时焦点进抽屉、Tab 在抽屉内循环(不会跑到后面的页面上),关闭后焦点还给打开前的元素。
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ title: string }>()
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement | null>(null)
const titleId = `kb-drw-${Math.random().toString(36).slice(2, 8)}`
let opener: HTMLElement | null = null

function focusables(): HTMLElement[] {
  return [...(panel.value?.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? [])].filter((el) => !el.hasAttribute('disabled'))
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    // 抽屉上面还压着别的东西时,Esc 留给它(展开的下拉菜单、确认框),不连带关掉整个抽屉——与 KbDialog 一致
    if (document.querySelector('.kb-pop-layer[data-open="true"], .kb-confirm-wrap')) return
    event.stopPropagation()
    emit('close')
  } else if (event.key === 'Tab') {
    // 头部永远有「关闭」按钮,所以至少有一个可聚焦的控件
    const items = focusables()
    const first = items[0]!
    const last = items[items.length - 1]!
    const active = document.activeElement
    // 刚打开时焦点在抽屉本身(不在任何控件上):Shift+Tab 也要绕回最后一个,不能跑出去
    if (event.shiftKey && (active === first || active === panel.value)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }
}
onMounted(async () => {
  opener = document.activeElement as HTMLElement | null
  await nextTick()
  panel.value?.focus({ preventScroll: true })
  document.addEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true)
  opener?.focus?.({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <Transition name="kb-drw" appear>
      <div class="kb-drw-wrap">
        <div class="kb-dlg-scrim" @click="emit('close')"></div>
        <aside ref="panel" class="kb-drawer" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1">
          <div class="kb-drawer-head">
            <b :id="titleId" class="kb-dialog-title">{{ title }}</b>
            <span class="kb-spacer"><button type="button" class="btn sm" @click="emit('close')">关闭</button></span>
          </div>
          <div class="kb-drawer-body"><slot /></div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>
