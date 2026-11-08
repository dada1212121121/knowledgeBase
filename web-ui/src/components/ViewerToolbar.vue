<script setup lang="ts">
/**
 * 多格式文件查看器通用顶栏 (ViewerToolbar)
 *
 * 统一 PDF / Word / PPT / 表格 / 代码 / 文本 / 归档 / 图片等多格式查看器的顶栏交互标准：
 * - 左侧 (start): 文件名、状态、缩略图/目录开关、页码指示
 * - 中间 (center): 翻页、缩放控制器、视图模式切换
 * - 居右 (end/tools): 搜索、反色/全屏、文字层切换及原件操作
 */
withDefaults(
  defineProps<{
    ariaLabel?: string
    /** 是否固定在查看器顶部(默认 true) */
    sticky?: boolean
  }>(),
  {
    ariaLabel: '查看器工具栏',
    sticky: true,
  },
)
</script>

<template>
  <header
    class="kb-vbar"
    :class="{ 'is-sticky': sticky }"
    role="toolbar"
    :aria-label="ariaLabel"
  >
    <div class="kb-vbar-start">
      <slot name="start" />
      <slot />
    </div>

    <div v-if="$slots.center" class="kb-vbar-center">
      <slot name="center" />
    </div>

    <div class="kb-vbar-end">
      <slot name="end" />
      <slot name="tools" />
    </div>
  </header>
</template>

<style>
.kb-vbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  min-height: calc(var(--ctl-h) + 12px);
  padding: 4px var(--sp-2);
  background: var(--surface-1);
  border-bottom: var(--hl) solid var(--b);
  box-sizing: border-box;
  flex: none;
  z-index: 2;
  overflow-x: auto;
  scrollbar-width: none;
}
.kb-vbar::-webkit-scrollbar {
  display: none;
}
.kb-vbar.is-sticky {
  position: sticky;
  top: 0;
}
.kb-vbar-start,
.kb-vbar-center,
.kb-vbar-end {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  flex: none;
}
.kb-vbar-start {
  min-width: 0;
  flex: 1 1 auto;
}
.kb-vbar-center {
  justify-content: center;
  flex: 0 0 auto;
}
.kb-vbar-end {
  margin-left: auto;
  justify-content: flex-end;
  flex: 0 0 auto;
}

/* 工具栏内常见元素通用样式对齐 */
.kb-vbar .btn.sm {
  min-width: var(--ctl-h);
  height: var(--ctl-h);
  padding: 0 6px;
}
.kb-vbar .mono {
  font-size: var(--text-12);
}

@media (pointer: coarse) {
  .kb-vbar {
    min-height: 44px;
    padding: 2px var(--sp-2);
  }
  /* 图标按钮（翻页、缩放、缩略图）宽度也要 ≥44px：以前只有 36，触屏点不准（a7-touch-viewers 守着） */
  .kb-vbar .btn.sm {
    min-width: 44px;
    height: 36px;
  }
}
</style>
