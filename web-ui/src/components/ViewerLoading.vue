<script setup lang="ts">
// 查看器 chunk / 原件加载中的占位:不闪烁(父级给了 delay),高度撑满,避免内容区先塌后涨。
defineProps<{ label?: string }>()
</script>

<template>
  <div class="kb-vl" role="status">
    <span class="kb-vl-dot" aria-hidden="true"></span>
    <span class="m">{{ label ?? '正在加载查看器…' }}</span>
  </div>
</template>

<style>
.kb-vl {
  flex: 1;
  min-height: calc(var(--row-h) * 6);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  background: var(--surface-sunken);
}
.kb-vl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: kb-vl-pulse 1s var(--ease-in-out) infinite alternate;
}
@keyframes kb-vl-pulse {
  from {
    opacity: 0.25;
  }
  to {
    opacity: 1;
  }
}
</style>
