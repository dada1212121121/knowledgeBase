<script setup lang="ts">
// 工具结果里的引用:条目 → 浏览器并打开它;项目 → 项目页;批次 / 任务 → 审计 / 任务页。
import { RouterLink } from 'vue-router'
import { KbIcon } from '@kb-ui/index'
import { refLink, type AgentRef } from '@/utils/agent'

defineProps<{ refs: AgentRef[] }>()

function iconOf(ref: AgentRef) {
  switch (ref.kind) {
    case 'item':
      return 'doc'
    case 'project':
      return 'folder'
    case 'batch':
      return 'archive'
    default:
      return 'clock'
  }
}
</script>

<template>
  <div v-if="refs.length" class="kb-agent-refs">
    <span class="kb-agent-refs-title">引用</span>
    <RouterLink
      v-for="ref in refs"
      :key="`${ref.kind}-${ref.id}`"
      :to="refLink(ref)"
      class="kb-agent-ref"
      :title="ref.source ? `${ref.source}` : ref.label"
    >
      <KbIcon :name="iconOf(ref)" :size="11" />
      <span class="kb-agent-ref-label">{{ ref.label }}</span>
      <span v-if="ref.source && ref.kind === 'item'" class="kb-agent-ref-source">{{ ref.source }}</span>
    </RouterLink>
  </div>
</template>

<style scoped>
.kb-agent-refs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: var(--gap-sm);
  padding-top: var(--gap-sm);
  border-top: var(--hl) dashed var(--border-default);
}
.kb-agent-refs-title {
  font-size: calc(11px * var(--fs));
  color: var(--t2);
  margin-right: 2px;
}
.kb-agent-ref {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 7px;
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r4);
  background: var(--surface-2);
  color: var(--t);
  text-decoration: none;
  font-size: calc(12px * var(--fs));
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.kb-agent-ref:hover {
  border-color: var(--ac);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
}
.kb-agent-ref-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}
.kb-agent-ref-source {
  color: var(--t2);
  font-size: calc(11px * var(--fs));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}
</style>
