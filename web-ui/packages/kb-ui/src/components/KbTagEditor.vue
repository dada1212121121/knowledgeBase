<script setup lang="ts">
import { isComposing } from '../composables/ime'
// 标签编辑:一排 tag + 末尾的「+」输入。回车 / 逗号添加,点 × 或在空输入里按退格删除。
import { ref } from 'vue'

const props = defineProps<{ modelValue: string[]; readonly?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const draft = ref('')

function add() {
  const value = draft.value.trim().replace(/,$/, '')
  draft.value = ''
  if (!value || props.modelValue.includes(value)) return
  emit('update:modelValue', [...props.modelValue, value])
}
/** 回车 / 逗号 = 添加;空输入里退格 = 删最后一个 */
function onKey(event: KeyboardEvent) {
  if (isComposing(event)) return
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault()
    add()
  } else if (event.key === 'Backspace' && !draft.value && props.modelValue.length) {
    remove(props.modelValue[props.modelValue.length - 1]!)
  }
}
function remove(tag: string) {
  emit('update:modelValue', props.modelValue.filter((item) => item !== tag))
}
</script>

<template>
  <span class="row kb-tags">
    <span v-for="tag in modelValue" :key="tag" class="tag">
      {{ tag }}<button v-if="!readonly" type="button" class="kb-chip-x" :aria-label="`删除标签 ${tag}`" @click="remove(tag)">×</button>
    </span>
    <input
      v-if="!readonly"
      v-model="draft"
      class="kb-tag-input"
      type="text"
      placeholder="+ 标签" aria-label="添加标签"
      @keydown="onKey"
      @blur="add"
    />
  </span>
</template>
