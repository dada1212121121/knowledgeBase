<script setup lang="ts">
// 找回密码页(多用户设计说明):邮箱 → 验证码 → 新密码。
// 防枚举:不论邮箱注册过没有,点「获取验证码」后看到的话都一样;验证码对不上才会报错。
// 重置成功后这个账号在所有设备上的登录都会失效,所以要回登录页重新登录。
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { KbButton, KbToastStack } from '@kb-ui/index'
import KbIcon from '@kb-ui/components/KbIcon.vue'
import AuthShell from '@/components/AuthShell.vue'
import { authStatus, resetPassword, type AuthStatus } from '@/api/client'
import { looksLikeEmail, useEmailCode } from '@/composables/useEmailCode'
import { accountErrorText } from '@/utils/accountError'
import { checkPassword } from '@/utils/passwordStrength'

const router = useRouter()
const status = ref<AuthStatus | null>(null)
const loadFailed = ref(false)

const email = ref('')
const code = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const done = ref(false)

const mail = useEmailCode('reset')

// 取站点状态(能不能找回、邮件是否配好):失败时给「重试」,不让人只能手动刷新整页
async function loadStatus() {
  loadFailed.value = false
  try {
    status.value = await authStatus()
  } catch {
    loadFailed.value = true
  }
}
void loadStatus()

const siteName = computed(() => status.value?.site.name ?? '知识库')
const strength = computed(() => checkPassword(password.value))
const canSubmit = computed(
  () => !busy.value && looksLikeEmail(email.value) && /^\d{6}$/.test(code.value.trim()) && strength.value.ok,
)

async function submit() {
  if (!canSubmit.value) return
  busy.value = true
  error.value = ''
  try {
    await resetPassword({ email: email.value.trim(), code: code.value.trim(), new_password: password.value })
    done.value = true
  } catch (err) {
    error.value = accountErrorText(err, '密码没有重置成功。请稍后再试;仍然不行请联系管理员。')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthShell :site-name="siteName" :tagline="status?.site.tagline">
    <KbToastStack />
    <template v-if="done">
      <h2>密码已重置</h2>
      <p class="auth-sub">你在其它设备上的登录已全部退出,请用新密码重新登录。</p>
      <KbButton variant="primary" size="md" class="auth-submit" @click="router.push('/login')">去登录</KbButton>
    </template>

    <template v-else-if="loadFailed">
      <h2>暂时无法找回密码</h2>
      <p class="auth-sub" role="alert">连不上服务器。检查网络后点「重试」。</p>
      <KbButton class="auth-submit" variant="primary" data-testid="auth-retry" @click="loadStatus">重试</KbButton>
      <p class="auth-alt"><router-link class="auth-link" to="/login">返回登录</router-link></p>
    </template>

    <template v-else-if="status && !status.mail_ready">
      <h2>暂时无法自助找回</h2>
      <p class="auth-sub">管理员还没有配置发信邮箱,请联系管理员为你重设密码。</p>
      <p class="auth-alt"><router-link class="auth-link" to="/login">返回登录</router-link></p>
    </template>

    <form v-else class="auth-form" novalidate @submit.prevent="submit">
      <h2>找回密码</h2>
      <p class="auth-sub">我们会向你的注册邮箱发送验证码</p>

      <div class="auth-field">
        <label for="fg-email">注册邮箱</label>
        <div class="auth-inline">
          <div class="auth-inp">
            <KbIcon name="mail" />
            <input
              id="fg-email"
              v-model="email"
              type="email"
              inputmode="email"
              autocomplete="email"
              autocapitalize="none"
              spellcheck="false"
              placeholder="name@example.com"
            />
          </div>
          <KbButton :disabled="mail.sending.value || mail.remaining.value > 0 || !looksLikeEmail(email)" @click="mail.send(email)">
            {{ mail.buttonLabel.value }}
          </KbButton>
        </div>
        <span v-if="mail.error.value" class="auth-help is-bad" role="alert">{{ mail.error.value }}</span>
        <!-- 防枚举:话术固定,不暗示这个邮箱注册过没有 -->
        <span v-else-if="mail.notice.value" class="auth-help">如果这个邮箱已注册,验证码已发送,请查收邮件。</span>
      </div>

      <div class="auth-field">
        <label for="fg-code">验证码</label>
        <div class="auth-inp">
          <KbIcon name="key" />
          <input
            id="fg-code"
            v-model="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            placeholder="6 位数字"
          />
        </div>
      </div>

      <div class="auth-field">
        <label for="fg-pass">新密码</label>
        <div class="auth-inp">
          <KbIcon name="lock" />
          <input id="fg-pass" v-model="password" type="password" autocomplete="new-password" placeholder="至少 8 位" />
        </div>
        <span v-if="password" class="auth-help" :class="{ 'is-bad': !strength.ok }">
          {{ strength.ok ? `强度:${strength.label}` : strength.message }}
        </span>
      </div>

      <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
      <button type="submit" hidden tabindex="-1"></button>
      <KbButton variant="primary" size="md" class="auth-submit" :disabled="!canSubmit" @click="submit">
        {{ busy ? '提交中…' : '重置密码' }}
      </KbButton>
      <p class="auth-alt"><router-link class="auth-link" to="/login">返回登录</router-link></p>
    </form>
  </AuthShell>
</template>
