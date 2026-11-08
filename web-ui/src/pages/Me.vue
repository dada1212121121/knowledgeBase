<script setup lang="ts">
import { localeDateTime } from '@/utils/time'
// 个人设置(多用户设计说明–5.7):个人资料(头像、昵称)、安全(改密码)、登录设备。
// 只组合 kb-ui 组件。头像先在本地预览、确认后才上传;所有改动都以服务端返回为准,保存成功后刷新全站的用户信息。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import TokenCard from '@/components/TokenCard.vue'
import TotpCard from '@/components/TotpCard.vue'
import MyUsageCard from '@/components/MyUsageCard.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import NotificationPrefs from '@/components/NotificationPrefs.vue'
import { KbBadge, KbButton, KbCard, KbDialog, KbEmpty, KbInput, KbSkeleton, useConfirm, useToast } from '@kb-ui/index'
import {
  EXPORT_DOWNLOAD_URL,
  authStatus,
  cancelAccountDeletion,
  changePassword,
  confirmEmailChange,
  discardExport,
  exportStatus,
  listSessions,
  removeAvatar,
  requestAccountDeletion,
  requestEmailChangeCode,
  revokeOtherSessions,
  revokeSession,
  startExport,
  updateDisplayName,
  uploadAvatar,
  type ExportState,
  type LoginSession,
} from '@/api/client'
import { useSessionStore } from '@/stores/session'
import { useFeature } from '@/composables/useFeature'
import { timeAgo } from '@/utils/agent'
import { OFFLINE_TEXT, accountErrorText } from '@/utils/accountError'
import { checkAvatarFile } from '@/utils/avatar'
import {
  canCancelDeletion,
  checkDisplayName,
  checkPasswordChange,
  deletionCountdown,
  exportPercent,
  expiresIn,
  formatBytes,
  MAX_DISPLAY_NAME,
} from '@/utils/accountForms'
import { checkPassword } from '@/utils/passwordStrength'
import { looksLikeEmail } from '@/composables/useEmailCode'

const toast = useToast()
const confirm = useConfirm()
const session = useSessionStore()
const user = computed(() => session.user)
// 被「站点要求开启两步验证」的拦截带过来时,地址里有 ?need=totp:滚到两步验证卡片并解释原因
const route = useRoute()
const canTokens = useFeature('api.tokens')

function fail(err: unknown, fallback: string) {
  toast.push(accountErrorText(err, fallback), 'danger')
}

// ---------------------------------------------------------------- 昵称
const nameDraft = ref(user.value?.display_name ?? '')
// 直接打开 /me 时用户信息可能晚到:拿到后填进输入框;用户已经在改的话不要覆盖
watch(
  () => user.value?.display_name,
  (value, previous) => {
    if (value !== undefined && (nameDraft.value === '' || nameDraft.value === previous)) nameDraft.value = value
  },
)
const nameDirty = computed(() => nameDraft.value.trim() !== (user.value?.display_name ?? ''))
const nameError = computed(() => (nameDraft.value === '' && !nameDirty.value ? null : checkDisplayName(nameDraft.value)))
const savingName = ref(false)

async function saveName() {
  const problem = checkDisplayName(nameDraft.value)
  if (problem) return toast.push(problem, 'danger')
  savingName.value = true
  try {
    const result = await updateDisplayName(nameDraft.value.trim())
    nameDraft.value = result.display_name
    await session.load()
    toast.push('昵称已保存')
  } catch (err) {
    fail(err, '昵称没有保存成功。请稍后再试。')
  } finally {
    savingName.value = false
  }
}

// ---------------------------------------------------------------- 头像
const fileInput = ref<HTMLInputElement | null>(null)
const picked = ref<File | null>(null)
const previewUrl = ref('')
const uploading = ref(false)

function releasePreview() {
  previewUrl.value = ''
  picked.value = null
}

// 预览用 data: URL 而不是 blob: URL:站点的内容安全策略 img-src 只放行 'self' 和 data:,blob: 会被拦成破图
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

async function onPick(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 同一个文件再选一次也要触发 change
  input.value = ''
  if (!file) return
  const problem = checkAvatarFile(file)
  if (problem) return toast.push(problem, 'danger')
  try {
    const url = await readAsDataUrl(file)
    picked.value = file
    previewUrl.value = url
  } catch (err) {
    fail(err, '这张图片读不出来。请换一张图片再试。')
  }
}

async function useThisPicture() {
  if (!picked.value || uploading.value) return
  uploading.value = true
  try {
    await uploadAvatar(picked.value)
    releasePreview()
    await session.load()
    toast.push('头像已更新')
  } catch (err) {
    // 保留预览,用户可以换一张或重试
    fail(err, '头像没有上传成功。请稍后再试,或换一张图片。')
  } finally {
    uploading.value = false
  }
}

async function dropAvatar() {
  const ok = await confirm.ask({
    title: '移除头像?',
    message: '移除后会显示名字的首字母。',
    confirmText: '移除',
    tone: 'danger',
    action: () => removeAvatar(),
  })
  if (ok) await session.load()
}

// ---------------------------------------------------------------- 改密码
const pw = ref({ current: '', next: '', confirm: '' })
const strength = computed(() => checkPassword(pw.value.next, (user.value?.username ?? '').toLowerCase()))
const pwProblem = computed(() => checkPasswordChange(pw.value, user.value?.username ?? ''))
// 「两次不一致」是填了两个框就能判断的事,不该被「当前密码还没填」遮住:单独提示
const mismatch = computed(() => pw.value.next !== '' && pw.value.confirm !== '' && pw.value.next !== pw.value.confirm)
const savingPw = ref(false)

async function savePassword() {
  const problem = checkPasswordChange(pw.value, user.value?.username ?? '')
  if (problem) return toast.push(problem, 'danger')
  savingPw.value = true
  try {
    await changePassword(pw.value.current, pw.value.next)
    pw.value = { current: '', next: '', confirm: '' }
    toast.push('密码已修改,其它设备上的登录已退出')
    await loadSessions()
  } catch (err) {
    fail(err, '密码没有修改成功。请稍后再试。')
  } finally {
    savingPw.value = false
  }
}

// ---------------------------------------------------------------- 登录设备
const sessions = ref<LoginSession[]>([])
const sessionsLoading = ref(true)
const sessionsError = ref('')

async function loadSessions() {
  try {
    sessions.value = (await listSessions()).sessions
    sessionsError.value = ''
  } catch (err) {
    // 写成「出了什么事 + 怎么办」:服务端的话在前,网络断了(fetch 抛 TypeError)就说连不上
    const reason = accountErrorText(err, '')
    sessionsError.value = !reason ? '登录设备暂时读不出来。请重试。' : reason === OFFLINE_TEXT ? reason : `${reason.replace(/[。.]$/, '')}。请重试。`
  } finally {
    sessionsLoading.value = false
  }
}
onMounted(() => void loadSessions())

async function retrySessions() {
  sessionsLoading.value = true
  sessionsError.value = ''
  await loadSessions()
}

const others = computed(() => sessions.value.filter((item) => !item.current))

async function signOutDevice(item: LoginSession) {
  const ok = await confirm.ask({
    title: `退出「${item.device}」?`,
    message: item.current ? '这是你正在用的设备,退出后需要重新登录。' : '这台设备上的登录会立即失效。',
    confirmText: '退出',
    tone: 'danger',
    action: () => revokeSession(item.id),
  })
  if (!ok) return
  if (item.current) {
    window.location.href = '/login'
    return
  }
  await loadSessions()
}

async function signOutOthers() {
  const ok = await confirm.ask({
    title: `退出其它 ${others.value.length} 台设备?`,
    message: '怀疑账号被别人用过时可以这样做。当前设备不受影响。',
    confirmText: '全部退出',
    tone: 'danger',
    action: () => revokeOtherSessions(),
  })
  if (ok) await loadSessions()
}

// ---------------------------------------------------------------- 导出我的数据
// 服务端在后台打包;这里只负责发起、看进度(进行中每 2 秒问一次)、下载、删除。
// 状态存在服务端,所以刷新页面或换个标签页回来,进度还在
const exp = ref<ExportState | null>(null)
const expError = ref('')
const expBusy = ref(false)
let expTimer: ReturnType<typeof setTimeout> | undefined
const expNow = ref(Date.now())

async function refreshExport() {
  try {
    exp.value = await exportStatus()
    expError.value = ''
  } catch (err) {
    expError.value = accountErrorText(err, '读不到导出的状态。请刷新页面再试。')
  }
  expNow.value = Date.now()
  if (expTimer) clearTimeout(expTimer)
  if (exp.value?.state === 'running') expTimer = setTimeout(() => void refreshExport(), 2000)
}
onMounted(() => void refreshExport())
onBeforeUnmount(() => expTimer && clearTimeout(expTimer))

async function beginExport() {
  if (expBusy.value) return
  expBusy.value = true
  expError.value = ''
  try {
    exp.value = await startExport()
    expTimer = setTimeout(() => void refreshExport(), 1000)
  } catch (err) {
    // 今天次数用完 / 磁盘不足 / 没有知识库:服务端给的就是人话
    expError.value = accountErrorText(err, '导出没有开始。请稍后再试。')
  } finally {
    expBusy.value = false
  }
}

async function dropExport() {
  const ok = await confirm.ask({
    title: '删除这份导出文件?',
    message: '删除后需要重新导出才能再下载。你的知识库不受影响。',
    confirmText: '删除',
    tone: 'danger',
    action: () => discardExport(),
  })
  if (ok) await refreshExport()
}

// ---------------------------------------------------------------- 更换邮箱
// 两步:① 新邮箱 + 当前密码 → 验证码发到新邮箱;② 输入验证码 → 换掉,旧邮箱收到通知
const mailReady = ref(true)
void authStatus()
  .then((value) => (mailReady.value = value.mail_ready))
  .catch(() => undefined)
const emailOpen = ref(false)
const emailStep = ref<'ask' | 'confirm'>('ask')
const emailForm = ref({ email: '', password: '', code: '' })
const emailBusy = ref(false)
const emailError = ref('')
const emailWait = ref(0)
let emailTimer: ReturnType<typeof setInterval> | undefined
onBeforeUnmount(() => emailTimer && clearInterval(emailTimer))

function openEmailChange() {
  emailForm.value = { email: '', password: '', code: '' }
  emailStep.value = 'ask'
  emailError.value = ''
  emailOpen.value = true
}

function startEmailWait(seconds: number) {
  emailWait.value = seconds
  if (emailTimer) clearInterval(emailTimer)
  emailTimer = setInterval(() => {
    emailWait.value -= 1
    if (emailWait.value <= 0 && emailTimer) clearInterval(emailTimer)
  }, 1000)
}

async function sendEmailCode() {
  if (emailBusy.value || emailWait.value > 0) return
  if (!looksLikeEmail(emailForm.value.email)) {
    emailError.value = '请输入正确的邮箱地址'
    return
  }
  if (!emailForm.value.password) {
    emailError.value = '请输入当前密码'
    return
  }
  emailBusy.value = true
  emailError.value = ''
  try {
    const result = await requestEmailChangeCode(emailForm.value.email.trim(), emailForm.value.password)
    startEmailWait(result.wait_secs)
    emailStep.value = 'confirm'
  } catch (err) {
    emailError.value = accountErrorText(err, '验证码没有发出去。请稍后再试。')
  } finally {
    // 密码只用这一次,用完就清掉
    emailForm.value.password = ''
    emailBusy.value = false
  }
}

async function submitEmailChange() {
  if (emailBusy.value || !/^\d{6}$/.test(emailForm.value.code.trim())) return
  emailBusy.value = true
  emailError.value = ''
  try {
    await confirmEmailChange(emailForm.value.email.trim(), emailForm.value.code.trim())
    emailOpen.value = false
    await session.load()
    toast.push('邮箱已更换,旧邮箱会收到一封通知')
  } catch (err) {
    emailError.value = accountErrorText(err, '邮箱没有更换成功。请稍后再试。')
  } finally {
    emailBusy.value = false
  }
}

// ---------------------------------------------------------------- 注销账号
const deleteAfter = computed(() => user.value?.delete_after ?? null)
// 倒计时文字每分钟刷新一次就够了
const tick = ref(Date.now())
const tickTimer = setInterval(() => (tick.value = Date.now()), 60_000)
onBeforeUnmount(() => clearInterval(tickTimer))
const deletionOpen = ref(false)
const deletionPassword = ref('')
const deleting = ref(false)
const deletionError = ref('')

function openDeletion() {
  deletionPassword.value = ''
  deletionError.value = ''
  deletionOpen.value = true
}

async function submitDeletion() {
  if (!deletionPassword.value || deleting.value) return
  deleting.value = true
  deletionError.value = ''
  try {
    await requestAccountDeletion(deletionPassword.value)
    deletionOpen.value = false
    await session.load()
    toast.push('已申请注销,冷静期内可以随时撤销')
  } catch (err) {
    deletionError.value = accountErrorText(err, '注销申请没有提交成功。请稍后再试。')
  } finally {
    // 密码用完就清掉,不在内存里多留
    deletionPassword.value = ''
    deleting.value = false
  }
}

async function undoDeletion() {
  try {
    await cancelAccountDeletion()
    await session.load()
    toast.push('已撤销注销,账号恢复正常')
  } catch (err) {
    fail(err, '没有撤销成功。请刷新页面看看账号状态,再试一次。')
    await session.load()
  }
}
</script>

<template>
  <AppShell roomy>
    <div class="row">
      <div>
        <div class="kb-page-title">个人设置</div>
        <div class="m kb-page-sub">你的资料、密码、两步验证、访问令牌和登录过的设备。</div>
      </div>
    </div>

    <div class="kb-me">
      <!-- ============================ 个人资料 ============================ -->
      <KbCard class="kb-me-card" aria-labelledby="me-profile">
        <header class="kb-me-head"><b id="me-profile">个人资料</b></header>

        <div class="kb-me-avatar">
          <img v-if="previewUrl" class="kb-me-preview" :src="previewUrl" alt="新头像预览" />
          <UserAvatar
            v-else-if="user"
            :user-id="user.id"
            :name="user.display_name || user.username"
            :file="user.avatar"
            :size="88"
            label="当前头像"
          />
          <div class="kb-me-avatar-actions">
            <template v-if="picked">
              <span class="m kb-small">预览:会居中裁成圆形。{{ picked.name }}</span>
              <div class="kb-me-row">
                <KbButton variant="primary" :disabled="uploading" @click="useThisPicture">{{ uploading ? '上传中…' : '使用这张' }}</KbButton>
                <KbButton :disabled="uploading" @click="releasePreview">取消</KbButton>
              </div>
            </template>
            <template v-else>
              <div class="kb-me-row">
                <KbButton @click="fileInput?.click()">更换头像</KbButton>
                <KbButton v-if="user?.avatar" variant="danger" @click="dropAvatar">移除</KbButton>
              </div>
              <span class="m kb-small">支持 PNG、JPEG、WebP、GIF,不超过 8 MB。会裁成正方形,并去掉照片里的位置等信息。</span>
            </template>
          </div>
          <input ref="fileInput" class="kb-me-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="选择头像图片" @change="onPick" />
        </div>

        <div class="kb-me-form">
          <label>
            昵称
            <KbInput v-model="nameDraft" :placeholder="user?.username ?? ''" maxlength="60" />
            <small v-if="nameError" class="kb-me-bad" role="alert">{{ nameError }}</small>
            <small v-else class="m">最多 {{ MAX_DISPLAY_NAME }} 个字,好友和协作者看到的是它。</small>
          </label>
          <div class="kb-me-actions">
            <KbButton variant="primary" :disabled="savingName || !nameDirty || !!nameError" @click="saveName">{{ savingName ? '保存中…' : '保存昵称' }}</KbButton>
          </div>
          <dl class="kb-me-facts">
            <div><dt>用户名</dt><dd>@{{ user?.username }}</dd></div>
            <div>
              <dt>邮箱</dt>
              <dd>
                {{ user?.email ?? '未绑定' }}
                <KbBadge v-if="user?.email && user.email_verified" tone="success">已验证</KbBadge>
                <KbButton size="sm" :disabled="!mailReady" :title="mailReady ? '' : '管理员还没有配置发信邮箱,暂时不能更换'" @click="openEmailChange">更换</KbButton>
              </dd>
            </div>
          </dl>
        </div>
      </KbCard>

      <!-- ============================ 安全 ============================ -->
      <KbCard class="kb-me-card" aria-labelledby="me-security">
        <header id="me-security-top" class="kb-me-head"><b id="me-security">修改密码</b></header>
        <form class="kb-me-form" novalidate @submit.prevent="savePassword">
          <!-- 浏览器的密码管理器靠隐藏的用户名字段把新密码存到正确的账号下 -->
          <input class="kb-me-file" type="text" autocomplete="username" :value="user?.username" tabindex="-1" aria-hidden="true" readonly />
          <label>当前密码<KbInput v-model="pw.current" type="password" autocomplete="current-password" /></label>
          <label>
            新密码
            <KbInput v-model="pw.next" type="password" autocomplete="new-password" placeholder="至少 8 位" />
            <span v-if="pw.next" class="kb-me-strength" :class="{ 'is-weak': strength.score <= 1, 'is-mid': strength.score === 2 }" role="img" :aria-label="`密码强度:${strength.label}`">
              <i v-for="n in 4" :key="n" :class="{ on: n <= strength.score }"></i>
            </span>
            <small v-if="pw.next" :class="strength.ok ? 'm' : 'kb-me-bad'">{{ strength.ok ? `强度:${strength.label}` : strength.message }}</small>
          </label>
          <label>确认新密码<KbInput v-model="pw.confirm" type="password" autocomplete="new-password" /></label>
          <small v-if="mismatch" class="kb-me-bad" role="alert">两次输入的新密码不一致</small>
          <small class="m">修改后,你在其它设备上的登录会全部退出,当前设备保持登录。</small>
          <div class="kb-me-actions">
            <button type="submit" hidden tabindex="-1"></button>
            <KbButton variant="primary" :disabled="savingPw || !!pwProblem" @click="savePassword">{{ savingPw ? '保存中…' : '修改密码' }}</KbButton>
          </div>
        </form>
      </KbCard>

      <!-- ============================ 我的用量 ============================ -->
      <MyUsageCard />

      <!-- ============================ 两步验证 ============================ -->
      <TotpCard :attention="route.query.need === 'totp'" />

      <!-- ============================ 访问令牌 ============================ -->
      <!-- 受「API 令牌与 MCP」功能点控制:没开通的账号整张卡片不出现(后端对创建照样检查) -->
      <TokenCard v-if="canTokens" />

      <!-- ============================ 登录设备 ============================ -->
      <KbCard class="kb-me-card kb-me-wide" aria-labelledby="me-devices">
        <header class="kb-me-head">
          <b id="me-devices">登录设备</b>
          <span class="kb-spacer"></span>
          <KbButton v-if="others.length" size="sm" variant="danger" @click="signOutOthers">退出其它 {{ others.length }} 台</KbButton>
        </header>
        <div v-if="sessionsError" class="kb-me-pad" data-testid="devices-failure">
          <p class="kb-me-bad" role="alert">{{ sessionsError }}</p>
          <KbButton size="sm" @click="retrySessions">重试</KbButton>
        </div>
        <div v-else-if="sessionsLoading" class="kb-me-pad" data-testid="devices-loading"><KbSkeleton variant="list" :lines="2" /></div>
        <ul v-else class="kb-me-devices">
          <li v-for="item in sessions" :key="item.id">
            <div class="kb-me-device">
              <b>{{ item.device }}</b>
              <KbBadge v-if="item.current" tone="accent">当前设备</KbBadge>
              <!-- 每一段不换行,只在「·」处断行:否则日期 10-10 会在连字符处被拆成两行 -->
              <small class="m kb-me-meta">
                <span>最近活跃 {{ timeAgo(item.last_seen) || '刚刚' }}</span>
                <span v-if="item.ip">{{ item.ip }}</span>
                <span>登录于 {{ timeAgo(item.created_at) }}</span>
              </small>
            </div>
            <KbButton size="sm" @click="signOutDevice(item)">退出</KbButton>
          </li>
        </ul>
      </KbCard>

      <!-- ============================ 通知偏好 ============================ -->
      <!-- 通知不依赖任何功能点(分享、@ 提及等都会发通知),所以所有人都有这张卡片 -->
      <NotificationPrefs />

      <!-- ============================ 导出我的数据 ============================ -->
      <KbCard class="kb-me-card kb-me-wide" aria-labelledby="me-export">
        <header class="kb-me-head"><b id="me-export">导出我的数据</b></header>
        <div class="kb-me-form kb-me-flat">
          <p class="m kb-small">
            把你的<b>笔记</b>和上传的<b>原始文件</b>打包成一个压缩文件带走:笔记按分组放在 <code>notes/</code> 下,每条一个 Markdown 文件;原始文件放在 <code>sources/</code> 下。只导出有效的笔记,不包含自动生成的索引;被系统隔离的可疑文件不会导出。
          </p>
          <p v-if="expError" class="kb-me-bad" role="alert">{{ expError }}</p>
          <template v-if="exp?.state === 'running'">
            <div class="kb-me-progress" role="progressbar" :aria-valuenow="exportPercent(exp.bytes_done, exp.bytes_total)" aria-valuemin="0" aria-valuemax="100" aria-label="导出进度">
              <i :style="{ width: `${exportPercent(exp.bytes_done, exp.bytes_total)}%` }" style-allow="进度条宽度由数据决定,只用百分比"></i>
            </div>
            <small class="m">正在打包 {{ exp.notes }} 条笔记、{{ exp.files }} 个文件 · {{ formatBytes(exp.bytes_done) }} / {{ formatBytes(exp.bytes_total) }}({{ exportPercent(exp.bytes_done, exp.bytes_total) }}%)。可以离开这个页面,回来还能看到。</small>
          </template>
          <template v-else-if="exp?.state === 'ready'">
            <div class="kb-me-token-row">
              <p class="kb-small">
                已生成:<b>{{ exp.notes }}</b> 条笔记、<b>{{ exp.files }}</b> 个文件,压缩后 {{ formatBytes(exp.size) }}。文件会保留 <span class="kb-me-nb">{{ expiresIn(exp.expires_at, expNow) }}</span>,之后自动删除。
              </p>
              <span class="kb-me-row">
                <a class="kb-btn is-primary" :href="EXPORT_DOWNLOAD_URL" download>下载</a>
                <KbButton variant="danger" @click="dropExport">删除</KbButton>
              </span>
            </div>
            <details v-if="exp.skipped.length" class="kb-me-skipped">
              <summary>有 {{ exp.skipped.length }} 项没有导出</summary>
              <ul><li v-for="line in exp.skipped" :key="line">{{ line }}</li></ul>
            </details>
            <KbButton :disabled="expBusy" @click="beginExport">重新导出</KbButton>
          </template>
          <template v-else-if="exp?.state === 'failed'">
            <p class="kb-me-bad" role="alert">{{ exp.reason }}</p>
            <div class="kb-me-actions"><KbButton variant="primary" :disabled="expBusy" @click="beginExport">重试</KbButton></div>
          </template>
          <template v-else-if="exp?.state === 'idle'">
            <div class="kb-me-token-row">
              <small class="m">今天还可以导出 {{ exp.today_left }} 次。</small>
              <KbButton variant="primary" :disabled="expBusy || exp.today_left === 0" @click="beginExport">{{ expBusy ? '准备中…' : '开始导出' }}</KbButton>
            </div>
          </template>
          <small v-else-if="!expError" class="m">加载中…</small>
        </div>
      </KbCard>

      <!-- ============================ 注销账号 ============================ -->
      <KbCard class="kb-me-card kb-me-wide kb-me-danger" aria-labelledby="me-delete">
        <header class="kb-me-head"><b id="me-delete">注销账号</b></header>
        <div v-if="deleteAfter !== null" class="kb-me-form kb-me-token-row" role="status">
          <p class="kb-small">
            账号<b>将于 {{ localeDateTime(deleteAfter, { hour12: false }) }} 被永久删除</b>({{ deletionCountdown(deleteAfter, tick) }})。
            <template v-if="canCancelDeletion(deleteAfter, tick)">在此之前你可以随时撤销,账号和数据都会原样保留。</template>
            <template v-else>冷静期已经结束,无法再撤销。</template>
          </p>
          <KbButton v-if="canCancelDeletion(deleteAfter, tick)" variant="primary" @click="undoDeletion">撤销注销</KbButton>
        </div>
        <div v-else class="kb-me-form kb-me-token-row">
          <p class="m kb-small">
            注销后,你的笔记、文件、头像和账号信息都会被<b>永久删除,无法恢复</b>。申请后有一段冷静期,期间账号照常使用,也可以随时撤销。
          </p>
          <KbButton variant="danger" @click="openDeletion">注销账号…</KbButton>
        </div>
      </KbCard>
    </div>

    <KbDialog v-if="emailOpen" title="更换邮箱" :subtitle="emailStep === 'ask' ? '验证码会发到新邮箱' : '验证码已发到你填写的新邮箱'" @close="emailOpen = false">
      <form class="kb-ut-form" novalidate @submit.prevent="emailStep === 'ask' ? sendEmailCode() : submitEmailChange()">
        <template v-if="emailStep === 'ask'">
          <label>新邮箱<KbInput v-model="emailForm.email" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com" /></label>
          <label>当前密码<KbInput v-model="emailForm.password" type="password" autocomplete="current-password" /></label>
          <p class="m kb-small">为了账号安全,换邮箱需要再输一次密码。换好后,旧邮箱会收到一封通知。</p>
        </template>
        <template v-else>
          <!-- 地址放在正文里而不是副标题:长地址折行会压到右上角的关闭按钮上 -->
          <p class="kb-me-addr"><span class="m kb-small">发送到</span> {{ emailForm.email.trim() }}</p>
          <label>
            邮箱验证码
            <KbInput v-model="emailForm.code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位数字" />
          </label>
          <p class="m kb-small">没收到?看看垃圾箱;{{ emailWait > 0 ? `${emailWait} 秒后可以` : '现在可以' }}<a v-if="emailWait <= 0" class="auth-link" href="#" @click.prevent="emailStep = 'ask'">返回重新发送</a><template v-else>重新发送</template>。</p>
        </template>
        <p v-if="emailError" class="kb-me-bad" role="alert">{{ emailError }}</p>
        <div class="kb-ut-actions">
          <KbButton @click="emailOpen = false">取消</KbButton>
          <button type="submit" hidden tabindex="-1"></button>
          <KbButton v-if="emailStep === 'ask'" variant="primary" :disabled="emailBusy || !emailForm.email || !emailForm.password" @click="sendEmailCode">{{ emailBusy ? '发送中…' : '发送验证码' }}</KbButton>
          <KbButton v-else variant="primary" :disabled="emailBusy || !/^\d{6}$/.test(emailForm.code.trim())" @click="submitEmailChange">{{ emailBusy ? '提交中…' : '确认更换' }}</KbButton>
        </div>
      </form>
    </KbDialog>

    <KbDialog v-if="deletionOpen" title="注销账号" subtitle="这会在冷静期结束后永久删除你的数据" @close="deletionOpen = false">
      <form class="kb-ut-form" novalidate @submit.prevent="submitDeletion">
        <ul class="kb-me-consequences">
          <li>你的笔记、上传的文件、知识库索引和头像都会被删除</li>
          <li>删除后无法恢复,也无法找回</li>
          <li>冷静期内账号照常使用,可以随时在这里撤销</li>
        </ul>
        <label>
          输入当前密码确认
          <KbInput v-model="deletionPassword" type="password" autocomplete="current-password" />
        </label>
        <p v-if="deletionError" class="kb-me-bad" role="alert">{{ deletionError }}</p>
        <div class="kb-ut-actions">
          <KbButton @click="deletionOpen = false">取消</KbButton>
          <button type="submit" hidden tabindex="-1"></button>
          <KbButton variant="danger" :disabled="!deletionPassword || deleting" @click="submitDeletion">{{ deleting ? '提交中…' : '申请注销' }}</KbButton>
        </div>
      </form>
    </KbDialog>
  </AppShell>
</template>

<style>
.kb-me{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--gap-lg,16px);align-items:start;margin-top:var(--gap-md,12px);padding-bottom:var(--gap-xl,24px)}
.kb-me-card{padding:0;overflow:hidden}
.kb-me-wide{grid-column:1/-1}
.kb-me-head{display:flex;align-items:center;gap:var(--sp-2);padding:var(--sp-3) var(--card-pad-x,16px);border-bottom:var(--hl) solid var(--b)}
.kb-me-pad{padding:12px var(--card-pad-x,16px)}
.kb-me-avatar{display:flex;align-items:center;gap:var(--gap-lg,16px);padding:var(--card-pad,16px);flex-wrap:wrap}
.kb-me-avatar-actions{display:flex;flex-direction:column;gap:8px;min-width:0;flex:1}
.kb-me-preview{width:88px;height:88px;border-radius:var(--r-pill);object-fit:cover;box-shadow:0 0 0 2px var(--accent)}
.kb-me-row{display:flex;gap:8px;flex-wrap:wrap}
.kb-me-file{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none}
.kb-me-form{display:flex;flex-direction:column;gap:var(--gap-sm,10px);padding:var(--card-pad,16px);border-top:var(--hl) solid var(--b)}
.kb-me-avatar+.kb-me-form{border-top:var(--hl) solid var(--b)}
form.kb-me-form{border-top:0}
.kb-me-form label{display:flex;flex-direction:column;gap:4px;font-size:calc(13px*var(--fs));color:var(--text-secondary);min-width:0}
.kb-me-form small{font-size:calc(12px*var(--fs))}
.kb-me-bad{color:var(--status-danger)}
.kb-me-actions{display:flex;gap:8px}
.kb-me-facts{display:flex;flex-direction:column;gap:8px;margin:4px 0 0;padding-top:12px;border-top:var(--hl) solid var(--b)}
.kb-me-facts>div{display:flex;justify-content:space-between;gap:12px;align-items:center}
.kb-me-facts dt{color:var(--text-secondary)}
.kb-me-facts dd{margin:0;display:flex;align-items:center;gap:8px;min-width:0;overflow-wrap:anywhere;text-align:right}
.kb-me-strength{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}
.kb-me-strength i{height:4px;border-radius:var(--r-xs);background:rgb(var(--ink),.12)}
.kb-me-strength i.on{background:var(--status-success)}
.kb-me-strength.is-weak i.on{background:var(--status-danger)}
.kb-me-strength.is-mid i.on{background:var(--status-warning)}
.kb-me-devices{list-style:none;margin:0;padding:0}
.kb-me-devices li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px var(--card-pad-x,16px);border-top:var(--hl) solid var(--b)}
.kb-me-devices li:first-child{border-top:0}
.kb-me-device{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.kb-me-device small{flex-basis:100%;color:var(--text-tertiary)}
.kb-me-meta{display:flex;flex-wrap:wrap;column-gap:0}
.kb-me-meta span{white-space:nowrap}
.kb-me-meta span+span::before{content:"·";margin:0 .5em}
.kb-me-addr{margin:0;overflow-wrap:anywhere;word-break:break-all}
.kb-me-flat{border-top:0}
.kb-me-nb{white-space:nowrap}
.kb-me-progress{height:8px;border-radius:var(--r-pill);background:rgb(var(--ink),.12);overflow:hidden}
.kb-me-progress i{display:block;height:100%;background:var(--accent);transition:width .4s ease}
.kb-me-skipped{font-size:calc(12px*var(--fs));color:var(--text-secondary)}
.kb-me-skipped ul{margin:6px 0 0;padding-left:1.2em;overflow-wrap:anywhere}
.kb-me-danger{border-color:color-mix(in oklab,var(--status-danger) 45%,transparent)}
.kb-me-consequences{margin:0;padding-left:1.2em;display:flex;flex-direction:column;gap:4px;color:var(--text-secondary)}
.kb-me-token-row{flex-direction:row;align-items:center;justify-content:space-between;gap:var(--gap-lg,16px);border-top:0}
.kb-me-token-row p{margin:0;flex:1}
@media (max-width:1023px){.kb-me{grid-template-columns:minmax(0,1fr)}}
@media (max-width:599px){
  .kb-me-avatar{flex-direction:column;align-items:flex-start}
  .kb-me-devices li{align-items:flex-start}
  .kb-me-token-row{flex-direction:column;align-items:stretch}
}
</style>
