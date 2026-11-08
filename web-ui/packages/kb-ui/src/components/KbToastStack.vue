<script setup lang="ts">
// Toast 容器:右上角堆叠,新的在最上面;进场从右侧带回弹滑入,离场淡出右移,其余的平滑让位。
// 倒计时细条沿底边收缩(鼠标停留暂停);点击关闭。需要在应用根部挂载一次(ShellFrame / Login)。
import { dismissToast, toasts } from './useToast'
import KbIcon from './KbIcon.vue'
</script>

<template>
  <Teleport to="body">
    <div class="kb-toasts" role="region" aria-label="通知" aria-live="polite">
      <TransitionGroup name="kb-toast" tag="div" class="kb-toast-list">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="kb-toast"
          :class="`is-${toast.tone}`"
          role="status"
          @click="dismissToast(toast.id)"
        >
          <span class="kb-toast-icon">
            <KbIcon :name="toast.tone === 'success' ? 'check' : toast.tone === 'danger' ? 'failed' : 'clock'" :size="14" />
          </span>
          <span class="kb-toast-text">{{ toast.message }}</span>
          <i class="kb-toast-timer" :style="{ animationDuration: `${toast.duration}ms` }" style-allow="倒计时时长" @animationend="dismissToast(toast.id)"></i>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
