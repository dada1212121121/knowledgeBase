<script setup lang="ts">
// 批量操作条(多选后出现):「已选 N 项」+ 全选 / 取消选择 + 批量操作按钮(默认插槽)。
// 贴在滚动容器底部(sticky),手机上避开安全区。
withDefaults(defineProps<{ count: number; total?: number }>(), { total: 0 })
defineEmits<{ clear: []; all: [] }>()
</script>

<template>
  <div v-if="count > 0" class="kb-batchbar" role="toolbar" aria-label="批量操作" data-testid="batchbar">
    <span class="kb-batchbar-count" role="status" aria-live="polite">已选 {{ count }} 项</span>
    <button v-if="total && count < total" type="button" class="kb-batchbar-link" @click="$emit('all')">全选 {{ total }} 项</button>
    <div class="kb-batchbar-actions"><slot /></div>
    <button type="button" class="kb-batchbar-link" @click="$emit('clear')">取消选择</button>
  </div>
</template>
