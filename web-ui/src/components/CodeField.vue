<script setup lang="ts">
// 「验证码或恢复码」二选一的输入(关闭 / 重新生成恢复码的对话框用):默认 6 格验证码,可切到恢复码。
// 登录页的同款切换写在页面里(位置和按钮排布不一样),规整规则都来自 utils/totp.ts。
import { nextTick, ref } from 'vue'
import OtpInput from './OtpInput.vue'
import { normalizeRecovery } from '@/utils/totp'

const props = defineProps<{ modelValue: string; mode: 'code' | 'recovery'; invalid?: boolean; describedby?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; 'update:mode': [value: 'code' | 'recovery'] }>()

const otp = ref<InstanceType<typeof OtpInput> | null>(null)
const recovery = ref<HTMLInputElement | null>(null)

function focus() {
  void nextTick(() => (props.mode === 'code' ? otp.value?.focus() : recovery.value?.focus()))
}

function toggle() {
  emit('update:mode', props.mode === 'code' ? 'recovery' : 'code')
  emit('update:modelValue', '')
  focus()
}

function onRecoveryInput(event: Event) {
  const el = event.target as HTMLInputElement
  if ((event as InputEvent).isComposing) return
  const next = normalizeRecovery(el.value)
  if (el.value !== next) el.value = next
  emit('update:modelValue', next)
}

defineExpose({ focus })
</script>

<template>
  <div class="kb-cf">
    <OtpInput v-if="mode === 'code'" ref="otp" :model-value="modelValue" label="6 位验证码" :invalid="invalid" :describedby="describedby" @update:model-value="emit('update:modelValue', $event)" />
    <input
      v-else
      ref="recovery"
      class="kb-input kb-cf-recovery"
      type="text"
      :value="modelValue"
      autocomplete="off"
      autocapitalize="characters"
      autocorrect="off"
      spellcheck="false"
      enterkeyhint="done"
      placeholder="XXXX-XXXX-XXXX"
      aria-label="恢复码"
      :aria-invalid="invalid || undefined"
      :aria-describedby="describedby"
      @input="onRecoveryInput"
    />
    <button type="button" class="kb-cf-switch" @click="toggle">{{ mode === 'code' ? '验证器不在身边?改用恢复码' : '改用验证器里的 6 位验证码' }}</button>
  </div>
</template>

<style>
.kb-cf {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
}
.kb-cf > .kb-otp,
.kb-cf-recovery {
  width: 100%;
}
.kb-cf-switch {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent-text);
  font: inherit;
  font-size: calc(13px * var(--fs));
  cursor: pointer;
}
.kb-cf-switch:hover {
  text-decoration: underline;
}
@media (pointer: coarse) {
  .kb-cf-switch {
    min-height: 44px;
  }
}
</style>
