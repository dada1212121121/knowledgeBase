<script setup lang="ts">
// 指标卡(设计规范):label / value / delta / tone / sparkline。
import { useId } from 'vue'
import { computed } from 'vue'
import KbNum from './KbNum.vue'
import KbSparkline from './KbSparkline.vue'

const sparkId = `kb-spark-${useId()}`
const props = withDefaults(
  defineProps<{
    label: string
    value: string | number
    delta?: string
    tone?: 'neutral' | 'success' | 'warning' | 'danger'
    spark?: number[]
  }>(),
  { delta: '', tone: 'neutral', spark: () => [] },
)

/**
 * 说明文字的颜色:用各状态色的「文字版」令牌(浅色主题下按对比度调过),不用原始状态色——
 * 原始的 --y 在白底上只有 2.6:1,看不清;danger 以前挂的 .down 类在样式表里根本不存在,等于没着色。
 */
const deltaColor = computed(() => ({ success: 'var(--status-success-text, var(--g))', warning: 'var(--status-warning-text, var(--y))', danger: 'var(--status-danger-text, var(--r))', neutral: '' })[props.tone])

</script>

<template>
  <div class="card metric">
    <div class="k">{{ label }}</div>
    <div class="v">
      <KbNum :value="value" />
    </div>
    <div class="s" :class="{ up: tone === 'success', down: tone === 'danger', m: tone === 'neutral' }" :style="deltaColor ? { color: deltaColor } : undefined">
      {{ delta }}
    </div>
    <KbSparkline v-if="spark?.length" :values="spark" :gradient-id="sparkId" />
  </div>
</template>
