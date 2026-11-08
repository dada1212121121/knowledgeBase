<script setup lang="ts">
// 配额覆盖编辑器(用户详情和角色详情共用):每一项留空 = 沿用上一层(角色 → 全站默认),填了才覆盖。
// 保存的是整份覆盖;编辑器不认识的键原样保留。
import { computed, ref, watch } from 'vue'
import { KbButton, KbInput } from '@kb-ui/index'
import { buildQuota, overrideCount, quotaChanged, quotaFields, toQuotaDraft, type QuotaDraft } from '@/utils/quota'

const props = withDefaults(
  defineProps<{
    /** 已保存的覆盖(quota_json 原文) */
    json?: string
    /** 全站默认值(系统参数 quota.*),用来在空格子里提示「沿用 100」;取不到就不提示 */
    defaults?: Record<string, number>
    /** 这一层的名字:「这个用户」「这个角色」 */
    scope: string
    /** 上一层的名字:用户的上一层是角色,角色的上一层是全站默认 */
    inherit: string
    busy?: boolean
    /** AI 总开关:关掉后不列 AI 额度和编码代理的项(已有的覆盖值照样保留、照样随保存提交) */
    aiEnabled?: boolean
  }>(),
  { json: '', defaults: () => ({}), busy: false, aiEnabled: true },
)
const emit = defineEmits<{ save: [quota: Record<string, number>] }>()

const draft = ref<QuotaDraft>(toQuotaDraft(props.json))
const problem = ref('')
// 服务器上的值变了(保存成功后重读、换了用户)就重置草稿
watch(
  () => props.json,
  (value) => {
    draft.value = toQuotaDraft(value)
    problem.value = ''
  },
)
const changed = computed(() => quotaChanged(draft.value, props.json))
const count = computed(() => overrideCount(props.json, props.aiEnabled))
const fields = computed(() => quotaFields(props.aiEnabled))

function placeholder(key: string): string {
  const base = props.defaults[key]
  return base === undefined ? `沿用${props.inherit}` : `沿用${props.inherit}(默认 ${base})`
}
function save() {
  const result = buildQuota(draft.value, props.json)
  if ('error' in result) {
    problem.value = result.error
    return
  }
  problem.value = ''
  emit('save', result.quota)
}
function clearAll() {
  draft.value = toQuotaDraft('')
  problem.value = ''
}
</script>

<template>
  <div class="kb-qe" data-testid="quota-editor">
    <p class="m kb-small kb-qe-note">
      留空 = 沿用{{ inherit }};填了就只对{{ scope }}生效。三层的优先级:用户 > 角色 > 全站默认。
      <b v-if="count" data-testid="quota-count">已覆盖 {{ count }} 项</b>
    </p>
    <div class="kb-qe-grid">
      <label v-for="field in fields" :key="field.key" class="kb-qe-field">
        <span>{{ field.label }}<small v-if="field.unit" class="m"> ({{ field.unit }})</small></span>
        <KbInput v-model="draft[field.key]" inputmode="numeric" :placeholder="placeholder(field.key)" :data-key="field.key" />
        <small v-if="field.zero" class="m">{{ field.zero }}</small>
      </label>
    </div>
    <p v-if="problem" class="kb-qe-bad" role="alert" data-testid="quota-problem">{{ problem }}</p>
    <div class="kb-qe-actions">
      <KbButton size="sm" :disabled="busy" data-testid="quota-clear" @click="clearAll">全部沿用{{ inherit }}</KbButton>
      <KbButton size="sm" variant="primary" :disabled="busy || !changed" data-testid="quota-save" @click="save">{{ busy ? '保存中…' : '保存配额' }}</KbButton>
    </div>
  </div>
</template>

<style>
.kb-qe{display:flex;flex-direction:column;gap:var(--gap-sm,8px);min-width:0}
.kb-qe-note{margin:0}
.kb-qe-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--gap-sm,8px) var(--gap-md,12px)}
.kb-qe-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:calc(13px*var(--fs))}
.kb-qe-field .kb-input{width:100%;min-width:0}
.kb-qe-bad{margin:0;color:var(--status-danger-text);font-size:calc(13px*var(--fs))}
.kb-qe-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:var(--gap-sm,8px)}
@media (max-width:599px){.kb-qe-grid{grid-template-columns:minmax(0,1fr)}}
</style>
