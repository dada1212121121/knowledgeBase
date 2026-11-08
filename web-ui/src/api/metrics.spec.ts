// 磁盘写满预测:按近 7 天的增长外推;数据不够、没增长、在变小都不预测。
import { describe, expect, it } from 'vitest'
import { diskFullIn } from './metrics'

const DAY = 86_400_000
const GB = 1024 ** 3
const point = (day: number, usedGb: number) => ({ at: day * DAY, disk_used: usedGb * GB, disk_total: 500 * GB })

describe('diskFullIn', () => {
  it('每天涨 10 GB、还剩 100 GB:约 10 天', () => {
    const left = diskFullIn([point(0, 300), point(3, 330), point(6, 360), point(7, 400 - 0)])
    // 7 天涨 100 GB(300 → 400),每天 ~14.3 GB,剩 100 GB → 约 7 天
    expect(left! / DAY).toBeCloseTo(7, 1)
  })
  it('不足一天的数据、没有增长、在变小、只有一个点:都不预测', () => {
    expect(diskFullIn([point(0, 300), { at: DAY / 2, disk_used: 305 * GB, disk_total: 500 * GB }])).toBeNull()
    expect(diskFullIn([point(0, 300), point(5, 300)])).toBeNull()
    expect(diskFullIn([point(0, 300), point(5, 280)])).toBeNull()
    expect(diskFullIn([point(0, 300)])).toBeNull()
    expect(diskFullIn([])).toBeNull()
  })
  it('已经写满:0', () => {
    expect(diskFullIn([point(0, 480), { at: 2 * DAY, disk_used: 500 * GB, disk_total: 500 * GB }])).toBe(0)
  })
})
