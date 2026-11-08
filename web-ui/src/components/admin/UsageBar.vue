<script setup lang="ts">
// 使用率条:已用 / 上限。颜色只是辅助(正常 / 接近上限 / 已超额),级别同时写在 aria 文案里,
// 页面上还会配一个文字徽标,色觉不同的人也不会漏看。上限为 0 表示不限:只画一条空轨道。
import { computed } from 'vue'
import { barPercent, levelOf, percentText } from '@/utils/usage'

const props = defineProps<{
  used: number
  limit: number
  /** 给读屏软件的名字,例如「Alice 的存储」。 */
  name: string
}>()

const level = computed(() => levelOf(props.used, props.limit))
const percent = computed(() => barPercent(props.used, props.limit))
const LEVEL_TEXT = { ok: '', warn: ',接近上限', over: ',已超出上限', unlimited: '' } as const
const label = computed(() => `${props.name}:${percentText(props.used, props.limit) || '不限'}${LEVEL_TEXT[level.value]}`)
</script>

<template>
  <!-- 不限额时没有「进度」可言,当作一张说明性的图 -->
  <div
    class="kb-ub"
    :role="level === 'unlimited' ? 'img' : 'progressbar'"
    :aria-label="label"
    :aria-valuemin="level === 'unlimited' ? undefined : 0"
    :aria-valuemax="level === 'unlimited' ? undefined : 100"
    :aria-valuenow="level === 'unlimited' ? undefined : Math.round(percent)"
    :data-level="level"
  >
    <i :class="`is-${level}`" :style="{ width: `${percent}%` }" style-allow="使用率来自数据"></i>
  </div>
</template>

<style>
.kb-ub{height:calc(8px*var(--fs));border-radius:var(--r-pill);background:rgb(var(--ink),.08);overflow:hidden;min-width:0}
.kb-ub > i{display:block;height:100%;border-radius:inherit;transition:width var(--dur-slow,300ms) var(--ease-out,ease-out)}
.kb-ub > i.is-ok{background:var(--accent)}
.kb-ub > i.is-warn{background:var(--status-warning)}
.kb-ub > i.is-over{background:var(--status-danger)}
.kb-ub > i.is-unlimited{background:transparent}
</style>
