<script setup lang="ts">
// 图表卡的统一骨架:标题 + 一句结论 + 时间范围切换 + 图 + 脚注。所有监控类图表卡都用它,三种非正常状态也在这里写一次:
//   loading → 图表形状的骨架屏;empty → 一句说明(「还没有……,有了之后这里会显示……」);error → 一行原因 + 重试。
// 范围切换放在标题下面一行,不放进标题条:手机上标题条是固定高度的单行(放不下就被裁掉)。
// 图的高度在三种状态之间不跳:body 有最小高度(minHeight)。
import { useId } from 'vue'
import KbButton from './KbButton.vue'
import KbSegmented from './KbSegmented.vue'
import KbSkeleton from './KbSkeleton.vue'

withDefaults(
  defineProps<{
    title: string
    /** 一句结论,例如「近 24 小时完成 4,224 个,失败 0」 */
    headline?: string
    /** 当前范围(v-model:range) */
    range?: string
    ranges?: { value: string; label: string }[]
    state?: 'ready' | 'loading' | 'empty' | 'error'
    emptyText?: string
    errorText?: string
    /** 图区域的最小高度(像素),三种状态之间不让卡片忽高忽低 */
    minHeight?: number
  }>(),
  { headline: '', range: '', ranges: () => [], state: 'ready', emptyText: '还没有数据', errorText: '没能读到数据', minHeight: 160 },
)
const emit = defineEmits<{ 'update:range': [value: string]; retry: [] }>()
const titleId = `kb-ccard-${useId()}`
</script>

<template>
  <section class="card kb-ccard" :aria-labelledby="titleId" :aria-busy="state === 'loading' || undefined">
    <div class="ch"><span :id="titleId">{{ title }}</span><div v-if="$slots.extra" class="r"><slot name="extra" /></div></div>
    <div class="kb-ccard-bar">
      <p v-if="headline && state === 'ready'" class="kb-ccard-headline" data-testid="chart-headline">{{ headline }}</p>
      <span v-else class="kb-ccard-headline"></span>
      <KbSegmented v-if="ranges.length" :model-value="range" :options="ranges" @update:model-value="(value: string) => emit('update:range', value)" />
    </div>
    <div class="kb-ccard-body" :style="{ minHeight: `${minHeight}px` }">
      <KbSkeleton v-if="state === 'loading'" variant="lines" :lines="5" />
      <div v-else-if="state === 'error'" class="kb-ccard-state" role="alert">
        <span>{{ errorText }}</span>
        <KbButton size="sm" @click="emit('retry')">重试</KbButton>
      </div>
      <div v-else-if="state === 'empty'" class="kb-ccard-state m">{{ emptyText }}</div>
      <slot v-else />
    </div>
    <div v-if="$slots.footer && state === 'ready'" class="kb-ccard-foot m"><slot name="footer" /></div>
  </section>
</template>
