<script setup lang="ts">
import { localeDateTime } from '@/utils/time'
// 用户与权限(管理组):角色与功能勾选、用户列表、单个用户的功能例外。
// 草图见 设计稿。只组合 kb-ui 组件;样式用工具类,手机上角色列表变成横向药丸。
import { computed, onMounted, ref, watch } from 'vue'
import AppShell from '@/layouts/AppShell.vue'
import InviteManager from '@/components/InviteManager.vue'
import { callCapability } from '@/api/client'
import QuotaEditor from '@/components/admin/QuotaEditor.vue'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import AdminSpaceViewer from '@/components/admin/AdminSpaceViewer.vue'
import { failureOf, friendly, type LoadPhase } from '@/utils/loadState'
import UserAvatar from '@/components/UserAvatar.vue'
import { KbBadge, KbButton, KbDialog, KbEmpty, KbIcon, KbInput, KbSwitch, useConfirm, useToast } from '@kb-ui/index'
import { useSessionStore } from '@/stores/session'
import { totpResetSummary } from '@/utils/totp'
import { registeredText } from '@/utils/userText'
import { formatBytes } from '@/utils/accountForms'
import { featureHint, featureLabel as featureShownLabel, visibleFeatures } from '@/utils/featureText'
import {
  featureCatalog,
  groupFeatures,
  roleCreate,
  roleDelete,
  roleList,
  roleUpdate,
  userCreate,
  userFeature,
  userGet,
  userList,
  userSetPassword,
  userTotpReset,
  userUpdate,
  type FeatureDef,
  type RoleRow,
  type UserDetail,
  type UserRow,
} from '@/utils/adminApi'

const toast = useToast()
const confirm = useConfirm()
const session = useSessionStore()

type Tab = 'roles' | 'users' | 'invites'
const tab = ref<Tab>('roles')
// 角色与功能(整页的前提)的读取状态:加载中 / 就绪 / 报错(可重试)/ 没开通。
const phase = ref<LoadPhase>('loading')
const message = ref('')

/** AI 总开关关了:界面上不出现「AI」字样,AI 功能点和 AI 额度先收起 */
const aiOff = computed(() => !session.aiEnabled)

const features = ref<FeatureDef[]>([])
/** 全站默认配额(系统参数 quota.*),给配额覆盖编辑器的空格子做提示;读不到(没有系统参数权限)就不提示 */
const quotaDefaults = ref<Record<string, number>>({})
async function loadQuotaDefaults() {
  try {
    const config = await callCapability<{ quota?: Record<string, number> }>('get_config')
    quotaDefaults.value = config.quota ?? {}
  } catch {
    quotaDefaults.value = {}
  }
}
const savingQuota = ref(false)
const roles = ref<RoleRow[]>([])
const selectedRoleId = ref('')
// AI 总开关关掉后,AI 功能点整组不列出(勾选保留在角色里,重新打开后再出现)
const groups = computed(() => groupFeatures(visibleFeatures(features.value, !aiOff.value)))
const selectedRole = computed(() => roles.value.find((role) => role.id === selectedRoleId.value) ?? null)
const featureLabel = (id: string) => features.value.find((item) => item.id === id)?.label ?? id


async function loadRoles() {
  const [catalog, list] = await Promise.all([featureCatalog(), roleList()])
  features.value = catalog.features
  roles.value = list.roles
  if (!roles.value.some((role) => role.id === selectedRoleId.value)) {
    selectedRoleId.value = roles.value.find((role) => role.id === 'role_user')?.id ?? roles.value[0]?.id ?? ''
  }
}

/** 做一件事:成功提示 done;失败按「发生了什么 + 可以怎么做」写成提示条(不直接露后端的英文异常) */
async function guard(action: () => Promise<unknown>, done?: string, doing = '完成操作') {
  try {
    await action()
    if (done) toast.push(done)
  } catch (err) {
    toast.push(failureOf(err, doing).message, 'danger')
  }
}

// ---------------------------------------------------------------- 角色
function roleHas(role: RoleRow, id: string) {
  return role.all_features || role.features.includes(id)
}

/** 开关一个功能点:乐观更新,失败回滚并提示 */
async function toggleFeature(role: RoleRow, def: FeatureDef, on: boolean) {
  if (role.all_features) return
  if (def.dangerous && on) {
    const ok = await confirm.ask({
      title: `给「${role.name}」开通「${def.label}」?`,
      message: '这是系统级的危险功能,拥有它的人可以改动全站的配置或账号。通常只应授予管理员。',
      confirmText: '开通',
      tone: 'danger',
    })
    if (!ok) return
  }
  const before = [...role.features]
  const next = on ? [...before, def.id] : before.filter((id) => id !== def.id)
  role.features = next
  try {
    const { role: saved } = await roleUpdate({ id: role.id, features: next, ...(def.dangerous && on ? { dangerous: true } : {}) })
    Object.assign(role, { features: saved.features, dangerous: saved.dangerous })
  } catch (err) {
    role.features = before
    toast.push(failureOf(err, '保存功能设置').message, 'danger')
  }
}

const creating = ref(false)
const newRole = ref({ name: '', description: '' })
async function submitNewRole() {
  const name = newRole.value.name.trim()
  if (!name) return
  await guard(async () => {
    const { role } = await roleCreate({ name, description: newRole.value.description.trim(), features: [] })
    await loadRoles()
    selectedRoleId.value = role.id
    creating.value = false
    newRole.value = { name: '', description: '' }
  }, '角色已创建,勾选需要的功能吧')
}

async function copyRole(role: RoleRow) {
  const name = `${role.name} 副本`.slice(0, 30)
  await guard(async () => {
    const { role: copy } = await roleCreate({
      name,
      description: role.description,
      features: role.all_features ? features.value.filter((item) => !item.dangerous).map((item) => item.id) : role.features,
      dangerous: role.dangerous && !role.all_features,
    })
    await loadRoles()
    selectedRoleId.value = copy.id
  }, '已复制为新角色')
}

async function removeRole(role: RoleRow) {
  // 有人在用的角色后端一定会拒绝:按钮已经置灰并写了原因,这里不再让人先确认再失败
  if (role.user_count > 0) return
  const ok = await confirm.ask({
    title: `删除角色「${role.name}」?`,
    message: '删除后不能恢复,这个角色的功能勾选和配额覆盖都会丢失。当前没有用户在用它。',
    confirmText: '删除角色',
    tone: 'danger',
    action: () => friendly(roleDelete(role.id), '删除角色'),
  })
  if (ok) await guard(loadRoles, undefined, '刷新角色列表')
}

// ---------------------------------------------------------------- 用户
const users = ref<UserRow[]>([])
const total = ref(0)
const query = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = 30
// 用户列表自己的读取状态:读不到不能只弹个提示再显示「没有符合条件的用户」(那是把「没读到」说成「没有」)
const usersPhase = ref<LoadPhase>('loading')
const usersMessage = ref('')
let usersLoaded = false
async function loadUsers() {
  // 第一次读显示骨架屏;之后搜索 / 翻页保留旧列表,读到了再换
  if (!usersLoaded) usersPhase.value = 'loading'
  try {
    const result = await userList({
      q: query.value.trim() || undefined,
      status: statusFilter.value || undefined,
      page: page.value,
      page_size: pageSize,
    })
    users.value = result.users
    total.value = result.total
    usersLoaded = true
    usersPhase.value = 'ready'
  } catch (err) {
    const failure = failureOf(err, '读取用户列表')
    usersPhase.value = failure.phase
    usersMessage.value = failure.message
    usersLoaded = false
  }
}
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch([query, statusFilter], () => {
  page.value = 1
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadUsers(), 250)
})
watch(page, () => void loadUsers())
watch(tab, (value) => {
  if (value === 'users') void loadUsers()
})
const filtering = computed(() => query.value.trim() !== '' || statusFilter.value !== '')
function clearFilters() {
  query.value = ''
  statusFilter.value = ''
}

/** 正在看的是不是自己的账号:自己不能停用自己(停用后立刻被踢下线,没人能再登录管理页) */
const isSelf = computed(() => !!detail.value && detail.value.user.id === session.user?.id)
const roleName = (id: string) => roles.value.find((role) => role.id === id)?.name ?? id
const statusText: Record<UserRow['status'], string> = {
  active: '正常',
  pending_email: '待验证邮箱',
  disabled: '已停用',
  deleting: '注销中',
}
const dateText = (ms: number | null) =>
  ms ? localeDateTime(ms, { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '从未登录'

/** 管理员只读查看别人的知识库:功能点 + 部署开关双门控(后端还会再查一次,这里只是不给没开通的人看入口) */
const canInspect = computed(() => session.has('sys.inspect') && session.inspectEnabled)
const inspectTarget = ref<UserRow | null>(null)
function openInspect(row: UserRow) {
  if (!canInspect.value || row.id === session.user?.id) return
  inspectTarget.value = row
}

const detail = ref<UserDetail | null>(null)
const detailOpen = ref(false)
const resetPassword = ref('')
async function openUser(row: UserRow) {
  await guard(async () => {
    detail.value = await userGet(row.id)
    resetPassword.value = ''
    detailOpen.value = true
  })
}
async function changeRole(value: string, select: HTMLSelectElement) {
  const current = detail.value
  if (!current || value === current.user.role_id) return
  const target = roles.value.find((role) => role.id === value)
  // 改成管理员 = 给他全站的权力,且以后新增的功能也自动拥有:必须明确确认,取消时把下拉框拨回原来的角色
  if (target?.all_features) {
    const who = current.user.display_name || current.user.username
    const ok = await confirm.ask({
      title: `把「${who}」设为${target.name}?`,
      message: `${target.name}拥有全部功能,包括管理用户和全站设置,以后新增的功能也会自动拥有。几秒内生效。`,
      confirmText: `设为${target.name}`,
      tone: 'danger',
    })
    if (!ok) {
      select.value = current.user.role_id
      return
    }
  }
  await guard(async () => {
    await userUpdate({ id: current.user.id, role_id: value })
    detail.value = await userGet(current.user.id)
    await Promise.all([loadUsers(), loadRoles()])
  }, '角色已更新,对方几秒内生效', '更新角色')
}
async function toggleDisabled() {
  const current = detail.value
  if (!current) return
  const disable = current.user.status !== 'disabled'
  const ok = await confirm.ask({
    title: disable ? `停用「${current.user.username}」?` : `启用「${current.user.username}」?`,
    message: disable ? '他会立刻退出所有设备,他的访问令牌也失效,连着的外部程序会断开;笔记和文件都保留,随时可以重新启用。' : '启用后他可以重新登录,原来的笔记和文件都在。',
    confirmText: disable ? '停用账号' : '启用账号',
    tone: disable ? 'danger' : 'default',
    action: () => friendly(userUpdate({ id: current.user.id, status: disable ? 'disabled' : 'active' }), disable ? '停用账号' : '启用账号'),
  })
  if (!ok) return
  await guard(async () => {
    detail.value = await userGet(current.user.id)
    await loadUsers()
  })
}
/** 例外三态:跟随角色 / 额外允许 / 禁止 */
function overrideOf(id: string): 'allow' | 'deny' | 'follow' {
  return detail.value?.overrides.find((item) => item.feature === id)?.effect ?? 'follow'
}
async function setOverride(def: FeatureDef, value: 'allow' | 'deny' | 'follow') {
  const current = detail.value
  if (!current) return
  await guard(async () => {
    await userFeature(current.user.id, def.id, value === 'follow' ? null : value)
    // 重新读一遍,而不是信任写接口回的形状:对话框始终显示服务器上的真实状态
    detail.value = await userGet(current.user.id)
  })
}
/** 保存单个用户的配额覆盖(整份替换;编辑器会保留它不认识的键) */
async function saveUserQuota(quota: Record<string, number>) {
  const current = detail.value
  if (!current) return
  savingQuota.value = true
  await guard(async () => {
    await userUpdate({ id: current.user.id, quota })
    detail.value = await userGet(current.user.id)
  }, '配额已保存,几秒内生效')
  savingQuota.value = false
}
async function saveRoleQuota(quota: Record<string, number>) {
  const role = selectedRole.value
  if (!role) return
  savingQuota.value = true
  await guard(async () => {
    const { role: saved } = await roleUpdate({ id: role.id, quota })
    Object.assign(role, { quota_json: saved.quota_json })
  }, '配额已保存,几秒内生效')
  savingQuota.value = false
}

async function submitPassword() {
  const current = detail.value
  if (!current || resetPassword.value.length < 8) {
    toast.push('密码至少 8 位', 'danger')
    return
  }
  // 重设密码会让对方所有设备上的登录失效:先确认,并把后果写在框里
  const who = current.user.display_name || current.user.username
  const password = resetPassword.value
  const ok = await confirm.ask({
    title: `重设「${who}」的密码?`,
    message: '他原来的密码立刻作废,所有设备上的登录都会失效,需要用新密码重新登录。请用安全的方式把新密码告诉他。这个操作会记入审计。',
    confirmText: '重设密码',
    tone: 'danger',
    action: () => friendly(userSetPassword(current.user.id, password), '重设密码'),
  })
  if (!ok) return
  resetPassword.value = ''
  toast.push('密码已重设,他的所有设备已退出登录')
}

/**
 * 重置两步验证:他丢了手机和恢复码、进不了账号时用。后端不管他开没开,都会让他所有设备上的登录失效,
 * 所以确认框里要把这个后果说全;结果提示条按「原来开没开」如实说。
 */
async function resetTotp() {
  const current = detail.value
  if (!current) return
  const who = current.user.display_name || current.user.username
  const outcome = ref<{ was_enabled: boolean; sessions_revoked: number } | null>(null)
  const ok = await confirm.ask({
    title: `重置「${who}」的两步验证?`,
    message: '会关掉他的两步验证,并让他所有设备上的登录立即失效。他下次只用密码登录,之后需要自己重新开启。这个操作会记入审计。',
    confirmText: '重置',
    tone: 'danger',
    action: async () => {
      outcome.value = await userTotpReset(current.user.id)
    },
  })
  if (ok && outcome.value) toast.push(totpResetSummary(outcome.value))
}

const addOpen = ref(false)
const addForm = ref({ username: '', password: '', email: '', role_id: 'role_user' })
async function submitUser() {
  const form = addForm.value
  await guard(async () => {
    await userCreate({
      username: form.username.trim(),
      password: form.password,
      email: form.email.trim() || undefined,
      role_id: form.role_id,
      must_change_password: true,
    })
    addOpen.value = false
    addForm.value = { username: '', password: '', email: '', role_id: 'role_user' }
    await Promise.all([loadUsers(), loadRoles()])
  }, '账号已创建,首次登录需要改密码')
}

async function init() {
  phase.value = 'loading'
  try {
    await loadRoles()
    phase.value = 'ready'
    void loadQuotaDefaults()
  } catch (err) {
    const failure = failureOf(err, '读取角色和功能')
    phase.value = failure.phase
    message.value = failure.message
  }
}
onMounted(() => void init())
</script>

<template>
  <AppShell roomy>
    <div class="row">
      <div>
        <div class="kb-page-title">用户与权限</div>
        <div class="m kb-page-sub">控制每个角色能使用哪些功能。修改后几秒内对在线用户生效。</div>
      </div>
      <span v-if="phase === 'ready'" class="kb-spacer row">
        <KbButton v-if="tab === 'users'" variant="primary" @click="addOpen = true">新建账号</KbButton>
        <KbButton v-else-if="tab === 'roles'" variant="primary" @click="creating = true">新建角色</KbButton>
      </span>
    </div>

    <!-- 角色都读不到(报错 / 没开通)时,页签和新建按钮都没有意义:整页只说原因,报错可重试 -->
    <AdminLoadState v-if="phase !== 'ready'" :phase="phase" :message="message" skeleton="lines" @retry="init()" />

    <div v-if="phase === 'ready'" class="kb-ut-tabs kb-sticky" role="tablist">
      <button type="button" role="tab" :aria-selected="tab === 'roles'" :class="{ on: tab === 'roles' }" @click="tab = 'roles'">角色与功能</button>
      <button type="button" role="tab" :aria-selected="tab === 'users'" :class="{ on: tab === 'users' }" @click="tab = 'users'">用户</button>
      <button type="button" role="tab" :aria-selected="tab === 'invites'" :class="{ on: tab === 'invites' }" @click="tab = 'invites'">邀请码</button>
    </div>

    <!-- ============================ 角色与功能 ============================ -->
    <div v-if="phase === 'ready' && tab === 'roles'" class="kb-ut-split">
      <nav class="kb-ut-roles" aria-label="角色">
        <button
          v-for="role in roles"
          :key="role.id"
          type="button"
          class="kb-ut-role"
          :class="{ on: role.id === selectedRoleId }"
          @click="selectedRoleId = role.id"
        >
          <b>{{ role.name }}</b>
          <small>{{ role.builtin ? '内置' : '自定义' }} · {{ role.user_count }} 人</small>
        </button>
      </nav>

      <section v-if="selectedRole" class="card kb-ut-detail">
        <header class="kb-ut-head">
          <div>
            <b>{{ selectedRole.name }}</b>
            <KbBadge v-if="selectedRole.builtin" tone="neutral">内置</KbBadge>
            <KbBadge v-if="selectedRole.dangerous && !selectedRole.all_features" tone="warning">可授予危险功能</KbBadge>
            <div v-if="selectedRole.description" class="m kb-small">{{ selectedRole.description }}</div>
          </div>
          <span class="kb-spacer row">
            <KbButton size="sm" @click="copyRole(selectedRole)">复制为新角色</KbButton>
            <KbButton v-if="!selectedRole.builtin" size="sm" variant="danger" :disabled="selectedRole.user_count > 0" @click="removeRole(selectedRole)">删除角色</KbButton>
          </span>
        </header>
        <p v-if="!selectedRole.builtin && selectedRole.user_count > 0" class="kb-ut-note" data-testid="role-in-use">还有 {{ selectedRole.user_count }} 个用户在用这个角色。把他们改成别的角色后,才能删除。</p>
        <p v-if="selectedRole.all_features" class="kb-ut-note">管理员角色拥有全部功能(包括以后新增的),不能修改。</p>
        <p v-if="aiOff" class="kb-ut-note is-warn">大模型相关的功能已在系统参数里关闭,这里先收起;重新打开后会出现,原来的勾选都保留。</p>

        <div v-for="entry in groups" :key="entry.group" class="kb-ut-group">
          <h5>{{ entry.group }}</h5>
          <div v-for="def in entry.items" :key="def.id" class="kb-ut-feature">
            <div class="kb-ut-ftext">
              <span>{{ featureShownLabel(def, !aiOff) }}</span>
              <KbBadge v-if="def.dangerous" tone="danger">危险</KbBadge>
              <KbBadge v-if="def.ai" tone="accent">AI</KbBadge>
              <small v-if="def.hint" class="m">{{ featureHint(def, !aiOff) }}</small>
            </div>
            <KbSwitch
              :aria-label="def.label"
              :model-value="roleHas(selectedRole, def.id)"
              :disabled="selectedRole.all_features"
              @update:model-value="(on: boolean) => toggleFeature(selectedRole!, def, on)"
            />
          </div>
        </div>

        <div v-if="!selectedRole.all_features" class="kb-ut-group" data-testid="role-quota">
          <h5>配额覆盖</h5>
          <QuotaEditor :json="selectedRole.quota_json" :defaults="quotaDefaults" scope="这个角色的用户" inherit="全站默认" :busy="savingQuota" :ai-enabled="!aiOff" @save="saveRoleQuota" />
        </div>
      </section>
    </div>

    <!-- ============================ 用户 ============================ -->
    <div v-else-if="phase === 'ready' && tab === 'users'" class="kb-ut-users">
      <div class="kb-ut-filter">
        <KbInput v-model="query" placeholder="搜索用户名、邮箱、昵称" />
        <select v-model="statusFilter" class="kb-ut-select" aria-label="状态">
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="disabled">已停用</option>
          <option value="pending_email">待验证邮箱</option>
        </select>
      </div>
      <AdminLoadState v-if="usersPhase !== 'ready'" :phase="usersPhase" :message="usersMessage" skeleton="lines" @retry="loadUsers()" />
      <KbEmpty v-else-if="!users.length" :title="filtering ? '没有符合条件的用户' : '还没有用户'" :description="filtering ? '换个关键字,或者清掉筛选再看。' : '点右上角的「新建账号」添加第一个用户。'">
        <template v-if="filtering" #action><KbButton variant="primary" @click="clearFilters">清除筛选</KbButton></template>
      </KbEmpty>
      <ul v-else class="card kb-ut-list">
        <li v-for="row in users" :key="row.id" class="kb-ut-item">
          <button type="button" class="kb-ut-row" @click="openUser(row)">
            <UserAvatar :user-id="row.id" :name="row.display_name || row.username" :file="row.avatar" :size="32" />
            <span class="kb-ut-main">
              <b>{{ row.display_name || row.username }}</b>
              <small class="m">@{{ row.username }}{{ row.email ? ` · ${row.email}` : '' }}</small>
            </span>
            <KbBadge tone="neutral">{{ roleName(row.role_id) }}</KbBadge>
            <KbBadge v-if="row.status !== 'active'" :tone="row.status === 'disabled' ? 'danger' : 'warning'">{{ statusText[row.status] }}</KbBadge>
            <span class="m kb-small kb-ut-time">{{ dateText(row.last_login_at) }}</span>
          </button>
          <!-- 看别人的知识库是独立功能点;自己的库直接去工作台,不必从这里看 -->
          <button v-if="canInspect && row.id !== session.user?.id" type="button" class="btn sm kb-ut-inspect" :data-testid="`user-inspect-${row.id}`" @click="openInspect(row)">
            <KbIcon name="doc" :size="12" /> 查看
          </button>
        </li>
      </ul>
      <div v-if="usersPhase === 'ready' && total > pageSize" class="kb-ut-pager">
        <KbButton size="sm" :disabled="page <= 1" @click="page -= 1">上一页</KbButton>
        <span class="m">{{ page }} / {{ Math.ceil(total / pageSize) }}(共 {{ total }} 人)</span>
        <KbButton size="sm" :disabled="page * pageSize >= total" @click="page += 1">下一页</KbButton>
      </div>
    </div>

    <!-- ============================ 邀请码 ============================ -->
    <InviteManager v-else-if="phase === 'ready'" :roles="roles" />

    <!-- 新建角色 -->
    <KbDialog v-if="creating" title="新建角色" subtitle="先起个名字,创建后再勾选功能" @close="creating = false">
      <div class="kb-ut-form">
        <label>角色名<KbInput v-model="newRole.name" placeholder="例如:只读成员" /></label>
        <label>说明(可选)<KbInput v-model="newRole.description" placeholder="这个角色是给谁用的" /></label>
        <div class="kb-ut-actions">
          <KbButton @click="creating = false">取消</KbButton>
          <KbButton variant="primary" :disabled="!newRole.name.trim()" @click="submitNewRole">创建</KbButton>
        </div>
      </div>
    </KbDialog>

    <!-- 新建账号 -->
    <KbDialog v-if="addOpen" title="新建账号" subtitle="对方首次登录时需要改掉这个初始密码" @close="addOpen = false">
      <div class="kb-ut-form">
        <label>用户名<KbInput v-model="addForm.username" placeholder="3–20 位小写字母、数字或下划线" /></label>
        <label>初始密码<KbInput v-model="addForm.password" type="password" placeholder="至少 8 位" /></label>
        <label>邮箱(可选)<KbInput v-model="addForm.email" placeholder="name@example.com" /></label>
        <label>
          角色
          <select v-model="addForm.role_id" class="kb-ut-select">
            <option v-for="role in roles" :key="role.id" :value="role.id">{{ role.name }}</option>
          </select>
        </label>
        <div class="kb-ut-actions">
          <KbButton @click="addOpen = false">取消</KbButton>
          <KbButton variant="primary" :disabled="!addForm.username.trim() || addForm.password.length < 8" @click="submitUser">创建账号</KbButton>
        </div>
      </div>
    </KbDialog>

    <!-- 用户详情 -->
    <KbDialog
      v-if="detailOpen && detail"
      :title="detail.user.display_name || detail.user.username"
      :subtitle="`@${detail.user.username}${detail.user.email ? ` · ${detail.user.email}` : ''}`"
      width="640px"
      no-autofocus
      @close="detailOpen = false"
    >
      <div class="kb-ut-form">
        <label>
          角色
          <select class="kb-ut-select" :value="detail.user.role_id" @change="changeRole(($event.target as HTMLSelectElement).value, $event.target as HTMLSelectElement)">
            <option v-for="role in roles" :key="role.id" :value="role.id">{{ role.name }}</option>
          </select>
        </label>
        <div class="kb-ut-facts m kb-small">
          <span>状态:{{ statusText[detail.user.status] }}</span>
          <span>注册方式:{{ registeredText(detail.user.registered_via) }}</span>
          <span>最近登录:{{ dateText(detail.user.last_login_at) }}</span>
          <span v-if="detail.space">已用存储:{{ formatBytes(detail.space.storage_bytes) }}</span>
        </div>

        <h5 class="kb-ut-sub">单独调整功能(在角色之外)</h5>
        <div v-for="entry in groups" :key="entry.group" class="kb-ut-group is-compact">
          <h5>{{ entry.group }}</h5>
          <div v-for="def in entry.items" :key="def.id" class="kb-ut-feature">
            <div class="kb-ut-ftext">
              <span>{{ featureShownLabel(def, !aiOff) }}</span>
              <KbBadge v-if="def.dangerous" tone="danger">危险</KbBadge>
              <KbBadge v-if="detail.effective_features.includes(def.id)" tone="success">可用</KbBadge>
            </div>
            <select
              class="kb-ut-select is-small"
              :value="overrideOf(def.id)"
              :aria-label="`${featureShownLabel(def, !aiOff)}:例外`"
              @change="setOverride(def, ($event.target as HTMLSelectElement).value as 'allow' | 'deny' | 'follow')"
            >
              <option value="follow">跟随角色</option>
              <option value="allow" :disabled="def.dangerous">额外允许</option>
              <option value="deny">禁止</option>
            </select>
          </div>
        </div>

        <h5 class="kb-ut-sub">单独调整配额(在角色之外)</h5>
        <QuotaEditor :json="detail.user.quota_json ?? ''" :defaults="quotaDefaults" scope="这个用户" inherit="角色或全站默认" :busy="savingQuota" :ai-enabled="!aiOff" @save="saveUserQuota" />

        <h5 class="kb-ut-sub">重设密码</h5>
        <div class="kb-ut-inline">
          <KbInput v-model="resetPassword" type="password" placeholder="新密码,至少 8 位" />
          <KbButton :disabled="resetPassword.length < 8" @click="submitPassword">重设</KbButton>
        </div>

        <h5 class="kb-ut-sub">两步验证</h5>
        <div class="kb-ut-inline kb-ut-totp">
          <p class="m kb-small">他丢了手机和恢复码、进不了账号时,可以替他关掉两步验证。</p>
          <KbButton variant="danger" data-testid="user-totp-reset" @click="resetTotp">重置两步验证</KbButton>
        </div>

        <p v-if="isSelf" class="m kb-small" data-testid="self-note">这是你自己的账号,不能停用。</p>
        <div class="kb-ut-actions">
          <KbButton :variant="detail.user.status === 'disabled' ? 'default' : 'danger'" :disabled="isSelf && detail.user.status !== 'disabled'" @click="toggleDisabled">
            {{ detail.user.status === 'disabled' ? '启用账号' : '停用账号' }}
          </KbButton>
          <KbButton variant="primary" @click="detailOpen = false">完成</KbButton>
        </div>
      </div>
    </KbDialog>

    <AdminSpaceViewer v-if="inspectTarget" :user-id="inspectTarget.id" :name="inspectTarget.display_name || inspectTarget.username" @close="inspectTarget = null" />
  </AppShell>
</template>

<style>
/* 页面级布局:只用 token,手机上角色列表变成横向药丸 */
.kb-ut-tabs{display:flex;gap:var(--gap-xs,4px);border-bottom:var(--hl) solid var(--b);margin:0}
.kb-ut-tabs button{padding:10px 14px;border:0;background:none;color:var(--text-secondary);border-bottom:2px solid transparent;cursor:pointer;font:inherit}
.kb-ut-tabs button.on{color:var(--text-primary);border-bottom-color:var(--accent)}
.kb-ut-split{display:grid;grid-template-columns:240px minmax(0,1fr);gap:var(--gap-lg,16px);align-items:start}
.kb-ut-roles{display:flex;flex-direction:column;gap:2px}
.kb-ut-role{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:10px 12px;border:0;border-radius:var(--r2);background:none;color:var(--text-primary);cursor:pointer;text-align:left;font:inherit}
.kb-ut-role small{color:var(--text-tertiary)}
.kb-ut-role:hover{background:rgb(var(--ink),.05)}
.kb-ut-role.on{background:rgb(var(--ink),.09)}
/* 选中的角色底色加深了,次要文字 --text-tertiary 压上去不到 4.5:1(axe color-contrast),升一档 */
.kb-ut-role.on small{color:var(--text-secondary)}
.kb-ut-detail{padding:0;overflow:hidden}
.kb-ut-head{display:flex;gap:var(--gap-md,12px);align-items:flex-start;justify-content:space-between;padding:var(--card-pad,16px);border-bottom:var(--hl) solid var(--b);flex-wrap:wrap}
.kb-ut-note{margin:0;padding:10px var(--card-pad-x,16px);font-size:calc(13px*var(--fs));color:var(--text-secondary);background:rgb(var(--ink),.03)}
.kb-ut-note.is-warn{color:var(--status-warning-text);background:color-mix(in oklab,var(--status-warning) 12%,transparent)}
.kb-ut-group h5{margin:0;padding:14px var(--card-pad-x,16px) 4px;font-size:calc(12px*var(--fs));font-weight:600;color:var(--text-tertiary);letter-spacing:.03em}
.kb-ut-group.is-compact h5{padding-left:0}
.kb-ut-feature{display:flex;align-items:center;gap:var(--gap-md,12px);justify-content:space-between;padding:9px var(--card-pad-x,16px);min-height:44px}
.kb-ut-group.is-compact .kb-ut-feature{padding-left:0;padding-right:0}
.kb-ut-feature.is-dim{opacity:.5}
.kb-ut-ftext{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.kb-ut-ftext small{flex-basis:100%;color:var(--text-tertiary);font-size:calc(12px*var(--fs))}
.kb-ut-filter{display:flex;gap:var(--gap-sm,8px);margin-bottom:var(--gap-md,12px)}
.kb-ut-filter > :first-child{flex:1;min-width:0}
.kb-ut-select{height:36px;padding:0 10px;border-radius:var(--r2);border:var(--hl) solid var(--b2);background:var(--surface-2);color:var(--text-primary);font:inherit}
.kb-ut-select.is-small{height:32px;font-size:calc(13px*var(--fs))}
.kb-ut-list{list-style:none;margin:0;padding:0;overflow:hidden}
.kb-ut-list li + li{border-top:var(--hl) solid var(--b)}
.kb-ut-item{display:flex;align-items:center;gap:var(--gap-sm,8px);padding-right:var(--card-pad-x,16px)}
.kb-ut-item > .kb-ut-row{padding-right:0}
.kb-ut-inspect{flex:none;white-space:nowrap}
.kb-ut-row{display:flex;align-items:center;gap:var(--gap-md,12px);width:100%;padding:12px var(--card-pad-x,16px);border:0;background:none;color:inherit;cursor:pointer;text-align:left;font:inherit;min-width:0}
.kb-ut-row:hover{background:rgb(var(--ink),.04)}
.kb-ut-main{display:flex;flex-direction:column;min-width:0;flex:1}
.kb-ut-main b,.kb-ut-main small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-ut-time{white-space:nowrap}
.kb-ut-pager{display:flex;align-items:center;justify-content:center;gap:var(--gap-md,12px);margin-top:var(--gap-md,12px)}
.kb-ut-form{display:flex;flex-direction:column;gap:var(--gap-md,12px);max-height:70dvh;overflow-y:auto}
.kb-ut-form label{display:flex;flex-direction:column;gap:6px;font-size:calc(13px*var(--fs));color:var(--text-secondary)}
.kb-ut-facts{display:flex;flex-wrap:wrap;gap:4px 16px}
.kb-ut-sub{margin:var(--gap-md,12px) 0 0;font-size:calc(13px*var(--fs));font-weight:600}
.kb-ut-inline{display:flex;gap:var(--gap-sm,8px)}
.kb-ut-inline > :first-child{flex:1;min-width:0}
.kb-ut-totp{align-items:center;flex-wrap:wrap}
.kb-ut-totp p{margin:0}
.kb-ut-actions{display:flex;gap:var(--gap-sm,8px);justify-content:flex-end;flex-wrap:wrap;padding-top:var(--gap-sm,8px)}
@media (max-width:1023px){
  .kb-ut-split{grid-template-columns:minmax(0,1fr)}
  .kb-ut-roles{flex-direction:row;overflow-x:auto;scrollbar-width:none;gap:var(--gap-sm,8px);padding-bottom:2px}
  .kb-ut-role{flex:none;border:var(--hl) solid var(--b2);border-radius:var(--r-pill);padding:8px 14px;flex-direction:row;align-items:center;gap:8px}
  .kb-ut-role small{display:none}
  .kb-ut-role.on{background:var(--accent);color:var(--on-accent);border-color:transparent}
}
@media (max-width:599px){
  .kb-ut-time{display:none}
  .kb-ut-feature{padding-top:11px;padding-bottom:11px}
  .kb-ut-actions > *{flex:1}
}
@media (pointer:coarse){.kb-ut-select{height:44px}.kb-ut-select.is-small{height:44px}.kb-ut-tabs button,.kb-ut-role{min-height:44px;min-width:44px}.kb-ut-tabs button{padding-block:0}}
</style>
