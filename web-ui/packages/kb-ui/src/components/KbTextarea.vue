<script setup lang="ts">
// KbTextarea:多行文本输入(与 KbInput 同一套 token)。
// 用于文本类在线编辑;等宽可选,行数可控。
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    /** 行数(高度 = rows × 行高) */
    rows?: number
    /** 等宽字体(代码 / json / csv 用) */
    mono?: boolean
    disabled?: boolean
    readonly?: boolean
  }>(),
  { placeholder: '', rows: 12, mono: false, disabled: false, readonly: false },
)

const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>()

const classes = computed(() => ({ 'kb-textarea-mono': props.mono }))
</script>

<template>
  <textarea
    class="kb-textarea"
    :class="classes"
    :value="modelValue"
    :placeholder="placeholder"
    :rows="rows"
    :disabled="disabled"
    :readonly="readonly"
    spellcheck="false"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  ></textarea>
</template>
