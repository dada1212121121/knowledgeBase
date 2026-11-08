<script setup lang="ts">
// 分享面板 · 链接页（设计规范）:谁能访问、角色、有效期、密码、下载、水印、复制 / 重置 / 关闭 / 撤销、访问统计。
//
// 链接地址(含令牌)后端只在「创建」和「重置」时返回这一次,之后接口里只有后四位提示。
// 所以这里把刚拿到的地址留在内存里让人复制,并明说「只显示这一次」;关掉面板后就再也找不回来,只能重置换新地址。
// 多选时是「合集链接」:一个链接打开后是虚拟目录,里面就是选中的这些项。
import { computed, onMounted, ref, watch } from 'vue'
import { KbBadge, KbButton, KbCopyButton, KbEmpty, KbInput, KbSelect, KbSkeleton, KbSwitch, useConfirm, useToast } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import './share.css'
import {
  linkCreate,
  linkGet,
  linkReset,
  linkRevoke,
  linkStats,
  linkUpdate,
  type LinkInfo,
  type LinkStats,
  type LinkUpdateArgs,
  type ShareTarget,
} from '@/api/share'
import { useSessionStore } from '@/stores/session'
import {
  AUDIENCE_LABEL,
  EXPIRY_OPTIONS,
  LINK_ROLES,
  audienceOptions,
  expiryForCreate,
  expiryPatch,
  expiryText,
  guestCeilingNote,
  isNoAccess,
  linkStateOf,
  maskedLink,
  personName,
  relativeTime,
  roleOptions,
  shareErrorText,
  validateExpiryDays,
  validateLinkPassword,
  type ExpiryChoice,
  type LinkAudience,
} from '@/utils/share'
import type { GrantRole } from '@/api/share'

const props = defineProps<{
  targets: ShareTarget[]
  titles?: Record<string, string>
  bundleTitle?: string
  /** 管理一条已有的链接(「我的分享」里点进来):直接用它,不再按资源去查;删除后通知上层关掉 */
  initialLink?: LinkInfo
}>()
const emit = defineEmits<{ changed: []; gone: [] }>()

const toast = useToast()
const confirmer = useConfirm()
const session = useSessionStore()

const bundle = computed(() => props.targets.length > 1)

type Status = 'loading' | 'ready' | 'error' | 'denied'
const status = ref<Status>('loading')
const errorText = ref('')
const deniedText = ref('')
const link = ref<LinkInfo | null>(null)
/** 刚创建 / 重置拿到的完整地址:只在内存里,关掉面板就没了 */
const freshUrl = ref('')
/** 点过「复制」了吗:没复制就关面板,上层会先提醒一句 */
const urlCopied = ref(false)
watch(freshUrl, () => (urlCopied.value = false))
defineExpose({ pendingUrl: computed(() => !!freshUrl.value && !urlCopied.value) })

const audiences = computed(() => audienceOptions((feature) => session.has(feature)))
const roleChoices = roleOptions(LINK_ROLES)

async function load() {
  status.value = 'loading'
  errorText.value = ''
  if (props.initialLink) {
    link.value = props.initialLink
    status.value = 'ready'
    return
  }
  // 合集链接没有「按资源查」的接口:创建后的链接留在 link 里,以后到「我的分享」里管理
  if (bundle.value) {
    status.value = 'ready'
    return
  }
  try {
    const result = await linkGet(props.targets[0]!)
    // 一个资源一个主链接;撤销过的不算
    link.value = result.links.find((item) => item.state !== 'revoked') ?? null
    status.value = 'ready'
  } catch (err) {
    errorText.value = shareErrorText(err, '链接设置没有加载出来。检查网络后重试。')
    deniedText.value = (err as { status?: number }).status === 403 ? errorText.value : ''
    status.value = isNoAccess(err) ? 'denied' : 'error'
  }
}
onMounted(() => void load())

// ---------------------------------------------------------------- 创建

const createAudience = ref<LinkAudience>('collaborators')
const createRole = ref<GrantRole>('viewer')
const createExpiry = ref<ExpiryChoice>('forever')
const createDays = ref('')
const createTitle = ref('')
const createError = ref('')
const creating = ref(false)

// 默认选开通了的、权限最小的那种范围:登录用户 > 仅协作者;「任何人」要用户自己选
onMounted(() => {
  const loggedIn = audiences.value.find((item) => item.value === 'logged_in')
  createAudience.value = loggedIn && !loggedIn.disabled ? 'logged_in' : 'collaborators'
})

const createAudienceChoices = computed(() => audiences.value.filter((item) => !item.disabled).map((item) => ({ value: item.value, label: item.label })))
const lockedAudiences = computed(() => audiences.value.filter((item) => item.disabled).map((item) => item.label))
const createDaysError = computed(() => (createExpiry.value === 'custom' && createDays.value ? validateExpiryDays(createDays.value) : null))

async function createLink() {
  if (creating.value) return
  if (createExpiry.value === 'custom') {
    const problem = validateExpiryDays(createDays.value)
    if (problem) {
      createError.value = problem
      return
    }
  }
  creating.value = true
  createError.value = ''
  try {
    const made = await linkCreate({
      ...(bundle.value ? { targets: props.targets, title: createTitle.value.trim() || props.bundleTitle || `合集(${props.targets.length} 项)` } : { target: props.targets[0]! }),
      audience: createAudience.value,
      role: createRole.value,
      ...expiryForCreate(createExpiry.value, createDays.value),
    })
    link.value = made.link
    freshUrl.value = made.url
    emit('changed')
    toast.push('链接已创建,请现在复制')
  } catch (err) {
    createError.value = shareErrorText(err)
  } finally {
    creating.value = false
  }
}

// ---------------------------------------------------------------- 修改

const saving = ref(false)

/** 提交一项修改,用服务器返回的链接覆盖本地(界面始终是服务器上的真实状态) */
async function patch(change: Omit<LinkUpdateArgs, 'id'>, done?: string): Promise<boolean> {
  const current = link.value
  if (!current || saving.value) return false
  saving.value = true
  try {
    link.value = (await linkUpdate({ id: current.id, ...change })).link
    if (done) toast.push(done)
    emit('changed')
    return true
  } catch (err) {
    toast.push(shareErrorText(err), 'danger')
    return false
  } finally {
    saving.value = false
  }
}

const AUDIENCE_OFF = 'off'
const accessValue = computed(() => (!link.value ? AUDIENCE_OFF : !link.value.enabled ? AUDIENCE_OFF : link.value.audience))
const accessChoices = computed(() => {
  const current = link.value?.audience
  const allowed = audiences.value.filter((item) => !item.disabled || item.value === current).map((item) => ({ value: item.value as string, label: item.label }))
  return [...allowed, { value: AUDIENCE_OFF, label: '关闭链接' }]
})
async function setAccess(value: string | number) {
  if (value === AUDIENCE_OFF) {
    await patch({ enabled: false }, '链接已关闭,旧地址暂时打不开;再选一个范围就能重新打开')
  } else {
    await patch({ audience: value as LinkAudience, enabled: true }, `谁能访问:${AUDIENCE_LABEL[value as LinkAudience]}`)
  }
}
const setRole = (value: string | number) => patch({ role: value as GrantRole }, '链接权限已更新')

// 有效期
const expiryChoice = ref<ExpiryChoice>('forever')
const expiryDays = ref('')
const expiryOptions = computed(() => {
  const at = link.value?.expires_at
  const list = EXPIRY_OPTIONS.map((item) => ({ value: item.value as string, label: item.label }))
  return at && link.value?.state !== 'expired' ? [{ value: 'keep', label: expiryText(at) }, ...list] : list
})
watch(
  link,
  (value) => {
    expiryChoice.value = value?.expires_at && value.state !== 'expired' ? 'keep' : 'forever'
    expiryDays.value = ''
  },
  { immediate: true },
)
const expiryDaysError = computed(() => (expiryDays.value ? validateExpiryDays(expiryDays.value) : null))
async function setExpiry(value: string | number) {
  expiryChoice.value = value as ExpiryChoice
  if (value === 'custom' || value === 'keep') return
  await patch(expiryPatch(value as ExpiryChoice), value === 'forever' ? '链接改成永久有效' : '有效期已更新')
}
async function applyCustomExpiry() {
  if (validateExpiryDays(expiryDays.value)) return
  await patch(expiryPatch('custom', expiryDays.value), '有效期已更新')
}

// 访问密码
const passwordOpen = ref(false)
const password = ref('')
const passwordError = ref('')
const passwordOn = computed(() => passwordOpen.value || !!link.value?.has_password)
async function togglePassword(on: boolean) {
  if (on) {
    passwordOpen.value = true
    return
  }
  passwordOpen.value = false
  password.value = ''
  passwordError.value = ''
  if (link.value?.has_password) await patch({ clear_password: true }, '已去掉访问密码')
}
async function savePassword() {
  const problem = validateLinkPassword(password.value)
  if (problem) {
    passwordError.value = problem
    return
  }
  passwordError.value = ''
  if (await patch({ password: password.value }, '访问密码已设置,之前输对过密码的人需要重新输入')) {
    password.value = ''
    passwordOpen.value = false
  }
}
watch(password, () => (passwordError.value = ''))

// ---------------------------------------------------------------- 重置 / 撤销 / 统计

async function resetLink() {
  const current = link.value
  if (!current) return
  const ok = await confirmer.ask({
    title: '重置链接?',
    message: '会换一个新地址,旧地址立刻打不开。设置(范围、角色、有效期、密码)保留。新地址只显示这一次,请马上复制。',
    confirmText: '重置',
    tone: 'danger',
    action: async () => {
      try {
        const made = await linkReset(current.id)
        link.value = made.link
        freshUrl.value = made.url
      } catch (err) {
        // 确认框会原样显示这里抛出的话:换成给人看的
        throw new Error(shareErrorText(err))
      }
    },
  })
  if (ok) {
    emit('changed')
    toast.push('已换成新地址,请现在复制')
  }
}

async function revokeLink() {
  const current = link.value
  if (!current) return
  const ok = await confirmer.ask({
    title: '删除这个链接?',
    message: '删除后地址永久失效,不能恢复。已经通过它加入的协作者不受影响。想以后还能打开,请改选「关闭链接」。',
    confirmText: '删除链接',
    tone: 'danger',
    action: () => linkRevoke(current.id).catch((err: unknown) => Promise.reject(new Error(shareErrorText(err)))),
  })
  if (!ok) return
  link.value = null
  freshUrl.value = ''
  stats.value = null
  statsOpen.value = false
  emit('changed')
  emit('gone')
  toast.push('链接已删除')
}

const stats = ref<LinkStats | null>(null)
const statsOpen = ref(false)
const statsError = ref('')
async function toggleStats() {
  statsOpen.value = !statsOpen.value
  if (!statsOpen.value || !link.value) return
  statsError.value = ''
  try {
    stats.value = await linkStats(link.value.id)
  } catch (err) {
    statsError.value = shareErrorText(err, '访问统计没有加载出来。')
  }
}

const state = computed(() => linkStateOf(link.value?.state ?? 'closed'))
const guestNote = computed(() => (link.value ? guestCeilingNote(link.value) : ''))
const showRole = computed(() => link.value?.audience !== 'collaborators')
const statsLine = computed(() => {
  const current = link.value
  if (!current) return ''
  if (!current.views) return '还没有人打开过。'
  return `已被打开 ${current.views} 次,最近一次 ${relativeTime(current.last_view_at)}。`
})
</script>

<template>
  <div class="kb-share-link-tab" data-testid="share-link">
    <KbSkeleton v-if="status === 'loading'" variant="card" :lines="3" />

    <KbEmpty
      v-else-if="status === 'denied'"
      icon="lock"
      title="你没有权限管理这里的链接"
      :description="deniedText || '只有所有者和「可管理」的人能创建或修改分享链接。'"
      size="sm"
      data-testid="share-denied"
    />

    <KbEmpty v-else-if="status === 'error'" icon="failed" title="链接设置没有加载出来" :description="errorText" size="sm" data-testid="share-error">
      <template #action><KbButton size="sm" @click="load">重试</KbButton></template>
    </KbEmpty>

    <!-- 还没有链接:选范围和角色再创建(创建是一个明确的动作,不在选下拉时悄悄发生) -->
    <form v-else-if="!link" class="kb-share-create" data-testid="share-link-create" @submit.prevent="createLink">
      <KbEmpty
        icon="link"
        :title="bundle ? '给选中的这些项生成一个合集链接' : '还没有分享链接'"
        :description="bundle ? '打开后是一个目录,里面就是选中的内容(文件夹照常展开)。合集里的内容以后被删除或移出权限,打开时自动不显示。' : '创建后把地址发给对方,不需要逐个添加协作者。'"
        size="sm"
      />
      <label v-if="bundle" class="kb-share-field">
        合集名称
        <KbInput v-model="createTitle" :placeholder="bundleTitle || `合集(${targets.length} 项)`" aria-label="合集名称" maxlength="60" />
      </label>
      <div class="kb-share-field">
        谁可以访问
        <KbSelect v-model="createAudience" :options="createAudienceChoices" aria-label="谁可以访问" data-testid="share-create-audience" />
        <small v-if="createAudience === 'anyone'" class="kb-share-warn">不用登录就能打开,请只把链接发给你信任的人。</small>
        <small v-else-if="createAudience === 'collaborators'">链接只是个地址,没有额外权限,只有协作者能打开。</small>
        <small v-else>登录后拿到链接的人都能打开。</small>
        <small v-if="lockedAudiences.length" class="kb-share-hint">你的账号没有开通:{{ lockedAudiences.join('、') }}。需要的话请联系管理员。</small>
      </div>
      <div v-if="createAudience !== 'collaborators'" class="kb-share-field">
        他们可以
        <KbSelect v-model="createRole" :options="roleChoices" aria-label="链接给的权限" data-testid="share-create-role" />
      </div>
      <div class="kb-share-field">
        有效期
        <KbSelect v-model="createExpiry" :options="EXPIRY_OPTIONS.map((item) => ({ value: item.value, label: item.label }))" aria-label="有效期" />
        <KbInput v-if="createExpiry === 'custom'" v-model="createDays" placeholder="天数,1–3650" inputmode="numeric" aria-label="自定义有效期(天)" />
        <small v-if="createDaysError" class="kb-share-error" role="alert">{{ createDaysError }}</small>
      </div>
      <p v-if="createError" class="kb-share-error" role="alert" data-testid="share-create-error">{{ createError }}</p>
      <div class="kb-share-actions">
        <KbButton variant="primary" :disabled="creating || !!createDaysError" data-testid="share-create-submit" @click="createLink">
          {{ creating ? '创建中…' : bundle ? '生成合集链接' : '创建链接' }}
        </KbButton>
      </div>
    </form>

    <!-- 已有链接 -->
    <template v-else>
      <div class="kb-share-state">
        <KbBadge :tone="state.tone">{{ state.text }}</KbBadge>
        <span v-if="link.bundle" class="kb-share-sub">合集链接 · {{ link.roots.length }} 项{{ link.title ? ` ·「${link.title}」` : '' }}</span>
        <span v-if="link.state === 'expired'" class="kb-share-warn">链接已过期,在下面选一个新的有效期就能恢复。</span>
      </div>

      <!-- 地址:完整地址只在创建 / 重置后这一次能看到 -->
      <div v-if="freshUrl" class="kb-share-url is-fresh" data-testid="share-fresh-url">
        <div class="kb-share-url-row">
          <code class="kb-share-url-text" data-testid="share-url">{{ freshUrl }}</code>
          <KbCopyButton :text="freshUrl" label="复制链接" variant="primary" size="md" @copied="(ok: boolean) => ok && (urlCopied = true)" />
        </div>
        <p class="kb-share-warn" role="status">完整地址只显示这一次,关掉这个面板就找不回来了,请现在复制。丢了也没关系,可以「重置链接」换一个新地址。</p>
      </div>
      <div v-else class="kb-share-url" data-testid="share-masked-url">
        <div class="kb-share-url-row">
          <code class="kb-share-url-text">{{ maskedLink(link.hint) }}</code>
          <KbButton size="sm" data-testid="share-reset" @click="resetLink">重置链接</KbButton>
        </div>
        <p class="kb-share-hint">为了安全,完整地址只在创建或重置时显示一次。需要新地址就重置(旧地址会立刻失效)。</p>
      </div>

      <div class="kb-share-opts">
        <div class="kb-share-opt">
          <div class="kb-share-opt-text">
            <b>谁可以访问</b>
            <small v-if="!link.enabled">链接已关闭,选一个范围可重新打开(设置保留)</small>
            <small v-else-if="link.audience === 'collaborators'">链接只是个地址,没有额外权限</small>
            <small v-else-if="link.audience === 'logged_in'">登录后拿到链接的人都能打开</small>
            <small v-else>不用登录就能打开</small>
          </div>
          <KbSelect :model-value="accessValue" :options="accessChoices" align="end" aria-label="谁可以访问" data-testid="share-access" @update:model-value="setAccess" />
        </div>

        <div v-if="showRole" class="kb-share-opt">
          <div class="kb-share-opt-text"><b>他们可以</b><small>通过链接进来的人拥有的权限</small></div>
          <KbSelect :model-value="link.role" :options="roleChoices" align="end" aria-label="链接给的权限" data-testid="share-role" @update:model-value="setRole" />
        </div>
        <p v-if="guestNote" class="kb-share-note" data-testid="share-guest-note">{{ guestNote }}</p>

        <div class="kb-share-opt">
          <div class="kb-share-opt-text"><b>有效期</b><small>{{ expiryText(link.expires_at) }}</small></div>
          <KbSelect :model-value="expiryChoice" :options="expiryOptions" align="end" aria-label="有效期" data-testid="share-expiry" @update:model-value="setExpiry" />
        </div>
        <div v-if="expiryChoice === 'custom'" class="kb-share-inline">
          <KbInput v-model="expiryDays" placeholder="天数,1–3650" inputmode="numeric" aria-label="自定义有效期(天)" @keydown.enter.prevent="applyCustomExpiry" />
          <KbButton :disabled="!expiryDays || !!expiryDaysError || saving" @click="applyCustomExpiry">应用</KbButton>
        </div>
        <p v-if="expiryChoice === 'custom' && expiryDaysError" class="kb-share-error" role="alert">{{ expiryDaysError }}</p>

        <div class="kb-share-opt">
          <div class="kb-share-opt-text"><b>访问密码</b><small>{{ link.has_password ? '已设置;访客需要输入 4–12 位密码' : '访客需要输入 4–12 位密码' }}</small></div>
          <KbSwitch :model-value="passwordOn" :disabled="saving" aria-label="访问密码" data-testid="share-password-switch" @update:model-value="togglePassword" />
        </div>
        <div v-if="passwordOn" class="kb-share-inline" data-testid="share-password-row">
          <KbInput v-model="password" :placeholder="link.has_password ? '输入新密码可修改' : '4–12 位密码'" autocomplete="new-password" aria-label="访问密码" @keydown.enter.prevent="savePassword" />
          <KbButton variant="primary" :disabled="!password || saving" data-testid="share-password-save" @click="savePassword">{{ link.has_password ? '修改密码' : '设置密码' }}</KbButton>
        </div>
        <p v-if="passwordError" class="kb-share-error" role="alert" data-testid="share-password-error">{{ passwordError }}</p>

        <div class="kb-share-opt">
          <div class="kb-share-opt-text"><b>允许下载、复制和打印</b><small>关闭后界面上不提供这些操作,但无法阻止截屏</small></div>
          <KbSwitch :model-value="link.allow_download" :disabled="saving" aria-label="允许下载、复制和打印" data-testid="share-download" @update:model-value="(on: boolean) => patch({ allow_download: on })" />
        </div>
        <div class="kb-share-opt">
          <div class="kb-share-opt-text"><b>显示水印</b><small>在页面上显示访问者名称和时间</small></div>
          <KbSwitch :model-value="link.watermark" :disabled="saving" aria-label="显示水印" data-testid="share-watermark" @update:model-value="(on: boolean) => patch({ watermark: on })" />
        </div>
      </div>

      <!-- 访问统计 -->
      <div class="kb-share-statsbox">
        <p class="kb-share-note" data-testid="share-stats-line">{{ statsLine }}</p>
        <button v-if="link.views" type="button" class="kb-share-link" :aria-expanded="statsOpen" @click="toggleStats">{{ statsOpen ? '收起访问统计' : '查看访问统计' }}</button>
        <div v-if="statsOpen" class="kb-share-visitors" data-testid="share-stats">
          <p v-if="statsError" class="kb-share-error" role="alert">{{ statsError }}</p>
          <template v-else-if="stats">
            <ul v-if="stats.visitors.length" class="kb-share-list" aria-label="登录访问者">
              <li v-for="visitor in stats.visitors" :key="visitor.user?.id ?? visitor.first_at" class="kb-share-row">
                <UserAvatar v-if="visitor.user" :user-id="visitor.user.id" :name="personName(visitor.user)" :file="visitor.user.avatar" :size="24" />
                <div class="kb-share-who">
                  <b>{{ visitor.user ? personName(visitor.user) : '已注销的用户' }}</b>
                  <small>打开 {{ visitor.visits }} 次 · 最近 {{ relativeTime(visitor.last_at) }}</small>
                </div>
              </li>
            </ul>
            <p v-else class="kb-share-hint">还没有登录的访问者。</p>
            <p class="kb-share-hint">{{ stats.anonymous_note }}。</p>
          </template>
          <KbSkeleton v-else variant="lines" :lines="2" />
        </div>
      </div>

      <div class="kb-share-actions is-split">
        <KbButton v-if="freshUrl" size="sm" @click="resetLink">重置链接</KbButton>
        <KbButton size="sm" variant="danger" data-testid="share-revoke" @click="revokeLink">删除链接</KbButton>
      </div>
    </template>
  </div>
</template>

<style>
.kb-share-link-tab { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.kb-share-create { display: flex; flex-direction: column; gap: var(--sp-3); }
.kb-share-field { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; font-size: var(--text-13); color: var(--text-secondary); }
.kb-share-field small { color: var(--text-tertiary); font-size: var(--text-12); }
.kb-share-field small.kb-share-warn { color: var(--status-warning-text); }
.kb-share-field .kb-input { width: 100%; }
.kb-share-state { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.kb-share-url { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border-radius: var(--r2); border: var(--hl) solid var(--border-subtle); background: rgb(var(--ink), 0.03); }
.kb-share-url.is-fresh { border-color: color-mix(in oklab, var(--accent) 45%, transparent); background: color-mix(in oklab, var(--accent) 8%, transparent); }
.kb-share-url-row { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; flex-wrap: wrap; }
.kb-share-url-text { flex: 1; min-width: 0; font-family: var(--mono); font-size: var(--text-12); color: var(--text-secondary); overflow-wrap: anywhere; word-break: break-all; }
.kb-share-url.is-fresh .kb-share-url-text { color: var(--text-primary); }
.kb-share-opts { display: flex; flex-direction: column; }
.kb-share-opts .kb-share-opt { padding: var(--sp-3) 0; border-top: var(--hl) solid var(--border-subtle); }
.kb-share-opts .kb-share-opt:first-child { border-top: 0; }
.kb-share-inline { display: flex; gap: var(--sp-2); align-items: center; padding-bottom: var(--sp-2); }
.kb-share-inline .kb-input { flex: 1; min-width: 0; }
.kb-share-statsbox { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2); }
.kb-share-statsbox .kb-share-note { align-self: stretch; }
.kb-share-visitors { align-self: stretch; }
</style>
