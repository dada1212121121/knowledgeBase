// 「获取验证码」按钮的状态:发送中、倒计时、服务端的提示语(注册与找回密码共用)。
//
// 倒计时以服务端返回的 `wait_secs` 为准;被限频(429)时用 `Retry-After`,
// 这样刷新页面后再点也不会和服务端的真实限制对不上。
import { computed, onBeforeUnmount, ref } from 'vue'
import { AccountError, requestEmailCode } from '@/api/client'
import { accountErrorText } from '@/utils/accountError'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function looksLikeEmail(text: string): boolean {
  return EMAIL_RE.test(text.trim())
}

export function useEmailCode(purpose: 'register' | 'reset') {
  const sending = ref(false)
  const remaining = ref(0)
  /** 发送成功后显示的提示(防枚举:不论邮箱是否注册,话术一样)。 */
  const notice = ref('')
  const error = ref('')
  let timer: ReturnType<typeof setInterval> | undefined

  function startCountdown(seconds: number) {
    remaining.value = Math.max(0, Math.ceil(seconds))
    if (timer) clearInterval(timer)
    if (remaining.value === 0) return
    timer = setInterval(() => {
      remaining.value -= 1
      if (remaining.value <= 0 && timer) {
        clearInterval(timer)
        timer = undefined
      }
    }, 1000)
  }

  async function send(email: string): Promise<boolean> {
    if (sending.value || remaining.value > 0) return false
    error.value = ''
    notice.value = ''
    if (!looksLikeEmail(email)) {
      error.value = '请输入正确的邮箱地址'
      return false
    }
    sending.value = true
    try {
      const result = await requestEmailCode(email.trim(), purpose)
      notice.value = `验证码已发送到 ${email.trim()},${result.ttl_minutes} 分钟内有效`
      startCountdown(result.wait_secs)
      return true
    } catch (err) {
      error.value = accountErrorText(err, '验证码没有发出去。请稍后再试;仍然不行请联系管理员。')
      if (err instanceof AccountError && err.status === 429) startCountdown(err.retryAfter)
      return false
    } finally {
      sending.value = false
    }
  }

  const buttonLabel = computed(() => {
    if (sending.value) return '发送中…'
    if (remaining.value > 0) return `${remaining.value} 秒后重发`
    return notice.value ? '重新发送' : '获取验证码'
  })

  onBeforeUnmount(() => {
    if (timer) clearInterval(timer)
  })

  return { sending, remaining, notice, error, buttonLabel, send }
}
