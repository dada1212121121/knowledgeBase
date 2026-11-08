<script setup lang="ts">
// 「编码代理」(ACP)分区(AI 总开关关闭、或账号没有 ai.acp 时不出现):把外部编码代理当子进程接入。
//   - 「运行与权限」:工具权限、沙箱、默认后端、可见工具组。这些设置**立即生效**(不走页面底部的保存条),
//     改权限 / 沙箱前要确认,文案说清放开以后代理能做什么;
//   - 代理表用响应式表格(手机变卡片),每行的操作按状态给:未安装给「安装」,已安装给「测试」;
//   - 添加自定义代理:表单就近校验(与后端同一口径),保存前确认——这条命令会被守护进程拉起来运行;
//   - 配置对话框(手机上 KbDialog 自己会变成贴底弹层):环境变量,密钥不回显,`••••` 表示保持原值,清空即删除;
//   - 读取有加载 / 报错(重试)/ 没开通三种状态。
import { computed, onMounted, reactive, ref } from 'vue'
import { KbBadge, KbButton, KbCard, KbDialog, KbField, KbInput, KbResponsiveTable, KbSelect, KbSwitch, useConfirm, useToast, type RtColumn } from '@kb-ui/index'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import { callCapability } from '@/api/client'
import { useLoadState } from '@/composables/useLoadState'
import {
  PERMISSIONS,
  acpFailure,
  agentState,
  envEntries,
  envPayload,
  isSecretEnv,
  permissionConfirm,
  sandboxConfirm,
  splitArgs,
  uninstallMessage,
  validateAgentForm,
  type AcpAgentRow,
  type AcpSettings,
  type CustomAgentForm,
  type EnvEntry,
} from '@/utils/settingsAcp'

type Row = AcpAgentRow & Record<string, unknown>

const toast = useToast()
const confirm = useConfirm()
const state = useLoadState<AcpSettings>(() => callCapability<AcpSettings>('acp_agents'), '读取编码代理')
onMounted(() => void state.reload())

const settings = computed(() => state.data.value)
const agents = computed(() => (settings.value?.agents ?? []) as Row[])
const defaultId = computed(() => settings.value?.default ?? '')
const sandbox = computed(() => settings.value?.sandbox !== false)
const permission = computed(() => settings.value?.permission || 'none')
const toolGroups = computed(() => settings.value?.tool_groups ?? [])

/** 操作失败的原因(常驻,不自动消失);下一次操作开始时清掉。 */
const actionError = ref('')
async function act(doing: string, work: () => Promise<void>, advice?: string) {
  actionError.value = ''
  try {
    await work()
  } catch (err) {
    actionError.value = acpFailure(doing, err, advice)
  }
}
const refresh = () => state.reload({ quiet: true })

// ---- 运行与权限(立即生效)
const permissionOptions = PERMISSIONS.map((item) => ({ value: item.value as string, label: item.label }))
async function setPermission(value: string | number) {
  const next = String(value)
  if (next === permission.value) return
  const text = permissionConfirm(next)
  const ok = await confirm.ask({ title: text.title, message: text.message, confirmText: text.confirmText, tone: text.danger ? 'danger' : 'default' })
  if (!ok) return
  await act('更改工具权限', async () => {
    await callCapability('acp_set_permission', { permission: next, confirm: true })
    toast.push('工具权限已更新。')
    await refresh()
  })
}

async function setSandbox(on: boolean) {
  const text = sandboxConfirm(on)
  const ok = await confirm.ask({ title: text.title, message: text.message, confirmText: text.confirmText, tone: text.danger ? 'danger' : 'default' })
  if (!ok) return
  await act('更改沙箱设置', async () => {
    await callCapability('acp_set_sandbox', { sandbox: on, confirm: true })
    toast.push(on ? '已开启沙箱运行。' : '已关闭沙箱运行(不推荐)。', on ? 'success' : 'warning')
    await refresh()
  })
}

/** 默认后端的选项:内置模型 + 已安装的代理;当前默认如果没装好也要留着,免得下拉里找不到它。 */
const backendOptions = computed(() => {
  const list = agents.value.filter((agent) => agent.available || agent.id === defaultId.value).map((agent) => ({ value: agent.id as string, label: agent.name }))
  return [{ value: '', label: '内置模型' }, ...list]
})
async function setDefault(value: string | number) {
  const id = String(value)
  await act('设置默认后端', async () => {
    await callCapability('acp_set_default', { id })
    const label = backendOptions.value.find((item) => item.value === id)?.label ?? '内置模型'
    toast.push(`默认后端:${label}。`)
    await refresh()
  })
}

// ---- 代理表
const columns: RtColumn[] = [
  { key: 'name', label: '代理', mobile: 'primary' },
  { key: 'command', label: '启动命令' },
  { key: 'state', label: '状态' },
]

const testing = ref('')
async function test(row: Row) {
  testing.value = row.id
  await act(
    `测试 ${row.name}`,
    async () => {
      const info = await callCapability<{ name: string; version: string }>('acp_test', { id: row.id })
      toast.push(`连接成功:${info.name || row.name} ${info.version}`.trim())
    },
    '请检查命令是否装好、登录态是否可用',
  )
  testing.value = ''
}

async function install(row: Row) {
  const ok = await confirm.ask({
    title: `安装「${row.name}」?`,
    message: `会用 npm 把 ${row.npm} 装到知识库自己的 acp-tools 目录,不装到系统全局。需要联网,可能要几分钟。`,
    confirmText: '安装',
    doneText: '已安装',
    action: () => callCapability('acp_install', { id: row.id, confirm: true }),
  })
  if (ok) await refresh()
}

async function uninstall(row: Row) {
  const ok = await confirm.ask({
    title: `卸载「${row.name}」?`,
    message: uninstallMessage(row.npm),
    confirmText: '卸载',
    tone: 'danger',
    doneText: '已卸载',
    action: () => callCapability('acp_uninstall', { id: row.id, confirm: true }),
  })
  if (ok) await refresh()
}

async function remove(row: Row) {
  const ok = await confirm.ask({
    title: `删除代理「${row.name}」?`,
    message: '只是从列表里移除这条配置,不会卸载已安装的程序。内置代理会恢复成默认配置。',
    confirmText: '删除',
    tone: 'danger',
    doneText: '已删除',
    action: () => callCapability('acp_remove_agent', { id: row.id, confirm: true }),
  })
  if (ok) await refresh()
}

// ---- 配置对话框(环境变量)
const editing = ref<Row | null>(null)
const entries = ref<EnvEntry[]>([])
const savingEnv = ref(false)
const envFailure = ref('')
function openConfig(row: Row) {
  editing.value = row
  entries.value = envEntries(row)
  envFailure.value = ''
}
async function saveConfig() {
  const row = editing.value
  if (!row) return
  savingEnv.value = true
  envFailure.value = ''
  try {
    await callCapability('acp_save_agent', { id: row.id, name: row.name, command: row.command, args: row.args, env: envPayload(entries.value), confirm: true })
    editing.value = null
    toast.push('代理配置已保存。')
    await refresh()
  } catch (err) {
    envFailure.value = acpFailure('保存配置', err)
  } finally {
    savingEnv.value = false
  }
}

// ---- 添加自定义代理
const form = reactive<CustomAgentForm>({ id: '', name: '', command: '', args: '' })
const submitted = ref(false)
const errors = computed(() => validateAgentForm(form, agents.value.map((agent) => agent.id)))
async function addAgent() {
  submitted.value = true
  if (Object.keys(errors.value).length) return
  const id = form.id.trim()
  const name = form.name.trim() || id
  const ok = await confirm.ask({
    title: `添加代理「${name}」?`,
    message: `守护进程会拉起「${form.command.trim()}」来运行${sandbox.value ? '(在沙箱里)' : '(沙箱已关闭,它会和守护进程同权)'}。只添加你信任的程序。`,
    confirmText: '添加',
    doneText: '已添加',
    action: () => callCapability('acp_save_agent', { id, name, command: form.command.trim(), args: splitArgs(form.args), env: {}, confirm: true }),
  })
  if (!ok) return
  Object.assign(form, { id: '', name: '', command: '', args: '' })
  submitted.value = false
  await refresh()
}
</script>

<template>
  <AdminLoadState v-if="state.phase.value !== 'ready'" :phase="state.phase.value" :message="state.message.value" skeleton="card" @retry="state.reload()" />

  <template v-else>
    <KbCard title="运行与权限" class="kb-st-card" data-testid="acp-settings">
      <p class="kb-st-note">这一页的设置改了立即生效,不需要点「保存」。代理是外部程序,请只接入你信任的。</p>
      <div class="kb-st-rows">
        <div class="kb-st-row" data-field="acp.permission">
          <div class="kb-st-text">
            <span class="kb-st-label">工具权限</span>
            <small class="kb-st-hint">代理请求执行工具时怎么答复。写操作默认拒绝;代理只能操作工作目录内的文件,越界请求自动拒绝。 <code class="kb-mono kb-st-key">acp.toml: permission</code></small>
          </div>
          <div class="kb-st-ctl"><KbSelect :model-value="permission" :options="permissionOptions" aria-label="工具权限" @update:model-value="setPermission" /></div>
        </div>
        <div class="kb-st-row is-switch" data-field="acp.sandbox">
          <div class="kb-st-text">
            <span class="kb-st-label">沙箱运行</span>
            <small class="kb-st-hint">代理放进沙箱(bwrap)里运行,看不到本机的管理接口。沙箱起不来时代理不会悄悄裸奔。 <code class="kb-mono kb-st-key">acp.toml: sandbox</code></small>
            <small v-if="!sandbox" class="kb-st-risk" data-testid="acp-sandbox-risk">沙箱已关闭:代理与守护进程同权,能读到本机文件。只在沙箱确实起不来时使用。</small>
          </div>
          <div class="kb-st-ctl"><KbSwitch :model-value="sandbox" aria-label="沙箱运行" @update:model-value="setSandbox" /></div>
        </div>
        <div class="kb-st-row" data-field="acp.default">
          <div class="kb-st-text">
            <span class="kb-st-label">默认后端</span>
            <small class="kb-st-hint">助手聊天默认用谁回答:内置模型,或下面已安装的某个代理。 <code class="kb-mono kb-st-key">acp.toml: default_agent</code></small>
          </div>
          <div class="kb-st-ctl"><KbSelect :model-value="defaultId" :options="backendOptions" aria-label="默认后端" @update:model-value="setDefault" /></div>
        </div>
        <div class="kb-st-row" data-field="acp.tool_groups">
          <div class="kb-st-text">
            <span class="kb-st-label">代理能用的工具组</span>
            <small class="kb-st-hint">只读;要改请编辑 acp.toml。 <code class="kb-mono kb-st-key">acp.toml: tool_groups</code></small>
          </div>
          <div class="kb-st-ctl"><span class="kb-mono kb-st-value" data-testid="acp-tool-groups">{{ toolGroups.join(' / ') || '全部' }}</span></div>
        </div>
      </div>
      <p v-if="actionError" class="kb-st-inline-error" role="alert" data-testid="acp-error">{{ actionError }}</p>
    </KbCard>

    <KbCard flush title="代理" class="kb-st-card" data-testid="acp-agents">
      <KbResponsiveTable :columns="columns" :rows="agents" empty="还没有可用的代理">
        <template #cell-name="{ row }">
          <span class="kb-mono">{{ (row as Row).name }}</span>
          <KbBadge v-if="!(row as Row).builtin" class="kb-st-nowrap">自定义</KbBadge>
          <KbBadge v-if="(row as Row).id === defaultId" tone="accent" class="kb-st-nowrap" data-testid="acp-default-badge">默认</KbBadge>
        </template>
        <template #cell-command="{ row }">
          <span class="kb-mono kb-hint kb-st-block">{{ (row as Row).command }} {{ (row as Row).args.join(' ') }}</span>
          <span v-if="(row as Row).npm" class="kb-hint kb-st-block">npm 包 {{ (row as Row).npm }}</span>
          <a v-else-if="(row as Row).docs" :href="(row as Row).docs" target="_blank" rel="noreferrer" class="kb-hint kb-st-block">安装说明</a>
        </template>
        <template #cell-state="{ row }">
          <KbBadge :tone="agentState(row as Row, defaultId).tone" class="kb-st-nowrap">{{ agentState(row as Row, defaultId).label }}</KbBadge>
        </template>
        <template #row-actions="{ row }">
          <div class="kb-st-actions" data-testid="acp-actions">
            <KbButton v-if="!(row as Row).available && (row as Row).npm" size="sm" variant="primary" :aria-label="`安装 ${(row as Row).name}`" data-testid="acp-install" @click="install(row as Row)">安装</KbButton>
            <KbButton v-if="(row as Row).available" size="sm" :disabled="testing === (row as Row).id" :aria-label="`测试 ${(row as Row).name}`" data-testid="acp-test" @click="test(row as Row)">{{ testing === (row as Row).id ? '测试中…' : '测试' }}</KbButton>
            <KbButton size="sm" :aria-label="`配置 ${(row as Row).name}`" data-testid="acp-config" @click="openConfig(row as Row)">配置</KbButton>
            <KbButton v-if="(row as Row).available && (row as Row).npm" size="sm" :aria-label="`卸载 ${(row as Row).name}`" data-testid="acp-uninstall" @click="uninstall(row as Row)">卸载</KbButton>
            <KbButton v-if="!(row as Row).builtin" size="sm" variant="danger" :aria-label="`删除 ${(row as Row).name}`" data-testid="acp-remove" @click="remove(row as Row)">删除</KbButton>
          </div>
        </template>
      </KbResponsiveTable>
    </KbCard>

    <KbCard title="添加自定义代理" class="kb-st-card" data-testid="acp-add">
      <p class="kb-st-note">任何实现了 ACP 的可执行文件都能接进来。添加后可以用「测试」验证它能不能正常启动。</p>
      <div class="kb-st-form">
        <KbField v-slot="{ id, describedby, invalid }" label="标识" hint="字母、数字、-、_、. ;添加后不能改" :error="submitted ? errors.id : ''" required>
          <KbInput :id="id" v-model="form.id" :aria-describedby="describedby" :aria-invalid="invalid ? 'true' : undefined" placeholder="my-agent" autocomplete="off" data-testid="acp-form-id" />
        </KbField>
        <KbField v-slot="{ id }" label="显示名" hint="可选;不填就用标识">
          <KbInput :id="id" v-model="form.name" placeholder="我的代理" autocomplete="off" data-testid="acp-form-name" />
        </KbField>
        <KbField v-slot="{ id, describedby, invalid }" label="启动命令" hint="绝对路径,或 PATH 上的命令名,例如 my-agent 或 /opt/my-agent" :error="submitted ? errors.command : ''" required>
          <KbInput :id="id" v-model="form.command" :aria-describedby="describedby" :aria-invalid="invalid ? 'true' : undefined" placeholder="/opt/my-agent" autocomplete="off" data-testid="acp-form-command" />
        </KbField>
        <KbField v-slot="{ id }" label="参数" hint="可选;用空格分隔">
          <KbInput :id="id" v-model="form.args" placeholder="--acp" autocomplete="off" data-testid="acp-form-args" />
        </KbField>
      </div>
      <div class="kb-row">
        <KbButton variant="primary" data-testid="acp-form-submit" @click="addAgent">添加代理</KbButton>
      </div>
    </KbCard>

    <KbDialog v-if="editing" :title="`配置 ${editing.name}`" @close="editing = null">
      <div class="kb-stack" data-testid="acp-config-dialog">
        <p v-if="editing.env_hint" class="kb-hint">
          填接口地址、密钥、模型名,会分别写入 <span class="kb-mono">{{ editing.env_hint.base }}</span> / <span class="kb-mono">{{ editing.env_hint.key }}</span> / <span class="kb-mono">{{ editing.env_hint.model }}</span>。
        </p>
        <p v-else class="kb-hint">这个代理没有固定的地址 / 密钥变量,按它的文档填环境变量(例如密钥、接口地址)。</p>
        <p class="kb-hint">密钥不回显:显示为 •••• 表示保持原值,清空后保存就是删除这个变量。</p>
        <div v-for="(entry, index) in entries" :key="index" class="kb-st-envrow">
          <KbInput v-model="entry.key" class="kb-mono" placeholder="变量名" :aria-label="`第 ${index + 1} 个变量名`" autocomplete="off" />
          <KbInput v-model="entry.value" :type="isSecretEnv(entry.key) ? 'password' : 'text'" placeholder="值" :aria-label="`第 ${index + 1} 个变量的值`" autocomplete="off" />
          <KbButton size="sm" variant="danger" :aria-label="`删除第 ${index + 1} 个变量`" @click="entries.splice(index, 1)">删除</KbButton>
        </div>
        <div class="kb-row">
          <KbButton size="sm" data-testid="acp-env-add" @click="entries.push({ key: '', value: '' })">添加变量</KbButton>
        </div>
        <p v-if="envFailure" class="kb-st-inline-error" role="alert" data-testid="acp-env-failure">{{ envFailure }}</p>
        <div class="kb-row kb-st-dialog-actions">
          <span class="kb-spacer"></span>
          <KbButton @click="editing = null">取消</KbButton>
          <KbButton variant="primary" :disabled="savingEnv" data-testid="acp-env-save" @click="saveConfig">{{ savingEnv ? '保存中…' : '保存' }}</KbButton>
        </div>
      </div>
    </KbDialog>
  </template>
</template>

<style>
.kb-st-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--gap-md,12px);margin-bottom:var(--gap-md,12px)}
@media (max-width:699px){.kb-st-form{grid-template-columns:minmax(0,1fr)}}
.kb-st-envrow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) auto;gap:var(--gap-sm,8px);align-items:center}
@media (max-width:599px){.kb-st-envrow{grid-template-columns:minmax(0,1fr) auto}.kb-st-envrow .kb-input:first-child{grid-column:1 / -1}}
.kb-st-dialog-actions{margin-top:var(--gap-sm,8px)}
</style>
