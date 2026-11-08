import { localeDateTime } from './time'
// 备份的展示逻辑(纯函数,便于单测):打包进度、失败告警、异地副本与校验结果的文案。
//
// 数据形状来自后端 `kb-service::backup`:
// - `BackupProgress`:WS 的 `backup.progress` 与 `backup_state.running` 都是它;
// - `BackupFailure`:`backup_state.alert` / `backup.failures` 与 WS 的 `backup.failed`;
// - `MirrorStatus`:`backup_status.mirrors`(异地 / 外部存储目录);
// - `LastCheck`:`backup_status.last_check`(备份写完后自动跑的那次校验);
// - `ArchiveCheck`:`backup_verify` 的返回(手工点「校验」)。
// WS 在比对环境里连不上,所以把这些判断抽成纯函数单独测。

/** 打包阶段(与后端 `BackupStage` 的 serde 短名一致)。 */
export type BackupStage = 'preparing' | 'packing' | 'mirroring' | 'verifying' | 'done' | 'failed'

/** 打包进度。 */
export interface BackupProgress {
  stage: BackupStage
  started_at: number
  updated_at: number
  files_total: number
  files_done: number
  bytes_total: number
  bytes_done: number
  current: string | null
  error?: string | null
}

/** 失败发生在哪一环(与后端 `BackupFailureKind` 一致)。 */
export type BackupFailureKind = 'pack' | 'prune' | 'mirror' | 'verify'

/** 一次失败的备份 / 清理 / 异地复制。 */
export interface BackupFailure {
  at: number
  trigger: 'auto' | 'manual'
  /** 旧后端没有这个字段,按“打包”处理。 */
  kind?: BackupFailureKind
  error: string
}

/** 一个异地目录的现状(`backup_status.mirrors`)。 */
export interface MirrorStatus {
  dir: string
  last_ok_at: number
  last_error: string | null
  error_at: number
  copies: number
  /** 目录里有没有最新那份归档(验收:异地副本跟不跟得上)。 */
  has_latest: boolean
}

/** 最近一次**自动校验**的结果(`backup_status.last_check`)。 */
export interface LastCheck {
  /** 校验时间(unix 毫秒)。 */
  at: number
  /** 被校验的归档名。 */
  name: string
  ok: boolean
  /** 没通过的原因(通过时为 null)。 */
  error?: string | null
  files: number
  uncompressed_bytes: number
  meta_db_bytes: number
}

/** `backup_verify` 的返回。 */
export interface ArchiveCheck {
  name: string
  size_bytes: number
  created_at: number
  version: string
  include_sources: boolean
  files: number
  uncompressed_bytes: number
  meta_db_bytes: number
  config_present: boolean
  skipped: string[]
  roots: string[]
}

/** 阶段名(与后端 `BackupStage::label` 一致)。 */
export function stageLabel(stage: BackupStage): string {
  switch (stage) {
    case 'preparing':
      return '准备中'
    case 'packing':
      return '打包中'
    case 'mirroring':
      return '复制中'
    case 'verifying':
      return '校验中'
    case 'done':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return stage
  }
}

/** 是否还在进行中(准备 / 打包 / 复制到异地 / 校验)。 */
export function isRunning(stage: BackupStage): boolean {
  return stage === 'preparing' || stage === 'packing' || stage === 'mirroring' || stage === 'verifying'
}

/**
 * 完成百分比(0..100)。
 *
 * 与后端 `BackupProgress::percent` 同一口径:优先按字节,字节总量还不知道时退回按文件数。
 * 进度条宽度需要整数,所以在这里就取整。
 */
export function progressPercent(progress: BackupProgress): number {
  let ratio = 0
  if (progress.bytes_total > 0) ratio = progress.bytes_done / progress.bytes_total
  else if (progress.files_total > 0) ratio = progress.files_done / progress.files_total
  if (!Number.isFinite(ratio)) return 0
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100)
}

/** 一行进度说明:`打包中 42% · 3/7 个文件 · 1.2 MB/4.8 MB`。 */
export function progressText(progress: BackupProgress, size: (bytes: number) => string): string {
  const parts = [`${stageLabel(progress.stage)} ${progressPercent(progress)}%`]
  if (progress.files_total > 0) {
    parts.push(`${progress.files_done}/${progress.files_total} 个文件`)
  }
  if (progress.bytes_total > 0) {
    parts.push(`${size(progress.bytes_done)}/${size(progress.bytes_total)}`)
  }
  return parts.join(' · ')
}

/** 触发方式的人话。 */
export function triggerLabel(trigger: BackupFailure['trigger']): string {
  return trigger === 'auto' ? '定时备份' : '手动备份'
}

/** 失败环节的人话(打包 / 清理 / 异地副本 / 校验)。 */
export function failureKindLabel(kind: BackupFailureKind | undefined): string {
  switch (kind) {
    case 'prune':
      return '清理'
    case 'mirror':
      return '异地副本'
    case 'verify':
      return '校验'
    default:
      return '备份'
  }
}

/**
 * 一条失败告警的说明:`定时备份在 2026-10-24 10:15 失败:…`。
 *
 * 清理 / 异地副本的失败也要说清是哪一环,否则横幅上只有一句“失败”看不出严重程度:
 * `定时备份的清理在 … 失败:…`。
 */
export function failureText(failure: BackupFailure): string {
  const at = when(failure.at)
  const kind = failure.kind ?? 'pack'
  const subject = kind === 'pack' ? triggerLabel(failure.trigger) : `${triggerLabel(failure.trigger)}的${failureKindLabel(kind)}`
  return `${subject}在 ${at} 失败:${failure.error}`
}

/**
 * 一个异地目录的现状说明。
 *
 * `has_latest` 才是“副本跟不跟得上”的判据:目录里有一堆旧归档但缺最新那份,等于没备份。
 */
export function mirrorText(mirror: MirrorStatus): string {
  const parts = [`${mirror.copies} 份`, mirror.has_latest ? '最新一份已在' : '最新一份不在']
  // 时间取更近的那一次:失败之后还说“上次复制 …”会让人以为刚刚复制成功
  if (mirror.error_at > mirror.last_ok_at && mirror.error_at > 0) {
    parts.push(`失败于 ${when(mirror.error_at)}`)
  } else if (mirror.last_ok_at > 0) {
    parts.push(`上次复制 ${when(mirror.last_ok_at)}`)
  } else {
    parts.push('还没复制过')
  }
  return parts.join(' · ')
}

/** 校验结果的摘要(成功时用):`8 个文件 · 解压后 1.2 MB · 元数据库 512 KB`。 */
export function checkSummary(check: ArchiveCheck, size: (bytes: number) => string): string {
  return `${check.files} 个文件 · 解压后 ${size(check.uncompressed_bytes)} · 元数据库 ${size(check.meta_db_bytes)}`
}

/**
 * 最近一次**自动校验**的说明:哪一份、什么时候、验出了什么。
 *
 * 结论(通过 / 没通过)由徽标给,这里只补细节;没通过时把原因原样带出来 ——
 * 一份解不开的备份等于没有备份,不能只显示一个红点。
 */
export function lastCheckText(check: LastCheck, size: (bytes: number) => string): string {
  const at = when(check.at)
  if (!check.ok) return `${check.name} · ${at} · ${check.error ?? '未知原因'}`
  return `${check.name} · ${at} · ${check.files} 个文件 · 解压后 ${size(check.uncompressed_bytes)}`
}

/**
 * 一次备份有了结果(成功或失败)时广播的窗口事件。
 *
 * 设置页点完「立即备份」就派发它,外壳收到后重读 `backup_state` —— 横幅能立刻撤掉,
 * 不必等 15 秒的常规刷新(WS 可用时另有 `backup.done` 事件)。
 */
export const BACKUP_SETTLED_EVENT = 'kb:backup-settled'

/** 广播「备份有结果了」。 */
export function notifyBackupSettled() {
  window.dispatchEvent(new CustomEvent(BACKUP_SETTLED_EVENT))
}

// ---------------------------------------------------------------- 设置页「备份」分区用的形状与文案

/** 一份已有备份(`backup_status.entries`;只有 `backup_create` 的返回带 `skipped`)。 */
export interface BackupEntry {
  name: string
  size_bytes: number
  created_at: number
  skipped?: number
}

/** 各部分占用的字节数(解释“这次备份会有多大”)。 */
export interface BackupUsage {
  meta_db_bytes: number
  lance_bytes: number
  sources_bytes: number
  uploads_bytes: number
  skills_bytes: number
  eval_bytes: number
  config_bytes: number
  backups_bytes: number
}

/** `[backup]`:定时备份与保留策略(最新一份永远保留)。 */
export interface BackupPolicy {
  enabled: boolean
  interval_hours: number
  keep_count: number
  keep_days: number
  include_sources: boolean
  mirror_dirs: string[]
}

/** `backup_status` 的返回。 */
export interface BackupStatus {
  home: string
  dir: string
  entries: BackupEntry[]
  last_backup_at: number | null
  policy: BackupPolicy
  next_backup_at: number | null
  last_auto: { at: number; ok: boolean; error: string | null } | null
  progress: BackupProgress | null
  alert: BackupFailure | null
  failures: BackupFailure[]
  mirrors: MirrorStatus[]
  last_check: LastCheck | null
  usage: BackupUsage
  notes: string[]
}

/** 保留策略的人话。 */
export function retentionText(policy?: Pick<BackupPolicy, 'keep_count' | 'keep_days'>): string {
  if (!policy || (!policy.keep_count && !policy.keep_days)) return '不自动清理'
  if (!policy.keep_days) return `留最近 ${policy.keep_count} 份`
  if (!policy.keep_count) return `只留 ${policy.keep_days} 天内的`
  return `留最近 ${policy.keep_count} 份且 ${policy.keep_days} 天内的`
}

// 备份记录 / 告警里的时间按站点时区显示,和归档文件名一致
const when = (at: number) => localeDateTime(at, { hour12: false })

/**
 * 「当前生效」的一句话:定时备份与保留策略只在这一处说一遍
 * (以前顶部状态、策略卡片、归档表副标题三处各说一遍)。
 */
export function policySummary(policy: BackupPolicy | undefined, nextAt: number | null): string {
  if (!policy) return ''
  const retention = `保留策略:${retentionText(policy)}${policy.keep_count || policy.keep_days ? ',最新一份永远保留' : ''}`
  if (!policy.enabled) return `定时备份已关闭;${retention}`
  return `每 ${policy.interval_hours} 小时备份一次${nextAt ? `,下次 ${when(nextAt)}` : ''};${retention}`
}

/** 备份会带上哪些、不带哪些,以及这次大约多大(取代一排 7 个大小徽标)。 */
export function usageSummary(usage: BackupUsage | undefined, includeSources: boolean, size: (bytes: number) => string): { included: string; excluded: string; total: string } {
  const u: BackupUsage = usage ?? { meta_db_bytes: 0, lance_bytes: 0, sources_bytes: 0, uploads_bytes: 0, skills_bytes: 0, eval_bytes: 0, config_bytes: 0, backups_bytes: 0 }
  const parts = [`元数据库 ${size(u.meta_db_bytes)}`, `配置 ${size(u.config_bytes)}`, `skills ${size(u.skills_bytes)}`, `评测 ${size(u.eval_bytes)}`]
  const core = u.meta_db_bytes + u.config_bytes + u.skills_bytes + u.eval_bytes
  if (includeSources) parts.push(`原件 ${size(u.sources_bytes)}`)
  return {
    included: parts.join(' · '),
    excluded: `向量表 ${size(u.lance_bytes)}(重建索引即可恢复)${includeSources ? '' : `、原件 ${size(u.sources_bytes)}(没勾选)`}`,
    total: size(includeSources ? core + u.sources_bytes : core),
  }
}

export interface RestoreStep {
  title: string
  detail: string
  command: string
}

/**
 * 恢复步骤(停服 → 校验 → 解包 → 启动)。
 *
 * 命令里带上真实的数据目录 / 归档目录,用户复制就能改;`kb backup` 故意不提供破坏性的
 * `restore` 子命令,完整说明见 `docs/BACKUP_RESTORE.md`。
 */
export function restoreSteps(home = '$KB_HOME', dir = '$KB_HOME/backups', newest = 'kb-<时间>.tar.gz'): RestoreStep[] {
  return [
    { title: '停掉守护进程', detail: '恢复期间不能有进程在写 meta.db;用 systemd 托管时 unit 名见 `kb service status`。', command: 'systemctl stop kb.service' },
    { title: '先留一份当前数据', detail: '恢复失败时用它回滚,别在“要不要恢复”上赌。', command: 'kb backup create' },
    { title: '校验归档', detail: '解压一遍检查 gzip 校验和、tar 头、manifest 与 meta.db;坏归档不要拿去恢复。', command: `kb backup verify ${newest}` },
    { title: '解包到临时目录', detail: '先解到别处看一眼,不要直接覆盖数据目录。', command: `mkdir -p /tmp/kb-restore && tar -xzf ${dir}/${newest} -C /tmp/kb-restore --no-same-owner` },
    { title: '覆盖数据目录', detail: '删掉旧的 WAL / SHM 再覆盖;secrets.toml 不在归档里,保持原样。', command: `rm -f ${home}/meta.db-wal ${home}/meta.db-shm && cp -a /tmp/kb-restore/. ${home}/` },
    { title: '启动并自检', detail: '健康检查通过后按需重建索引(向量表不在归档里,重建即可恢复)。', command: 'systemctl start kb.service && kb doctor' },
  ]
}
