import { describe, expect, it } from 'vitest'
import type { LlmUsageRow, StorageOverview, StorageRow } from '@/api/usage'
import {
  alertCounts,
  barPercent,
  diskLevel,
  filterStorage,
  isDay,
  levelOf,
  llmAlertCounts,
  llmPurposeLabel,
  ownerHandle,
  ownerName,
  PART_LABELS,
  partsOf,
  percentText,
  quotaText,
  shiftDay,
  sortStorage,
  tokensText,
  siteDay,
  vectorShare,
} from './usage'

const GB = 1024 ** 3
const row = (extra: Partial<StorageRow> = {}): StorageRow => ({
  space_id: 'sp_1',
  owner_id: 'usr_1',
  username: 'alice',
  display_name: 'Alice',
  sources_bytes: 0,
  uploads_bytes: 0,
  vectors_bytes: 0,
  meta_bytes: 0,
  workspace_bytes: 0,
  total_bytes: 0,
  measured_at: 1000,
  limit_bytes: 100 * GB,
  ...extra,
})

describe('levelOf:告警线在 90% 与 100%', () => {
  it('刚好卡在边界上的值落在哪一边', () => {
    expect(levelOf(89, 100)).toBe('ok')
    expect(levelOf(90, 100)).toBe('warn')
    expect(levelOf(99, 100)).toBe('warn')
    expect(levelOf(100, 100)).toBe('over')
    expect(levelOf(101, 100)).toBe('over')
    // 真实字节数:90 GB / 100 GB 正好是 90%
    expect(levelOf(90 * GB, 100 * GB)).toBe('warn')
    expect(levelOf(90 * GB - 1, 100 * GB)).toBe('ok')
  })

  it('上限为 0 是「不限」,用了多少都不告警', () => {
    expect(levelOf(5 * GB, 0)).toBe('unlimited')
    expect(levelOf(0, 0)).toBe('unlimited')
  })
})

describe('使用率文字与进度条', () => {
  it('取整的百分比;有占用却不足 1% 写 <1%;不限不显示百分比', () => {
    expect(percentText(64 * GB, 100 * GB)).toBe('64%')
    expect(percentText(1, 100 * GB)).toBe('<1%')
    expect(percentText(0, 100 * GB)).toBe('0%')
    expect(percentText(5 * GB, 0)).toBe('')
  })

  it('进度条封顶 100,不限和空占用都是 0', () => {
    expect(barPercent(50, 100)).toBe(50)
    expect(barPercent(250, 100)).toBe(100)
    expect(barPercent(10, 0)).toBe(0)
    expect(barPercent(0, 100)).toBe(0)
  })
})

describe('占用分项', () => {
  it('原件 = 原始文件 + 还没处理完的上传分片;笔记是元数据库', () => {
    const parts = partsOf({ sources_bytes: 3, uploads_bytes: 4, vectors_bytes: 5, meta_bytes: 6, workspace_bytes: 7 })
    expect(parts).toEqual({ notes: 6, originals: 7, vectors: 5, workspace: 7 })
  })
})

describe('名字', () => {
  it('昵称优先,再用户名,账号被删了也要有个说法', () => {
    expect(ownerName(row())).toBe('Alice')
    expect(ownerName(row({ display_name: '  ' }))).toBe('alice')
    expect(ownerName(row({ display_name: null, username: null }))).toBe('已删除的账号')
    expect(ownerHandle(row())).toBe('@alice')
    expect(ownerHandle(row({ username: null }))).toBe('')
  })
})

describe('排序', () => {
  const rows = [
    row({ owner_id: 'a', username: 'amy', display_name: 'Amy', total_bytes: 10 * GB, vectors_bytes: 2 * GB, measured_at: 30 }),
    row({ owner_id: 'b', username: 'bob', display_name: 'Bob', total_bytes: 95 * GB, vectors_bytes: 9 * GB, measured_at: 10 }),
    row({ owner_id: 'c', username: 'cat', display_name: 'Cat', total_bytes: 40 * GB, vectors_bytes: 1 * GB, measured_at: 20, limit_bytes: 0 }),
  ]
  const ids = (list: StorageRow[]) => list.map((item) => item.owner_id).join('')

  it('按总占用、向量索引、统计时间,升降序都对', () => {
    expect(ids(sortStorage(rows, 'total', true))).toBe('bca')
    expect(ids(sortStorage(rows, 'total', false))).toBe('acb')
    expect(ids(sortStorage(rows, 'vectors', true))).toBe('bac')
    expect(ids(sortStorage(rows, 'measured', false))).toBe('bca')
  })

  it('按使用率:快满的在前,没有上限的人排最后', () => {
    expect(ids(sortStorage(rows, 'ratio', true))).toBe('bac')
  })

  it('按名字排,不改原数组', () => {
    const before = ids(rows)
    expect(ids(sortStorage(rows, 'name', false))).toBe('abc')
    expect(ids(rows)).toBe(before)
  })

  it('同值时按名字稳定排', () => {
    const tie = [row({ owner_id: 'z', display_name: 'Zed' }), row({ owner_id: 'a', display_name: 'Abe' })]
    expect(ids(sortStorage(tie, 'total', true))).toBe('az')
  })
})

describe('筛选与告警计数', () => {
  const rows = [
    row({ owner_id: 'a', username: 'amy', display_name: '艾米', total_bytes: 10 * GB }),
    row({ owner_id: 'b', username: 'bob', display_name: 'Bob', total_bytes: 95 * GB }),
    row({ owner_id: 'c', username: 'cat', display_name: 'Cat', total_bytes: 120 * GB }),
    row({ owner_id: 'd', username: 'dan', display_name: 'Dan', total_bytes: 500 * GB, limit_bytes: 0 }),
  ]

  it('只看告警:接近上限和已超额的算,不限的不算', () => {
    expect(filterStorage(rows, { query: '', onlyAlerts: true }).map((item) => item.owner_id)).toEqual(['b', 'c'])
    expect(alertCounts(rows)).toEqual({ warn: 1, over: 1 })
  })

  it('按用户名或昵称搜索,不分大小写', () => {
    expect(filterStorage(rows, { query: 'BOB', onlyAlerts: false }).map((item) => item.owner_id)).toEqual(['b'])
    expect(filterStorage(rows, { query: '艾米', onlyAlerts: false }).map((item) => item.owner_id)).toEqual(['a'])
    expect(filterStorage(rows, { query: '  ', onlyAlerts: false })).toHaveLength(4)
  })
})

describe('磁盘状态与向量占比', () => {
  const disk = (extra: Partial<StorageOverview['disk']>): StorageOverview['disk'] => ({ free_gb: 200, reserve_gb: 30, paused: false, warn: false, ...extra })
  it('已暂停优先于预警', () => {
    expect(diskLevel(disk({}))).toBe('ok')
    expect(diskLevel(disk({ warn: true }))).toBe('warn')
    expect(diskLevel(disk({ warn: true, paused: true }))).toBe('paused')
  })

  it('向量索引占全站的比例', () => {
    expect(vectorShare({ measured_spaces: 1, total_spaces: 1, total_bytes: 200, vectors_bytes: 50, oldest_measured_at: null })).toBe(25)
    expect(vectorShare({ measured_spaces: 0, total_spaces: 1, total_bytes: 0, vectors_bytes: 0, oldest_measured_at: null })).toBe(0)
  })
})

describe('AI 额度文字', () => {
  it('token 数:千位逗号、万、亿', () => {
    expect(tokensText(0)).toBe('0')
    expect(tokensText(9876)).toBe('9,876')
    expect(tokensText(10_000)).toBe('1 万')
    expect(tokensText(68_000)).toBe('6.8 万')
    expect(tokensText(200_000)).toBe('20 万')
    expect(tokensText(1_234_567)).toBe('123 万')
    expect(tokensText(120_000_000)).toBe('1.2 亿')
    expect(tokensText(-1)).toBe('—')
  })

  it('额度行写成「已用 / 共」,不限单独说明', () => {
    expect(quotaText(68_000, 200_000)).toBe('已用 6.8 万 / 共 20 万')
    expect(quotaText(68_000, 0)).toBe('已用 6.8 万 · 不限')
  })

  it('排行里超额和快用完的人数', () => {
    const llm = (tokens: number, limit: number): LlmUsageRow => ({ user_id: 'u', username: 'u', display_name: 'U', calls: 1, input_tokens: tokens, output_tokens: 0, tokens, limit })
    expect(llmAlertCounts([llm(200_000, 200_000), llm(190_000, 200_000), llm(1, 200_000), llm(10 ** 9, 0)])).toEqual({ over: 1, warn: 1, users: 4 })
  })

  it('模型用途有中文名（含 AI 写作的 write）；不认识的用途原样显示', () => {
    expect(llmPurposeLabel('write')).toBe('写作助手')
    expect(llmPurposeLabel('agent')).toBe('助手对话')
    expect(llmPurposeLabel('web_extract')).toBe('网页规范化')
    expect(llmPurposeLabel('future_purpose')).toBe('future_purpose')
  })
})

describe('站点日期', () => {
  it('毫秒时间戳 → 站点日期(默认北京时间),UTC 16 点已经算第二天', () => {
    expect(siteDay(Date.UTC(2026, 9, 28, 15, 59, 59))).toBe('2026-10-28')
    expect(siteDay(Date.UTC(2026, 9, 28, 16, 0, 0))).toBe('2026-10-29')
  })

  it('isDay 只认真实存在的日期', () => {
    expect(isDay('2026-10-28')).toBe(true)
    expect(isDay('2024-02-29')).toBe(true)
    expect(isDay('2026-02-29')).toBe(false)
    expect(isDay('2026-13-01')).toBe(false)
    expect(isDay('2026-1-1')).toBe(false)
    expect(isDay("x'; DROP TABLE")).toBe(false)
  })

  it('前后挪天,跨月跨年都对;非法输入原样返回', () => {
    expect(shiftDay('2026-10-28', 1)).toBe('2026-10-29')
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftDay('2024-03-01', -1)).toBe('2024-02-29')
    expect(shiftDay('不是日期', 1)).toBe('不是日期')
  })

})

describe('占用分项的名字', () => {
  it('用术语表的说法,名字里不带「AI」(AI 总开关关掉后这一列仍在)', () => {
    expect(PART_LABELS.map((part) => part.label)).toEqual(['笔记', '原件', '向量索引', '代理工作目录'])
    expect(JSON.stringify(PART_LABELS)).not.toMatch(/AI/)
  })
})
