// 数据来源的纯逻辑:类型名 / 图标、刷新策略文案、同步状态、哪些来源归「导入」页、哪些归管理组。
// 和界面分开,方便单测;原来散在 Sources.vue 里。
import type { IconName } from '@kb-ui/index'

export type SourceKind = 'local_dir' | 'git' | 'web' | 'upload' | 'archive' | 'note'

export interface SourceRow {
  id: string
  kind: SourceKind
  name: string
  uri: string
  collection: string
  tags: string[]
  include: string[]
  exclude: string[]
  depth: number
  allow_hosts: string[]
  refresh_minutes: number | null
  status: 'idle' | 'syncing' | 'error'
  last_synced_at: number | null
  last_error: string | null
  files: number
  created_at: number
  /** 网页来源:抓到的页面是否交给内置模型整理成规范化结果(旧接口没有这一项时按关处理) */
  ai_extract?: boolean
  /** 网页来源的提取要求(空 = 自动) */
  extract_prompt?: string
  /** 最近一次 AI 规范化的情况(没跑过为 null) */
  ai_status?: SourceAiStatus | null
}

/** 网页来源最近一次 AI 规范化的情况(后端 `Source.ai_status`) */
export interface SourceAiStatus {
  done: number
  pending: number
  failed: number
  note: string | null
  updated_at: number
}

/** AI 规范化的一行说明:「已整理 3 页 · 待整理 2 页 · 失败 1 页」;一页都没处理过时返回空串。 */
export function aiStatusText(status: SourceAiStatus | null | undefined): string {
  if (!status) return ''
  const parts = [`已整理 ${status.done} 页`]
  if (status.pending) parts.push(`待整理 ${status.pending} 页`)
  if (status.failed) parts.push(`失败 ${status.failed} 页`)
  return parts.join(' · ')
}

/** 每个数据源的解析队列计数(后端 `list_sources.items[].stats`;没有就不显示) */
export interface SourceStats {
  total: number
  today: number
  failed: number
  quarantined: number
  pending: number
}

export const KIND_LABEL: Record<SourceKind, string> = {
  local_dir: '服务器目录',
  git: 'Git 仓库',
  web: '网页',
  upload: '文件上传',
  archive: '压缩包',
  note: '手写笔记',
}

export const KIND_ICON: Record<SourceKind, IconName> = {
  local_dir: 'dir',
  git: 'branch',
  web: 'globe',
  upload: 'upload',
  archive: 'archive',
  note: 'edit',
}

/**
 * 服务器目录和 Git 仓库读的是**服务器上**的路径 / 外部仓库,需要 `sources.local` 功能点,是管理员的事,归「管理 → 项目与集合」;
 * 普通用户在「导入」页只处理自己的东西:网页、上传的文件、压缩包、手写笔记。
 */
export const SERVER_KINDS: readonly SourceKind[] = ['local_dir', 'git']
export const USER_KINDS: readonly SourceKind[] = ['web', 'upload', 'archive', 'note']

export const isServerKind = (kind: string): boolean => (SERVER_KINDS as readonly string[]).includes(kind)

/** 按类型筛选:全部 / 网页 / 上传(上传和压缩包算一类) / 笔记。 */
export type SourceFilter = 'all' | 'web' | 'upload' | 'note'
export const SOURCE_FILTERS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'web', label: '网页' },
  { value: 'upload', label: '上传' },
  { value: 'note', label: '笔记' },
]

export function matchesFilter(source: Pick<SourceRow, 'kind'>, filter: SourceFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'upload') return source.kind === 'upload' || source.kind === 'archive'
  return source.kind === filter
}

/** 刷新间隔 → 「每小时 / 每天 / 每周 / 每 N 天 / 每 N 小时 / 每 N 分钟」 */
export function everyLabel(minutes: number): string {
  if (minutes === 60) return '每小时'
  if (minutes === 1440) return '每天'
  if (minutes === 10080) return '每周'
  if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`
  return `每 ${minutes} 分钟`
}

/** 类型列:类型名 + 抓取深度 / 刷新策略(都来自数据源自身的字段;没有的字段不显示) */
export function kindText(source: Pick<SourceRow, 'kind' | 'depth' | 'refresh_minutes' | 'ai_extract'>): string {
  const every = source.refresh_minutes ? everyLabel(source.refresh_minutes) : ''
  const parts: (string | false)[] =
    source.kind === 'local_dir'
      ? ['服务器目录', every ? `${every}同步` : '手动同步']
      : source.kind === 'git'
        ? ['Git 仓库', !!every && `${every}拉取`]
        : source.kind === 'web'
          ? ['网页抓取', source.depth > 0 && `深度 ${source.depth}`, !!every && `${every}刷新`, !!source.ai_extract && 'AI 规范化']
          : source.kind === 'archive'
            ? ['压缩包', '递归解析']
            : [KIND_LABEL[source.kind]]
  return parts.filter(Boolean).join(' · ')
}

/** 状态徽标:同步中 / 出错 / 从未同步 / 已同步 */
export function statusTag(source: Pick<SourceRow, 'status' | 'kind' | 'last_synced_at'>): { tone: 'accent' | 'danger' | 'neutral' | 'success'; text: string } {
  if (source.status === 'syncing') return { tone: 'accent', text: source.kind === 'web' ? '抓取中' : '同步中' }
  if (source.status === 'error') return { tone: 'danger', text: '出错' }
  if (!source.last_synced_at) return { tone: 'neutral', text: '待同步' }
  return { tone: 'success', text: '已同步' }
}

import { clockText, daysAgo, isToday, monthDayText } from './time'

/** 最近同步:进行中 / 从未同步 / 刚刚 / N 分钟前 / N 小时前 / 今天 HH:MM / 昨天 / MM-DD */
export function since(source: Pick<SourceRow, 'status' | 'last_synced_at'>, now = Date.now()): string {
  if (source.status === 'syncing') return '进行中'
  const at = source.last_synced_at
  if (!at) return '从未同步'
  const diff = now - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 6 * 3_600_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  // 站点时区决定哪一天是“今天”;日期文本也按站点时区写,和后台同步记录一致
  if (isToday(at, now)) return `今天 ${clockText(at)}`
  if (daysAgo(at, now) === 1) return '昨天'
  return monthDayText(at, now)
}

/** 解析成功率:(总数 − 失败 − 隔离) / 总数,向下取到 0.1%,有失败时不会显示成 100%;没有文件返回空串。 */
export function successRate(info: { total: number; failed: number; quarantined: number } | null): string {
  if (!info || info.total <= 0) return ''
  const ok = Math.max(0, info.total - info.failed - info.quarantined)
  return `${(Math.floor((ok / info.total) * 1000) / 10).toFixed(1)}%`
}

/** 移除数据源确认文案：本地目录绝不能承诺“文件一起清掉”，否则会误导用户以为源文件也被删。 */
export function removeSourceMessage(kind: SourceKind): string {
  switch (kind) {
    case 'local_dir':
      return '只从知识库移除索引，服务器目录中的原始文件不会被删除。'
    case 'git':
      return '会删除知识库中的仓库副本与索引，不会改动远端仓库。'
    case 'web':
      return '会删除抓取到知识库的网页副本与索引，不会改动源站。'
    default:
      return '它索引出来的块、向量与知识库中的文件都会清掉。'
  }
}

/**
 * 「粘贴网址」入口里用户输入的东西 → 能交给抓取的 http(s) 地址,不是网址返回 null。
 * 没写协议的补 https://(用户常常直接粘贴 docs.example.com/x);只认 http / https,且主机名里要有点
 * (挡掉 hello、javascript:、ftp: 这类)。真正的安全校验(内网地址、重定向)在服务端,这里只管别把明显不是网址的东西提交上去。
 */
export function normalizeWebUrl(text: string): string | null {
  const raw = text.trim()
  if (!raw || /\s/.test(raw)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/]+:\d+(\/|$)/.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname.includes('.')) return null
    return url.toString()
  } catch {
    return null
  }
}
