<script setup lang="ts">
import { clockText, timezoneOffsetText } from '@/utils/time'
// 批次详情 · 实时流水线(设计稿):七个阶段的进度环 + 总进度 + 吞吐 / 用时 / 剩余 / 向量 + 正在处理的文件。
// 数据:get_batch_progress;实时更新走 WS 的 `ingest.stage`,另有 3 秒轮询兜底(WS 断了也不会停)。
// 动作:pause_batch / resume_batch / cancel_batch。
// 四种状态:读取中(骨架屏)、出错(说清楚 + 重试)、无权限、就绪;就绪之后某次刷新失败,保留旧数据并提示。
import { PATHS, importFile } from '@/router/paths'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import { KbIcon, KbNum, KbSparkline, useConfirm, useToast } from '@kb-ui/index'

import { callCapability } from '@/api/client'
import { failureOf, type LoadPhase } from '@/utils/loadState'
import { useLiveEvents } from '@/composables/useLiveEvents'
import { fileChip } from '@/utils/files'
import type { IngestState } from '@/utils/ingest'

interface StageProgress {
  stage: string
  label: string
  files: number
  done: number
  chunks: number
  vectors: number
  percent: number
}
interface BatchProgress {
  batch: string
  collection: string
  state: 'running' | 'paused' | 'canceled' | 'done'
  stage: string
  done: number
  total: number
  chunks: number
  vectors: number
  throughput_cps: number
  eta_s: number | null
  elapsed_s: number
  current_files: string[]
  backend: string
  stages: StageProgress[]
}

const route = useRoute()
const router = useRouter()
const toast = useToast()
const batch = computed(() => String(route.params.batch ?? ''))
const progress = ref<BatchProgress | null>(null)
/** 还没有进度数据时页面处于哪种状态;有数据之后一直是 ready */
const phase = ref<LoadPhase>('loading')
/** 出错 / 无权限时给用户看的两句话 */
const message = ref('')
/** 已经显示过数据之后,某次刷新(3 秒一次的轮询)失败了:保留旧数据,只提示一句 */
const refreshFailed = ref(false)
const busy = ref(false)
/** 吞吐折线:每次拿到进度记一个点,最多 40 个 */
const samples = ref<number[]>([])
interface BatchFile {
  id: string
  rel_path: string
  state: IngestState
  error: string | null
  chunks: number
}
/** 本批次的文件(给「正在处理」里每个文件标上它自己所处的阶段;完成页的「需要处理」也用它) */
const batchFiles = ref<BatchFile[]>([])
const fileStates = computed(() => Object.fromEntries(batchFiles.value.map((file) => [file.rel_path, file.state])))
const STATE_LABEL: Record<string, string> = { queued: '排队', extracting: '解析中', chunking: '分块', embedding: '向量化' }

const fmt = (value: number) => value.toLocaleString()
const mmss = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const clock = (at: number) => clockText(at)
// 页面上写的时间都按站点时区,时区偏移也用它,不用访问者电脑的
const zone = () => timezoneOffsetText()

const NOT_FOUND = '没有找到这个批次。它可能已经被清理,回到「导入记录」看看。'
async function load() {
  try {
    const data = await callCapability<BatchProgress>('get_batch_progress', { batch: batch.value })
    if (!Array.isArray(data?.stages)) {
      progress.value = null
      message.value = NOT_FOUND
      phase.value = 'error'
      return
    }
    apply(data)
    const listed = await callCapability<{ files: BatchFile[] }>('list_ingest', {
      batch_id: batch.value,
      page_size: 200,
    }).catch(() => null)
    if (listed) batchFiles.value = listed.files
  } catch (err) {
    const failure = failureOf(err, '读取批次进度')
    // 已经有数据:后台刷新失败不把整页换成报错,保留旧数据并提示(下一次轮询会自动重试)
    if (progress.value && failure.phase === 'error') {
      refreshFailed.value = true
      return
    }
    progress.value = null
    message.value = failure.message
    phase.value = failure.phase
  }
}
/** 出错页上的「重试」:回到读取中,再读一次 */
async function retry() {
  phase.value = 'loading'
  await load()
}
function apply(data: BatchProgress) {
  // 轮询和 WebSocket 推送都会走这里:拿到数据就说明读通了,清掉出错 / 刷新失败的标记
  refreshFailed.value = false
  phase.value = 'ready'
  progress.value = data
  samples.value = [...samples.value, data.throughput_cps].slice(-40)
}

let timer = 0
onMounted(() => {
  void load()
  timer = window.setInterval(() => {
    // 运行中要刷进度;上一次刷新失败了也要继续试(页面上写着「稍后会自动重试」)
    if (progress.value?.state === 'running' || refreshFailed.value) void load()
  }, 3000)
})
onUnmounted(() => window.clearInterval(timer))
useLiveEvents((event) => {
  if (event.type !== 'ingest.stage') return
  const data = event.data as unknown as BatchProgress
  if (data.batch === batch.value) apply(data)
})

/** 阶段环:除了「可检索」之外,每一步的主数字 / 副说明(后端给什么就写什么,没有的不编) */
const steps = computed(() =>
  (progress.value?.stages ?? []).map((stage) => {
    const done = stage.percent >= 100
    const main =
      stage.stage === 'embed'
        ? `${fmt(stage.vectors)} / ${fmt(stage.chunks)}`
        : stage.stage === 'write'
          ? fmt(stage.vectors)
          : `${fmt(stage.done)} / ${fmt(stage.files)}`
    const note: Record<string, string> = {
      upload: '文件',
      detect: '内容和扩展名',
      chunk: stage.chunks ? `${fmt(stage.chunks)} 块` : '',
      embed: '块',
      write: '向量',
      searchable: '文件',
    }
    return {
      key: stage.stage,
      label: stage.label,
      main: stage.stage === 'upload' ? `${main} 文件` : main,
      note: stage.stage === 'upload' ? '' : (note[stage.stage] ?? ''),
      percent: Math.round(stage.percent),
      done,
      // 圆环周长 2πr(r=19)≈119.4
      dash: `${(119.4 * Math.min(100, stage.percent)) / 100} 200`,
      active: !done && stage.percent > 0,
    }
  }),
)
/** 总进度:各阶段(不含「可检索」)平均 */
const overall = computed(() => {
  const stages = (progress.value?.stages ?? []).filter((stage) => stage.stage !== 'searchable')
  if (!stages.length) return 0
  return Math.round(stages.reduce((sum, stage) => sum + stage.percent, 0) / stages.length)
})
const currentLabel = computed(() => progress.value?.stages.find((stage) => stage.stage === progress.value?.stage)?.label ?? '')
const stateTag = computed(() => {
  switch (progress.value?.state) {
    case 'paused':
      return { cls: 'y', text: '已暂停', spin: false }
    case 'canceled':
      return { cls: 'r', text: '已取消', spin: false }
    case 'done':
      return { cls: 'g', text: '已完成', spin: false }
    default:
      return { cls: 'ac', text: '运行中', spin: true }
  }
})
const startedAt = computed(() => (progress.value ? Date.now() - progress.value.elapsed_s * 1000 : 0))
const finishAt = computed(() => (progress.value?.eta_s != null ? Date.now() + progress.value.eta_s * 1000 : 0))

/* ---------------- 批次完成(设计稿) ---------------- */
const finished = computed(() => progress.value?.state === 'done')
const okFiles = computed(() => batchFiles.value.filter((file) => file.state === 'done').length)
const problems = computed(() => batchFiles.value.filter((file) => file.state === 'failed' || file.state === 'quarantined'))
const failedCount = computed(() => problems.value.filter((file) => file.state === 'failed').length)
const quarantinedCount = computed(() => problems.value.length - failedCount.value)
const avgChunks = computed(() => (okFiles.value ? Math.round((progress.value?.chunks ?? 0) / okFiles.value) : 0))
const spent = computed(() => {
  const seconds = progress.value?.elapsed_s ?? 0
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒` : `${Math.floor(seconds)} 秒`
})
const searchText = ref('')
function search() {
  const text = searchText.value.trim()
  if (text) void router.push({ path: PATHS.search, query: { q: text } })
}
async function retryAll() {
  const ids = problems.value.map((file) => file.id)
  if (!ids.length) return
  busy.value = true
  try {
    await callCapability('retry_ingest', { ids })
    toast.push(`已重新入队 ${ids.length} 个文件`)
    await load()
  } catch (err) {
    toast.push(failureOf(err, '重试').message, 'danger')
  } finally {
    busy.value = false
  }
}
async function revertAll() {
  const ok = await useConfirm().ask({
    title: '撤销整个批次?',
    message: '这个批次入库的内容会被撤销,已完成的文件也会回滚。',
    confirmText: '撤销整批',
    tone: 'danger',
    doneText: '已撤销',
    action: () => callCapability('cancel_batch', { batch: batch.value, revert: true }),
  })
  if (ok) await load()
}

/** doing = 正在做什么(「暂停」),done = 成功后的提示(「已暂停」);失败提示是「暂停失败:原因。…」 */
async function act(name: string, doing: string, done: string) {
  busy.value = true
  try {
    await callCapability(name, { batch: batch.value })
    toast.push(done)
    await load()
  } catch (err) {
    toast.push(failureOf(err, doing).message, 'danger')
  } finally {
    busy.value = false
  }
}
async function cancel() {
  const ok = await useConfirm().ask({
    title: '取消这个批次?',
    message: '在途文件会回滚,已完成的文件保留。',
    confirmText: '取消批次',
    cancelText: '再想想',
    tone: 'danger',
  })
  if (ok) await act('cancel_batch', '取消批次', '已取消')
}
</script>

<template>
  <AppShell roomy>
    <template #breadcrumb>
      <RouterLink :to="PATHS.import">导入</RouterLink>
      <span>/</span>
      <RouterLink :to="PATHS.importQueue">导入记录</RouterLink>
      <span>/</span>
      <b class="mono">{{ batch.slice(0, 8) }}</b><b v-if="finished"> · 完成</b>
    </template>
    <template #actions><span class="kb-none"></span></template>

    <!-- 还没有数据:骨架屏 / 出错(带重试)/ 无权限 -->
    <AdminLoadState v-if="!progress" :phase="phase" :message="message" skeleton="lines" @retry="retry" />
    <p v-if="progress && refreshFailed" class="m kb-pl-idle" role="status" data-testid="batch-stale">最近一次刷新没成功,下面显示的是之前的数据,稍后会自动重试。</p>

    <!-- 批次已完成:总结页(批次完成) -->
    <div v-if="progress && finished" class="kb-done">
      <div class="card kb-done-head">
        <span class="kb-done-orb"><KbIcon name="check" :size="22" /></span>
        <div class="kb-done-title">
          <div class="kb-page-title">批次 <span class="mono">{{ batch.slice(0, 8) }}</span> 已完成</div>
          <div class="m kb-done-sub">
            用时 {{ spent }}<template v-if="progress.backend"> · {{ progress.backend }}</template> · 平均 {{ progress.throughput_cps }} 块/秒
          </div>
        </div>
        <button type="button" class="btn sm kb-done-revert" :disabled="busy" @click="revertAll">撤销整批</button>
      </div>

      <div class="kb-grid kb-grid-4">
        <div class="card metric">
          <div class="m kb-small">文件</div>
          <div class="v mono"><KbNum :value="`${okFiles} / ${progress.total}`" /></div>
          <div class="m kb-delta-note">成功</div>
        </div>
        <div class="card metric">
          <div class="m kb-small">块</div>
          <div class="v mono"><KbNum :value="fmt(progress.chunks)" /></div>
          <div class="m kb-delta-note">{{ avgChunks ? `平均 ${fmt(avgChunks)} / 文件` : '—' }}</div>
        </div>
        <div class="card metric">
          <div class="m kb-small">向量</div>
          <div class="v mono"><KbNum :value="fmt(progress.vectors)" /></div>
          <div class="m kb-delta-note">{{ progress.backend || '—' }}</div>
        </div>
        <div class="card metric">
          <div class="m kb-small">问题</div>
          <div class="v mono"><KbNum :value="`${failedCount} + ${quarantinedCount}`" /></div>
          <div class="m kb-delta-note">失败 · 隔离</div>
        </div>
      </div>

      <div v-if="problems.length" class="card kb-done-todo">
        <div class="ch">
          需要处理
          <div class="r">
            <button type="button" class="btn sm" :disabled="busy" @click="retryAll"><KbIcon name="refresh" :size="14" /> 全部重试</button>
          </div>
        </div>
        <RouterLink v-for="file in problems" :key="file.id" class="row kb-done-row" :to="importFile(file.id)">
          <span class="kb-fmt mono" :class="`is-${fileChip((file.rel_path.split(' › ')[0] ?? '').split('/').pop() ?? '').tone}`">
            {{ fileChip((file.rel_path.split(' › ')[0] ?? '').split('/').pop() ?? '').label }}
          </span>
          <span class="kb-done-name" :title="file.rel_path">{{ file.rel_path.split('/').pop() }}</span>
          <span class="m kb-done-why" :title="file.error ?? ''">{{ file.error ?? '' }}</span>
          <span class="tag" :class="file.state === 'failed' ? 'r' : 'y'">{{ file.state === 'failed' ? '失败' : '隔离' }}</span>
        </RouterLink>
      </div>

      <form class="card kb-done-search" @submit.prevent="search">
        <div class="row kb-done-search-head">
          <b>试试搜索刚导入的内容</b>
          <span class="m">{{ progress.collection }}</span>
        </div>
        <label class="inp kb-done-input">
          <KbIcon name="search" :size="14" />
          <input v-model="searchText" type="text" placeholder="例如:这批资料里关于部署的说明" aria-label="搜索刚导入的内容" />
          <kbd class="kbd">↵</kbd>
        </label>
      </form>
    </div>

    <template v-else-if="progress">
      <!-- 手机:标题 + 状态徽标 + 一行摘要 -->
      <div class="kb-q-msub">
        <b>批次 <span class="mono">{{ batch.slice(0, 8) }}</span></b>
        <span class="tag" :class="stateTag.cls">{{ stateTag.text }} {{ overall }}%</span>
        <span v-if="progress.backend" class="tag mono">{{ progress.backend }}</span>
        <span class="m kb-pl-sub">{{ progress.collection }} · {{ progress.total }} 个文件<template v-if="progress.eta_s != null"> · 预计剩余 {{ mmss(progress.eta_s) }}</template></span>
      </div>

      <div class="row kb-q-head kb-pl-head">
        <div class="kb-q-title">
          <div class="row kb-pl-title">
            <span class="kb-page-title">批次 <span class="mono">{{ batch.slice(0, 8) }}</span></span>
            <span class="tag" :class="stateTag.cls"><span v-if="stateTag.spin" class="ring kb-pl-ring"></span> {{ stateTag.text }}</span>
            <span v-if="progress.backend" class="tag mono">{{ progress.backend }}</span>
          </div>
          <div class="m kb-page-sub">{{ progress.collection }} · {{ progress.total }} 个文件</div>
        </div>
        <span class="kb-spacer row">
          <button v-if="progress.state === 'paused'" type="button" class="btn" :disabled="busy" @click="act('resume_batch', '继续批次', '已继续')">继续</button>
          <button v-else type="button" class="btn" :disabled="busy || progress.state !== 'running'" @click="act('pause_batch', '暂停批次', '已暂停')">暂停</button>
          <button type="button" class="btn" :disabled="busy || progress.state === 'canceled' || progress.state === 'done'" @click="cancel">取消</button>
          <RouterLink class="btn pri" :to="`${PATHS.importQueue}?batch=${batch}`">查看文件</RouterLink>
        </span>
      </div>

      <div class="card kb-pl">
        <div class="pst kb-pl-steps">
          <div v-for="(step, index) in steps" :key="step.key" class="kb-pl-step">
            <div
              v-if="index > 0"
              class="kb-pl-line"
              :class="{ 'is-done': steps[index - 1]?.done, 'is-active': !steps[index - 1]?.done && steps[index - 1]?.active }"
            ></div>
            <svg class="kb-pl-svg" :class="{ 'is-active': step.active }" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
              <circle cx="22" cy="22" r="19" fill="none" stroke="rgba(var(--ink),.08)" stroke-width="2.5" />
              <circle
                cx="22"
                cy="22"
                r="19"
                fill="none"
                :stroke="step.done ? 'var(--status-success)' : 'var(--accent-hover)'"
                stroke-width="2.5"
                stroke-linecap="round"
                :stroke-dasharray="step.dash"
                transform="rotate(-90 22 22)"
              />
              <text x="22" y="26" text-anchor="middle" class="kb-pl-pct">{{ step.done ? '✓' : `${step.percent}%` }}</text>
            </svg>
            <div class="kb-pl-label">{{ step.label }}</div>
            <div class="mono kb-pl-main">{{ step.main }}</div>
            <div class="m kb-pl-note">{{ step.note }}</div>
          </div>
        </div>
        <div class="row kb-pl-total">
          <div class="bar kb-pl-bar"><i :style="{ width: `${overall}%` }" style-allow="总进度"></i></div>
          <span class="mono">{{ overall }}%</span>
        </div>
      </div>

      <div class="kb-grid kb-grid-4">
        <div class="card metric">
          <div class="m kb-small">吞吐</div>
          <div class="v mono"><KbNum :value="progress.throughput_cps" /></div>
          <div class="m kb-delta-note">块/秒</div>
          <KbSparkline
            class="kb-pl-spark"
            :values="samples.length > 1 ? samples : [progress.throughput_cps, progress.throughput_cps]"
            :width="246"
            :height="48"
            gradient-id="pl-spark"
          />
        </div>
        <div class="card metric">
          <div class="m kb-small">已用时</div>
          <div class="v mono">{{ mmss(progress.elapsed_s) }}</div>
          <div class="m kb-delta-note">开始于 {{ clock(startedAt) }} ({{ zone() }})</div>
        </div>
        <div class="card metric">
          <div class="m kb-small">预计剩余</div>
          <div class="v mono">{{ progress.eta_s != null ? mmss(progress.eta_s) : '—' }}</div>
          <div class="m kb-delta-note">{{ finishAt ? `完成约 ${clock(finishAt)}` : '暂无估计' }}</div>
        </div>
        <div class="card metric">
          <div class="m kb-small">向量</div>
          <div class="v mono">{{ fmt(progress.vectors) }} / {{ fmt(progress.chunks) }}</div>
          <div class="m kb-delta-note">已写入 / 已分块</div>
        </div>
      </div>

      <div class="card kb-pl-now">
        <div class="row kb-pl-now-head">
          <b>正在处理</b>
          <span class="m kb-pl-now-count">{{ progress.current_files.length }} 个并发</span>
        </div>
        <div v-for="name in progress.current_files" :key="name" class="row kb-pl-file">
          <span class="ring"></span>
          <span class="kb-fmt mono" :class="`is-${fileChip(name).tone}`">{{ fileChip(name).label }}</span>
          <span class="kb-pl-file-name" :title="name">{{ name }}</span>
          <span v-if="STATE_LABEL[fileStates[name] ?? ''] ?? currentLabel" class="tag ac">{{ STATE_LABEL[fileStates[name] ?? ''] ?? currentLabel }}</span>
        </div>
        <div v-if="!progress.current_files.length" class="m kb-pl-idle">
          {{ progress.state === 'running' ? '暂时没有在处理的文件' : '这个批次没有在跑' }}
        </div>
      </div>
    </template>
  </AppShell>
</template>
