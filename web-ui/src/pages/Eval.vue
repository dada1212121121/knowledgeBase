<script setup lang="ts">
// 评测(管理组,功能点 search.tune):拿一份写好「查询 → 应该找到哪个文件」的清单(黄金集)逐条搜索,看正确文件排第几。
// 调整检索设置前后各跑一次,对比两次的数字,就知道改动有没有变好。
//
// 数据:eval_history 读历次结果(每条里存着逐条名次),eval_run 现跑一次(同步返回,没有中间进度,所以等待时只能显示已用时间)。
// 四种状态:读历史时骨架 / 读失败(整块报错 + 重试)/ 没跑过(空状态 + 运行)/ 没有这个功能(说明原因,不请求接口)。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppShell from '@/layouts/AppShell.vue'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import {
  KbBadge,
  KbButton,
  KbCard,
  KbEmpty,
  KbGroupedBars,
  KbHBars,
  KbInput,
  KbLineChart,
  KbPageHeader,
  KbResponsiveTable,
  KbSegmented,
  KbSelect,
  PHONE_QUERY,
  useMedia,
  useToast,
  type GroupSeries,
  type RtColumn,
} from '@kb-ui/index'
import { CapabilityError, callCapability } from '@/api/client'
import { useFeature } from '@/composables/useFeature'
import { adminFailure } from '@/utils/adminFailure'
import { chartPercent, hitRateTrend, latencyTrend, rankDistribution } from '@/utils/evalCharts'
import { NO_ACCESS_TEXT, type Failure, type LoadPhase } from '@/utils/loadState'
import {
  byFormat,
  casesOfFormat,
  compareRuns,
  degradedNote,
  deltaView,
  elapsedText,
  formatOf,
  incomparableNote,
  intervalText,
  invalidNote,
  isInvalidSet,
  metricHelp,
  missedCount,
  modeText,
  rerankText,
  optionalMs,
  optionalPercent,
  percentText,
  previousOf,
  rankView,
  samplingNote,
  scoreText,
  stamp,
  trendLabels,
  trendOf,
  type DeltaView,
  type EvalCase,
  type EvalRun,
} from '@/utils/evalRuns'

const toast = useToast()
const allowed = useFeature('search.tune')
const phone = useMedia(PHONE_QUERY)

const phase = ref<LoadPhase>('loading')
const message = ref('')
const history = ref<EvalRun[]>([])
/** 这次打开页面后现跑的一次;还没跑过就是 null,页面显示历史里最新的一条 */
const result = ref<EvalRun | null>(null)
const running = ref(false)
const startedAt = ref(0)
const now = ref(0)
const runFailure = ref<Failure | null>(null)
const k = ref<string | number>(5)
/** 抽样条数:空 = 全部跑;填了就是「从黄金集里随机抽 N 条」(输入框给的是字符串,提交前再转数字) */
const sample = ref('')
/** 随机种子:空 = 后端现取一个(结果里会回传);填了就复现同一批用例 */
const seed = ref('')
const format = ref<string | number>('all')
const chartView = ref('trend')
let ticker: number | undefined

const kOptions = [3, 5, 10].map((value) => ({ value, label: `${value} 条` }))

/** 页面上展示的这一次:刚跑完的优先,否则是历史里最新的 */
const shown = computed<EvalRun | null>(() => result.value ?? history.value[0] ?? null)
const previous = computed(() => previousOf(shown.value, history.value))
const deltas = computed(() => compareRuns(shown.value, previous.value))
/** 这次和上一次能不能直接比(返回条数 / 用例集指纹);不能比时说清楚为什么,而不是藏起来 */
const deltaNote = computed(() => incomparableNote(shown.value, previous.value))
const help = computed(() => metricHelp(shown.value?.k ?? Number(k.value)))
const shownCases = computed<EvalCase[]>(() => shown.value?.cases ?? [])
const formats = computed(() => byFormat(shownCases.value))
const hasTrend = computed(() => history.value.length >= 2)
const hasFormat = computed(() => formats.value.length > 0)
/** 一条能跑的用例都没有:两个数字都没有意义,不摆指标卡 */
const invalidSet = computed(() => isInvalidSet(shown.value))
/** 图画哪一种:两种都有就听用户选的;只有一种就画那一种 */
const view = computed(() => (!hasFormat.value || (chartView.value === 'trend' && hasTrend.value) ? 'trend' : 'format'))

interface MetricCard {
  key: string
  label: string
  value: string
  help: string
  delta: DeltaView | null
}
const metrics = computed<MetricCard[]>(() => {
  const run = shown.value
  // 一条有效用例都没有时后端给的是 null:一张卡都不摆,而不是显示「NaN%」
  if (!run || isInvalidSet(run)) return []
  const d = deltas.value
  const text = help.value
  // 命中率是比例:把小样本的 95% 区间摆在数字下面,「差一条」就不再像「退步」
  const interval = intervalText(run)
  return [
    { key: 'hit1', label: text.hit1.label, value: percentText(run.hit_at_1), help: text.hit1.help, delta: d ? deltaView(d.hit1, 'point') : null },
    {
      key: 'hitk',
      label: text.hitk.label,
      value: percentText(run.hit_at_k),
      help: interval ? `${text.hitk.help}${interval} 是这一批用例给出的范围。` : text.hitk.help,
      delta: d ? deltaView(d.hitk, 'point') : null,
    },
    { key: 'mrr', label: text.mrr.label, value: scoreText(run.mrr), help: text.mrr.help, delta: d ? deltaView(d.mrr, 'score') : null },
    { key: 'degraded', label: text.degraded.label, value: String(run.degraded_cases ?? 0), help: text.degraded.help, delta: null },
  ]
})
const note = computed(() => degradedNote(shown.value))
/** 黄金集里对不上库的用例(已从分母剔除) */
const invalidMessage = computed(() => invalidNote(shown.value))
/** 抽样 / 打乱是怎么做的,以及怎么复现这一批 */
const samplingMessage = computed(() => samplingNote(shown.value))

// ---------------------------------------------------------------- 图

const trendRuns = computed(() => trendOf(history.value, phone.value ? 6 : 8))
const series = computed<GroupSeries[]>(() => {
  const kText = shown.value?.k ?? Number(k.value)
  if (view.value === 'format') {
    return [
      { name: `前 ${kText} 条命中率`, color: 'var(--chart-1)', values: formats.value.map((item) => item.hitRate) },
      { name: '平均排名得分', color: 'var(--chart-3)', values: formats.value.map((item) => item.mrr) },
    ]
  }
  return [
    { name: `前 ${kText} 条命中率`, color: 'var(--chart-1)', values: trendRuns.value.map((run) => run.hit_at_k) },
    { name: '平均排名得分', color: 'var(--chart-3)', values: trendRuns.value.map((run) => run.mrr) },
  ]
})
const labels = computed(() => (view.value === 'format' ? formats.value.map((item) => item.name) : trendLabels(trendRuns.value, phone.value)))
const chartOptions = [
  { value: 'trend', label: '历次趋势' },
  { value: 'format', label: '按文件格式' },
]

// 走势与名次分布:上面的分组柱图回答「这几次谁高谁低」,折线回答「有没有变差」(回落的点会标红),
// 名次分布回答「没排第 1 的那些,到底排在哪、有多少根本没找到」
const hitTrend = computed(() => hitRateTrend(history.value, phone.value))
const latency = computed(() => latencyTrend(history.value, phone.value))
const ranks = computed(() => rankDistribution(shownCases.value))
const droppedRuns = computed(() => new Set(hitTrend.value.series.flatMap((item) => item.flags ?? [])).size)
const msText = (value: number) => `${Math.round(value)} 毫秒`

// ---------------------------------------------------------------- 表

const historyColumns: RtColumn[] = [
  { key: 'at', label: '时间', cellClass: 'mono', mobile: 'primary' },
  { key: 'run', label: '运行编号', cellClass: 'mono m', mobile: 'meta' },
  { key: 'mode', label: '检索方式', cellClass: 'm', mobile: 'meta' },
  { key: 'hit3', label: '前 3 条命中率', cellClass: 'mono', mobile: 'meta' },
  { key: 'hit10', label: '前 10 条命中率', cellClass: 'mono', mobile: 'meta' },
  { key: 'mrr', label: '平均排名得分', cellClass: 'mono', mobile: 'meta' },
  { key: 'p95', label: '慢查询耗时', cellClass: 'mono', mobile: 'meta' },
]
interface HistoryRow extends EvalRun {
  id: string
}
const historyRows = computed<HistoryRow[]>(() => history.value.map((run, index) => ({ ...run, id: run.run_id ?? `${run.at ?? index}` })))

const caseColumns: RtColumn[] = [
  { key: 'query', label: '查询', mobile: 'primary' },
  { key: 'expect', label: '应该找到的文件', cellClass: 'mono m', clip: true, mobile: 'meta' },
  { key: 'rank', label: '实际名次', mobile: 'meta' },
]
interface CaseRow extends EvalCase {
  id: string
}
const filterOptions = computed(() => [
  { value: 'all', label: `全部格式 ${shownCases.value.length}` },
  ...formats.value.map((item) => ({ value: item.name, label: `${item.name} ${item.total}` })),
])
const caseRows = computed<CaseRow[]>(() => casesOfFormat(shownCases.value, String(format.value)).map((item, index) => ({ ...item, id: String(index) })))

// ---------------------------------------------------------------- 取数与运行

/** 读历史;成功返回 null,失败返回写好的失败说明(由调用方决定是整块报错还是只提示一句) */
async function fetchHistory(): Promise<Failure | null> {
  try {
    // 后端历史文件可能不存在或字段缺失(能力返回 `{}`),不能让 `undefined` 落到模板里
    const listed = await callCapability<{ runs?: EvalRun[] }>('eval_history', { limit: 20 })
    history.value = listed.runs ?? []
    return null
  } catch (err) {
    return adminFailure(err, '读取评测记录')
  }
}
/**
 * 功能点是否开通要看**当前**的会话:刷新页面时会话还没取回来,`allowed` 先是 true、取回来之后才变成 false,
 * 所以「无权限」靠 effectivePhase 随它实时切换,而不是在挂载那一刻判断一次。
 */
const effectivePhase = computed<LoadPhase>(() => (allowed.value ? phase.value : 'forbidden'))
const effectiveMessage = computed(() => (allowed.value ? message.value : NO_ACCESS_TEXT))

async function init() {
  if (!allowed.value) return
  phase.value = 'loading'
  const failure = await fetchHistory()
  phase.value = failure ? failure.phase : 'ready'
  message.value = failure?.message ?? ''
}

/** 真正的参数:抽多少条、用什么种子。空着就不传,由后端现取一个种子(并在结果里回传)。 */
function payload(): Record<string, unknown> {
  const data: Record<string, unknown> = { k: Number(k.value) }
  const size = Number(sample.value)
  if (sample.value !== '' && Number.isFinite(size) && size > 0) data.sample = Math.floor(size)
  const chosen = Number(seed.value)
  if (seed.value !== '' && Number.isFinite(chosen) && chosen >= 0) data.seed = Math.floor(chosen)
  return data
}

/** 换一个随机种子再跑:同一份黄金集也能给出另一批用例,避免只看一批数字就把调参定下来。 */
function reroll() {
  if (running.value) return
  seed.value = String(Math.floor(Math.random() * 1_000_000_000))
  void run()
}

async function run() {
  if (running.value) return
  running.value = true
  runFailure.value = null
  startedAt.value = Date.now()
  now.value = startedAt.value
  ticker = window.setInterval(() => (now.value = Date.now()), 1000)
  // 开跑前已有的记录:请求中途断开时,靠它认出"断开后服务端其实跑完了"的那一条(不比时间,手机和服务器的钟可能不一致)
  const knownRuns = new Set(history.value.map((item) => item.run_id).filter(Boolean))
  try {
    const finished = await callCapability<EvalRun>('eval_run', payload())
    result.value = { ...finished, at: finished.at ?? Date.now() }
    format.value = 'all'
    // 刚跑完的已经写进历史;重读一次让「历次结果」带上它。读失败不该盖掉这次的结果,只提示一句
    const failure = await fetchHistory()
    phase.value = 'ready'
    if (isInvalidSet(finished)) {
      // 一条能跑的用例都没有:这就是没测出东西,不能报一个命中率
      toast.push('这次没跑出数字:黄金集里的用例全都对不上库(见下方说明)', 'warning')
    } else {
      toast.push(`评测完成:第 1 条命中率 ${percentText(finished.hit_at_1)}`)
      // 有效用例被剔过时要张扬一点:命中率的分母已经不是黄金集的全部了
      if (finished.status === 'partial') toast.push(`有 ${finished.invalid_cases?.length ?? 0} 条用例无效、已从分母剔除`, 'warning')
    }
    if (failure) toast.push(`评测跑完了,但没能刷新历次结果。${failure.message}`, 'warning')
  } catch (err) {
    const gateway = err instanceof CapabilityError && err.code === 'bad_gateway'
    // 连接断了不等于没跑完:守护进程照常把结果写进了历史。重读一次,有新记录就直接用它
    const recovered = gateway && (await fetchHistory()) === null ? history.value.find((item) => item.run_id && !knownRuns.has(item.run_id)) : undefined
    if (recovered) {
      result.value = recovered
      format.value = 'all'
      phase.value = 'ready'
      toast.push(
        isInvalidSet(recovered)
          ? '中途断开了连接,但评测已在服务器上跑完:黄金集里的用例全都对不上库,没跑出数字'
          : `中途断开了连接,但评测已在服务器上跑完:第 1 条命中率 ${percentText(recovered.hit_at_1)}`,
        'warning',
      )
    } else {
      runFailure.value = adminFailure(err, '运行评测', {
        next: gateway ? '服务可能刚重启过或这次耗时太长,过几秒再点「重新运行」。' : '请确认黄金集文件存在、格式正确后重新运行。',
      })
    }
  } finally {
    running.value = false
    window.clearInterval(ticker)
  }
}

onMounted(() => void init())
// 管理员稍后给这个账号开通了功能:不用刷新页面,自动读取
watch(allowed, (value) => {
  if (value && phase.value !== 'ready') void init()
})
onUnmounted(() => window.clearInterval(ticker))
</script>

<template>
  <AppShell>
    <div class="kb-ev" data-testid="eval">
      <KbPageHeader title="评测" description="拿一份写好「查询 + 应该找到哪个文件」的清单(黄金集)逐条搜索,看正确文件排在第几位。调整检索设置前后各跑一次,就知道改动有没有变好。">
        <template v-if="effectivePhase !== 'forbidden'" #actions>
          <KbSelect v-model="k" :options="kOptions" prefix="返回条数 " aria-label="返回条数" />
          <KbButton variant="primary" :disabled="running || effectivePhase === 'loading'" data-testid="eval-run" @click="run">{{ running ? '评测中…' : '运行评测' }}</KbButton>
        </template>
      </KbPageHeader>

      <!-- 运行参数:抽样条数留空 = 全部用例;种子留空 = 后端现取一个(结果里会回传,填回去就能复现同一批) -->
      <div v-if="effectivePhase !== 'forbidden'" class="kb-ev-params">
        <label class="kb-ev-param">
          <span>抽样条数</span>
          <KbInput v-model="sample" inputmode="numeric" placeholder="全部" aria-label="抽样条数" data-testid="eval-sample" />
        </label>
        <label class="kb-ev-param">
          <span>随机种子</span>
          <KbInput v-model="seed" inputmode="numeric" placeholder="每次自动" aria-label="随机种子" data-testid="eval-seed" />
        </label>
        <KbButton size="sm" :disabled="running || effectivePhase !== 'ready'" data-testid="eval-reroll" @click="reroll">换一批用例</KbButton>
      </div>
      <p v-if="effectivePhase !== 'forbidden'" class="m kb-ev-note">
        返回条数(k):每条查询只看前几条结果,数字越大越容易命中,对比两次评测时请用同一个值。
        评测默认把黄金集全部跑一遍、顺序每次随机打乱;填了抽样条数就只随机抽 N 条,留空就是全部。
        想看数字稳不稳,点「换一批用例」——换一批抽样再跑一次,差得多说明用例集还太小。
      </p>

      <!-- 运行中:评测是同步请求,后端不报告完成了几条,所以只显示已用时间和一条走动的条,不编百分比 -->
      <div v-if="running" class="card kb-ev-wait" role="status" data-testid="eval-running">
        <div class="kb-ev-wait-text">正在评测,已用 {{ elapsedText(now - startedAt) }}。会逐条搜索黄金集里的查询,查询多的话要等一会儿,请不要关闭页面。</div>
        <div class="kb-ev-wait-bar" aria-hidden="true"><i></i></div>
      </div>

      <div v-if="runFailure" class="card kb-ev-fail" role="alert" data-testid="eval-run-error">
        <span class="kb-ev-fail-text">{{ runFailure.message }}</span>
        <!-- 没有权限时重试也不会变好,不给按钮 -->
        <KbButton v-if="runFailure.phase === 'error'" :disabled="running" data-testid="eval-retry" @click="run">重新运行</KbButton>
      </div>

      <AdminLoadState v-if="effectivePhase !== 'ready'" :phase="effectivePhase" :message="effectiveMessage" skeleton="card" @retry="init()" />

      <!-- 没跑过:一句说明 + 一个下一步 -->
      <div v-else-if="!shown" class="card" data-testid="eval-empty">
        <KbEmpty icon="chart" title="还没有跑过评测" description="评测会逐条搜索黄金集里的查询,统计正确文件排在第几位。第一次跑完后,这里会出现命中率、历次对比和逐条结果。">
          <template #action><KbButton variant="primary" :disabled="running" @click="run">{{ running ? '评测中…' : '运行评测' }}</KbButton></template>
        </KbEmpty>
      </div>

      <template v-else>
        <p class="m kb-ev-meta" data-testid="eval-meta">
          {{ result ? '刚跑完的这一次' : '最近一次评测' }}:{{ stamp(shown.at) }}<template v-if="shown.set"> · 用例集 {{ shown.set }}</template> · 检索方式 {{ modeText(shown.mode) }} · 重排 {{ rerankText(shown) }}<template v-if="shownCases.length"> · 共 {{ shownCases.length }} 条查询,{{ missedCount(shownCases) }} 条没找到</template>
        </p>
        <p v-if="note" class="kb-ev-warn" role="status" data-testid="eval-degraded">{{ note }}</p>
        <!-- 预检剔除的用例:命中率的分母已经不是黄金集的全部,必须说清楚 -->
        <p v-if="invalidMessage" class="kb-ev-warn" role="status" data-testid="eval-invalid">{{ invalidMessage }}</p>
        <!-- 两次不是同一道题(返回条数 / 用例集不同)就不给↑↓徽章,改为一句话说明 -->
        <p v-if="deltaNote" class="kb-ev-warn" role="status" data-testid="eval-incomparable">{{ deltaNote }}</p>
        <p v-if="samplingMessage" class="m kb-ev-meta" data-testid="eval-sampling">{{ samplingMessage }}</p>

        <!-- 一条能跑的用例都没有:不摆指标卡、不画图,只说明为什么没数字 -->
        <div v-if="invalidSet" class="card kb-ev-fail" role="alert" data-testid="eval-invalid-set">
          <span class="kb-ev-fail-text">这次没跑出数字:黄金集里的用例全都对不上库。按上面列出的集合名 / 文件路径修好 {{ shown.set ?? 'eval/golden.toml' }},再跑一次。</span>
        </div>

        <div v-if="!invalidSet" class="kb-ev-metrics" data-testid="eval-metrics">
          <div v-for="item in metrics" :key="item.key" class="card metric kb-ev-metric" :data-testid="`metric-${item.key}`">
            <div class="k">{{ item.label }}</div>
            <div class="v">{{ item.value }}</div>
            <div v-if="item.delta" class="s kb-ev-delta" :class="`is-${item.delta.tone}`">{{ item.delta.text }}<span class="m"> · 对比上一次</span></div>
            <!-- 没有对比数字的卡(第一次跑 / 换了用例集)也占住这一行,四张卡的说明文字才落在同一条基线上 -->
            <div v-else class="s kb-ev-delta-slot" aria-hidden="true">&nbsp;</div>
            <div class="s kb-ev-help">{{ item.help }}</div>
          </div>
        </div>

        <div v-if="!invalidSet" class="kb-ev-grid">
          <KbCard :title="view === 'format' ? '按文件格式拆分' : '历次趋势'" flush class="kb-ev-chart" data-testid="eval-chart">
            <template #extra>
              <KbSegmented v-if="hasTrend && hasFormat" v-model="chartView" :options="chartOptions" />
            </template>
            <KbGroupedBars v-if="view === 'format' || hasTrend" :labels="labels" :series="series" />
            <KbEmpty v-else icon="chart" size="sm" title="还画不出趋势" description="至少要有两次评测记录才能看变化。再运行一次评测,这里就会出现对比。" />
            <div v-if="view === 'format' || hasTrend" class="kb-ev-legend">
              <span class="kb-legend-dot"><span class="dot kb-dot-c1"></span>{{ series[0]?.name }}</span>
              <span class="kb-legend-dot"><span class="dot kb-dot-c3"></span>{{ series[1]?.name }}</span>
            </div>
          </KbCard>

          <KbCard title="历次结果" :subtitle="`最近 ${history.length} 次`" flush class="kb-ev-history" data-testid="eval-history">
            <KbResponsiveTable class="kb-ev-table" :columns="historyColumns" :rows="(historyRows as unknown as Record<string, unknown>[])" empty="还没有跑过评测">
              <template #cell-at="{ row }">{{ stamp((row as unknown as HistoryRow).at) }}</template>
              <template #cell-run="{ row }">{{ (row as unknown as HistoryRow).run_id ?? '—' }}</template>
              <template #cell-mode="{ row }">{{ modeText((row as unknown as HistoryRow).mode) }}</template>
              <template #cell-hit3="{ row }">{{ optionalPercent((row as unknown as HistoryRow).hit_at_3) }}</template>
              <template #cell-hit10="{ row }">{{ optionalPercent((row as unknown as HistoryRow).hit_at_10) }}</template>
              <template #cell-mrr="{ row }">{{ scoreText((row as unknown as HistoryRow).mrr) }}</template>
              <template #cell-p95="{ row }">{{ optionalMs((row as unknown as HistoryRow).p95_ms) }}</template>
            </KbResponsiveTable>
            <details class="kb-ev-cols">
              <summary>这些列是什么意思</summary>
              <ul>
                <li><b>{{ help.hit3.label }}</b>:{{ help.hit3.help }}</li>
                <li><b>{{ help.hit10.label }}</b>:{{ help.hit10.help }}</li>
                <li><b>{{ help.p95.label }}</b>:{{ help.p95.help }}</li>
                <li><b>检索方式</b>:只用关键词、关键词 + 语义、关键词 + 语义 + 重排,共三种。方式不同的两次结果不要直接比。</li>
              </ul>
            </details>
          </KbCard>
        </div>

        <div v-if="hasTrend || ranks.length" class="kb-ev-insights" data-testid="eval-insights">
          <KbCard v-if="hasTrend" title="命中率走势" class="kb-ev-trend" :class="{ 'is-wide': !latency }" data-testid="eval-trend">
            <!-- 结论写在正文里:卡片标题旁的小字在平板和手机上会被藏掉,「有没有变差」是这张图最要紧的一句 -->
            <p class="kb-ev-verdict" :class="{ 'is-down': droppedRuns }" data-testid="eval-trend-verdict">{{ droppedRuns ? `有 ${droppedRuns} 次比上一次低,图上用红圈标出。` : '最近几次没有回落。' }}</p>
            <KbLineChart :labels="hitTrend.labels" :series="hitTrend.series" label="命中率走势" :format="chartPercent" :floor="0" :ceil="1" category-label="运行时间" :height="phone ? 180 : 220" />
            <p v-if="hitTrend.skippedK || hitTrend.skippedSet" class="m kb-ev-foot">
              <template v-if="hitTrend.skippedK">有 {{ hitTrend.skippedK }} 次的返回条数和最新一次不同;</template>
              <template v-if="hitTrend.skippedSet">有 {{ hitTrend.skippedSet }} 次跑的不是同一批用例(黄金集改过或抽样不同);</template>
              这些次数没有画进曲线——不是同一个题,数字不能直接比。
            </p>
          </KbCard>
          <KbCard v-if="latency" title="慢查询耗时走势" class="kb-ev-latency" data-testid="eval-latency">
            <KbLineChart :labels="latency.labels" :series="latency.series" label="慢查询耗时走势" :format="msText" :floor="0" area category-label="运行时间" :height="phone ? 160 : 220" />
            <p class="m kb-ev-foot">95% 的查询在这个时间内完成。检索方式不同的两次耗时差很多(只用关键词最快,加上重排最慢),对比前先看「历次结果」里的检索方式。</p>
          </KbCard>
          <KbCard v-if="ranks.length" title="正确文件排在第几位" class="kb-ev-ranks" data-testid="eval-ranks">
            <KbHBars :rows="ranks" label="正确文件的名次分布" :max="shownCases.length" :format="(value: number) => `${value}`" />
            <p class="m kb-ev-foot">共 {{ shownCases.length }} 条查询。第 1 位越多越好;「没找到」是检索没把正确文件放进前 10 位,优先看这一行。</p>
          </KbCard>
        </div>

        <KbCard v-if="shownCases.length" title="逐条结果" :subtitle="`${caseRows.length} 条`" flush data-testid="eval-cases">
          <template #extra>
            <KbSelect v-model="format" :options="filterOptions" aria-label="按文件格式筛选" />
          </template>
          <KbResponsiveTable :columns="caseColumns" :rows="(caseRows as unknown as Record<string, unknown>[])" empty="这个格式下没有查询">
            <template #cell-query="{ row }">{{ (row as unknown as CaseRow).query }}</template>
            <template #cell-expect="{ row }">{{ (row as unknown as CaseRow).expect ?? `(没写应该找到的文件,按「${formatOf(row as unknown as CaseRow)}」归类)` }}</template>
            <template #cell-rank="{ row }">
              <KbBadge class="kb-ev-rank" :tone="rankView((row as unknown as CaseRow).rank).tone">{{ rankView((row as unknown as CaseRow).rank).text }}</KbBadge>
            </template>
          </KbResponsiveTable>
        </KbCard>
        <p v-else class="m kb-ev-meta" data-testid="eval-no-cases">这条记录没有保存逐条结果。重新运行一次评测,就能看到每条查询排在第几位。</p>
      </template>

    </div>
  </AppShell>
</template>

<style scoped>
.kb-ev { display: flex; flex-direction: column; gap: var(--gap); width: 100%; min-width: 0; }
.kb-ev-note { margin: var(--sp-2) 0 0; font-size: var(--text-12); }
/* 运行参数(抽样条数 / 随机种子):窄屏换行,输入框各自贴着标签 */
.kb-ev-params { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-2) var(--sp-3); }
.kb-ev-param { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; flex: 0 1 150px; font-size: var(--text-12); color: var(--text-secondary); }
.kb-ev-param .kb-input { width: 100%; min-width: 0; }
.kb-ev-meta { margin: 0; font-size: var(--text-13); overflow-wrap: anywhere; }
.kb-ev-warn { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r2); background: var(--surface-2); color: var(--status-warning-text); font-size: var(--text-13); overflow-wrap: anywhere; }

/* 运行中:一条来回走动的条表示「还在跑」;减少动效时不动,只显示满的条 */
.kb-ev-wait { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--card-pad-ui); }
.kb-ev-wait-text { font-size: var(--text-13); overflow-wrap: anywhere; }
.kb-ev-wait-bar { position: relative; height: var(--progress-h, 6px); border-radius: var(--r-pill); background: var(--panel2); overflow: hidden; }
.kb-ev-wait-bar > i { position: absolute; top: 0; bottom: 0; left: 0; width: 35%; border-radius: inherit; background: var(--accent); animation: kb-ev-slide 1.4s ease-in-out infinite; }
@keyframes kb-ev-slide { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
@media (prefers-reduced-motion: reduce) { .kb-ev-wait-bar > i { animation: none; width: 100%; } }
:global(:root[data-motion='reduce']) .kb-ev-wait-bar > i { animation: none; width: 100%; }

.kb-ev-fail { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-3); padding: var(--card-pad-ui); border-color: var(--status-danger); }
.kb-ev-fail-text { flex: 1 1 240px; min-width: 0; color: var(--status-danger-text); font-size: var(--text-13); overflow-wrap: anywhere; }

/* 四张指标卡:手机一列(每张带一句解释,两列会窄得读不下去) */
.kb-ev-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--gap); }
.kb-ev-metric { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.kb-ev-metric .v { margin-top: 0; }
/* 只是占位:和 .kb-ev-delta 一样高,但不带语义(测试也按「没有 .kb-ev-delta」判断没在比) */
.kb-ev-delta-slot { min-height: 1.33em; }
.kb-ev-delta.is-up { color: var(--status-success-text); }
.kb-ev-delta.is-down { color: var(--status-danger-text); }
/* 说明文字是卡片的「脚注」:长短不一(2 行 / 3 行)时让上方的空隙吸收余量,
   四张卡的说明离底边一样远,而不是一行行的底边参差(卡高已经拉平,见 align-items:stretch) */
.kb-ev-help { margin-top: auto; overflow-wrap: anywhere; }
@media (max-width: 1099px) { .kb-ev-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 599px) { .kb-ev-metrics { grid-template-columns: minmax(0, 1fr); } }

.kb-ev-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--gap); }
/* 两栏是一组对照(图 + 表),底边必须齐平:之前用 align-items:start,两张卡各自按内容定高,
   同一行里就差出 4px 的台阶 */
@media (min-width: 1280px) { .kb-ev-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); align-items: stretch; } }
/* 带 overflow 的卡片放进纵向 flex 容器,WebKit 会把它压成 1px 高;不让它收缩 */
.kb-ev-chart, .kb-ev-history { flex: 0 0 auto; min-width: 0; }
.kb-ev-legend { display: flex; flex-wrap: wrap; gap: var(--sp-3); padding: 0 var(--card-pad-ui) var(--card-pad-ui); }
.kb-ev-table { padding: 0 var(--card-pad-ui) var(--sp-2); }
.kb-ev-cols { padding: var(--sp-2) var(--card-pad-ui) var(--card-pad-ui); font-size: var(--text-12); }
.kb-ev-cols summary { cursor: pointer; color: var(--text-secondary); min-height: 2em; display: flex; align-items: center; }
.kb-ev-cols ul { margin: var(--sp-2) 0 0; padding-left: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-1); color: var(--text-secondary); overflow-wrap: anywhere; }
.kb-ev-rank { flex: 0 0 auto; white-space: nowrap; }
/* 走势与名次分布:手机一列;宽屏两列(走势占宽的一列,耗时与名次并排) */
.kb-ev-insights { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--gap); }
.kb-ev-insights > * { min-width: 0; flex: 0 0 auto; }
.kb-ev-foot { margin: var(--sp-2) 0 0; font-size: var(--text-12); overflow-wrap: anywhere; }
.kb-ev-verdict { margin: 0 0 var(--sp-2); font-size: var(--text-13); color: var(--text-secondary); overflow-wrap: anywhere; }
.kb-ev-verdict.is-down { color: var(--status-danger-text); font-weight: 600; }
/* 宽屏两列:走势和耗时并排,名次分布占满一行;没有耗时记录时走势独占一行(is-wide),不留半边空白 */
@media (min-width: 840px) { .kb-ev-insights { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kb-ev-ranks, .kb-ev-trend.is-wide { grid-column: 1 / -1; } }
@media (pointer: coarse) { .kb-ev-cols summary { min-height: 44px; } }
</style>
