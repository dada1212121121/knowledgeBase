// 「备份」分区的数据与操作:状态读取(四种状态)、打包进度(WS + 兜底轮询)、立即备份 / 删除 / 按策略清理 / 校验。
//
// 以前这些都堆在 Settings.vue 里:
//   - 读取失败被 catch 吞掉,页面表现为“还没有备份”;现在是报错 + 重试;
//   - 备份 / 校验失败只闪一条 5 秒的提示条;现在失败原因常驻在 actionError,校验结果留在对应的那一行。
// 备份有结果(成功或失败)就通知外壳重读告警横幅,不让它等下一次 15 秒轮询。
import { computed, onUnmounted, ref, watch } from 'vue'
import { useConfirm, useToast } from '@kb-ui/index'
import { callCapability } from '@/api/client'
import { useLiveEvents } from '@/composables/useLiveEvents'
import { useLoadState } from '@/composables/useLoadState'
import { actionFailure } from '@/utils/actionFailure'
import { formatSize } from '@/utils/files'
import {
  checkSummary,
  isRunning,
  notifyBackupSettled,
  progressPercent,
  progressText,
  retentionText,
  type ArchiveCheck,
  type BackupEntry,
  type BackupProgress,
  type BackupStatus,
} from '@/utils/backup'

export const BACKUP_POLL_MS = 1000

export function useBackup() {
  const toast = useToast()
  const confirm = useConfirm()
  const state = useLoadState<BackupStatus>(() => callCapability<BackupStatus>('backup_status'), '读取备份信息')
  const status = state.data
  const refresh = () => state.reload({ quiet: true })

  /** WS 推来的实时进度(`backup.progress`);刚打开页面时若正在打包,用 backup_status.progress 兜底 */
  const liveProgress = ref<BackupProgress | null>(null)
  const backingUp = ref(false)

  /** 当前要展示的进度:只在真的在打包时显示,避免“完成后还挂着一条 100% 的进度条” */
  const running = computed<BackupProgress | null>(() => {
    const live = liveProgress.value
    if (live && isRunning(live.stage)) return live
    const fromStatus = status.value?.progress ?? null
    return fromStatus && isRunning(fromStatus.stage) ? fromStatus : null
  })
  const percent = computed(() => (running.value ? progressPercent(running.value) : 0))
  const progressLabel = computed(() => (running.value ? progressText(running.value, formatSize) : ''))

  /**
   * 打包中的进度兜底轮询。正常靠 WS 的 `backup.progress`;但 WS 断开、或者备份是别人
   * (定时备份 / 另一个标签页)发起的,页面就看不到事件 —— 所以只要“在打包”,就每秒问一次轻量的 `backup_state`。
   */
  let timer: number | undefined
  function stopPolling() {
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined
  }
  async function poll() {
    try {
      const current = await callCapability<{ running: BackupProgress | null }>('backup_state')
      liveProgress.value = current.running
      if (!current.running && !backingUp.value) {
        stopPolling()
        await refresh()
      }
    } catch {
      // 轮询只是兜底:这一次失败就等下一次(或 WS),不打扰用户
    }
  }
  watch(
    [backingUp, running],
    ([busy, active]) => {
      if (busy || active) {
        if (timer === undefined) timer = window.setInterval(() => void poll(), BACKUP_POLL_MS)
      } else {
        stopPolling()
      }
    },
    { immediate: true },
  )
  onUnmounted(stopPolling)

  useLiveEvents((event) => {
    if (event.type === 'backup.progress') {
      const progress = event.data as unknown as BackupProgress
      liveProgress.value = isRunning(progress.stage) ? progress : null
      if (!isRunning(progress.stage)) void refresh()
      return
    }
    if (event.type === 'backup.done' || event.type === 'backup.failed') {
      liveProgress.value = null
      void refresh()
    }
  })

  // ---- 操作
  /** 操作失败的原因(常驻);下一次操作开始时清掉。 */
  const actionError = ref('')
  /** 每份归档最近一次手动校验的结果(留在那一行里,不是 3 秒就消失的提示条)。 */
  const checks = ref<Record<string, { ok: boolean; text: string }>>({})
  const verifying = ref('')

  async function create(includeSources: boolean) {
    backingUp.value = true
    actionError.value = ''
    try {
      const entry = await callCapability<BackupEntry>('backup_create', { include_sources: includeSources })
      toast.push(`备份完成:${entry.name}(${formatSize(entry.size_bytes)})`)
      if ((entry.skipped ?? 0) > 0) toast.push(`有 ${entry.skipped} 个文件被跳过(名字非法或超过 8 GiB),详见归档里的 manifest.json`, 'warning')
      await refresh()
    } catch (err) {
      actionError.value = actionFailure('备份', err, '请检查磁盘空间后重试')
    } finally {
      backingUp.value = false
      // 成功或失败都通知外壳重读告警:横幅不该等到下一次 15 秒轮询才更新
      notifyBackupSettled()
    }
  }

  async function remove(entry: BackupEntry) {
    const mirrored = (status.value?.mirrors?.length ?? 0) > 0
    const ok = await confirm.ask({
      title: `删除备份「${entry.name}」?`,
      message: mirrored ? '归档文件与它的异地副本都会被删掉,不能恢复。需要的话先拷到别处。' : '归档文件会被删掉,不能恢复。需要的话先拷到别处。',
      confirmText: '删除',
      tone: 'danger',
      doneText: '已删除',
      action: () => callCapability('backup_delete', { name: entry.name }),
    })
    if (ok) {
      // 异地副本删不掉会记一条告警:让外壳立刻重读,不用等 15 秒
      notifyBackupSettled()
      await refresh()
    }
  }

  /** 按**已保存**的保留策略清理旧归档(最新一份永远保留)。 */
  async function prune() {
    const ok = await confirm.ask({
      title: '按保留策略清理旧备份?',
      message: `会删掉超出「${retentionText(status.value?.policy)}」的归档(含异地副本),最新一份永远保留。删掉不能恢复。`,
      confirmText: '清理',
      tone: 'danger',
      doneText: '已清理',
      action: async () => {
        const report = await callCapability<{ removed: string[]; kept: number; failed: [string, string][] }>('backup_prune', { dry_run: false })
        if (report.failed.length) {
          // 删不掉的会同时进 `.failures.json` 的告警(横幅可见),这里先说清是哪几份
          toast.push(`有 ${report.failed.length} 份删不掉,已记入备份告警:${report.failed[0]![1]}`, 'warning')
        }
        return report.removed.length ? `已删除 ${report.removed.length} 份,保留 ${report.kept} 份` : '没有需要清理的归档'
      },
    })
    if (ok) {
      notifyBackupSettled()
      await refresh()
    }
  }

  /** 校验一份归档(只读:恢复流程的第一步)。结果留在那一行里。 */
  async function verify(entry: BackupEntry) {
    verifying.value = entry.name
    try {
      const check = await callCapability<ArchiveCheck>('backup_verify', { name: entry.name })
      checks.value = { ...checks.value, [entry.name]: { ok: true, text: `校验通过 · ${checkSummary(check, formatSize)}` } }
    } catch (err) {
      checks.value = { ...checks.value, [entry.name]: { ok: false, text: actionFailure('校验', err, '这份备份可能已经损坏,不要拿它恢复') } }
    } finally {
      verifying.value = ''
    }
  }

  return {
    phase: state.phase,
    message: state.message,
    reload: state.reload,
    refresh,
    status,
    running,
    percent,
    progressLabel,
    backingUp,
    actionError,
    checks,
    verifying,
    create,
    remove,
    prune,
    verify,
  }
}
