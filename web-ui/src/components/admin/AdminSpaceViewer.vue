<script setup lang="ts">
// 管理员只读查看别人的知识库:一个全屏弹窗,里面就是平常的「文档 / 任务 / 导入记录」三页。
//
// 不复制第二套界面:三个页面组件都支持 embedded(不套外壳、不改地址栏)+ readonly(不给写入口),
// 能力调用统一带 X-KB-Admin-View,由后端 AdminViewGate 按只读白名单放行。
// 打开弹窗时先调 admin_space_open:确认账号 / 个人知识库可用,并记一条审计;之后每次读写都还会再记。
import { computed, onMounted, ref } from 'vue'
import { KbBadge, KbButton, KbDialog, KbEmpty, KbSegmented, KbSkeleton } from '@kb-ui/index'
import Browser from '@/pages/Browser.vue'
import Jobs from '@/pages/Jobs.vue'
import ImportRecords from '@/components/import/ImportRecords.vue'
import { callCapability } from '@/api/client'
import { formatSize } from '@/utils/files'
import type { RecordFilter } from '@/utils/ingest'

const props = defineProps<{
  /** 目标用户 id(`usr_…`) */
  userId: string
  /** 列表里已经拿到的显示名,弹窗头先用它,摘要回来再补全 */
  name: string
}>()
const emit = defineEmits<{ close: [] }>()

type Tab = 'docs' | 'jobs' | 'import'
const tab = ref<Tab>('docs')
const tabOptions = [
  { value: 'docs', label: '文档' },
  { value: 'jobs', label: '任务' },
  { value: 'import', label: '导入记录' },
]
/** 导入记录页自己的筛选(只读,默认全部) */
const importFilter = ref<RecordFilter>('all')

interface Summary {
  user_id: string
  space_id: string
  username: string
  display_name: string | null
  used_bytes: number
}

const summary = ref<Summary | null>(null)
const loading = ref(true)
const error = ref('')

const title = computed(() => {
  const display = summary.value?.display_name || summary.value?.username || props.name
  return `查看知识库 · ${display}`
})
const subtitle = computed(() => {
  const value = summary.value
  if (!value) return '只读查看,你的每一步都会记入系统审计'
  return `@${value.username} · 已用 ${formatSize(value.used_bytes)} · 只读查看,你的每一步都会记入系统审计`
})

async function open() {
  loading.value = true
  error.value = ''
  try {
    // 这一发不带 X-KB-Admin-View:它要按管理员的身份确认目标账号,不是读目标库
    summary.value = await callCapability<Summary>('admin_space_open', { user_id: props.userId })
  } catch (err) {
    error.value = err instanceof Error ? err.message : '没能打开这个用户的知识库'
  } finally {
    loading.value = false
  }
}
onMounted(open)
</script>

<template>
  <KbDialog plain class="kb-inspect-dialog" :title="title" :subtitle="subtitle" width="min(1680px, 97vw)" @close="emit('close')">
    <div class="kb-inspect">
      <div v-if="!error" class="kb-inspect-bar">
        <KbSegmented :model-value="tab" :options="tabOptions" @update:model-value="(value: string) => (tab = value as Tab)" />
        <span class="kb-spacer"></span>
        <KbBadge tone="neutral">只读</KbBadge>
      </div>

      <div v-if="loading" class="kb-inspect-state">
        <KbSkeleton variant="card" :lines="6" />
      </div>
      <div v-else-if="error" class="kb-inspect-state">
        <KbEmpty icon="failed" title="没能打开这个用户的知识库" :description="error">
          <template #action><KbButton size="sm" variant="primary" @click="open">重试</KbButton></template>
        </KbEmpty>
      </div>
      <div v-else class="kb-inspect-body">
        <!-- 三个页面都用平常的组件,只是 embedded + readonly;切页签才挂载,不一次读三个库的首页 -->
        <Browser v-if="tab === 'docs'" embedded readonly :view-as="userId" />
        <Jobs v-else-if="tab === 'jobs'" embedded readonly :view-as="userId" />
        <ImportRecords v-else :filter="importFilter" batch="" readonly :view-as="userId" @update:filter="(value: RecordFilter) => (importFilter = value)" />
      </div>
    </div>
  </KbDialog>
</template>

<style scoped>
/* 弹窗基本占满视口:里面是完整的工作台,留太多边只会把双栏挤窄 */
:global(.kb-inspect-dialog) {
  width: min(1680px, calc(100vw - 24px));
  height: calc(100vh - 24px);
  height: calc(100dvh - 24px);
  max-height: calc(100vh - 24px);
  max-height: calc(100dvh - 24px);
}
:global(.kb-inspect-dialog > .kb-dialog-body) {
  display: flex;
  overflow: hidden;
}
.kb-inspect {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}
.kb-inspect-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: none;
  padding: var(--sp-2) var(--card-pad-x);
  border-bottom: var(--hl) solid var(--b);
}
.kb-inspect-state {
  padding: var(--card-pad);
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.kb-inspect-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.kb-inspect-body > * {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}
/* 导入记录页自己不是滚动容器:在弹窗里给它一个,否则长列表会被裁掉 */
.kb-inspect-body > :deep(.kb-rec) {
  overflow-y: auto;
}
@media (max-width: 599px) {
  :global(.kb-inspect-dialog) {
    width: 100%;
    height: calc(100dvh - 16px);
    max-height: calc(100dvh - 16px);
  }
}
</style>
