<script setup lang="ts">
import { localeDateTime } from '@/utils/time'
// 批次(管理组「审计 / 批次」的一页,功能点 sys.ops):每次写操作记成一个批次,可以整批撤销。
// 撤销是危险操作:确认框写明哪些会恢复、跳过的是什么、撤销后不能再来;结果如实说「恢复了几项、跳过了几项」。
import { onMounted, ref, watch } from 'vue'
import { KbBadge, KbButton, KbEmpty, KbPager, useConfirm, useToast } from '@kb-ui/index'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import { callCapability, type BatchView } from '@/api/client'
import { actorText, batchTitle } from '@/utils/auditText'
import { friendly, failureOf, type LoadPhase } from '@/utils/loadState'

const toast = useToast()
const confirm = useConfirm()
const phase = ref<LoadPhase>('loading')
const message = ref('')
const batches = ref<BatchView[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const stale = ref(false)

async function load() {
  if (!batches.value.length) phase.value = 'loading'
  try {
    const reply = await callCapability<{ batches: BatchView[]; total: number }>('batch_list', { page: page.value, page_size: pageSize.value })
    batches.value = reply.batches
    total.value = reply.total
    stale.value = false
    phase.value = 'ready'
  } catch (err) {
    const failure = failureOf(err, '读取批次')
    if (batches.value.length && failure.phase === 'error') {
      stale.value = true
      return
    }
    batches.value = []
    phase.value = failure.phase
    message.value = failure.message
  }
}
onMounted(() => void load())
watch([page, pageSize], () => void load())

/** 状态:颜色之外都有文字 */
function stateOf(batch: BatchView): { text: string; tone: 'success' | 'warning' | 'neutral' } {
  if (batch.reverted_at) return { text: '已撤销', tone: 'warning' }
  if (!batch.changes.length) return { text: '只读', tone: 'neutral' }
  if (!batch.changes.some((change) => change.revertible)) return { text: '已提交', tone: 'success' }
  return { text: '可撤销', tone: 'success' }
}
const revertible = (batch: BatchView) => !batch.reverted_at && batch.changes.some((change) => change.revertible)
const when = (at: number) => localeDateTime(at, { hour12: false })

interface RevertReport {
  reverted: unknown[]
  skipped: { target?: string; reason?: string }[]
}

async function revert(batch: BatchView) {
  const count = batch.changes.filter((change) => change.revertible).length
  const title = batchTitle(batch.description)
  let report: RevertReport | null = null
  const ok = await confirm.ask({
    title: `撤销批次「${title}」?`,
    message:
      `${actorText(batch.actor)} 在 ${when(batch.created_at)} 做的这批操作里,有 ${count} 项改动会恢复到做之前的样子。` +
      '认不出怎么恢复的改动会被跳过,跳过的不会再恢复。撤销后这个批次不能再次撤销,也不能反悔。这个操作会记入审计。',
    confirmText: '撤销整批',
    cancelText: '先不撤销',
    tone: 'danger',
    doneText: '已撤销',
    action: () =>
      friendly(
        callCapability<RevertReport>('revert_batch', { batch_id: batch.id }).then((result) => {
          report = result
        }),
        '撤销批次',
      ),
  })
  if (!ok) return
  const done = report as RevertReport | null
  if (done) {
    const skipped = done.skipped.length
    const reason = done.skipped.find((item) => item.reason)?.reason
    toast.push(
      skipped ? `已恢复 ${done.reverted.length} 项,另有 ${skipped} 项无法恢复,已跳过${reason ? `(${reason})` : ''}。` : `已恢复 ${done.reverted.length} 项。`,
      skipped ? 'warning' : 'success',
    )
  }
  await load()
}
</script>

<template>
  <div class="kb-bp" data-testid="batch-panel">
    <AdminLoadState v-if="phase !== 'ready'" :phase="phase" :message="message" skeleton="lines" @retry="load()" />

    <template v-else>
      <div class="kb-bp-bar">
        <span class="kb-bp-title">批次</span>
        <span class="m kb-small">共 {{ total }} 个。每次写操作(新建、修改、删除、导入)记成一个批次,可以整批撤销。</span>
      </div>
      <p v-if="stale" class="m kb-small" role="status" data-testid="batch-stale">最近一次刷新没成功,下面显示的是之前的数据。<KbButton size="sm" @click="load()">重新读取</KbButton></p>

      <KbEmpty v-if="!batches.length" class="card" icon="database" title="还没有批次" description="每次写操作(新建、修改、删除、导入)都会记成一个批次,出现后可以整批撤销。" />

      <div v-else class="card kb-bp-card">
        <ul class="kb-bp-list">
          <li v-for="batch in batches" :key="batch.id" class="kb-bp-row" data-testid="batch-row">
            <div class="kb-bp-main">
              <div class="kb-bp-head">
                <KbBadge :tone="stateOf(batch).tone">{{ stateOf(batch).text }}</KbBadge>
                <b class="kb-bp-name" :title="batch.description">{{ batchTitle(batch.description) }}</b>
              </div>
              <small class="m">{{ actorText(batch.actor) }} · {{ when(batch.created_at) }} · <span class="mono" :title="'批次编号'">{{ batch.id }}</span></small>
            </div>
            <KbButton v-if="revertible(batch)" size="sm" variant="danger" :aria-label="`撤销批次「${batchTitle(batch.description)}」`" data-testid="batch-revert" @click="revert(batch)">撤销整批</KbButton>
          </li>
        </ul>
        <KbPager v-model:page="page" v-model:page-size="pageSize" :total="total" :sizes="[20, 50, 100]" />
      </div>
    </template>
  </div>
</template>

<style>
.kb-bp{display:flex;flex-direction:column;gap:var(--gap-md,12px);min-width:0}
.kb-bp-bar{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--gap-xs,4px) var(--gap-md,12px)}
.kb-bp-title{font-weight:600}
.kb-bp-card{flex:0 0 auto;padding:0;overflow:hidden}
.kb-bp-list{list-style:none;margin:0;padding:0}
.kb-bp-row{display:flex;align-items:center;justify-content:space-between;gap:var(--gap-md,12px);padding:var(--gap-sm,8px) var(--card-pad-x,16px);min-height:56px;border-bottom:var(--hl) solid var(--b)}
.kb-bp-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.kb-bp-head{display:flex;align-items:center;gap:var(--gap-sm,8px);min-width:0}
.kb-bp-head .kb-badge{flex:0 0 auto;white-space:nowrap}
.kb-bp-name{min-width:0;overflow-wrap:anywhere}
.kb-bp-row .kb-btn{flex:0 0 auto;white-space:nowrap}
@media (max-width:599px){.kb-bp-row{flex-wrap:wrap}.kb-bp-row .kb-btn{margin-left:auto}}
@media (pointer:coarse){.kb-bp-row .kb-btn{min-width:44px}}
</style>
