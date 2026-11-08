<script setup lang="ts">
import { localeDateTime } from '@/utils/time'
// 「备份」分区(需要 sys.ops;没有这个功能点的账号看不到):
//   - 「备份」一张卡:上次 / 下次 / 最近校验 / 归档目录 四五行事实 + 失败告警 + 进度 + 「立即备份」;
//     定时备份与保留策略只在「定时备份与保留」那一处说一遍(以前顶部状态、策略卡、归档表副标题三处各说一遍);
//   - 已有备份用响应式表格(手机变卡片),每份的校验结果留在那一行里;
//   - 策略、异地目录是字段表驱动的配置项(走页面底部的保存条),异地副本的现状放在同一张卡里;
//   - 恢复步骤默认折起(六段命令常驻会占满一屏);
//   - 读取有加载 / 报错(重试)/ 没开通三种状态,策略和异地目录的设置不依赖它,读取失败时照样能改。
import { computed, onMounted, ref, watch } from 'vue'
import { KbBadge, KbButton, KbCard, KbCopyButton, KbProgress, KbResponsiveTable, KbSwitch, type RtColumn } from '@kb-ui/index'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import FieldCards from './FieldCards.vue'
import { useBackup } from '@/composables/useBackup'
import type { Draft } from '@/utils/settingsFields'
import { formatSize } from '@/utils/files'
import { failureKindLabel, failureText, lastCheckText, mirrorText, policySummary, restoreSteps, triggerLabel, usageSummary, type BackupEntry } from '@/utils/backup'

type Row = BackupEntry & Record<string, unknown>

const props = defineProps<{
  aiOn: boolean
  draft: Draft
  errors: Record<string, string>
  /** 策略或异地目录有没有改了没保存(清理按的是已保存的策略)。 */
  policyUnsaved: boolean
  /** 每次保存设置成功就 +1:重新读一遍,「当前生效」才会跟上。 */
  savedTick: number
}>()
const emit = defineEmits<{ update: [path: string, value: string | boolean] }>()

const backup = useBackup()
onMounted(() => void backup.reload())
watch(
  () => props.savedTick,
  () => void backup.refresh(),
)

const ready = computed(() => backup.phase.value === 'ready')
const status = backup.status
const includeSources = ref(false)
const when = (at: number) => localeDateTime(at, { hour12: false })

const usage = computed(() => usageSummary(status.value?.usage, includeSources.value, formatSize))
const summary = computed(() => policySummary(status.value?.policy, status.value?.next_backup_at ?? null))
const nextText = computed(() => {
  const policy = status.value?.policy
  if (!policy?.enabled) return '定时备份已关闭'
  return status.value?.next_backup_at ? when(status.value.next_backup_at) : '还没排上'
})
const rows = computed(() => (status.value?.entries ?? []) as Row[])
const steps = computed(() => restoreSteps(status.value?.home, status.value?.dir, status.value?.entries?.[0]?.name))

const columns: RtColumn[] = [
  { key: 'name', label: '归档', mobile: 'primary' },
  { key: 'size', label: '大小' },
  { key: 'created', label: '时间' },
]
</script>

<template>
  <AdminLoadState v-if="!ready" :phase="backup.phase.value === 'ready' ? 'loading' : backup.phase.value" :message="backup.message.value" skeleton="card" @retry="backup.reload()" />

  <template v-if="ready && status">
    <KbCard title="备份" class="kb-st-card" data-testid="backup-card">
      <p class="kb-st-note">把无法重建的部分(元数据库、配置、skills、评测数据)打成一个 tar.gz 放在归档目录,可以再复制一份到异地目录。</p>
      <dl class="kb-st-facts">
        <div class="kb-st-fact"><dt class="kb-hint">上次备份</dt><dd data-testid="backup-last">{{ status.last_backup_at ? when(status.last_backup_at) : '还没有备份' }}</dd></div>
        <div class="kb-st-fact"><dt class="kb-hint">下次定时备份</dt><dd data-testid="backup-next">{{ nextText }}</dd></div>
        <div v-if="status.last_auto" class="kb-st-fact">
          <dt class="kb-hint">上次定时备份</dt>
          <dd data-testid="backup-last-auto">
            <KbBadge :tone="status.last_auto.ok ? 'success' : 'danger'" class="kb-st-nowrap">{{ status.last_auto.ok ? '成功' : '失败' }}</KbBadge>
            {{ when(status.last_auto.at) }}<template v-if="!status.last_auto.ok"> · {{ status.last_auto.error ?? '原因不明' }}</template>
          </dd>
        </div>
        <div v-if="status.last_check" class="kb-st-fact">
          <dt class="kb-hint">最近校验</dt>
          <dd data-testid="backup-last-check">
            <KbBadge :tone="status.last_check.ok ? 'success' : 'danger'" class="kb-st-nowrap">{{ status.last_check.ok ? '通过' : '没通过' }}</KbBadge>
            {{ lastCheckText(status.last_check, formatSize) }}
          </dd>
        </div>
        <div class="kb-st-fact"><dt class="kb-hint">归档目录</dt><dd class="kb-mono kb-st-block" data-testid="backup-dir">{{ status.dir }}</dd></div>
      </dl>

      <div v-if="status.alert" class="kb-st-inline-error" role="alert" data-testid="backup-alert">
        <KbBadge tone="danger" class="kb-st-nowrap">{{ failureKindLabel(status.alert.kind) }}失败</KbBadge>
        <span>{{ failureText(status.alert) }}</span>
      </div>
      <details v-if="status.failures.length > 1" class="kb-st-details" data-testid="backup-failures">
        <summary>最近 {{ Math.min(status.failures.length, 5) }} 次失败记录</summary>
        <ul class="kb-st-list">
          <li v-for="failure in status.failures.slice(0, 5)" :key="failure.at" class="kb-st-mirror">
            <KbBadge class="kb-st-nowrap">{{ triggerLabel(failure.trigger) }}</KbBadge>
            <KbBadge v-if="(failure.kind ?? 'pack') !== 'pack'" tone="danger" class="kb-st-nowrap">{{ failureKindLabel(failure.kind) }}</KbBadge>
            <span class="kb-hint kb-st-block">{{ when(failure.at) }} · {{ failure.error }}</span>
          </li>
        </ul>
      </details>

      <div v-if="backup.running.value" class="kb-stack" data-testid="backup-progress">
        <KbProgress :value="backup.percent.value" label="备份进度" />
        <div class="kb-row">
          <span class="kb-hint">{{ backup.progressLabel.value }}</span>
          <span v-if="backup.running.value.current" class="kb-mono kb-hint kb-st-block">{{ backup.running.value.current }}</span>
        </div>
      </div>

      <div class="kb-st-key-form">
        <KbButton variant="primary" :disabled="backup.backingUp.value" data-testid="backup-create" @click="backup.create(includeSources)">{{ backup.backingUp.value ? '正在打包…' : '立即备份' }}</KbButton>
        <!-- 开关和说明包成一对:手机上「立即备份」后面放不下时它们一起换到下一行,不会开关留在按钮旁、说明掉到下面 -->
        <span class="kb-st-switch-pair">
          <KbSwitch v-model="includeSources" aria-label="同时备份原件" data-testid="backup-include-sources" />
          <span class="kb-hint kb-st-key-hint">同时备份原件(sources):体积大,通常另有副本</span>
        </span>
      </div>
      <p class="kb-hint" data-testid="backup-usage">
        这次会打包约 {{ usage.total }}:{{ usage.included }}。不备份:{{ usage.excluded }}。
      </p>
      <p v-if="backup.actionError.value" class="kb-st-inline-error" role="alert" data-testid="backup-error">{{ backup.actionError.value }}</p>
    </KbCard>

    <KbCard flush title="已有备份" class="kb-st-card" data-testid="backup-entries">
      <KbResponsiveTable :columns="columns" :rows="rows" row-key="name" empty="还没有备份。点上面的「立即备份」做第一份。">
        <template #cell-name="{ row }">
          <span class="kb-mono kb-st-block">{{ (row as Row).name }}</span>
          <span v-if="backup.checks.value[(row as Row).name]" class="kb-st-block" :class="backup.checks.value[(row as Row).name]!.ok ? 'kb-st-ok' : 'kb-st-bad'" :role="backup.checks.value[(row as Row).name]!.ok ? 'status' : 'alert'" data-testid="backup-check">
            {{ backup.checks.value[(row as Row).name]!.text }}
          </span>
        </template>
        <template #cell-size="{ row }"><span class="kb-hint">{{ formatSize((row as Row).size_bytes) }}</span></template>
        <template #cell-created="{ row }"><span class="kb-hint">{{ when((row as Row).created_at) }}</span></template>
        <template #row-actions="{ row }">
          <div class="kb-st-actions">
            <KbButton size="sm" :disabled="backup.verifying.value === (row as Row).name" :aria-label="`校验 ${(row as Row).name}`" data-testid="backup-verify" @click="backup.verify(row as Row)">{{ backup.verifying.value === (row as Row).name ? '校验中…' : '校验' }}</KbButton>
            <KbButton size="sm" variant="danger" :aria-label="`删除 ${(row as Row).name}`" data-testid="backup-delete" @click="backup.remove(row as Row)">删除</KbButton>
          </div>
        </template>
      </KbResponsiveTable>
    </KbCard>
  </template>

  <FieldCards section="backup" v-bind="{ aiOn, draft, errors }" @update="(path, value) => emit('update', path, value)">
    <template #in-backup>
      <template v-if="ready && status">
        <div class="kb-st-key-form">
          <span class="kb-hint kb-st-key-hint kb-st-grow" data-testid="backup-policy-summary">当前生效:{{ summary }}</span>
          <KbButton size="sm" data-testid="backup-prune" @click="backup.prune()">按策略清理</KbButton>
        </div>
        <p class="kb-hint">保留策略在下一次自动备份成功之后生效;要立刻清理,点右边的按钮。</p>
        <p v-if="policyUnsaved" class="kb-st-risk" data-testid="backup-policy-unsaved">上面的策略还没保存:这里显示的、「按策略清理」用的都是已保存的策略。</p>
      </template>
    </template>
    <template #in-mirror>
      <template v-if="ready && status">
        <ul v-if="status.mirrors.length" class="kb-st-list" data-testid="backup-mirrors">
          <li v-for="mirror in status.mirrors" :key="mirror.dir" class="kb-st-mirror-item">
            <div class="kb-st-mirror">
              <KbBadge :tone="mirror.has_latest ? 'success' : 'danger'" class="kb-st-nowrap">{{ mirror.has_latest ? '已同步' : '未同步' }}</KbBadge>
              <span class="kb-mono kb-st-block">{{ mirror.dir }}</span>
            </div>
            <span class="kb-hint kb-st-block">{{ mirrorText(mirror) }}</span>
            <span v-if="mirror.last_error" class="kb-st-bad kb-st-block" role="alert">上次失败:{{ mirror.last_error }}</span>
          </li>
        </ul>
        <p v-else class="kb-st-risk" data-testid="backup-no-mirror">还没有配置异地目录:归档只存在本机的 backups/ 下,这块盘坏了就一起没了。</p>
        <p class="kb-hint">复制失败不会让这次备份失败(本机已经有一份),但会记进备份告警。每份副本落盘后会回读比对 sha256,对不上的副本会被删掉并记告警,不会留在异地目录里冒充“已同步”。目录可以事先不存在,会自动创建。</p>
      </template>
    </template>
  </FieldCards>

  <KbCard v-if="ready && status" title="恢复步骤" class="kb-st-card" data-testid="backup-restore">
    <details class="kb-st-details">
      <summary>展开恢复步骤(停服 → 校验 → 解包 → 启动,命令可以直接复制)</summary>
      <ol class="kb-st-steps">
        <li v-for="(step, index) in steps" :key="step.title" class="kb-st-step">
          <div class="kb-row">
            <KbBadge class="kb-st-nowrap">{{ index + 1 }}</KbBadge>
            <b>{{ step.title }}</b>
            <span class="kb-spacer"></span>
            <KbCopyButton :text="step.command" label="复制" />
          </div>
          <p class="kb-hint kb-st-step-detail">{{ step.detail }}</p>
          <pre class="kb-mono kb-st-code">{{ step.command }}</pre>
        </li>
      </ol>
      <p v-for="note in status.notes" :key="note" class="kb-hint">{{ note }}</p>
      <p class="kb-hint">完整说明(回滚、常见问题、恢复后要做什么)见 <span class="kb-mono">docs/BACKUP_RESTORE.md</span>。</p>
    </details>
  </KbCard>
</template>

<style>
.kb-st-switch-pair{display:inline-flex;align-items:center;gap:var(--gap-sm,8px);min-width:0;flex:1 1 14em}
.kb-st-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--gap-sm,8px) var(--gap-md,12px);margin:0 0 var(--gap-md,12px)}
.kb-st-fact{display:flex;flex-direction:column;gap:2px;min-width:0}
.kb-st-fact dd{margin:0;min-width:0;overflow-wrap:anywhere;font-size:calc(13px*var(--fs))}
@media (max-width:599px){.kb-st-facts{grid-template-columns:minmax(0,1fr)}}
.kb-st-grow{flex:1 1 220px}
.kb-st-mirror-item{display:flex;flex-direction:column;gap:2px;min-width:0}
.kb-st-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--gap-md,12px)}
.kb-st-step{display:flex;flex-direction:column;gap:4px;min-width:0}
.kb-st-step-detail{margin:0}
</style>
