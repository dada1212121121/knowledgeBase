<script setup lang="ts">
// 确认弹窗宿主(全应用挂一次)。节奏参考 uilab「确认弹窗」:
//   卡片 0.9→1 带回弹长出;点确认后不急着关——问题与按钮淡出、卡片高度平滑变矮,
//   一个圆里一笔画出对勾,「已删除」淡入;停约 0.8 秒再收起。
//   无障碍:role=alertdialog;破坏性操作先聚焦「取消」;Tab 在两个按钮间循环;Esc 取消。
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import KbIcon from './KbIcon.vue'
import { acceptConfirm, cancelConfirm, confirmState, escapeConfirm } from './useConfirm'

const card = ref<HTMLElement | null>(null)
const askLayer = ref<HTMLElement | null>(null)
const doneLayer = ref<HTMLElement | null>(null)
const cancelBtn = ref<HTMLButtonElement | null>(null)
const okBtn = ref<HTMLButtonElement | null>(null)
const height = ref<number | null>(null)
let opener: HTMLElement | null = null
let observer: ResizeObserver | null = null

const titleId = 'kb-confirm-title'
const descId = 'kb-confirm-desc'

function measure() {
  const layer = confirmState.phase === 'done' ? doneLayer.value : askLayer.value
  if (layer) height.value = layer.offsetHeight
}

// 键盘监听挂在 window 的捕获阶段,而不是 document:确认常常是从对话框 / 底部弹层里发起的,
// 它们也在 document 上监听 Esc;window 的捕获先于 document,这里 stopPropagation 之后下面的对话框就收不到,
// 按 Esc 只取消确认,不会连发起确认的对话框一起关掉。
function onKey(event: KeyboardEvent) {
  if (!confirmState.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    escapeConfirm()
  } else if (event.key === 'Tab' && confirmState.phase === 'ask') {
    const buttons = [cancelBtn.value, okBtn.value].filter(Boolean) as HTMLElement[]
    const index = buttons.indexOf(document.activeElement as HTMLElement)
    event.preventDefault()
    const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length
    buttons[next]?.focus()
  }
}

watch(
  () => confirmState.open,
  async (open) => {
    if (open) {
      opener = document.activeElement as HTMLElement | null
      window.addEventListener('keydown', onKey, true)
      await nextTick()
      measure()
      if (card.value && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measure)
        if (askLayer.value) observer.observe(askLayer.value)
      }
      // 破坏性操作先聚焦最不危险的按钮
      ;(confirmState.options.tone === 'danger' ? cancelBtn.value : okBtn.value)?.focus({ preventScroll: true })
    } else {
      window.removeEventListener('keydown', onKey, true)
      observer?.disconnect()
      observer = null
      opener?.focus?.({ preventScroll: true })
    }
  },
)
watch(
  () => confirmState.phase,
  async (phase) => {
    await nextTick()
    measure()
    if (phase === 'done') card.value?.focus({ preventScroll: true })
  },
)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
  observer?.disconnect()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="kb-dlg">
      <div v-if="confirmState.open" class="kb-dlg-wrap kb-confirm-wrap">
        <div class="kb-dlg-scrim"></div>
        <div
          ref="card"
          class="kb-dialog kb-confirm"
          :class="`is-${confirmState.phase}`"
          role="alertdialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :aria-describedby="descId"
          tabindex="-1"
          :style="height != null ? { height: `${height}px` } : undefined"
          style-allow="卡片高度跟随当前层"
        >
          <div ref="askLayer" class="kb-confirm-layer kb-confirm-ask" :aria-hidden="confirmState.phase === 'done'">
            <div class="kb-confirm-text">
              <b :id="titleId" class="kb-confirm-title">{{ confirmState.options.title }}</b>
              <p v-if="confirmState.options.message" :id="descId" class="kb-confirm-msg">{{ confirmState.options.message }}</p>
              <p v-if="confirmState.error" class="kb-confirm-err" role="alert">{{ confirmState.error }}</p>
            </div>
            <div class="kb-confirm-actions">
              <button ref="cancelBtn" type="button" class="btn kb-confirm-btn" :disabled="confirmState.phase === 'busy'" @click="cancelConfirm">
                {{ confirmState.options.cancelText ?? '取消' }}
              </button>
              <button
                ref="okBtn"
                type="button"
                class="btn kb-confirm-btn"
                :class="confirmState.options.tone === 'danger' ? 'is-danger' : 'pri'"
                :disabled="confirmState.phase === 'busy'"
                @click="acceptConfirm"
              >
                <span v-if="confirmState.phase === 'busy'" class="kb-spinner"></span>
                {{ confirmState.error ? '重试' : (confirmState.options.confirmText ?? '确认') }}
              </button>
            </div>
          </div>
          <!-- 完成层:一直在 DOM 里(透明),第一次出现时不会临时加载字体或抖动 -->
          <div ref="doneLayer" class="kb-confirm-layer kb-confirm-done" :aria-hidden="confirmState.phase !== 'done'">
            <span class="kb-confirm-tick" :class="{ 'is-danger': confirmState.options.tone === 'danger' }">
              <svg class="kb-tick" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path v-if="confirmState.phase === 'done'" d="M4 8.4l2.6 2.6L12 5.4" />
              </svg>
            </span>
            <span class="kb-confirm-done-text" role="status">{{ confirmState.options.doneText }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
