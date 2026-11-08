<script setup lang="ts">
// 任务详情里的文件清单:桌面详情卡、手机弹层、表格「详情」列的对话框共用这一份。
//
// 三种数据来源,按优先级:
// 1. 逐文件记录(job_files):每个文件的变化、写入块数,失败的行还能展开看原因;
// 2. 老任务(逐文件记录上线前跑完的)只有任务参数里的路径,摘要最多 10 条,要写明;
// 3. 经验笔记任务没有文件,给笔记入口。
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { KbBadge, KbButton } from '@kb-ui/index'
import { PATHS } from '@/router/paths'
import type { FileChange, JobFileRow } from '@/api/jobs'
import { fileChangeText, fileChangeTone, jobFileCountsText, jobFileSummary } from '@/utils/jobView'
import { clockText, isToday, stampText } from '@/utils/time'

const props = withDefaults(
  defineProps<{
    /** 任务 id:换任务时收起所有展开行 */
    jobId: string
    /** 逐文件记录;空数组时退到 fallbackPaths / insightId */
    files: JobFileRow[]
    /** 这个任务一共处理了多少个文件(不是已加载的条数) */
    total?: number
    counts?: Partial<Record<FileChange, number>>
    /** 老任务的任务参数清单(摘要模式最多 10 条) */
    fallbackPaths?: string[]
    /** 经验笔记任务的目标笔记 id */
    insightId?: string | null
    collection?: string | null
    /** 正在读清单(首次或翻下一页) */
    loading?: boolean
    /** 清单读取失败:给一句提示,不要冒充「老任务」 */
    failed?: boolean
  }>(),
  {
    total: 0,
    counts: () => ({}),
    fallbackPaths: () => [],
    insightId: null,
    collection: null,
    loading: false,
    failed: false,
  },
)
const emit = defineEmits<{ more: [] }>()

/** 展开的行按路径记:点「详情」才出现块数明细和错误全文,清单本身保持一行一个文件 */
const expanded = ref(new Set<string>())
watch(
  () => props.jobId,
  () => {
    expanded.value = new Set()
  },
)
function toggle(path: string) {
  const next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expanded.value = next
}

const shown = computed(() => Math.max(props.total, props.files.length))
const countsText = computed(() => jobFileCountsText(props.counts))
const remaining = computed(() => Math.max(0, props.total - props.files.length))
/** 每页 200 条(和后端 page_size 上限一致),一次加载不完就再拉一页 */
const moreText = computed(() => `再显示 ${Math.min(200, remaining.value)} 个`)

function openAt(file: string) {
  return { path: PATHS.kb, query: { collection: props.collection ?? undefined, path: file } }
}
function insightAt(id: string) {
  return { path: PATHS.kb, query: { collection: props.collection ?? undefined, item: id } }
}
function doneText(at: number): string {
  if (!at) return '—'
  return isToday(at) ? clockText(at) : stampText(at)
}
</script>

<template>
  <div v-if="shown" class="kb-job-files-section" data-testid="job-files-section">
    <div class="kb-job-files-title">
      <b>改动的文件 ({{ shown }} 个)</b>
      <span class="m kb-light">点文件名在知识库中打开,点「详情」看块数与错误</span>
    </div>
    <p v-if="countsText" class="m kb-light kb-job-files-counts" data-testid="job-files-counts">{{ countsText }}</p>
    <ul class="kb-job-files-list" data-testid="job-files-changed">
      <li v-for="file in files" :key="file.path" class="kb-job-file" :data-change="file.change">
        <div class="kb-job-file-head">
          <KbBadge :tone="fileChangeTone(file.change)">{{ fileChangeText(file.change) }}</KbBadge>
          <RouterLink :to="openAt(file.path)" target="_blank" class="kb-file-link mono kb-job-file-path" :title="`在知识库中打开 ${file.path}`">
            {{ file.path }}
          </RouterLink>
          <span class="m kb-light kb-job-file-nums">{{ jobFileSummary(file) }}</span>
          <button type="button" class="kb-job-file-toggle" :aria-expanded="expanded.has(file.path)" @click="toggle(file.path)">
            {{ expanded.has(file.path) ? '收起' : '详情' }}
          </button>
        </div>
        <div v-if="expanded.has(file.path)" class="kb-job-file-detail" data-testid="job-file-detail">
          <span>写入 <b class="mono">{{ file.chunks }}</b> 块</span>
          <span>元数据 <b class="mono">{{ file.meta_chunks }}</b> 块</span>
          <span>删除 <b class="mono">{{ file.deleted_chunks }}</b> 块</span>
          <span>处理于 <b class="mono">{{ doneText(file.done_at) }}</b></span>
          <p v-if="file.error" class="kb-job-file-error" data-testid="job-file-error">{{ file.error }}</p>
        </div>
      </li>
    </ul>
    <div v-if="remaining > 0" class="kb-job-files-more">
      <KbButton size="sm" :disabled="loading" @click="emit('more')">{{ moreText }}</KbButton>
      <span class="m kb-light">已显示 {{ files.length }} / {{ total }}</span>
    </div>
    <p v-else-if="loading" class="m kb-light">正在读取文件清单…</p>
  </div>

  <!-- 清单没读出来:给提示,不要退成「老任务」的清单误导人 -->
  <p v-else-if="failed" class="m kb-light" data-testid="job-files-failed">没能读取这个任务的逐文件记录,稍后会自动重试。</p>

  <!-- 老任务:逐文件记录上线前跑完的,只有任务参数里的路径,而且摘要只留前 10 条 -->
  <div v-else-if="fallbackPaths.length" class="kb-job-files-section" data-testid="job-files-section">
    <div class="kb-job-files-title">
      <b>涉及的文件 ({{ fallbackPaths.length }} 个)</b>
      <span class="m kb-light">点击在知识库中打开</span>
    </div>
    <p class="m kb-light kb-job-files-note">这个任务没有逐文件记录(旧版本跑完的),这里只是任务参数里的文件清单,最多 10 个。</p>
    <ul class="code mono kb-job-files-list">
      <li v-for="file in fallbackPaths" :key="file" class="kb-job-file-fallback">
        <RouterLink :to="openAt(file)" target="_blank" class="kb-file-link" :title="`在知识库中打开 ${file}`">{{ file }}</RouterLink>
      </li>
    </ul>
  </div>

  <div v-else-if="insightId" class="kb-job-files-section" data-testid="job-insight-section">
    <div class="kb-job-files-title">
      <b>涉及的经验笔记</b>
    </div>
    <RouterLink :to="insightAt(insightId)" target="_blank" class="kb-file-link">经验笔记 · {{ insightId }}</RouterLink>
  </div>
</template>

<style scoped>
.kb-job-files-section {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
}
.kb-job-files-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.kb-job-files-counts {
  margin: 0;
}
.kb-job-files-note {
  margin: 0;
}
.kb-job-files-list {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  list-style: none;
  max-height: 18em;
  overflow-y: auto;
  border-radius: var(--r2);
  background: var(--bg-surface-2, rgba(0, 0, 0, 0.04));
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.kb-job-file {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}
.kb-job-file-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
/* 路径占中间,太长就省略(完整路径在 title 和点击打开的页面里) */
.kb-job-file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-job-file-nums {
  white-space: nowrap;
}
.kb-job-file-toggle {
  border: 0;
  background: none;
  padding: 0;
  color: var(--accent-text);
  cursor: pointer;
  font: inherit;
  white-space: nowrap;
}
.kb-job-file-toggle:hover {
  text-decoration: underline;
}
.kb-job-file-detail {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r2);
  background: var(--bg-surface-2, rgba(0, 0, 0, 0.04));
  font-size: var(--fs-sm, 0.875rem);
}
.kb-job-file-error {
  flex-basis: 100%;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--danger-text, #b42318);
  white-space: pre-wrap;
}
.kb-job-file-fallback {
  overflow-wrap: anywhere;
}
.kb-job-files-more {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
</style>
