<script setup lang="ts">
// 密码页:上锁的链接在输对密码前什么都不透露(标题、内容、类型都不给)。
// 输错 5 次这个来源会被锁 10 分钟(整条链接另有总上限);两种文案不同:「密码不对」可以再试,「被锁了」要等。
import { ref } from 'vue'
import { KbButton, KbInput } from '@kb-ui/index'
import { publicUnlock } from '@/api/share'
import { unlockErrorText } from '@/utils/publicShare'

const props = defineProps<{ token: string }>()
const emit = defineEmits<{ unlocked: [] }>()

const password = ref('')
const error = ref('')
const locked = ref(false)
const busy = ref(false)

async function submit() {
  if (busy.value || !password.value) return
  busy.value = true
  error.value = ''
  try {
    await publicUnlock(props.token, password.value)
    emit('unlocked')
  } catch (err) {
    const said = unlockErrorText(err)
    error.value = said.text
    locked.value = said.locked
    // 输错了留着方便改一个字;被锁了再输也没用,清掉免得误以为还在试
    if (said.locked) password.value = ''
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="kb-ppw" data-testid="public-password" @submit.prevent="submit">
    <h1 class="kb-ppw-title">这个链接需要访问密码</h1>
    <p class="kb-ppw-text">向把链接发给你的人要密码。输对之后,24 小时内在这台设备上不用再输。</p>
    <label class="kb-ppw-field">
      访问密码
      <KbInput v-model="password" type="password" placeholder="输入访问密码" autocomplete="off" autocapitalize="off" aria-label="访问密码" data-testid="public-password-input" />
    </label>
    <p v-if="error" class="kb-ppw-error" role="alert" :data-locked="locked" data-testid="public-password-error">{{ error }}</p>
    <KbButton variant="primary" :disabled="busy || !password" data-testid="public-password-submit" @click="submit">{{ busy ? '验证中…' : '打开' }}</KbButton>
  </form>
</template>

<style>
.kb-ppw { display: flex; flex-direction: column; gap: var(--sp-3); width: min(420px, 100%); margin: var(--sp-6) auto; padding: var(--sp-5); border: var(--hl) solid var(--border-subtle); border-radius: var(--r3); background: var(--surface-1); box-sizing: border-box; }
.kb-ppw-title { margin: 0; font-size: var(--text-20); font-weight: var(--fw-title); }
.kb-ppw-text { margin: 0; color: var(--text-secondary); font-size: var(--text-13); line-height: var(--lh-body); }
.kb-ppw-field { display: flex; flex-direction: column; gap: 6px; font-size: var(--text-13); color: var(--text-secondary); }
.kb-ppw-field .kb-input { width: 100%; }
.kb-ppw-error { margin: 0; color: var(--status-danger-text); font-size: var(--text-13); line-height: var(--lh-body); }
</style>
