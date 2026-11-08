<script setup lang="ts">
// 表单底部操作条（设计规范）:保存 / 取消固定在内容区底部,不用滚到最下面才找得到保存。
//   - sticky 贴在滚动容器底部,避开刘海屏底部横条(safe-area);
//   - 软键盘弹出时跟着键盘上沿走(外壳把键盘占用高度写进 --kb-kbd-inset);
//   - dirty 时左侧显示「有未保存的修改」。
withDefaults(defineProps<{ dirty?: boolean; dirtyText?: string }>(), { dirty: false, dirtyText: '有未保存的修改' })
</script>

<template>
  <div class="kb-actionbar" :class="{ 'is-dirty': dirty }" role="group" aria-label="操作">
    <span v-if="dirty" class="kb-actionbar-note" role="status">{{ dirtyText }}</span>
    <span v-else-if="$slots.note" class="kb-actionbar-note"><slot name="note" /></span>
    <div class="kb-actionbar-actions"><slot /></div>
  </div>
</template>
