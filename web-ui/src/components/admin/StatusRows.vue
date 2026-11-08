<script setup lang="ts">
// 系统状态页里卡片的「标签 + 帮助文字 + 值」列表。
// 桌面左边标签右边值;手机上标签在上、值在下(路径、地址这种长值横着放会把标签挤没);
// compact 的列表(值只有几个字,如各状态的数量)手机上也保持左右并排。
// 值有 tone 时画成徽标:状态用文字 + 颜色一起说,不只靠颜色。
import { KbBadge } from '@kb-ui/index'
import type { StatusRow } from '@/utils/systemStatus'

withDefaults(defineProps<{ rows: StatusRow[]; compact?: boolean }>(), { compact: false })
</script>

<template>
  <dl class="kb-srows" :class="{ 'is-compact': compact }">
    <div v-for="row in rows" :key="row.key" class="kb-srow" :data-testid="`row-${row.key}`">
      <dt>
        {{ row.label }}
        <small v-if="row.help" class="m">{{ row.help }}</small>
      </dt>
      <dd :class="{ mono: row.mono }">
        <KbBadge v-if="row.tone" class="kb-srow-badge" :tone="row.tone">{{ row.value }}</KbBadge>
        <template v-else>{{ row.value }}</template>
      </dd>
    </div>
  </dl>
</template>

<style>
.kb-srows { margin: 0; display: flex; flex-direction: column; min-width: 0; }
.kb-srow { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); align-items: start; gap: var(--sp-1) var(--sp-3); padding: var(--sp-2) 0; border-top: var(--hl) solid var(--b); min-width: 0; }
.kb-srow:first-child { border-top: 0; padding-top: 0; }
.kb-srow dt { display: flex; flex-direction: column; gap: var(--sp-1); color: var(--text-secondary); font-size: var(--text-13); min-width: 0; overflow-wrap: anywhere; }
.kb-srow dt small { font-size: var(--text-12); line-height: var(--lh-body); }
.kb-srow dd { margin: 0; min-width: 0; text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.kb-srow-badge { white-space: normal; text-align: left; }
@media (max-width: 599px) {
  .kb-srow { grid-template-columns: minmax(0, 1fr); }
  .kb-srow dd { text-align: left; }
  /* 标签和值都很短(几个数字)的列表:手机上仍然左右并排,不把一行拆成两行 */
  .kb-srows.is-compact .kb-srow { grid-template-columns: minmax(0, 1fr) auto; }
  .kb-srows.is-compact .kb-srow dd { text-align: right; }
}
</style>
