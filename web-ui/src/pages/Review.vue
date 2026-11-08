<script setup lang="ts">
import { localeDateTime } from '@/utils/time'
// 审核收件箱(收尾阶段):自动提炼出的候选经验在这里人工确认。
// 数据:list_drafts(状态过滤 + 各状态计数,分页);动作:review_draft(通过 / 修订通过 / 驳回 / 不再提炼)。
// 通过之后才转正成 insight —— 草稿本身从不进向量表。
//
// 版面(.4):一条草稿一张卡片,层次是 标题 → 摘要(折叠)→ AI 的意见 → 依据(折叠)→ 标签 → 操作;
// 主操作「通过」和次要操作分开,「驳回」类收进「⋯」菜单;待审的可以多选,批量通过 / 驳回。
import { computed, onMounted, ref, watch } from 'vue'
import AppShell from '@/layouts/AppShell.vue'
import { KbBadge, KbBatchBar, KbButton, KbDialog, KbEmpty, KbInput, KbPageHeader, KbSegmented, KbSelect, KbSkeleton, KbTagEditor, KbTextarea, isComposing, useConfirm, useToast } from '@kb-ui/index'
import { callCapability } from '@/api/client'
import DraftStatsCard from '@/components/review/DraftStatsCard.vue'
import { batchSummary, decisionText, isActionable, isLongBody, kindText, remaining, scoreText, scoreTone, stateText, stateTone } from '@/utils/review'
import { relativeTime } from '@/utils/share'
import { useFeature } from '@/composables/useFeature'
import { NO_ACCESS_TEXT } from '@/utils/loadState'

interface DraftItem {
  id: string
  collection: string
  project: string | null
  title: string
  body_md: string
  kind: string
  tags: string[]
  related_paths: string[]
  evidence: string[]
  state: 'pending' | 'approved' | 'revised' | 'rejected' | 'duplicate'
  score: number | null
  decision: string | null
  reasons: string[]
  duplicate_of: string | null
  insight_id: string | null
  created_at: number
  decided_at: number | null
}

interface InboxPage {
  drafts: DraftItem[]
  total: number
  counts: { pending: number; approved: number; rejected: number; duplicate: number }
}

const PAGE_SIZE = 20
const toast = useToast()

const state = ref('pending')
const items = ref<DraftItem[]>([])
/** 该状态下的总数(可能比已显示的多) */
const total = ref(0)
const page = ref(1)
const counts = ref<InboxPage['counts']>({ pending: 0, approved: 0, rejected: 0, duplicate: 0 })
const loading = ref(true)
const loadingMore = ref(false)
const error = ref('')
/**
 * 这个账号用不了审核(没有 ai.extract:AI 总开关关了,或角色没勾「自动提炼与审核」)。
 * 入口在侧栏里本来就被藏起来了,但书签、通知、命令面板里的旧链接还能直接打开这一页;
 * 此时整页显示「没有开通」,不请求、不渲染候选草稿(草稿卡片里有「AI 评分」字样,AI 关闭后不该出现)。
 */
const allowed = useFeature('ai.extract')
/** 服务端对列表请求返回了 403:功能点在页面打开期间被收回(会话里的功能列表每 20 秒才刷新一次) */
const denied = ref(false)
const locked = computed(() => !allowed.value || denied.value)
/** 正在处理的草稿(单条操作中,按钮置灰防重复点) */
const busy = ref('')
const batchBusy = ref(false)
const selected = ref<string[]>([])
/** 展开了全文 / 依据的草稿 */
const openBody = ref<Set<string>>(new Set())

/** 状态页签(计数来自后端,前端不自己算) */
const tabs = computed(() => [
  { label: `待审 ${counts.value.pending}`, value: 'pending' },
  { label: `已通过 ${counts.value.approved}`, value: 'approved' },
  { label: `已驳回 ${counts.value.rejected}`, value: 'rejected' },
  { label: `重复 ${counts.value.duplicate}`, value: 'duplicate' },
])

const actionable = computed(() => items.value.filter((item) => isActionable(item.state)))
const hiddenCount = computed(() => remaining(total.value, items.value.length))
const allChecked = computed(() => actionable.value.length > 0 && actionable.value.every((item) => selected.value.includes(item.id)))

function applyPage(result: InboxPage, append: boolean) {
  const drafts = result.drafts ?? []
  items.value = append ? [...items.value, ...drafts.filter((draft) => !items.value.some((item) => item.id === draft.id))] : drafts
  total.value = result.total ?? items.value.length
  counts.value = result.counts ?? counts.value
}

async function refresh() {
  if (!allowed.value) return
  loading.value = true
  page.value = 1
  try {
    applyPage(await callCapability<InboxPage>('list_drafts', { state: state.value, page: 1, page_size: PAGE_SIZE }), false)
    error.value = ''
  } catch (err) {
    items.value = []
    total.value = 0
    // 403 不显示服务端的原话:AI 总开关关着时它说的是「AI 功能已关闭」,关闭后界面上不能出现 AI 字样;
    // 重试也不会变,所以走「没有开通」而不是带「重新加载」的报错
    if ((err as { status?: number })?.status === 403) {
      denied.value = true
      error.value = ''
    } else {
      error.value = err instanceof Error && /[\u4e00-\u9fff]/.test(err.message) ? err.message : '读取收件箱失败。检查网络后重试。'
    }
  } finally {
    loading.value = false
    // 刷新后只留下仍在列表里的选中项
    selected.value = selected.value.filter((id) => items.value.some((item) => item.id === id && isActionable(item.state)))
  }
}

async function loadMore() {
  if (loadingMore.value) return
  loadingMore.value = true
  try {
    applyPage(await callCapability<InboxPage>('list_drafts', { state: state.value, page: page.value + 1, page_size: PAGE_SIZE }), true)
    page.value += 1
  } catch (err) {
    toast.push(err instanceof Error ? err.message : '没能加载更多,请再试一次', 'danger')
  } finally {
    loadingMore.value = false
  }
}

async function switchState(value: string) {
  state.value = value
  selected.value = []
  await refresh()
}

// ===== 单条操作 =====
async function approve(item: DraftItem) {
  busy.value = item.id
  try {
    await callCapability('review_draft', { id: item.id, decision: 'approve' })
    toast.push(`已转正:${item.title}`, 'success')
    await refresh()
  } catch (err) {
    toast.push(err instanceof Error ? err.message : '通过失败,请稍后再试', 'danger')
  } finally {
    busy.value = ''
  }
}

async function reject(item: DraftItem, neverExtract: boolean) {
  const ok = await useConfirm().ask({
    title: neverExtract ? `驳回「${item.title}」并不再提炼?` : `驳回「${item.title}」?`,
    message: neverExtract
      ? '这条的指纹与向量会被记住:以后同样的候选不会再进收件箱,正文也会被清空。'
      : '驳回之后不会转正;同样的候选再次出现时会标成重复,不再调审核模型。',
    confirmText: neverExtract ? '驳回并不再提炼' : '驳回',
    tone: 'danger',
    doneText: '已驳回',
    action: () => callCapability('review_draft', { id: item.id, decision: 'reject', never_extract: neverExtract }),
  })
  if (ok) await refresh()
}

/** 「⋯」菜单:驳回类操作收在这里,不和「通过」并排(误点驳回代价更大) */
const moreOptions = [
  { value: 'reject', label: '驳回' },
  { value: 'never', label: '驳回并不再提炼' },
]
function onMore(item: DraftItem, value: string | number) {
  void reject(item, value === 'never')
}

// ===== 批量 =====
function toggle(id: string) {
  selected.value = selected.value.includes(id) ? selected.value.filter((entry) => entry !== id) : [...selected.value, id]
}
function toggleAll() {
  selected.value = allChecked.value ? [] : actionable.value.map((item) => item.id)
}

/** 逐条处理:每条各自成败,不因为一条失败放弃后面的;结果如实汇总(成功几条、失败几条、第一个原因) */
async function runBatch(verb: '通过' | '驳回', ids: string[]) {
  let done = 0
  let failed = 0
  let firstError = ''
  for (const id of ids) {
    try {
      await callCapability('review_draft', verb === '通过' ? { id, decision: 'approve' } : { id, decision: 'reject', never_extract: false })
      done += 1
    } catch (err) {
      failed += 1
      if (!firstError) firstError = err instanceof Error ? err.message : '未知错误'
    }
  }
  return { done, failed, firstError }
}

async function approveSelected() {
  const ids = [...selected.value]
  if (!ids.length || batchBusy.value) return
  batchBusy.value = true
  try {
    const result = await runBatch('通过', ids)
    const summary = batchSummary('通过', result.done, result.failed, result.firstError)
    toast.push(summary.text, summary.tone)
    selected.value = []
    await refresh()
  } finally {
    batchBusy.value = false
  }
}

async function rejectSelected() {
  const ids = [...selected.value]
  if (!ids.length || batchBusy.value) return
  let result = { done: 0, failed: 0, firstError: '' }
  const ok = await useConfirm().ask({
    title: `驳回选中的 ${ids.length} 条候选笔记?`,
    message: '驳回之后不会转正;同样的候选再次出现时会标成重复,不再调审核模型。需要「不再提炼」的请单独驳回。',
    confirmText: `驳回 ${ids.length} 条`,
    tone: 'danger',
    doneText: '已处理',
    action: async () => {
      batchBusy.value = true
      try {
        result = await runBatch('驳回', ids)
      } finally {
        batchBusy.value = false
      }
    },
  })
  if (!ok) return
  const summary = batchSummary('驳回', result.done, result.failed, result.firstError)
  toast.push(summary.text, summary.tone)
  selected.value = []
  await refresh()
}

// ===== 修订后通过(标题 / 正文 / 标签可改) =====
const editing = ref<DraftItem | null>(null)
const editTitle = ref('')
const editBody = ref('')
const editTags = ref<string[]>([])
const editBusy = ref(false)

function openEdit(item: DraftItem) {
  editing.value = item
  editTitle.value = item.title
  editBody.value = item.body_md
  editTags.value = [...item.tags]
}

async function saveEdit() {
  const item = editing.value
  if (!item) return
  if (!editTitle.value.trim() || !editBody.value.trim()) {
    toast.push('标题与正文都不能为空', 'danger')
    return
  }
  editBusy.value = true
  try {
    await callCapability('review_draft', {
      id: item.id,
      decision: 'approve',
      title: editTitle.value.trim(),
      body_md: editBody.value.trim(),
      tags: editTags.value,
    })
    toast.push('已按你的版本转正', 'success')
    editing.value = null
    await refresh()
  } catch (err) {
    toast.push(err instanceof Error ? err.message : '保存失败,请稍后再试', 'danger')
  } finally {
    editBusy.value = false
  }
}

/** 标题框里按 Enter 就提交(正文是多行,标签框的 Enter 是加标签,所以只有标题这一格这样);中文输入法选词时的回车不算 */
function onTitleEnter(event: KeyboardEvent) {
  if (isComposing(event) || editBusy.value) return
  void saveEdit()
}

function toggleBody(id: string) {
  const next = new Set(openBody.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openBody.value = next
}

onMounted(() => void refresh())
// 会话里的功能列表比页面晚到(或之后又被管理员改回来)时,补一次读取
watch(allowed, (value) => {
  if (value) {
    denied.value = false
    void refresh()
  }
})
</script>

<template>
  <AppShell>
    <div class="kb-rv" data-testid="review">
      <KbPageHeader title="审核收件箱" description="自动提炼出的候选笔记在这里人工确认;通过之后才能被搜索到" />

      <KbEmpty v-if="locked" icon="lock" title="你的账号没有开通这个功能" :description="NO_ACCESS_TEXT" data-testid="review-off" />

      <template v-else>
        <DraftStatsCard class="kb-rv-stats" :counts="counts" :loading="loading" />
        <div class="kb-rv-bar kb-sticky">
          <KbSegmented :model-value="state" :options="tabs" @update:model-value="switchState" />
          <label v-if="actionable.length" class="kb-rv-all">
            <input type="checkbox" :checked="allChecked" data-testid="review-all" @change="toggleAll" />
            <span>全选本页 {{ actionable.length }} 条</span>
          </label>
          <!-- 刷新的是下面的列表,放在列表的控件行里;以前放在页头的操作区,手机上被拉成一整行宽的大按钮 -->
          <!-- 和左边的分段控件同一行:用默认尺寸(28),不要 sm(22),否则这一行两个控件差 6px(视觉基线规范) -->
          <KbButton class="kb-rv-refresh" :disabled="loading" data-testid="review-refresh" @click="refresh">刷新</KbButton>
        </div>

        <KbEmpty v-if="error" icon="failed" title="没能读取收件箱" :description="error" data-testid="review-error">
          <template #action><KbButton variant="primary" @click="refresh">重新加载</KbButton></template>
        </KbEmpty>

        <div v-else-if="loading" class="kb-rv-list" data-testid="review-loading">
          <div v-for="index in 2" :key="index" class="card kb-rv-card"><KbSkeleton variant="lines" :lines="4" /></div>
        </div>

        <div v-else-if="!items.length" class="card kb-rv-pad">
          <KbEmpty
            icon="inbox"
            :title="state === 'pending' ? '没有待审的候选笔记' : `没有${stateText(state)}的候选笔记`"
            :description="state === 'pending' ? '自动提炼出的候选笔记会先进入这里,由 AI 评分与人工确认后才会转正' : '切到「待审」看看有没有新候选'"
            data-testid="review-empty"
          />
        </div>

        <ul v-else class="kb-rv-list" role="list">
          <li v-for="item in items" :key="item.id" class="card kb-rv-card" :class="{ 'is-selected': selected.includes(item.id) }" data-testid="draft-card" :data-id="item.id">
            <header class="kb-rv-head">
              <!-- 勾选框本体是原生尺寸(13px);外面包一层 label,触屏上这层撑到 44px 见方(点 label 任意处都等于点勾选框) -->
            <label v-if="isActionable(item.state)" class="kb-rv-checkhit">
              <input type="checkbox" class="kb-rv-check" :checked="selected.includes(item.id)" :aria-label="`选择候选笔记:${item.title}`" data-testid="draft-check" @change="toggle(item.id)" />
            </label>
              <h3 class="kb-rv-title">{{ item.title }}</h3>
              <KbBadge class="kb-rv-state" :tone="stateTone(item.state)">{{ stateText(item.state) }}</KbBadge>
            </header>

            <div class="kb-rv-meta">
              <KbBadge tone="neutral">{{ kindText(item.kind) }}</KbBadge>
              <span class="m">{{ item.project ?? item.collection }}</span>
              <span class="m" :title="localeDateTime(item.created_at, { hour12: false })">{{ relativeTime(item.created_at) }}</span>
            </div>

            <p class="kb-rv-body" :class="{ 'is-clamped': isLongBody(item.body_md) && !openBody.has(item.id) }">{{ item.body_md || '(正文已清空)' }}</p>
            <button v-if="isLongBody(item.body_md)" type="button" class="kb-rv-link" :aria-expanded="openBody.has(item.id)" data-testid="draft-expand" @click="toggleBody(item.id)">
              {{ openBody.has(item.id) ? '收起' : '展开全文' }}
            </button>

            <div class="kb-rv-ai" data-testid="draft-ai">
              <KbBadge :tone="scoreTone(item.score)">{{ scoreText(item.score) }}</KbBadge>
              <span v-if="decisionText(item.decision)" class="kb-rv-decision">{{ decisionText(item.decision) }}</span>
              <ul v-if="item.reasons.length" class="kb-rv-reasons" role="list">
                <li v-for="reason in item.reasons" :key="reason" class="m">{{ reason }}</li>
              </ul>
            </div>

            <details v-if="item.evidence.length" class="kb-rv-evidence" data-testid="draft-evidence">
              <summary>依据 · {{ item.evidence.length }} 处</summary>
              <blockquote v-for="(line, index) in item.evidence" :key="index">{{ line }}</blockquote>
            </details>

            <div v-if="item.tags.length || item.related_paths.length || item.duplicate_of" class="kb-rv-tags">
              <KbBadge v-for="tag in item.tags" :key="tag" tone="accent">{{ tag }}</KbBadge>
              <span v-for="path in item.related_paths" :key="path" class="mono m kb-rv-path">{{ path }}</span>
              <span v-if="item.duplicate_of" class="m">与 {{ item.duplicate_of }} 重复</span>
            </div>

            <footer v-if="isActionable(item.state)" class="kb-rv-actions">
              <KbButton variant="primary" :disabled="busy === item.id || batchBusy" data-testid="draft-approve" @click="approve(item)">通过</KbButton>
              <KbButton :disabled="busy === item.id || batchBusy" data-testid="draft-revise" @click="openEdit(item)">修订后通过</KbButton>
              <KbSelect model-value="" :options="moreOptions" display="⋯" :caret="false" align="end" aria-label="更多操作" data-testid="draft-more" @update:model-value="onMore(item, $event)" />
            </footer>
            <footer v-else class="kb-rv-actions">
              <span class="m">{{ item.insight_id ? `已转正为 ${item.insight_id}` : '这条不会再转正' }}</span>
            </footer>
          </li>
        </ul>

        <div v-if="!loading && !error && hiddenCount > 0" class="kb-rv-more" data-testid="review-more">
          <span class="m">还有 {{ hiddenCount }} 条没显示</span>
          <KbButton :disabled="loadingMore" @click="loadMore">{{ loadingMore ? '加载中…' : '加载更多' }}</KbButton>
        </div>

        <KbBatchBar :count="selected.length" :total="actionable.length" @clear="selected = []" @all="toggleAll">
          <KbButton size="sm" variant="primary" :disabled="batchBusy" data-testid="batch-approve" @click="approveSelected">通过 {{ selected.length }} 条</KbButton>
          <KbButton size="sm" variant="danger" :disabled="batchBusy" data-testid="batch-reject" @click="rejectSelected">驳回</KbButton>
        </KbBatchBar>
      </template>
    </div>

    <KbDialog v-if="editing" title="修订后通过" width="640px" @close="editing = null">
      <div class="kb-form">
        <label>标题</label>
        <KbInput v-model="editTitle" @keydown.enter="onTitleEnter" />
        <label>正文</label>
        <KbTextarea v-model="editBody" :rows="10" />
        <label>标签</label>
        <KbTagEditor v-model="editTags" />
      </div>
      <template #footer>
        <KbButton size="sm" @click="editing = null">取消</KbButton>
        <KbButton size="sm" variant="primary" :disabled="editBusy" @click="saveEdit">
          {{ editBusy ? '保存中…' : '按此版本转正' }}
        </KbButton>
      </template>
    </KbDialog>
  </AppShell>
</template>

<style scoped>
.kb-rv { display: flex; flex-direction: column; gap: var(--gap); width: 100%; max-width: 1000px; margin: 0 auto; min-width: 0; }
.kb-rv-bar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-3); min-width: 0; }
.kb-rv-all { display: inline-flex; align-items: center; gap: var(--sp-2); margin-left: auto; font-size: var(--text-13); color: var(--text-secondary); }
.kb-rv-all + .kb-rv-refresh { margin-left: 0; }
.kb-rv-pad { padding: var(--gap-xl) var(--card-pad-ui); }
.kb-rv-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--gap); }
.kb-rv-card { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--card-pad-ui); min-width: 0; }
/* 选中:描一圈强调色边(不只靠颜色,卡片左上角的勾选框也是选中的),--accent-ring 是整条 box-shadow */
.kb-rv-card.is-selected { box-shadow: var(--accent-ring); }
.kb-rv-head { display: flex; align-items: flex-start; gap: var(--sp-3); min-width: 0; }
.kb-rv-checkhit { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; margin-top: var(--sp-1); }
.kb-rv-check { margin: 0; flex: 0 0 auto; }
/* 标题长时徽标不能被挤成竖排的两行 */
.kb-rv-state { flex: 0 0 auto; white-space: nowrap; }
.kb-rv-title { flex: 1 1 auto; margin: 0; font-size: var(--text-16); font-weight: var(--fw-title); line-height: var(--lh-tight); overflow-wrap: anywhere; min-width: 0; }
.kb-rv-meta { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); font-size: var(--text-12); }
.kb-rv-body { margin: 0; max-width: 72ch; color: var(--text-secondary); line-height: var(--lh-loose); white-space: pre-wrap; overflow-wrap: anywhere; }
/* 折叠:只留几行,免得一张卡片把整屏占满 */
.kb-rv-body.is-clamped { display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.kb-rv-link { align-self: flex-start; padding: 0; border: 0; background: none; color: var(--accent-text); font-size: var(--text-13); cursor: pointer; min-height: 2em; }
.kb-rv-ai { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); padding: var(--sp-2) var(--sp-3); border-radius: var(--r2); background: var(--surface-2); min-width: 0; }
.kb-rv-decision { font-size: var(--text-13); font-weight: var(--fw-medium); }
.kb-rv-reasons { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--text-12); }
.kb-rv-reasons li::before { content: '· '; }
.kb-rv-evidence summary { cursor: pointer; font-size: var(--text-13); color: var(--text-secondary); min-height: 2em; display: flex; align-items: center; }
/* 触屏上折叠开关和「⋯」都要有 44px 见方的可点区域(按输入方式判断,不按屏宽) */
@media (pointer: coarse) {
  .kb-rv-evidence summary, .kb-rv-link { min-height: 44px; }
  /* 勾选框的可点区域 44×44;负外边距把多出来的 11px 吃掉,卡片头部的版面和以前一样(右边是 12px 的间距) */
  .kb-rv-checkhit { width: 44px; height: 44px; margin: -11px; }
  .kb-rv-all { min-height: 44px; }
  .kb-rv-actions :deep(.kb-select .btn) { min-width: 44px; }
}
.kb-rv-evidence blockquote { margin: var(--sp-2) 0 0; padding: var(--sp-2) var(--sp-3); border-left: 2px solid var(--border-strong); color: var(--text-tertiary); font-family: var(--mono); font-size: var(--text-12); white-space: pre-wrap; overflow-wrap: anywhere; }
.kb-rv-tags { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
.kb-rv-path { font-size: var(--text-12); overflow-wrap: anywhere; }
.kb-rv-actions { display: flex; align-items: center; gap: var(--sp-2); padding-top: var(--sp-1); }
.kb-rv-more { display: flex; align-items: center; justify-content: center; gap: var(--sp-3); padding: var(--sp-2) 0; }
/* 手机:「通过」和「修订后通过」各占一半,「⋯」留一个手指宽;按钮整行排满好点 */
@media (max-width: 599px) {
  /* 手机上「审核结果」图表卡排到列表后面:它有三百多像素高,放在最上面会把第一张草稿的「通过」按钮挤出第一屏(设计规范:
     第一屏能看到第一张卡片的操作按钮)。审核这页的主要事情是处理草稿,统计是次要的 */
  .kb-rv-stats { order: 9; }
  .kb-rv-actions > :not(.kb-select) { flex: 1 1 0; }
  /* 卡片里每个块(标题 / 元信息 / 正文 / AI 评分 / 依据 / 标签 / 路径 / 按钮)之间 12px,八个块就是近 100px 的空隙,手机上收到 8px */
  .kb-rv-card { gap: var(--sp-2); }
  /* 全选和刷新同一行:全选靠左占剩余宽度,刷新靠右 */
  .kb-rv-all { margin-left: 0; flex: 1 1 auto; }
  .kb-rv-refresh { flex: none; }
}
</style>
