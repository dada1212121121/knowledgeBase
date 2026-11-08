import { clockText as siteClockText } from './time'
// 系统状态页的纯逻辑:数据形状、各块是否读到、数字与状态的人话写法、日志解析。
//
// 数据来自后端 `system_status` 能力(crates/kb-service/src/system_status.rs 的 SystemStatus)。
// 原则和后端一样:采不到的字段留空并说明,界面不编数字——所以这里的类型把可能缺的字段都标成可选。
import { DISK_ALERT_RATIO } from './systemAlerts'

export interface Provider {
  kind: string
  id: string
  name: string
  installed: boolean
  ready: boolean
  current: boolean
  detail: string | null
  model: string | null
}

export interface SystemSnapshot {
  overview?: {
    service?: { version?: string; uptime_seconds?: number | null; home?: string; listen?: string }
    collections?: number
    projects?: number
    sources?: number
    components_ready?: [number, number]
    note?: string | null
  }
  resources?: {
    cpu?: { cores?: number; busy_ratio?: number; load?: number[] }
    memory?: { total_mb?: number; available_mb?: number; used_ratio?: number }
    disk?: { mount?: string; free_gb?: number; total_gb?: number; used_ratio?: number }
    gpu?: { name?: string | null; utilization?: number | null; memory_used_mb?: number | null; note?: string | null }
  }
  components?: Provider[]
  env?: { cpu_cores?: number; memory_mb?: number; has_nvidia?: boolean; gpu?: string | null; has_intel_gpu?: boolean; tools?: string[] }
  jobs?: {
    by_state?: [string, number][]
    recent?: { id: string; kind: string; state: string; done: number; total: number | null; updated_at: number }[]
    ingest?: [string, number][]
  }
  network?: {
    listen?: string
    socket?: string
    allow_remote?: boolean
    mcp_transports?: string[]
    mcp_allowed_hosts?: string[]
    llm_calls_today?: number
    llm_tokens_today?: [number, number]
  }
  logs?: { dir?: string; files?: [string, number][]; tail?: string[] }
}

// ---------------------------------------------------------------- 分块

/** 页面上各自独立显示的块。一块缺了只影响它自己。 */
export type BlockKey = 'overview' | 'network' | 'resources' | 'env' | 'components' | 'jobs' | 'logs'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 这一块的数据读到了没有。
 * 后端是一次调用返回所有块,某一块采集失败或老版本没有这一块时,字段会缺失或形状不对;
 * 这里逐块检查必要的字段,不合格的块单独显示「没读到」,其它块照常。
 */
export function blockReady(snapshot: SystemSnapshot | null, key: BlockKey): boolean {
  if (!snapshot) return false
  switch (key) {
    case 'overview':
      return isObject(snapshot.overview) && isObject(snapshot.overview.service)
    case 'network':
      return isObject(snapshot.network)
    case 'resources': {
      const resources = snapshot.resources
      return isObject(resources) && isObject(resources.cpu) && isObject(resources.memory) && isObject(resources.disk)
    }
    case 'env':
      return isObject(snapshot.env)
    case 'components':
      return Array.isArray(snapshot.components)
    case 'jobs': {
      const jobs = snapshot.jobs
      return isObject(jobs) && Array.isArray(jobs.by_state) && Array.isArray(jobs.recent) && Array.isArray(jobs.ingest)
    }
    case 'logs': {
      const logs = snapshot.logs
      return isObject(logs) && Array.isArray(logs.files) && Array.isArray(logs.tail)
    }
  }
}

export const BLOCK_NAME: Record<BlockKey, string> = {
  overview: '服务信息',
  network: '网络与访问',
  resources: '资源用量',
  env: '运行环境',
  components: '组件',
  jobs: '任务',
  logs: '日志',
}

// ---------------------------------------------------------------- 页签

export const TAB_IDS = ['service', 'resources', 'components', 'jobs', 'logs'] as const
export type TabId = (typeof TAB_IDS)[number]

/** 旧地址里的 ?tab= 取值:overview / network 现在合并进「服务」。认不出的取值回到第一页,不留空白页面。 */
export function tabFromQuery(value: unknown): TabId {
  if (value === 'overview' || value === 'network') return 'service'
  return (TAB_IDS as readonly unknown[]).includes(value) ? (value as TabId) : 'service'
}

// ---------------------------------------------------------------- 数字

/** 运行时长:不到 1 小时写分钟,一天以内写「时 分」,更久写「天 时」。取不到显示「—」。 */
export function uptimeText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

/** 比例 → 整数百分比(术语表:百分比不带小数)。 */
export const ratioText = (ratio: number | null | undefined): string => (ratio === null || ratio === undefined || !Number.isFinite(ratio) ? '—' : `${Math.round(ratio * 100)}%`)

/** MB → 小于 1 GB 写 MB,否则写 GB(一位小数)。大小和单位之间留一个空格。 */
export function mbText(mb: number | null | undefined): string {
  if (mb === null || mb === undefined || !Number.isFinite(mb)) return '—'
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}
export const gbText = (gb: number | null | undefined): string => (gb === null || gb === undefined || !Number.isFinite(gb) ? '—' : `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`)

export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** 大数在窄处写「万」:18.2 万;不到一万写带千分位的整数。 */
export const wanText = (value: number): string => (value >= 10_000 ? `${(value / 10_000).toFixed(1)} 万` : value.toLocaleString('en-US'))

export const countText = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : value.toLocaleString('en-US'))

/** 「12:30:05」(站点时区)。 */
export function clockText(at: number): string {
  return siteClockText(at, true)
}

// ---------------------------------------------------------------- 资源水位

export type Level = 'ok' | 'high' | 'full'
/** 内存 / 磁盘用到这个比例算「偏高」;磁盘和头像上的小圆点用同一条「快满了」线(systemAlerts)。 */
export const HIGH_RATIO = 0.8

export function levelOf(ratio: number | null | undefined): Level {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return 'ok'
  if (ratio >= DISK_ALERT_RATIO) return 'full'
  return ratio >= HIGH_RATIO ? 'high' : 'ok'
}

/** 水位徽标的文字——颜色之外也用文字说明,色盲和读屏都能懂。ok 不显示徽标。 */
export const LEVEL_TEXT: Record<Level, string> = { ok: '', high: '偏高', full: '快满了' }

// ---------------------------------------------------------------- 任务

const JOB_STATE: Record<string, string> = { queued: '排队', running: '运行中', paused: '已暂停', done: '完成', failed: '失败', canceled: '已取消' }
export const jobStateText = (state: string): string => JOB_STATE[state] ?? state

export function jobStateTone(state: string): 'accent' | 'danger' | 'success' | 'neutral' {
  return state === 'running' ? 'accent' : state === 'failed' ? 'danger' : state === 'done' ? 'success' : 'neutral'
}

const JOB_KIND: Record<string, string> = {
  index: '索引',
  reindex: '重建索引',
  embed: '建立索引',
  migrate: '更换索引模型',
  ingest: '导入解析',
  sync: '同步来源',
  save_insight: '保存笔记',
  backup: '备份',
  eval: '评测',
  evolve: '自动提炼',
  extract: '自动提炼',
  review: '自动审核',
}
export const jobKindText = (kind: string): string => JOB_KIND[kind] ?? kind

/** 和 AI 提炼 / 审核有关的任务:AI 总开关关掉后,这些任务在页面上不出现。 */
const AI_JOB_KINDS = new Set(['evolve', 'extract', 'review'])
export const isAiJob = (kind: string): boolean => AI_JOB_KINDS.has(kind)

const INGEST_STATE: Record<string, string> = {
  queued: '排队',
  extracting: '提取文字',
  chunking: '切分内容',
  embedding: '建立索引',
  done: '完成',
  skipped: '已跳过',
  quarantined: '已隔离',
  failed: '失败',
}
export const ingestStateText = (state: string): string => INGEST_STATE[state] ?? state

/** 取某个状态的数量,没有这个状态算 0。 */
export const countOf = (pairs: [string, number][] | undefined, state: string): number => pairs?.find(([name]) => name === state)?.[1] ?? 0

export const totalOf = (pairs: [string, number][] | undefined): number => (pairs ?? []).reduce((sum, [, count]) => sum + count, 0)

// ---------------------------------------------------------------- 组件

export interface KindInfo {
  label: string
  help: string
}
const KIND: Record<string, KindInfo> = {
  ocr: { label: '文字识别(OCR)', help: '把图片和扫描件里的文字读出来,之后才能被搜到' },
  transcribe: { label: '音视频转写', help: '把音频、视频里的话转成文字,之后才能被搜到' },
  embed: { label: '索引模型', help: '把内容变成可以按意思搜索的形式;换模型要重建索引' },
  rerank: { label: '重排模型', help: '对初步搜到的结果再排一次序,让更相关的排在前面' },
  llm: { label: '云端模型', help: '自动提炼、审核等功能调用的模型' },
  review: { label: '审核模型', help: '给自动提炼出的笔记打分的模型' },
  sidecar: { label: '模型运行服务', help: '在本机运行上面这些模型的后台进程' },
}
export const kindInfo = (kind: string): KindInfo => KIND[kind] ?? { label: kind, help: '' }

/** 只和 AI 有关的组件种类:AI 总开关关掉后不出现。 */
const AI_KINDS = new Set(['llm', 'review'])
export const isAiKind = (kind: string): boolean => AI_KINDS.has(kind)

const KIND_ORDER = ['ocr', 'transcribe', 'embed', 'rerank', 'llm', 'review', 'sidecar']

export function visibleComponents(components: Provider[] | undefined, aiEnabled: boolean): Provider[] {
  return (components ?? []).filter((item) => aiEnabled || !isAiKind(item.kind))
}

/** 按种类分组,常见的种类固定在前面,其余按名字排。 */
export function groupComponents(components: Provider[]): [string, Provider[]][] {
  const groups = new Map<string, Provider[]>()
  for (const provider of components) {
    const list = groups.get(provider.kind) ?? []
    list.push(provider)
    groups.set(provider.kind, list)
  }
  const rank = (kind: string) => {
    const index = KIND_ORDER.indexOf(kind)
    return index < 0 ? KIND_ORDER.length : index
  }
  return [...groups.entries()].sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right))
}

export interface ComponentState {
  text: string
  tone: 'success' | 'warning' | 'danger'
}
export function componentState(provider: Pick<Provider, 'installed' | 'ready'>): ComponentState {
  if (provider.ready) return { text: '就绪', tone: 'success' }
  return provider.installed ? { text: '未就绪', tone: 'warning' } : { text: '未安装', tone: 'danger' }
}

/** [就绪数, 总数]。 */
export const readyCount = (components: Provider[]): [number, number] => [components.filter((item) => item.ready).length, components.length]

/** 没就绪的组件一句话(给「需要注意」用);都就绪返回 null。 */
export function notReadyNote(components: Provider[]): string | null {
  const bad = components.filter((item) => !item.ready)
  if (!bad.length) return null
  const names = bad.map((item) => `${item.name || item.id}(${kindInfo(item.kind).label}${item.installed ? '' : ',未安装'})`)
  return `有 ${bad.length} 个组件没有就绪:${names.join('、')}。`
}

// ---------------------------------------------------------------- 网络

const TRANSPORT: Record<string, string> = { stdio: '本机进程(stdio)', http: '网络请求(http)' }
export const transportText = (name: string): string => TRANSPORT[name] ?? name

export const hostsText = (hosts: string[] | undefined): string => (hosts?.length ? hosts.join('、') : '只允许本机访问')

// ---------------------------------------------------------------- 日志

export interface LogLine {
  time: string
  level: string
  text: string
}

/** 日志里带终端颜色码(ESC[…m),要先去掉 */
const ANSI = /\u001b\[[0-9;]*m/g
const LOG_LINE = /^(?:\d{4}-\d\d-\d\dT)?(\d\d:\d\d:\d\d)\S*\s+(INFO|WARN|ERROR|DEBUG|TRACE)\s+(.*)$/

/** 一行日志拆成 时间 / 级别 / 正文;认不出格式的行整行当正文。 */
export function parseLogLine(raw: string): LogLine {
  const clean = raw.replace(ANSI, '')
  const match = clean.match(LOG_LINE)
  return match ? { time: match[1]!, level: match[2]!, text: match[3]! } : { time: '', level: '', text: clean }
}

export const LEVEL_NAME: Record<string, string> = { ERROR: '错误', WARN: '警告', INFO: '信息', DEBUG: '调试', TRACE: '跟踪' }
export const levelName = (level: string): string => LEVEL_NAME[level] ?? level

/** 只看按级别解析出来的警告和错误,不拿「正文里碰巧有 WARN 这个词」的行充数。 */
export function recentProblems(tail: string[] | undefined, limit = 6): LogLine[] {
  return (tail ?? [])
    .map(parseLogLine)
    .filter((line) => line.level === 'WARN' || line.level === 'ERROR')
    .slice(-limit)
}

/** 日志尾部最多显示多少行(页面里是可滚动的框,不是越多越好)。 */
export const TAIL_LINES = 60
export const tailLines = (tail: string[] | undefined, limit = TAIL_LINES): LogLine[] => (tail ?? []).slice(-limit).map(parseLogLine)

// ---------------------------------------------------------------- 各卡片的「标签 + 帮助文字 + 值」

/** 一行:中文标签 + 可选的一句帮助文字(键名放在里面)+ 值。`tone` 有值时,值显示成徽标。 */
export interface StatusRow {
  key: string
  label: string
  help?: string
  value: string
  mono?: boolean
  tone?: 'success' | 'warning' | 'danger' | 'neutral' | 'accent'
}

const dash = (value: string | number | null | undefined): string => (value === null || value === undefined || value === '' ? '—' : String(value))

export function serviceRows(snapshot: SystemSnapshot): StatusRow[] {
  const service = snapshot.overview?.service
  return [
    { key: 'version', label: '版本', value: dash(service?.version) },
    { key: 'uptime', label: '已运行', help: '这次启动以来的时间', value: uptimeText(service?.uptime_seconds) },
    { key: 'home', label: '数据目录', help: '知识库的全部数据存放在这里(KB_HOME)', value: dash(service?.home), mono: true },
  ]
}

export function scaleRows(snapshot: SystemSnapshot): StatusRow[] {
  const overview = snapshot.overview
  return [
    { key: 'collections', label: '集合', help: '知识库里的内容分组', value: `${countText(overview?.collections ?? 0)} 个` },
    { key: 'projects', label: '项目', help: '管理员在服务器上登记的代码目录', value: `${countText(overview?.projects ?? 0)} 个` },
    { key: 'sources', label: '数据来源', help: '导入页和项目页里登记的网页、文件夹、仓库等', value: `${countText(overview?.sources ?? 0)} 个` },
  ]
}

export function networkRows(snapshot: SystemSnapshot): StatusRow[] {
  const network = snapshot.network
  const remote = network?.allow_remote === true
  return [
    { key: 'listen', label: '监听地址', help: '网页和接口对外提供服务的地址(server.listen)', value: dash(network?.listen), mono: true },
    {
      key: 'remote',
      label: '允许远程访问',
      help: '关闭时只有这台机器能访问(server.allow_remote)',
      value: remote ? '已开启' : '已关闭',
      tone: remote ? 'warning' : 'success',
    },
    { key: 'socket', label: '本机通道', help: '本机命令行和其它程序连接时用的 socket 文件', value: dash(network?.socket), mono: true },
    {
      key: 'transports',
      label: 'MCP 接入方式',
      help: 'MCP 是让其它程序读取知识库的接口(mcp.transports)',
      value: network?.mcp_transports?.length ? network.mcp_transports.map(transportText).join('、') : '—',
    },
    {
      key: 'hosts',
      label: 'MCP 允许的访问域名',
      help: '通过反向代理对外提供 MCP 时,要把外部域名加进来(mcp.allowed_hosts)',
      value: hostsText(network?.mcp_allowed_hosts),
    },
  ]
}

/** 今日云端模型用量(AI 总开关关掉后整张卡都不出现,见页面)。 */
export function llmRows(snapshot: SystemSnapshot): StatusRow[] {
  const network = snapshot.network
  const [input, output] = network?.llm_tokens_today ?? [0, 0]
  return [
    { key: 'calls', label: '今日调用', help: '自动提炼、审核等功能调用云端模型的次数(llm_calls_today)', value: `${countText(network?.llm_calls_today ?? 0)} 次` },
    { key: 'quota', label: '今日用掉的额度', help: '输入和输出各用了多少;每个人的额度排行在「存储与用量」里', value: `输入 ${wanText(input)} · 输出 ${wanText(output)}` },
  ]
}

export function cpuRows(snapshot: SystemSnapshot): StatusRow[] {
  const cpu = snapshot.resources?.cpu
  return [
    { key: 'cores', label: '核数', value: cpu?.cores === undefined ? '—' : `${cpu.cores} 核` },
    { key: 'busy', label: '使用率', help: '自启动以来的平均,不是此刻的瞬时值', value: ratioText(cpu?.busy_ratio) },
    {
      key: 'load',
      label: '负载',
      help: '最近 1 / 5 / 15 分钟的平均排队任务数;接近核数说明已经满载',
      value: cpu?.load?.length ? cpu.load.map((item) => item.toFixed(2)).join(' / ') : '—',
    },
  ]
}

export function memoryRows(snapshot: SystemSnapshot): StatusRow[] {
  const memory = snapshot.resources?.memory
  return [
    { key: 'used', label: '已用', value: ratioText(memory?.used_ratio) },
    { key: 'available', label: '可用', value: mbText(memory?.available_mb) },
    { key: 'total', label: '总量', value: mbText(memory?.total_mb) },
  ]
}

export function diskRows(snapshot: SystemSnapshot): StatusRow[] {
  const disk = snapshot.resources?.disk
  return [
    { key: 'mount', label: '所在磁盘', help: '数据目录所在的挂载点', value: dash(disk?.mount), mono: true },
    { key: 'used', label: '已用', value: ratioText(disk?.used_ratio) },
    { key: 'free', label: '可用 / 总量', value: `${gbText(disk?.free_gb)} / ${gbText(disk?.total_gb)}` },
  ]
}

export function gpuRows(snapshot: SystemSnapshot): StatusRow[] {
  const gpu = snapshot.resources?.gpu
  return [
    { key: 'name', label: '显卡', value: gpu?.name || '没有检测到独立显卡' },
    { key: 'utilization', label: '利用率', value: gpu?.utilization === null || gpu?.utilization === undefined ? '未采集' : ratioText(gpu.utilization) },
    { key: 'memory', label: '显存已用', value: gpu?.memory_used_mb === null || gpu?.memory_used_mb === undefined ? '未采集' : mbText(gpu.memory_used_mb) },
  ]
}

export function envRows(snapshot: SystemSnapshot): StatusRow[] {
  const env = snapshot.env
  return [
    { key: 'nvidia', label: 'NVIDIA 显卡驱动', value: env?.has_nvidia ? '可用' : '未检测到', tone: env?.has_nvidia ? 'success' : 'neutral' },
    { key: 'intel', label: 'Intel 核显', value: env?.has_intel_gpu ? '可用' : '未检测到', tone: env?.has_intel_gpu ? 'success' : 'neutral' },
    { key: 'tools', label: '已安装的工具', help: '导入和解析时会用到的命令行工具', value: env?.tools?.length ? env.tools.join('、') : '—' },
  ]
}

/** 任务队列:每个状态一行;失败的任务数大于 0 时用红色徽标,运行中用强调色。 */
export function jobStateRows(pairs: [string, number][] | undefined): StatusRow[] {
  return (pairs ?? []).map(([state, count]) => ({
    key: state,
    label: jobStateText(state),
    value: countText(count),
    tone: count > 0 && state === 'failed' ? 'danger' : count > 0 && state === 'running' ? 'accent' : undefined,
  }))
}

/** 导入队列:只列有文件的状态;全是 0 时返回空数组,由页面写「队列是空的」。 */
export function ingestRows(pairs: [string, number][] | undefined): StatusRow[] {
  return (pairs ?? [])
    .filter(([, count]) => count > 0)
    .map(([state, count]) => ({
      key: state,
      label: ingestStateText(state),
      value: countText(count),
      tone: state === 'failed' || state === 'quarantined' ? 'danger' : undefined,
    }))
}

/** 「需要注意」:把各块里值得看一眼的问题汇总成几句话。某一块没读到就不参与,不影响别的。 */
export function attentionNotes(snapshot: SystemSnapshot | null, aiEnabled: boolean): string[] {
  if (!snapshot) return []
  const notes: string[] = []
  if (blockReady(snapshot, 'components')) {
    const note = notReadyNote(visibleComponents(snapshot.components, aiEnabled))
    if (note) notes.push(note)
  } else if (aiEnabled && snapshot.overview?.note) {
    notes.push(snapshot.overview.note)
  }
  if (blockReady(snapshot, 'resources')) {
    const level = levelOf(snapshot.resources!.disk!.used_ratio)
    if (level !== 'ok') notes.push(`磁盘已用 ${ratioText(snapshot.resources!.disk!.used_ratio)},${level === 'full' ? '快满了,请尽快清理或扩容' : '空间偏紧,留意增长'}。`)
  }
  if (blockReady(snapshot, 'jobs')) {
    const failed = countOf(snapshot.jobs!.by_state, 'failed')
    if (failed > 0) notes.push(`有 ${failed} 个任务失败了,可以到「任务」页查看原因。`)
  }
  return notes
}
