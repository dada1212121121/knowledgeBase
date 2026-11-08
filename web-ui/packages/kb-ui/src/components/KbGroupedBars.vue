<script setup lang="ts">
// 分组柱图(14 评测「按格式拆分」):每个分类一组并排的细柱,值域 0–1。
import { computed } from 'vue'

export interface GroupSeries {
  name: string
  color: string
  /** 与 labels 一一对应,0–1 */
  values: number[]
}
const props = defineProps<{ labels: string[]; series: GroupSeries[] }>()
const groups = computed(() =>
  props.labels.map((label, index) => ({
    label,
    bars: props.series.map((s) => ({ name: s.name, color: s.color, value: Math.min(1, Math.max(0, s.values[index] ?? 0)) })),
  })),
)
</script>

<template>
  <div class="kb-gbars">
    <div v-for="group in groups" :key="group.label" class="kb-gbars-group">
      <div class="kb-gbars-plot">
        <i
          v-for="bar in group.bars"
          :key="bar.name"
          :style="{ height: `${Math.max(2, Math.round(bar.value * 100))}%`, background: bar.color }"
          style-allow="柱高与颜色来自数据"
          :title="`${group.label} · ${bar.name} ${bar.value.toFixed(3)}`"
        ></i>
      </div>
      <div class="m kb-gbars-label">{{ group.label }}</div>
    </div>
  </div>
</template>
