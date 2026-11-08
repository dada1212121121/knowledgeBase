<script setup lang="ts">
// 正文占位骨架:编辑器 chunk 还在路上时先把版式占住,避免标题之后整块空白再「跳」一下。
// 只画结构不画内容,所以不需要 props;宽高按正文行高走,加载完成后尺寸基本对得上。
</script>

<template>
  <div class="kb-doc-skeleton" role="status" aria-busy="true" aria-label="正文加载中">
    <span class="kb-doc-skeleton-line skel is-title"></span>
    <span class="kb-doc-skeleton-line skel"></span>
    <span class="kb-doc-skeleton-line skel is-short"></span>
    <span class="kb-doc-skeleton-line skel"></span>
    <span class="kb-doc-skeleton-line skel is-short"></span>
  </div>
</template>

<style>
/* 线条用项目的 .skel（motion.css）：底色、transform 扫光、动效档位「减少」时不动，都由它负责；这里只管版式。
   整块晚一点才淡入（和 .kb-skel 同一个延迟）：很快加载完的页面不会闪一下骨架 */
.kb-doc-skeleton {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 6px 0 12px;
  animation: kb-skel-in var(--dur-base) var(--ease-out) both;
  animation-delay: 120ms; /* motion-allow: 与 .kb-skel 同一个延迟,令牌里没有这个值 */
}
.kb-doc-skeleton-line {
  height: 14px;
}
.kb-doc-skeleton-line.is-title {
  width: 42%;
  height: 22px;
}
.kb-doc-skeleton-line.is-short {
  width: 64%;
}
</style>
