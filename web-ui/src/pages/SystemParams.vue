<script setup lang="ts">
// 系统参数(管理组):注册、AI、存储、分享与游客、站点。草图见 设计稿。
// 页面由 utils/systemParams.ts 的字段表驱动;保存时只提交改过的键,后端热更新,不用重启。
import { computed, onMounted, ref } from 'vue'
import AppShell from '@/layouts/AppShell.vue'
import MailSettings from '@/components/MailSettings.vue'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import { KbBadge, KbButton, KbCard, KbInput, KbSwitch, useConfirm, useToast } from '@kb-ui/index'
import { callCapability } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import { failureOf, type LoadPhase } from '@/utils/loadState'
import { PARAM_SECTIONS, buildPatch, readPath, restartFields, sectionsFor, toDraft, type Draft, type ParamField } from '@/utils/systemParams'
import { roleList, type RoleRow } from '@/utils/adminApi'
import { setSiteTimezone } from '@/utils/time'

const toast = useToast()
const confirm = useConfirm()
const session = useSessionStore()
// 加载中 / 报错 / 无权限三种非正常状态走统一的管理页组件;就绪后才画参数卡片
const phase = ref<LoadPhase>('loading')
const message = ref('')
const saving = ref(false)
const config = ref<Record<string, unknown>>({})
const draft = ref<Draft>({})
/** 「新用户的默认角色」要从角色里选;没有「用户」功能读不到角色时退回手填编号 */
const roles = ref<RoleRow[]>([])

async function load() {
  config.value = await callCapability<Record<string, unknown>>('get_config')
  draft.value = toDraft(config.value)
  // 时区是全局显示口径:保存后立即改,不等下一次 /auth/status
  setSiteTimezone(readPath(config.value, 'site.timezone') as string | undefined)
  roles.value = await roleList().then((reply) => reply.roles).catch(() => [])
}

// AI 总开关以**已保存**的配置为准:关着时「AI」分区换成中性写法、只留总开关;
// 草稿里刚打开还没保存时,其余设置要保存之后才出现
const aiOn = computed(() => readPath(config.value, 'ai.enabled') === true)
const sections = computed(() => sectionsFor(aiOn.value))
const aiTurningOn = computed(() => !aiOn.value && draft.value['ai.enabled'] === true)

/** 当前草稿相对已保存配置的改动(用于「有 N 项未保存」和保存按钮) */
const pending = computed(() => {
  const result = buildPatch(config.value, draft.value)
  return 'error' in result ? { error: result.error, changed: [] as string[] } : { error: '', changed: result.changed }
})
const dirty = computed(() => pending.value.changed.length > 0)

function disabled(field: ParamField) {
  return !!field.dependsOn && draft.value[field.dependsOn] !== true
}

function revert() {
  draft.value = toDraft(config.value)
}

/**
 * 这几类改动影响全站,保存前先确认并写明后果:
 *  - 打开带风险提示的项(允许游客编辑、允许网页来源访问内网、管理员必须开两步验证…);
 *  - 把大模型总开关从开改成关(所有人的入口立刻消失、后台自动整理停止)。
 */
async function confirmRisky(changed: string[]): Promise<boolean> {
  const all = sections.value.flatMap((section) => section.fields)
  const risky = changed.map((path) => all.find((field) => field.path === path)).filter((field): field is ParamField => !!field?.risk && draft.value[field.path] === true)
  const turningOff = changed.includes('ai.enabled') && draft.value['ai.enabled'] !== true
  if (!risky.length && !turningOff) return true
  const parts = [
    ...risky.map((field) => `「${field.label}」:${field.risk}。`),
    ...(turningOff ? ['关闭大模型功能后,所有人的相关入口立刻消失,后台的自动提炼、审核和整理也会停止;已有的笔记和索引不受影响,重新打开即可恢复。'] : []),
  ]
  return confirm.ask({
    title: risky.length ? '确认保存这些有风险的设置?' : '确认关闭大模型功能?',
    message: parts.join(' '),
    confirmText: risky.length ? '确认保存' : '确认关闭',
    cancelText: '先不保存',
    tone: 'danger',
  })
}

async function save() {
  const result = buildPatch(config.value, draft.value)
  if ('error' in result) {
    toast.push(result.error, 'danger')
    return
  }
  if (!result.changed.length) return
  if (!(await confirmRisky(result.changed))) return
  saving.value = true
  try {
    const reply = await callCapability<{ applied: boolean; restart_required: boolean; notes: string[] }>('update_config', {
      patch: result.patch,
      confirm: true,
    })
    if (!reply.applied) {
      toast.push(reply.notes.join(';') || '没有写入', 'warning')
      return
    }
    // 后端热更新不覆盖的键(内网抓取等)写进了配置文件,但要重启服务才生效:单独说清楚,别让人以为已经生效
    const needRestart = restartFields(result.changed)
    toast.push(
      reply.restart_required || needRestart.length
        ? `已保存 ${result.changed.length} 项。「${needRestart.map((field) => field.label).join('、') || '部分设置'}」要重启服务后才生效,其余已立即生效。`
        : `已保存 ${result.changed.length} 项,立即生效`,
      reply.restart_required || needRestart.length ? 'warning' : 'success',
    )
    await load()
    // AI 总开关等会改变导航:让会话 store 马上刷新,不等 20 秒
    void session.load()
  } catch (err) {
    toast.push(failureOf(err, '保存系统参数').message, 'danger')
  } finally {
    saving.value = false
  }
}

const activeSection = ref(PARAM_SECTIONS[0]?.id ?? '')
function jump(id: string) {
  activeSection.value = id
  document.getElementById(`param-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function init() {
  phase.value = 'loading'
  try {
    await load()
    phase.value = 'ready'
  } catch (err) {
    const failure = failureOf(err, '读取系统参数')
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
        <div class="kb-page-title">系统参数</div>
        <div class="m kb-page-sub">这些值是全站默认。角色和单个用户可以覆盖配额类的值。保存后立即生效。</div>
      </div>
    </div>

    <AdminLoadState v-if="phase !== 'ready'" :phase="phase" :message="message" skeleton="lines" @retry="init()" />

    <div v-else class="kb-sp-layout">
      <nav class="kb-sp-nav" aria-label="参数分组">
        <button
          v-for="section in sections"
          :key="section.id"
          type="button"
          :class="{ on: section.id === activeSection }"
          @click="jump(section.id)"
        >
          {{ section.title }}
        </button>
      </nav>

      <div class="kb-sp-body">
        <KbCard v-for="section in sections" :id="`param-${section.id}`" :key="section.id" class="kb-sp-card">
          <header class="kb-sp-head">
            <b>{{ section.title }}</b>
            <KbBadge v-if="section.id === 'ai' && draft['ai.enabled'] !== true" tone="warning">已关闭</KbBadge>
          </header>
          <p v-if="section.note" class="kb-sp-note">{{ section.note }}</p>
          <MailSettings v-if="section.id === 'mail'" />

          <div v-for="field in section.fields" :key="field.path" class="kb-sp-row" :class="{ 'is-sub': field.sub, 'is-off': disabled(field), 'has-switch': field.kind === 'bool' }">
            <div class="kb-sp-text">
              <span>{{ field.label }}<KbBadge v-if="field.restart" tone="warning" class="kb-sp-restart" data-testid="param-restart">需要重启</KbBadge></span>
              <small v-if="field.hint" class="m">{{ field.hint }}</small>
              <small v-if="field.risk && draft[field.path] === true" class="kb-sp-risk">{{ field.risk }}</small>
              <small v-if="field.path === 'ai.enabled' && aiTurningOn" class="kb-sp-risk" data-testid="ai-turning-on">保存之后,其余的大模型设置和额度才会出现在这里。</small>
            </div>
            <div class="kb-sp-ctl">
              <KbSwitch
                v-if="field.kind === 'bool'"
                :model-value="draft[field.path] === true"
                :disabled="disabled(field)"
                :aria-label="field.label"
                @update:model-value="(on: boolean) => (draft[field.path] = on)"
              />
              <select
                v-else-if="field.kind === 'role' && roles.length"
                class="kb-sp-select"
                :value="String(draft[field.path] ?? '')"
                :aria-label="field.label"
                @change="draft[field.path] = ($event.target as HTMLSelectElement).value"
              >
                <option v-if="!roles.some((role) => role.id === draft[field.path])" :value="String(draft[field.path] ?? '')">{{ draft[field.path] || '请选择' }}</option>
                <option v-for="role in roles" :key="role.id" :value="role.id">{{ role.name }}</option>
              </select>
              <template v-else>
                <KbInput
                  :model-value="String(draft[field.path] ?? '')"
                  :placeholder="field.kind === 'list' ? '留空 = 不限制' : ''"
                  :inputmode="field.kind === 'number' ? 'numeric' : undefined"
                  :aria-label="field.label"
                  @update:model-value="(value: string) => !disabled(field) && (draft[field.path] = value)"
                />
                <span v-if="field.unit" class="m kb-small">{{ field.unit }}</span>
              </template>
            </div>
          </div>
        </KbCard>
      </div>
    </div>

    <div v-if="dirty || pending.error" class="kb-sp-save" role="region" aria-label="保存">
      <span class="kb-sp-dot"></span>
      <span class="kb-sp-count">{{ pending.error || `有 ${pending.changed.length} 项修改未保存` }}</span>
      <span class="kb-spacer"></span>
      <KbButton :disabled="saving" @click="revert">还原</KbButton>
      <KbButton variant="primary" :disabled="saving || !!pending.error" @click="save">{{ saving ? '保存中…' : '保存' }}</KbButton>
    </div>
  </AppShell>
</template>

<style>
.kb-sp-layout{display:grid;grid-template-columns:180px minmax(0,1fr);gap:var(--gap-lg,16px);align-items:start;margin-top:var(--gap-md,12px)}
.kb-sp-nav{position:sticky;top:0;display:flex;flex-direction:column;gap:2px}
.kb-sp-nav button{padding:8px 12px;border:0;border-radius:var(--r2);background:none;color:var(--text-secondary);cursor:pointer;text-align:left;font:inherit}
.kb-sp-nav button.on{background:rgb(var(--ink),.08);color:var(--text-primary)}
.kb-sp-body{display:flex;flex-direction:column;gap:var(--gap-lg,16px);min-width:0;padding-bottom:84px}
.kb-sp-card{padding:0;overflow:hidden;scroll-margin-top:12px}
.kb-sp-head{display:flex;align-items:center;gap:var(--sp-2);padding:var(--sp-3) var(--card-pad-x,16px);border-bottom:var(--hl) solid var(--b)}
.kb-sp-note{margin:0;padding:10px var(--card-pad-x,16px);font-size:calc(13px*var(--fs));color:var(--text-secondary);background:rgb(var(--ink),.03)}
.kb-sp-row{display:flex;align-items:center;justify-content:space-between;gap:var(--gap-md,12px);padding:12px var(--card-pad-x,16px);border-top:var(--hl) solid var(--b);min-width:0}
.kb-sp-row.is-sub{padding-left:calc(var(--card-pad-x,16px) + 20px);background:rgb(var(--ink),.02)}
.kb-sp-row.is-off{opacity:.45}
.kb-sp-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.kb-sp-text small{color:var(--text-tertiary);font-size:calc(12px*var(--fs))}
.kb-sp-risk{color:var(--status-warning-text)!important}
.kb-sp-restart{margin-left:8px;vertical-align:middle}
.kb-sp-ctl{display:flex;align-items:center;gap:8px;flex:none;min-width:0}
.kb-sp-ctl .kb-input,.kb-sp-ctl input{min-width:0;width:200px}
.kb-sp-select{height:36px;min-width:0;width:200px;padding:0 10px;border-radius:var(--r2);border:var(--hl) solid var(--b2);background:var(--surface-2);color:var(--text-primary);font:inherit}
@media (pointer:coarse){.kb-sp-select{height:44px}.kb-sp-nav button{min-height:44px;min-width:44px}}
.kb-sp-save{position:fixed;left:var(--shell-left,0px);right:0;bottom:calc(var(--shell-bottom,0px) + var(--kbd-inset,0px));z-index:15;display:flex;align-items:center;gap:var(--gap-sm,8px);padding:12px max(24px,var(--safe-right)) calc(12px + var(--safe-bottom)) max(24px,var(--safe-left));background:color-mix(in oklab,var(--bg-canvas) 92%,transparent);backdrop-filter:blur(8px);border-top:var(--hl) solid var(--b2)}
.kb-sp-dot{width:8px;height:8px;border-radius:50%;background:var(--status-warning)}
.kb-sp-count{font-size:calc(13px*var(--fs))}
/* 保存条贴着内容区的底部:左边让出侧栏(宽度随三态 / 拖动变化)、下边让出手机标签栏——这两个量由外壳写进 --shell-left / --shell-bottom */
@media (max-width:1023px){
  .kb-sp-layout{grid-template-columns:minmax(0,1fr)}
  .kb-sp-nav{position:static;flex-direction:row;overflow-x:auto;scrollbar-width:none;border-bottom:var(--hl) solid var(--b)}
  /* flex:none:横滑导航的按钮不能被压窄(触屏下设了 min-width 之后,浏览器不再按文字宽度兜底,文字会叠在一起) */
  .kb-sp-nav button{flex:none;white-space:nowrap;border-radius:0;border-bottom:2px solid transparent;padding:10px 12px}
  .kb-sp-nav button.on{background:none;border-bottom-color:var(--accent)}
}
@media (max-width:699px){
  .kb-sp-row{flex-wrap:wrap;align-items:flex-start}
  .kb-sp-row .kb-sp-ctl{width:100%}
  .kb-sp-ctl .kb-input,.kb-sp-ctl input,.kb-sp-select{width:100%;flex:1}
  .kb-sp-row.has-switch{flex-wrap:nowrap;align-items:center}
  .kb-sp-row.has-switch .kb-sp-ctl{width:auto}
  .kb-sp-row.is-sub{padding-left:calc(var(--card-pad-x,16px) + 12px)}
}
/* 底部标签栏形态(手机、竖屏折叠屏):保存条改成内容区里的 sticky 底栏,不再 fixed 贴窗口底边。
   手机浏览器自带的底部工具栏会让「窗口底边」和外壳(100dvh)的底边差几十像素,fixed 的保存条就掉到标签栏下面被盖住;
   sticky 是内容区的一部分,标签栏永远在内容区下面,两者不可能再错位。键盘弹出时外壳自己让出键盘高度,这里不用再算。
   用 data-tabbar 判断(外壳按同一个形态渲染标签栏),不重复写一份媒体查询。 */
.kb-app[data-tabbar] .kb-sp-save{position:sticky;left:auto;right:auto;bottom:0;flex:0 0 auto;margin:0;padding:10px 16px;border:var(--hl) solid var(--b2);border-radius:var(--r3);background:var(--surface-3);box-shadow:var(--sh2);backdrop-filter:none}
@media (max-width:599px){
  .kb-sp-save{padding:10px 16px}
  .kb-sp-count{display:none}
  .kb-sp-dot{display:none}
  .kb-sp-save .kb-spacer{display:none}
  .kb-sp-save .btn{flex:1}
}
</style>
