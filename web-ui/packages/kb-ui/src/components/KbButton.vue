<script setup lang="ts">
// 按钮(设计规范):primary / default / danger,size 两种。
withDefaults(defineProps<{ variant?: 'default' | 'primary' | 'danger'; size?: 'md' | 'sm'; disabled?: boolean }>(), {
  variant: 'default',
  size: 'md',
  disabled: false,
})
</script>

<template>
  <button
    type="button"
    class="kb-btn"
    :class="{ 'is-primary': variant === 'primary', 'is-danger': variant === 'danger', 'is-sm': size === 'sm' }"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>
