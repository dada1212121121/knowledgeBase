// 项目与集合页(「项目」卡片和「集合」表)的纯逻辑。
//
// 术语(设计稿):「项目」只指管理员在服务器上登记的代码目录;「集合」是知识库里的一组内容;
// insight → 笔记;collection / 物理表 / 嵌入器 这些词不在界面上出现。
import type { JobSummary, ProjectInfo } from '@/api/client'
import type { StatusRow } from './systemStatus'

/** `list_collections` 的一项(含存储表与迁移目标)。 */
export interface CollectionRow {
  name: string
  kind: string
  project_id: string | null
  embedder_id: string
  dim: number
  active_table: string
  rows: number
  migrating_to: string | null
}

/** `migrate_plan` 的返回。字段都当可能缺失处理。 */
export interface MigrationPlan {
  to_table?: string
  from_embedder?: string
  to_embedder?: string
  rows?: number
  insight_rows?: number
  estimated_seconds?: number
  can_switch_without_reembed?: boolean
}

/** 已知的索引模型(与 config.toml 的 `[embed] model` 取值一致)。 */
export const EMBEDDERS = ['bge-m3-int8', 'bge-m3', 'multilingual-minilm', 'multilingual-e5-base'] as const

const count = (value: number): string => value.toLocaleString('en-US')

// ---------------------------------------------------------------- 项目

/** 最近索引过的项目排前面;没索引过的排最后,同样新的按名字排,顺序稳定。 */
export function sortProjects(projects: ProjectInfo[]): ProjectInfo[] {
  return [...projects].sort((left, right) => (right.project.last_indexed_at ?? 0) - (left.project.last_indexed_at ?? 0) || left.project.name.localeCompare(right.project.name))
}

/** 输入框里的规则:逗号(中英文)和换行都能分隔,去掉空项。 */
export function parseGlobs(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export const globsText = (list: string[]): string => list.join(', ')

/** 卡片上显示的规则:没有就写明白意思,不留空白。 */
export const includeText = (list: string[]): string => (list.length ? list.join('  ') : '全部文件')
export const excludeText = (list: string[]): string => (list.length ? list.join('  ') : '无')

export function projectRows(info: ProjectInfo): StatusRow[] {
  return [
    { key: 'include', label: '只索引这些文件', value: includeText(info.project.include), mono: true },
    { key: 'exclude', label: '不索引这些文件', value: excludeText(info.project.exclude), mono: true },
  ]
}

export function indexedText(lastIndexedAt: number | null | undefined, relative: (at: number) => string): string {
  return lastIndexedAt ? `上次索引 ${relative(lastIndexedAt)}` : '还没有索引过'
}

// ---------------------------------------------------------------- 集合

export function collectionKind(item: Pick<CollectionRow, 'name' | 'kind'>): string {
  if (item.name.endsWith('/code')) return '代码'
  if (item.name.endsWith('/docs')) return '文档'
  if (item.name.endsWith('/insights')) return '笔记'
  return item.kind === 'global' ? '全局' : item.name.startsWith('_global') ? '外部' : '项目'
}

/** `fastembed:bge-m3-int8` → `bge-m3-int8`。 */
export const embedderName = (id: string): string => id.replace(/^fastembed:/, '')

export const modelText = (item: Pick<CollectionRow, 'embedder_id' | 'dim'>): string => `${embedderName(item.embedder_id)} · ${item.dim} 维`

export const totalRows = (collections: CollectionRow[]): number => collections.reduce((sum, item) => sum + item.rows, 0)

export const collectionsSummary = (collections: CollectionRow[]): string => `${collections.length} 个集合 · 共 ${count(totalRows(collections))} 个内容片段`

export const pageSummary = (projects: number, collections: number, embedder: string): string =>
  `${projects} 个项目 · ${collections} 个集合${embedder ? ` · 当前索引模型 ${embedderName(embedder)}` : ''}`

/** 某个集合正在更换索引模型的进度(0–100);没有对应的任务返回 null,任务没有总量时按 0。 */
export function migrationPercent(jobs: JobSummary[], name: string): number | null {
  const job = jobs.find((entry) => entry.kind === 'migrate' && ['running', 'queued'].includes(entry.state) && entry.collection === name)
  if (!job) return null
  return job.progress_total ? Math.min(100, Math.round((job.progress_done / job.progress_total) * 100)) : 0
}

export function statusView(item: CollectionRow, jobs: JobSummary[]): { text: string; tone: 'success' | 'accent'; target: string } {
  if (!item.migrating_to) return { text: '就绪', tone: 'success', target: '' }
  const percent = migrationPercent(jobs, item.name)
  return { text: percent === null ? '更换中' : `更换中 ${percent}%`, tone: 'accent', target: `换成 ${embedderName(item.migrating_to)}` }
}

/** 有集合正在更换索引模型时,页面隔一会儿刷新一次,让进度动起来、完成后状态变回「就绪」。 */
export const hasMigrating = (collections: CollectionRow[]): boolean => collections.some((item) => !!item.migrating_to)

export function deleteCollectionMessage(item: Pick<CollectionRow, 'name' | 'rows'>): string {
  const notes = item.name.endsWith('/insights') ? '这里面的笔记也会一起删除。' : ''
  return `集合里的全部内容(${count(item.rows)} 个片段,含笔记)和它的索引都会删除,不能恢复。${notes}`
}

// ---------------------------------------------------------------- 更换索引模型

/** 估算耗时:不到一分钟写秒,之后写分秒。 */
export function durationText(value: number): string {
  const total = Math.max(0, Math.round(value))
  if (total < 1) return '不到 1 秒'
  if (total < 60) return `约 ${total} 秒`
  const minutes = Math.floor(total / 60)
  return minutes < 60 ? `约 ${minutes} 分 ${total % 60} 秒` : `约 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

/** 估算结果写成「标签 + 值」。新旧模型兼容时不用重新索引,只说切换很快;否则说要处理多少、大概多久。 */
export function planRows(plan: MigrationPlan): StatusRow[] {
  const rows: StatusRow[] = [{ key: 'model', label: '索引模型', value: `${embedderName(plan.from_embedder ?? '—')} → ${embedderName(plan.to_embedder ?? '—')}` }]
  if (plan.can_switch_without_reembed) {
    rows.push({ key: 'reindex', label: '要重新索引吗', help: '新旧模型生成的向量兼容(同一兼容组)', value: '不需要,切换很快', tone: 'success' })
  } else {
    rows.push(
      { key: 'reindex', label: '要重新索引吗', help: '新旧模型不兼容,所有内容都要重新处理一遍', value: '需要', tone: 'warning' },
      { key: 'rows', label: '要处理的内容', value: `${count(plan.rows ?? 0)} 个片段(其中笔记 ${count(plan.insight_rows ?? 0)} 条)` },
      { key: 'time', label: '预计耗时', value: durationText(plan.estimated_seconds ?? 0) },
    )
  }
  rows.push({ key: 'table', label: '新的存储位置', help: '更换完成后才会切换过去,旧的会保留用于回滚', value: plan.to_table ?? '—', mono: true })
  return rows
}

/** 选的模型和当前一样,不需要更换。 */
export const sameModel = (collection: Pick<CollectionRow, 'embedder_id'>, target: string): boolean => embedderName(collection.embedder_id) === target

// ---------------------------------------------------------------- 项目卡片上的开关

export interface SwitchRow {
  key: 'hooks' | 'cloud' | 'extract'
  label: string
  help: string
  on: boolean
  /** 开关不可用(置灰,点击无反应);必须同时给 `note`,让人看得见为什么不能点 */
  disabled?: boolean
  /** 开关下方的补充说明(目前只有「不可用的原因」) */
  note?: string
}

/** 非 git 目录没有 `.git/hooks`,装不了提交钩子;后端 `HookManager::open` 也会拒绝,所以界面直接置灰。 */
export const HOOKS_NOT_GIT_NOTE = '这个目录不是 git 仓库,没有可装的提交钩子。'

/**
 * 仓库把 `core.hooksPath` 指到别处(husky 等)时,后端不去改那个目录、返回 `managed_by_other`,
 * 此时并没有装上任何钩子,不能再弹「已开启」。
 */
export const HOOKS_MANAGED_BY_OTHER_TEXT =
  '这个仓库的 hooks 目录由别的工具托管(core.hooksPath),kb 没有改动它。要自动索引,请在 post-commit 等钩子里手动加一行通知命令。'

/** 开启「提交后自动索引」前的确认文案:装哪些钩子、对原有钩子怎么处理、会不会外发、第一次触发做什么。 */
export const HOOKS_ENABLE_MESSAGE =
  '会在这个 git 仓库写入 post-commit、post-merge、post-checkout、post-rewrite 四个钩子。' +
  '仓库里原有的同名钩子先备份为 .kb-orig,再链式调用。钩子只通知本机守护进程,不调用大模型。' +
  '开启后第一次触发会全量扫描一次,没变的文件按哈希跳过。'

/**
 * 项目卡片上的开关。「提交后自动索引」谁都有;「允许发给云端模型」「自动提炼」是 AI 功能,
 * AI 总开关关掉后这两行整行不出现(值保持原样,保存时照原值提交)。
 *
 * 「提交后自动索引」只对 git 仓库有意义:`is_git` 为 false 时置灰并写明原因。
 */
export function projectSwitches(info: ProjectInfo, aiEnabled: boolean): SwitchRow[] {
  const rows: SwitchRow[] = [
    {
      key: 'hooks',
      label: '提交后自动索引',
      help: '每次 git 提交、合并或切换分支后自动更新索引(会在仓库里写入 git 钩子)。',
      on: info.project.hooks_installed,
      ...(info.project.is_git ? {} : { disabled: true, note: HOOKS_NOT_GIT_NOTE }),
    },
  ]
  if (aiEnabled) {
    rows.push(
      { key: 'cloud', label: '允许发给云端模型', help: '允许把这个项目的代码片段发给云端模型,用于自动提炼(allow_cloud_llm)。', on: info.project.allow_cloud_llm },
      { key: 'extract', label: '自动提炼', help: '提交或会话结束后自动整理出候选笔记,放进审核收件箱(extract_enabled)。需先允许发给云端模型。', on: info.project.extract_enabled },
    )
  }
  return rows
}
