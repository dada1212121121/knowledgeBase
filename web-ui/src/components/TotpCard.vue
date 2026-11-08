<script setup lang="ts">
// 个人设置里的「两步验证」卡片:状态(未开启 / 已开启 / 站点要求必须开启)、开启、关闭、重新生成恢复码、剩余恢复码。
// 流程本身在 TotpFlowDialog.vue。四种状态都做:加载(骨架屏)、报错(可重试)、无权限(403)、正常。
// `attention` 为真时(被「站点要求开启两步验证」的全局拦截带到这里),滚动到本卡片、聚焦「开启」按钮并解释原因。
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { KbBadge, KbButton, KbCard, KbSkeleton } from '@kb-ui/index'
import TotpFlowDialog from './TotpFlowDialog.vue'
import { AccountError, authStatus } from '@/api/client'
import { totpStatus, type TotpState } from '@/api/totp'
import { useSessionStore } from '@/stores/session'
import { recoveryLevel } from '@/utils/totp'

const props = defineProps<{ attention?: boolean }>()

const session = useSessionStore()
const state = ref<TotpState | null>(null)
const loading = ref(true)
const failure = ref<{ message: string; forbidden: boolean } | null>(null)
const flow = ref<'enable' | 'disable' | 'regenerate' | null>(null)
const siteName = ref('知识库')
const card = ref<InstanceType<typeof KbCard> | null>(null)
const enableButton = ref<InstanceType<typeof KbButton> | null>(null)

async function load() {
  // 刷新(开启 / 关闭之后)时保留旧内容,不闪骨架屏
  if (!state.value) loading.value = true
  try {
    state.value = await totpStatus()
    failure.value = null
    // 站点强制而当前账号还没开:全局拦截(router)据此把其它页面都带回这里;开启之后立即放开
    session.needsTotpSetup = state.value.required && !state.value.enabled
  } catch (err) {
    const forbidden = err instanceof AccountError && err.status === 403
    failure.value = {
      forbidden,
      message: forbidden
        ? '你的账号没有开通这个功能,请联系管理员。'
        : err instanceof AccountError && err.status !== 0 && err.message
          ? `${err.message.replace(/[。.]$/, '')}。请重试。`
          : '连不上服务器。检查网络后重试。',
    }
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  void authStatus().then((value) => (siteName.value = value.site.name || '知识库')).catch(() => undefined)
  await load()
  if (props.attention) await showAttention()
})
watch(
  () => props.attention,
  (value) => value && void showAttention(),
)

async function showAttention() {
  await nextTick()
  ;(card.value?.$el as HTMLElement | undefined)?.scrollIntoView({ block: 'center' })
  enableButton.value?.$el?.focus?.()
}

const level = computed(() => recoveryLevel(state.value?.recovery_codes_left ?? 0))
const mustEnable = computed(() => !!state.value?.required && !state.value.enabled)
const account = computed(() => session.user?.username ?? '')
const badge = computed(() => {
  if (!state.value) return null
  if (state.value.enabled) return { tone: 'success' as const, text: '已开启' }
  return state.value.required ? { tone: 'warning' as const, text: '必须开启' } : { tone: 'neutral' as const, text: '未开启' }
})

async function changed() {
  await load()
}
</script>

<template>
  <KbCard ref="card" class="kb-me-card kb-totp" :class="{ 'is-attention': attention && mustEnable }" aria-labelledby="me-2fa" data-testid="totp-card">
    <header class="kb-me-head">
      <b id="me-2fa">两步验证</b>
      <span class="kb-spacer"></span>
      <KbBadge v-if="badge" :tone="badge.tone" data-testid="totp-badge">{{ badge.text }}</KbBadge>
    </header>

    <div v-if="loading" class="kb-me-form kb-me-flat"><KbSkeleton :lines="3" /></div>

    <div v-else-if="failure" class="kb-me-form kb-me-flat" data-testid="totp-failure">
      <p class="kb-me-bad" role="alert">{{ failure.message }}</p>
      <div v-if="!failure.forbidden" class="kb-me-actions"><KbButton @click="load">重试</KbButton></div>
    </div>

    <div v-else-if="state" class="kb-me-form kb-me-flat">
      <p v-if="mustEnable" class="kb-totp-must" role="alert" data-testid="totp-must">
        <b>站点要求管理员账号必须开启两步验证。</b>在开启之前,其它页面暂时不能使用——开启后会自动恢复。
      </p>

      <template v-if="!state.enabled">
        <p class="m kb-small">登录时除了密码,再输入手机验证器里的一次性数字。即使密码被别人知道,没有你的手机也登录不了。</p>
        <p class="m kb-small">需要一个验证器 App,例如 Google Authenticator、Microsoft Authenticator 或 1Password。</p>
        <div class="kb-me-actions">
          <KbButton ref="enableButton" variant="primary" data-testid="totp-enable" @click="flow = 'enable'">开启两步验证</KbButton>
        </div>
      </template>

      <template v-else>
        <p class="kb-small" data-testid="totp-on">登录时需要密码和验证器里的 6 位数字。</p>
        <p class="kb-totp-left" :class="`is-${level}`" data-testid="totp-left">
          <KbBadge :tone="level === 'none' ? 'danger' : level === 'low' ? 'warning' : 'neutral'">剩余恢复码 {{ state.recovery_codes_left }} 个</KbBadge>
          <span v-if="level === 'low'" class="kb-small">快用完了,建议重新生成一批。</span>
          <span v-else-if="level === 'none'" class="kb-small">已经用完。手机丢了就进不了账号,请现在重新生成。</span>
          <span v-else class="m kb-small">手机丢了或验证器用不了时,可以用它们登录。</span>
        </p>
        <div class="kb-me-actions kb-totp-actions">
          <KbButton data-testid="totp-regenerate" @click="flow = 'regenerate'">重新生成恢复码</KbButton>
          <KbButton v-if="!state.required" variant="danger" data-testid="totp-disable" @click="flow = 'disable'">关闭两步验证</KbButton>
        </div>
        <p v-if="state.required" class="m kb-small" data-testid="totp-locked">站点要求管理员账号必须开启两步验证,所以不能关闭。</p>
      </template>
    </div>

    <TotpFlowDialog v-if="flow" :flow="flow" :account="account" :site="siteName" @close="flow = null" @changed="changed" />
  </KbCard>
</template>

<style>
.kb-totp.is-attention {
  border-color: var(--status-warning);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--status-warning) 25%, transparent);
}
.kb-totp-must {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r2);
  background: color-mix(in oklab, var(--status-warning) 14%, transparent);
  color: var(--text-primary);
  font-size: calc(13px * var(--fs));
  line-height: var(--lh-body);
}
.kb-totp-must b {
  color: var(--status-warning-text);
}
.kb-totp-left {
  margin: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.kb-totp-actions {
  flex-wrap: wrap;
}
</style>
