<script setup lang="ts">
// 进度条(设计规范):value 为 0..100;tone 用于失败 / 完成态。
// label 是进度条的可访问名称(axe aria-progressbar-name:role=progressbar 必须有名字),读屏念「总体进度 40%」才知道是哪一项;
// 同一页有好几条进度时要各自传,默认的「进度」只是兜底,不让它没有名字。
withDefaults(defineProps<{ value: number; tone?: 'accent' | 'success' | 'danger'; label?: string }>(), { tone: 'accent', label: '进度' })
const color = { accent: 'var(--accent)', success: 'var(--g)', danger: 'var(--r)' }
</script>

<template>
  <div class="kb-progress" role="progressbar" :aria-label="label" :aria-valuenow="value" aria-valuemin="0" aria-valuemax="100">
    <i :style="{ width: `${Math.min(100, Math.max(0, value))}%`, background: color[tone] }"></i>
  </div>
</template>
