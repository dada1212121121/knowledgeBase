// 「组件」与「OCR 与转写」分区的展示逻辑(纯函数,便于单测)。
// 数据来自能力 `provider_list` / `recommend_providers` / `ocr_status`(后端 `kb-cli/src/capability_backend.rs`)。
// 组件状态(使用中 / 已选用 · 缺运行时 / 可用 …)的合成在 utils/provider.ts,这里不重复。

import { formatSize } from './files'

export interface Provider {
  kind: string
  id: string
  name: string
  installed: boolean
  ready: boolean
  current: boolean
  detail: string | null
  model: string | null
  install_command: string | null
  removable: boolean
}

export interface EnvProfile {
  cpu_cores: number
  memory_mb: number
  disk_free_gb: number
  has_nvidia: boolean
  gpu: string | null
  has_intel_gpu: boolean
  tools: string[]
}

export interface Recommendation {
  kind: string
  provider: string
  reason: string
  already_current: boolean
}

/** 下载 / 安装的进度(OCR 与转写共用同一份:后端只有一个安装任务槽)。 */
export interface InstallStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | string
  lines: number
  tail: string[]
  error: string | null
  command: string
}

export interface OcrStatus {
  enabled: boolean
  backend: string
  model_size: string
  model_dir: string | null
  install_command: string
  install: InstallStatus
}

/** 组件类别的名字(术语表:OCR 保留原样,嵌入 / 重排用中文)。 */
export const KIND_LABELS: Readonly<Record<string, string>> = {
  ocr: '文字识别(OCR)',
  transcribe: '音视频转写',
  embed: '嵌入',
  rerank: '重排',
}
export const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind

export interface ProviderActions {
  /** 能自动下载(后端只支持 ocr 与 transcribe,而且要有安装命令、还没就绪)。 */
  install: boolean
  /** 能一键设为默认(后端只支持 ocr;其它类别的默认值只能改配置)。 */
  setDefault: boolean
  /** 能卸载(后端说了算)。 */
  uninstall: boolean
}

/**
 * 一个组件上能做哪些操作。
 *
 * 后端 `provider_set_default` 只认 ocr,`provider_install` 只认 ocr / transcribe;
 * 以前每一行都画「设为默认」,嵌入 / 重排 / 转写点了只会得到报错,现在这些按钮根本不出现。
 */
export function providerActions(provider: Provider): ProviderActions {
  const installable = provider.kind === 'ocr' || provider.kind === 'transcribe'
  return {
    install: installable && !!provider.install_command && !provider.ready,
    setDefault: provider.kind === 'ocr',
    uninstall: provider.removable,
  }
}

/** 一类组件的概况:`2/3 就绪 · 已选用的后端不可用`。 */
export function kindSummary(providers: readonly Provider[], kind: string): string {
  const list = providers.filter((item) => item.kind === kind)
  const ready = list.filter((item) => item.ready).length
  const broken = list.some((item) => item.current && !item.ready)
  return `${ready}/${list.length} 就绪${broken ? ' · 已选用的后端不可用' : ''}`
}

const orDash = (value: number | null | undefined, format: (n: number) => string) => (typeof value === 'number' && Number.isFinite(value) ? format(value) : '—')

/** 环境检测的几行;取不到的就写「—」,不编数字。 */
export function envRows(env: EnvProfile | null): { label: string; value: string }[] {
  return [
    { label: '处理器', value: orDash(env?.cpu_cores, (n) => `${n} 核`) },
    { label: '内存', value: orDash(env?.memory_mb, (n) => formatSize(n * 1024 * 1024)) },
    { label: '磁盘可用', value: orDash(env?.disk_free_gb, (n) => `${n} GB`) },
    { label: '显卡', value: env ? (env.gpu ?? '未检测到独立显卡') : '—' },
    { label: '已装工具', value: env?.tools?.length ? env.tools.join(' · ') : '—' },
  ]
}

/** 只留下属于这几类组件的推荐。 */
export const recsOfKinds = (recs: readonly Recommendation[], kinds: readonly string[]) => recs.filter((item) => kinds.includes(item.kind))

/** 能一键采用的推荐:后端只支持切换 ocr 的默认引擎,而且还没采用。 */
export const adoptable = (recs: readonly Recommendation[]) => recs.filter((item) => item.kind === 'ocr' && !item.already_current)

export function installLabel(state: string): string {
  switch (state) {
    case 'running':
      return '下载中'
    case 'done':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return '未开始'
  }
}

export function installTone(state: string): 'success' | 'danger' | 'warning' | 'neutral' {
  return state === 'done' ? 'success' : state === 'failed' ? 'danger' : state === 'running' ? 'warning' : 'neutral'
}

/** 下载失败的两句话(出了什么事 + 怎么办)。后端给的原因是日志里的原话,可能是英文,原样放在后面供查。 */
export function installFailureText(install: InstallStatus): string {
  const reason = install.error?.trim()
  return `下载没有成功${reason ? `:${reason.replace(/[。.]$/, '')}` : ''}。请检查网络和磁盘空间后,点上面对应组件的「下载」重试。`
}
