<script setup lang="ts">
// 手机长按底部弹层:第一项固定是「多选」,和右键菜单的操作集合一致。
import { KbIcon, KbSheet } from '@kb-ui/index'
import type { MenuState } from '@/composables/useFileActions'

withDefaults(defineProps<{ state: MenuState; selectable?: boolean }>(), { selectable: true })
const emit = defineEmits<{ close: []; pick: [kind: 'delete' | 'move']; select: [] }>()
</script>

<template>
  <KbSheet title="文件操作" no-autofocus @close="emit('close')">
    <div class="kb-file-sheet" data-testid="file-action-sheet">
      <div class="kb-file-sheet-head">
        <b :title="state.target.path">{{ state.target.name }}</b>
        <span class="m">{{ state.actions.folder ? `文件夹 · ${state.actions.files} 个文件` : '文件' }}</span>
      </div>
      <button v-if="selectable" type="button" class="kb-file-sheet-item" data-testid="file-sheet-select" @click="emit('select')">
        <KbIcon name="check" :size="16" /><span>多选</span>
      </button>
      <button
        type="button"
        class="kb-file-sheet-item"
        :disabled="!state.actions.move.allowed"
        data-testid="file-sheet-move"
        @click="emit('pick', 'move')"
      >
        <KbIcon name="folder" :size="16" /><span>移动…</span>
      </button>
      <div v-if="!state.actions.move.allowed && state.actions.move.reason" class="kb-file-sheet-why">{{ state.actions.move.reason }}</div>
      <button
        type="button"
        class="kb-file-sheet-item is-danger"
        :disabled="!state.actions.delete.allowed"
        data-testid="file-sheet-delete"
        @click="emit('pick', 'delete')"
      >
        <KbIcon name="trash" :size="16" /><span>删除…</span>
      </button>
      <div v-if="!state.actions.delete.allowed && state.actions.delete.reason" class="kb-file-sheet-why">{{ state.actions.delete.reason }}</div>
    </div>
  </KbSheet>
</template>

<style scoped>
.kb-file-sheet { display: grid; gap: 2px; padding: 0 4px 8px; }
.kb-file-sheet-head { display: grid; gap: 2px; padding: 4px 10px 10px; }
.kb-file-sheet-head b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-file-sheet-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 10px;
  border: 0;
  border-radius: var(--r2);
  background: none;
  color: var(--ink);
  font: inherit;
  font-size: var(--text-15);
  text-align: left;
}
.kb-file-sheet-item:active:not(:disabled) { background: var(--hover); }
.kb-file-sheet-item:disabled { color: var(--m); }
.kb-file-sheet-item.is-danger { color: var(--status-danger-text); }
.kb-file-sheet-why { padding: 0 10px 8px 38px; color: var(--m); font-size: var(--text-12); line-height: 1.45; }
</style>
