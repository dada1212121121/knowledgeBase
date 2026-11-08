// 「组件」与「OCR 与转写」分区共用的数据和操作:组件目录 + 环境画像 + 推荐 + 下载进度。
//
// - 读取有加载 / 报错 / 无权限三种状态(useLoadState);推荐读不到不拖垮整块,但会说“推荐暂时读不到”,不静默吞;
// - 操作失败的原因常驻在 actionError(错误不自动消失),成功用提示条;
// - 下载是后台任务:进度 `ocr_status.install` 在「下载中」时每 2 秒自动刷新,一结束(成功或失败)就重新读组件目录,
//   页面上的“可用 / 未安装”随之更新,不用手点刷新。
import { computed, onUnmounted, ref, watch } from 'vue'
import { useConfirm, useToast } from '@kb-ui/index'
import { callCapability } from '@/api/client'
import { useLoadState } from '@/composables/useLoadState'
import { actionFailure as failure } from '@/utils/actionFailure'
import { kindLabel, type EnvProfile, type OcrStatus, type Provider, type Recommendation } from '@/utils/settingsComponents'

interface Bundle {
  providers: Provider[]
  env: EnvProfile | null
  /** null = 推荐读取失败(和“没有推荐”是两回事)。 */
  recommendations: Recommendation[] | null
  /** 后端的坏声明(`<KB_HOME>/backends/*`):条目照常列,问题单独摆出来。 */
  backendWarnings: string[]
}

export const INSTALL_POLL_MS = 2000

export function useProviders() {
  const toast = useToast()
  const confirm = useConfirm()
  const state = useLoadState<Bundle>(async () => {
    const listed = await callCapability<{ providers?: Provider[]; env?: EnvProfile | null; backend_warnings?: string[] }>('provider_list')
    let recommendations: Recommendation[] | null = null
    try {
      recommendations = (await callCapability<{ recommendations?: Recommendation[] }>('recommend_providers')).recommendations ?? []
    } catch {
      recommendations = null // 页面上单独提示“推荐暂时读不到”,不影响组件目录本身
    }
    return {
      providers: listed.providers ?? [],
      env: listed.env ?? null,
      recommendations,
      backendWarnings: listed.backend_warnings ?? [],
    }
  }, '读取组件信息')

  const providers = computed(() => state.data.value?.providers ?? [])
  const env = computed(() => state.data.value?.env ?? null)
  const recommendations = computed(() => state.data.value?.recommendations ?? [])
  const recommendationsFailed = computed(() => state.data.value !== null && state.data.value.recommendations === null)
  const backendWarnings = computed(() => state.data.value?.backendWarnings ?? [])

  // ---- 下载进度
  const ocr = ref<OcrStatus | null>(null)
  const installError = ref('')
  async function loadInstall() {
    try {
      ocr.value = await callCapability<OcrStatus>('ocr_status')
      installError.value = ''
    } catch (err) {
      installError.value = failure('读取下载进度', err)
    }
  }

  let timer: number | undefined
  function stopPolling() {
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined
  }
  watch(
    () => ocr.value?.install?.state,
    (now, before) => {
      if (now === 'running') {
        if (timer === undefined) timer = window.setInterval(() => void loadInstall(), INSTALL_POLL_MS)
        return
      }
      stopPolling()
      // 下载刚结束:组件目录里的“未安装 / 可用”要跟着变
      if (before === 'running') void state.reload({ quiet: true })
    },
  )
  onUnmounted(stopPolling)

  // ---- 操作
  const busy = ref('')
  const actionError = ref('')

  async function run(key: string, doing: string, work: () => Promise<void>) {
    busy.value = key
    actionError.value = ''
    try {
      await work()
    } catch (err) {
      actionError.value = failure(doing, err)
    } finally {
      busy.value = ''
    }
  }

  const installProvider = (provider: Provider) =>
    run(provider.id, `下载 ${provider.id}`, async () => {
      await callCapability('provider_install', { kind: provider.kind, id: provider.id })
      toast.push(`已开始下载 ${provider.id}。`)
      await loadInstall()
    })

  const setDefault = (provider: Provider) =>
    run(provider.id, `把 ${provider.id} 设为默认`, async () => {
      await callCapability('provider_set_default', { kind: provider.kind, id: provider.id })
      // 默认引擎写在 extract.ocr_backend,后端按“要重启才生效”处理(config.rs 的热更新白名单里没有 extract.*)
      toast.push(`已把 ${provider.id} 设为默认${kindLabel(provider.kind)}引擎。要重启服务后才生效。`, 'warning')
      await Promise.all([state.reload({ quiet: true }), loadInstall()])
    })

  async function uninstall(provider: Provider) {
    const ok = await confirm.ask({
      title: `卸载 ${provider.id} 的模型文件?`,
      message: '会删除模型目录里的识别模型文件,不动系统里装的运行时;之后要用的话得重新下载。',
      confirmText: '卸载',
      tone: 'danger',
      doneText: '已卸载',
      action: async () => {
        const result = await callCapability<{ removed: number }>('provider_uninstall', { kind: provider.kind, id: provider.id })
        toast.push(`已清理 ${result.removed} 个模型文件。`)
      },
    })
    if (ok) await state.reload({ quiet: true })
  }

  const adopt = (recs: readonly Recommendation[]) =>
    run('adopt', '采用推荐', async () => {
      for (const item of recs) await callCapability('provider_set_default', { kind: item.kind, id: item.provider })
      toast.push('已采用推荐的识别引擎。要重启服务后才生效。', 'warning')
      await Promise.all([state.reload({ quiet: true }), loadInstall()])
    })

  return {
    phase: state.phase,
    message: state.message,
    reload: state.reload,
    providers,
    env,
    recommendations,
    recommendationsFailed,
    backendWarnings,
    ocr,
    installError,
    loadInstall,
    busy,
    actionError,
    installProvider,
    setDefault,
    uninstall,
    adopt,
  }
}
