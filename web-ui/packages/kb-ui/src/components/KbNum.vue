<script setup lang="ts">
// 带数字滚动的一段文字:把「12,438 条」「1.5 GB」「63%」里的数字部分交给 KbCountUp(进入视口后从 0 滚到值,
// 值变化时从当前显示值滚到新值并闪一下),前后缀原样。没有数字(「—」)直接显示原文。
// 减弱动效时 KbCountUp 直接显示目标值,所以这里不需要再判断。
import { computed } from 'vue'
import KbCountUp from './KbCountUp.vue'
import { splitNumber } from './numberParts'

const props = defineProps<{ value: string | number | null | undefined }>()
const parts = computed(() => splitNumber(props.value))
</script>

<template>
  <template v-if="parts">{{ parts.prefix }}<KbCountUp :value="parts.number" :decimals="parts.decimals" :locale="parts.locale" />{{ parts.suffix }}</template>
  <template v-else>{{ value ?? '—' }}</template>
</template>
