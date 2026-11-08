<script setup lang="ts">
// 单文件时间线(设计稿):每个阶段的耗时 / 块数 / 向量数 / 失败原因,失败阶段可以就地「重试此阶段 / 跳过 / 移入隔离」。
// 数据:get_file_timeline;动作:retry_file_stage / skip_file / quarantine_file。
// 四种状态:读取中(骨架屏)、出错(说清楚 + 重试)、无权限、就绪;动作之后重新读取失败时保留旧数据并提示。
import { PATHS, importBatch } from '@/router/paths'
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import { KbBadge, KbIcon, KbNum, useToast } from '@kb-ui/index'

import { callCapability } from '@/api/client'
import { failureOf, type LoadPhase } from '@/utils/loadState'
import { fileChip, formatSize } from '@/utils/files'
import { formatElapsed, stateTag, type IngestState } from '@/utils/ingest'

interface TimelineFile {
  id: string
  batch_id: string | null
  collection: string
  rel_path: string
  size: number
  sha256?: string | null
  state: IngestState
  error: string | null
  chunks: number
  vectors: number
  elapsed_ms: number | null
}
interface TimelineStage {
  stage: string
  label: string
  status: string
  duration_ms: number | null
  chunks: number
  vectors: number
  error: string | null
}
interface Timeline {
  file: TimelineFile
  stages: TimelineStage[]
  total_ms: number | null
}

const route = useRoute()
const toast = useToast()
const id = computed(() => String(route.params.id ?? ''))
const timeline = ref<Timeline | null>(null)
/** 还没有数据时页面处于哪种状态;有数据之后一直是 ready */
const phase = ref<LoadPhase>('loading')
/** 出错 / 无权限时给用户看的两句话 */
const message = ref('')
/** 已经显示过数据之后重新读取失败:保留旧数据,只提示一句 */
const refreshFailed = ref(false)
const busy = ref(false)

const NOT_FOUND = '没有找到这个文件。它可能已经被清理,回到「导入记录」看看。'
async function load() {
  try {
    const data = await callCapability<Timeline>('get_file_timeline', { id: id.value })
    if (!data?.file || !Array.isArray(data.stages)) {
      timeline.value = null
      message.value = NOT_FOUND
      phase.value = 'error'
      return
    }
    timeline.value = data
    refreshFailed.value = false
    phase.value = 'ready'
  } catch (err) {
    const failure = failureOf(err, '读取文件时间线')
    if (timeline.value && failure.phase === 'error') {
      refreshFailed.value = true
      return
    }
    timeline.value = null
    message.value = failure.message
    phase.value = failure.phase
  }
}
/** 出错页上的「重试」:回到读取中,再读一次 */
async function retry() {
  phase.value = 'loading'
  await load()
}
onMounted(load)

const file = computed(() => timeline.value?.file ?? null)
const chip = computed(() => fileChip((file.value?.rel_path ?? '').split(' › ')[0]!.split('/').pop() ?? ''))
const shortName = computed(() => (file.value?.rel_path ?? '').split('/').pop() ?? '')
const fmt = (value: number) => value.toLocaleString()

type StepState = 'done' | 'failed' | 'running' | 'pending'
const steps = computed(() =>
  (timeline.value?.stages ?? []).map((stage) => {
    const state: StepState =
      stage.status === 'ok'
        ? 'done'
        : stage.status === 'failed' || stage.status === 'quarantined'
          ? 'failed'
          : stage.status === 'running'
            ? 'running'
            : 'pending'
    const parts = [stage.chunks ? `${fmt(stage.chunks)} 块` : '', stage.vectors ? `${fmt(stage.vectors)} 向量` : ''].filter(Boolean)
    return {
      ...stage,
      state,
      note: stage.error ?? (parts.join(' · ') || (state === 'pending' ? '未开始' : '')),
      time: state === 'pending' ? '—' : formatElapsed(stage.duration_ms),
    }
  }),
)
const failedStage = computed(() => steps.value.find((step) => step.state === 'failed') ?? null)
const tag = computed(() => {
  const state = file.value?.state
  if (state === 'failed' && failedStage.value) return { tone: 'danger' as const, text: `✕ 失败于 ${failedStage.value.label}` }
  return state ? stateTag(state) : { tone: 'neutral' as const, text: '' }
})

/** doing = 正在做什么(「跳过」),done = 成功后的提示(「已跳过」);失败提示是「跳过失败:原因。…」 */
async function act(name: string, args: Record<string, unknown>, doing: string, done: string) {
  busy.value = true
  try {
    await callCapability(name, { id: id.value, ...args })
    toast.push(done)
    await load()
  } catch (err) {
    toast.push(failureOf(err, doing).message, 'danger')
  } finally {
    busy.value = false
  }
}
const retryStage = (stage: string) => act('retry_file_stage', { stage }, '重试这个阶段', '已从该阶段重跑')
</script>

<template>
  <AppShell roomy>
    <template #breadcrumb>
      <RouterLink :to="PATHS.import">导入</RouterLink>
      <span>/</span>
      <RouterLink v-if="file?.batch_id" :to="importBatch(file.batch_id)" class="mono">{{ file.batch_id.slice(0, 8) }}</RouterLink>
      <RouterLink v-else :to="PATHS.importQueue">导入记录</RouterLink>
      <span>/</span>
      <b>{{ shortName || '文件' }}</b>
    </template>
    <template #actions><span class="kb-none"></span></template>

    <!-- 还没有数据:骨架屏 / 出错(带重试)/ 无权限 -->
    <AdminLoadState v-if="!file" :phase="phase" :message="message" skeleton="lines" @retry="retry" />
    <p v-if="file && refreshFailed" class="m kb-pl-idle" role="status" data-testid="file-stale">最近一次刷新没成功,下面显示的是之前的数据。操作之后可以再点一次,或刷新页面。</p>

    <template v-if="file">
      <!-- 手机:顶上一行「批次 › 文件」+ 状态徽标(桌面的面包屑里已经有) -->
      <div class="kb-q-msub">
        <b>
          <template v-if="file.batch_id">批次 <RouterLink class="mono kb-link" :to="importBatch(file.batch_id)">{{ file.batch_id.slice(0, 8) }}</RouterLink> › </template>文件
        </b>
        <KbBadge :tone="tag.tone">{{ file.state === 'failed' ? '失败' : tag.text }}</KbBadge>
      </div>
      <div class="row kb-tl-head">
        <span class="kb-fmt mono" :class="`is-${chip.tone}`">{{ chip.label }}</span>
        <span class="kb-tl-name" :title="file.rel_path">{{ shortName }}</span>
        <KbBadge :tone="tag.tone">{{ tag.text }}</KbBadge>
        <span class="m mono kb-tl-meta">{{ file.id.slice(0, 8) }} · {{ formatSize(file.size) }}</span>
      </div>

      <div class="kb-grid kb-grid-4">
        <div class="card metric">
          <div class="m kb-small">总耗时</div>
          <div class="v mono">{{ formatElapsed(timeline?.total_ms) }}</div>
          <div class="m kb-delta-note">{{ failedStage ? `卡在 ${failedStage.label}` : '全部阶段' }}</div>
        </div>
        <div class="card metric">
          <div class="m kb-small">块</div>
          <div class="v mono"><KbNum :value="fmt(file.chunks)" /></div>
          <div class="m kb-delta-note">{{ file.chunks ? '已分块' : '未分块' }}</div>
        </div>
        <div class="card metric">
          <div class="m kb-small">向量</div>
          <div class="v mono">{{ fmt(file.vectors) }}</div>
          <div class="m kb-delta-note">{{ file.vectors ? '已写入' : '—' }}</div>
        </div>
        <div class="card metric">
          <div class="m kb-small">大小</div>
          <div class="v mono">{{ formatSize(file.size) }}</div>
          <div class="m kb-delta-note">{{ file.collection }}</div>
        </div>
      </div>

      <div class="kb-tl-grid">
        <div class="card kb-tl-card">
          <div v-for="step in steps" :key="step.stage" class="kb-tl-step" :class="`is-${step.state}`">
            <span class="kb-tl-dot" aria-hidden="true"></span>
            <div class="kb-tl-body">
              <div class="row kb-tl-line">
                <b>{{ step.label }}</b>
                <span class="m mono kb-tl-time">{{ step.time }}</span>
              </div>
              <div class="kb-tl-note" :class="{ 'is-error': step.state === 'failed' }">{{ step.note }}</div>
              <div v-if="step.state === 'failed'" class="row kb-tl-actions">
                <button type="button" class="btn sm pri" :disabled="busy" @click="retryStage(step.stage)">
                  <KbIcon name="refresh" :size="14" /> 重试此阶段
                </button>
                <button type="button" class="btn sm" :disabled="busy" @click="act('skip_file', {}, '跳过', '已跳过')">跳过</button>
                <button type="button" class="btn sm" :disabled="busy" @click="act('quarantine_file', {}, '移入隔离', '已移入隔离')">移入隔离</button>
              </div>
            </div>
          </div>
        </div>

        <div class="card kb-tl-info">
          <div class="ch">文件信息</div>
          <dl class="kb-src-detail kb-tl-kv">
            <dt>路径</dt>
            <dd class="mono">{{ file.rel_path }}</dd>
            <dt>集合</dt>
            <dd class="mono">{{ file.collection }}</dd>
            <template v-if="file.batch_id">
              <dt>批次</dt>
              <dd><RouterLink class="mono kb-link" :to="importBatch(file.batch_id)">{{ file.batch_id.slice(0, 8) }}</RouterLink></dd>
            </template>
            <template v-if="file.sha256">
              <dt>SHA-256</dt>
              <dd class="mono">{{ file.sha256.slice(0, 16) }}…</dd>
            </template>
            <template v-if="file.error">
              <dt>失败原因</dt>
              <dd class="kb-danger">{{ file.error }}</dd>
            </template>
          </dl>
        </div>
      </div>
    </template>
  </AppShell>
</template>
