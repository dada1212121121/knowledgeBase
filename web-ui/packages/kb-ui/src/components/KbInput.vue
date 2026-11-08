<script setup lang="ts">
// 输入框(设计规范):单行 / 多行,统一 focus ring。
withDefaults(defineProps<{ modelValue: string; placeholder?: string; type?: string; multiline?: boolean }>(), {
  placeholder: '',
  type: 'text',
  multiline: false,
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <textarea
    v-if="multiline"
    class="kb-textarea"
    :value="modelValue"
    :placeholder="placeholder"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  ></textarea>
  <input
    v-else
    class="kb-input"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>
