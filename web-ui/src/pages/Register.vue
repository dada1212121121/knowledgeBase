<script setup lang="ts">
// 注册页(多用户设计说明,草图 设计稿的 register 视图)。
// 邮箱 → 验证码 → 用户名 → 密码(→ 邀请码)。是否要邀请码、能不能注册都来自 /auth/status,管理员在系统参数里控制。
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { KbButton, KbToastStack, useToast } from '@kb-ui/index'
import KbIcon from '@kb-ui/components/KbIcon.vue'
import AuthShell from '@/components/AuthShell.vue'
import { authStatus, checkInvite, registerAccount, type AuthStatus } from '@/api/client'
import { friendList } from '@/api/social'
import { looksLikeEmail, useEmailCode } from '@/composables/useEmailCode'
import { accountErrorText } from '@/utils/accountError'
import { normalizeInviteCode } from '@/utils/invites'
import { checkPassword } from '@/utils/passwordStrength'
import { displayName, inviteFriendHint } from '@/utils/social'

const router = useRouter()
const toast = useToast()
const status = ref<AuthStatus | null>(null)
const loadFailed = ref(false)

const email = ref('')
const code = ref('')
const username = ref('')
const password = ref('')
const invite = ref(new URLSearchParams(window.location.search).get('invite') ?? '')
const busy = ref(false)
const error = ref('')

const mail = useEmailCode('register')

// 取站点状态(能不能注册、要不要邀请码):失败时给「重试」,不让人只能手动刷新整页
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
const showInvite = computed(() => status.value?.require_invite === true || invite.value !== '')
const inviteRequired = computed(() => status.value?.require_invite === true)

const strength = computed(() => checkPassword(password.value, username.value.trim().toLowerCase()))
const usernameOk = computed(() => /^[A-Za-z0-9_]{3,20}$/.test(username.value.trim()))
const usernameHint = computed(() => {
  if (username.value === '' || usernameOk.value) return '3–20 位字母、数字或下划线,好友通过它找到你'
  return '用户名需要 3–20 位,只能用字母、数字或下划线'
})

// 邀请码:填完停顿一下就向服务端核对,让用户在点「注册」之前就知道有没有效
const inviteState = ref<'' | 'checking' | 'valid' | 'invalid'>('')
const inviteReason = ref('')
// 邀请码是否带「自动加好友」:invite-check 目前不返回这个字段(undefined = 不知道),返回了就用它
const inviteAutoFriend = ref<boolean | undefined>(undefined)
const inviteHint = computed(() => inviteFriendHint(inviteState.value === 'valid', inviteAutoFriend.value))
let inviteTimer: ReturnType<typeof setTimeout> | undefined
function onInviteInput() {
  inviteState.value = ''
  inviteReason.value = ''
  inviteAutoFriend.value = undefined
  if (inviteTimer) clearTimeout(inviteTimer)
  // 只在输入成完整的邀请码时才核对:半截码发给服务端会被记成一次失败尝试
  const text = normalizeInviteCode(invite.value)
  if (!text) return
  inviteState.value = 'checking'
  inviteTimer = setTimeout(async () => {
    try {
      const result: Awaited<ReturnType<typeof checkInvite>> & { auto_friend?: boolean } = await checkInvite(text)
      inviteState.value = result.valid ? 'valid' : 'invalid'
      inviteReason.value = result.reason ?? ''
      inviteAutoFriend.value = typeof result.auto_friend === 'boolean' ? result.auto_friend : undefined
    } catch (err) {
      inviteState.value = ''
      // 被限速等情况不当作「邀请码无效」,把原因告诉用户
      inviteReason.value = accountErrorText(err, '暂时没法核对邀请码。请稍后再试。')
    }
  }, 450)
}
if (invite.value) onInviteInput()

const canSubmit = computed(
  () =>
    !busy.value &&
    looksLikeEmail(email.value) &&
    /^\d{6}$/.test(code.value.trim()) &&
    usernameOk.value &&
    strength.value.ok &&
    (!inviteRequired.value || invite.value.trim() !== ''),
)

/**
 * 用邀请码注册后,如果真的和邀请人成为了好友,告诉用户一声(以好友列表为准,不是猜的)。
 * 新账号的好友只可能是邀请人;角色没有好友功能、网络抖动都不打扰用户——这只是个提示。
 */
async function announceInviter() {
  try {
    const { friends } = await friendList()
    if (friends.length === 1) toast.push(`已和${displayName(friends[0]!)}成为好友,可以在「好友」里查看`)
  } catch {
    /* 没有好友功能(403)或网络问题:不提示 */
  }
}

async function submit() {
  if (!canSubmit.value) return
  busy.value = true
  error.value = ''
  try {
    await registerAccount({
      email: email.value.trim(),
      code: code.value.trim(),
      username: username.value.trim(),
      password: password.value,
      invite: invite.value.trim() || undefined,
    })
    // 注册成功服务端已经把这个浏览器登录了
    const usedInvite = invite.value.trim() !== ''
    await router.push('/home')
    if (usedInvite) void announceInviter()
  } catch (err) {
    error.value = accountErrorText(err, '注册没有成功。请稍后再试;仍然不行请联系管理员。')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthShell :site-name="siteName" :tagline="status?.site.tagline">
    <KbToastStack />
    <template v-if="loadFailed">
      <h2>暂时无法注册</h2>
      <p class="auth-sub" role="alert">连不上服务器。检查网络后点「重试」。</p>
      <KbButton class="auth-submit" variant="primary" data-testid="auth-retry" @click="loadStatus">重试</KbButton>
      <p class="auth-alt"><router-link class="auth-link" to="/login">返回登录</router-link></p>
    </template>

    <template v-else-if="status && !status.registration_open">
      <h2>暂未开放注册</h2>
      <p class="auth-sub">
        {{ status.mail_ready ? '管理员已关闭注册。' : '管理员还没有配置发信邮箱。' }}如需账号,请联系管理员。
      </p>
      <p class="auth-alt"><router-link class="auth-link" to="/login">返回登录</router-link></p>
    </template>

    <form v-else-if="status" class="auth-form" novalidate @submit.prevent="submit">
      <h2>创建账号</h2>
      <p class="auth-sub">用邮箱注册,几分钟就能开始</p>

      <div class="auth-field">
        <label for="reg-email">邮箱</label>
        <div class="auth-inline">
          <div class="auth-inp">
            <KbIcon name="mail" />
            <input
              id="reg-email"
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
        <span v-else-if="mail.notice.value" class="auth-help">{{ mail.notice.value }}</span>
      </div>

      <div class="auth-field">
        <label for="reg-code">邮箱验证码</label>
        <div class="auth-inp">
          <KbIcon name="key" />
          <input
            id="reg-code"
            v-model="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            placeholder="6 位数字"
          />
        </div>
      </div>

      <div class="auth-field">
        <label for="reg-user">用户名</label>
        <div class="auth-inp">
          <KbIcon name="user" />
          <input
            id="reg-user"
            v-model="username"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            maxlength="20"
            placeholder="例如 user_yi"
          />
        </div>
        <span class="auth-help" :class="{ 'is-bad': username !== '' && !usernameOk }">{{ usernameHint }}</span>
      </div>

      <div class="auth-field">
        <label for="reg-pass">密码</label>
        <div class="auth-inp">
          <KbIcon name="lock" />
          <input id="reg-pass" v-model="password" type="password" autocomplete="new-password" placeholder="至少 8 位" />
        </div>
        <div
          v-if="password"
          class="auth-strength"
          :class="{ 'is-weak': strength.score <= 1, 'is-mid': strength.score === 2 }"
          role="img"
          :aria-label="`密码强度:${strength.label}`"
        >
          <i v-for="n in 4" :key="n" :class="{ on: n <= strength.score }"></i>
        </div>
        <span v-if="password" class="auth-help" :class="{ 'is-bad': !strength.ok }">
          {{ strength.ok ? `强度:${strength.label}` : strength.message }}
        </span>
      </div>

      <div v-if="showInvite" class="auth-field">
        <label for="reg-invite">邀请码<span v-if="inviteRequired" class="auth-help">(必填)</span></label>
        <div class="auth-inp">
          <KbIcon name="key" />
          <input
            id="reg-invite"
            v-model="invite"
            autocapitalize="characters"
            autocomplete="off"
            spellcheck="false"
            placeholder="KB-XXXX-XXXX"
            @input="onInviteInput"
          />
        </div>
        <span v-if="inviteState === 'valid'" class="auth-help">邀请码有效</span>
        <span v-else-if="inviteState === 'invalid' || inviteReason" class="auth-help is-bad" role="alert">
          {{ inviteReason || '邀请码无效、已过期或已用完' }}
        </span>
        <span v-if="inviteHint" class="auth-help" data-testid="invite-friend-hint">{{ inviteHint }}</span>
      </div>

      <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
      <!-- 隐藏的提交按钮:没有它,多个输入框的表单按回车不会提交 -->
      <button type="submit" hidden tabindex="-1"></button>
      <KbButton variant="primary" size="md" class="auth-submit" :disabled="!canSubmit" @click="submit">
        {{ busy ? '注册中…' : '注册' }}
      </KbButton>
      <p class="auth-alt">已有账号?<router-link class="auth-link" to="/login">去登录</router-link></p>
    </form>

    <template v-else>
      <h2>创建账号</h2>
      <p class="auth-sub">正在加载…</p>
    </template>
  </AuthShell>
</template>
