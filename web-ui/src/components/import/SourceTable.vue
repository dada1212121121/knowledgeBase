<script setup lang="ts">
// 数据来源表:电脑是表格,手机变卡片(类型图标 + 名称 + 状态 + 文件数 + 最近同步),点一行看详情,行末「同步」。
// 数据由页面传进来(useSources),这里只负责画。
import { KbBadge, KbButton, KbIcon, KbResponsiveTable, type RtColumn } from '@kb-ui/index'
import { KIND_ICON, kindText, since, statusTag, type SourceRow, type SourceStats } from '@/utils/importSources'

defineProps<{
  rows: SourceRow[]
  stats: Record<string, SourceStats>
  /** 正在同步 / 移除的来源编号(那一行的按钮置灰) */
  busy: string
  loading?: boolean
  empty?: string
}>()
const emit = defineEmits<{ open: [row: SourceRow]; sync: [row: SourceRow] }>()

// mobile:卡片的版式在 card 插槽里自己排,这里只标哪些列在卡片里算次要信息
const columns: RtColumn[] = [
  { key: 'name', label: '名称 / 位置', mobile: 'primary' },
  { key: 'kind', label: '类型', cellClass: 'm', mobile: 'meta' },
  { key: 'files', label: '文件', cellClass: 'mono', mobile: 'meta' },
  { key: 'status', label: '状态', mobile: 'meta' },
  { key: 'synced', label: '最近同步', cellClass: 'm', mobile: 'meta' },
]
const as = (row: unknown) => row as SourceRow
const fmt = (value: number) => value.toLocaleString()
</script>

<template>
  <KbResponsiveTable
    class="kb-srct"
    :columns="columns"
    :rows="(rows as unknown as Record<string, unknown>[])"
    :loading="loading"
    :empty="empty ?? '还没有数据来源'"
    clickable
    @row-click="(row) => emit('open', as(row))"
  >
    <template #cell-name="{ row }">
      <div class="kb-srct-name">
        <span class="kb-srct-ico"><KbIcon :name="KIND_ICON[as(row).kind]" :size="14" /></span>
        <span class="kb-srct-text">
          <span class="kb-srct-title">{{ as(row).name }}</span>
          <span class="m mono kb-srct-uri" :title="as(row).uri">{{ as(row).uri }}</span>
        </span>
      </div>
    </template>
    <template #cell-kind="{ row }">{{ kindText(as(row)) }}</template>
    <template #cell-files="{ row }">
      <span>{{ fmt(as(row).files) }}</span>
      <span v-if="stats[as(row).id]?.today" class="m kb-srct-today"> +{{ stats[as(row).id]!.today }} 今天</span>
    </template>
    <template #cell-status="{ row }">
      <KbBadge :tone="statusTag(as(row)).tone" :title="as(row).last_error ?? undefined">{{ statusTag(as(row)).text }}</KbBadge>
      <span v-if="stats[as(row).id]?.failed || stats[as(row).id]?.quarantined" class="m kb-srct-bad">
        {{ stats[as(row).id]!.failed }} 失败<template v-if="stats[as(row).id]!.quarantined"> · {{ stats[as(row).id]!.quarantined }} 隔离</template>
      </span>
    </template>
    <template #cell-synced="{ row }">{{ since(as(row)) }}</template>

    <template #card="{ row }">
      <div class="kb-srct-card" data-testid="source-card">
        <div class="kb-srct-name">
          <span class="kb-srct-ico"><KbIcon :name="KIND_ICON[as(row).kind]" :size="14" /></span>
          <span class="kb-srct-text">
            <span class="kb-srct-title">{{ as(row).name }}</span>
            <span class="m mono kb-srct-uri" :title="as(row).uri">{{ as(row).uri }}</span>
          </span>
          <KbBadge class="kb-srct-state" :tone="statusTag(as(row)).tone">{{ statusTag(as(row)).text }}</KbBadge>
        </div>
        <div class="m kb-srct-line">{{ kindText(as(row)) }} · {{ fmt(as(row).files) }} 个文件<template v-if="stats[as(row).id]?.today"> · +{{ stats[as(row).id]!.today }} 今天</template></div>
        <div v-if="stats[as(row).id]?.failed || stats[as(row).id]?.quarantined" class="kb-srct-bad">{{ stats[as(row).id]!.failed }} 失败<template v-if="stats[as(row).id]!.quarantined"> · {{ stats[as(row).id]!.quarantined }} 隔离</template></div>
        <div class="m kb-srct-line">最近同步:{{ since(as(row)) }}</div>
      </div>
    </template>

    <template #row-actions="{ row }">
      <KbButton size="sm" :disabled="busy === as(row).id" :aria-label="`同步 ${as(row).name}`" data-testid="source-sync" @click="emit('sync', as(row))">
        <KbIcon name="refresh" :size="14" /> 同步
      </KbButton>
    </template>
  </KbResponsiveTable>
</template>

<style scoped>
.kb-srct-name { display: flex; align-items: center; gap: var(--sp-3); min-width: 0; }
.kb-srct-ico { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 2em; height: 2em; border-radius: var(--r2); background: var(--surface-2); color: var(--text-secondary); }
.kb-srct-text { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; flex: 1 1 auto; }
.kb-srct-title { font-weight: var(--fw-medium); overflow-wrap: anywhere; }
.kb-srct-uri { font-size: var(--text-12); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-srct-today { font-size: var(--text-12); }
.kb-srct-bad { color: var(--status-danger-text); font-size: var(--text-12); margin-left: var(--sp-2); }
/* 名字长时状态徽标不能被挤成竖排 */
.kb-srct-state { flex: 0 0 auto; white-space: nowrap; }
.kb-srct-card { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
.kb-srct-line { font-size: var(--text-12); overflow-wrap: anywhere; }
.kb-srct-card .kb-srct-bad { margin-left: 0; }
</style>
