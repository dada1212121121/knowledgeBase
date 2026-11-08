<script setup lang="ts">
// 复制按钮(参考 uilab「复制按钮反馈」):点一下复制,图标绕竖轴翻成对勾,上方冒出「已复制」小气泡,2 秒后复原;
// 失败也明说(红叉「复制失败」)。navigator.clipboard 只在 https / localhost 可用,普通 http 页面退回
// 「临时只读 textarea + execCommand('copy')」。
import { computed, onBeforeUnmount, ref } from 'vue'
import KbIcon from './KbIcon.vue'

const props = withDefaults(defineProps<{ text: string | (() => string); label?: string; size?: 'md' | 'sm'; variant?: 'default' | 'primary' }>(), {
  label: '',
  size: 'sm',
  variant: 'default',
})
const emit = defineEmits<{ copied: [ok: boolean] }>()

const state = ref<'idle' | 'ok' | 'fail'>('idle')
let timer = 0

async function writeClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // 被拒绝(权限 / 非安全上下文)就走下面的旧办法
  }
  const area = document.createElement('textarea')
  area.value = value
  area.readOnly = true
  area.setAttribute('aria-hidden', 'true')
  area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0'
  const focused = document.activeElement as HTMLElement | null
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  focused?.focus?.()
  return ok
}

async function copy() {
  const value = typeof props.text === 'function' ? props.text() : props.text
  const ok = await writeClipboard(value)
  state.value = ok ? 'ok' : 'fail'
  emit('copied', ok)
  window.clearTimeout(timer)
  timer = window.setTimeout(() => (state.value = 'idle'), 2000)
}
onBeforeUnmount(() => window.clearTimeout(timer))
const announce = computed(() => (state.value === 'ok' ? '已复制到剪贴板' : state.value === 'fail' ? '复制失败,请手动选择' : ''))
</script>

<template>
  <span class="kb-copy" :class="`is-${state}`">
    <button type="button" class="btn" :class="{ sm: size === 'sm', pri: variant === 'primary' }" :aria-label="label || '复制'" @click="copy">
      <span class="kb-flip" :class="{ 'is-flipped': state !== 'idle' }" aria-hidden="true">
        <span class="kb-flip-face"><KbIcon name="link" :size="14" /></span>
        <span class="kb-flip-face kb-flip-back"><KbIcon :name="state === 'fail' ? 'failed' : 'check'" :size="14" /></span>
      </span>
      <span v-if="label">{{ label }}</span>
    </button>
    <span class="kb-copy-bubble" :class="{ 'is-open': state !== 'idle', 'is-fail': state === 'fail' }" aria-hidden="true">
      <KbIcon :name="state === 'fail' ? 'failed' : 'check'" :size="12" />{{ state === 'fail' ? '复制失败' : '已复制' }}
    </span>
    <span class="kb-sr" role="status">{{ announce }}</span>
  </span>
</template>
