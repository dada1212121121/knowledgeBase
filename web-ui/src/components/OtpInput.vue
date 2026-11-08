<script setup lang="ts">
// 6 位验证码输入(草图 设计稿?view=twofa):六个格子是装饰,真正的输入框只有一个,
// 透明地铺在格子上面。这样才能保留浏览器的原生行为:
//   - 手机弹数字键盘(inputmode=numeric),短信 / 验证器的「一键填入」认 autocomplete=one-time-code;
//   - 粘贴、长按选择、退格、读屏软件都按一个普通输入框工作(六个独立输入框做不到整段粘贴和自动填充);
//   - 全角数字(中文输入法)、`123 456` 这样的粘贴内容在这里规整成纯数字。
// 验证码只在组件的值里,不写进地址栏、不打日志、不落本地存储。
import { computed, ref } from 'vue'
import { normalizeCode, CODE_DIGITS } from '@/utils/totp'

const props = withDefaults(defineProps<{ modelValue: string; label: string; id?: string; disabled?: boolean; invalid?: boolean; describedby?: string }>(), {
  id: undefined,
  disabled: false,
  invalid: false,
  describedby: undefined,
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const input = ref<HTMLInputElement | null>(null)
const focused = ref(false)

const cells = computed(() => Array.from({ length: CODE_DIGITS }, (_, index) => props.modelValue[index] ?? ''))
// 下一个要输入的格子高亮;输满后停在最后一格
const active = computed(() => (focused.value ? Math.min(props.modelValue.length, CODE_DIGITS - 1) : -1))

function sync(el: HTMLInputElement) {
  const next = normalizeCode(el.value)
  // 把被过滤掉的字符也从真实输入框里去掉,否则「看起来是空的」但框里还有字母
  if (el.value !== next) el.value = next
  emit('update:modelValue', next)
}

function onInput(event: Event) {
  // 输入法组字过程中不要动内容(拼音没选字之前就被改写会打断输入);组字结束再规整
  if ((event as InputEvent).isComposing) return
  sync(event.target as HTMLInputElement)
}

defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <div class="kb-otp" :class="{ 'is-invalid': invalid, 'is-disabled': disabled }" data-testid="otp">
    <div class="kb-otp-cells" aria-hidden="true">
      <span v-for="(char, index) in cells" :key="index" class="kb-otp-cell" :class="{ 'is-active': index === active, 'is-filled': char !== '' }">{{ char }}</span>
    </div>
    <input
      :id="id"
      ref="input"
      class="kb-otp-input"
      type="text"
      inputmode="numeric"
      pattern="[0-9]*"
      autocomplete="one-time-code"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      enterkeyhint="done"
      maxlength="24"
      :value="modelValue"
      :disabled="disabled"
      :aria-label="label"
      :aria-invalid="invalid || undefined"
      :aria-describedby="describedby"
      @input="onInput"
      @compositionend="(event) => sync(event.target as HTMLInputElement)"
      @focus="focused = true"
      @blur="focused = false"
    />
  </div>
</template>

<style>
.kb-otp {
  position: relative;
}
.kb-otp-cells {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--sp-2);
}
.kb-otp-cell {
  display: grid;
  place-items: center;
  height: calc(var(--field-h) * 1.3);
  min-height: 48px;
  border-radius: var(--r2);
  background: var(--surface-sunken);
  border: 1px solid var(--border-default);
  color: var(--text-primary);
  font-size: calc(22px * var(--fs));
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.kb-otp-cell.is-active {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 25%, transparent);
}
.kb-otp.is-invalid .kb-otp-cell {
  border-color: var(--status-danger);
}
.kb-otp.is-disabled .kb-otp-cell {
  opacity: 0.55;
}
/* 真实输入框:铺满格子、完全透明但可聚焦、可粘贴;字号 ≥16px 以免 iOS 聚焦时放大页面 */
.kb-otp-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: transparent;
  caret-color: transparent;
  opacity: 0;
  font-size: max(16px, 1em);
  cursor: text;
}
</style>
