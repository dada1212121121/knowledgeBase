<script setup lang="ts">
// 水印:链接开了水印时在整页上铺「访问者 · 时间」。只是不显眼的提示,无法阻止截屏(设置里已如实说明)。
// 不拦截点击(pointer-events: none),读屏软件也跳过它(aria-hidden)。
import { WATERMARK_TILES } from '@/utils/publicShare'

defineProps<{ text: string }>()
</script>

<template>
  <div class="kb-wm" aria-hidden="true" data-testid="public-watermark">
    <span v-for="index in WATERMARK_TILES" :key="index" class="kb-wm-tile">{{ text }}</span>
  </div>
</template>

<style>
/* 旋转后的水印块本来就比屏幕大:用 clip-path 裁到屏幕内,而不是 overflow:hidden——这样它不是“裁掉内容的容器”(版面巡检会把后者当成缺陷),
   固定定位的层也不会撑出页面的横向滚动 */
.kb-wm { position: fixed; inset: 0; z-index: 20; overflow: visible; clip-path: inset(0); pointer-events: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); align-content: space-around; gap: var(--sp-6); padding: var(--sp-5); transform: rotate(-18deg) scale(1.4); }
.kb-wm-tile { color: var(--text-primary); opacity: 0.07; font-size: var(--text-14); white-space: nowrap; text-align: center; user-select: none; }
</style>
