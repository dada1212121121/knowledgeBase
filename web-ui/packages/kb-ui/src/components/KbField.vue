<script setup lang="ts">
// 表单字段(设计规范表单):标签 + 控件 + 帮助文字 + 就近的校验报错。
//   手机标签在上;桌面可选标签在左(layout="inline")。
//   报错用 role="alert" 并通过 aria-describedby 关联到控件,读屏软件会读;颜色不是唯一的提示(带图标 + 文字)。
// 控件通过默认插槽的 `id` / `describedby` 作用域参数接上:
//   <KbField label="邮箱" :error="err" v-slot="{ id, describedby, invalid }"><input :id="id" :aria-describedby="describedby" :aria-invalid="invalid" /></KbField>
import { computed } from 'vue'
import KbIcon from './KbIcon.vue'

const props = withDefaults(
  defineProps<{
    label: string
    hint?: string
    error?: string
    required?: boolean
    /** stack = 标签在上;inline = 桌面标签在左(手机仍在上);auto = 同 stack */
    layout?: 'auto' | 'stack' | 'inline'
    /** 控件 id;不传则自动生成 */
    for?: string
  }>(),
  { hint: '', error: '', required: false, layout: 'auto', for: '' },
)

const uid = `kb-f-${Math.random().toString(36).slice(2, 8)}`
const id = computed(() => props.for || uid)
const hintId = computed(() => `${id.value}-hint`)
const errorId = computed(() => `${id.value}-error`)
const describedby = computed(() => [props.error ? errorId.value : '', props.hint ? hintId.value : ''].filter(Boolean).join(' ') || undefined)
const invalid = computed(() => !!props.error)
</script>

<template>
  <div class="kb-field" :class="[`is-${layout}`, { 'is-invalid': invalid }]">
    <label class="kb-field-label" :for="id">
      {{ label }}<span v-if="required" class="kb-field-req" aria-hidden="true">*</span>
      <span v-if="required" class="kb-sr">(必填)</span>
      <span v-if="$slots.extra" class="kb-field-extra"><slot name="extra" /></span>
    </label>
    <div class="kb-field-body">
      <slot :id="id" :describedby="describedby" :invalid="invalid" />
      <p v-if="error" :id="errorId" class="kb-field-error" role="alert"><KbIcon name="failed" :size="14" />{{ error }}</p>
      <p v-if="hint" :id="hintId" class="kb-field-hint">{{ hint }}</p>
    </div>
  </div>
</template>
