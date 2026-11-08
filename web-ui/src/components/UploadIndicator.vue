<script setup lang="ts">
// 后台上传:页脚中间的「上传 7 / 23」小胶囊 + 点开的逐文件浮层。
// 上传在 pinia store 里跑,切换页面不中断;新的上传开始时浮层自动展开,点 × 收起(胶囊还在)。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { KbIcon } from '@kb-ui/index'

import { useUploadStore, type UploadItem } from '@/stores/upload'
import { fileChip, formatSize } from '@/utils/files'
import { PATHS } from '@/router/paths'

const uploads = useUploadStore()
const open = ref(false)

const visible = computed(() => uploads.items.length > 0)
const doneCount = computed(() => uploads.items.filter((item) => item.state === 'done' || item.state === 'skipped').length)
const percent = computed(() => uploads.summary.percent)

const totalBytes = computed(() => uploads.totalBytes)
const sentBytes = computed(() => uploads.sentBytes)

/** 剩余时间:按平滑后的速度估算;速度还没测出来(刚开始 / 在校验)不给数,宁可不显示也不乱猜 */
function etaText(remaining: number, bytesPerSecond: number): string {
  if (bytesPerSecond <= 0 || remaining <= 0) return ''
  const seconds = Math.ceil(remaining / bytesPerSecond)
  if (seconds < 5) return '马上完成'
  if (seconds < 60) return `剩余约 ${seconds} 秒`
  if (seconds < 3600) return `剩余约 ${Math.ceil(seconds / 60)} 分钟`
  return `剩余约 ${Math.floor(seconds / 3600)} 小时 ${Math.ceil((seconds % 3600) / 60)} 分钟`
}

/** 现在大家在干什么:有文件在传字节就是「上传中」;都在算指纹 / 等合并时也要说清,而不是停在 0% */
const PHASE_TEXT = { hashing: '校验文件', checking: '检查重复', sending: '上传中', merging: '合并校验' } as const
const headline = computed(() => {
  const running = uploads.items.filter((item) => item.state === 'uploading')
  if (!running.length) return uploads.hasActive ? (uploads.paused ? '已暂停' : '排队中') : '上传完成'
  if (running.some((item) => item.phase === 'sending')) return PHASE_TEXT.sending
  return PHASE_TEXT[running[0]?.phase ?? 'sending']
})

/** 速度:每秒取一次已传字节的增量,做指数平滑;没有在传就不显示 */
const speed = ref(0)
let lastSent = 0
let timer = 0
watch(
  () => uploads.hasActive,
  (active) => {
    window.clearInterval(timer)
    if (!active) {
      speed.value = 0
      return
    }
    lastSent = sentBytes.value
    timer = window.setInterval(() => {
      const delta = Math.max(0, sentBytes.value - lastSent)
      lastSent = sentBytes.value
      speed.value = speed.value ? speed.value * 0.6 + delta * 0.4 : delta
    }, 1000)
  },
  { immediate: true },
)
onBeforeUnmount(() => window.clearInterval(timer))

// 一批新上传开始(从没有在传变成有在传)就展开浮层
watch(
  () => uploads.hasActive,
  (active, before) => {
    if (active && !before) open.value = true
  },
)

const note = computed(() => {
  const bytes = `${formatSize(sentBytes.value)} / ${formatSize(totalBytes.value)}`
  return speed.value > 0 ? `${bytes} · ${formatSize(speed.value)}/s` : bytes
})
/** 面板里的概况:已传 / 总量 · 速度 · 剩余时间 */
const detail = computed(() => {
  const parts = [`${formatSize(sentBytes.value)} / ${formatSize(totalBytes.value)}`]
  if (speed.value > 0) parts.push(`${formatSize(speed.value)}/s`)
  const eta = uploads.hasActive ? etaText(totalBytes.value - sentBytes.value, speed.value) : ''
  if (eta) parts.push(eta)
  return parts.join(' · ')
})
/** 没有字节在动的阶段(算指纹、等服务端合并):进度条用来回滑动的条纹,表示「在忙」而不是「卡住了」 */
const busy = computed(() => {
  const running = uploads.items.filter((item) => item.state === 'uploading')
  return running.length > 0 && running.every((item) => item.phase !== 'sending')
})

const RANK: Record<UploadItem['state'], number> = { uploading: 0, failed: 1, waiting: 2, done: 3, skipped: 4 }
const MAX_ROWS = 40
// 文件不多时保持入队顺序;太多时把正在传 / 失败的排前面,已完成的沉到后面
const rows = computed(() =>
  (uploads.items.length <= MAX_ROWS ? uploads.items : [...uploads.items].sort((left, right) => RANK[left.state] - RANK[right.state]))
    .slice(0, MAX_ROWS)
    .map((item) => ({
      item,
      chip: fileChip(item.name),
      text:
        item.state === 'uploading'
          ? item.phase === 'sending' || !item.phase
            ? `${Math.round(item.percent)}%`
            : PHASE_TEXT[item.phase]
          : item.state === 'done'
            ? '完成'
            : item.state === 'skipped'
              ? '跳过'
              : item.state === 'failed'
                ? '失败'
                : '排队',
    })),
)
const hidden = computed(() => Math.max(0, uploads.items.length - MAX_ROWS))
</script>

<template>
  <template v-if="visible">
    <button type="button" class="upi" :aria-expanded="open" aria-label="后台上传" @click="open = !open">
      <span v-if="uploads.hasActive" class="ring"></span>
      <KbIcon v-else name="check" :size="14" />
      <span>{{ headline }} {{ doneCount }} / {{ uploads.items.length }}</span>
      <span class="bar kb-upi-bar" :class="{ 'is-busy': busy }"><i :style="busy ? undefined : { width: `${percent}%` }" style-allow="总进度"></i></span>
      <span v-if="uploads.hasActive" class="m mono kb-upi-pct">{{ busy ? '…' : `${percent}%` }}</span>
      <span class="m mono kb-upi-note">{{ note }}</span>
    </button>

    <div v-if="open" class="card upp" role="dialog" aria-label="后台上传">
      <div class="ch">
        后台上传
        <div class="r row kb-upp-actions">
          <button v-if="uploads.hasActive || uploads.paused" type="button" class="btn sm" @click="uploads.togglePause()">
            {{ uploads.paused ? '继续' : '暂停' }}
          </button>
          <button v-else type="button" class="btn sm" @click="uploads.clearFinished(); open = false">清空</button>
          <button type="button" class="kb-dialog-x" aria-label="收起" @click="open = false"><KbIcon name="close" :size="14" /></button>
        </div>
      </div>
      <div class="m mono kb-upp-sum" data-testid="upload-detail">{{ detail }}</div>
      <div class="kb-upp-list">
        <div v-for="row in rows" :key="row.item.id" class="row kb-upp-row">
          <span class="kb-fmt mono" :class="`is-${row.chip.tone}`">{{ row.chip.label }}</span>
          <span class="kb-upp-name" :title="row.item.error ?? row.item.relPath">{{ row.item.name }}</span>
          <span class="bar kb-upp-bar" :class="{ 'is-failed': row.item.state === 'failed', 'is-busy': row.item.state === 'uploading' && !!row.item.phase && row.item.phase !== 'sending' }">
            <i :style="{ width: `${row.item.percent}%` }" style-allow="单个文件进度"></i>
          </span>
          <span class="m mono kb-upp-state" :class="{ 'kb-danger': row.item.state === 'failed' }">{{ row.text }}</span>
        </div>
        <div v-if="hidden" class="m kb-upp-more">还有 {{ hidden }} 个</div>
      </div>
      <RouterLink class="kb-upp-foot m" :to="PATHS.importQueue" @click="open = false">在「导入记录」里查看进度 →</RouterLink>
    </div>
  </template>
</template>
