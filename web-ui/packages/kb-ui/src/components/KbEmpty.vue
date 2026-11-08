<script setup lang="ts">
// 空态(设计规范):一句说明 + 一个可点的下一步(action 插槽)。
// size=sm 用在卡片 / 抽屉里(更紧凑);role=status 让读屏软件知道这里是「没有内容」而不是漏渲染。
import KbIcon from './KbIcon.vue'
import type { IconName } from './icons'

withDefaults(defineProps<{ icon?: IconName; title: string; description?: string; size?: 'md' | 'sm' }>(), {
  icon: 'database',
  description: '',
  size: 'md',
})
</script>

<template>
  <div class="kb-empty" :class="{ 'is-sm': size === 'sm' }" role="status">
    <div class="kb-empty-icon"><KbIcon :name="icon" :size="size === 'sm' ? 16 : 20" /></div>
    <div class="kb-empty-title">{{ title }}</div>
    <div v-if="description" class="kb-hint kb-empty-desc">{{ description }}</div>
    <div v-if="$slots.action" class="kb-row"><slot name="action" /></div>
  </div>
</template>
