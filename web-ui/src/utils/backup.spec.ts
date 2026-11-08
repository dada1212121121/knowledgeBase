import { describe, expect, it } from 'vitest'
import {
  checkSummary,
  failureKindLabel,
  failureText,
  isRunning,
  lastCheckText,
  mirrorText,
  policySummary,
  progressPercent,
  progressText,
  restoreSteps,
  retentionText,
  stageLabel,
  triggerLabel,
  usageSummary,
  type BackupPolicy,
  type BackupProgress,
  type LastCheck,
  type MirrorStatus,
} from './backup'

const size = (bytes: number) => `${bytes} B`

function progress(patch: Partial<BackupProgress> = {}): BackupProgress {
  return {
    stage: 'packing',
    started_at: 1_792_860_000_000,
    updated_at: 1_792_860_001_000,
    files_total: 4,
    files_done: 1,
    bytes_total: 1000,
    bytes_done: 250,
    current: 'meta.db',
    ...patch,
  }
}

describe('progressPercent', () => {
  it('有字节总量时按字节算', () => {
    expect(progressPercent(progress())).toBe(25)
  })

  it('字节总量还不知道时退回按文件数', () => {
    expect(progressPercent(progress({ bytes_total: 0 }))).toBe(25)
  })

  it('什么都不知道时是 0,不出现 NaN', () => {
    expect(progressPercent(progress({ bytes_total: 0, files_total: 0 }))).toBe(0)
  })

  it('超过总量夹到 100,负数夹到 0', () => {
    expect(progressPercent(progress({ bytes_done: 9999 }))).toBe(100)
    expect(progressPercent(progress({ bytes_done: -10 }))).toBe(0)
  })
})

describe('progressText', () => {
  it('带上阶段、百分比、文件数与字节数', () => {
    expect(progressText(progress(), size)).toBe('打包中 25% · 1/4 个文件 · 250 B/1000 B')
  })

  it('还没收集到文件清单时只说阶段', () => {
    expect(
      progressText(progress({ stage: 'preparing', files_total: 0, bytes_total: 0 }), size),
    ).toBe('准备中 0%')
  })
})

describe('阶段与触发方式', () => {
  it('阶段名与后端一致', () => {
    expect(stageLabel('preparing')).toBe('准备中')
    expect(stageLabel('packing')).toBe('打包中')
    expect(stageLabel('mirroring')).toBe('复制中')
    expect(stageLabel('verifying')).toBe('校验中')
    expect(stageLabel('done')).toBe('已完成')
    expect(stageLabel('failed')).toBe('失败')
  })

  it('准备 / 打包 / 复制到异地 / 校验都算进行中', () => {
    expect(isRunning('preparing')).toBe(true)
    expect(isRunning('packing')).toBe(true)
    // 复制阶段没做完时页面不该收起进度条(几 GB 的归档要拷一会儿)
    expect(isRunning('mirroring')).toBe(true)
    // 校验要解压一遍,大归档也要几秒:这段时间同样不能说“已完成”
    expect(isRunning('verifying')).toBe(true)
    expect(isRunning('done')).toBe(false)
    expect(isRunning('failed')).toBe(false)
  })

  it('触发方式区分定时与手动', () => {
    expect(triggerLabel('auto')).toBe('定时备份')
    expect(triggerLabel('manual')).toBe('手动备份')
  })
})

describe('failureText', () => {
  it('说明谁在什么时候失败、原因是什么', () => {
    const text = failureText({
      at: Date.UTC(2026, 9, 24, 2, 15),
      trigger: 'auto',
      error: '磁盘写满',
    })
    expect(text).toContain('定时备份在')
    expect(text).toContain('2026')
    expect(text).toContain('10:15')
    expect(text).toContain('磁盘写满')
  })

  it('清理 / 异地副本的失败要说清是哪一环', () => {
    const at = Date.UTC(2026, 9, 24, 2, 15)
    expect(failureText({ at, trigger: 'auto', kind: 'prune', error: '只读文件系统' })).toContain(
      '定时备份的清理在',
    )
    expect(
      failureText({ at, trigger: 'manual', kind: 'mirror', error: '建目录失败' }),
    ).toContain('手动备份的异地副本在')
    // 自动校验没过:一份解不开的备份等于没有备份,横幅上要说清是「校验」这一环
    expect(failureText({ at, trigger: 'auto', kind: 'verify', error: '归档里没有 meta.db' })).toContain(
      '定时备份的校验在',
    )
    // 旧后端没有 kind:按打包处理,句子与之前一致
    expect(failureText({ at, trigger: 'manual', error: '同名备份已存在' })).toContain('手动备份在')
  })

  it('环节名与后端一致', () => {
    expect(failureKindLabel('pack')).toBe('备份')
    expect(failureKindLabel('prune')).toBe('清理')
    expect(failureKindLabel('mirror')).toBe('异地副本')
    expect(failureKindLabel('verify')).toBe('校验')
    expect(failureKindLabel(undefined)).toBe('备份')
  })
})

describe('mirrorText', () => {
  const mirror = (patch: Partial<MirrorStatus> = {}): MirrorStatus => ({
    dir: '/mnt/usb/kb-backups',
    last_ok_at: Date.UTC(2026, 9, 24, 2, 15),
    last_error: null,
    error_at: 0,
    copies: 3,
    has_latest: true,
    ...patch,
  })

  it('同步到位时说份数与上次复制时间', () => {
    const text = mirrorText(mirror())
    expect(text).toContain('3 份')
    expect(text).toContain('最新一份已在')
    expect(text).toContain('上次复制')
  })

  it('缺最新那份时明确说出来(有一堆旧归档也算没备份)', () => {
    expect(mirrorText(mirror({ has_latest: false }))).toContain('最新一份不在')
  })

  it('从没复制过时不显示假的复制时间', () => {
    const text = mirrorText(mirror({ last_ok_at: 0, copies: 0, has_latest: false }))
    expect(text).toContain('还没复制过')
    expect(text).not.toContain('上次复制')
  })

  it('失败比上次成功更近时说的是失败时间,不冒充“上次复制”', () => {
    const text = mirrorText(
      mirror({
        has_latest: false,
        last_ok_at: Date.UTC(2026, 9, 20, 0, 0),
        error_at: Date.UTC(2026, 9, 24, 2, 15),
        last_error: '建目录失败',
      }),
    )
    expect(text).toContain('失败于')
    expect(text).not.toContain('上次复制')
  })
})

describe('checkSummary', () => {
  it('列出文件数、解压后大小与元数据库大小', () => {
    const summary = checkSummary(
      {
        name: 'kb-1.tar.gz',
        size_bytes: 120,
        created_at: 1,
        version: '0.4.0',
        include_sources: false,
        files: 8,
        uncompressed_bytes: 2048,
        meta_db_bytes: 1024,
        config_present: true,
        skipped: [],
        roots: ['meta.db'],
      },
      size,
    )
    expect(summary).toBe('8 个文件 · 解压后 2048 B · 元数据库 1024 B')
  })
})

describe('lastCheckText', () => {
  const check = (patch: Partial<LastCheck> = {}): LastCheck => ({
    at: Date.UTC(2026, 9, 24, 2, 15),
    name: 'kb-20261024-101500.tar.gz',
    ok: true,
    error: null,
    files: 8,
    uncompressed_bytes: 2048,
    meta_db_bytes: 1024,
    ...patch,
  })

  it('通过时说明是哪一份、什么时候、验出多少内容', () => {
    const text = lastCheckText(check(), size)
    expect(text).toContain('kb-20261024-101500.tar.gz')
    expect(text).toContain('10:15')
    expect(text).toContain('8 个文件')
    expect(text).toContain('2048 B')
  })

  it('没通过时把原因带出来,不显示“0 个文件”这种假细节', () => {
    const text = lastCheckText(
      check({
        ok: false,
        error: '归档校验失败:归档里没有 meta.db(不是 kb 备份?)',
        files: 0,
        uncompressed_bytes: 0,
        meta_db_bytes: 0,
      }),
      size,
    )
    expect(text).toContain('归档里没有 meta.db')
    expect(text).not.toContain('个文件')
  })

  it('原因缺失时也不留空', () => {
    expect(lastCheckText(check({ ok: false, error: null }), size)).toContain('未知原因')
  })
})

describe('retentionText', () => {
  it('份数 / 天数 / 都有 / 都没有', () => {
    expect(retentionText({ keep_count: 7, keep_days: 0 })).toBe('留最近 7 份')
    expect(retentionText({ keep_count: 0, keep_days: 30 })).toBe('只留 30 天内的')
    expect(retentionText({ keep_count: 7, keep_days: 30 })).toBe('留最近 7 份且 30 天内的')
    expect(retentionText({ keep_count: 0, keep_days: 0 })).toBe('不自动清理')
    expect(retentionText(undefined)).toBe('不自动清理')
  })
})

describe('policySummary', () => {
  const policy: BackupPolicy = { enabled: true, interval_hours: 24, keep_count: 7, keep_days: 0, include_sources: false, mirror_dirs: [] }

  it('开着:间隔 + 下次时间 + 保留策略,只说一遍', () => {
    const text = policySummary(policy, 1_792_860_000_000)
    expect(text).toContain('每 24 小时备份一次,下次 ')
    expect(text).toContain('保留策略:留最近 7 份,最新一份永远保留')
  })

  it('开着但没有下次时间(还没排上):不写“下次”', () => {
    expect(policySummary(policy, null)).toBe('每 24 小时备份一次;保留策略:留最近 7 份,最新一份永远保留')
  })

  it('关闭:明说已关闭,保留策略照样写(手动备份也按它清理)', () => {
    expect(policySummary({ ...policy, enabled: false }, null)).toBe('定时备份已关闭;保留策略:留最近 7 份,最新一份永远保留')
  })

  it('不自动清理时不写“最新一份永远保留”(没有清理就谈不上)', () => {
    expect(policySummary({ ...policy, keep_count: 0 }, null)).toBe('每 24 小时备份一次;保留策略:不自动清理')
  })

  it('没有策略(还没读到):空', () => {
    expect(policySummary(undefined, null)).toBe('')
  })
})

describe('usageSummary', () => {
  const usage = { meta_db_bytes: 100, lance_bytes: 900, sources_bytes: 50, uploads_bytes: 0, skills_bytes: 10, eval_bytes: 20, config_bytes: 5, backups_bytes: 300 }

  it('默认不含原件:合计 = 元数据库 + 配置 + skills + 评测;原件写在“不备份”里', () => {
    const summary = usageSummary(usage, false, size)
    expect(summary.total).toBe('135 B')
    expect(summary.included).toBe('元数据库 100 B · 配置 5 B · skills 10 B · 评测 20 B')
    expect(summary.excluded).toBe('向量表 900 B(重建索引即可恢复)、原件 50 B(没勾选)')
  })

  it('勾选原件:原件进合计,不再出现在“不备份”里', () => {
    const summary = usageSummary(usage, true, size)
    expect(summary.total).toBe('185 B')
    expect(summary.included).toContain('原件 50 B')
    expect(summary.excluded).toBe('向量表 900 B(重建索引即可恢复)')
  })

  it('还没读到占用:全是 0,不报错', () => {
    expect(usageSummary(undefined, false, size).total).toBe('0 B')
  })
})

describe('restoreSteps', () => {
  it('六步,顺序是停服 → 留一份 → 校验 → 解包 → 覆盖 → 启动', () => {
    expect(restoreSteps().map((step) => step.title)).toEqual(['停掉守护进程', '先留一份当前数据', '校验归档', '解包到临时目录', '覆盖数据目录', '启动并自检'])
  })

  it('命令里带上真实的数据目录、归档目录和最新一份归档', () => {
    const steps = restoreSteps('/data/kb', '/data/kb/backups', 'kb-20261020.tar.gz')
    expect(steps[2]!.command).toBe('kb backup verify kb-20261020.tar.gz')
    expect(steps[3]!.command).toContain('tar -xzf /data/kb/backups/kb-20261020.tar.gz')
    expect(steps[4]!.command).toBe('rm -f /data/kb/meta.db-wal /data/kb/meta.db-shm && cp -a /tmp/kb-restore/. /data/kb/')
  })

  it('覆盖前一定先删旧的 WAL / SHM(否则旧日志会盖回恢复的库)', () => {
    expect(restoreSteps()[4]!.command.indexOf('meta.db-wal')).toBeLessThan(restoreSteps()[4]!.command.indexOf('cp -a'))
  })
})
