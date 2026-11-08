import { describe, expect, it } from 'vitest'
import { DISK_ALERT_RATIO, buildSystemAlerts } from './systemAlerts'

const failure = { at: 1_790_000_000_000, trigger: 'auto' as const, kind: 'pack' as const, error: '磁盘写满' }
const base = { privileged: true, online: true, backup: null, diskUsedRatio: 0.5 }

describe('buildSystemAlerts', () => {
  it('一切正常没有告警', () => {
    expect(buildSystemAlerts(base)).toEqual([])
  })
  it('没有系统功能的账号永远没有告警(不暴露服务器内部状态)', () => {
    expect(buildSystemAlerts({ privileged: false, online: false, backup: failure, diskUsedRatio: 0.99 })).toEqual([])
  })
  it('后台连不上', () => {
    expect(buildSystemAlerts({ ...base, online: false }).map((item) => item.id)).toEqual(['offline'])
  })
  it('备份失败带上原因', () => {
    const [alert] = buildSystemAlerts({ ...base, backup: failure })
    expect(alert?.id).toBe('backup')
    expect(alert?.text).toContain('磁盘写满')
  })
  it('磁盘到阈值才告警,文案是整数百分比', () => {
    expect(buildSystemAlerts({ ...base, diskUsedRatio: DISK_ALERT_RATIO - 0.01 })).toEqual([])
    const [alert] = buildSystemAlerts({ ...base, diskUsedRatio: 0.953 })
    expect(alert?.text).toContain('95%')
  })
  it('拿不到磁盘数据时不告警', () => {
    expect(buildSystemAlerts({ ...base, diskUsedRatio: null })).toEqual([])
  })
  it('多个原因都列出来,顺序固定', () => {
    expect(buildSystemAlerts({ privileged: true, online: false, backup: failure, diskUsedRatio: 0.95 }).map((item) => item.id)).toEqual(['offline', 'backup', 'disk'])
  })
})
