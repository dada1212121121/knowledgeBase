<script setup lang="ts">
// 操作进度 / 结果。删除文件夹可能是几千个文件,按钮转圈不够说明「还在做事、做到哪了」。
import { computed } from 'vue'
import type { FileOp } from './types'

const props = defineProps<{ busy: boolean; result: FileOp | null }>()
const percent = computed(() => {
  const op = props.result
  if (!op || !op.total) return 0
  return Math.min(100, Math.round((op.done / op.total) * 100))
})
const label = computed(() => {
  if (props.busy) return '正在处理…大文件夹需要一点时间,请不要关闭页面'
  const op = props.result
  if (!op) return ''
  if (op.state === 'done') return `完成:${op.done}/${op.total} 项`
  if (op.state === 'partial') return `部分完成:${op.done}/${op.total} 项,${op.failed} 项失败`
  if (op.state === 'rolled_back') return '失败,已经回滚到操作前'
  return `失败:${op.error || '未知原因'}`
})
</script>

<template>
  <div v-if="busy || result" class="kb-file-progress" aria-live="polite" data-testid="file-op-progress">
    <div class="kb-file-progress-label">{{ label }}</div>
    <div v-if="busy" class="kb-file-progress-track is-indeterminate"><i></i></div>
    <div v-else-if="result?.total" class="kb-file-progress-track"><i :style="{ width: `${percent}%` }"></i></div>
  </div>
</template>

<style scoped>
.kb-file-progress { display: grid; gap: 7px; margin-top: 12px; }
.kb-file-progress-label { color: var(--m); font-size: var(--text-12); line-height: 1.5; }
.kb-file-progress-track { height: 5px; overflow: hidden; border-radius: 99px; background: var(--hover); }
.kb-file-progress-track i { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width 200ms ease; }
.kb-file-progress-track.is-indeterminate i { width: 36%; animation: kb-file-slide 1.2s ease-in-out infinite; }
@keyframes kb-file-slide { from { transform: translateX(-110%); } to { transform: translateX(300%); } }
</style>
