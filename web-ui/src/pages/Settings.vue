<script setup lang="ts">
// 系统设置(管理组,功能点 sys.settings):左栏分区导航 + 右栏卡片。
//   - 配置项由 utils/settingsFields.ts 的字段表驱动(中文标签 + 帮助文字 + 取值范围 + 需要重启标记),
//     保存只提交改过的键;草稿、校验、补丁都是纯函数,单测在 settingsFields.spec.ts;
//   - 分区清单与 AI 总开关 / 功能点的隐藏规则在 utils/settingsNav.ts;
//   - 四种状态:加载(骨架屏)、报错(可重试)、无权限(未开通)、空(各分区自己给下一步)。
import { PATHS } from '@/router/paths'
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import FieldCards from '@/components/settings/FieldCards.vue'
import AcpSection from '@/components/settings/AcpSection.vue'
import BackupSection from '@/components/settings/BackupSection.vue'
import McpSection from '@/components/settings/McpSection.vue'
import ModelSection from '@/components/settings/ModelSection.vue'
import ComponentsSection from '@/components/settings/ComponentsSection.vue'
import OcrSection from '@/components/settings/OcrSection.vue'
import SettingsSaveBar from '@/components/settings/SettingsSaveBar.vue'
import SkillsSection from '@/components/settings/SkillsSection.vue'
import TuningCard from '@/components/settings/TuningCard.vue'
import {
  useConfirm,
  KbCard,
  KbSettingsLayout,
  useToast,
  useUnsavedGuard,
} from '@kb-ui/index'
import { callCapability } from '@/api/client'
import { useShellStore } from '@/stores/shell'
import { useSessionStore } from '@/stores/session'
import { useLoadState } from '@/composables/useLoadState'
import { resolveTab, sectionLabel, visibleSections, type SectionId } from '@/utils/settingsNav'
import {
  buildSettingsPatch,
  groupsOf,
  restartFields,
  saveFailureText,
  saveSummary,
  toDraft,
  type Draft,
} from '@/utils/settingsFields'

type Config = Record<string, Record<string, unknown>>

const route = useRoute()
const router = useRouter()
const toast = useToast()
const shell = useShellStore()
const session = useSessionStore()

// ---------------------------------------------------------------- 分区导航
/** AI 总开关:会话没加载完时按「关」算,免得闪一下「AI」字样(术语表:关掉后任何位置都不出现)。 */
const aiOn = computed(() => session.loaded && session.aiEnabled)
const visible = computed(() => visibleSections({ aiOn: aiOn.value, has: (feature) => session.has(feature) }))
const navLabels = computed(() => visible.value.map((section) => section.label))
const active = ref<SectionId>('general')
const activeLabel = computed(() => sectionLabel(active.value))

/** 把地址里的 ?tab= 对应到分区:旧页签落到合并后的位置,搬走的页签去它们现在的页面。 */
function applyTab() {
  const resolved = resolveTab(route.query.tab, visible.value)
  if (resolved.redirect === 'appearance') return void router.replace(PATHS.appearance)
  if (resolved.redirect === 'tokens') return void router.replace(PATHS.me)
  active.value = resolved.id
  // 会话还没加载完时分区清单不全(AI 分区暂时不在),这时不改地址,免得把深链接丢了
  if (resolved.corrected && session.loaded) void router.replace({ query: { ...route.query, tab: resolved.id } })
}
watch([() => route.query.tab, visible], applyTab, { immediate: true })

function onSelect(label: string) {
  const section = visible.value.find((item) => item.label === label)
  if (!section) return
  active.value = section.id
  void router.replace({ query: { ...route.query, tab: section.id } })
}

// ---------------------------------------------------------------- 配置:读取 / 草稿 / 保存
const {
  phase,
  data: config,
  message,
  reload,
} = useLoadState<Config>(() => callCapability<Config>('get_config'), '读取系统设置', (text) => toast.push(text, 'warning'))
const ready = computed(() => phase.value === 'ready' && session.loaded && !!config.value)

const draft = ref<Draft>({})
// 读到(或重新读到)配置就把草稿重置成它:保存成功后的重新读取也走这里
watch(config, (value) => (draft.value = value ? toDraft(value) : {}), { immediate: true })

const pending = computed(() => (config.value ? buildSettingsPatch(config.value, draft.value) : { patch: {}, changed: [], errors: {} }))
const firstError = computed(() => Object.values(pending.value.errors)[0] ?? '')
/** 有多少项改了没保存(含填错了的)。 */
const dirtyCount = computed(() => new Set([...pending.value.changed, ...Object.keys(pending.value.errors)]).size)
const dirty = computed(() => dirtyCount.value > 0)

const saving = ref(false)
/** 每次保存成功 +1:备份分区据此重新读「当前生效」。 */
const savedTick = ref(0)
/** 上一次保存失败的原因(常驻在保存条上,不自动消失)。 */
const saveFailure = ref('')

function setDraft(path: string, value: string | boolean) {
  draft.value[path] = value
  saveFailure.value = ''
}
function revert() {
  draft.value = config.value ? toDraft(config.value) : {}
  saveFailure.value = ''
}

interface UpdateReply {
  applied: boolean
  restart_required: boolean
  changed: string[]
  migration_plan: Record<string, unknown> | null
  notes: string[]
}

async function save() {
  const { patch, changed, errors } = pending.value
  if (!changed.length || Object.keys(errors).length) return
  saving.value = true
  saveFailure.value = ''
  try {
    const reply = await callCapability<UpdateReply>('update_config', { patch, confirm: true })
    if (reply.migration_plan) {
      toast.push('嵌入相关的改动不会直接写入:要先迁移已有集合,再改配置。', 'warning')
    } else if (!reply.applied) {
      toast.push(reply.notes.join(';') || '没有写入任何改动', 'warning')
    } else {
      const summary = saveSummary(changed, restartFields(changed).map((field) => field.label))
      toast.push(summary.text, summary.tone)
      await reload({ quiet: true })
      savedTick.value += 1
      // 改了 AI 之类会影响导航的设置:让会话马上刷新,不等 20 秒
      void session.load()
    }
  } catch (err) {
    saveFailure.value = saveFailureText(err)
    toast.push(saveFailure.value, 'danger')
  } finally {
    saving.value = false
  }
}

useUnsavedGuard(dirty, () =>
  useConfirm().ask({ title: '有修改还没保存', message: '现在离开,这些修改会丢失。', confirmText: '离开', cancelText: '继续编辑', tone: 'danger' }),
)

/** 传给 FieldCards 的公共参数。 */
const fieldProps = computed(() => ({ aiOn: aiOn.value, draft: draft.value, errors: pending.value.errors }))
/** 当前分区里有没有配置项(决定要不要显示「保存后立即生效…」那句话)。 */
const hasFields = computed(() => groupsOf(active.value, aiOn.value).length > 0)

// 数据目录(取自 system_status,需要 sys.ops;没有这个功能或读不到就不显示这一行,不编数)
const dataHome = ref('')
async function loadDataHome() {
  if (!session.has('sys.ops')) return
  try {
    const status = await callCapability<{ overview?: { service?: { home?: string } } }>('system_status')
    dataHome.value = status.overview?.service?.home ?? ''
  } catch {
    // 数据目录只是“版本与位置”卡里的一行信息,读不到不影响设置本身
  }
}
const mcpTransports = computed(() => (config.value?.mcp?.transports as string[] | undefined) ?? [])

onMounted(async () => {
  void reload()
  await loadDataHome()
})
</script>

<template>
  <AppShell :bare="true">
    <template #breadcrumb>
      <span>系统设置</span>/<b>{{ activeLabel }}</b>
    </template>

    <!-- 无权限:整页只说这一件事,不画导航 -->
    <div v-if="phase === 'forbidden'" class="kb-st-solo">
      <AdminLoadState phase="forbidden" :message="message" />
    </div>

    <KbSettingsLayout v-else class="kb-st-layout" :items="navLabels" :active="activeLabel" @select="onSelect">
      <AdminLoadState v-if="!ready" :phase="phase === 'error' ? 'error' : 'loading'" :message="message" skeleton="lines" @retry="reload()" />

      <div v-else class="kb-st" data-testid="settings-body">
        <p v-if="hasFields" class="kb-st-lead">保存后立即生效;带「需要重启」标记的项,要重启服务后才生效。</p>

        <!-- ================= 常规 ================= -->
        <template v-if="active === 'general'">
          <FieldCards section="general" v-bind="fieldProps" @update="setDraft" />
          <KbCard title="版本与位置" class="kb-st-card" data-testid="about-card">
            <div class="kb-stack">
              <div class="kb-row"><span class="kb-hint">版本</span><span class="kb-spacer"></span><span class="kb-mono">{{ shell.version ? `v${shell.version}` : '—' }}</span></div>
              <div v-if="dataHome" class="kb-row"><span class="kb-hint">数据目录</span><span class="kb-spacer"></span><span class="kb-mono kb-st-wrap">{{ dataHome }}</span></div>
              <div class="kb-row">
                <span class="kb-hint">主题、密度、字号等外观,每个人各自一份</span>
                <span class="kb-spacer"></span>
                <RouterLink class="btn sm" :to="PATHS.appearance">打开外观设置</RouterLink>
              </div>
              <div class="kb-row">
                <span class="kb-hint">守护进程的运行状况与本机环境检测,出问题时先看这里</span>
                <span class="kb-spacer"></span>
                <RouterLink class="btn sm" :to="PATHS.system">打开系统状态</RouterLink>
              </div>
            </div>
          </KbCard>
        </template>

        <!-- ================= 存储与索引(含调度与维护) ================= -->
        <template v-else-if="active === 'storage'">
          <FieldCards section="storage" v-bind="fieldProps" @update="setDraft" />
        </template>

        <!-- ================= 搜索与排序 ================= -->
        <template v-else-if="active === 'search'">
          <FieldCards section="search" v-bind="fieldProps" @update="setDraft" />
          <TuningCard />
        </template>

        <!-- ================= 模型 ================= -->
        <template v-else-if="active === 'model'">
          <ModelSection :draft="draft" :errors="pending.errors" :unsaved="pending.changed.some((path) => path.startsWith('llm.'))" @update="setDraft" />
        </template>

        <!-- ================= 组件 ================= -->
        <template v-else-if="active === 'components'">
          <ComponentsSection v-bind="fieldProps" @update="setDraft" />
        </template>

        <!-- ================= OCR 与转写 ================= -->
        <template v-else-if="active === 'ocr'">
          <OcrSection v-bind="fieldProps" @update="setDraft" />
        </template>

        <!-- ================= Skills ================= -->
        <template v-else-if="active === 'skills'">
          <SkillsSection :ai-on="aiOn" />
        </template>

        <!-- ================= MCP 接入 ================= -->
        <template v-else-if="active === 'mcp'">
          <McpSection :transports="mcpTransports" :allow-remote="config?.server?.allow_remote === true" />
        </template>

        <!-- ================= 编码代理 ================= -->
        <template v-else-if="active === 'acp'">
          <AcpSection />
        </template>

        <!-- ================= 备份 ================= -->
        <template v-else-if="active === 'backup'">
          <BackupSection v-bind="fieldProps" :policy-unsaved="pending.changed.some((path) => path.startsWith('backup.'))" :saved-tick="savedTick" @update="setDraft" />
        </template>
      </div>

      <SettingsSaveBar v-if="ready" :count="dirtyCount" :error="firstError" :failure="saveFailure" :saving="saving" @save="save" @revert="revert" />
    </KbSettingsLayout>
  </AppShell>
</template>

<style>
/* 页面层只排版:分区里的卡片竖着排,每张卡不被压缩(WebKit 下 overflow:hidden 的卡放在可滚动的纵向 flex 里会塌成 1px) */
.kb-st{display:flex;flex-direction:column;gap:calc(14px*var(--fs));min-width:0}
.kb-st > *{flex:0 0 auto}
.kb-st-solo{padding:var(--page-pad)}
.kb-st-lead{margin:0;color:var(--text-secondary);font-size:calc(13px*var(--fs));line-height:1.6}
.kb-st-wrap{min-width:0;overflow-wrap:anywhere;text-align:right}
/* 触屏:两个字的分区名(「常规」「模型」「组件」「备份」)按钮宽度只有 42px,撑到 44px 以上 */
@media (pointer:coarse){.kb-st-layout .kb-settings-nav .ni{min-width:44px;justify-content:center}}
</style>
