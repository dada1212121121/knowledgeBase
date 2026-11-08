<script setup lang="ts">
// 手机(以及竖屏的折叠屏 / 小平板)底部标签栏:首页、知识库、搜索、通知、我的。
//
// 通知不是页面而是抽屉,所以它是 <button>,其余是链接;「我的」是进入其余所有入口的地方
// (侧栏在手机上不存在,也不再有汉堡抽屉)。位置固定在内容下方的正常流里,不压住内容;
// 底部留出刘海屏的安全区。
import { KbIcon, type IconName } from '@kb-ui/index'
import { RouterLink } from 'vue-router'

export interface TabEntry {
  id: string
  label: string
  icon: IconName
  /** 链接目标;没有就是按钮(通知) */
  to?: string
  active: boolean
  /** 红色数字角标 */
  count?: number
}

defineProps<{ tabs: TabEntry[] }>()
defineEmits<{ action: [id: string] }>()
</script>

<template>
  <nav class="kb-tabbar" aria-label="主导航" data-testid="tabbar">
    <template v-for="tab in tabs" :key="tab.id">
      <RouterLink
        v-if="tab.to"
        class="kb-tab"
        :class="{ on: tab.active }"
        :to="tab.to"
        :aria-current="tab.active ? 'page' : undefined"
        :data-tab="tab.id"
      >
        <KbIcon :name="tab.icon" :size="22" /><span class="kb-tab-label">{{ tab.label }}</span>
      </RouterLink>
      <button
        v-else
        type="button"
        class="kb-tab"
        :class="{ on: tab.active }"
        :aria-label="tab.count ? `${tab.label},${tab.count} 条未读` : tab.label"
        :data-tab="tab.id"
        @click="$emit('action', tab.id)"
      >
        <KbIcon :name="tab.icon" :size="22" /><span class="kb-tab-label">{{ tab.label }}</span>
        <em v-if="tab.count" class="kb-tab-badge" :data-testid="`tab-badge-${tab.id}`">{{ tab.count > 99 ? '99+' : tab.count }}</em>
      </button>
    </template>
  </nav>
</template>
