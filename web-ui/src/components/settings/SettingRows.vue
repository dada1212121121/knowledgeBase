<script setup lang="ts">
// 一组配置项(系统设置页的每张表单卡都用它):每行 = 中文标签 + 一句帮助文字(带取值范围与配置键)+ 控件,
// 需要重启的项打「需要重启」标记,风险项在行内写明后果,校验报错就近显示在这一行下面。
// 手机上标签在上、控件在下占满宽度;开关保持一行(标签左、开关右)。
// 页面只管草稿和保存,这里不碰网络:控件改动通过 update 事件交给页面。
import { computed } from 'vue'
import { KbBadge, KbIcon, KbInput, KbSelect, KbSwitch } from '@kb-ui/index'
import { needsRestart, rangeText, riskOf, type ChoiceOption, type Draft, type SettingField } from '@/utils/settingsFields'

const props = defineProps<{
  fields: SettingField[]
  draft: Draft
  errors: Record<string, string>
  /** 运行时才知道的单选项(例如服务商列表),优先于字段表里写死的 options。 */
  choices?: Record<string, ChoiceOption[]>
}>()
const emit = defineEmits<{ update: [path: string, value: string | boolean] }>()

const idOf = (path: string) => `st-${path.replace(/\./g, '-')}`

/** 单选项:当前值不在列表里(手改的配置、已下线的服务商)也要保留,免得一打开就被悄悄改掉。 */
function optionsOf(field: SettingField): ChoiceOption[] {
  const list = props.choices?.[field.path] ?? field.options ?? []
  const current = String(props.draft[field.path] ?? '')
  return current && list.length && !list.some((option) => option.value === current) ? [...list, { value: current, label: current }] : list
}

/** 只读项的展示文字。 */
function shown(field: SettingField): string {
  const value = props.draft[field.path]
  if (field.kind === 'bool') return value === true ? '开启' : '关闭'
  return String(value ?? '') || '—'
}

const rows = computed(() =>
  props.fields.map((field) => ({
    field,
    id: idOf(field.path),
    range: rangeText(field),
    risk: riskOf(field, props.draft[field.path]),
    error: props.errors[field.path] ?? '',
    options: field.kind === 'choice' ? optionsOf(field) : [],
  })),
)
</script>

<template>
  <div class="kb-st-rows" data-testid="setting-rows">
    <div
      v-for="row in rows"
      :key="row.field.path"
      class="kb-st-row"
      :class="{ 'is-switch': row.field.kind === 'bool' && !row.field.readonly, 'is-invalid': !!row.error }"
      data-testid="setting-row"
      :data-field="row.field.path"
    >
      <div class="kb-st-text">
        <label class="kb-st-label" :for="row.id">
          <span>{{ row.field.label }}</span>
          <KbBadge v-if="needsRestart(row.field.path) && !row.field.readonly" tone="warning" class="kb-st-restart" data-testid="setting-restart">需要重启</KbBadge>
        </label>
        <small :id="`${row.id}-hint`" class="kb-st-hint">
          {{ row.field.hint }}<template v-if="row.range">{{ row.range }}。</template> <code class="kb-mono kb-st-key">{{ row.field.path }}</code>
        </small>
        <small v-if="row.risk" class="kb-st-risk" role="note" data-testid="setting-risk">{{ row.risk }}</small>
        <small v-if="row.error" :id="`${row.id}-error`" class="kb-st-error" role="alert" data-testid="setting-error">
          <KbIcon name="failed" :size="14" />{{ row.error }}
        </small>
      </div>
      <div class="kb-st-ctl">
        <span v-if="row.field.readonly" :id="row.id" class="kb-mono kb-st-value" data-testid="setting-value">{{ shown(row.field) }}</span>
        <KbSwitch
          v-else-if="row.field.kind === 'bool'"
          :id="row.id"
          :model-value="draft[row.field.path] === true"
          :aria-label="row.field.label"
          :aria-describedby="`${row.id}-hint`"
          @update:model-value="(value: boolean) => emit('update', row.field.path, value)"
        />
        <KbSelect
          v-else-if="row.field.kind === 'choice' && row.options.length"
          :model-value="String(draft[row.field.path] ?? '')"
          :options="row.options"
          :aria-label="row.field.label"
          @update:model-value="(value: string | number) => emit('update', row.field.path, String(value))"
        />
        <template v-else>
          <KbInput
            :id="row.id"
            :multiline="row.field.kind === 'list'"
            :model-value="String(draft[row.field.path] ?? '')"
            :placeholder="row.field.placeholder ?? ''"
            :inputmode="row.field.kind === 'int' ? 'numeric' : row.field.kind === 'number' ? 'decimal' : undefined"
            :aria-invalid="row.error ? 'true' : undefined"
            :aria-describedby="[`${row.id}-hint`, row.error ? `${row.id}-error` : ''].filter(Boolean).join(' ')"
            autocomplete="off"
            spellcheck="false"
            @update:model-value="(value: string) => emit('update', row.field.path, value)"
          />
          <span v-if="row.field.unit" class="kb-st-unit">{{ row.field.unit }}</span>
        </template>
      </div>
    </div>
  </div>
</template>

<style>
.kb-st-rows{container-type:inline-size;display:flex;flex-direction:column;min-width:0}
.kb-st-row{display:flex;align-items:center;justify-content:space-between;gap:var(--gap-md,12px);padding:12px 0;border-top:var(--hl) solid var(--b);min-width:0}
.kb-st-row:first-child{border-top:0;padding-top:0}
.kb-st-row:last-child{padding-bottom:0}
.kb-st-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.kb-st-label{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--t);font-size:calc(14px*var(--fs));line-height:1.4}
.kb-st-restart{flex:0 0 auto;white-space:nowrap}
.kb-st-hint{color:var(--text-tertiary);font-size:calc(12px*var(--fs));line-height:1.55;overflow-wrap:anywhere}
.kb-st-key{font-size:calc(12px*var(--fs));color:var(--text-secondary);white-space:nowrap}
.kb-st-risk{margin:0;color:var(--status-warning-text);font-size:calc(12px*var(--fs));line-height:1.5}
.kb-st-error{display:flex;align-items:flex-start;gap:4px;color:var(--status-danger-text,var(--r));font-size:calc(12px*var(--fs));line-height:1.5}
.kb-st-ctl{display:flex;align-items:center;gap:8px;flex:none;min-width:0;max-width:100%}
.kb-st-ctl .kb-input,.kb-st-ctl .kb-textarea{width:220px;min-width:0}
.kb-st-unit{min-width:2.2em;color:var(--text-secondary);font-size:calc(12px*var(--fs));white-space:nowrap}
.kb-st-value{max-width:260px;overflow-wrap:anywhere;text-align:right}
.kb-st-row.is-invalid .kb-input,.kb-st-row.is-invalid .kb-textarea{border-color:var(--status-danger-text,var(--r))}
/* 卡片放不下「标签 + 控件」并排时(手机、窄侧栏):标签在上,控件占满宽度;开关仍然一行 */
@container (max-width: 560px){
  .kb-st-row{flex-direction:column;align-items:stretch;gap:var(--gap-sm,8px)}
  .kb-st-ctl{width:100%;flex:1 1 auto}
  .kb-st-ctl .kb-input,.kb-st-ctl .kb-textarea{width:100%;flex:1}
  .kb-st-value{max-width:100%;text-align:left}
  .kb-st-row.is-switch{flex-direction:row;align-items:center;gap:var(--gap-md,12px)}
  .kb-st-row.is-switch .kb-st-ctl{width:auto;flex:none}
}
</style>
