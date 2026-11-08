<script setup lang="ts">
// 好友页的编辑面板:电脑是居中的对话框,手机是底部弹层(产品要求:手机上弹出的编辑面板用 KbSheet)。
// 内容和底部按钮用同样的插槽,调用方不用关心当前是哪一种。
// 要用 v-if 挂载(KbDialog 的约定),关闭时由调用方卸载。
import { KbDialog, KbSheet, PHONE_QUERY, useMedia } from '@kb-ui/index'

defineProps<{ title: string; subtitle?: string }>()
defineEmits<{ close: [] }>()
const phone = useMedia(PHONE_QUERY)
</script>

<template>
  <KbSheet v-if="phone" :title="title" @close="$emit('close')">
    <p v-if="subtitle" class="m kb-fp-sub">{{ subtitle }}</p>
    <slot />
    <template v-if="$slots.footer" #footer><slot name="footer" /></template>
  </KbSheet>
  <KbDialog v-else :title="title" :subtitle="subtitle" @close="$emit('close')">
    <slot />
    <template v-if="$slots.footer" #footer><slot name="footer" /></template>
  </KbDialog>
</template>

<style scoped>
.kb-fp-sub { margin: 0 0 var(--sp-3); }
</style>
