<script setup lang="ts">
// 存储与用量(管理组,功能点 sys.ops):三页——每个人占了多少空间、每个人当天用了多少 AI 额度、全站的分享链接。
// AI 总开关关掉后「AI 额度」一页和页头里的 AI 字样都不出现(直接打开 ?tab=ai 的旧链接回到「存储」)。
// 这里只有统计数字和链接的元数据,看不到任何人的笔记、文件内容或提问。
// 当前页签写进地址(?tab=),刷新和分享地址都停在同一页。
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import { KbPageHeader, KbTabs, type TabItem } from '@kb-ui/index'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import StoragePanel from '@/components/admin/StoragePanel.vue'
import LlmUsagePanel from '@/components/admin/LlmUsagePanel.vue'
import ShareAdminPanel from '@/components/admin/ShareAdminPanel.vue'
import { useFeature } from '@/composables/useFeature'
import { useSessionStore } from '@/stores/session'
import { NO_ACCESS_TEXT } from '@/utils/loadState'

// 入口按功能点隐藏;直接输地址进来时说明原因(后端对每个能力照样检查,这里只是体验)
const allowed = useFeature('sys.ops')

const session = useSessionStore()
const aiOn = computed(() => session.aiEnabled)
const TABS = computed<TabItem[]>(() => [
  { value: 'storage', label: '存储' },
  ...(aiOn.value ? [{ value: 'ai', label: 'AI 额度' }] : []),
  { value: 'shares', label: '分享链接' },
])
const description = computed(() =>
  aiOn.value
    ? '每个人占了多少空间、当天用了多少 AI 额度、全站有哪些分享链接。这里只有统计数字和链接的元数据,看不到任何人的内容。'
    : '每个人占了多少空间、全站有哪些分享链接。这里只有统计数字和链接的元数据,看不到任何人的内容。',
)
const route = useRoute()
const router = useRouter()
const tab = computed({
  get: () => (TABS.value.some((item) => item.value === route.query.tab) ? String(route.query.tab) : 'storage'),
  set: (value: string) => void router.replace({ query: { ...route.query, tab: value === 'storage' ? undefined : value } }),
})
</script>

<template>
  <AppShell>
    <KbPageHeader title="存储与用量" :description="description" />
    <AdminLoadState v-if="!allowed" phase="forbidden" :message="NO_ACCESS_TEXT" />
    <template v-else>
      <KbTabs v-model="tab" :tabs="TABS" class="kb-sticky" data-testid="usage-tabs" />
      <StoragePanel v-if="tab === 'storage'" />
      <LlmUsagePanel v-else-if="tab === 'ai'" />
      <ShareAdminPanel v-else />
    </template>
  </AppShell>
</template>
