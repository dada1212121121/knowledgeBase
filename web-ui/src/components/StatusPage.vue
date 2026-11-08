<script setup lang="ts">
// 错误与状态页的统一外观(设计规范「错误与状态页」):居中的 图标 + 标题 + 说明 + 操作。
// 404、服务不可用、公开分享页的失效 / 过期 / 需要登录都用它,样式只在这一处。
// 没开通某个功能的提示不用它:那是页面里的一块内容(KbEmpty),不是整页状态。
import { KbEmpty } from '@kb-ui/index'
import type { IconName } from '@kb-ui/components/icons'

defineProps<{ icon: IconName; title: string; description?: string }>()
</script>

<template>
  <div class="kb-status-page" data-testid="status-page">
    <div class="kb-status-box">
      <KbEmpty :icon="icon" :title="title" :description="description">
        <template v-if="$slots.default" #action><slot /></template>
      </KbEmpty>
      <div v-if="$slots.detail" class="kb-status-detail"><slot name="detail" /></div>
    </div>
  </div>
</template>

<style>
.kb-status-page { display: flex; justify-content: center; padding: var(--sp-6) var(--sp-4); min-width: 0; }
.kb-status-box { display: flex; flex-direction: column; align-items: center; gap: var(--sp-3); width: 100%; max-width: 32rem; min-width: 0; }
.kb-status-page .btn { text-decoration: none; }
.kb-status-detail { max-width: 100%; text-align: center; font-size: var(--text-12); color: var(--text-tertiary); overflow-wrap: anywhere; }
</style>
