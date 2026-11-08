<script setup lang="ts">
// AI 助手的独立页面:和外壳里 ⌘J 呼出的右侧抽屉是同一个组件(AssistantDrawer 的 page 模式),
// 只是铺满内容区、宽屏时左边常驻会话列表、手机上占满页面。以前这里是另一份 700 行的实现,两边功能和修复总对不上。
// 账号没有 ai.assistant 或 AI 总开关关着:显示「没有开通」,不渲染助手(也不发任何请求)。
import { computed } from 'vue'
import { KbEmpty } from '@kb-ui/index'
import AppShell from '@/layouts/AppShell.vue'
import AssistantDrawer from '@/components/AssistantDrawer.vue'
import { useFeature } from '@/composables/useFeature'
import { useSessionStore } from '@/stores/session'

const enabled = useFeature('ai.assistant')
const session = useSessionStore()
// AI 总开关关着时,「没有开通」页的标题和说明都不能带「AI」字样(术语表:关闭后全站无 AI 字样),
// 路由表里这一页叫「AI 助手」,所以顶栏标题也要换掉;只是角色没勾这个功能(总开关开着)时照旧写清楚是哪个功能
const aiOff = computed(() => !session.aiEnabled)
const offTitle = computed(() => (!enabled.value && aiOff.value ? '功能未开通' : undefined))
const offText = computed(() => (aiOff.value ? '请联系管理员。' : 'AI 助手需要管理员为你的账号开通。请联系管理员。'))
</script>

<template>
  <AppShell bare :title="offTitle">
    <div v-if="enabled" class="kb-assistant-page">
      <AssistantDrawer mode="page" />
    </div>
    <div v-else class="content">
      <KbEmpty icon="lock" title="你的账号没有开通这个功能" :description="offText" data-testid="assistant-off" />
    </div>
  </AppShell>
</template>

<style scoped>
/* 占满外壳的内容区(顶栏以下、手机标签栏以上),对话列表在里面自己滚动 */
.kb-assistant-page { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; height: 100%; }
.kb-assistant-page > * { flex: 1 1 auto; min-height: 0; }
</style>
