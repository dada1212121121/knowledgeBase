<script setup lang="ts">
// 邮件设置(系统参数页里的「邮件」分组;后端见 kb-cli/src/admin_registration.rs)。
// 注册验证码和找回密码都靠这里配置的邮箱发出。可以配一个主账号和一个备用账号:主账号发不出去时自动改用备用。
// 授权码(不是登录密码)只写不读:页面永远拿不到已保存的授权码,只知道「有没有设置」。
import { computed, onMounted, reactive, ref } from 'vue'
import { KbBadge, KbButton, KbInput, KbSelect, KbSwitch, useConfirm, useToast } from '@kb-ui/index'
import { callCapability } from '@/api/client'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import { failureOf, type LoadPhase } from '@/utils/loadState'
import {
  mailLog,
  mailPassword,
  mailStatus,
  mailTest,
  type MailLogRow,
  type MailSlot,
  type MailStatus,
} from '@/utils/adminApi'
import { timeAgo } from '@/utils/agent'
import {
  CUSTOM_PRESET,
  accountPatch,
  applyPreset,
  formFromAccount,
  logResult,
  mailKindLabel,
  passwordPlaceholder,
  slotLabel,
  type AccountForm,
} from '@/utils/mailSettings'

const toast = useToast()
const confirm = useConfirm()
const status = ref<MailStatus | null>(null)
const log = ref<MailLogRow[]>([])
// 邮件设置自己的读取状态:读不到只影响这一块,换成「出了什么事 + 重试」
const phase = ref<LoadPhase>('loading')
const problem = ref('')

interface SlotState {
  form: AccountForm
  password: string
  testTo: string
  saving: boolean
  savingPassword: boolean
  testing: boolean
  testResult: { ok: boolean; text: string } | null
}

function emptySlot(): SlotState {
  return {
    form: formFromAccount({ preset: CUSTOM_PRESET, host: '', port: 465, security: 'tls', username: '', configured: false, password_set: false }),
    password: '',
    testTo: '',
    saving: false,
    savingPassword: false,
    testing: false,
    testResult: null,
  }
}

const slots = reactive<Record<MailSlot, SlotState>>({ primary: emptySlot(), backup: emptySlot() })
const general = reactive({ enabled: false, from_name: '', per_minute: '30', saving: false })

async function load(initial = false) {
  const value = await mailStatus()
  status.value = value
  general.enabled = value.enabled
  general.from_name = value.from_name
  general.per_minute = String(value.per_minute)
  // 首次加载填表单;之后刷新(保存、发测试后)只更新状态,不覆盖用户正在改的内容
  if (initial) {
    slots.primary.form = formFromAccount(value.primary)
    slots.backup.form = formFromAccount(value.backup)
  }
  log.value = (await mailLog(30)).log
}

async function init() {
  phase.value = 'loading'
  try {
    await load(true)
    phase.value = 'ready'
  } catch (err) {
    const failure = failureOf(err, '读取邮件设置')
    phase.value = failure.phase
    problem.value = failure.message
  }
}
onMounted(() => void init())

const presetOptions = computed(() => [
  ...(status.value?.presets ?? []).map((preset) => ({ value: preset.id, label: preset.name })),
  { value: CUSTOM_PRESET, label: '自定义' },
])

function choosePreset(slot: MailSlot, id: string) {
  slots[slot].form = applyPreset(slots[slot].form, id, status.value?.presets ?? [])
}

async function patchConfig(patch: Record<string, unknown>) {
  const reply = await callCapability<{ applied: boolean; notes: string[] }>('update_config', { patch, confirm: true })
  if (!reply.applied) throw new Error(reply.notes?.join(';') || '没有写入')
}

async function guard(action: () => Promise<void>) {
  try {
    await action()
  } catch (err) {
    toast.push(failureOf(err, '保存邮件设置').message, 'danger')
  }
}

async function saveGeneral() {
  const perMinute = Number(general.per_minute)
  if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 600) {
    toast.push('每分钟发信上限需要是 1–600 的整数', 'danger')
    return
  }
  general.saving = true
  await guard(async () => {
    await patchConfig({ mail: { enabled: general.enabled, from_name: general.from_name.trim(), per_minute: perMinute } })
    toast.push('邮件设置已保存,立即生效')
    await load()
  })
  general.saving = false
}

async function saveAccount(slot: MailSlot) {
  const result = accountPatch(slots[slot].form)
  if ('error' in result) {
    toast.push(result.error, 'danger')
    return
  }
  slots[slot].saving = true
  await guard(async () => {
    await patchConfig({ mail: { [slot]: result.patch } })
    toast.push(`${slotLabel(slot)}已保存`)
    await load()
  })
  slots[slot].saving = false
}

async function savePassword(slot: MailSlot) {
  const state = slots[slot]
  if (state.password.trim() === '') return
  state.savingPassword = true
  await guard(async () => {
    await mailPassword(slot, state.password)
    // 授权码写进去就立刻从页面状态里清掉,不在内存里多留
    state.password = ''
    toast.push('授权码已保存')
    await load()
  })
  state.savingPassword = false
}

async function clearPassword(slot: MailSlot) {
  const ok = await confirm.ask({
    title: `清除${slotLabel(slot)}的授权码?`,
    message: '清除后这个账号无法发信,直到重新填写授权码。',
    confirmText: '清除',
    tone: 'danger',
    action: () => mailPassword(slot, ''),
  })
  if (ok) await guard(() => load())
}

async function sendTest(slot: MailSlot) {
  const state = slots[slot]
  state.testing = true
  state.testResult = null
  await guard(async () => {
    const result = await mailTest(slot, state.testTo.trim() || undefined)
    state.testResult = result.ok
      ? { ok: true, text: `测试邮件已发到 ${result.to},请到收件箱确认(也看看垃圾箱)` }
      : { ok: false, text: result.error ?? '发送失败' }
    await load()
  })
  state.testing = false
}

const slotList: MailSlot[] = ['primary', 'backup']
const securityOptions = [
  { value: 'tls', label: 'SSL/TLS(465)' },
  { value: 'starttls', label: 'STARTTLS(587)' },
]
</script>

<template>
  <div class="kb-mail">
    <AdminLoadState v-if="phase !== 'ready'" :phase="phase" :message="problem" skeleton="lines" @retry="init()" />
    <template v-else-if="status">
      <div class="kb-sp-row">
        <div class="kb-sp-text">
          <span>启用邮件</span>
          <small class="m">关闭后无法邮箱注册和找回密码,已有账号仍可正常登录</small>
        </div>
        <div class="kb-sp-ctl"><KbSwitch v-model="general.enabled" aria-label="启用邮件" /></div>
      </div>
      <div class="kb-sp-row">
        <div class="kb-sp-text">
          <span>发件人名称</span>
          <small class="m">留空则使用站点名称</small>
        </div>
        <div class="kb-sp-ctl"><KbInput v-model="general.from_name" aria-label="发件人名称" /></div>
      </div>
      <div class="kb-sp-row">
        <div class="kb-sp-text">
          <span>全站每分钟最多发信</span>
          <small class="m">防止被人刷验证码邮件;已发出的邮件在下面「最近发信」里</small>
        </div>
        <div class="kb-sp-ctl"><KbInput v-model="general.per_minute" inputmode="numeric" aria-label="全站每分钟最多发信" /><span class="m kb-small">封</span></div>
      </div>
      <div class="kb-mail-pad kb-mail-actions">
        <KbBadge :tone="status.ready ? 'success' : 'warning'">{{ status.ready ? '可以发信' : '还不能发信:请先配置发件账号' }}</KbBadge>
        <span class="m kb-small">最近一小时已发 {{ status.sent_last_hour }} 封</span>
        <span class="kb-spacer"></span>
        <KbButton variant="primary" :disabled="general.saving" @click="saveGeneral">{{ general.saving ? '保存中…' : '保存' }}</KbButton>
      </div>

      <section v-for="slot in slotList" :key="slot" class="kb-mail-slot" :aria-label="slotLabel(slot)">
        <header>
          <b>{{ slotLabel(slot) }}</b>
          <KbBadge v-if="slot === 'backup'" tone="neutral">可选</KbBadge>
          <KbBadge v-if="status[slot].configured && status[slot].password_set" tone="success">已配置</KbBadge>
          <KbBadge v-else-if="status[slot].configured" tone="warning">缺授权码</KbBadge>
        </header>
        <p v-if="slot === 'backup'" class="m kb-small">主账号发不出去(被限额、被拒绝、连不上)时自动改用它;主账号恢复前一小时内都走备用。</p>

        <div class="kb-mail-grid">
          <label>邮箱服务商
            <KbSelect
              :model-value="slots[slot].form.preset"
              :options="presetOptions"
              @update:model-value="(value: string | number) => choosePreset(slot, String(value))"
            />
          </label>
          <label>登录名(发件地址)
            <KbInput v-model="slots[slot].form.username" placeholder="noreply@qq.com" />
          </label>
          <template v-if="slots[slot].form.preset === CUSTOM_PRESET">
            <label>SMTP 服务器<KbInput v-model="slots[slot].form.host" placeholder="smtp.example.com" /></label>
            <label>端口<KbInput v-model="slots[slot].form.port" /></label>
            <label>加密方式
              <KbSelect
                :model-value="slots[slot].form.security"
                :options="securityOptions"
                @update:model-value="(value: string | number) => (slots[slot].form.security = String(value))"
              />
            </label>
          </template>
          <p v-else class="m kb-small kb-mail-wide">服务器 {{ slots[slot].form.host }}:{{ slots[slot].form.port }}(加密连接)</p>
        </div>
        <div class="kb-mail-actions">
          <KbButton :disabled="slots[slot].saving" @click="saveAccount(slot)">{{ slots[slot].saving ? '保存中…' : '保存账号设置' }}</KbButton>
        </div>

        <div class="kb-mail-grid">
          <label class="kb-mail-wide">授权码
            <KbInput
              v-model="slots[slot].password"
              type="password"
              autocomplete="new-password"
              :placeholder="passwordPlaceholder(status[slot].password_set)"
            />
            <small class="m">在邮箱网页版的「设置 → 账号」里开启 SMTP 并生成。保存后不会再显示。</small>
          </label>
        </div>
        <div class="kb-mail-actions">
          <KbButton :disabled="slots[slot].savingPassword || slots[slot].password.trim() === ''" @click="savePassword(slot)">
            保存授权码
          </KbButton>
          <KbButton v-if="status[slot].password_set" variant="danger" @click="clearPassword(slot)">清除授权码</KbButton>
        </div>

        <div class="kb-mail-test">
          <KbInput v-model="slots[slot].testTo" placeholder="收件邮箱(不填则发给你自己)" />
          <KbButton :disabled="slots[slot].testing || !status[slot].configured" @click="sendTest(slot)">
            {{ slots[slot].testing ? '发送中…' : '发送测试邮件' }}
          </KbButton>
        </div>
        <p v-if="slots[slot].testResult" class="kb-small" :class="slots[slot].testResult.ok ? 'kb-mail-ok' : 'kb-mail-bad'" role="status">
          {{ slots[slot].testResult.ok ? '✓ ' : '✗ ' }}{{ slots[slot].testResult.text }}
        </p>
        <p class="m kb-small">测试只用这个账号发,不会自动改用另一个,所以这里报错就是它真的有问题。</p>
      </section>

      <section class="kb-mail-slot" aria-label="最近发信">
        <header><b>最近发信</b></header>
        <p v-if="!log.length" class="m kb-small">还没有发过邮件。</p>
        <ul v-else class="kb-mail-log">
          <li v-for="row in log" :key="row.id">
            <div class="kb-mail-log-main">
              <span class="kb-mail-log-to">{{ row.to_addr }}</span>
              <small class="m">{{ mailKindLabel(row.kind) }} · {{ timeAgo(row.at) }}</small>
            </div>
            <KbBadge :tone="logResult(row).tone" :title="logResult(row).full">{{ logResult(row).text }}</KbBadge>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style>
.kb-mail-pad{padding:12px var(--card-pad-x,16px)}
.kb-mail-slot{display:flex;flex-direction:column;gap:var(--gap-sm,8px);padding:14px var(--card-pad-x,16px);border-top:var(--hl) solid var(--b)}
.kb-mail-slot>header{display:flex;align-items:center;gap:8px}
.kb-mail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--gap-sm,8px) var(--gap-md,12px)}
.kb-mail-grid label{display:flex;flex-direction:column;gap:4px;font-size:calc(13px*var(--fs));color:var(--text-secondary);min-width:0}
.kb-mail-grid label small{color:var(--text-tertiary)}
.kb-mail-wide{grid-column:1/-1}
.kb-mail-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kb-mail-test{display:flex;gap:8px;align-items:center}
.kb-mail-test .kb-input,.kb-mail-test input{flex:1;min-width:0}
.kb-mail-ok{color:var(--status-success)}
.kb-mail-bad{color:var(--status-danger)}
.kb-mail-log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.kb-mail-log li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-top:var(--hl) solid var(--b)}
.kb-mail-log li:first-child{border-top:0}
.kb-mail-log-main{display:flex;flex-direction:column;min-width:0}
.kb-mail-log-to{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-mail-log .tag{max-width:55%;white-space:normal;text-align:right}
/* 失败原因是服务器返回的整段话,会换成两三行;.tag 默认固定 20px 高(只放短词),文字会溢出徽章压到下一条的分隔线上。
   这里让徽章随内容撑高,单行时仍是 20px */
.kb-mail-log .tag{height:auto;min-height:20px;padding-top:2px;padding-bottom:2px;line-height:1.4;overflow-wrap:anywhere}
@media (max-width:699px){
  .kb-mail-grid{grid-template-columns:minmax(0,1fr)}
  .kb-mail-test{flex-direction:column;align-items:stretch}
  /* 纵向排列时 flex:1 会把输入框的高度基准压成 0,文字被裁掉 */
  .kb-mail-test .kb-input,.kb-mail-test input{flex:none}
  /* 纵向排列时必须 stretch:flex-start 会让收件人一栏按整串地址的宽度撑开(nowrap 的最小内容宽度),把卡片撑出屏幕,省略号也就失效了(clipcheck 抓到) */
  .kb-mail-log li{flex-direction:column;align-items:stretch;gap:4px}
  .kb-mail-log .tag{max-width:100%;text-align:left;align-self:flex-start}
}
</style>
