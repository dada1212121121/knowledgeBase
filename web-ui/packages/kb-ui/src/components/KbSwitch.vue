<script lang="ts">
// 同一页可能有很多个带文字的开关,每个文字节点要有自己的 id 才能被 aria-labelledby 指到
let labelSeq = 0
</script>

<script setup lang="ts">
// 开关(设计规范): 视觉来自 token 层的 .sw。Enter / 空格可切换,disabled 时不响应并降低对比。
//
// 可访问名称(axe aria-toggle-field-name,role=switch 必须有名字):
//   - 传了 label:开关旁边的文字就是它的名字,用 aria-labelledby 连起来(以前只是并排摆着,读屏只念「开关」);
//   - 没传 label:调用方必须自己给 aria-label / aria-labelledby(属性会落在开关上),
//     因为这种用法多半是表单行里文字在别处。
const props = defineProps<{ modelValue: boolean; label?: string; disabled?: boolean }>()
const labelId = `kb-sw-l-${++labelSeq}`
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
function toggle() {
  if (!props.disabled) emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <span v-if="label" class="kb-row">
    <span
      class="sw"
      :class="{ on: modelValue, 'is-disabled': disabled }"
      role="switch"
      :aria-checked="modelValue"
      :aria-disabled="disabled"
      :aria-labelledby="labelId"
      :tabindex="disabled ? -1 : 0"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    ></span>
    <!-- 点文字也能切换(和原生 label 一致);开关本体只有 28×16,单靠它在手机上很难点中 -->
    <span :id="labelId" class="kb-hint kb-sw-label" :class="{ 'is-disabled': disabled }" @click="toggle">{{ label }}</span>
  </span>
  <span
    v-else
    class="sw"
    :class="{ on: modelValue, 'is-disabled': disabled }"
    role="switch"
    :aria-checked="modelValue"
    :aria-disabled="disabled"
    :tabindex="disabled ? -1 : 0"
    @click="toggle"
    @keydown.enter.prevent="toggle"
    @keydown.space.prevent="toggle"
  ></span>
</template>
