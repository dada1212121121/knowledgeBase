<script setup lang="ts">
// 两版正文的对比窗口:统一 diff(行级),增删行分色,长段没改的行折叠。
import { computed, ref } from 'vue'
import { KbButton, KbDialog } from '@kb-ui/index'
import { diffLines } from '@/utils/textDiff'

const props = defineProps<{
  /** 旧的一版(左边 / 减号那一侧)。 */
  before: { label: string; text: string } | null
  /** 新的一版。 */
  after: { label: string; text: string } | null
  loading: boolean
  error: string
}>()
const emit = defineEmits<{ close: [] }>()

/** 只看改动:没动的行折成一条「未改动 N 行」。 */
const onlyChanges = ref(false)
const result = computed(() => {
  if (!props.before || !props.after) return null
  return diffLines(props.before.text, props.after.text, onlyChanges.value ? 0 : 3)
})
const subtitle = computed(() => {
  if (!props.before || !props.after) return ''
  return `${props.before.label} → ${props.after.label}`
})
const summary = computed(() => (result.value ? `+${result.value.added} 行 · −${result.value.removed} 行` : ''))
</script>

<template>
  <KbDialog title="版本对比" :subtitle="subtitle" width="960px" plain data-testid="version-diff" @close="emit('close')">
    <div class="kb-diff">
      <div class="kb-diff-bar">
        <span v-if="result" class="kb-diff-sum mono" data-testid="diff-summary">{{ summary }}</span>
        <span v-if="result && !result.added && !result.removed" class="m">两版内容一样</span>
        <label class="kb-diff-toggle">
          <input v-model="onlyChanges" type="checkbox" data-testid="diff-only-changes" />
          <span>只看改动</span>
        </label>
      </div>
      <div v-if="loading" class="kb-diff-hint m">正在读取版本正文…</div>
      <div v-else-if="error" class="kb-diff-hint" role="alert">{{ error }}</div>
      <ol v-else-if="result" class="kb-diff-lines mono" data-testid="diff-lines">
        <li v-for="(line, index) in result.lines" :key="index" :class="['kb-diff-line', `is-${line.kind}`]">
          <template v-if="line.kind === 'skip'">
            <span class="kb-diff-gutter">⋯</span>
            <span class="kb-diff-skip">未改动 {{ line.count }} 行</span>
          </template>
          <template v-else>
            <span class="kb-diff-no">{{ line.oldLine ?? '' }}</span>
            <span class="kb-diff-no">{{ line.newLine ?? '' }}</span>
            <span class="kb-diff-sign">{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ' }}</span>
            <span class="kb-diff-text">{{ line.text || ' ' }}</span>
          </template>
        </li>
      </ol>
    </div>
    <template #footer>
      <KbButton data-testid="diff-close" @click="emit('close')">关闭</KbButton>
    </template>
  </KbDialog>
</template>

<style scoped>
.kb-diff { display: grid; gap: 8px; min-height: 200px; }
.kb-diff-bar { display: flex; align-items: center; gap: 12px; font-size: var(--text-12); }
.kb-diff-sum { color: var(--status-success-text); }
.kb-diff-toggle { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; cursor: pointer; }
.kb-diff-hint { padding: 24px 0; text-align: center; }
.kb-diff-lines {
  max-height: min(62vh, 640px);
  overflow: auto;
  margin: 0;
  padding: 6px 0;
  list-style: none;
  border: 1px solid var(--b2);
  border-radius: var(--r2);
  background: var(--surface-2);
  font-size: var(--text-12);
  line-height: 1.55;
}
.kb-diff-line { display: flex; align-items: flex-start; gap: 8px; padding: 0 10px; white-space: pre-wrap; word-break: break-word; }
.kb-diff-line.is-add { background: color-mix(in srgb, var(--status-success-text) 12%, transparent); }
.kb-diff-line.is-remove { background: color-mix(in srgb, var(--status-danger-text) 12%, transparent); }
.kb-diff-no { flex: none; width: 3ch; text-align: right; color: var(--t2); user-select: none; }
.kb-diff-sign { flex: none; width: 1ch; color: var(--t2); user-select: none; }
.kb-diff-line.is-add .kb-diff-sign { color: var(--status-success-text); }
.kb-diff-line.is-remove .kb-diff-sign { color: var(--status-danger-text); }
.kb-diff-text { min-width: 0; }
.kb-diff-skip { color: var(--t2); font-style: italic; }
.kb-diff-gutter { flex: none; width: 7ch; text-align: right; color: var(--t2); }
</style>
