<script setup lang="ts">
// 邀请码管理(用户页的「邀请码」标签;后端见 kb-cli/src/admin_registration.rs)。
// 明文邀请码只在生成的那一刻显示一次,关掉窗口后列表里只剩前缀;要给别人就得当场复制。
import { computed, onMounted, ref } from 'vue'
import { KbBadge, KbButton, KbDialog, KbEmpty, KbInput, useConfirm, useToast } from '@kb-ui/index'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import { failureOf, friendly, type LoadPhase } from '@/utils/loadState'
import {
  inviteCreate,
  inviteList,
  inviteRevoke,
  inviteUses,
  type InviteRow,
  type InviteState,
  type RoleRow,
} from '@/utils/adminApi'
import { timeAgo } from '@/utils/agent'
import {
  EXPIRY_OPTIONS,
  STATE_LABELS,
  codesText,
  emptyInviteForm,
  expiryText,
  inviteArgs,
  stateTone,
  usageText,
} from '@/utils/invites'

const props = defineProps<{ roles: RoleRow[] }>()

const toast = useToast()
const confirm = useConfirm()
const rows = ref<{ invite: InviteRow; state: InviteState }[]>([])
const now = ref(Date.now())
const phase = ref<LoadPhase>('loading')
const message = ref('')

async function load() {
  const reply = await inviteList()
  rows.value = reply.invites
  now.value = reply.now
}

/** 读列表:失败就把整块换成「出了什么事 + 重试」。撤销 / 生成之后也走这里,免得列表没刷新还显示着旧状态 */
async function reload() {
  if (!rows.value.length) phase.value = 'loading'
  try {
    await load()
    phase.value = 'ready'
  } catch (err) {
    const failure = failureOf(err, '读取邀请码')
    phase.value = failure.phase
    message.value = failure.message
  }
}

onMounted(() => void reload())

// 没指定角色的邀请码,注册时用「系统参数 → 注册 → 新用户的默认角色」,这里不猜它叫什么
const roleName = (id: string | null) => (id ? (props.roles.find((role) => role.id === id)?.name ?? id) : '系统默认')
// 邀请码不能授予管理员角色(后端也会拒),所以下拉里不列出它们
const grantableRoles = computed(() => props.roles.filter((role) => !role.all_features))

// ---------------------------------------------------------------- 生成
const creating = ref(false)
const form = ref(emptyInviteForm())
const submitting = ref(false)
const created = ref<string[]>([])

function openCreate() {
  form.value = emptyInviteForm()
  creating.value = true
}

async function submit() {
  const result = inviteArgs(form.value)
  if ('error' in result) {
    toast.push(result.error, 'danger')
    return
  }
  submitting.value = true
  try {
    const reply = await inviteCreate(result.args)
    created.value = reply.invites.map((item) => item.code)
    creating.value = false
    await reload()
  } catch (err) {
    toast.push(failureOf(err, '生成邀请码').message, 'danger')
  } finally {
    submitting.value = false
  }
}

async function copyAll() {
  try {
    await navigator.clipboard.writeText(codesText(created.value))
    toast.push('已复制')
  } catch {
    toast.push('浏览器不允许自动复制,请手动选中复制', 'warning')
  }
}

// ---------------------------------------------------------------- 撤销与使用记录
async function revoke(invite: InviteRow) {
  const ok = await confirm.ask({
    title: `撤销邀请码 ${invite.prefix}…?`,
    message: '撤销后不能再用它注册,也不能恢复;已经用它注册的账号不受影响。要继续邀请,再生成新的邀请码。',
    confirmText: '撤销',
    tone: 'danger',
    action: () => friendly(inviteRevoke(invite.id), '撤销邀请码'),
  })
  if (ok) await reload()
}

const openId = ref('')
const uses = ref<{ user_id: string; username: string | null; ip: string | null; at: number }[]>([])
async function toggleUses(invite: InviteRow) {
  if (openId.value === invite.id) {
    openId.value = ''
    return
  }
  openId.value = invite.id
  uses.value = []
  try {
    uses.value = (await inviteUses(invite.id)).uses
  } catch (err) {
    toast.push(failureOf(err, '读取使用记录').message, 'danger')
  }
}

defineExpose({ openCreate })
</script>

<template>
  <div class="kb-inv">
    <div class="kb-inv-bar">
      <span class="m kb-small">邀请码在注册页填写。是否必须填写,在「系统参数 → 注册」里控制。</span>
      <KbButton variant="primary" @click="openCreate">生成邀请码</KbButton>
    </div>

    <AdminLoadState v-if="phase !== 'ready'" :phase="phase" :message="message" skeleton="lines" @retry="reload()" />
    <KbEmpty v-else-if="!rows.length" title="还没有邀请码" description="生成后可以发给要邀请的人;对方在注册页填写它。">
      <template #action><KbButton variant="primary" @click="openCreate">生成邀请码</KbButton></template>
    </KbEmpty>

    <ul v-else class="kb-inv-list">
      <li v-for="item in rows" :key="item.invite.id" :class="{ 'is-dead': item.state !== 'active' }">
        <div class="kb-inv-main">
          <div class="kb-inv-title">
            <code>{{ item.invite.prefix }}…</code>
            <KbBadge :tone="stateTone(item.state)">{{ STATE_LABELS[item.state] }}</KbBadge>
            <span v-if="item.invite.note" class="kb-inv-note">{{ item.invite.note }}</span>
          </div>
          <small class="m">
            {{ usageText(item.invite) }} · {{ expiryText(item.invite.expires_at, now) }} · 角色:{{ roleName(item.invite.role_id) }}
            · 创建于 {{ timeAgo(item.invite.created_at) }}
          </small>
        </div>
        <div class="kb-inv-actions">
          <KbButton v-if="item.invite.used > 0" size="sm" @click="toggleUses(item.invite)">
            {{ openId === item.invite.id ? '收起' : '使用记录' }}
          </KbButton>
          <KbButton v-if="item.state === 'active'" size="sm" variant="danger" @click="revoke(item.invite)">撤销</KbButton>
        </div>
        <ul v-if="openId === item.invite.id" class="kb-inv-uses">
          <li v-for="use in uses" :key="use.user_id + use.at">
            <b>{{ use.username ?? '(账号已删除)' }}</b>
            <small class="m">{{ timeAgo(use.at) }}<template v-if="use.ip"> · {{ use.ip }}</template></small>
          </li>
          <li v-if="!uses.length" class="m kb-small">加载中…</li>
        </ul>
      </li>
    </ul>

    <KbDialog v-if="creating" title="生成邀请码" subtitle="明文只显示一次,请当场复制" @close="creating = false">
      <div class="kb-ut-form">
        <label>备注(可选)<KbInput v-model="form.note" placeholder="例如:内测第一批" /></label>
        <label>
          角色
          <select v-model="form.role_id" class="kb-ut-select">
            <option value="">系统默认角色</option>
            <option v-for="role in grantableRoles" :key="role.id" :value="role.id">{{ role.name }}</option>
          </select>
        </label>
        <label>
          有效期
          <select v-model.number="form.expires_days" class="kb-ut-select">
            <option v-for="option in EXPIRY_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label>每个码可用次数<KbInput v-model="form.max_uses" inputmode="numeric" /></label>
        <label>一次生成几个<KbInput v-model="form.count" inputmode="numeric" /></label>
        <label>存储配额(GB,可选)<KbInput v-model="form.storage_gb" inputmode="numeric" placeholder="留空 = 沿用角色或系统默认" /></label>
        <div class="kb-ut-actions">
          <KbButton @click="creating = false">取消</KbButton>
          <KbButton variant="primary" :disabled="submitting" @click="submit">{{ submitting ? '生成中…' : '生成' }}</KbButton>
        </div>
      </div>
    </KbDialog>

    <KbDialog
      v-if="created.length"
      :title="created.length === 1 ? '邀请码已生成' : `已生成 ${created.length} 个邀请码`"
      subtitle="关闭后不再显示明文,请现在复制保存"
      no-autofocus
      :close-on-scrim="false"
      @close="created = []"
    >
      <div class="kb-ut-form">
        <ul class="kb-inv-codes">
          <li v-for="code in created" :key="code"><code>{{ code }}</code></li>
        </ul>
        <div class="kb-ut-actions">
          <KbButton @click="copyAll">复制{{ created.length > 1 ? '全部' : '' }}</KbButton>
          <KbButton variant="primary" @click="created = []">我已保存</KbButton>
        </div>
      </div>
    </KbDialog>
  </div>
</template>

<style>
.kb-inv{display:flex;flex-direction:column;gap:var(--gap-md,12px)}
.kb-inv-bar{display:flex;align-items:center;justify-content:space-between;gap:var(--gap-md,12px);flex-wrap:wrap}
.kb-inv-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;border:var(--hl) solid var(--b);border-radius:var(--r2);overflow:hidden}
.kb-inv-list>li{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px var(--card-pad-x,16px);border-top:var(--hl) solid var(--b)}
.kb-inv-list>li:first-child{border-top:0}
.kb-inv-list>li.is-dead .kb-inv-main{opacity:.6}
.kb-inv-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.kb-inv-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kb-inv-note{color:var(--text-secondary);min-width:0;overflow-wrap:anywhere}
.kb-inv-actions{display:flex;gap:8px}
.kb-inv-uses{flex-basis:100%;list-style:none;margin:0;padding:8px 12px;display:flex;flex-direction:column;gap:6px;border-radius:var(--r2);background:rgb(var(--ink),.04)}
.kb-inv-uses li{display:flex;justify-content:space-between;gap:8px}
.kb-inv-codes{list-style:none;margin:0;padding:12px;display:flex;flex-direction:column;gap:6px;border-radius:var(--r2);background:var(--surface-sunken);max-height:40vh;overflow:auto}
.kb-inv-codes code{font-size:calc(15px*var(--fs));letter-spacing:.04em;user-select:all}
</style>
