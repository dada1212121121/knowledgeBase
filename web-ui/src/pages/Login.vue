<script setup lang="ts">
// 登录页(多用户设计说明,草图 设计稿)。
// 站点名、能不能注册、能不能自助找回密码都来自 /auth/status,管理员在系统参数里控制。
// 首次使用(还没有任何账号)时显示「设置管理密码」引导:初始密码只能经本机 socket 设置,浏览器里设不了。
// 账号开了两步验证时,密码对了以后进入第二步「输入验证码」(草图 login.html?view=twofa):
// 登录挑战(challenge)只放在内存里,不进地址栏、不进本地存储;验证码同样只在输入框的值里。
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { KbButton, KbToastStack } from '@kb-ui/index'
import KbIcon from '@kb-ui/components/KbIcon.vue'
import AuthShell from '@/components/AuthShell.vue'
import OtpInput from '@/components/OtpInput.vue'
import { authStatus, health, login, loginTotp, type AuthStatus } from '@/api/client'
import { safeNext } from '@/utils/status'
import { accountErrorText } from '@/utils/accountError'
import { codeReady, explainTotpError, normalizeRecovery } from '@/utils/totp'

const router = useRouter()
const status = ref<AuthStatus | null>(null)
const username = ref('')
const password = ref('')
const showPassword = ref(false)
const error = ref('')
const busy = ref(false)
const setupMode = ref(false)
const version = ref('')
const copied = ref(false)

const siteName = computed(() => status.value?.site.name ?? '知识库')
const explicitSetup = new URLSearchParams(window.location.search).has('setup')

let poll: ReturnType<typeof setInterval> | undefined

async function refreshStatus() {
  // 请求失败(守护进程没起来)按登录页处理:只有明确拿到 password_set === false 才进引导
  const value = await authStatus().catch(() => null)
  if (value) status.value = value
  setupMode.value = explicitSetup ? value?.password_set !== true : value !== null && value.password_set === false
  if (!setupMode.value && poll) {
    clearInterval(poll)
    poll = undefined
  }
}

void (async () => {
  const info = await health().catch(() => null)
  if (info?.version) version.value = info.version
  await refreshStatus()
  // 引导页上写着「每 3 秒自动检测」,就真的检测:管理员在终端设好密码后,这里自动变成登录表单
  if (setupMode.value) poll = setInterval(() => void refreshStatus(), 3000)
})()

onBeforeUnmount(() => {
  if (poll) clearInterval(poll)
})

async function copyCommand() {
  try {
    await navigator.clipboard.writeText('kb auth set-password')
    copied.value = true
    setTimeout(() => (copied.value = false), 1600)
  } catch {
    // 剪贴板不可用时忽略(命令就写在页面上)
  }
}

// ---------------------------------------------------------------- 第二步:两步验证
type Stage = 'password' | 'totp'
const stage = ref<Stage>('password')
/** 用 6 位验证码还是恢复码。 */
const codeMode = ref<'code' | 'recovery'>('code')
const code = ref('')
const otp = ref<InstanceType<typeof OtpInput> | null>(null)
const recoveryInput = ref<HTMLInputElement | null>(null)
// 登录挑战是「密码已经对过」的凭证:不放进响应式状态(模板用不到)、不写地址栏 / localStorage / sessionStorage,
// 刷新页面就丢掉,回到输密码——这是有意的。
let challenge = ''

const canSubmitCode = computed(() => codeReady(code.value, codeMode.value))

function focusCode() {
  void nextTick(() => (codeMode.value === 'code' ? otp.value?.focus() : recoveryInput.value?.focus()))
}

/** 回到输密码那一步(挑战作废 / 用户主动返回)。`message` 显示在密码表单上方。 */
function backToPassword(message = '') {
  challenge = ''
  code.value = ''
  codeMode.value = 'code'
  stage.value = 'password'
  error.value = message
}

function switchMode() {
  codeMode.value = codeMode.value === 'code' ? 'recovery' : 'code'
  code.value = ''
  error.value = ''
  focusCode()
}

function onRecoveryInput(event: Event) {
  const el = event.target as HTMLInputElement
  if ((event as InputEvent).isComposing) return
  code.value = normalizeRecovery(el.value)
  if (el.value !== code.value) el.value = code.value
}

/** 登录成功后的去向:会话过期被踢回来时带了 ?next=,回到原来的页面(只允许站内路径,防开放重定向)。 */
async function finishLogin() {
  const next = new URLSearchParams(window.location.search).get('next')
  await router.push(safeNext(next))
}

async function submit() {
  if (busy.value || password.value === '') return
  busy.value = true
  error.value = ''
  try {
    const result = await login(password.value, username.value)
    if (result.kind === 'totp') {
      challenge = result.challenge
      // 第二步用不到密码了,不要把它留在内存里(用户点「返回」要重新输)
      password.value = ''
      showPassword.value = false
      code.value = ''
      codeMode.value = 'code'
      stage.value = 'totp'
      focusCode()
      return
    }
    await finishLogin()
  } catch (err) {
    error.value = accountErrorText(err, '登录没有成功。请稍后再试;仍然不行请联系管理员。')
  } finally {
    busy.value = false
  }
}

async function submitCode() {
  if (busy.value || !canSubmitCode.value) return
  busy.value = true
  error.value = ''
  const mode = codeMode.value
  try {
    await loginTotp(challenge, code.value)
    challenge = ''
    code.value = ''
    await finishLogin()
  } catch (err) {
    const view = explainTotpError(err, mode === 'code' ? 'login-code' : 'login-recovery')
    // 挑战作废(超时 / 输错太多次)或账号被停用:这一步已经没法继续,回到输密码
    if (view.kind === 'challenge_expired' || view.kind === 'forbidden') {
      backToPassword(view.message)
    } else {
      error.value = view.message
      // 输错了清空重输;不清的话再按一次回车会把同一个错码又发一遍,白白消耗这个挑战的 5 次机会
      code.value = ''
      focusCode()
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthShell :site-name="siteName" :tagline="status?.site.tagline">
    <KbToastStack />

    <template v-if="setupMode">
      <h2>设置管理密码</h2>
      <p class="auth-sub">首次使用,三步完成</p>
      <ol class="login-steps">
        <li class="is-done">
          <span class="login-step-n"><KbIcon name="check" :size="12" /></span>
          <div>
            <b>守护进程已就绪</b>
            <span v-if="version" class="auth-help">kb v{{ version }}</span>
          </div>
        </li>
        <li>
          <span class="login-step-n">2</span>
          <div>
            <b>在运行 kb 的机器上执行</b>
            <span class="auth-help">出于安全考虑,初始密码不能在浏览器里设置</span>
            <div class="login-cmd">
              <code>$ kb auth set-password</code>
              <button type="button" class="login-copy" @click="copyCommand">
                <KbIcon name="copy" :size="12" />{{ copied ? '已复制' : '复制' }}
              </button>
            </div>
          </div>
        </li>
        <li>
          <span class="login-step-n">3</span>
          <div>
            <b>返回此页面登录</b>
            <span class="auth-help">设置完成后这里会自动切换,每 3 秒检测一次</span>
          </div>
        </li>
      </ol>
    </template>

    <!-- ============ 第二步:两步验证 ============ -->
    <form v-else-if="stage === 'totp'" class="auth-form" method="post" novalidate data-testid="login-totp" @submit.prevent="submitCode">
      <h2>两步验证</h2>
      <p class="auth-sub">{{ codeMode === 'code' ? '请输入验证器 App 里显示的 6 位数字' : '请输入一个还没用过的恢复码' }}</p>

      <div class="auth-field">
        <OtpInput
          v-if="codeMode === 'code'"
          ref="otp"
          v-model="code"
          label="6 位验证码"
          :invalid="!!error"
          describedby="login-totp-error"
        />
        <template v-else>
          <label for="login-recovery">恢复码</label>
          <div class="auth-inp">
            <KbIcon name="key" />
            <input
              id="login-recovery"
              ref="recoveryInput"
              :value="code"
              type="text"
              inputmode="text"
              autocomplete="off"
              autocapitalize="characters"
              autocorrect="off"
              spellcheck="false"
              enterkeyhint="done"
              placeholder="XXXX-XXXX-XXXX"
              :aria-invalid="!!error || undefined"
              aria-describedby="login-totp-error"
              @input="onRecoveryInput"
            />
          </div>
          <span class="auth-help">创建两步验证时保存的那一批;每个只能用一次。</span>
        </template>
      </div>

      <p v-if="error" id="login-totp-error" class="auth-error" role="alert">{{ error }}</p>
      <button type="submit" hidden tabindex="-1"></button>
      <KbButton variant="primary" size="md" class="auth-submit" :disabled="busy || !canSubmitCode" @click="submitCode">
        {{ busy ? '验证中…' : '验证并登录' }}
      </KbButton>
      <p class="auth-alt">
        <template v-if="codeMode === 'code'">验证器不在身边?<button type="button" class="auth-link login-linkbtn" @click="switchMode">使用恢复码</button></template>
        <template v-else>找到验证器了?<button type="button" class="auth-link login-linkbtn" @click="switchMode">改用验证码</button></template>
      </p>
      <p class="auth-alt"><button type="button" class="auth-link login-linkbtn" @click="backToPassword()">返回,重新输入密码</button></p>
    </form>

    <form v-else class="auth-form" method="post" novalidate @submit.prevent="submit">
      <h2>欢迎回来</h2>
      <p class="auth-sub">登录后继续你的工作</p>

      <div class="auth-field">
        <label for="login-user">用户名或邮箱</label>
        <div class="auth-inp">
          <KbIcon name="user" />
          <input
            id="login-user"
            v-model="username"
            type="text"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            placeholder="name@example.com"
          />
        </div>
      </div>

      <div class="auth-field">
        <label for="login-pass">
          密码
          <router-link v-if="status?.mail_ready" class="auth-link" to="/forgot">忘记密码?</router-link>
        </label>
        <div class="auth-inp">
          <KbIcon name="lock" />
          <input
            id="login-pass"
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="current-password"
          />
          <button
            type="button"
            class="login-eye"
            :aria-label="showPassword ? '隐藏密码' : '显示密码'"
            :aria-pressed="showPassword"
            @click="showPassword = !showPassword"
          >
            <KbIcon name="eye" />
          </button>
        </div>
        <span v-if="status && !status.mail_ready" class="auth-help">忘记密码?请联系管理员重设。</span>
      </div>

      <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
      <button type="submit" hidden tabindex="-1"></button>
      <KbButton variant="primary" size="md" class="auth-submit" :disabled="busy || password === ''" @click="submit">
        {{ busy ? '登录中…' : '登录' }}
      </KbButton>
      <p v-if="status?.registration_open" class="auth-alt">
        还没有账号?<router-link class="auth-link" to="/register">立即注册</router-link>
      </p>
    </form>
  </AuthShell>
</template>

<style>
/* 文字链接样式的按钮:去掉按钮默认外观;触屏上可点区域撑到 44px */
.login-linkbtn {
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: calc(13px * var(--fs));
}
@media (pointer: coarse) {
  .login-linkbtn {
    min-height: 44px;
    padding: 0 var(--sp-2);
  }
}
.login-eye {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  margin-right: -6px;
  border: 0;
  border-radius: var(--r2);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.login-eye:hover {
  color: var(--text-primary);
}
/* 触屏上「显示密码」的点按区不小于 44px(密码框本身也是 44 高,放得下) */
@media (pointer: coarse) {
  .login-eye {
    width: 44px;
    height: 44px;
  }
}
.login-steps {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.login-steps li {
  display: flex;
  gap: 12px;
}
.login-steps li > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.login-step-n {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--r-pill);
  font-size: calc(12px * var(--fs));
  color: var(--text-secondary);
  box-shadow: 0 0 0 1px var(--border-strong) inset;
}
.login-steps li.is-done .login-step-n {
  background: var(--status-success);
  color: var(--on-accent);
  box-shadow: none;
}
.login-cmd {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding: 8px 8px 8px 12px;
  border-radius: var(--r2);
  background: var(--surface-sunken);
  border: 1px solid var(--border-default);
}
.login-cmd code {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  font-size: calc(13px * var(--fs));
}
.login-copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  min-height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r2);
  background: var(--surface-3);
  color: var(--text-secondary);
  font: inherit;
  font-size: calc(12px * var(--fs));
  cursor: pointer;
}
</style>
