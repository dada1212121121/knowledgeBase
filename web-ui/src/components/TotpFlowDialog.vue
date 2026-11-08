<script setup lang="ts">
// 两步验证的三个流程对话框(个人设置里的「两步验证」卡片打开):
//   enable      重新输密码 → 二维码 + 手输密钥 + 输入第一个码 → 恢复码(只显示一次)
//   disable     重新输密码 + 验证码(或恢复码)→ 关闭
//   regenerate  重新输密码 + 验证码(或恢复码)→ 新的恢复码(旧的全部作废)
//
// 安全约定:
//   - 密码只在提交的那一刻用,无论成败立刻清空;不写任何存储;
//   - 密钥和恢复码只活在这个组件里,对话框一关就丢;恢复码展示时,没勾「我已保存」不允许关,
//     离开页面(刷新 / 关标签 / 站内跳转)前会拦一下,因为关掉就再也看不到了;
//   - 请求体里的验证码不会进地址栏或日志。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { KbButton, KbCopyButton, KbDialog, useConfirm, useToast } from '@kb-ui/index'
import CodeField from './CodeField.vue'
import OtpInput from './OtpInput.vue'
import RecoveryCodes from './RecoveryCodes.vue'
import TotpQr from './TotpQr.vue'
import { totpConfirm, totpDisable, totpRegenerate, totpSetup, type TotpSetup } from '@/api/totp'
import { codeReady, explainTotpError, groupSecret, type TotpContext } from '@/utils/totp'

const props = defineProps<{ flow: 'enable' | 'disable' | 'regenerate'; account: string; site: string }>()
const emit = defineEmits<{ close: []; changed: [] }>()

type Step = 'password' | 'scan' | 'verify' | 'codes'
const step = ref<Step>(props.flow === 'enable' ? 'password' : 'verify')
const password = ref('')
const code = ref('')
const mode = ref<'code' | 'recovery'>('code')
const busy = ref(false)
const error = ref('')
const setup = ref<TotpSetup | null>(null)
const codes = ref<string[]>([])
const saved = ref(false)
const closeHint = ref('')

const toast = useToast()
const confirm = useConfirm()
const router = useRouter()

const passwordInput = ref<HTMLInputElement | null>(null)
const codeField = ref<InstanceType<typeof CodeField> | null>(null)
const scanOtp = ref<InstanceType<typeof OtpInput> | null>(null)

const title = computed(() => {
  if (props.flow === 'disable') return '关闭两步验证'
  if (props.flow === 'regenerate') return step.value === 'codes' ? '新的恢复码' : '重新生成恢复码'
  return '开启两步验证'
})
const subtitle = computed(() => {
  if (props.flow === 'disable') return '关闭后,登录只需要密码'
  if (props.flow === 'regenerate') return step.value === 'codes' ? '旧的恢复码已经全部作废' : '旧的恢复码会全部作废,请确认是你本人'
  return { password: '第 1 步,共 3 步:确认是你本人', scan: '第 2 步,共 3 步:绑定验证器', codes: '第 3 步,共 3 步:保存恢复码', verify: '' }[step.value]
})

// ------------------------------------------------------------ 离开前的拦截(恢复码只显示一次)
const unsaved = computed(() => step.value === 'codes' && !saved.value)
const stopGuard = router.beforeEach(async () => {
  if (!unsaved.value) return true
  return confirm.ask({
    title: '恢复码还没保存',
    message: '关掉之后就再也看不到这一批恢复码了。确定要离开吗?',
    confirmText: '仍然离开',
    cancelText: '回去保存',
    tone: 'danger',
  })
})
function onBeforeUnload(event: BeforeUnloadEvent) {
  if (!unsaved.value) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  stopGuard()
})

// ------------------------------------------------------------ 焦点
function focusFirst() {
  void nextTick(() => {
    if (step.value === 'password') passwordInput.value?.focus()
    else if (step.value === 'scan') scanOtp.value?.focus()
    else if (step.value === 'verify') passwordInput.value?.focus()
  })
}
watch(step, focusFirst)

// ------------------------------------------------------------ 提交
const context = computed<TotpContext>(() => {
  if (step.value === 'password') return 'setup'
  if (step.value === 'scan') return 'confirm'
  return props.flow === 'disable' ? 'disable' : 'regenerate'
})

const canSubmit = computed(() => {
  if (busy.value) return false
  if (step.value === 'password') return password.value !== ''
  if (step.value === 'scan') return codeReady(code.value, 'code')
  if (step.value === 'verify') return password.value !== '' && codeReady(code.value, mode.value)
  return false
})

async function submit() {
  if (!canSubmit.value) return
  busy.value = true
  error.value = ''
  const where = step.value
  // 密码只在这一次请求里用:成功后立刻清掉。只有「验证码输错」时留着,免得用户为重输一个码再敲一遍密码
  let keepPassword = false
  try {
    if (where === 'password') {
      setup.value = await totpSetup(password.value)
      code.value = ''
      step.value = 'scan'
    } else if (where === 'scan') {
      const done = await totpConfirm(code.value)
      codes.value = done.recovery_codes
      code.value = ''
      step.value = 'codes'
      emit('changed')
    } else if (props.flow === 'disable') {
      await totpDisable(password.value, code.value)
      emit('changed')
      toast.push('两步验证已关闭')
      emit('close')
    } else {
      const done = await totpRegenerate(password.value, code.value)
      codes.value = done.recovery_codes
      code.value = ''
      step.value = 'codes'
      emit('changed')
    }
  } catch (err) {
    const view = explainTotpError(err, context.value)
    error.value = view.message
    if (view.kind === 'bad_code') {
      keepPassword = where === 'verify'
      code.value = ''
      if (where === 'scan') scanOtp.value?.focus()
      else codeField.value?.focus()
    } else if (view.kind === 'bad_password') {
      passwordInput.value?.focus()
    } else if (view.kind === 'conflict') {
      // 已经在别处开启了:让外面的卡片刷新成最新状态
      emit('changed')
    }
  } finally {
    if (!keepPassword) password.value = ''
    busy.value = false
  }
}

function requestClose() {
  if (busy.value) return
  if (step.value === 'codes' && !saved.value) {
    closeHint.value = '请先保存恢复码,勾选「我已保存」后才能关闭。'
    return
  }
  emit('close')
}
watch(saved, (value) => {
  if (value) closeHint.value = ''
})

const secretText = computed(() => (setup.value ? groupSecret(setup.value.secret) : ''))
// 只把确认过是 otpauth 的地址放进链接,避免服务端返回异常内容时变成可执行链接
const appLink = computed(() => (setup.value?.otpauth_uri.startsWith('otpauth://totp/') ? setup.value.otpauth_uri : ''))
</script>

<template>
  <KbDialog :title="title" :subtitle="subtitle" :close-on-scrim="false" width="640px" @close="requestClose">
    <form class="kb-tf" method="post" novalidate data-testid="totp-flow" :data-step="step" @submit.prevent="submit">
      <!-- 密码(开启的第 1 步;关闭 / 重新生成时和验证码一起) -->
      <template v-if="step === 'password' || step === 'verify'">
        <p v-if="step === 'password'" class="kb-tf-lead">为了账号安全,开启前需要再输入一次当前密码。</p>
        <p v-else-if="flow === 'disable'" class="kb-tf-lead">关闭后,别人只要知道你的密码就能登录。请输入密码和一个验证码来确认是你本人。</p>
        <p v-else class="kb-tf-lead">重新生成后,现有的恢复码会全部作废。请输入密码和一个验证码来确认是你本人。</p>
        <label class="kb-tf-field">
          <span>当前密码</span>
          <input ref="passwordInput" v-model="password" class="kb-input" type="password" autocomplete="current-password" :aria-invalid="!!error || undefined" aria-describedby="totp-flow-error" />
        </label>
      </template>

      <!-- 二维码 + 密钥 + 第一个验证码 -->
      <div v-if="step === 'scan' && setup" class="kb-tf-scan">
        <div class="kb-tf-qr">
          <TotpQr :uri="setup.otpauth_uri" />
          <a v-if="appLink" class="kb-tf-applink" :href="appLink">在这台设备的验证器 App 里打开</a>
        </div>
        <div class="kb-tf-side">
          <ol class="kb-tf-steps">
            <li>在手机上打开验证器 App(如 Google Authenticator、Microsoft Authenticator、1Password),选择「扫描二维码」。</li>
            <li>扫不了?选择「手动输入」,填入下面的密钥(账号随意,类型选「基于时间」)。</li>
            <li>输入验证器里显示的 6 位数字,确认开启。</li>
          </ol>
          <div class="kb-tf-key">
            <span class="kb-tf-key-label">手动输入的密钥</span>
            <div class="kb-tf-key-row">
              <code data-testid="totp-secret">{{ secretText }}</code>
              <KbCopyButton :text="() => setup!.secret" label="复制密钥" />
            </div>
          </div>
          <div class="kb-tf-field">
            <span>第一个验证码</span>
            <OtpInput ref="scanOtp" v-model="code" label="验证器里的 6 位验证码" :invalid="!!error" describedby="totp-flow-error" />
          </div>
        </div>
      </div>

      <div v-if="step === 'verify'" class="kb-tf-field">
        <span>验证码</span>
        <CodeField ref="codeField" v-model="code" v-model:mode="mode" :invalid="!!error" describedby="totp-flow-error" />
      </div>

      <RecoveryCodes v-if="step === 'codes'" v-model:saved="saved" :codes="codes" :account="account" :site="site" :hint="closeHint" />

      <p v-if="error" id="totp-flow-error" class="kb-tf-error" role="alert">{{ error }}</p>

      <div class="kb-tf-actions">
        <template v-if="step === 'codes'">
          <KbButton variant="primary" data-testid="rc-done" :disabled="!saved" @click="requestClose">完成</KbButton>
        </template>
        <template v-else>
          <KbButton :disabled="busy" @click="requestClose">取消</KbButton>
          <button type="submit" hidden tabindex="-1"></button>
          <KbButton :variant="flow === 'disable' && step === 'verify' ? 'danger' : 'primary'" data-testid="totp-submit" :disabled="!canSubmit" @click="submit">
            {{ busy ? '处理中…' : step === 'password' ? '继续' : step === 'scan' ? '确认并开启' : flow === 'disable' ? '关闭两步验证' : '重新生成' }}
          </KbButton>
        </template>
      </div>
    </form>
  </KbDialog>
</template>

<style>
.kb-tf {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-width: 0;
}
.kb-tf-lead {
  margin: 0;
  color: var(--text-secondary);
  font-size: calc(14px * var(--fs));
  line-height: var(--lh-body);
}
.kb-tf-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
  font-size: calc(13px * var(--fs));
  color: var(--text-secondary);
}
.kb-tf-field .kb-input {
  width: 100%;
}
.kb-tf-scan {
  display: grid;
  grid-template-columns: minmax(0, 232px) minmax(0, 1fr);
  gap: var(--sp-4);
  align-items: start;
}
.kb-tf-qr {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  align-items: flex-start;
}
.kb-tf-applink {
  display: none;
  align-items: center;
  min-height: 44px;
  color: var(--accent-text);
  font-size: calc(13px * var(--fs));
}
.kb-tf-side {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 0;
}
.kb-tf-steps {
  margin: 0;
  padding-left: 1.4em;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  color: var(--text-secondary);
  font-size: calc(13px * var(--fs));
  line-height: var(--lh-body);
}
.kb-tf-key {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.kb-tf-key-label {
  font-size: calc(12px * var(--fs));
  color: var(--text-tertiary);
}
.kb-tf-key-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.kb-tf-key-row code {
  flex: 1;
  min-width: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r2);
  background: var(--surface-sunken);
  border: 1px solid var(--border-default);
  font-family: var(--mono);
  font-size: calc(14px * var(--fs));
  letter-spacing: 0.05em;
  color: var(--text-primary);
  user-select: all;
  overflow-wrap: anywhere;
}
.kb-tf-error {
  margin: 0;
  color: var(--status-danger-text);
  font-size: calc(13px * var(--fs));
  line-height: var(--lh-body);
}
.kb-tf-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
@media (max-width: 599px) {
  .kb-tf-scan {
    grid-template-columns: minmax(0, 1fr);
  }
  .kb-tf-qr {
    align-items: center;
  }
  .kb-tf-actions > * {
    flex: 1;
    justify-content: center;
  }
}
/* 手机 / 平板这类触屏上,二维码在同一台设备上没法扫,给一个直接打开验证器 App 的入口 */
@media (pointer: coarse) {
  .kb-tf-applink {
    display: inline-flex;
  }
}
</style>
