<script setup lang="ts">
import { localeDateTime } from '@/utils/time'
// 一个数据来源的详情:类型、位置、目标集合、标签、包含 / 排除、域名白名单、文件数、最近同步、最近错误;能同步、能移除。
// 网页来源另有「AI 规范化」:开关、提取要求(留空 = 自动)、最近一次的整理情况与暂停原因,开关和要求可以就地修改。
// 电脑是右侧抽屉,手机是底部弹层(产品要求:手机上弹出的面板用 KbSheet)。
import { computed, ref, watch } from 'vue'
import { KbButton, KbDrawer, KbInput, KbSheet, KbSwitch, PHONE_QUERY, useMedia, useToast } from '@kb-ui/index'
import { callCapability } from '@/api/client'
import { useFeature } from '@/composables/useFeature'
import { aiStatusText, kindText, type SourceRow } from '@/utils/importSources'

// 注意:Vue 会把没传的布尔 prop 转成 false(不是 undefined),所以「默认可以移除」必须用 withDefaults 写明
const props = withDefaults(defineProps<{ source: SourceRow; busy: boolean; canRemove?: boolean }>(), { canRemove: true })
const emit = defineEmits<{ close: []; sync: []; remove: []; updated: [source: SourceRow] }>()
const phone = useMedia(PHONE_QUERY)
const toast = useToast()

const formatTime = (at: number | null) => (at ? localeDateTime(at, { hour12: false }) : '—')
const rows = computed(() => {
  const item = props.source
  const list = (values: string[]) => (values.length ? values.join('、') : '')
  const all: [string, string][] = [
    ['类型', kindText(item)],
    ['位置', item.uri],
    ['目标集合', item.collection],
    ['标签', list(item.tags)],
    ['包含', list(item.include)],
    ['排除', list(item.exclude)],
    ['域名白名单', list(item.allow_hosts)],
    ['文件数', item.files.toLocaleString()],
    ['最近同步', formatTime(item.last_synced_at)],
    ['创建时间', formatTime(item.created_at)],
    ['最近错误', item.last_error ?? ''],
  ]
  if (item.kind === 'web' && item.ai_extract) {
    all.push(['提取要求', item.extract_prompt?.trim() || '自动(按页面类型尽量全面地整理)'])
    all.push(['AI 整理', aiStatusText(item.ai_status) || '还没有整理过,下次同步时开始'])
    if (item.ai_status?.note) all.push(['AI 说明', item.ai_status.note])
  }
  return all.filter(([, value]) => value && value !== '—')
})

/* ---------------- AI 规范化:就地修改 ---------------- */
const canAiExtract = useFeature('ai.extract')
const editable = computed(() => props.source.kind === 'web' && canAiExtract.value)
const aiExtract = ref(false)
const extractPrompt = ref('')
/** 与后端 `MAX_EXTRACT_PROMPT_CHARS` 一致 */
const EXTRACT_PROMPT_MAX = 2000
function reset() {
  aiExtract.value = !!props.source.ai_extract
  extractPrompt.value = props.source.extract_prompt ?? ''
}
watch(() => props.source, reset, { immediate: true })
const promptError = computed(() =>
  extractPrompt.value.trim().length > EXTRACT_PROMPT_MAX ? `提取要求不能超过 ${EXTRACT_PROMPT_MAX} 个字` : '',
)
const promptChanged = computed(() => extractPrompt.value.trim() !== (props.source.extract_prompt ?? '').trim())
const dirty = computed(() => aiExtract.value !== !!props.source.ai_extract || (aiExtract.value && promptChanged.value))
const saving = ref(false)

async function save() {
  if (!dirty.value || promptError.value || saving.value) return
  saving.value = true
  try {
    const result = await callCapability<{ source: SourceRow }>('update_source', {
      id: props.source.id,
      ai_extract: aiExtract.value,
      // 关掉时不动提取要求:再打开还是原来那份
      ...(aiExtract.value ? { extract_prompt: extractPrompt.value.trim() } : {}),
    })
    toast.push(
      aiExtract.value ? (promptChanged.value ? '已保存。下次同步时按新要求重新整理' : '已打开 AI 规范化,下次同步时开始整理') : '已关闭 AI 规范化(已整理的内容保留)',
      'success',
    )
    emit('updated', result.source)
  } catch (err) {
    toast.push(`保存失败:${err instanceof Error ? err.message : '请稍后再试'}`, 'danger')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <component :is="phone ? KbSheet : KbDrawer" :title="source.name" @close="emit('close')">
    <div class="kb-srcd" data-testid="source-detail">
      <dl class="kb-srcd-list">
        <template v-for="[label, value] in rows" :key="label">
          <dt>{{ label }}</dt>
          <dd :class="{ mono: label === '位置', 'kb-srcd-bad': label === '最近错误', 'kb-srcd-pre': label === '提取要求' }">{{ value }}</dd>
        </template>
      </dl>
      <section v-if="editable" class="kb-srcd-ai" data-testid="source-detail-ai" aria-label="AI 规范化">
        <KbSwitch v-model="aiExtract" label="抓到的页面再用 AI 整理成规范化内容(原文照常入库,会用到 AI 额度)" />
        <template v-if="aiExtract">
          <KbInput
            v-model="extractPrompt"
            multiline
            placeholder="留空自动提取。例:只要产品名称、价格、规格参数和发布日期"
            aria-label="提取要求(可不填)"
            data-testid="source-detail-prompt"
          />
          <span v-if="promptError" class="kb-srcd-bad" role="alert">{{ promptError }}</span>
          <span v-else-if="promptChanged" class="m">改了提取要求,下次同步时每页都会按新要求重新整理</span>
        </template>
        <div class="kb-srcd-actions">
          <KbButton variant="primary" :disabled="!dirty || !!promptError || saving" data-testid="source-detail-save" @click="save">保存</KbButton>
          <KbButton v-if="dirty" :disabled="saving" @click="reset">还原</KbButton>
        </div>
      </section>
      <div class="kb-srcd-actions">
        <KbButton :disabled="busy" data-testid="source-detail-sync" @click="emit('sync')">同步</KbButton>
        <KbButton v-if="canRemove" variant="danger" :disabled="busy" data-testid="source-detail-remove" @click="emit('remove')">移除</KbButton>
      </div>
    </div>
  </component>
</template>

<style scoped>
.kb-srcd { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
.kb-srcd-list { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--sp-2) var(--sp-4); margin: 0; }
.kb-srcd-list dt { color: var(--text-tertiary); font-size: var(--text-13); }
.kb-srcd-list dd { margin: 0; overflow-wrap: anywhere; }
.kb-srcd-pre { white-space: pre-wrap; }
.kb-srcd-bad { color: var(--status-danger-text); }
.kb-srcd-ai { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; padding-top: var(--sp-3); border-top: 1px solid var(--border-subtle); }
.kb-srcd-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
</style>
