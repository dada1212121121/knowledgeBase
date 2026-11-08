<script setup lang="ts">
// 向量表体检(管理组,能力 index_stats):每张表多少行、碎成几片、版本留了多少、索引覆盖到哪。
// 只读诊断,不写库;「整理索引」是 W 级动作(会短暂占住表的写入),所以点之前要确认。
import { computed, ref } from 'vue'
import { KbBadge, KbButton, KbEmpty, KbResponsiveTable, useToast, type RtColumn } from '@kb-ui/index'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import { callCapability } from '@/api/client'
import { useLoadState } from '@/composables/useLoadState'
import { adminFailure } from '@/utils/adminFailure'
import {
  FRAGMENT_WARN,
  fragmentsNote,
  hasMissingIndex,
  indexKindText,
  indexNote,
  statsSummary,
  tableName,
  type IndexStats,
  type TableStatRow,
} from '@/utils/indexStats'

const toast = useToast()
const { phase, data, message, reload } = useLoadState(() => callCapability<IndexStats>('index_stats'), '读取向量表状况', (text) => toast.push(text, 'warning'))
void reload()

const busy = ref(false)
const summary = computed(() => statsSummary(data.value))
const missing = computed(() => hasMissingIndex(data.value))

const columns: RtColumn[] = [
  { key: 'name', label: '集合', mobile: 'primary' },
  { key: 'rows', label: '行数', align: 'right' },
  { key: 'fragments', label: '碎片', align: 'right' },
  { key: 'data_files', label: '数据文件', align: 'right' },
  { key: 'versions', label: '保留版本', align: 'right', mobile: 'meta' },
  { key: 'index', label: '向量索引' },
]

const rowOf = (row: unknown): TableStatRow => row as TableStatRow
const count = (value: number) => value.toLocaleString('en-US')

/** 整理索引:先建索引再收碎片,按表串行,期间这张表的写入排队。 */
async function maintain() {
  if (busy.value) return
  busy.value = true
  try {
    const result = await callCapability<{ maintained: string[]; failed: Array<{ collection: string; stage: string; error: string }> }>('maintain_indexes', { confirm: true })
    const ok = result.maintained.length
    const bad = result.failed.length
    if (bad) toast.push(`${ok} 个集合已整理,${bad} 个失败:${result.failed[0].collection}(${result.failed[0].stage})`, 'warning')
    else toast.push(`${ok} 个集合已整理`, 'success')
    await reload({ quiet: true })
  } catch (err) {
    toast.push(adminFailure(err, '整理索引').message, 'warning')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="kb-is" data-testid="index-stats">
    <AdminLoadState v-if="phase !== 'ready' || !data" :phase="phase" :message="message" @retry="reload()" />

    <template v-else>
      <div class="card kb-is-card">
        <div class="kb-is-head">
          <div>
            <div class="ch">向量表</div>
            <p class="m kb-is-sum" data-testid="index-summary">{{ summary }}</p>
          </div>
          <KbButton v-if="missing" :loading="busy" data-testid="maintain-indexes" @click="maintain">整理索引</KbButton>
        </div>

        <KbResponsiveTable v-if="data.tables.length" :columns="columns" :rows="data.tables" row-key="table" cards="auto" empty="还没有物理表">
          <template #cell-name="{ row }">
            <div class="kb-is-name">
              <b>{{ tableName(rowOf(row)) }}</b>
              <small v-if="!rowOf(row).collection" class="m">表名对不上集合(旧记录)</small>
            </div>
          </template>
          <template #cell-rows="{ row }"><span class="mono">{{ count(rowOf(row).rows) }}</span></template>
          <template #cell-fragments="{ row }">
            <span class="kb-is-frag" :class="{ 'is-warn': rowOf(row).fragments > FRAGMENT_WARN }">
              <span class="mono">{{ count(rowOf(row).fragments) }}</span>
              <KbBadge v-if="rowOf(row).fragments > FRAGMENT_WARN" tone="warning">{{ fragmentsNote(rowOf(row)) }}</KbBadge>
            </span>
          </template>
          <template #cell-data_files="{ row }"><span class="mono">{{ count(rowOf(row).data_files) }}</span></template>
          <template #cell-versions="{ row }"><span class="mono">{{ count(rowOf(row).versions) }}</span></template>
          <template #cell-index="{ row }">
            <div class="kb-is-index">
              <b>{{ indexKindText(rowOf(row).index_kind) }}</b>
              <small class="m">{{ indexNote(rowOf(row)) }}</small>
            </div>
          </template>
        </KbResponsiveTable>
        <KbEmpty v-else icon="database" title="还没有物理表" description="索引过一次内容之后,这里会列出每张表的碎片与索引状况。" />

        <p class="m kb-is-foot">
          行数过了 {{ count(data.threshold) }} 的表会建向量索引,由夜间任务负责;碎片太多时检索要扫更多文件,「整理索引」会顺带把它们合并。
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.kb-is-card { padding: 16px; }
.kb-is-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.kb-is-sum { margin: 4px 0 12px; }
.kb-is-name { display: flex; flex-direction: column; gap: 2px; }
.kb-is-frag { display: inline-flex; align-items: center; gap: 6px; }
.kb-is-frag.is-warn { color: var(--status-warning-text); }
.kb-is-index { display: flex; flex-direction: column; gap: 2px; }
.kb-is-foot { margin-top: 12px; }
</style>
