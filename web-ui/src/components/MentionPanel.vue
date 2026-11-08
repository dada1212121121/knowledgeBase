<script setup lang="ts">
// `@` 引用面板(照 codeg):按类型分组,选中后插入 `@[标题](kb://kind/id)`。
import type { MentionKind, MentionRef } from '@/agent/mentions'

defineProps<{
  kinds: Array<{ kind: MentionKind; label: string; hint: string }>
  kind: MentionKind
  items: MentionRef[]
  active: number
  loading: boolean
}>()

const emit = defineEmits<{ tab: [kind: MentionKind]; select: [index: number] }>()
</script>

<template>
  <div class="kb-mention-panel" role="listbox" aria-label="引用">
    <div class="kb-mention-tabs">
      <button
        v-for="entry in kinds"
        :key="entry.kind"
        type="button"
        class="kb-mention-tab"
        :class="{ 'is-active': entry.kind === kind }"
        @mousedown.prevent="emit('tab', entry.kind)"
      >
        {{ entry.label }}
      </button>
    </div>
    <div class="kb-mention-body">
      <div v-if="loading" class="kb-mention-hint">搜索中…</div>
      <div v-else-if="!items.length" class="kb-mention-hint">
        {{ kind === 'item' ? '输入关键词搜索笔记' : '没有匹配项' }}
      </div>
      <button
        v-for="(item, index) in items"
        :key="item.uri"
        type="button"
        class="kb-mention-item"
        :class="{ 'is-active': index === active }"
        role="option"
        :aria-selected="index === active"
        @mousedown.prevent="emit('select', index)"
      >
        <span class="kb-mention-label">{{ item.label }}</span>
        <span v-if="item.detail" class="kb-mention-detail">{{ item.detail }}</span>
        <span class="kb-mention-kind">{{ item.kind }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.kb-mention-panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 40;
  display: flex;
  flex-direction: column;
  max-height: 300px;
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r2);
  background: var(--panel);
  box-shadow: 0 12px 32px rgb(0 0 0 / 28%);
  overflow: hidden;
}
.kb-mention-tabs {
  display: flex;
  gap: 2px;
  padding: 4px;
  border-bottom: var(--hl) solid var(--border-default);
}
.kb-mention-tab {
  padding: 3px 8px;
  border: 0;
  border-radius: var(--r1);
  background: transparent;
  color: var(--text-tertiary);
  font-size: calc(11px * var(--fs));
  cursor: pointer;
}
.kb-mention-tab.is-active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}
.kb-mention-body {
  overflow: auto;
  padding: 4px;
}
.kb-mention-hint {
  padding: 8px;
  color: var(--text-tertiary);
  font-size: calc(11px * var(--fs));
}
.kb-mention-item {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: baseline;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--r1);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.kb-mention-item.is-active,
.kb-mention-item:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.kb-mention-label {
  font-size: calc(12px * var(--fs));
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-mention-detail {
  color: var(--text-tertiary);
  font-size: calc(11px * var(--fs));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-mention-kind {
  color: var(--text-tertiary);
  font-family: var(--mono);
  font-size: calc(10px * var(--fs));
}
</style>
