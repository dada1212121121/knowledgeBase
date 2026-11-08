<script setup lang="ts">
// 卡片容器(设计规范):header / extra / default / footer 四个槽。
// variant: plain(默认)| key(渐变描边)| dots(点阵底纹)。
withDefaults(
  defineProps<{ title?: string; subtitle?: string; variant?: 'plain' | 'key' | 'dots'; flush?: boolean }>(),
  { title: '', subtitle: '', variant: 'plain', flush: false },
)
</script>

<template>
  <div class="card" :class="{ key: variant === 'key', dots: variant === 'dots' }">
    <div v-if="title || $slots.header || $slots.extra" class="ch">
      <slot name="header">{{ title }}<span v-if="subtitle" class="m" style="font-weight: 400">· {{ subtitle }}</span></slot>
      <div v-if="$slots.extra" class="r"><slot name="extra" /></div>
    </div>
    <div v-if="flush"><slot /></div>
    <div v-else class="kb-card-body"><slot /></div>
    <div v-if="$slots.footer" class="kb-card-foot"><slot name="footer" /></div>
  </div>
</template>
