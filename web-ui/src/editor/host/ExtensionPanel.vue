<script setup lang="ts">
/**
 * 扩展面板的挂载点
 *
 * 为什么单独一个组件：面板的内容是扩展用原生 DOM 画的，生命周期要和 Vue 组件严格对应——
 * 组件挂载时调 `mount(panel, el)`，卸载时（用户收起面板、扩展被卸载、编辑器关闭）必须调它返回的清理函数。
 * `mount` 可能是异步的，所以「还没挂完就被卸载」时要等它挂完立刻清理，否则会泄漏事件监听和定时器。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { PanelInfo } from '../extensions/registry'

const props = defineProps<{
  panel: PanelInfo
  /** 往 el 里画面板并返回清理函数（Host 把注册表的 mountPanel 绑好当前编辑器后传进来） */
  mount: (panel: PanelInfo, el: HTMLElement) => Promise<() => void>
}>()
const emit = defineEmits<{ close: [] }>()

const body = ref<HTMLElement | null>(null)
let cleanup: (() => void) | null = null
let unmounted = false

onMounted(async () => {
  if (!body.value) return
  const result = await props.mount(props.panel, body.value)
  if (unmounted) result()
  else cleanup = result
})

onBeforeUnmount(() => {
  unmounted = true
  cleanup?.()
  cleanup = null
})
</script>

<template>
  <section class="kb-editor-ext-panel" :aria-label="panel.title" :data-ext-panel="panel.key" data-testid="editor-ext-panel">
    <div class="kb-editor-ext-panel-head">
      <span>{{ panel.title }}</span>
      <button type="button" class="btn sm" :aria-label="`收起${panel.title}`" @click="emit('close')">收起</button>
    </div>
    <div ref="body" class="kb-editor-ext-panel-body" data-testid="editor-ext-panel-body"></div>
  </section>
</template>

<style>
.kb-editor-ext-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  padding: 4px 0 2px;
  border-top: var(--hl) dashed var(--border-default);
}
.kb-editor-ext-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
}
.kb-editor-ext-panel-body {
  overflow: auto;
  color: var(--text-primary);
  font-size: calc(13px * var(--fs));
}
</style>
