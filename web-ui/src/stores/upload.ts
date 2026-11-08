// 上传队列(后台上传):文件在 pinia store 里排队,切换页面不中断。
//
// 页面只负责“把文件丢进队列”和“看进度”;真正的分片、重试、续传都在
// `@/api/upload` 里。并发 2 个文件(每个文件内部串行分片)。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import {
  precheck,
  relativePathOf,
  sha256Hex,
  summarize,
  uploadFile,
  type DedupStrategy,
  type PrecheckResult,
  type UploadPhase,
} from '@/api/upload'

/** 一个待上传的文件。 */
export interface UploadItem {
  id: string
  name: string
  relPath: string
  size: number
  percent: number
  /** 已经送出的字节(续传时包含之前已收到的分片);完成后等于 size */
  sent: number
  /** 正在传的文件当前处于哪个阶段;排队、完成、失败时没有 */
  phase?: UploadPhase
  /** waiting | uploading | done | skipped | failed */
  state: 'waiting' | 'uploading' | 'done' | 'skipped' | 'failed'
  batch: string
  error?: string
}

/** 入队参数。 */
export interface EnqueueOptions {
  collection: string
  tags?: string[]
  /** 所有文件的默认策略。 */
  strategy?: DedupStrategy
  /** 逐文件策略(按集合内相对路径),优先于 `strategy`。 */
  strategies?: Record<string, DedupStrategy>
}

/** 上传完成的一个批次(批次完成的总结用)。 */
export interface CompletedBatch {
  batch: string
  collection: string
  files: number
  failed: number
  skipped: number
}

const MAX_CONCURRENT = 2

export const useUploadStore = defineStore('upload', () => {
  const items = ref<UploadItem[]>([])
  const pending: { file: File; item: UploadItem; options: EnqueueOptions }[] = []
  const running = ref(0)
  /** 需要人工选策略的重复文件。 */
  const duplicates = ref<{ relPath: string; result: PrecheckResult }[]>([])
  /** 刚跑完的批次(批次完成弹总结)。 */
  const completed = ref<CompletedBatch[]>([])
  const lastError = ref('')
  /** 「添加数据」对话框打开时由它自己接管拖放(全局遮罩暂停,避免拖进对话框时直接开传) */
  const captureDrops = ref(false)
  /** 暂停:不再开始新的文件(正在传的文件会传完,分片续传无法在中途停) */
  const paused = ref(false)

  const active = computed(() => items.value.filter((item) => item.state === 'uploading' || item.state === 'waiting'))
  /** 全部文件的总字节;完成 / 跳过的文件按全部送出算 */
  const totalBytes = computed(() => items.value.reduce((sum, item) => sum + item.size, 0))
  const sentBytes = computed(() =>
    items.value.reduce((sum, item) => sum + (item.state === 'done' || item.state === 'skipped' ? item.size : Math.min(item.size, item.sent)), 0),
  )
  const summary = computed(() => {
    const base = summarize(
      items.value.map((item) => item.percent),
      items.value.filter((item) => item.state === 'failed').length,
    )
    // 总进度按字节加权:一个 2 GB 的文件和十个 1 KB 的文件,不该各占一半
    return totalBytes.value > 0 ? { ...base, percent: Math.round((sentBytes.value / totalBytes.value) * 100) } : base
  })
  const hasActive = computed(() => active.value.length > 0)

  /** 预检一批文件:返回需要人工决定的重复项(重复文件)。 */
  async function inspect(files: File[], collection: string) {
    const results = await precheck(
      collection,
      await Promise.all(
        files.map(async (file) => ({
          rel_path: relativePathOf(file),
          size: file.size,
          sha256: await sha256Hex(file),
        })),
      ),
    )
    const conflicts = results
      .filter((result) => result.status === 'same_name_diff_content')
      .map((result) => ({ relPath: result.rel_path, result }))
    return { results, conflicts }
  }

  /** 把一个文件夹 / 一批文件放进队列,返回本批次的 id(可撤销)。 */
  function enqueue(files: File[], options: EnqueueOptions): string {
    const batch = crypto.randomUUID()
    for (const file of files) {
      const item: UploadItem = {
        id: crypto.randomUUID(),
        name: file.name,
        relPath: relativePathOf(file),
        size: file.size,
        percent: 0,
        sent: 0,
        state: 'waiting',
        batch,
      }
      items.value.push(item)
      pending.push({
        file,
        item,
        options: {
          ...options,
          strategy: options.strategies?.[item.relPath] ?? options.strategy,
        },
      })
    }
    pump()
    return batch
  }

  /** 启动下一批(并发上限 2)。 */
  function pump() {
    while (!paused.value && running.value < MAX_CONCURRENT && pending.length > 0) {
      const next = pending.shift()
      if (!next) break
      running.value += 1
      void run(next.file, next.item, next.options).finally(() => {
        running.value -= 1
        pump()
      })
    }
  }

  async function run(file: File, item: UploadItem, options: EnqueueOptions) {
    item.state = 'uploading'
    try {
      const completedUpload = await uploadFile(file, {
        collection: options.collection,
        tags: options.tags,
        strategy: options.strategy,
        batch: item.batch,
        onProgress: (percent) => {
          item.percent = percent
        },
        onBytes: (sent) => {
          item.sent = sent
        },
        onPhase: (phase) => {
          item.phase = phase
        },
        onDuplicate: (result) => {
          duplicates.value.push({ relPath: result.rel_path, result })
        },
      })
      item.percent = 100
      item.sent = item.size
      item.phase = undefined
      item.state = completedUpload.skipped.length > 0 ? 'skipped' : 'done'
      if (completedUpload.skipped.length > 0) {
        item.error = completedUpload.skipped[0]?.reason === 'same_content' ? '内容已存在(秒传)' : '按策略跳过'
      }
    } catch (error) {
      item.state = 'failed'
      item.phase = undefined
      item.error = error instanceof Error ? error.message : '上传失败'
      lastError.value = item.error
    } finally {
      settle(item.batch)
    }
  }

  /** 一个批次的文件都结束了 → 记一条“批次完成”(批次完成)。 */
  function settle(batch: string) {
    const batchItems = items.value.filter((item) => item.batch === batch)
    if (!batchItems.length) return
    if (batchItems.some((item) => item.state === 'waiting' || item.state === 'uploading')) return
    if (completed.value.some((entry) => entry.batch === batch)) return
    completed.value.push({
      batch,
      collection: '',
      files: batchItems.length,
      failed: batchItems.filter((item) => item.state === 'failed').length,
      skipped: batchItems.filter((item) => item.state === 'skipped').length,
    })
  }

  /** 清掉已完成 / 已失败的条目(状态栏浮层的“清空”)。 */
  function togglePause() {
    paused.value = !paused.value
    if (!paused.value) pump()
  }

  function clearFinished() {
    items.value = items.value.filter((item) => item.state === 'uploading' || item.state === 'waiting')
    duplicates.value = []
  }

  /** 关掉一条“批次完成”提示。 */
  function dismissBatch(batch: string) {
    completed.value = completed.value.filter((entry) => entry.batch !== batch)
  }

  /** 清空全部(测试与“取消全部”用)。 */
  function reset() {
    items.value = []
    pending.length = 0
    duplicates.value = []
    completed.value = []
    lastError.value = ''
  }

  return {
    items,
    duplicates,
    completed,
    running,
    active,
    summary,
    totalBytes,
    sentBytes,
    hasActive,
    lastError,
    captureDrops,
    paused,
    togglePause,
    inspect,
    enqueue,
    clearFinished,
    dismissBatch,
    reset,
  }
})
