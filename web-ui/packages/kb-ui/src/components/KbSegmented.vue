<script setup lang="ts">
// 分段控件(参考 uilab「分段控件」):选中块是一块会滑动的胶囊,点另一段它滑过去(spring 曲线),
// 不是各段各自换底色。键盘:← → 切换并聚焦(两端绕回),Home / End;只有选中项在 Tab 序列里。
import { ref } from 'vue'
import { useSlider } from '../motion/useSlider'

const props = defineProps<{ modelValue: string; options: { value: string; label: string }[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const root = ref<HTMLElement | null>(null)
const { style, ready } = useSlider(root, 'i', () => props.modelValue)

function move(delta: number) {
  const list = props.options
  const index = list.findIndex((option) => option.value === props.modelValue)
  const next = list[(index + delta + list.length) % list.length]
  if (!next) return
  emit('update:modelValue', next.value)
  requestAnimationFrame(() => root.value?.querySelector<HTMLElement>('i[data-active="true"]')?.focus())
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') (event.preventDefault(), move(1))
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') (event.preventDefault(), move(-1))
  else if (event.key === 'Home') (event.preventDefault(), move(-props.options.length))
  else if (event.key === 'End') (event.preventDefault(), move(props.options.length - 1))
}
</script>

<template>
  <span ref="root" class="seg kb-seg" :class="{ 'is-ready': ready }" role="tablist" @keydown="onKey">
    <span class="kb-seg-thumb" :style="style" aria-hidden="true" style-allow="滑块位置由量出的选中项决定"></span>
    <i
      v-for="option in options"
      :key="option.value"
      role="tab"
      :class="{ on: option.value === modelValue }"
      :data-active="option.value === modelValue"
      :aria-selected="option.value === modelValue"
      :tabindex="option.value === modelValue ? 0 : -1"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </i>
  </span>
</template>
