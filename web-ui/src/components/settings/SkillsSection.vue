<script setup lang="ts">
// 「Skills」分区:声明式清单的登记情况。
//   - 读取有加载(骨架)/ 报错(重试)/ 没开通三种状态;空状态给下一步(往目录里放 manifest.toml 再重新扫描);
//   - 表格用响应式表格(手机变卡片);重新扫描失败的原因常驻;
//   - 说明文字随 AI 总开关变:关闭后不提“提示词(覆盖提炼 / 审核)”这一类。
import { computed, onMounted, ref } from 'vue'
import { KbBadge, KbButton, KbCard, KbEmpty, KbResponsiveTable, useConfirm, useToast, type RtColumn } from '@kb-ui/index'
import SkillEditDialog from '@/components/settings/SkillEditDialog.vue'
import PluginEditDialog from '@/components/settings/PluginEditDialog.vue'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import { callCapability } from '@/api/client'
import { useLoadState } from '@/composables/useLoadState'
import { actionFailure } from '@/utils/actionFailure'
import { SKILL_KIND_HELP, creatableKinds, skillDetail, skillKindText, skillsIntro, type OfficialPluginInfo, type PluginDraft, type SkillDraft, type SkillInfo, type SkillSummary } from '@/utils/settingsExtras'

type Row = SkillInfo & Record<string, unknown>

const props = defineProps<{ aiOn: boolean }>()

const toast = useToast()
const confirm = useConfirm()
const state = useLoadState<SkillSummary>(() => callCapability<SkillSummary>('list_skills'), '读取 Skills 清单')
const official = ref<OfficialPluginInfo[]>([])
const officialLoading = ref(false)
const officialError = ref('')

/** 官方插件列表单独读:它来自宿主二进制,和 skills 目录里的清单是两回事。 */
async function loadOfficial() {
  officialLoading.value = true
  officialError.value = ''
  try {
    official.value = await callCapability<OfficialPluginInfo[]>('list_official_plugins')
  } catch (err) {
    officialError.value = actionFailure('读取官方插件', err)
  } finally {
    officialLoading.value = false
  }
}
onMounted(() => {
  void state.reload()
  void loadOfficial()
})

const summary = computed(() => state.data.value)
/** 进程钩子的真实状态:开关打开不等于真的在沙箱里跑,要把 bwrap 探测结果一起显示。 */
const execState = computed<{ tone: 'success' | 'warning' | 'danger'; label: string; hint: string }>(() => {
  const data = summary.value
  if (!data?.allow_exec) {
    return {
      tone: 'success',
      label: '不允许(默认)',
      hint: '插件的外部进程不会运行(声明式索引照常);旧的 exec 类型只登记。',
    }
  }
  if (data.sandbox_available) {
    return {
      tone: 'success',
      label: '沙箱运行',
      hint: '插件进程在 bwrap 沙箱里:只有插件目录可写,联网按插件权限放行。',
    }
  }
  if (data.allow_unsandboxed) {
    return {
      tone: 'warning',
      label: '未沙箱',
      hint: 'bwrap 不可用,管理员打开了 skills.allow_unsandboxed;插件直接跑在宿主上,只装可信来源。',
    }
  }
  return {
    tone: 'danger',
    label: '没有沙箱',
    hint: 'bwrap 不可用且没有打开 skills.allow_unsandboxed;进程钩子已禁用,声明式索引照常。',
  }
})
const rows = computed(() => (summary.value?.skills ?? []) as Row[])
const scanning = ref(false)
const scanError = ref('')

/** 改完插件 / skill 后两边都要重读:官方插件的安装状态也跟着变。 */
async function refreshAll() {
  await state.reload({ quiet: true })
  await loadOfficial()
}

async function rescan() {
  scanning.value = true
  scanError.value = ''
  try {
    await callCapability('reload_skills', { confirm: true })
    await refreshAll()
    toast.push(`已重新扫描 Skills(${summary.value?.skills.length ?? 0} 个)。`)
  } catch (err) {
    scanError.value = actionFailure('重新扫描', err)
  } finally {
    scanning.value = false
  }
}

/** 每种类型是干什么的(只列这个站点用得到的类型:AI 关了就没有"提示词") */
const kindHelp = computed(() => creatableKinds(props.aiOn).map((kind) => ({ ...kind, ...SKILL_KIND_HELP[kind.value]! })))

const columns: RtColumn[] = [
  { key: 'name', label: '名称', mobile: 'primary' },
  { key: 'kind', label: '类型' },
  { key: 'version', label: '版本' },
  { key: 'state', label: '状态' },
  { key: 'detail', label: '规则 / 阶段' },
  { key: 'actions', label: '操作' },
]

/* ---------------- 新增 / 编辑 / 停用 / 删除 ---------------- */
/** 打开着的编辑框:`new` = 新建;否则是正在编辑的那个 skill / 插件。 */
const skillDialog = ref<'new' | { id: string; draft: SkillDraft } | null>(null)
const pluginDialog = ref<'new' | { id: string; draft: PluginDraft } | null>(null)
const busyId = ref('')
const actionError = ref('')
const officialBusy = ref('')

/** 脚本类没有可编辑内容,不给"编辑"/"停用";插件和声明式 skill 都能改。 */
const editable = (row: Row) => row.kind !== 'exec' && !!row.id
const isPlugin = (row: Row) => row.kind === 'plugin'

async function fetchSkillDraft(row: Row): Promise<SkillDraft | null> {
  try {
    const result = await callCapability<{ draft: SkillDraft }>('get_skill', { id: row.id })
    return result.draft
  } catch (err) {
    actionError.value = actionFailure('读取这个 skill 的内容', err)
    return null
  }
}
async function fetchPluginDraft(row: Row): Promise<PluginDraft | null> {
  try {
    const result = await callCapability<{ draft: PluginDraft }>('get_plugin', { id: row.id })
    return result.draft
  } catch (err) {
    actionError.value = actionFailure('读取这个插件的内容', err)
    return null
  }
}
async function edit(row: Row) {
  actionError.value = ''
  busyId.value = row.id
  if (isPlugin(row)) {
    const draft = await fetchPluginDraft(row)
    busyId.value = ''
    if (draft) pluginDialog.value = { id: row.id, draft }
    return
  }
  const draft = await fetchSkillDraft(row)
  busyId.value = ''
  if (draft) skillDialog.value = { id: row.id, draft }
}
async function toggle(row: Row) {
  actionError.value = ''
  busyId.value = row.id
  try {
    // 只改 enabled:不再把整份内容读出来再写回去,插件里的脚本文件也不会被碰
    await callCapability('set_skill_enabled', { id: row.id, enabled: !row.enabled, confirm: true })
    toast.push(row.enabled ? `已停用 ${row.name}。` : `已启用 ${row.name}。`)
    await refreshAll()
  } catch (err) {
    actionError.value = actionFailure(row.enabled ? '停用' : '启用', err)
  } finally {
    busyId.value = ''
  }
}
async function remove(row: Row) {
  actionError.value = ''
  const ok = await confirm.ask({
    title: `删除 ${row.name}?`,
    message: '这个 skill 会从清单目录里删掉,马上不再生效,不能恢复。已经建好索引的文件不会因此重新处理。',
    confirmText: '删除',
    cancelText: '取消',
    tone: 'danger',
  })
  if (!ok) return
  busyId.value = row.id
  try {
    await callCapability('delete_skill', { id: row.id, confirm: true })
    toast.push(`已删除 ${row.name}。`)
    await refreshAll()
  } catch (err) {
    actionError.value = actionFailure('删除', err)
  } finally {
    busyId.value = ''
  }
}

/* ---------------- 官方插件 ---------------- */
async function installOfficial(item: OfficialPluginInfo) {
  actionError.value = ''
  officialBusy.value = item.id
  try {
    if (item.installed) {
      const ok = await confirm.ask({
        title: `重新安装 ${item.name}?`,
        message: '会用宿主自带的版本覆盖当前目录里的清单和脚本,你对这个官方插件做过的修改会丢失。',
        confirmText: '重新安装',
        cancelText: '取消',
        tone: 'danger',
      })
      if (!ok) return
    }
    await callCapability('install_official_plugin', { id: item.id, overwrite: item.installed, confirm: true })
    toast.push(item.installed ? `${item.name} 已重新安装。` : `${item.name} 已安装。`)
    await refreshAll()
  } catch (err) {
    actionError.value = actionFailure(item.installed ? '重新安装官方插件' : '安装官方插件', err)
  } finally {
    officialBusy.value = ''
  }
}

async function uninstallOfficial(item: OfficialPluginInfo) {
  actionError.value = ''
  const ok = await confirm.ask({
    title: `卸载 ${item.name}?`,
    message: '会从 skills 目录删掉这个官方插件,马上不再生效。已经建好索引的文件不会因此重新处理。',
    confirmText: '卸载',
    cancelText: '取消',
    tone: 'danger',
  })
  if (!ok) return
  officialBusy.value = item.id
  try {
    await callCapability('uninstall_official_plugin', { id: item.id, overwrite: false, confirm: true })
    toast.push(`已卸载 ${item.name}。`)
    await refreshAll()
  } catch (err) {
    actionError.value = actionFailure('卸载官方插件', err)
  } finally {
    officialBusy.value = ''
  }
}

const HOOK_LABEL: Readonly<Record<string, string>> = { extract: '解析', chunk: '切块', enrich: '增强', source: '抓取来源' }
const officialHooks = (item: OfficialPluginInfo) => item.hooks.map((hook) => HOOK_LABEL[hook] ?? hook).join('、') || '仅声明式规则(无进程)'
</script>

<template>
  <AdminLoadState v-if="state.phase.value !== 'ready'" :phase="state.phase.value" :message="state.message.value" skeleton="card" @retry="state.reload()" />

  <template v-else-if="summary">
    <KbCard title="Skills" class="kb-st-card" data-testid="skills-card">
      <p class="kb-st-note">{{ skillsIntro(aiOn) }}</p>
      <ul class="kb-st-list" data-testid="skills-kinds">
        <li v-for="kind in kindHelp" :key="kind.value" class="kb-st-note"><b>{{ kind.label }}</b>:{{ kind.what }}{{ kind.example }}</li>
      </ul>
      <div class="kb-stack">
        <div class="kb-row">
          <span class="kb-hint">清单目录</span>
          <span class="kb-spacer"></span>
          <span class="kb-mono kb-st-wrap-left" data-testid="skills-dir">{{ summary.dir ?? '—' }}</span>
        </div>
        <div class="kb-row">
          <span class="kb-hint">脚本类 skill</span>
          <KbBadge :tone="execState.tone" class="kb-st-nowrap" data-testid="skills-exec">{{ execState.label }}</KbBadge>
          <span class="kb-hint kb-st-key-hint">{{ execState.hint }}想改要编辑 config.toml(<code class="kb-mono kb-st-key">skills.allow_exec</code>),重启后生效。</span>
        </div>
        <div class="kb-st-key-form">
          <KbButton variant="primary" data-testid="skills-add" @click="skillDialog = 'new'">新增 Skill</KbButton>
          <KbButton data-testid="skills-add-plugin" @click="pluginDialog = 'new'">新增插件</KbButton>
          <KbButton :disabled="scanning" data-testid="skills-rescan" @click="rescan">{{ scanning ? '扫描中…' : '重新扫描' }}</KbButton>
          <span class="kb-hint kb-st-key-hint">在这里新增 / 编辑 / 停用 / 删除,保存后马上生效;插件可以换索引策略或接外部进程。也可以直接改清单目录里的文件,再点「重新扫描」。</span>
        </div>
        <p v-if="actionError" class="kb-st-inline-error" role="alert" data-testid="skills-action-error">{{ actionError }}</p>
        <p v-if="scanError" class="kb-st-inline-error" role="alert" data-testid="skills-error">{{ scanError }}</p>
      </div>
    </KbCard>

    <KbCard title="官方插件" class="kb-st-card" data-testid="official-plugins">
      <p class="kb-st-note">随程序自带的 {{ official.length }} 个插件:专有格式切块、构建噪音排除、索引前脱敏。装进清单目录后就能像普通插件一样停用、改参数;脚本类开关关闭时只有声明式索引生效。</p>
      <p v-if="officialError" class="kb-st-inline-error" role="alert" data-testid="official-error">
        {{ officialError }}
        <KbButton size="sm" data-testid="official-retry" @click="loadOfficial">重试</KbButton>
      </p>
      <p v-else-if="officialLoading && !official.length" class="kb-hint" data-testid="official-loading">读取中…</p>
      <ul class="kb-st-list kb-st-official-list">
        <li v-for="item in official" :key="item.id" class="kb-st-official" :data-testid="`official-row-${item.id}`">
          <div class="kb-row kb-st-wrap">
            <b>{{ item.name }}</b>
            <KbBadge :tone="item.installed ? 'success' : 'neutral'" class="kb-st-nowrap" :data-testid="`official-state-${item.id}`">
              {{ item.installed ? `已安装 v${item.installed_version ?? item.version}` : '未安装' }}
            </KbBadge>
            <span class="kb-mono kb-hint">v{{ item.version }}</span>
          </div>
          <p class="kb-hint">{{ item.description }}</p>
          <p class="kb-mono kb-hint kb-st-block">处理:{{ item.include.join('、') }}</p>
          <p v-if="item.exclude?.length" class="kb-mono kb-hint kb-st-block" :data-testid="`official-exclude-${item.id}`">排除:{{ item.exclude.join('、') }}</p>
          <p class="kb-hint">钩子:{{ officialHooks(item) }}<span v-if="item.tags.length"> · 标签:{{ item.tags.join('、') }}</span></p>
          <div class="kb-row">
            <KbButton size="sm" variant="primary" :disabled="officialBusy === item.id" :data-testid="`official-install-${item.id}`" @click="installOfficial(item)">
              {{ item.installed ? (item.installed_version === item.version ? '重新安装' : `更新到 v${item.version}`) : '安装' }}
            </KbButton>
            <KbButton v-if="item.installed" size="sm" variant="danger" :disabled="officialBusy === item.id" :data-testid="`official-uninstall-${item.id}`" @click="uninstallOfficial(item)">卸载</KbButton>
          </div>
        </li>
      </ul>
    </KbCard>

    <KbCard flush title="已登记的 skill" class="kb-st-card" data-testid="skills-list">
      <KbResponsiveTable :columns="columns" :rows="rows" row-key="id">
        <template #empty>
          <KbEmpty size="sm" icon="database" title="还没有 skill" description="Skill 是给系统定的几条小规矩:哪些文件怎么切片并自动打标签、新建笔记必须填什么。点「新增 Skill」,里面有示例可以一键填入;需要换切分方式可以先装上面的官方插件。">
            <template #action><KbButton variant="primary" @click="skillDialog = 'new'">新增 Skill</KbButton></template>
          </KbEmpty>
        </template>
        <template #cell-name="{ row }"><span class="kb-mono kb-st-block">{{ (row as Row).name }}</span></template>
        <template #cell-kind="{ row }"><KbBadge class="kb-st-nowrap">{{ skillKindText((row as Row).kind) }}</KbBadge></template>
        <template #cell-version="{ row }"><span class="kb-mono kb-hint">{{ (row as Row).version || '—' }}</span></template>
        <template #cell-state="{ row }"><KbBadge :tone="(row as Row).enabled ? 'success' : 'neutral'" class="kb-st-nowrap">{{ (row as Row).enabled ? '已启用' : '已停用' }}</KbBadge></template>
        <template #cell-detail="{ row }"><span class="kb-mono kb-hint kb-st-block">{{ skillDetail(row as Row) }}</span></template>
        <template #cell-actions="{ row }">
          <span v-if="editable(row as Row)" class="kb-row kb-st-nowrap">
            <KbButton size="sm" :disabled="busyId === (row as Row).id" :data-testid="`skill-edit-${(row as Row).id}`" @click="edit(row as Row)">编辑</KbButton>
            <KbButton size="sm" :disabled="busyId === (row as Row).id" :data-testid="`skill-toggle-${(row as Row).id}`" @click="toggle(row as Row)">{{ (row as Row).enabled ? '停用' : '启用' }}</KbButton>
            <KbButton size="sm" variant="danger" :disabled="busyId === (row as Row).id" :data-testid="`skill-delete-${(row as Row).id}`" @click="remove(row as Row)">删除</KbButton>
          </span>
          <span v-else-if="(row as Row).id" class="kb-hint">
            <KbButton size="sm" variant="danger" :disabled="busyId === (row as Row).id" :data-testid="`skill-delete-${(row as Row).id}`" @click="remove(row as Row)">删除</KbButton>
          </span>
        </template>
      </KbResponsiveTable>
    </KbCard>

    <KbCard v-if="summary.warnings.length" title="加载告警" class="kb-st-card" data-testid="skills-warnings">
      <p class="kb-st-note">坏清单只记一条告警,不影响其它 skill。</p>
      <ul class="kb-st-list">
        <li v-for="warning in summary.warnings" :key="warning" class="kb-hint kb-st-block">{{ warning }}</li>
      </ul>
    </KbCard>

    <SkillEditDialog
      v-if="skillDialog"
      :ai-on="props.aiOn"
      :editing="skillDialog === 'new' ? null : skillDialog"
      @close="skillDialog = null"
      @saved="refreshAll"
    />
    <PluginEditDialog
      v-if="pluginDialog"
      :editing="pluginDialog === 'new' ? null : pluginDialog"
      :allow-exec="summary.allow_exec"
      @close="pluginDialog = null"
      @saved="refreshAll"
    />
  </template>
</template>

<style>
.kb-st-official-list{display:flex;flex-direction:column;gap:var(--gap-md,12px)}
.kb-st-official{display:flex;flex-direction:column;gap:4px;padding:var(--gap-md,12px);border:var(--hl) solid var(--b2);border-radius:var(--r2);background:var(--surface-2,transparent)}
.kb-st-official p{margin:0}
@media (max-width: 640px){.kb-st-official{padding:var(--gap-sm,8px)}}
</style>
