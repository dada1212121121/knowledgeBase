<script setup lang="ts">
// 聊天框的 `@` 快捷命令菜单(只展示后端 `chat_commands` 白名单里的命令)。
import type { ChatCommand } from '@/agent/commands'

defineProps<{
  items: ChatCommand[]
  active: number
}>()

const emit = defineEmits<{ select: [index: number] }>()
</script>

<template>
  <div v-if="items.length" class="kb-cmd-menu" role="listbox" aria-label="快捷命令">
    <div class="kb-cmd-head">快捷命令(只列允许的能力)</div>
    <button
      v-for="(item, index) in items"
      :key="item.id"
      type="button"
      class="kb-cmd-item"
      :class="{ 'is-active': index === active }"
      role="option"
      :aria-selected="index === active"
      @mousedown.prevent="emit('select', index)"
    >
      <span class="kb-cmd-id">@{{ item.id }}</span>
      <span class="kb-cmd-label">{{ item.label }}</span>
      <span class="kb-cmd-desc">{{ item.description }}</span>
      <span v-if="item.args.length" class="kb-cmd-args">{{ item.args.map((arg) => `<${arg}>`).join(' ') }}</span>
    </button>
  </div>
</template>

<style scoped>
.kb-cmd-menu {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 40;
  max-height: 260px;
  overflow: auto;
  padding: 4px;
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r2);
  background: var(--panel);
  box-shadow: 0 12px 32px rgb(0 0 0 / 28%);
}
.kb-cmd-head {
  padding: 4px 8px;
  font-size: calc(11px * var(--fs));
  color: var(--text-tertiary);
}
.kb-cmd-item {
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--r1);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.kb-cmd-item.is-active,
.kb-cmd-item:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.kb-cmd-id {
  font-family: var(--mono);
  font-size: calc(12px * var(--fs));
  color: var(--accent);
}
.kb-cmd-label {
  font-size: calc(12px * var(--fs));
  font-weight: 600;
}
.kb-cmd-desc {
  font-size: calc(11px * var(--fs));
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-cmd-args {
  font-family: var(--mono);
  font-size: calc(11px * var(--fs));
  color: var(--text-tertiary);
}
</style>
